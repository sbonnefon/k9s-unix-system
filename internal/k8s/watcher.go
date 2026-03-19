package k8s

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	authv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

type Watcher struct {
	clientset    *kubernetes.Clientset
	dynClient    dynamic.Interface
	traefikGVR   *schema.GroupVersionResource // resolved GVR, nil if unavailable
	contextName  string
	mu           sync.RWMutex
	namespaces   map[string]*NamespaceInfo
	pods         map[string]map[string]*PodInfo       // ns -> pod name -> pod
	nodes        map[string]*NodeInfo
	services     map[string]map[string]*ServiceInfo    // ns -> svc name -> svc
	ingresses    map[string]map[string]*IngressInfo    // ns -> ingress name -> info
	pvcs         map[string]map[string]*PVCInfo        // ns -> pvc name -> info
	workloads    map[string]map[string]*WorkloadInfo   // ns -> "Kind/name" -> info
	resources    map[string]map[string]map[string]*ResourceInfo // kind -> ns -> name -> info (ns="" for cluster-scoped)
	eventCh      chan Event
	stopCh       chan struct{}
}

func NewWatcher(kubecontext string) (*Watcher, error) {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	overrides := &clientcmd.ConfigOverrides{}
	if kubecontext != "" {
		overrides.CurrentContext = kubecontext
	}
	clientConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, overrides)

	// Resolve the current context name
	rawConfig, _ := clientConfig.RawConfig()
	contextName := rawConfig.CurrentContext
	if kubecontext != "" {
		contextName = kubecontext
	}

	config, err := clientConfig.ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("k8s config: %w", err)
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("k8s client: %w", err)
	}

	dynClient, err := dynamic.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("k8s dynamic client: %w", err)
	}

	return &Watcher{
		clientset:   clientset,
		dynClient:   dynClient,
		contextName: contextName,
		namespaces: make(map[string]*NamespaceInfo),
		pods:       make(map[string]map[string]*PodInfo),
		nodes:      make(map[string]*NodeInfo),
		services:   make(map[string]map[string]*ServiceInfo),
		ingresses:  make(map[string]map[string]*IngressInfo),
		pvcs:       make(map[string]map[string]*PVCInfo),
		workloads:  make(map[string]map[string]*WorkloadInfo),
		resources:  make(map[string]map[string]map[string]*ResourceInfo),
		eventCh:    make(chan Event, 256),
		stopCh:     make(chan struct{}),
	}, nil
}

func (w *Watcher) Events() <-chan Event {
	return w.eventCh
}

func (w *Watcher) Start(ctx context.Context) error {
	// Initial list of namespaces
	nsList, err := w.clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list namespaces: %w", err)
	}

	w.mu.Lock()
	for i := range nsList.Items {
		ns := &nsList.Items[i]
		w.namespaces[ns.Name] = &NamespaceInfo{Name: ns.Name, Status: string(ns.Status.Phase)}
		w.pods[ns.Name] = make(map[string]*PodInfo)
	}
	w.mu.Unlock()

	// Try cluster-wide pod list first, fall back to per-namespace
	podList, err := w.clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if !isForbidden(err) {
			return fmt.Errorf("list pods: %w", err)
		}
		log.Printf("No cluster-wide pod list permission, listing per namespace")
		var podMu sync.Mutex
		var forbiddenPodCount, accessiblePodCount int32
		listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
			nsPodList, nsErr := w.clientset.CoreV1().Pods(ns.Name).List(ctx, metav1.ListOptions{})
			if nsErr != nil {
				if isForbidden(nsErr) {
					w.mu.Lock()
					if nsInfo, ok := w.namespaces[ns.Name]; ok {
						nsInfo.Forbidden = true
					}
					w.mu.Unlock()
					podMu.Lock()
					forbiddenPodCount++
					podMu.Unlock()
				}
				return
			}
			w.mu.Lock()
			for i := range nsPodList.Items {
				pod := &nsPodList.Items[i]
				info := podToInfo(pod)
				if w.pods[pod.Namespace] == nil {
					w.pods[pod.Namespace] = make(map[string]*PodInfo)
				}
				w.pods[pod.Namespace][pod.Name] = &info
			}
			w.mu.Unlock()
			podMu.Lock()
			accessiblePodCount++
			podMu.Unlock()
		})
		log.Printf("Pods: %d namespaces accessible, %d forbidden", accessiblePodCount, forbiddenPodCount)
	} else {
		w.mu.Lock()
		for i := range podList.Items {
			pod := &podList.Items[i]
			info := podToInfo(pod)
			if w.pods[pod.Namespace] == nil {
				w.pods[pod.Namespace] = make(map[string]*PodInfo)
			}
			w.pods[pod.Namespace][pod.Name] = &info
		}
		w.mu.Unlock()

		// Even though we can list pods cluster-wide (via view-no-logs),
		// determine which namespaces the user cannot edit (mark as forbidden).
		var sarMu sync.Mutex
		var forbiddenCount int32
		listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
			sar := &authv1.SelfSubjectAccessReview{
				Spec: authv1.SelfSubjectAccessReviewSpec{
					ResourceAttributes: &authv1.ResourceAttributes{
						Namespace: ns.Name,
						Verb:      "delete",
						Resource:  "pods",
					},
				},
			}
			result, sarErr := w.clientset.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, sar, metav1.CreateOptions{})
			if sarErr != nil {
				return
			}
			if !result.Status.Allowed {
				w.mu.Lock()
				if nsInfo, ok := w.namespaces[ns.Name]; ok {
					nsInfo.Forbidden = true
				}
				w.mu.Unlock()
				sarMu.Lock()
				forbiddenCount++
				sarMu.Unlock()
			}
		})
		log.Printf("Pods: cluster-wide list OK, %d/%d namespaces forbidden (no edit)", forbiddenCount, len(nsList.Items))
	}

	// Emit snapshot with pods — frontend renders immediately while rest loads
	log.Printf("Emitting initial snapshot (namespaces + pods)")
	w.emitSnapshot()

	// Nodes - optional, skip if forbidden
	nodeList, err := w.clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		if !isForbidden(err) {
			return fmt.Errorf("list nodes: %w", err)
		}
		log.Printf("No permission to list nodes, skipping")
		nodeList = &corev1.NodeList{}
	} else {
		w.mu.Lock()
		for i := range nodeList.Items {
			node := &nodeList.Items[i]
			info := nodeToInfo(node)
			w.nodes[node.Name] = &info
		}
		w.mu.Unlock()
	}

	// Try cluster-wide service list first, fall back to per-namespace
	svcList, err := w.clientset.CoreV1().Services("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if !isForbidden(err) {
			return fmt.Errorf("list services: %w", err)
		}
		log.Printf("No cluster-wide service list permission, listing per namespace")
		var svcMu sync.Mutex
		var forbiddenSvcCount, accessibleSvcCount int32
		listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
			nsSvcList, nsErr := w.clientset.CoreV1().Services(ns.Name).List(ctx, metav1.ListOptions{})
			if nsErr != nil {
				if isForbidden(nsErr) {
					svcMu.Lock()
					forbiddenSvcCount++
					svcMu.Unlock()
				}
				return
			}
			w.mu.Lock()
			for i := range nsSvcList.Items {
				svc := &nsSvcList.Items[i]
				info := serviceToInfo(svc)
				if w.services[svc.Namespace] == nil {
					w.services[svc.Namespace] = make(map[string]*ServiceInfo)
				}
				w.services[svc.Namespace][svc.Name] = &info
			}
			w.mu.Unlock()
			svcMu.Lock()
			accessibleSvcCount++
			svcMu.Unlock()
		})
		log.Printf("Services: %d namespaces accessible, %d forbidden", accessibleSvcCount, forbiddenSvcCount)
	} else {
		w.mu.Lock()
		for i := range svcList.Items {
			svc := &svcList.Items[i]
			info := serviceToInfo(svc)
			if w.services[svc.Namespace] == nil {
				w.services[svc.Namespace] = make(map[string]*ServiceInfo)
			}
			w.services[svc.Namespace][svc.Name] = &info
		}
		w.mu.Unlock()
	}

	// Ingresses — optional, skip if API not available
	ingList, err := w.clientset.NetworkingV1().Ingresses("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if !isForbidden(err) {
			log.Printf("Cannot list ingresses (skipping): %v", err)
		} else {
			log.Printf("No permission to list ingresses, listing per namespace")
			listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
				nsIngList, nsErr := w.clientset.NetworkingV1().Ingresses(ns.Name).List(ctx, metav1.ListOptions{})
				if nsErr != nil {
					return
				}
				w.mu.Lock()
				for i := range nsIngList.Items {
					ing := &nsIngList.Items[i]
					info := ingressToInfo(ing)
					if w.ingresses[ing.Namespace] == nil {
						w.ingresses[ing.Namespace] = make(map[string]*IngressInfo)
					}
					w.ingresses[ing.Namespace][ing.Name] = &info
				}
				w.mu.Unlock()
			})
		}
	} else {
		w.mu.Lock()
		for i := range ingList.Items {
			ing := &ingList.Items[i]
			info := ingressToInfo(ing)
			if w.ingresses[ing.Namespace] == nil {
				w.ingresses[ing.Namespace] = make(map[string]*IngressInfo)
			}
			w.ingresses[ing.Namespace][ing.Name] = &info
		}
		w.mu.Unlock()
	}

	// Traefik IngressRoutes — optional, try both API groups
	for _, gvr := range traefikGVRs {
		irList, irErr := w.dynClient.Resource(gvr).Namespace("").List(ctx, metav1.ListOptions{})
		if irErr != nil {
			if !isForbidden(irErr) {
				// CRD doesn't exist or other error — try next GVR
				continue
			}
			// Forbidden cluster-wide — try per-namespace
			log.Printf("No cluster-wide IngressRoute list permission (%s), listing per namespace", gvr.Group)
			var irFound int32
			listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
				nsIRList, nsErr := w.dynClient.Resource(gvr).Namespace(ns.Name).List(ctx, metav1.ListOptions{})
				if nsErr != nil {
					return
				}
				w.mu.Lock()
				irFound++
				for _, item := range nsIRList.Items {
					infos := ingressRouteToInfos(&item)
					for i := range infos {
						info := infos[i]
						if w.ingresses[info.Namespace] == nil {
							w.ingresses[info.Namespace] = make(map[string]*IngressInfo)
						}
						w.ingresses[info.Namespace][info.Name] = &info
					}
				}
				w.mu.Unlock()
			})
			found := irFound > 0
			if found {
				gvrCopy := gvr
				w.traefikGVR = &gvrCopy
				log.Printf("Traefik IngressRoutes found via %s/%s (per-namespace)", gvr.Group, gvr.Version)
			}
			break
		}
		gvrCopy := gvr
		w.traefikGVR = &gvrCopy
		log.Printf("Traefik IngressRoutes found via %s/%s", gvr.Group, gvr.Version)
		w.mu.Lock()
		for _, item := range irList.Items {
			infos := ingressRouteToInfos(&item)
			for i := range infos {
				info := infos[i]
				if w.ingresses[info.Namespace] == nil {
					w.ingresses[info.Namespace] = make(map[string]*IngressInfo)
				}
				w.ingresses[info.Namespace][info.Name] = &info
			}
		}
		w.mu.Unlock()
		break
	}

	// Emit snapshot with services + ingresses
	log.Printf("Emitting snapshot (+ services, ingresses)")
	w.emitSnapshot()

	// PVCs — optional, skip if forbidden
	pvcList, err := w.clientset.CoreV1().PersistentVolumeClaims("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if !isForbidden(err) {
			log.Printf("Cannot list PVCs (skipping): %v", err)
		} else {
			log.Printf("No permission to list PVCs, listing per namespace")
			listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
				nsPvcList, nsErr := w.clientset.CoreV1().PersistentVolumeClaims(ns.Name).List(ctx, metav1.ListOptions{})
				if nsErr != nil {
					return
				}
				w.mu.Lock()
				for i := range nsPvcList.Items {
					pvc := &nsPvcList.Items[i]
					info := pvcToInfo(pvc)
					if w.pvcs[pvc.Namespace] == nil {
						w.pvcs[pvc.Namespace] = make(map[string]*PVCInfo)
					}
					w.pvcs[pvc.Namespace][pvc.Name] = &info
				}
				w.mu.Unlock()
			})
		}
	} else {
		w.mu.Lock()
		for i := range pvcList.Items {
			pvc := &pvcList.Items[i]
			info := pvcToInfo(pvc)
			if w.pvcs[pvc.Namespace] == nil {
				w.pvcs[pvc.Namespace] = make(map[string]*PVCInfo)
			}
			w.pvcs[pvc.Namespace][pvc.Name] = &info
		}
		w.mu.Unlock()
	}

	// Deployments — optional
	depList, err := w.clientset.AppsV1().Deployments("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if isForbidden(err) {
			log.Printf("No permission to list deployments, listing per namespace")
			listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
				nsDepList, nsErr := w.clientset.AppsV1().Deployments(ns.Name).List(ctx, metav1.ListOptions{})
				if nsErr != nil {
					return
				}
				w.mu.Lock()
				for i := range nsDepList.Items {
					dep := &nsDepList.Items[i]
					info := deploymentToInfo(dep)
					key := info.Kind + "/" + info.Name
					if w.workloads[dep.Namespace] == nil {
						w.workloads[dep.Namespace] = make(map[string]*WorkloadInfo)
					}
					w.workloads[dep.Namespace][key] = &info
				}
				w.mu.Unlock()
			})
		} else {
			log.Printf("Cannot list deployments (skipping): %v", err)
		}
	} else {
		w.mu.Lock()
		for i := range depList.Items {
			dep := &depList.Items[i]
			info := deploymentToInfo(dep)
			key := info.Kind + "/" + info.Name
			if w.workloads[dep.Namespace] == nil {
				w.workloads[dep.Namespace] = make(map[string]*WorkloadInfo)
			}
			w.workloads[dep.Namespace][key] = &info
		}
		w.mu.Unlock()
	}

	// StatefulSets — optional
	stsList, err := w.clientset.AppsV1().StatefulSets("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if isForbidden(err) {
			log.Printf("No permission to list statefulsets, listing per namespace")
			listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
				nsStsList, nsErr := w.clientset.AppsV1().StatefulSets(ns.Name).List(ctx, metav1.ListOptions{})
				if nsErr != nil {
					return
				}
				w.mu.Lock()
				for i := range nsStsList.Items {
					sts := &nsStsList.Items[i]
					info := statefulSetToInfo(sts)
					key := info.Kind + "/" + info.Name
					if w.workloads[sts.Namespace] == nil {
						w.workloads[sts.Namespace] = make(map[string]*WorkloadInfo)
					}
					w.workloads[sts.Namespace][key] = &info
				}
				w.mu.Unlock()
			})
		} else {
			log.Printf("Cannot list statefulsets (skipping): %v", err)
		}
	} else {
		w.mu.Lock()
		for i := range stsList.Items {
			sts := &stsList.Items[i]
			info := statefulSetToInfo(sts)
			key := info.Kind + "/" + info.Name
			if w.workloads[sts.Namespace] == nil {
				w.workloads[sts.Namespace] = make(map[string]*WorkloadInfo)
			}
			w.workloads[sts.Namespace][key] = &info
		}
		w.mu.Unlock()
	}

	// DaemonSets — optional
	dsList, err := w.clientset.AppsV1().DaemonSets("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if isForbidden(err) {
			log.Printf("No permission to list daemonsets, listing per namespace")
			listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
				nsDsList, nsErr := w.clientset.AppsV1().DaemonSets(ns.Name).List(ctx, metav1.ListOptions{})
				if nsErr != nil {
					return
				}
				w.mu.Lock()
				for i := range nsDsList.Items {
					ds := &nsDsList.Items[i]
					info := daemonSetToInfo(ds)
					key := info.Kind + "/" + info.Name
					if w.workloads[ds.Namespace] == nil {
						w.workloads[ds.Namespace] = make(map[string]*WorkloadInfo)
					}
					w.workloads[ds.Namespace][key] = &info
				}
				w.mu.Unlock()
			})
		} else {
			log.Printf("Cannot list daemonsets (skipping): %v", err)
		}
	} else {
		w.mu.Lock()
		for i := range dsList.Items {
			ds := &dsList.Items[i]
			info := daemonSetToInfo(ds)
			key := info.Kind + "/" + info.Name
			if w.workloads[ds.Namespace] == nil {
				w.workloads[ds.Namespace] = make(map[string]*WorkloadInfo)
			}
			w.workloads[ds.Namespace][key] = &info
		}
		w.mu.Unlock()
	}

	// CronJobs — optional
	cjList, err := w.clientset.BatchV1().CronJobs("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if isForbidden(err) {
			log.Printf("No permission to list cronjobs, listing per namespace")
			listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
				nsCjList, nsErr := w.clientset.BatchV1().CronJobs(ns.Name).List(ctx, metav1.ListOptions{})
				if nsErr != nil {
					return
				}
				w.mu.Lock()
				for i := range nsCjList.Items {
					cj := &nsCjList.Items[i]
					info := cronJobToInfo(cj)
					key := info.Kind + "/" + info.Name
					if w.workloads[cj.Namespace] == nil {
						w.workloads[cj.Namespace] = make(map[string]*WorkloadInfo)
					}
					w.workloads[cj.Namespace][key] = &info
				}
				w.mu.Unlock()
			})
		} else {
			log.Printf("Cannot list cronjobs (skipping): %v", err)
		}
	} else {
		w.mu.Lock()
		for i := range cjList.Items {
			cj := &cjList.Items[i]
			info := cronJobToInfo(cj)
			key := info.Kind + "/" + info.Name
			if w.workloads[cj.Namespace] == nil {
				w.workloads[cj.Namespace] = make(map[string]*WorkloadInfo)
			}
			w.workloads[cj.Namespace][key] = &info
		}
		w.mu.Unlock()
	}

	// Jobs — optional
	jobList, err := w.clientset.BatchV1().Jobs("").List(ctx, metav1.ListOptions{})
	if err != nil {
		if isForbidden(err) {
			log.Printf("No permission to list jobs, listing per namespace")
			listPerNamespaceParallel(nsList.Items, func(ns corev1.Namespace) {
				nsJobList, nsErr := w.clientset.BatchV1().Jobs(ns.Name).List(ctx, metav1.ListOptions{})
				if nsErr != nil {
					return
				}
				w.mu.Lock()
				for i := range nsJobList.Items {
					job := &nsJobList.Items[i]
					info := jobToInfo(job)
					key := info.Kind + "/" + info.Name
					if w.workloads[job.Namespace] == nil {
						w.workloads[job.Namespace] = make(map[string]*WorkloadInfo)
					}
					w.workloads[job.Namespace][key] = &info
				}
				w.mu.Unlock()
			})
		} else {
			log.Printf("Cannot list jobs (skipping): %v", err)
		}
	} else {
		w.mu.Lock()
		for i := range jobList.Items {
			job := &jobList.Items[i]
			info := jobToInfo(job)
			key := info.Kind + "/" + info.Name
			if w.workloads[job.Namespace] == nil {
				w.workloads[job.Namespace] = make(map[string]*WorkloadInfo)
			}
			w.workloads[job.Namespace][key] = &info
		}
		w.mu.Unlock()
	}

	// Emit snapshot with workloads
	log.Printf("Emitting snapshot (+ PVCs, workloads)")
	w.emitSnapshot()

	// Generic resources (ConfigMaps, Secrets, HPAs, NetworkPolicies, etc.)
	for _, def := range genericResources {
		w.listAndWatchGenericResource(ctx, def)
	}

	// Send final complete snapshot
	log.Printf("Emitting final snapshot (all resources loaded)")
	w.emitSnapshot()

	go w.watchNamespaces(ctx, nsList.ResourceVersion)
	go w.watchPodsAllNamespaces(ctx)
	if len(nodeList.Items) > 0 {
		go w.watchNodes(ctx, nodeList.ResourceVersion)
	}
	go w.watchServicesAllNamespaces(ctx)
	go w.watchIngressesAllNamespaces(ctx)
	if w.traefikGVR != nil {
		go w.watchTraefikIngressRoutes(ctx)
	}
	go w.watchPVCsAllNamespaces(ctx)
	go w.watchDeploymentsAllNamespaces(ctx)
	go w.watchStatefulSetsAllNamespaces(ctx)
	go w.watchDaemonSetsAllNamespaces(ctx)
	go w.watchCronJobsAllNamespaces(ctx)
	go w.watchJobsAllNamespaces(ctx)

	return nil
}

func (w *Watcher) watchNamespaces(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.clientset.CoreV1().Namespaces().Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			ns, ok := event.Object.(*corev1.Namespace)
			if !ok {
				continue
			}
			rv = ns.ResourceVersion

			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				w.namespaces[ns.Name] = &NamespaceInfo{Name: ns.Name, Status: string(ns.Status.Phase)}
				if w.pods[ns.Name] == nil {
					w.pods[ns.Name] = make(map[string]*PodInfo)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "ns_added", Namespace: ns.Name})

			case watch.Deleted:
				w.mu.Lock()
				delete(w.namespaces, ns.Name)
				delete(w.pods, ns.Name)
				w.mu.Unlock()
				w.emit(Event{Type: "ns_deleted", Namespace: ns.Name})
			}
		}
	}
}

func (w *Watcher) watchNodes(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.clientset.CoreV1().Nodes().Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			node, ok := event.Object.(*corev1.Node)
			if !ok {
				continue
			}
			rv = node.ResourceVersion
			info := nodeToInfo(node)

			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				w.nodes[node.Name] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "node_updated", Node: &info})

			case watch.Deleted:
				w.mu.Lock()
				delete(w.nodes, node.Name)
				w.mu.Unlock()
				w.emit(Event{Type: "node_deleted", Node: &info})
			}
		}
	}
}

func (w *Watcher) Stop() {
	close(w.stopCh)
}

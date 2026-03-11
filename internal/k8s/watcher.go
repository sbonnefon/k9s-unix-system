package k8s

import (
	"context"
	"fmt"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

type PodInfo struct {
	Name          string            `json:"name"`
	Namespace     string            `json:"namespace"`
	Status        string            `json:"status"`
	Ready         bool              `json:"ready"`
	Restarts      int32             `json:"restarts"`
	Age           string            `json:"age"`
	NodeName      string            `json:"nodeName"`
	CPURequest    int64             `json:"cpuRequest"`    // millicores
	MemoryRequest int64             `json:"memoryRequest"` // bytes
	Labels        map[string]string `json:"labels,omitempty"`
}

type NamespaceInfo struct {
	Name   string    `json:"name"`
	Status string    `json:"status"`
	Pods   []PodInfo `json:"pods"`
}

type NodeInfo struct {
	Name           string `json:"name"`
	Status         string `json:"status"` // "Ready" or "NotReady"
	CPUCapacity    int64  `json:"cpuCapacity"`    // millicores
	MemoryCapacity int64  `json:"memoryCapacity"` // bytes
}

type ServiceInfo struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace"`
	Type      string            `json:"type"`
	ClusterIP string            `json:"clusterIP"`
	Selector  map[string]string `json:"selector,omitempty"`
}

type Event struct {
	Type      string          `json:"type"`
	Namespace string          `json:"namespace,omitempty"`
	Pod       *PodInfo        `json:"pod,omitempty"`
	Snapshot  []NamespaceInfo `json:"snapshot,omitempty"`
	Node      *NodeInfo       `json:"node,omitempty"`
	Nodes     []NodeInfo      `json:"nodes,omitempty"`
	Service   *ServiceInfo    `json:"service,omitempty"`
	Services  []ServiceInfo   `json:"services,omitempty"`
}

type Watcher struct {
	clientset  *kubernetes.Clientset
	mu         sync.RWMutex
	namespaces map[string]*NamespaceInfo
	pods       map[string]map[string]*PodInfo // ns -> pod name -> pod
	nodes      map[string]*NodeInfo
	services   map[string]map[string]*ServiceInfo // ns -> svc name -> svc
	eventCh    chan Event
	stopCh     chan struct{}
}

func NewWatcher(kubecontext string) (*Watcher, error) {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	overrides := &clientcmd.ConfigOverrides{}
	if kubecontext != "" {
		overrides.CurrentContext = kubecontext
	}
	config, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, overrides).ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("k8s config: %w", err)
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("k8s client: %w", err)
	}

	return &Watcher{
		clientset:  clientset,
		namespaces: make(map[string]*NamespaceInfo),
		pods:       make(map[string]map[string]*PodInfo),
		nodes:      make(map[string]*NodeInfo),
		services:   make(map[string]map[string]*ServiceInfo),
		eventCh:    make(chan Event, 256),
		stopCh:     make(chan struct{}),
	}, nil
}

func (w *Watcher) Events() <-chan Event {
	return w.eventCh
}

func (w *Watcher) Snapshot() []NamespaceInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()

	result := make([]NamespaceInfo, 0, len(w.namespaces))
	for _, ns := range w.namespaces {
		nsCopy := NamespaceInfo{Name: ns.Name, Status: ns.Status}
		if pods, ok := w.pods[ns.Name]; ok {
			for _, p := range pods {
				nsCopy.Pods = append(nsCopy.Pods, *p)
			}
		}
		result = append(result, nsCopy)
	}
	return result
}

func (w *Watcher) SnapshotNodes() []NodeInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()

	result := make([]NodeInfo, 0, len(w.nodes))
	for _, n := range w.nodes {
		result = append(result, *n)
	}
	return result
}

func (w *Watcher) SnapshotServices() []ServiceInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()

	result := make([]ServiceInfo, 0)
	for _, svcs := range w.services {
		for _, s := range svcs {
			result = append(result, *s)
		}
	}
	return result
}

func (w *Watcher) Start(ctx context.Context) error {
	// Initial list
	nsList, err := w.clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list namespaces: %w", err)
	}
	podList, err := w.clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list pods: %w", err)
	}
	nodeList, err := w.clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list nodes: %w", err)
	}
	svcList, err := w.clientset.CoreV1().Services("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return fmt.Errorf("list services: %w", err)
	}

	w.mu.Lock()
	for i := range nsList.Items {
		ns := &nsList.Items[i]
		w.namespaces[ns.Name] = &NamespaceInfo{Name: ns.Name, Status: string(ns.Status.Phase)}
		w.pods[ns.Name] = make(map[string]*PodInfo)
	}
	for i := range podList.Items {
		pod := &podList.Items[i]
		info := podToInfo(pod)
		if w.pods[pod.Namespace] == nil {
			w.pods[pod.Namespace] = make(map[string]*PodInfo)
		}
		w.pods[pod.Namespace][pod.Name] = &info
	}
	for i := range nodeList.Items {
		node := &nodeList.Items[i]
		info := nodeToInfo(node)
		w.nodes[node.Name] = &info
	}
	for i := range svcList.Items {
		svc := &svcList.Items[i]
		info := serviceToInfo(svc)
		if w.services[svc.Namespace] == nil {
			w.services[svc.Namespace] = make(map[string]*ServiceInfo)
		}
		w.services[svc.Namespace][svc.Name] = &info
	}
	w.mu.Unlock()

	// Send initial snapshot
	w.emit(Event{
		Type:     "snapshot",
		Snapshot: w.Snapshot(),
		Nodes:    w.SnapshotNodes(),
		Services: w.SnapshotServices(),
	})

	go w.watchNamespaces(ctx, nsList.ResourceVersion)
	go w.watchPods(ctx, podList.ResourceVersion)
	go w.watchNodes(ctx, nodeList.ResourceVersion)
	go w.watchServices(ctx, svcList.ResourceVersion)

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

func (w *Watcher) watchPods(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.clientset.CoreV1().Pods("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			pod, ok := event.Object.(*corev1.Pod)
			if !ok {
				continue
			}
			rv = pod.ResourceVersion
			info := podToInfo(pod)

			switch event.Type {
			case watch.Added:
				w.mu.Lock()
				if w.pods[pod.Namespace] == nil {
					w.pods[pod.Namespace] = make(map[string]*PodInfo)
				}
				w.pods[pod.Namespace][pod.Name] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "pod_added", Namespace: pod.Namespace, Pod: &info})

			case watch.Modified:
				w.mu.Lock()
				if w.pods[pod.Namespace] == nil {
					w.pods[pod.Namespace] = make(map[string]*PodInfo)
				}
				w.pods[pod.Namespace][pod.Name] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "pod_modified", Namespace: pod.Namespace, Pod: &info})

			case watch.Deleted:
				w.mu.Lock()
				if w.pods[pod.Namespace] != nil {
					delete(w.pods[pod.Namespace], pod.Name)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "pod_deleted", Namespace: pod.Namespace, Pod: &info})
			}
		}
	}
}

func (w *Watcher) emit(e Event) {
	select {
	case w.eventCh <- e:
	default:
		// Drop event if channel full
	}
}

func (w *Watcher) Stop() {
	close(w.stopCh)
}

func podToInfo(pod *corev1.Pod) PodInfo {
	status := string(pod.Status.Phase)
	ready := true
	var restarts int32

	for _, cs := range pod.Status.ContainerStatuses {
		restarts += cs.RestartCount
		if !cs.Ready {
			ready = false
		}
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			status = cs.State.Waiting.Reason
		}
		if cs.State.Terminated != nil && cs.State.Terminated.Reason != "" {
			status = cs.State.Terminated.Reason
		}
	}

	age := time.Since(pod.CreationTimestamp.Time).Truncate(time.Second).String()

	var cpuMillis, memBytes int64
	for _, c := range pod.Spec.Containers {
		if cpu, ok := c.Resources.Requests[corev1.ResourceCPU]; ok {
			cpuMillis += cpu.MilliValue()
		}
		if mem, ok := c.Resources.Requests[corev1.ResourceMemory]; ok {
			memBytes += mem.Value()
		}
	}

	return PodInfo{
		Name:          pod.Name,
		Namespace:     pod.Namespace,
		Status:        status,
		Ready:         ready,
		Restarts:      restarts,
		Age:           age,
		NodeName:      pod.Spec.NodeName,
		CPURequest:    cpuMillis,
		MemoryRequest: memBytes,
		Labels:        pod.Labels,
	}
}

func nodeToInfo(node *corev1.Node) NodeInfo {
	status := "NotReady"
	for _, cond := range node.Status.Conditions {
		if cond.Type == corev1.NodeReady && cond.Status == corev1.ConditionTrue {
			status = "Ready"
			break
		}
	}

	var cpuMillis, memBytes int64
	if cpu, ok := node.Status.Capacity[corev1.ResourceCPU]; ok {
		cpuMillis = cpu.MilliValue()
	}
	if mem, ok := node.Status.Capacity[corev1.ResourceMemory]; ok {
		memBytes = mem.Value()
	}

	return NodeInfo{
		Name:           node.Name,
		Status:         status,
		CPUCapacity:    cpuMillis,
		MemoryCapacity: memBytes,
	}
}

func serviceToInfo(svc *corev1.Service) ServiceInfo {
	return ServiceInfo{
		Name:      svc.Name,
		Namespace: svc.Namespace,
		Type:      string(svc.Spec.Type),
		ClusterIP: svc.Spec.ClusterIP,
		Selector:  svc.Spec.Selector,
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

func (w *Watcher) watchServices(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.clientset.CoreV1().Services("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			svc, ok := event.Object.(*corev1.Service)
			if !ok {
				continue
			}
			rv = svc.ResourceVersion
			info := serviceToInfo(svc)

			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				if w.services[svc.Namespace] == nil {
					w.services[svc.Namespace] = make(map[string]*ServiceInfo)
				}
				w.services[svc.Namespace][svc.Name] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "svc_updated", Namespace: svc.Namespace, Service: &info})

			case watch.Deleted:
				w.mu.Lock()
				if w.services[svc.Namespace] != nil {
					delete(w.services[svc.Namespace], svc.Name)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "svc_deleted", Namespace: svc.Namespace, Service: &info})
			}
		}
	}
}

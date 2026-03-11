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
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Status    string `json:"status"`
	Ready     bool   `json:"ready"`
	Restarts  int32  `json:"restarts"`
	Age       string `json:"age"`
}

type NamespaceInfo struct {
	Name   string    `json:"name"`
	Status string    `json:"status"`
	Pods   []PodInfo `json:"pods"`
}

type Event struct {
	Type      string      `json:"type"` // "snapshot", "pod_added", "pod_modified", "pod_deleted", "ns_added", "ns_deleted"
	Namespace string      `json:"namespace,omitempty"`
	Pod       *PodInfo    `json:"pod,omitempty"`
	Snapshot  []NamespaceInfo `json:"snapshot,omitempty"`
}

type Watcher struct {
	clientset  *kubernetes.Clientset
	mu         sync.RWMutex
	namespaces map[string]*NamespaceInfo
	pods       map[string]map[string]*PodInfo // ns -> pod name -> pod
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
	w.mu.Unlock()

	// Send initial snapshot
	w.emit(Event{Type: "snapshot", Snapshot: w.Snapshot()})

	// Watch namespaces
	go w.watchNamespaces(ctx, nsList.ResourceVersion)
	// Watch pods
	go w.watchPods(ctx, podList.ResourceVersion)

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

	return PodInfo{
		Name:      pod.Name,
		Namespace: pod.Namespace,
		Status:    status,
		Ready:     ready,
		Restarts:  restarts,
		Age:       age,
	}
}

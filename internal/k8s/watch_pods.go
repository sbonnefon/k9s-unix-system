package k8s

import (
	"context"
	"log"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
)

// watchPodsAllNamespaces tries cluster-wide watch first, falls back to per-namespace watches.
func (w *Watcher) watchPodsAllNamespaces(ctx context.Context) {
	// Try cluster-wide watch first
	watcher, err := w.clientset.CoreV1().Pods("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchPods(ctx, "")
		return
	}
	if !isForbidden(err) {
		log.Printf("Pod cluster watch error (non-forbidden): %v", err)
		w.watchPods(ctx, "")
		return
	}

	// Fall back to per-namespace watches
	log.Printf("No cluster-wide pod watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()

	for _, ns := range namespaces {
		go w.watchPodsNamespace(ctx, ns)
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
			if isForbidden(err) {
				log.Printf("Pod cluster watch forbidden, stopping")
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			pod, ok := event.Object.(*corev1.Pod)
			if !ok {
				continue
			}
			rv = pod.ResourceVersion
			w.handlePodEvent(event.Type, pod)
		}
	}
}

func (w *Watcher) watchPodsNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.clientset.CoreV1().Pods(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			pod, ok := event.Object.(*corev1.Pod)
			if !ok {
				continue
			}
			w.handlePodEvent(event.Type, pod)
		}
	}
}

func (w *Watcher) handlePodEvent(eventType watch.EventType, pod *corev1.Pod) {
	info := podToInfo(pod)

	switch eventType {
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

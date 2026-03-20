package k8s

import (
	"context"
	"log"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
)

// watchServicesAllNamespaces tries cluster-wide watch first, falls back to per-namespace watches.
func (w *Watcher) watchServicesAllNamespaces(ctx context.Context) {
	watcher, err := w.clientset.CoreV1().Services("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchServices(ctx, "")
		return
	}
	if !isForbidden(err) {
		log.Printf("Service cluster watch error (non-forbidden): %v", err)
		w.watchServices(ctx, "")
		return
	}

	log.Printf("No cluster-wide service watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()

	for _, ns := range namespaces {
		go w.watchServicesNamespace(ctx, ns)
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
			if isForbidden(err) {
				log.Printf("Service cluster watch forbidden, stopping")
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			svc, ok := event.Object.(*corev1.Service)
			if !ok {
				continue
			}
			rv = svc.ResourceVersion
			w.handleServiceEvent(event.Type, svc)
		}
	}
}

func (w *Watcher) watchServicesNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.clientset.CoreV1().Services(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			svc, ok := event.Object.(*corev1.Service)
			if !ok {
				continue
			}
			w.handleServiceEvent(event.Type, svc)
		}
	}
}

func (w *Watcher) handleServiceEvent(eventType watch.EventType, svc *corev1.Service) {
	info := serviceToInfo(svc)

	switch eventType {
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

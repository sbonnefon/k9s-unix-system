package k8s

import (
	"context"
	"log"
	"time"

	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
)

// ── Ingress watchers ─────────────────────────────────────────────

func (w *Watcher) watchIngressesAllNamespaces(ctx context.Context) {
	watcher, err := w.clientset.NetworkingV1().Ingresses("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchIngresses(ctx, "")
		return
	}
	if !isForbidden(err) {
		return
	}
	log.Printf("No cluster-wide ingress watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()
	for _, ns := range namespaces {
		go w.watchIngressesNamespace(ctx, ns)
	}
}

func (w *Watcher) watchIngresses(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.NetworkingV1().Ingresses("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			ing, ok := event.Object.(*networkingv1.Ingress)
			if !ok {
				continue
			}
			rv = ing.ResourceVersion
			w.handleIngressEvent(event.Type, ing)
		}
	}
}

func (w *Watcher) watchIngressesNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.NetworkingV1().Ingresses(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			ing, ok := event.Object.(*networkingv1.Ingress)
			if !ok {
				continue
			}
			w.handleIngressEvent(event.Type, ing)
		}
	}
}

func (w *Watcher) handleIngressEvent(eventType watch.EventType, ing *networkingv1.Ingress) {
	info := ingressToInfo(ing)
	switch eventType {
	case watch.Added, watch.Modified:
		w.mu.Lock()
		if w.ingresses[ing.Namespace] == nil {
			w.ingresses[ing.Namespace] = make(map[string]*IngressInfo)
		}
		w.ingresses[ing.Namespace][ing.Name] = &info
		w.mu.Unlock()
		w.emit(Event{Type: "ingress_updated", Namespace: ing.Namespace, Ingress: &info})
	case watch.Deleted:
		w.mu.Lock()
		if w.ingresses[ing.Namespace] != nil {
			delete(w.ingresses[ing.Namespace], ing.Name)
		}
		w.mu.Unlock()
		w.emit(Event{Type: "ingress_deleted", Namespace: ing.Namespace, Ingress: &info})
	}
}

// ── Traefik IngressRoute watchers ────────────────────────────────

func (w *Watcher) watchTraefikIngressRoutes(ctx context.Context) {
	gvr := *w.traefikGVR
	var rv string

	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		opts := metav1.ListOptions{}
		if rv != "" {
			opts.ResourceVersion = rv
		}
		watcher, err := w.dynClient.Resource(gvr).Namespace("").Watch(ctx, opts)
		if err != nil {
			if isForbidden(err) {
				log.Printf("Traefik IngressRoute watch forbidden, trying per-namespace")
				w.watchTraefikIngressRoutesPerNS(ctx, gvr)
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}

		for event := range watcher.ResultChan() {
			obj, ok := event.Object.(*unstructured.Unstructured)
			if !ok {
				continue
			}
			rv = obj.GetResourceVersion()
			w.handleTraefikEvent(event.Type, obj)
		}
	}
}

func (w *Watcher) watchTraefikIngressRoutesPerNS(ctx context.Context, gvr schema.GroupVersionResource) {
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()

	for _, ns := range namespaces {
		go func(ns string) {
			for {
				select {
				case <-ctx.Done():
					return
				case <-w.stopCh:
					return
				default:
				}

				watcher, err := w.dynClient.Resource(gvr).Namespace(ns).Watch(ctx, metav1.ListOptions{})
				if err != nil {
					if isForbidden(err) {
						return
					}
					time.Sleep(2 * time.Second)
					continue
				}

				for event := range watcher.ResultChan() {
					obj, ok := event.Object.(*unstructured.Unstructured)
					if !ok {
						continue
					}
					w.handleTraefikEvent(event.Type, obj)
				}
			}
		}(ns)
	}
}

func (w *Watcher) handleTraefikEvent(eventType watch.EventType, obj *unstructured.Unstructured) {
	infos := ingressRouteToInfos(obj)

	switch eventType {
	case watch.Added, watch.Modified:
		w.mu.Lock()
		for i := range infos {
			info := infos[i]
			if w.ingresses[info.Namespace] == nil {
				w.ingresses[info.Namespace] = make(map[string]*IngressInfo)
			}
			w.ingresses[info.Namespace][info.Name] = &info
			w.mu.Unlock()
			w.emit(Event{Type: "ingress_updated", Namespace: info.Namespace, Ingress: &info})
			w.mu.Lock()
		}
		w.mu.Unlock()

	case watch.Deleted:
		ns := obj.GetNamespace()
		name := "tr:" + obj.GetName()
		w.mu.Lock()
		if w.ingresses[ns] != nil {
			delete(w.ingresses[ns], name)
		}
		w.mu.Unlock()
		w.emit(Event{Type: "ingress_deleted", Namespace: ns, Ingress: &IngressInfo{Name: name, Namespace: ns}})
	}
}

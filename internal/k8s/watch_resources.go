package k8s

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
)

// ── Generic resource watchers ────────────────────────────────────

// genericResourceDefs lists all additional resource types we watch via the dynamic client.
// Each entry defines the GVR, kind label, whether it's cluster-scoped, and a converter.
type genericResourceDef struct {
	GVR           schema.GroupVersionResource
	Kind          string
	ClusterScoped bool
	ToInfo        func(obj *unstructured.Unstructured) ResourceInfo
}

var genericResources = []genericResourceDef{
	{
		GVR:  schema.GroupVersionResource{Group: "", Version: "v1", Resource: "configmaps"},
		Kind: "ConfigMap",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			dataMap, _, _ := unstructured.NestedMap(obj.Object, "data")
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "ConfigMap",
				Data: map[string]string{"keys": fmt.Sprintf("%d", len(dataMap))}}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "", Version: "v1", Resource: "secrets"},
		Kind: "Secret",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			sType, _, _ := unstructured.NestedString(obj.Object, "type")
			dataMap, _, _ := unstructured.NestedMap(obj.Object, "data")
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "Secret",
				Data: map[string]string{"type": sType, "keys": fmt.Sprintf("%d", len(dataMap))}}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "", Version: "v1", Resource: "serviceaccounts"},
		Kind: "ServiceAccount",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "ServiceAccount"}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "discovery.k8s.io", Version: "v1", Resource: "endpointslices"},
		Kind: "EndpointSlice",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "EndpointSlice"}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "", Version: "v1", Resource: "resourcequotas"},
		Kind: "ResourceQuota",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "ResourceQuota"}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "", Version: "v1", Resource: "limitranges"},
		Kind: "LimitRange",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "LimitRange"}
		},
	},
	{
		GVR:           schema.GroupVersionResource{Group: "", Version: "v1", Resource: "persistentvolumes"},
		Kind:          "PersistentVolume",
		ClusterScoped: true,
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			phase, _, _ := unstructured.NestedString(obj.Object, "status", "phase")
			return ResourceInfo{Name: obj.GetName(), Kind: "PersistentVolume",
				Data: map[string]string{"phase": phase}}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "autoscaling", Version: "v2", Resource: "horizontalpodautoscalers"},
		Kind: "HPA",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			targetRef, _, _ := unstructured.NestedString(obj.Object, "spec", "scaleTargetRef", "name")
			minR, _, _ := unstructured.NestedInt64(obj.Object, "spec", "minReplicas")
			maxR, _, _ := unstructured.NestedInt64(obj.Object, "spec", "maxReplicas")
			curR, _, _ := unstructured.NestedInt64(obj.Object, "status", "currentReplicas")
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "HPA",
				Data: map[string]string{"target": targetRef, "min": fmt.Sprintf("%d", minR), "max": fmt.Sprintf("%d", maxR), "current": fmt.Sprintf("%d", curR)}}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "networking.k8s.io", Version: "v1", Resource: "networkpolicies"},
		Kind: "NetworkPolicy",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "NetworkPolicy"}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "policy", Version: "v1", Resource: "poddisruptionbudgets"},
		Kind: "PDB",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			minAvail, _, _ := unstructured.NestedString(obj.Object, "spec", "minAvailable")
			maxUnavail, _, _ := unstructured.NestedString(obj.Object, "spec", "maxUnavailable")
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "PDB",
				Data: map[string]string{"minAvailable": minAvail, "maxUnavailable": maxUnavail}}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "replicasets"},
		Kind: "ReplicaSet",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			replicas, _, _ := unstructured.NestedInt64(obj.Object, "spec", "replicas")
			ready, _, _ := unstructured.NestedInt64(obj.Object, "status", "readyReplicas")
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "ReplicaSet",
				Data: map[string]string{"replicas": fmt.Sprintf("%d", replicas), "ready": fmt.Sprintf("%d", ready)}}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "roles"},
		Kind: "Role",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "Role"}
		},
	},
	{
		GVR:  schema.GroupVersionResource{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "rolebindings"},
		Kind: "RoleBinding",
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			roleRef, _, _ := unstructured.NestedString(obj.Object, "roleRef", "name")
			return ResourceInfo{Name: obj.GetName(), Namespace: obj.GetNamespace(), Kind: "RoleBinding",
				Data: map[string]string{"roleRef": roleRef}}
		},
	},
	{
		GVR:           schema.GroupVersionResource{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterroles"},
		Kind:          "ClusterRole",
		ClusterScoped: true,
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			return ResourceInfo{Name: obj.GetName(), Kind: "ClusterRole"}
		},
	},
	{
		GVR:           schema.GroupVersionResource{Group: "rbac.authorization.k8s.io", Version: "v1", Resource: "clusterrolebindings"},
		Kind:          "ClusterRoleBinding",
		ClusterScoped: true,
		ToInfo: func(obj *unstructured.Unstructured) ResourceInfo {
			roleRef, _, _ := unstructured.NestedString(obj.Object, "roleRef", "name")
			return ResourceInfo{Name: obj.GetName(), Kind: "ClusterRoleBinding",
				Data: map[string]string{"roleRef": roleRef}}
		},
	},
}

// listAndWatchGenericResource lists and watches a single generic resource type.
func (w *Watcher) listAndWatchGenericResource(ctx context.Context, def genericResourceDef) {
	ns := ""
	if def.ClusterScoped {
		ns = ""
	}

	// Initial list
	list, err := w.dynClient.Resource(def.GVR).Namespace(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		if isForbidden(err) {
			// Try per-namespace for namespaced resources
			if !def.ClusterScoped {
				w.listGenericPerNamespace(ctx, def)
			} else {
				log.Printf("No permission to list %s (skipping)", def.Kind)
			}
		} else {
			log.Printf("Cannot list %s (skipping): %v", def.Kind, err)
		}
		// Still try to watch even if list failed (might get permission later or was transient)
		go w.watchGenericResource(ctx, def)
		return
	}

	w.mu.Lock()
	for _, item := range list.Items {
		info := def.ToInfo(&item)
		nsKey := info.Namespace // "" for cluster-scoped
		if w.resources[def.Kind] == nil {
			w.resources[def.Kind] = make(map[string]map[string]*ResourceInfo)
		}
		if w.resources[def.Kind][nsKey] == nil {
			w.resources[def.Kind][nsKey] = make(map[string]*ResourceInfo)
		}
		w.resources[def.Kind][nsKey][info.Name] = &info
	}
	w.mu.Unlock()

	go w.watchGenericResource(ctx, def)
}

func (w *Watcher) listGenericPerNamespace(ctx context.Context, def genericResourceDef) {
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()

	var wg sync.WaitGroup
	sem := make(chan struct{}, 10)
	for _, ns := range namespaces {
		wg.Add(1)
		sem <- struct{}{}
		go func(nsName string) {
			defer wg.Done()
			defer func() { <-sem }()
			list, err := w.dynClient.Resource(def.GVR).Namespace(nsName).List(ctx, metav1.ListOptions{})
			if err != nil {
				return
			}
			w.mu.Lock()
			for _, item := range list.Items {
				info := def.ToInfo(&item)
				if w.resources[def.Kind] == nil {
					w.resources[def.Kind] = make(map[string]map[string]*ResourceInfo)
				}
				if w.resources[def.Kind][nsName] == nil {
					w.resources[def.Kind][nsName] = make(map[string]*ResourceInfo)
				}
				w.resources[def.Kind][nsName][info.Name] = &info
			}
			w.mu.Unlock()
		}(ns)
	}
	wg.Wait()
}

func (w *Watcher) watchGenericResource(ctx context.Context, def genericResourceDef) {
	ns := ""
	if def.ClusterScoped {
		ns = ""
	}

	var rv string
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}

		watcher, err := w.dynClient.Resource(def.GVR).Namespace(ns).Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				if !def.ClusterScoped {
					w.watchGenericPerNamespace(ctx, def)
				}
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
			info := def.ToInfo(obj)
			nsKey := info.Namespace

			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				if w.resources[def.Kind] == nil {
					w.resources[def.Kind] = make(map[string]map[string]*ResourceInfo)
				}
				if w.resources[def.Kind][nsKey] == nil {
					w.resources[def.Kind][nsKey] = make(map[string]*ResourceInfo)
				}
				w.resources[def.Kind][nsKey][info.Name] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "resource_updated", Namespace: nsKey, Resource: &info})

			case watch.Deleted:
				w.mu.Lock()
				if w.resources[def.Kind] != nil && w.resources[def.Kind][nsKey] != nil {
					delete(w.resources[def.Kind][nsKey], info.Name)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "resource_deleted", Namespace: nsKey, Resource: &info})
			}
		}
	}
}

func (w *Watcher) watchGenericPerNamespace(ctx context.Context, def genericResourceDef) {
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()

	for _, ns := range namespaces {
		go func(ns string) {
			var rv string
			for {
				select {
				case <-ctx.Done():
					return
				case <-w.stopCh:
					return
				default:
				}

				watcher, err := w.dynClient.Resource(def.GVR).Namespace(ns).Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
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
					rv = obj.GetResourceVersion()
					info := def.ToInfo(obj)

					switch event.Type {
					case watch.Added, watch.Modified:
						w.mu.Lock()
						if w.resources[def.Kind] == nil {
							w.resources[def.Kind] = make(map[string]map[string]*ResourceInfo)
						}
						if w.resources[def.Kind][ns] == nil {
							w.resources[def.Kind][ns] = make(map[string]*ResourceInfo)
						}
						w.resources[def.Kind][ns][info.Name] = &info
						w.mu.Unlock()
						w.emit(Event{Type: "resource_updated", Namespace: ns, Resource: &info})

					case watch.Deleted:
						w.mu.Lock()
						if w.resources[def.Kind] != nil && w.resources[def.Kind][ns] != nil {
							delete(w.resources[def.Kind][ns], info.Name)
						}
						w.mu.Unlock()
						w.emit(Event{Type: "resource_deleted", Namespace: ns, Resource: &info})
					}
				}
			}
		}(ns)
	}
}

package k8s

// emitSnapshot emits a full snapshot event with all currently loaded data.
func (w *Watcher) emitSnapshot() {
	w.emit(Event{
		Type:      "snapshot",
		Context:   w.contextName,
		Snapshot:  w.Snapshot(),
		Nodes:     w.SnapshotNodes(),
		Services:  w.SnapshotServices(),
		Ingresses: w.SnapshotIngresses(),
		PVCs:      w.SnapshotPVCs(),
		Workloads: w.SnapshotWorkloads(),
		Resources: w.SnapshotResources(),
	})
}

func (w *Watcher) emit(e Event) {
	select {
	case w.eventCh <- e:
	default:
		// Drop event if channel full
	}
}

func (w *Watcher) Snapshot() []NamespaceInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()

	result := make([]NamespaceInfo, 0, len(w.namespaces))
	for _, ns := range w.namespaces {
		nsCopy := NamespaceInfo{Name: ns.Name, Status: ns.Status, Forbidden: ns.Forbidden}
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

func (w *Watcher) SnapshotIngresses() []IngressInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()
	result := make([]IngressInfo, 0)
	for _, ings := range w.ingresses {
		for _, i := range ings {
			result = append(result, *i)
		}
	}
	return result
}

func (w *Watcher) SnapshotPVCs() []PVCInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()
	result := make([]PVCInfo, 0)
	for _, pvcs := range w.pvcs {
		for _, p := range pvcs {
			result = append(result, *p)
		}
	}
	return result
}

func (w *Watcher) SnapshotWorkloads() []WorkloadInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()
	result := make([]WorkloadInfo, 0)
	for _, wls := range w.workloads {
		for _, wl := range wls {
			result = append(result, *wl)
		}
	}
	return result
}

func (w *Watcher) SnapshotResources() []ResourceInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()
	result := make([]ResourceInfo, 0)
	for _, nss := range w.resources {
		for _, names := range nss {
			for _, r := range names {
				result = append(result, *r)
			}
		}
	}
	return result
}

package k8s

import (
	"context"
	"log"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/watch"
)

// ── PVC watchers ─────────────────────────────────────────────────

func (w *Watcher) watchPVCsAllNamespaces(ctx context.Context) {
	watcher, err := w.clientset.CoreV1().PersistentVolumeClaims("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchPVCs(ctx, "")
		return
	}
	if !isForbidden(err) {
		return
	}
	log.Printf("No cluster-wide PVC watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()
	for _, ns := range namespaces {
		go w.watchPVCsNamespace(ctx, ns)
	}
}

func (w *Watcher) watchPVCs(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.CoreV1().PersistentVolumeClaims("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			pvc, ok := event.Object.(*corev1.PersistentVolumeClaim)
			if !ok {
				continue
			}
			rv = pvc.ResourceVersion
			w.handlePVCEvent(event.Type, pvc)
		}
	}
}

func (w *Watcher) watchPVCsNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.CoreV1().PersistentVolumeClaims(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			pvc, ok := event.Object.(*corev1.PersistentVolumeClaim)
			if !ok {
				continue
			}
			w.handlePVCEvent(event.Type, pvc)
		}
	}
}

func (w *Watcher) handlePVCEvent(eventType watch.EventType, pvc *corev1.PersistentVolumeClaim) {
	info := pvcToInfo(pvc)
	switch eventType {
	case watch.Added, watch.Modified:
		w.mu.Lock()
		if w.pvcs[pvc.Namespace] == nil {
			w.pvcs[pvc.Namespace] = make(map[string]*PVCInfo)
		}
		w.pvcs[pvc.Namespace][pvc.Name] = &info
		w.mu.Unlock()
		w.emit(Event{Type: "pvc_updated", Namespace: pvc.Namespace, PVC: &info})
	case watch.Deleted:
		w.mu.Lock()
		if w.pvcs[pvc.Namespace] != nil {
			delete(w.pvcs[pvc.Namespace], pvc.Name)
		}
		w.mu.Unlock()
		w.emit(Event{Type: "pvc_deleted", Namespace: pvc.Namespace, PVC: &info})
	}
}

// ── Deployment watchers ──────────────────────────────────────────

func (w *Watcher) watchDeploymentsAllNamespaces(ctx context.Context) {
	watcher, err := w.clientset.AppsV1().Deployments("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchDeployments(ctx, "")
		return
	}
	if !isForbidden(err) {
		return
	}
	log.Printf("No cluster-wide deployment watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()
	for _, ns := range namespaces {
		go w.watchDeploymentsNamespace(ctx, ns)
	}
}

func (w *Watcher) watchDeployments(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.AppsV1().Deployments("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			dep, ok := event.Object.(*appsv1.Deployment)
			if !ok {
				continue
			}
			rv = dep.ResourceVersion
			info := deploymentToInfo(dep)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[dep.Namespace] == nil {
					w.workloads[dep.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[dep.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: dep.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[dep.Namespace] != nil {
					delete(w.workloads[dep.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: dep.Namespace, Workload: &info})
			}
		}
	}
}

func (w *Watcher) watchDeploymentsNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.AppsV1().Deployments(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			dep, ok := event.Object.(*appsv1.Deployment)
			if !ok {
				continue
			}
			info := deploymentToInfo(dep)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[dep.Namespace] == nil {
					w.workloads[dep.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[dep.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: dep.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[dep.Namespace] != nil {
					delete(w.workloads[dep.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: dep.Namespace, Workload: &info})
			}
		}
	}
}

// ── StatefulSet watchers ─────────────────────────────────────────

func (w *Watcher) watchStatefulSetsAllNamespaces(ctx context.Context) {
	watcher, err := w.clientset.AppsV1().StatefulSets("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchStatefulSets(ctx, "")
		return
	}
	if !isForbidden(err) {
		return
	}
	log.Printf("No cluster-wide statefulset watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()
	for _, ns := range namespaces {
		go w.watchStatefulSetsNamespace(ctx, ns)
	}
}

func (w *Watcher) watchStatefulSets(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.AppsV1().StatefulSets("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			sts, ok := event.Object.(*appsv1.StatefulSet)
			if !ok {
				continue
			}
			rv = sts.ResourceVersion
			info := statefulSetToInfo(sts)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[sts.Namespace] == nil {
					w.workloads[sts.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[sts.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: sts.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[sts.Namespace] != nil {
					delete(w.workloads[sts.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: sts.Namespace, Workload: &info})
			}
		}
	}
}

func (w *Watcher) watchStatefulSetsNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.AppsV1().StatefulSets(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			sts, ok := event.Object.(*appsv1.StatefulSet)
			if !ok {
				continue
			}
			info := statefulSetToInfo(sts)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[sts.Namespace] == nil {
					w.workloads[sts.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[sts.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: sts.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[sts.Namespace] != nil {
					delete(w.workloads[sts.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: sts.Namespace, Workload: &info})
			}
		}
	}
}

// ── DaemonSet watchers ───────────────────────────────────────────

func (w *Watcher) watchDaemonSetsAllNamespaces(ctx context.Context) {
	watcher, err := w.clientset.AppsV1().DaemonSets("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchDaemonSets(ctx, "")
		return
	}
	if !isForbidden(err) {
		return
	}
	log.Printf("No cluster-wide daemonset watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()
	for _, ns := range namespaces {
		go w.watchDaemonSetsNamespace(ctx, ns)
	}
}

func (w *Watcher) watchDaemonSets(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.AppsV1().DaemonSets("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			ds, ok := event.Object.(*appsv1.DaemonSet)
			if !ok {
				continue
			}
			rv = ds.ResourceVersion
			info := daemonSetToInfo(ds)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[ds.Namespace] == nil {
					w.workloads[ds.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[ds.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: ds.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[ds.Namespace] != nil {
					delete(w.workloads[ds.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: ds.Namespace, Workload: &info})
			}
		}
	}
}

func (w *Watcher) watchDaemonSetsNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.AppsV1().DaemonSets(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			ds, ok := event.Object.(*appsv1.DaemonSet)
			if !ok {
				continue
			}
			info := daemonSetToInfo(ds)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[ds.Namespace] == nil {
					w.workloads[ds.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[ds.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: ds.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[ds.Namespace] != nil {
					delete(w.workloads[ds.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: ds.Namespace, Workload: &info})
			}
		}
	}
}

// ── CronJob watchers ─────────────────────────────────────────────

func (w *Watcher) watchCronJobsAllNamespaces(ctx context.Context) {
	watcher, err := w.clientset.BatchV1().CronJobs("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchCronJobs(ctx, "")
		return
	}
	if !isForbidden(err) {
		return
	}
	log.Printf("No cluster-wide cronjob watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()
	for _, ns := range namespaces {
		go w.watchCronJobsNamespace(ctx, ns)
	}
}

func (w *Watcher) watchCronJobs(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.BatchV1().CronJobs("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			cj, ok := event.Object.(*batchv1.CronJob)
			if !ok {
				continue
			}
			rv = cj.ResourceVersion
			info := cronJobToInfo(cj)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[cj.Namespace] == nil {
					w.workloads[cj.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[cj.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: cj.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[cj.Namespace] != nil {
					delete(w.workloads[cj.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: cj.Namespace, Workload: &info})
			}
		}
	}
}

func (w *Watcher) watchCronJobsNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.BatchV1().CronJobs(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			cj, ok := event.Object.(*batchv1.CronJob)
			if !ok {
				continue
			}
			info := cronJobToInfo(cj)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[cj.Namespace] == nil {
					w.workloads[cj.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[cj.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: cj.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[cj.Namespace] != nil {
					delete(w.workloads[cj.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: cj.Namespace, Workload: &info})
			}
		}
	}
}

// ── Job watchers ─────────────────────────────────────────────────

func (w *Watcher) watchJobsAllNamespaces(ctx context.Context) {
	watcher, err := w.clientset.BatchV1().Jobs("").Watch(ctx, metav1.ListOptions{})
	if err == nil {
		watcher.Stop()
		w.watchJobs(ctx, "")
		return
	}
	if !isForbidden(err) {
		return
	}
	log.Printf("No cluster-wide job watch permission, watching per namespace")
	w.mu.RLock()
	namespaces := make([]string, 0, len(w.namespaces))
	for ns := range w.namespaces {
		namespaces = append(namespaces, ns)
	}
	w.mu.RUnlock()
	for _, ns := range namespaces {
		go w.watchJobsNamespace(ctx, ns)
	}
}

func (w *Watcher) watchJobs(ctx context.Context, rv string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.BatchV1().Jobs("").Watch(ctx, metav1.ListOptions{ResourceVersion: rv})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			job, ok := event.Object.(*batchv1.Job)
			if !ok {
				continue
			}
			rv = job.ResourceVersion
			info := jobToInfo(job)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[job.Namespace] == nil {
					w.workloads[job.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[job.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: job.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[job.Namespace] != nil {
					delete(w.workloads[job.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: job.Namespace, Workload: &info})
			}
		}
	}
}

func (w *Watcher) watchJobsNamespace(ctx context.Context, ns string) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.stopCh:
			return
		default:
		}
		watcher, err := w.clientset.BatchV1().Jobs(ns).Watch(ctx, metav1.ListOptions{})
		if err != nil {
			if isForbidden(err) {
				return
			}
			time.Sleep(2 * time.Second)
			continue
		}
		for event := range watcher.ResultChan() {
			job, ok := event.Object.(*batchv1.Job)
			if !ok {
				continue
			}
			info := jobToInfo(job)
			switch event.Type {
			case watch.Added, watch.Modified:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[job.Namespace] == nil {
					w.workloads[job.Namespace] = make(map[string]*WorkloadInfo)
				}
				w.workloads[job.Namespace][key] = &info
				w.mu.Unlock()
				w.emit(Event{Type: "workload_updated", Namespace: job.Namespace, Workload: &info})
			case watch.Deleted:
				w.mu.Lock()
				key := info.Kind + "/" + info.Name
				if w.workloads[job.Namespace] != nil {
					delete(w.workloads[job.Namespace], key)
				}
				w.mu.Unlock()
				w.emit(Event{Type: "workload_deleted", Namespace: job.Namespace, Workload: &info})
			}
		}
	}
}

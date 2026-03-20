package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// handleWorkloadDescribe returns details about a Deployment or StatefulSet.
func (s *Server) handleWorkloadDescribe(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	kind := r.URL.Query().Get("kind")
	if ns == "" || name == "" || kind == "" {
		http.Error(w, "namespace, name, and kind required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	type ContainerResources struct {
		Name   string `json:"name"`
		CPUReq string `json:"cpuRequest"`
		CPULim string `json:"cpuLimit"`
		MemReq string `json:"memoryRequest"`
		MemLim string `json:"memoryLimit"`
	}

	type WorkloadDescribe struct {
		Name       string               `json:"name"`
		Namespace  string               `json:"namespace"`
		Kind       string               `json:"kind"`
		Replicas   int32                `json:"replicas"`
		Ready      int32                `json:"readyReplicas"`
		Updated    int32                `json:"updatedReplicas"`
		Strategy   string               `json:"strategy,omitempty"`
		Containers []ContainerResources `json:"containers"`
		// CronJob-specific
		Schedule     string `json:"schedule,omitempty"`
		Suspended    bool   `json:"suspended,omitempty"`
		LastSchedule string `json:"lastSchedule,omitempty"`
		ActiveJobs   int32  `json:"activeJobs,omitempty"`
	}

	desc := WorkloadDescribe{Name: name, Namespace: ns, Kind: kind}

	appendContainers := func(containers []corev1.Container) {
		for _, c := range containers {
			desc.Containers = append(desc.Containers, ContainerResources{
				Name:   c.Name,
				CPUReq: c.Resources.Requests.Cpu().String(),
				CPULim: c.Resources.Limits.Cpu().String(),
				MemReq: c.Resources.Requests.Memory().String(),
				MemLim: c.Resources.Limits.Memory().String(),
			})
		}
	}

	switch kind {
	case "Deployment":
		dep, err := client.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if dep.Spec.Replicas != nil {
			desc.Replicas = *dep.Spec.Replicas
		}
		desc.Ready = dep.Status.ReadyReplicas
		desc.Updated = dep.Status.UpdatedReplicas
		desc.Strategy = string(dep.Spec.Strategy.Type)
		appendContainers(dep.Spec.Template.Spec.Containers)
	case "StatefulSet":
		sts, err := client.AppsV1().StatefulSets(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if sts.Spec.Replicas != nil {
			desc.Replicas = *sts.Spec.Replicas
		}
		desc.Ready = sts.Status.ReadyReplicas
		desc.Updated = sts.Status.UpdatedReplicas
		appendContainers(sts.Spec.Template.Spec.Containers)
	case "DaemonSet":
		ds, err := client.AppsV1().DaemonSets(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		desc.Replicas = ds.Status.DesiredNumberScheduled
		desc.Ready = ds.Status.NumberReady
		desc.Updated = ds.Status.UpdatedNumberScheduled
		appendContainers(ds.Spec.Template.Spec.Containers)
	case "CronJob":
		cj, err := client.BatchV1().CronJobs(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		desc.Schedule = cj.Spec.Schedule
		if cj.Spec.Suspend != nil && *cj.Spec.Suspend {
			desc.Suspended = true
		}
		desc.ActiveJobs = int32(len(cj.Status.Active))
		if cj.Status.LastScheduleTime != nil {
			desc.LastSchedule = cj.Status.LastScheduleTime.Format(time.RFC3339)
		}
		appendContainers(cj.Spec.JobTemplate.Spec.Template.Spec.Containers)
	case "Job":
		job, err := client.BatchV1().Jobs(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if job.Spec.Parallelism != nil {
			desc.Replicas = *job.Spec.Parallelism
		}
		desc.Ready = job.Status.Succeeded
		desc.ActiveJobs = job.Status.Active
		appendContainers(job.Spec.Template.Spec.Containers)
	default:
		http.Error(w, "unsupported kind: "+kind, http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(desc)
}

// handleWorkloadScale changes the replica count of a Deployment or StatefulSet.
func (s *Server) handleWorkloadScale(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
		Kind      string `json:"kind"`
		Replicas  int32  `json:"replicas"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Namespace == "" || req.Name == "" || req.Kind == "" {
		http.Error(w, "namespace, name, and kind required", http.StatusBadRequest)
		return
	}
	if req.Replicas < 0 {
		http.Error(w, "replicas must be >= 0", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	switch req.Kind {
	case "Deployment":
		scale, err := client.AppsV1().Deployments(req.Namespace).GetScale(ctx, req.Name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		scale.Spec.Replicas = req.Replicas
		_, err = client.AppsV1().Deployments(req.Namespace).UpdateScale(ctx, req.Name, scale, metav1.UpdateOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	case "StatefulSet":
		scale, err := client.AppsV1().StatefulSets(req.Namespace).GetScale(ctx, req.Name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		scale.Spec.Replicas = req.Replicas
		_, err = client.AppsV1().StatefulSets(req.Namespace).UpdateScale(ctx, req.Name, scale, metav1.UpdateOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	default:
		http.Error(w, "unsupported kind: "+req.Kind, http.StatusBadRequest)
		return
	}

	log.Printf("Scaled %s/%s in %s to %d replicas", req.Kind, req.Name, req.Namespace, req.Replicas)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":   "scaled",
		"kind":     req.Kind,
		"name":     req.Name,
		"replicas": req.Replicas,
	})
}

// handleWorkloadResources updates container resource requests/limits.
func (s *Server) handleWorkloadResources(w http.ResponseWriter, r *http.Request) {
	type ContainerRes struct {
		Name   string `json:"name"`
		CPUReq string `json:"cpuRequest"`
		CPULim string `json:"cpuLimit"`
		MemReq string `json:"memoryRequest"`
		MemLim string `json:"memoryLimit"`
	}
	var req struct {
		Namespace  string         `json:"namespace"`
		Name       string         `json:"name"`
		Kind       string         `json:"kind"`
		Containers []ContainerRes `json:"containers"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Namespace == "" || req.Name == "" || req.Kind == "" || len(req.Containers) == 0 {
		http.Error(w, "namespace, name, kind, and containers required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	// Build resource map per container name
	resMap := make(map[string]ContainerRes)
	for _, c := range req.Containers {
		resMap[c.Name] = c
	}

	updateContainers := func(containers []corev1.Container) error {
		for i := range containers {
			cr, ok := resMap[containers[i].Name]
			if !ok {
				continue
			}
			if containers[i].Resources.Requests == nil {
				containers[i].Resources.Requests = corev1.ResourceList{}
			}
			if containers[i].Resources.Limits == nil {
				containers[i].Resources.Limits = corev1.ResourceList{}
			}
			if cr.CPUReq != "" {
				q, err := resource.ParseQuantity(cr.CPUReq)
				if err != nil {
					return fmt.Errorf("invalid cpu request %q: %w", cr.CPUReq, err)
				}
				containers[i].Resources.Requests[corev1.ResourceCPU] = q
			}
			if cr.CPULim != "" {
				q, err := resource.ParseQuantity(cr.CPULim)
				if err != nil {
					return fmt.Errorf("invalid cpu limit %q: %w", cr.CPULim, err)
				}
				containers[i].Resources.Limits[corev1.ResourceCPU] = q
			}
			if cr.MemReq != "" {
				q, err := resource.ParseQuantity(cr.MemReq)
				if err != nil {
					return fmt.Errorf("invalid memory request %q: %w", cr.MemReq, err)
				}
				containers[i].Resources.Requests[corev1.ResourceMemory] = q
			}
			if cr.MemLim != "" {
				q, err := resource.ParseQuantity(cr.MemLim)
				if err != nil {
					return fmt.Errorf("invalid memory limit %q: %w", cr.MemLim, err)
				}
				containers[i].Resources.Limits[corev1.ResourceMemory] = q
			}
		}
		return nil
	}

	switch req.Kind {
	case "Deployment":
		dep, err := client.AppsV1().Deployments(req.Namespace).Get(ctx, req.Name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := updateContainers(dep.Spec.Template.Spec.Containers); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if _, err := client.AppsV1().Deployments(req.Namespace).Update(ctx, dep, metav1.UpdateOptions{}); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	case "StatefulSet":
		sts, err := client.AppsV1().StatefulSets(req.Namespace).Get(ctx, req.Name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := updateContainers(sts.Spec.Template.Spec.Containers); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if _, err := client.AppsV1().StatefulSets(req.Namespace).Update(ctx, sts, metav1.UpdateOptions{}); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	default:
		http.Error(w, "unsupported kind: "+req.Kind, http.StatusBadRequest)
		return
	}

	log.Printf("Updated resources for %s/%s in %s", req.Kind, req.Name, req.Namespace)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "updated"})
}

// handleWorkloadRestart triggers a rolling restart by patching the pod template annotation.
func (s *Server) handleWorkloadRestart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
		Kind      string `json:"kind"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Namespace == "" || req.Name == "" || req.Kind == "" {
		http.Error(w, "namespace, name, and kind required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()
	restartAnnotation := fmt.Sprintf(`{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":"%s"}}}}}`, time.Now().Format(time.RFC3339))

	var err error
	switch req.Kind {
	case "Deployment":
		_, err = client.AppsV1().Deployments(req.Namespace).Patch(ctx, req.Name, types.StrategicMergePatchType, []byte(restartAnnotation), metav1.PatchOptions{})
	case "StatefulSet":
		_, err = client.AppsV1().StatefulSets(req.Namespace).Patch(ctx, req.Name, types.StrategicMergePatchType, []byte(restartAnnotation), metav1.PatchOptions{})
	default:
		http.Error(w, "unsupported kind: "+req.Kind, http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	log.Printf("Restarted %s/%s in %s", req.Kind, req.Name, req.Namespace)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "restarted"})
}

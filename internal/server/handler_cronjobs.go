package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// handleCronJobSchedule updates the schedule of a CronJob.
func (s *Server) handleCronJobSchedule(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
		Schedule  string `json:"schedule"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Namespace == "" || req.Name == "" || req.Schedule == "" {
		http.Error(w, "namespace, name, and schedule required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	cj, err := client.BatchV1().CronJobs(req.Namespace).Get(ctx, req.Name, metav1.GetOptions{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	cj.Spec.Schedule = req.Schedule
	if _, err := client.BatchV1().CronJobs(req.Namespace).Update(ctx, cj, metav1.UpdateOptions{}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	log.Printf("Updated CronJob %s/%s schedule to %s", req.Namespace, req.Name, req.Schedule)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "updated", "schedule": req.Schedule})
}

// handleCronJobSuspend toggles the suspend state of a CronJob.
func (s *Server) handleCronJobSuspend(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
		Suspended bool   `json:"suspended"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Namespace == "" || req.Name == "" {
		http.Error(w, "namespace and name required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	cj, err := client.BatchV1().CronJobs(req.Namespace).Get(ctx, req.Name, metav1.GetOptions{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	cj.Spec.Suspend = &req.Suspended
	if _, err := client.BatchV1().CronJobs(req.Namespace).Update(ctx, cj, metav1.UpdateOptions{}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	action := "resumed"
	if req.Suspended {
		action = "suspended"
	}
	log.Printf("CronJob %s/%s %s", req.Namespace, req.Name, action)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"status": action, "suspended": req.Suspended})
}

// handleCronJobTrigger creates a Job from a CronJob (like kubectl create job --from).
func (s *Server) handleCronJobTrigger(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.Namespace == "" || req.Name == "" {
		http.Error(w, "namespace and name required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	cj, err := client.BatchV1().CronJobs(req.Namespace).Get(ctx, req.Name, metav1.GetOptions{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	jobName := fmt.Sprintf("%s-manual-%d", req.Name, time.Now().Unix())
	if len(jobName) > 63 {
		jobName = jobName[:63]
	}

	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      jobName,
			Namespace: req.Namespace,
			Labels:    cj.Spec.JobTemplate.Labels,
			Annotations: map[string]string{
				"cronjob.kubernetes.io/instantiate": "manual",
			},
		},
		Spec: cj.Spec.JobTemplate.Spec,
	}

	created, err := client.BatchV1().Jobs(req.Namespace).Create(ctx, job, metav1.CreateOptions{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	log.Printf("Triggered Job %s/%s from CronJob %s", req.Namespace, created.Name, req.Name)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "triggered", "job": created.Name})
}

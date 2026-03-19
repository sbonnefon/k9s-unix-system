package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// handleDescribe returns a JSON description of a pod (events, conditions, containers).
func (s *Server) handleDescribe(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	if ns == "" || name == "" {
		http.Error(w, "namespace and name required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	pod, err := client.CoreV1().Pods(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Build a describe-like output
	type ContainerDesc struct {
		Name         string `json:"name"`
		Image        string `json:"image"`
		Ready        bool   `json:"ready"`
		RestartCount int32  `json:"restartCount"`
		State        string `json:"state"`
		Reason       string `json:"reason,omitempty"`
	}

	type PodDescribe struct {
		Name       string            `json:"name"`
		Namespace  string            `json:"namespace"`
		Node       string            `json:"node"`
		Status     string            `json:"status"`
		IP         string            `json:"ip"`
		StartTime  string            `json:"startTime,omitempty"`
		Labels     map[string]string `json:"labels,omitempty"`
		Containers []ContainerDesc   `json:"containers"`
		Conditions []string          `json:"conditions"`
		Events     []string          `json:"events"`
	}

	desc := PodDescribe{
		Name:      pod.Name,
		Namespace: pod.Namespace,
		Node:      pod.Spec.NodeName,
		Status:    string(pod.Status.Phase),
		IP:        pod.Status.PodIP,
		Labels:    pod.Labels,
	}

	if pod.Status.StartTime != nil {
		desc.StartTime = pod.Status.StartTime.Format(time.RFC3339)
	}

	for _, c := range pod.Status.ContainerStatuses {
		cd := ContainerDesc{
			Name:         c.Name,
			Image:        c.Image,
			Ready:        c.Ready,
			RestartCount: c.RestartCount,
		}
		switch {
		case c.State.Running != nil:
			cd.State = "Running"
		case c.State.Waiting != nil:
			cd.State = "Waiting"
			cd.Reason = c.State.Waiting.Reason
		case c.State.Terminated != nil:
			cd.State = "Terminated"
			cd.Reason = c.State.Terminated.Reason
		}
		desc.Containers = append(desc.Containers, cd)
	}

	for _, cond := range pod.Status.Conditions {
		desc.Conditions = append(desc.Conditions, fmt.Sprintf("%s=%s", cond.Type, cond.Status))
	}

	// Fetch events for this pod
	events, err := client.CoreV1().Events(ns).List(ctx, metav1.ListOptions{
		FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Pod", name),
	})
	if err == nil {
		for _, ev := range events.Items {
			age := time.Since(ev.LastTimestamp.Time).Truncate(time.Second)
			desc.Events = append(desc.Events, fmt.Sprintf("[%s] %s: %s", age, ev.Reason, ev.Message))
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(desc)
}

// handleLogs streams pod logs via SSE (Server-Sent Events) with follow.
func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	if ns == "" || name == "" {
		http.Error(w, "namespace and name required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	tailLines := int64(100)
	req := client.CoreV1().Pods(ns).GetLogs(name, &corev1.PodLogOptions{
		Follow:    true,
		TailLines: &tailLines,
	})

	stream, err := req.Stream(ctx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer stream.Close()

	// SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	scanner := bufio.NewScanner(stream)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return
		default:
		}
		line := scanner.Text()
		fmt.Fprintf(w, "data: %s\n\n", line)
		flusher.Flush()
	}
}

// handleDeletePod deletes a pod.
func (s *Server) handleDeletePod(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	if ns == "" || name == "" {
		http.Error(w, "namespace and name required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	err := client.CoreV1().Pods(ns).Delete(ctx, name, metav1.DeleteOptions{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":    "deleted",
		"pod":       name,
		"namespace": ns,
	})
}

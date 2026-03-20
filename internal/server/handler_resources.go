package server

import (
	"encoding/json"
	"net/http"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func (s *Server) handleResourceDescribe(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	kind := r.URL.Query().Get("kind")
	if ns == "" || name == "" || kind == "" {
		http.Error(w, "namespace, name, and kind required", http.StatusBadRequest)
		return
	}
	client := s.watcher.K8sClient()
	ctx := r.Context()

	switch kind {
	case "ConfigMap":
		cm, err := client.CoreV1().ConfigMaps(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"name":      cm.Name,
			"namespace": cm.Namespace,
			"kind":      "ConfigMap",
			"data":      cm.Data,
		})
	default:
		http.Error(w, "unsupported kind: "+kind, http.StatusBadRequest)
	}
}

func (s *Server) handleResourceEdit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Namespace string            `json:"namespace"`
		Name      string            `json:"name"`
		Kind      string            `json:"kind"`
		Data      map[string]string `json:"data"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" || req.Namespace == "" || req.Kind == "" {
		http.Error(w, "namespace, name, kind, and data required", http.StatusBadRequest)
		return
	}
	client := s.watcher.K8sClient()
	ctx := r.Context()

	switch req.Kind {
	case "ConfigMap":
		cm, err := client.CoreV1().ConfigMaps(req.Namespace).Get(ctx, req.Name, metav1.GetOptions{})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		cm.Data = req.Data
		if _, err := client.CoreV1().ConfigMaps(req.Namespace).Update(ctx, cm, metav1.UpdateOptions{}); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "updated"})
	default:
		http.Error(w, "unsupported kind: "+req.Kind, http.StatusBadRequest)
	}
}

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

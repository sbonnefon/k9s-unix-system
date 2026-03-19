package server

import (
	"encoding/json"
	"log"
	"net/http"

	k8swatch "github.com/jeppe/k8s-unix-system/internal/k8s"
)

func (s *Server) handleListContexts(w http.ResponseWriter, r *http.Request) {
	contexts, current, err := k8swatch.ListContexts()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"contexts": contexts,
		"current":  current,
		"active":   s.watcher.ContextName(),
	})
}

func (s *Server) handleSwitchContext(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Context string `json:"context"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Context == "" {
		http.Error(w, "context field required", http.StatusBadRequest)
		return
	}

	log.Printf("Switching to context: %s", req.Context)
	if err := s.watcher.SwitchContext(s.ctx, req.Context); err != nil {
		log.Printf("Failed to switch context: %v", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	log.Printf("Successfully switched to context: %s", req.Context)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "ok",
		"context": req.Context,
	})
}

package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os/exec"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/gorilla/websocket"
	k8swatch "github.com/jeppe/k8s-unix-system/internal/k8s"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type portForwardEntry struct {
	cmd       *exec.Cmd
	cancel    context.CancelFunc
	LocalPort int    `json:"localPort"`
	SvcName   string `json:"service"`
	Namespace string `json:"namespace"`
	SvcPort   int    `json:"servicePort"`
}

type Server struct {
	watcher      *k8swatch.Watcher
	clients      map[*websocket.Conn]bool
	mu           sync.Mutex
	ctx          context.Context
	portForwards map[string]*portForwardEntry // key: "ns/name:port"
	pfMu         sync.Mutex
}

func New(w *k8swatch.Watcher, ctx context.Context) *Server {
	return &Server{
		watcher:      w,
		clients:      make(map[*websocket.Conn]bool),
		ctx:          ctx,
		portForwards: make(map[string]*portForwardEntry),
	}
}

func (s *Server) Router(frontendFS http.FileSystem) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)

	r.Get("/api/state", s.handleState)
	r.Get("/api/contexts", s.handleListContexts)
	r.Post("/api/context/switch", s.handleSwitchContext)
	r.Get("/api/pod/describe", s.handleDescribe)
	r.Get("/api/pod/logs", s.handleLogs)
	r.Delete("/api/pod/delete", s.handleDeletePod)
	r.Get("/api/workload/describe", s.handleWorkloadDescribe)
	r.Patch("/api/workload/scale", s.handleWorkloadScale)
	r.Patch("/api/workload/resources", s.handleWorkloadResources)
	r.Post("/api/workload/restart", s.handleWorkloadRestart)
	r.Patch("/api/cronjob/schedule", s.handleCronJobSchedule)
	r.Patch("/api/cronjob/suspend", s.handleCronJobSuspend)
	r.Post("/api/cronjob/trigger", s.handleCronJobTrigger)
	r.Get("/api/resource/describe", s.handleResourceDescribe)
	r.Patch("/api/resource/edit", s.handleResourceEdit)
	r.Get("/api/service/describe", s.handleServiceDescribe)
	r.Get("/api/service/endpoints", s.handleServiceEndpoints)
	r.Post("/api/service/portforward", s.handleServicePortForward)
	r.Delete("/api/service/portforward", s.handleServicePortForwardStop)
	r.Get("/ws", s.handleWS)
	r.Handle("/*", http.FileServer(frontendFS))

	return r
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.watcher.Snapshot())
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}

	// Send initial snapshot and register client under the same lock
	// to prevent BroadcastEvents from writing concurrently.
	snapshot := s.watcher.Snapshot()
	nodes := s.watcher.SnapshotNodes()
	services := s.watcher.SnapshotServices()
	ingresses := s.watcher.SnapshotIngresses()
	pvcs := s.watcher.SnapshotPVCs()
	workloads := s.watcher.SnapshotWorkloads()
	resources := s.watcher.SnapshotResources()
	msg, _ := json.Marshal(k8swatch.Event{
		Type:      "snapshot",
		Context:   s.watcher.ContextName(),
		Snapshot:  snapshot,
		Nodes:     nodes,
		Services:  services,
		Ingresses: ingresses,
		PVCs:      pvcs,
		Workloads: workloads,
		Resources: resources,
	})

	s.mu.Lock()
	conn.WriteMessage(websocket.TextMessage, msg)
	s.clients[conn] = true
	s.mu.Unlock()

	// Keep connection alive, read (and discard) client messages
	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.clients, conn)
			s.mu.Unlock()
			conn.Close()
		}()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
}

func (s *Server) BroadcastEvents() {
	for event := range s.watcher.Events() {
		msg, err := json.Marshal(event)
		if err != nil {
			continue
		}

		s.mu.Lock()
		for conn := range s.clients {
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				conn.Close()
				delete(s.clients, conn)
			}
		}
		s.mu.Unlock()
	}
}

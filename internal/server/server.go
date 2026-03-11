package server

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/gorilla/websocket"
	k8swatch "github.com/jeppe/k8s-unix-system/internal/k8s"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Server struct {
	watcher *k8swatch.Watcher
	clients map[*websocket.Conn]bool
	mu      sync.Mutex
}

func New(w *k8swatch.Watcher) *Server {
	return &Server{
		watcher: w,
		clients: make(map[*websocket.Conn]bool),
	}
}

func (s *Server) Router(frontendFS http.FileSystem) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)

	r.Get("/api/state", s.handleState)
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

	s.mu.Lock()
	s.clients[conn] = true
	s.mu.Unlock()

	// Send initial snapshot
	snapshot := s.watcher.Snapshot()
	msg, _ := json.Marshal(k8swatch.Event{Type: "snapshot", Snapshot: snapshot})
	conn.WriteMessage(websocket.TextMessage, msg)

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

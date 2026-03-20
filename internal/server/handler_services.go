package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os/exec"
	"strconv"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// handleServiceDescribe returns details about a Service including events.
func (s *Server) handleServiceDescribe(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	if ns == "" || name == "" {
		http.Error(w, "namespace and name required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	svc, err := client.CoreV1().Services(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	type PortDesc struct {
		Name       string `json:"name,omitempty"`
		Port       int32  `json:"port"`
		TargetPort string `json:"targetPort"`
		Protocol   string `json:"protocol"`
		NodePort   int32  `json:"nodePort,omitempty"`
	}

	type ServiceDescribe struct {
		Name       string            `json:"name"`
		Namespace  string            `json:"namespace"`
		Type       string            `json:"type"`
		ClusterIP  string            `json:"clusterIP"`
		ExternalIP []string          `json:"externalIPs,omitempty"`
		Selector   map[string]string `json:"selector,omitempty"`
		Labels     map[string]string `json:"labels,omitempty"`
		Ports      []PortDesc        `json:"ports"`
		Events     []string          `json:"events"`
		Age        string            `json:"age"`
	}

	desc := ServiceDescribe{
		Name:      svc.Name,
		Namespace: svc.Namespace,
		Type:      string(svc.Spec.Type),
		ClusterIP: svc.Spec.ClusterIP,
		Selector:  svc.Spec.Selector,
		Labels:    svc.Labels,
	}

	if len(svc.Spec.ExternalIPs) > 0 {
		desc.ExternalIP = svc.Spec.ExternalIPs
	}
	if svc.Status.LoadBalancer.Ingress != nil {
		for _, ing := range svc.Status.LoadBalancer.Ingress {
			if ing.IP != "" {
				desc.ExternalIP = append(desc.ExternalIP, ing.IP)
			}
			if ing.Hostname != "" {
				desc.ExternalIP = append(desc.ExternalIP, ing.Hostname)
			}
		}
	}

	desc.Age = time.Since(svc.CreationTimestamp.Time).Truncate(time.Second).String()

	for _, p := range svc.Spec.Ports {
		desc.Ports = append(desc.Ports, PortDesc{
			Name:       p.Name,
			Port:       p.Port,
			TargetPort: p.TargetPort.String(),
			Protocol:   string(p.Protocol),
			NodePort:   p.NodePort,
		})
	}

	events, err := client.CoreV1().Events(ns).List(ctx, metav1.ListOptions{
		FieldSelector: fmt.Sprintf("involvedObject.name=%s,involvedObject.kind=Service", name),
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

// handleServiceEndpoints returns the resolved endpoints for a service
// using discovery.k8s.io/v1 EndpointSlice API.
func (s *Server) handleServiceEndpoints(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	if ns == "" || name == "" {
		http.Error(w, "namespace and name required", http.StatusBadRequest)
		return
	}

	client := s.watcher.K8sClient()
	ctx := r.Context()

	sliceList, err := client.DiscoveryV1().EndpointSlices(ns).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("kubernetes.io/service-name=%s", name),
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	type EndpointAddress struct {
		IP       string `json:"ip"`
		NodeName string `json:"nodeName,omitempty"`
		PodName  string `json:"podName,omitempty"`
		Ready    bool   `json:"ready"`
	}
	type EndpointPort struct {
		Name     string `json:"name,omitempty"`
		Port     int32  `json:"port"`
		Protocol string `json:"protocol"`
	}
	type EndpointSubset struct {
		Addresses []EndpointAddress `json:"addresses"`
		Ports     []EndpointPort    `json:"ports"`
	}

	var subsets []EndpointSubset
	for _, slice := range sliceList.Items {
		sub := EndpointSubset{}

		for _, port := range slice.Ports {
			ep := EndpointPort{}
			if port.Name != nil {
				ep.Name = *port.Name
			}
			if port.Port != nil {
				ep.Port = *port.Port
			}
			if port.Protocol != nil {
				ep.Protocol = string(*port.Protocol)
			}
			sub.Ports = append(sub.Ports, ep)
		}

		for _, endpoint := range slice.Endpoints {
			ready := endpoint.Conditions.Ready == nil || *endpoint.Conditions.Ready
			for _, addr := range endpoint.Addresses {
				ea := EndpointAddress{IP: addr, Ready: ready}
				if endpoint.NodeName != nil {
					ea.NodeName = *endpoint.NodeName
				}
				if endpoint.TargetRef != nil && endpoint.TargetRef.Kind == "Pod" {
					ea.PodName = endpoint.TargetRef.Name
				}
				sub.Addresses = append(sub.Addresses, ea)
			}
		}

		// Only include slices that have addresses
		if len(sub.Addresses) > 0 || len(sub.Ports) > 0 {
			subsets = append(subsets, sub)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"name":      name,
		"namespace": ns,
		"subsets":   subsets,
	})
}

// handleServicePortForward starts a kubectl port-forward to a service.
func (s *Server) handleServicePortForward(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
		Port      int    `json:"port"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" || req.Namespace == "" || req.Port == 0 {
		http.Error(w, "namespace, name, and port required", http.StatusBadRequest)
		return
	}

	key := fmt.Sprintf("%s/%s:%d", req.Namespace, req.Name, req.Port)

	s.pfMu.Lock()
	if existing, ok := s.portForwards[key]; ok {
		s.pfMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":    "already_running",
			"localPort": existing.LocalPort,
			"key":       key,
		})
		return
	}
	s.pfMu.Unlock()

	// Find a free local port
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		http.Error(w, "failed to find free port: "+err.Error(), http.StatusInternalServerError)
		return
	}
	localPort := listener.Addr().(*net.TCPAddr).Port
	listener.Close()

	pfCtx, cancel := context.WithCancel(s.ctx)
	args := []string{
		"port-forward",
		"--context", s.watcher.ContextName(),
		"-n", req.Namespace,
		fmt.Sprintf("svc/%s", req.Name),
		fmt.Sprintf("%d:%d", localPort, req.Port),
	}
	cmd := exec.CommandContext(pfCtx, "kubectl", args...)

	if err := cmd.Start(); err != nil {
		cancel()
		http.Error(w, "failed to start port-forward: "+err.Error(), http.StatusInternalServerError)
		return
	}

	entry := &portForwardEntry{
		cmd:       cmd,
		cancel:    cancel,
		LocalPort: localPort,
		SvcName:   req.Name,
		Namespace: req.Namespace,
		SvcPort:   req.Port,
	}

	s.pfMu.Lock()
	s.portForwards[key] = entry
	s.pfMu.Unlock()

	// Cleanup when process exits
	go func() {
		cmd.Wait()
		s.pfMu.Lock()
		delete(s.portForwards, key)
		s.pfMu.Unlock()
	}()

	log.Printf("Port-forward started: %s → localhost:%d", key, localPort)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "started",
		"localPort": localPort,
		"key":       key,
	})
}

// handleServicePortForwardStop stops an active port-forward.
func (s *Server) handleServicePortForwardStop(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("namespace")
	name := r.URL.Query().Get("name")
	portStr := r.URL.Query().Get("port")
	if ns == "" || name == "" || portStr == "" {
		http.Error(w, "namespace, name, and port required", http.StatusBadRequest)
		return
	}
	port, _ := strconv.Atoi(portStr)
	key := fmt.Sprintf("%s/%s:%d", ns, name, port)

	s.pfMu.Lock()
	entry, ok := s.portForwards[key]
	if ok {
		entry.cancel()
		delete(s.portForwards, key)
	}
	s.pfMu.Unlock()

	if !ok {
		http.Error(w, "no active port-forward for "+key, http.StatusNotFound)
		return
	}

	log.Printf("Port-forward stopped: %s", key)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "stopped", "key": key})
}

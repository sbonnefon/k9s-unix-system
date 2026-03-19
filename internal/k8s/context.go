package k8s

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

func (w *Watcher) ContextName() string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.contextName
}

// realKubeconfigPath returns the path to the real ~/.kube/config, bypassing
// kubie's KUBECONFIG override (which points to a temp file with only one context).
func realKubeconfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".kube", "config")
}

// ListContexts returns all available kubeconfig contexts and the current one.
// It reads from ~/.kube/config directly to bypass kubie's KUBECONFIG override.
func ListContexts() (contexts []string, current string, err error) {
	rules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: realKubeconfigPath()}
	clientConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, &clientcmd.ConfigOverrides{})
	rawConfig, err := clientConfig.RawConfig()
	if err != nil {
		return nil, "", fmt.Errorf("load kubeconfig: %w", err)
	}
	current = rawConfig.CurrentContext
	for name := range rawConfig.Contexts {
		contexts = append(contexts, name)
	}
	return contexts, current, nil
}

// SwitchContext stops the current watcher, reinitializes with a new context, and restarts.
// It reads from ~/.kube/config directly to bypass kubie's KUBECONFIG override.
func (w *Watcher) SwitchContext(ctx context.Context, newContext string) error {
	// Stop existing watchers
	w.Stop()

	// Reinitialize k8s clients for the new context using the real kubeconfig
	rules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: realKubeconfigPath()}
	overrides := &clientcmd.ConfigOverrides{}
	if newContext != "" {
		overrides.CurrentContext = newContext
	}
	clientConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, overrides)

	rawConfig, _ := clientConfig.RawConfig()
	contextName := rawConfig.CurrentContext
	if newContext != "" {
		contextName = newContext
	}

	config, err := clientConfig.ClientConfig()
	if err != nil {
		return fmt.Errorf("k8s config for context %q: %w", newContext, err)
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return fmt.Errorf("k8s client: %w", err)
	}

	dynClient, err := dynamic.NewForConfig(config)
	if err != nil {
		return fmt.Errorf("k8s dynamic client: %w", err)
	}

	// Reset watcher state under lock
	w.mu.Lock()
	w.clientset = clientset
	w.dynClient = dynClient
	w.contextName = contextName
	w.traefikGVR = nil
	w.namespaces = make(map[string]*NamespaceInfo)
	w.pods = make(map[string]map[string]*PodInfo)
	w.nodes = make(map[string]*NodeInfo)
	w.services = make(map[string]map[string]*ServiceInfo)
	w.ingresses = make(map[string]map[string]*IngressInfo)
	w.pvcs = make(map[string]map[string]*PVCInfo)
	w.workloads = make(map[string]map[string]*WorkloadInfo)
	w.resources = make(map[string]map[string]map[string]*ResourceInfo)
	w.stopCh = make(chan struct{})
	w.mu.Unlock()

	// Restart watchers (Start emits progressive snapshots as resources load)
	if err := w.Start(ctx); err != nil {
		return fmt.Errorf("start watcher for context %q: %w", newContext, err)
	}

	return nil
}

// K8sClient returns the underlying Kubernetes clientset for direct API calls.
func (w *Watcher) K8sClient() *kubernetes.Clientset {
	return w.clientset
}

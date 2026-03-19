package k8s

import (
	"regexp"

	"k8s.io/apimachinery/pkg/runtime/schema"
)

type PodInfo struct {
	Name           string            `json:"name"`
	Namespace      string            `json:"namespace"`
	Status         string            `json:"status"`
	Ready          bool              `json:"ready"`
	Restarts       int32             `json:"restarts"`
	Age            string            `json:"age"`
	NodeName       string            `json:"nodeName"`
	CPURequest     int64             `json:"cpuRequest"`    // millicores
	MemoryRequest  int64             `json:"memoryRequest"` // bytes
	Labels         map[string]string `json:"labels,omitempty"`
	OwnerKind      string            `json:"ownerKind,omitempty"`
	OwnerName      string            `json:"ownerName,omitempty"`
	ContainerCount int               `json:"containerCount"`
	PVCNames       []string          `json:"pvcNames,omitempty"`
}

type NamespaceInfo struct {
	Name      string    `json:"name"`
	Status    string    `json:"status"`
	Pods      []PodInfo `json:"pods"`
	Forbidden bool      `json:"forbidden,omitempty"`
}

type NodeInfo struct {
	Name           string `json:"name"`
	Status         string `json:"status"` // "Ready" or "NotReady"
	CPUCapacity    int64  `json:"cpuCapacity"`    // millicores
	MemoryCapacity int64  `json:"memoryCapacity"` // bytes
}

type ServicePortInfo struct {
	Name       string `json:"name,omitempty"`
	Port       int32  `json:"port"`
	TargetPort string `json:"targetPort"`
	Protocol   string `json:"protocol"`
}

type ServiceInfo struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace"`
	Type      string            `json:"type"`
	ClusterIP string            `json:"clusterIP"`
	Selector  map[string]string `json:"selector,omitempty"`
	Ports     []ServicePortInfo `json:"ports,omitempty"`
}

type IngressInfo struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace"`
	Rules     []IngressRuleInfo `json:"rules"`
}

type IngressRuleInfo struct {
	Host             string `json:"host"`
	Path             string `json:"path"`
	ServiceName      string `json:"serviceName"`
	ServicePort      string `json:"servicePort"`
	ServiceNamespace string `json:"serviceNamespace,omitempty"`
}

type PVCInfo struct {
	Name         string `json:"name"`
	Namespace    string `json:"namespace"`
	Status       string `json:"status"` // Bound, Pending, Lost
	StorageClass string `json:"storageClass,omitempty"`
	Capacity     int64  `json:"capacity"` // bytes
	VolumeName   string `json:"volumeName,omitempty"`
}

type WorkloadInfo struct {
	Name            string `json:"name"`
	Namespace       string `json:"namespace"`
	Kind            string `json:"kind"` // Deployment, StatefulSet, DaemonSet, CronJob, Job
	Replicas        int32  `json:"replicas"`
	ReadyReplicas   int32  `json:"readyReplicas"`
	UpdatedReplicas int32  `json:"updatedReplicas"`
	// CronJob-specific fields
	Schedule        string `json:"schedule,omitempty"`
	Suspended       bool   `json:"suspended,omitempty"`
	LastSchedule    string `json:"lastSchedule,omitempty"`
	ActiveJobs      int32  `json:"activeJobs,omitempty"`
}

// ResourceInfo is a generic type for K8s resources that don't need specialized fields.
// Used for ConfigMaps, Secrets, HPAs, NetworkPolicies, PVs, ServiceAccounts, Endpoints,
// ResourceQuotas, LimitRanges, PDBs, ReplicaSets, Roles, RoleBindings, etc.
type ResourceInfo struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace,omitempty"` // empty for cluster-scoped
	Kind      string            `json:"kind"`
	Data      map[string]string `json:"data,omitempty"` // kind-specific summary fields
}

type Event struct {
	Type      string          `json:"type"`
	Context   string          `json:"context,omitempty"`
	Namespace string          `json:"namespace,omitempty"`
	Pod       *PodInfo        `json:"pod,omitempty"`
	Snapshot  []NamespaceInfo `json:"snapshot,omitempty"`
	Node      *NodeInfo       `json:"node,omitempty"`
	Nodes     []NodeInfo      `json:"nodes,omitempty"`
	Service   *ServiceInfo    `json:"service,omitempty"`
	Services  []ServiceInfo   `json:"services,omitempty"`
	Ingress   *IngressInfo    `json:"ingress,omitempty"`
	Ingresses []IngressInfo   `json:"ingresses,omitempty"`
	PVC       *PVCInfo        `json:"pvc,omitempty"`
	PVCs      []PVCInfo       `json:"pvcs,omitempty"`
	Workload  *WorkloadInfo   `json:"workload,omitempty"`
	Workloads []WorkloadInfo  `json:"workloads,omitempty"`
	Resource  *ResourceInfo   `json:"resource,omitempty"`
	Resources []ResourceInfo  `json:"resources,omitempty"`
}

// Traefik IngressRoute GVRs (try traefik.io first, fall back to traefik.containo.us)
var traefikGVRs = []schema.GroupVersionResource{
	{Group: "traefik.io", Version: "v1alpha1", Resource: "ingressroutes"},
	{Group: "traefik.containo.us", Version: "v1alpha1", Resource: "ingressroutes"},
}

// Regex to extract Host(`...`) and PathPrefix(`...`) from Traefik match rules
var (
	reTraefikHost = regexp.MustCompile("Host\\(`([^`]+)`\\)")
	reTraefikPath = regexp.MustCompile("PathPrefix\\(`([^`]+)`\\)")
)

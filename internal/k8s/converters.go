package k8s

import (
	"fmt"
	"sync"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	networkingv1 "k8s.io/api/networking/v1"
)

func isForbidden(err error) bool {
	return k8serrors.IsForbidden(err)
}

// listPerNamespaceParallel runs fn for each namespace concurrently (max 10 goroutines).
func listPerNamespaceParallel(nsList []corev1.Namespace, fn func(ns corev1.Namespace)) {
	var wg sync.WaitGroup
	sem := make(chan struct{}, 10)
	for _, ns := range nsList {
		wg.Add(1)
		sem <- struct{}{}
		go func(n corev1.Namespace) {
			defer wg.Done()
			defer func() { <-sem }()
			fn(n)
		}(ns)
	}
	wg.Wait()
}

func podToInfo(pod *corev1.Pod) PodInfo {
	status := string(pod.Status.Phase)
	ready := true
	var restarts int32

	for _, cs := range pod.Status.ContainerStatuses {
		restarts += cs.RestartCount
		if !cs.Ready {
			ready = false
		}
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			status = cs.State.Waiting.Reason
		}
		if cs.State.Terminated != nil && cs.State.Terminated.Reason != "" {
			status = cs.State.Terminated.Reason
		}
	}

	age := time.Since(pod.CreationTimestamp.Time).Truncate(time.Second).String()

	var cpuMillis, memBytes int64
	for _, c := range pod.Spec.Containers {
		if cpu, ok := c.Resources.Requests[corev1.ResourceCPU]; ok {
			cpuMillis += cpu.MilliValue()
		}
		if mem, ok := c.Resources.Requests[corev1.ResourceMemory]; ok {
			memBytes += mem.Value()
		}
	}

	// Collect volume references (PVC, ConfigMap, Secret)
	var pvcNames []string
	cmSet := make(map[string]bool)
	secretSet := make(map[string]bool)
	for _, v := range pod.Spec.Volumes {
		if v.PersistentVolumeClaim != nil {
			pvcNames = append(pvcNames, v.PersistentVolumeClaim.ClaimName)
		}
		if v.ConfigMap != nil {
			cmSet[v.ConfigMap.Name] = true
		}
		if v.Secret != nil {
			secretSet[v.Secret.SecretName] = true
		}
		if v.Projected != nil {
			for _, src := range v.Projected.Sources {
				if src.ConfigMap != nil {
					cmSet[src.ConfigMap.Name] = true
				}
				if src.Secret != nil {
					secretSet[src.Secret.Name] = true
				}
			}
		}
	}

	// Collect envFrom references (ConfigMap, Secret)
	for _, c := range pod.Spec.Containers {
		for _, ef := range c.EnvFrom {
			if ef.ConfigMapRef != nil {
				cmSet[ef.ConfigMapRef.Name] = true
			}
			if ef.SecretRef != nil {
				secretSet[ef.SecretRef.Name] = true
			}
		}
	}

	var configMapNames []string
	for name := range cmSet {
		configMapNames = append(configMapNames, name)
	}
	var secretNames []string
	for name := range secretSet {
		secretNames = append(secretNames, name)
	}

	// Resolve owner — walk through ReplicaSet to find Deployment
	var ownerKind, ownerName string
	if len(pod.OwnerReferences) > 0 {
		owner := pod.OwnerReferences[0]
		ownerKind = owner.Kind
		ownerName = owner.Name
		// ReplicaSet is usually owned by a Deployment — surface that instead
		if ownerKind == "ReplicaSet" {
			// Strip the ReplicaSet hash suffix to get the Deployment name
			// e.g. "my-deploy-5d4f7b8c9" -> "my-deploy"
			if idx := lastDashBeforeHash(ownerName); idx > 0 {
				ownerKind = "Deployment"
				ownerName = ownerName[:idx]
			}
		}
	}

	return PodInfo{
		Name:           pod.Name,
		Namespace:      pod.Namespace,
		Status:         status,
		Ready:          ready,
		Restarts:       restarts,
		Age:            age,
		NodeName:       pod.Spec.NodeName,
		CPURequest:     cpuMillis,
		MemoryRequest:  memBytes,
		Labels:         pod.Labels,
		OwnerKind:      ownerKind,
		OwnerName:      ownerName,
		ContainerCount: len(pod.Spec.Containers),
		PVCNames:       pvcNames,
		ConfigMapNames: configMapNames,
		SecretNames:    secretNames,
	}
}

func nodeToInfo(node *corev1.Node) NodeInfo {
	status := "NotReady"
	for _, cond := range node.Status.Conditions {
		if cond.Type == corev1.NodeReady && cond.Status == corev1.ConditionTrue {
			status = "Ready"
			break
		}
	}

	var cpuMillis, memBytes int64
	if cpu, ok := node.Status.Capacity[corev1.ResourceCPU]; ok {
		cpuMillis = cpu.MilliValue()
	}
	if mem, ok := node.Status.Capacity[corev1.ResourceMemory]; ok {
		memBytes = mem.Value()
	}

	return NodeInfo{
		Name:           node.Name,
		Status:         status,
		CPUCapacity:    cpuMillis,
		MemoryCapacity: memBytes,
	}
}

func serviceToInfo(svc *corev1.Service) ServiceInfo {
	info := ServiceInfo{
		Name:      svc.Name,
		Namespace: svc.Namespace,
		Type:      string(svc.Spec.Type),
		ClusterIP: svc.Spec.ClusterIP,
		Selector:  svc.Spec.Selector,
	}
	for _, p := range svc.Spec.Ports {
		info.Ports = append(info.Ports, ServicePortInfo{
			Name:       p.Name,
			Port:       p.Port,
			TargetPort: p.TargetPort.String(),
			Protocol:   string(p.Protocol),
		})
	}
	return info
}

func ingressToInfo(ing *networkingv1.Ingress) IngressInfo {
	info := IngressInfo{
		Name:      ing.Name,
		Namespace: ing.Namespace,
	}
	for _, rule := range ing.Spec.Rules {
		if rule.HTTP == nil {
			continue
		}
		for _, path := range rule.HTTP.Paths {
			port := ""
			if path.Backend.Service != nil && path.Backend.Service.Port.Number != 0 {
				port = fmt.Sprintf("%d", path.Backend.Service.Port.Number)
			} else if path.Backend.Service != nil && path.Backend.Service.Port.Name != "" {
				port = path.Backend.Service.Port.Name
			}
			svcName := ""
			if path.Backend.Service != nil {
				svcName = path.Backend.Service.Name
			}
			info.Rules = append(info.Rules, IngressRuleInfo{
				Host:        rule.Host,
				Path:        path.Path,
				ServiceName: svcName,
				ServicePort: port,
			})
		}
	}
	return info
}

// ingressRouteToInfos converts a Traefik IngressRoute unstructured object
// into one or more IngressInfo (one per route entry with services).
func ingressRouteToInfos(obj *unstructured.Unstructured) []IngressInfo {
	name := obj.GetName()
	namespace := obj.GetNamespace()

	spec, ok := obj.Object["spec"].(map[string]interface{})
	if !ok {
		return nil
	}

	routes, ok := spec["routes"].([]interface{})
	if !ok {
		return nil
	}

	// Determine TLS (if tls section exists, use https)
	scheme := "http"
	if _, hasTLS := spec["tls"]; hasTLS {
		scheme = "https"
	}

	info := IngressInfo{
		Name:      "tr:" + name, // prefix to distinguish from standard Ingress
		Namespace: namespace,
	}

	for _, r := range routes {
		route, ok := r.(map[string]interface{})
		if !ok {
			continue
		}

		matchStr, _ := route["match"].(string)
		if matchStr == "" {
			continue
		}

		// Extract host and path from match rule
		host := ""
		path := "/"
		if m := reTraefikHost.FindStringSubmatch(matchStr); len(m) > 1 {
			host = m[1]
		}
		if m := reTraefikPath.FindStringSubmatch(matchStr); len(m) > 1 {
			path = m[1]
		}

		// Extract services
		services, _ := route["services"].([]interface{})
		if len(services) == 0 {
			info.Rules = append(info.Rules, IngressRuleInfo{
				Host: host,
				Path: path,
			})
			continue
		}

		for _, s := range services {
			svc, ok := s.(map[string]interface{})
			if !ok {
				continue
			}
			svcName, _ := svc["name"].(string)
			svcNs, _ := svc["namespace"].(string)
			svcPort := ""
			if p, ok := svc["port"].(float64); ok {
				svcPort = fmt.Sprintf("%d", int(p))
			} else if p, ok := svc["port"].(int64); ok {
				svcPort = fmt.Sprintf("%d", p)
			} else if p, ok := svc["port"].(string); ok {
				svcPort = p
			}

			rule := IngressRuleInfo{
				Host:             host,
				Path:             path,
				ServiceName:      svcName,
				ServicePort:      svcPort,
				ServiceNamespace: svcNs,
			}
			info.Rules = append(info.Rules, rule)
		}
	}

	_ = scheme // scheme info is implicit from host — frontend builds URLs from host+path
	if len(info.Rules) == 0 {
		return nil
	}
	return []IngressInfo{info}
}

func pvcToInfo(pvc *corev1.PersistentVolumeClaim) PVCInfo {
	info := PVCInfo{
		Name:       pvc.Name,
		Namespace:  pvc.Namespace,
		Status:     string(pvc.Status.Phase),
		VolumeName: pvc.Spec.VolumeName,
	}
	if pvc.Spec.StorageClassName != nil {
		info.StorageClass = *pvc.Spec.StorageClassName
	}
	if storage, ok := pvc.Status.Capacity[corev1.ResourceStorage]; ok {
		info.Capacity = storage.Value()
	} else if req, ok := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
		info.Capacity = req.Value()
	}
	return info
}

func deploymentToInfo(dep *appsv1.Deployment) WorkloadInfo {
	replicas := int32(1)
	if dep.Spec.Replicas != nil {
		replicas = *dep.Spec.Replicas
	}
	return WorkloadInfo{
		Name:            dep.Name,
		Namespace:       dep.Namespace,
		Kind:            "Deployment",
		Replicas:        replicas,
		ReadyReplicas:   dep.Status.ReadyReplicas,
		UpdatedReplicas: dep.Status.UpdatedReplicas,
	}
}

func statefulSetToInfo(sts *appsv1.StatefulSet) WorkloadInfo {
	replicas := int32(1)
	if sts.Spec.Replicas != nil {
		replicas = *sts.Spec.Replicas
	}
	return WorkloadInfo{
		Name:            sts.Name,
		Namespace:       sts.Namespace,
		Kind:            "StatefulSet",
		Replicas:        replicas,
		ReadyReplicas:   sts.Status.ReadyReplicas,
		UpdatedReplicas: sts.Status.UpdatedReplicas,
	}
}

func cronJobToInfo(cj *batchv1.CronJob) WorkloadInfo {
	info := WorkloadInfo{
		Name:       cj.Name,
		Namespace:  cj.Namespace,
		Kind:       "CronJob",
		Schedule:   cj.Spec.Schedule,
		ActiveJobs: int32(len(cj.Status.Active)),
	}
	if cj.Spec.Suspend != nil && *cj.Spec.Suspend {
		info.Suspended = true
	}
	if cj.Status.LastScheduleTime != nil {
		info.LastSchedule = cj.Status.LastScheduleTime.Format(time.RFC3339)
	}
	return info
}

func daemonSetToInfo(ds *appsv1.DaemonSet) WorkloadInfo {
	return WorkloadInfo{
		Name:            ds.Name,
		Namespace:       ds.Namespace,
		Kind:            "DaemonSet",
		Replicas:        ds.Status.DesiredNumberScheduled,
		ReadyReplicas:   ds.Status.NumberReady,
		UpdatedReplicas: ds.Status.UpdatedNumberScheduled,
	}
}

func jobToInfo(job *batchv1.Job) WorkloadInfo {
	replicas := int32(1)
	if job.Spec.Parallelism != nil {
		replicas = *job.Spec.Parallelism
	}
	return WorkloadInfo{
		Name:          job.Name,
		Namespace:     job.Namespace,
		Kind:          "Job",
		Replicas:      replicas,
		ReadyReplicas: job.Status.Succeeded,
		ActiveJobs:    job.Status.Active,
	}
}

// lastDashBeforeHash finds the last '-' that precedes a ReplicaSet hash suffix.
// Returns the index of the dash, or -1 if not found.
func lastDashBeforeHash(name string) int {
	idx := len(name) - 1
	// Walk backwards past the hash (alphanumeric)
	for idx >= 0 && ((name[idx] >= '0' && name[idx] <= '9') || (name[idx] >= 'a' && name[idx] <= 'f') || (name[idx] >= 'A' && name[idx] <= 'F')) {
		idx--
	}
	if idx > 0 && name[idx] == '-' {
		return idx
	}
	return -1
}

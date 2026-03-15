import { state, workloadKey } from './state.js';
import { layoutNamespaces, ensureNamespace, addOrUpdatePod, removePod, removeNamespace } from './layout.js';
import { rebuildServiceLines, rebuildIngressLines } from './connections.js';
import { updateHUD } from './hud.js';

export function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    document.getElementById('loading').style.display = 'none';
  };

  ws.onmessage = (e) => {
    const event = JSON.parse(e.data);
    handleEvent(event);
  };

  ws.onclose = () => {
    document.getElementById('loading').style.display = 'block';
    document.getElementById('loading').textContent = 'RECONNECTING...';
    setTimeout(connectWS, 3000);
  };
}

function handleEvent(event) {
  switch (event.type) {
    case 'snapshot':
      for (const [name] of state.namespaces) removeNamespace(name);
      for (const ns of event.snapshot) {
        ensureNamespace(ns.name);
        for (const pod of ns.pods ?? []) {
          addOrUpdatePod(ns.name, pod);
        }
      }
      state.nodes.clear();
      for (const node of event.nodes ?? []) {
        state.nodes.set(node.name, node);
      }
      state.workloads.clear();
      for (const workload of event.workloads ?? []) {
        state.workloads.set(workloadKey(workload.namespace, workload.kind, workload.name), workload);
      }
      state.services = event.services ?? [];
      state.ingresses = event.ingresses ?? [];
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngressLines();
      updateHUD();
      break;

    case 'pod_added':
    case 'pod_modified':
      addOrUpdatePod(event.namespace, event.pod);
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngressLines();
      updateHUD();
      break;

    case 'pod_deleted':
      removePod(event.namespace, event.pod.name);
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngressLines();
      updateHUD();
      break;

    case 'ns_added':
      ensureNamespace(event.namespace);
      layoutNamespaces();
      updateHUD();
      break;

    case 'ns_deleted':
      removeNamespace(event.namespace);
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngressLines();
      updateHUD();
      break;

    case 'node_updated':
      state.nodes.set(event.node.name, event.node);
      layoutNamespaces();
      updateHUD();
      break;

    case 'node_deleted':
      state.nodes.delete(event.node.name);
      layoutNamespaces();
      updateHUD();
      break;

    case 'svc_updated':
      if (event.service) {
        const idx = state.services.findIndex(s => s.name === event.service.name && s.namespace === event.service.namespace);
        if (idx >= 0) state.services[idx] = event.service;
        else state.services.push(event.service);
      }
      rebuildServiceLines();
      rebuildIngressLines();
      updateHUD();
      break;

    case 'svc_deleted':
      if (event.service) {
        state.services = state.services.filter(s => !(s.name === event.service.name && s.namespace === event.service.namespace));
      }
      rebuildServiceLines();
      rebuildIngressLines();
      updateHUD();
      break;

    case 'ingress_updated':
      if (event.ingress) {
        const idx = state.ingresses.findIndex(i => i.name === event.ingress.name && i.namespace === event.ingress.namespace);
        if (idx >= 0) state.ingresses[idx] = event.ingress;
        else state.ingresses.push(event.ingress);
      }
      rebuildIngressLines();
      updateHUD();
      break;

    case 'ingress_deleted':
      if (event.ingress) {
        state.ingresses = state.ingresses.filter(i => !(i.name === event.ingress.name && i.namespace === event.ingress.namespace));
      }
      rebuildIngressLines();
      updateHUD();
      break;

    case 'workloads_snapshot':
      state.workloads.clear();
      for (const workload of event.workloads ?? []) {
        state.workloads.set(workloadKey(workload.namespace, workload.kind, workload.name), workload);
      }
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngressLines();
      updateHUD();
      break;
  }
}

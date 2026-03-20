import { state } from '../core/state.js';
import { ensureNamespace, removeNamespace, layoutNamespaces } from '../rendering/namespaces.js';
import { addOrUpdatePod, removePod } from '../rendering/pods.js';
import { rebuildServiceLines } from '../rendering/services.js';
import { rebuildIngresses } from '../rendering/ingresses.js';
import { rebuildPVCs } from '../rendering/pvcs.js';
import { rebuildWorkloadGroups } from '../rendering/workloads.js';
import { rebuildResources } from '../rendering/resources.js';

// ── HUD Update ─────────────────────────────────────────────────
function updateHUD() {
  let pods = 0;
  for (const [, ns] of state.namespaces) pods += ns.pods.size;
  document.getElementById('ns-count').textContent = state.namespaces.size;
  document.getElementById('pod-count').textContent = pods;
  document.getElementById('node-count').textContent = state.nodes.size;
  document.getElementById('svc-count').textContent = state.services.length;
  document.getElementById('ing-count').textContent = state.ingresses.length;
  document.getElementById('pvc-count').textContent = state.pvcs.length;
  document.getElementById('wl-count').textContent = state.workloads.length;
  document.getElementById('res-count').textContent = state.resources.length;
}

// ── WebSocket ──────────────────────────────────────────────────
function connectWS() {
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
      // Update active context in dropdown
      if (event.context) {
        const sel = document.getElementById('ctx-select');
        if (sel.value !== event.context) sel.value = event.context;
        document.getElementById('ctx-switching').style.display = 'none';
      }
      // Clear existing
      for (const [name] of state.namespaces) removeNamespace(name);
      for (const ns of event.snapshot) {
        ensureNamespace(ns.name, ns.forbidden || false);
        for (const pod of ns.pods ?? []) {
          addOrUpdatePod(ns.name, pod);
        }
      }
      // Nodes
      state.nodes.clear();
      for (const node of event.nodes ?? []) {
        state.nodes.set(node.name, node);
      }
      // Services
      state.services = event.services ?? [];
      // Ingresses
      state.ingresses = event.ingresses ?? [];
      // PVCs
      state.pvcs = event.pvcs ?? [];
      // Workloads
      state.workloads = event.workloads ?? [];
      // Resources
      state.resources = event.resources ?? [];
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngresses();
      rebuildPVCs();
      rebuildWorkloadGroups();
      rebuildResources();
      updateHUD();
      break;

    case 'pod_added':
    case 'pod_modified':
      addOrUpdatePod(event.namespace, event.pod);
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngresses();
      rebuildPVCs();
      rebuildWorkloadGroups();
      updateHUD();
      break;

    case 'pod_deleted':
      removePod(event.namespace, event.pod.name);
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngresses();
      rebuildPVCs();
      rebuildWorkloadGroups();
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
      rebuildIngresses();
      rebuildPVCs();
      rebuildWorkloadGroups();
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
      updateHUD();
      break;

    case 'svc_deleted':
      if (event.service) {
        state.services = state.services.filter(s => !(s.name === event.service.name && s.namespace === event.service.namespace));
      }
      rebuildServiceLines();
      rebuildIngresses();
      updateHUD();
      break;

    case 'ingress_updated':
      if (event.ingress) {
        const idx = state.ingresses.findIndex(i => i.name === event.ingress.name && i.namespace === event.ingress.namespace);
        if (idx >= 0) state.ingresses[idx] = event.ingress;
        else state.ingresses.push(event.ingress);
      }
      rebuildIngresses();
      updateHUD();
      break;

    case 'ingress_deleted':
      if (event.ingress) {
        state.ingresses = state.ingresses.filter(i => !(i.name === event.ingress.name && i.namespace === event.ingress.namespace));
      }
      rebuildIngresses();
      updateHUD();
      break;

    case 'pvc_updated':
      if (event.pvc) {
        const idx = state.pvcs.findIndex(p => p.name === event.pvc.name && p.namespace === event.pvc.namespace);
        if (idx >= 0) state.pvcs[idx] = event.pvc;
        else state.pvcs.push(event.pvc);
      }
      rebuildPVCs();
      updateHUD();
      break;

    case 'pvc_deleted':
      if (event.pvc) {
        state.pvcs = state.pvcs.filter(p => !(p.name === event.pvc.name && p.namespace === event.pvc.namespace));
      }
      rebuildPVCs();
      updateHUD();
      break;

    case 'workload_updated':
      if (event.workload) {
        const idx = state.workloads.findIndex(w => w.name === event.workload.name && w.namespace === event.workload.namespace && w.kind === event.workload.kind);
        if (idx >= 0) state.workloads[idx] = event.workload;
        else state.workloads.push(event.workload);
      }
      rebuildWorkloadGroups();
      updateHUD();
      break;

    case 'workload_deleted':
      if (event.workload) {
        state.workloads = state.workloads.filter(w => !(w.name === event.workload.name && w.namespace === event.workload.namespace && w.kind === event.workload.kind));
      }
      rebuildWorkloadGroups();
      updateHUD();
      break;

    case 'resource_updated':
      if (event.resource) {
        const idx = state.resources.findIndex(r => r.name === event.resource.name && r.namespace === event.resource.namespace && r.kind === event.resource.kind);
        if (idx >= 0) state.resources[idx] = event.resource;
        else state.resources.push(event.resource);
      }
      rebuildResources();
      updateHUD();
      break;

    case 'resource_deleted':
      if (event.resource) {
        state.resources = state.resources.filter(r => !(r.name === event.resource.name && r.namespace === event.resource.namespace && r.kind === event.resource.kind));
      }
      rebuildResources();
      updateHUD();
      break;
  }
}

export { connectWS, handleEvent, updateHUD };

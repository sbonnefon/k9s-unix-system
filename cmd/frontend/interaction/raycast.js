import * as THREE from 'three';
import { state } from '../core/state.js';
import { scene, canvas, activeCamera } from '../core/scene.js';
import { statusColor, formatBytes } from '../core/materials.js';
import { markBillboardsDirty } from '../rendering/labels.js';
import { applyInstanceHover, removeInstanceHover } from '../rendering/pods.js';

// Pod meshes are invisible (rendered via InstancedMesh) but still raycastable.
// scene.traverse visits them regardless of visibility; the raycaster is the one
// that skips invisible objects, so we temporarily flip visibility during raycast.

// ── Raycasting (hover tooltip) ─────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hoveredMesh = null;
const tooltip = document.getElementById('tooltip');
let pointerLocked = false;

let _mouseDirty = false;
document.addEventListener('mousemove', (e) => {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  _mouseDirty = true;

  // Tooltip position
  tooltip.style.left = (e.clientX + 16) + 'px';
  tooltip.style.top = (e.clientY + 16) + 'px';
});

// Cached mesh arrays -- rebuilt only when scene changes
let _cachedHoverTargets = [];
let _cachedNsTargets = [];
let _meshCacheDirty = true;

function invalidateMeshCache() {
  _meshCacheDirty = true;
  markBillboardsDirty();
}

const HOVERABLE_TYPES = new Set(['pod', 'nodeBlock', 'resource', 'workload', 'pvc', 'ingressArch', 'namespace', 'service']);

function rebuildMeshCache() {
  if (!_meshCacheDirty) return;
  _cachedHoverTargets = [];
  _cachedNsTargets = [];
  scene.traverse((obj) => {
    if (obj.isMesh && HOVERABLE_TYPES.has(obj.userData.type)) {
      // Pod meshes are invisible (rendered via InstancedMesh) but still included
      // for raycasting — traverse visits them regardless of visibility.
      _cachedHoverTargets.push(obj);
    }
    if (obj.userData.type === 'namespace' || obj.userData.type === 'label' || obj.userData.type === 'ingressArch') {
      _cachedNsTargets.push(obj);
    }
  });
  _meshCacheDirty = false;
}

// Store original material state for unhover restore
let _hoverSavedState = null;

function applyHoverHighlight(mesh) {
  const mat = mesh.material;
  _hoverSavedState = {
    emissiveIntensity: mat.emissiveIntensity,
    opacity: mat.opacity,
    emissive: mat.emissive ? mat.emissive.clone() : null,
  };
  if (mat.emissive) {
    mat.emissiveIntensity = Math.max(mat.emissiveIntensity * 3, 2);
  }
  // Boost opacity for transparent objects (workloads, ingress arches, service tubes, etc.)
  if (mat.transparent && mat.opacity < 0.5) {
    mat.opacity = Math.min(mat.opacity * 3, 0.85);
  }
}

function removeHoverHighlight(mesh) {
  if (!_hoverSavedState) return;
  const mat = mesh.material;
  if (_hoverSavedState.emissive) {
    mat.emissiveIntensity = _hoverSavedState.emissiveIntensity;
  }
  mat.opacity = _hoverSavedState.opacity;
  _hoverSavedState = null;
}

// These will be set by app.js to avoid circular deps
let _selectorMatchesLabels = null;
let _podURLs = null;
let _RESOURCE_COLORS = null;

function setRaycastDeps({ selectorMatchesLabels, podURLs, RESOURCE_COLORS }) {
  _selectorMatchesLabels = selectorMatchesLabels;
  _podURLs = podURLs;
  _RESOURCE_COLORS = RESOURCE_COLORS;
}

function buildTooltipHTML(mesh) {
  const ud = mesh.userData;
  switch (ud.type) {
    case 'pod': {
      const pod = ud.pod;
      const statusClass = pod.status === 'Running' ? 'status-running'
        : ['Pending', 'ContainerCreating', 'PodInitializing'].includes(pod.status) ? 'status-pending'
        : 'status-error';
      const matchedSvcs = state.services
        .filter(s => s.namespace === pod.namespace && _selectorMatchesLabels(s.selector, pod.labels))
        .map(s => s.name);
      return `
        <div class="pod-name">${pod.name}</div>
        <div class="pod-ns">ns/${pod.namespace}${pod.nodeName ? ' · node/' + pod.nodeName : ''}</div>
        ${pod.ownerKind ? `<div style="opacity:0.8">${pod.ownerKind}/${pod.ownerName}</div>` : ''}
        <div class="pod-status ${statusClass}">● ${pod.status}</div>
        <div>Ready: ${pod.ready ? 'YES' : 'NO'} &middot; Restarts: ${pod.restarts} &middot; Containers: ${pod.containerCount || 1}</div>
        ${pod.cpuRequest || pod.memoryRequest ? `<div>CPU: ${pod.cpuRequest ? pod.cpuRequest + 'm' : '—'} &middot; Mem: ${pod.memoryRequest ? formatBytes(pod.memoryRequest) : '—'}</div>` : ''}
        ${matchedSvcs.length ? `<div style="color:#00aaff">svc/${matchedSvcs.join(', svc/')}</div>` : ''}
        ${pod.pvcNames && pod.pvcNames.length ? `<div style="color:#8844cc">pvc/${pod.pvcNames.join(', pvc/')}</div>` : ''}
        ${(() => { const u = _podURLs(pod); return u.length ? `<div style="color:#ffaa00">${u.join(', ')}</div>` : ''; })()}
        <div>Age: ${pod.age}</div>
        <div style="opacity:0.5; margin-top:4px">Double-click for actions</div>
      `;
    }
    case 'nodeBlock': {
      const node = ud.node;
      const statusClass = node.status === 'Ready' ? 'status-running' : 'status-error';
      return `
        <div class="pod-name">${node.name}</div>
        <div class="pod-ns">node</div>
        <div class="pod-status ${statusClass}">● ${node.status}</div>
        ${node.cpuCapacity ? `<div>CPU: ${node.cpuCapacity}m &middot; Mem: ${formatBytes(node.memoryCapacity)}</div>` : ''}
      `;
    }
    case 'resource': {
      const res = ud.resource;
      const color = '#' + new THREE.Color(_RESOURCE_COLORS[res.kind] || 0x777777).getHexString();
      const dataEntries = res.data ? Object.entries(res.data).map(([k, v]) => `<div style="opacity:0.7">${k}: ${v}</div>`).join('') : '';
      let referencedBy = '';
      if (res.kind === 'ConfigMap' || res.kind === 'Secret') {
        const refPods = [];
        const ns = state.namespaces.get(res.namespace);
        if (ns && ns.pods) {
          for (const [, podMesh] of ns.pods) {
            const pod = podMesh.userData.pod;
            if (!pod) continue;
            const names = res.kind === 'ConfigMap' ? pod.configMapNames : pod.secretNames;
            if (names && names.includes(res.name)) {
              refPods.push('pod/' + pod.name);
            }
          }
        }
        if (refPods.length) {
          referencedBy = `<div style="opacity:0.8;color:${color}">Referenced by: ${refPods.join(', ')}</div>`;
        }
      }
      const dblClickHint = res.kind === 'ConfigMap' ? `<div style="opacity:0.5; margin-top:4px">Double-click for actions</div>` : '';
      return `
        <div class="pod-name" style="color:${color}">${res.kind}</div>
        <div class="pod-ns">${res.name}${res.namespace ? ' · ns/' + res.namespace : ' (cluster)'}</div>
        ${dataEntries}
        ${referencedBy}
        ${dblClickHint}
      `;
    }
    case 'workload': {
      const wl = ud.workload;
      const WL_COLORS_HEX = { Deployment: '#00ff88', StatefulSet: '#00aaff', DaemonSet: '#44ccaa', CronJob: '#ffaa00', Job: '#ffcc66' };
      const color = WL_COLORS_HEX[wl.kind] || '#00ff88';
      let info = '';
      if (wl.kind === 'CronJob') {
        info = `<div>Schedule: ${wl.schedule || '?'}</div>`;
        if (wl.suspended) info += `<div style="color:#ff4444">SUSPENDED</div>`;
        if (wl.lastSchedule) info += `<div>Last: ${wl.lastSchedule}</div>`;
        if (wl.activeJobs !== undefined) info += `<div>Active jobs: ${wl.activeJobs}</div>`;
      } else if (wl.kind === 'Job') {
        info = `<div>Completions: ${wl.readyReplicas}/${wl.replicas}</div>`;
      } else {
        const healthy = wl.readyReplicas >= wl.replicas;
        info = `<div>Replicas: ${wl.readyReplicas}/${wl.replicas} ${healthy ? '' : '<span style="color:#ffcc00">NOT READY</span>'}</div>`;
      }
      return `
        <div class="pod-name" style="color:${color}">${wl.kind}</div>
        <div class="pod-ns">${wl.name} · ns/${wl.namespace}</div>
        ${info}
        <div style="opacity:0.5; margin-top:4px">Double-click to edit</div>
      `;
    }
    case 'pvc': {
      const pvc = ud.pvc;
      const pvcStatusColor = pvc.status === 'Bound' ? '#8844cc' : pvc.status === 'Pending' ? '#ffcc00' : '#ff4444';
      return `
        <div class="pod-name" style="color:#8844cc">PersistentVolumeClaim</div>
        <div class="pod-ns">${pvc.name} · ns/${pvc.namespace}</div>
        <div style="color:${pvcStatusColor}">● ${pvc.status}</div>
        ${pvc.capacity ? `<div>Capacity: ${pvc.capacity}</div>` : ''}
        ${ud.podName ? `<div style="opacity:0.7">Mounted by: ${ud.podName}</div>` : ''}
      `;
    }
    case 'ingressArch': {
      const nsIngresses = ud.ingresses || [];
      const routeCount = nsIngresses.reduce((n, ing) => n + (ing.rules || []).length, 0);
      let routes = '';
      for (const ing of nsIngresses.slice(0, 5)) {
        for (const rule of (ing.rules || []).slice(0, 3)) {
          routes += `<div style="opacity:0.7">${rule.host || '—'}${rule.path || '/'} → svc/${rule.serviceName || '?'}</div>`;
        }
      }
      if (routeCount > 8) routes += `<div style="opacity:0.5">...and ${routeCount - 8} more</div>`;
      return `
        <div class="pod-name" style="color:#ffaa00">Ingress</div>
        <div class="pod-ns">ns/${ud.namespace} · ${nsIngresses.length} ingress(es) · ${routeCount} route(s)</div>
        ${routes}
        <div style="opacity:0.5; margin-top:4px">Click for route details</div>
      `;
    }
    case 'namespace': {
      const nsName = ud.name;
      if (nsName === '__nodes__') return null;
      const ns = state.namespaces.get(nsName);
      const podCount = ns ? ns.pods.size : 0;
      const wlCount = state.workloads.filter(w => w.namespace === nsName).length;
      const svcCount = state.services.filter(s => s.namespace === nsName).length;
      const ingCount = state.ingresses.filter(i => i.namespace === nsName).length;
      return `
        <div class="pod-name" style="color:#cc6699">${nsName}</div>
        <div class="pod-ns">namespace</div>
        <div>${podCount} pod(s) &middot; ${wlCount} workload(s)</div>
        <div>${svcCount} service(s) &middot; ${ingCount} ingress(es)</div>
        <div style="opacity:0.5; margin-top:4px">Click to spotlight</div>
      `;
    }
    case 'service': {
      const svc = ud.service;
      const portsStr = (svc.ports || []).map(p => `${p.port}${p.name ? '/' + p.name : ''} → ${p.targetPort} (${p.protocol})`).join('<br>');
      return `
        <div class="pod-name" style="color:#00aaff">Service</div>
        <div class="pod-ns">${svc.name} · ns/${svc.namespace}</div>
        <div>Type: ${svc.type} &middot; ClusterIP: ${svc.clusterIP || 'None'}</div>
        ${portsStr ? `<div style="opacity:0.8">${portsStr}</div>` : ''}
        <div style="opacity:0.7">${ud.matchedPodCount || 0} matching pod(s)</div>
        <div style="opacity:0.5; margin-top:4px">Double-click for actions</div>
      `;
    }
    default:
      return null;
  }
}

function updateRaycast() {
  if (!_mouseDirty) return;
  _mouseDirty = false;

  rebuildMeshCache();
  raycaster.setFromCamera(mouse, activeCamera());

  // Cursor hint for clickable targets
  if (!pointerLocked) {
    const nsHits = raycaster.intersectObjects(_cachedNsTargets);
    canvas.style.cursor = nsHits.length > 0 ? 'pointer' : 'default';
  }

  // Temporarily make invisible pod/resource meshes visible for raycasting
  const invisibleProxies = [];
  for (const obj of _cachedHoverTargets) {
    if (!obj.visible && (obj.userData.type === 'pod' || obj.userData.type === 'resource')) {
      obj.visible = true;
      invisibleProxies.push(obj);
    }
  }

  const intersects = raycaster.intersectObjects(_cachedHoverTargets);

  // Restore invisibility
  for (const obj of invisibleProxies) {
    obj.visible = false;
  }

  if (hoveredMesh) {
    if (hoveredMesh.userData.type === 'pod') {
      removeInstanceHover();
    } else {
      removeHoverHighlight(hoveredMesh);
    }
    hoveredMesh = null;
  }

  if (intersects.length > 0) {
    hoveredMesh = intersects[0].object;
    if (hoveredMesh.userData.type === 'pod') {
      const pod = hoveredMesh.userData.pod;
      if (pod) applyInstanceHover(pod.namespace, pod.name);
    } else {
      applyHoverHighlight(hoveredMesh);
    }
    canvas.style.cursor = 'pointer';

    const html = buildTooltipHTML(hoveredMesh);
    if (html) {
      tooltip.innerHTML = html;
      tooltip.style.display = 'block';
    } else {
      tooltip.style.display = 'none';
    }
  } else {
    tooltip.style.display = 'none';
  }
}

function setPointerLocked(locked) {
  pointerLocked = locked;
}

export {
  raycaster,
  mouse,
  invalidateMeshCache,
  rebuildMeshCache,
  updateRaycast,
  setRaycastDeps,
  setPointerLocked,
  _cachedNsTargets,
};

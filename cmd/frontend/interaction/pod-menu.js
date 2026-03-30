import * as THREE from 'three';
import { state } from '../core/state.js';
import { scene, canvas, activeCamera } from '../core/scene.js';
import { podURLs } from '../rendering/ingresses.js';
import { openWorkloadEdit } from './workload-edit.js';
import { openResourceMenu } from './resource-menu.js';

// ── Pod Actions (double-click menu) ────────────────────────────
const podMenu = document.getElementById('pod-menu');
const podMenuTitle = document.getElementById('pod-menu-title');
const outputPanel = document.getElementById('output-panel');
const outputTitle = document.getElementById('output-title');
const outputBody = document.getElementById('output-body');
const outputClose = document.getElementById('output-close');
const killConfirm = document.getElementById('kill-confirm');
const killPodName = document.getElementById('kill-pod-name');
const killYes = document.getElementById('kill-yes');
const killNo = document.getElementById('kill-no');

let selectedPod = null;   // { name, namespace }
let logAbort = null;       // AbortController for log streaming

function closePodMenu() {
  podMenu.style.display = 'none';
  selectedPod = null;
}

function closeOutputPanel() {
  outputPanel.style.display = 'none';
  outputBody.textContent = '';
  if (logAbort) { logAbort.abort(); logAbort = null; }
}

function closeKillConfirm() {
  killConfirm.style.display = 'none';
}

async function doPodDescribe(pod) {
  closeOutputPanel();
  outputTitle.textContent = `DESCRIBE  ${pod.namespace}/${pod.name}`;
  outputBody.textContent = 'Loading...';
  outputPanel.style.display = 'flex';

  try {
    const resp = await fetch(`/api/pod/describe?namespace=${encodeURIComponent(pod.namespace)}&name=${encodeURIComponent(pod.name)}`);
    if (!resp.ok) throw new Error(await resp.text());
    const desc = await resp.json();

    let out = '';
    out += `Name:       ${desc.name}\n`;
    out += `Namespace:  ${desc.namespace}\n`;
    out += `Node:       ${desc.node}\n`;
    out += `Status:     ${desc.status}\n`;
    out += `IP:         ${desc.ip}\n`;
    if (desc.startTime) out += `Start Time: ${desc.startTime}\n`;
    if (desc.labels && Object.keys(desc.labels).length) {
      out += `Labels:\n`;
      for (const [k, v] of Object.entries(desc.labels)) {
        out += `  ${k}=${v}\n`;
      }
    }
    out += `\n--- CONTAINERS ---\n`;
    for (const c of (desc.containers || [])) {
      out += `\n  ${c.name}\n`;
      out += `    Image:    ${c.image}\n`;
      out += `    Ready:    ${c.ready}\n`;
      out += `    Restarts: ${c.restartCount}\n`;
      out += `    State:    ${c.state}${c.reason ? ' (' + c.reason + ')' : ''}\n`;
    }
    out += `\n--- CONDITIONS ---\n`;
    for (const cond of (desc.conditions || [])) {
      out += `  ${cond}\n`;
    }
    if (desc.events && desc.events.length) {
      out += `\n--- EVENTS ---\n`;
      for (const ev of desc.events) {
        out += `  ${ev}\n`;
      }
    }

    // Resolve URLs for this pod
    const urls = podURLs({ ...pod, labels: desc.labels });
    if (urls.length) {
      out += `\n--- URLS ---\n`;
      for (const u of urls) {
        out += `  ${u}\n`;
      }
    }

    const escaped = out.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const withLinks = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" style="color:#ffaa00;text-decoration:underline;pointer-events:auto;cursor:pointer">$1</a>');
    outputBody.innerHTML = withLinks;
  } catch (err) {
    outputBody.textContent = `ERROR: ${err.message}`;
  }
}

async function doPodLogs(pod) {
  closeOutputPanel();
  if (logAbort) logAbort.abort();
  logAbort = new AbortController();

  outputTitle.textContent = `LOGS  ${pod.namespace}/${pod.name}  (streaming)`;
  outputBody.textContent = '';
  outputPanel.style.display = 'flex';

  try {
    const resp = await fetch(
      `/api/pod/logs?namespace=${encodeURIComponent(pod.namespace)}&name=${encodeURIComponent(pod.name)}`,
      { signal: logAbort.signal },
    );
    if (!resp.ok) throw new Error(await resp.text());

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          outputBody.textContent += line.slice(6) + '\n';
          outputBody.scrollTop = outputBody.scrollHeight;
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      outputBody.textContent += `\n--- ERROR: ${err.message} ---\n`;
    }
  }
}

let pendingKillPod = null;

function showKillConfirm(pod) {
  pendingKillPod = pod;
  killPodName.textContent = `${pod.namespace}/${pod.name}`;
  killConfirm.style.display = 'block';
}

async function doKillPod() {
  if (!pendingKillPod) return;
  const pod = pendingKillPod;
  closeKillConfirm();

  closeOutputPanel();
  outputTitle.textContent = `KILL  ${pod.namespace}/${pod.name}`;
  outputBody.textContent = 'Deleting pod...';
  outputPanel.style.display = 'flex';

  try {
    const resp = await fetch(
      `/api/pod/delete?namespace=${encodeURIComponent(pod.namespace)}&name=${encodeURIComponent(pod.name)}`,
      { method: 'DELETE' },
    );
    if (!resp.ok) throw new Error(await resp.text());
    const result = await resp.json();
    outputBody.textContent = `Pod ${result.namespace}/${result.pod} deleted successfully.`;
  } catch (err) {
    outputBody.textContent = `ERROR: ${err.message}`;
  }
  pendingKillPod = null;
}

killYes.addEventListener('click', doKillPod);
killNo.addEventListener('click', closeKillConfirm);

// Highlight active menu item
function setActiveMenuItem(id) {
  podMenu.querySelectorAll('.menu-item').forEach(el => el.style.background = '');
  if (id) {
    const el = document.getElementById(id);
    if (el) el.style.background = 'rgba(0, 255, 136, 0.15)';
  }
}

// Reposition pod menu to left side so it doesn't overlap with output panel
function repositionPodMenu() {
  if (podMenu.style.display !== 'block') return;
  const menuRect = podMenu.getBoundingClientRect();
  if (outputPanel.style.display === 'flex') {
    const maxX = window.innerWidth * 0.5 - menuRect.width - 10;
    if (menuRect.left > maxX) {
      podMenu.style.left = Math.max(10, maxX) + 'px';
    }
  }
}

// Menu item clicks
document.getElementById('pod-menu-describe').addEventListener('click', () => {
  if (selectedPod) { doPodDescribe(selectedPod); setActiveMenuItem('pod-menu-describe'); repositionPodMenu(); }
});
document.getElementById('pod-menu-logs').addEventListener('click', () => {
  if (selectedPod) { doPodLogs(selectedPod); setActiveMenuItem('pod-menu-logs'); repositionPodMenu(); }
});
document.getElementById('pod-menu-kill').addEventListener('click', () => {
  if (selectedPod) showKillConfirm(selectedPod);
  closePodMenu();
});
document.getElementById('pod-menu-open-url').addEventListener('click', () => {
  const openUrlItem = document.getElementById('pod-menu-open-url');
  const urls = JSON.parse(openUrlItem.dataset.urls || '[]');
  for (const url of urls) window.open(url, '_blank');
});

outputClose.addEventListener('click', closeOutputPanel);

// ── Double-click handler ────────────────────────────────────────
// Import svc-menu functions lazily to avoid circular deps
let _closeSvcMenu = null;
let _selectedService = null;
let _svcMenu = null;
let _svcMenuTitle = null;
let _doServicePortForward = null;

function setSvcMenuDeps(deps) {
  _closeSvcMenu = deps.closeSvcMenu;
  _svcMenu = deps.svcMenu;
  _svcMenuTitle = deps.svcMenuTitle;
  _doServicePortForward = deps.doServicePortForward;
  _selectedService = deps.selectedServiceRef;
}

canvas.addEventListener('dblclick', (e) => {
  const dblMouse = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  );
  const dblRay = new THREE.Raycaster();
  dblRay.setFromCamera(dblMouse, activeCamera());

  const podMeshes = [];
  const wlMeshes = [];
  const svcMeshes = [];
  const resMeshes = [];
  scene.traverse((obj) => {
    if (obj.isMesh && obj.userData.type === 'workload') wlMeshes.push(obj);
    if (obj.isMesh && obj.userData.type === 'service') svcMeshes.push(obj);
    if (obj.isMesh && obj.userData.type === 'resource') resMeshes.push(obj);
  });
  // Pod meshes are invisible (rendered via InstancedMesh) — collect from state
  for (const [, ns] of state.namespaces) {
    for (const [, mesh] of ns.pods) {
      podMeshes.push(mesh);
    }
  }

  // Temporarily make invisible pods visible for raycasting
  const invisiblePods = podMeshes.filter(m => !m.visible);
  for (const m of invisiblePods) m.visible = true;

  // Prioritize pod hits
  const podHits = dblRay.intersectObjects(podMeshes);

  // Restore invisibility
  for (const m of invisiblePods) m.visible = false;
  if (podHits.length > 0) {
    const pod = podHits[0].object.userData.pod;
    if (!pod) return;

    selectedPod = { name: pod.name, namespace: pod.namespace, labels: pod.labels };
    podMenuTitle.textContent = pod.name;

    const urls = podURLs(pod);
    const openUrlItem = document.getElementById('pod-menu-open-url');
    if (urls.length > 0) {
      openUrlItem.style.display = 'flex';
      openUrlItem.dataset.urls = JSON.stringify(urls);
    } else {
      openUrlItem.style.display = 'none';
    }

    podMenu.style.left = e.clientX + 'px';
    podMenu.style.top = e.clientY + 'px';
    podMenu.style.display = 'block';
    e.stopPropagation();
    return;
  }

  // Check service hits
  const svcHits = dblRay.intersectObjects(svcMeshes);
  if (svcHits.length > 0 && _svcMenu) {
    const svc = svcHits[0].object.userData.service;
    if (!svc) return;
    _selectedService.value = { name: svc.name, namespace: svc.namespace, ports: svc.ports || [] };
    _svcMenuTitle.textContent = `svc/${svc.name}`;
    const pfContainer = document.getElementById('svc-menu-pf-ports');
    pfContainer.innerHTML = '';
    for (const p of (svc.ports || [])) {
      const item = document.createElement('div');
      item.className = 'menu-item';
      item.style.color = '#44ccaa';
      item.innerHTML = `<span class="menu-key" style="border-color:#44ccaa;color:#44ccaa">P</span> Port-forward :${p.port}`;
      item.addEventListener('click', () => _doServicePortForward(svc, p.port));
      pfContainer.appendChild(item);
    }
    _svcMenu.style.left = e.clientX + 'px';
    _svcMenu.style.top = e.clientY + 'px';
    _svcMenu.style.display = 'block';
    e.stopPropagation();
    return;
  }

  // Check resource hits
  const resHits = dblRay.intersectObjects(resMeshes);
  if (resHits.length > 0) {
    const resource = resHits[0].object.userData.resource;
    if (resource && resource.kind === 'ConfigMap') {
      openResourceMenu(resource, e.clientX, e.clientY);
      e.stopPropagation();
      return;
    }
  }

  // Check workload hits
  const wlHits = dblRay.intersectObjects(wlMeshes);
  if (wlHits.length > 0) {
    const wl = wlHits[0].object.userData.workload;
    if (!wl) return;
    openWorkloadEdit(wl);
    e.stopPropagation();
    return;
  }
});

export {
  podMenu,
  outputPanel,
  outputTitle,
  outputBody,
  killConfirm,
  selectedPod,
  closePodMenu,
  closeOutputPanel,
  closeKillConfirm,
  doPodDescribe,
  doPodLogs,
  showKillConfirm,
  doKillPod,
  setActiveMenuItem,
  repositionPodMenu,
  setSvcMenuDeps,
};

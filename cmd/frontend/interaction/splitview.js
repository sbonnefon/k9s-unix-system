import * as THREE from 'three';
import { state } from '../core/state.js';
import { renderer, scene, camera } from '../core/scene.js';
import { updateControlsHint } from './camera.js';

// ── Split View — multi-camera workload monitoring ───────────────

const ERROR_STATUSES = new Set(['CrashLoopBackOff', 'Error', 'Failed', 'ImagePullBackOff']);

const splitView = {
  active: false,
  count: 0,        // 0=off, 4, 6, 8
  cameras: [],     // PerspectiveCamera[]
  targets: [],     // { nsName, wlName, wlKind, worldPos }[]
  offset: 0,       // pagination offset for N/P
  time: 0,         // elapsed time for gentle orbit
};

// Grid layouts for each split count
const LAYOUTS = {
  4: { cols: 2, rows: 2 },
  6: { cols: 3, rows: 2 },
  8: { cols: 4, rows: 2 },
};

// ── Workload ranking (errors first, then by namespace) ──────────

function rankWorkloads() {
  const errorWorkloads = [];
  const healthyWorkloads = [];

  for (const wl of state.workloads) {
    const ns = state.namespaces.get(wl.namespace);
    if (!ns) continue;

    // Check if any pod in this workload is in error
    let hasError = false;
    for (const [, mesh] of ns.pods) {
      const pod = mesh.userData.pod;
      if (!pod) continue;
      if (pod.ownerKind === wl.kind && pod.ownerName === wl.name && ERROR_STATUSES.has(pod.status)) {
        hasError = true;
        break;
      }
    }

    // Compute world position of the workload's pods center
    const worldPos = new THREE.Vector3();
    let podCount = 0;
    for (const [, mesh] of ns.pods) {
      const pod = mesh.userData.pod;
      if (pod && pod.ownerKind === wl.kind && pod.ownerName === wl.name) {
        const wp = new THREE.Vector3();
        mesh.getWorldPosition(wp);
        worldPos.add(wp);
        podCount++;
      }
    }

    if (podCount === 0) {
      // Orphan workload — use namespace center
      ns.group.getWorldPosition(worldPos);
    } else {
      worldPos.divideScalar(podCount);
    }

    const entry = { nsName: wl.namespace, wlName: wl.name, wlKind: wl.kind, worldPos, hasError };
    if (hasError) {
      errorWorkloads.push(entry);
    } else {
      healthyWorkloads.push(entry);
    }
  }

  // Errors first, then healthy
  return [...errorWorkloads, ...healthyWorkloads];
}

// ── Camera management ───────────────────────────────────────────

function ensureCameras(count) {
  while (splitView.cameras.length < count) {
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
    splitView.cameras.push(cam);
  }
}

function updateSplitCameras(dt) {
  splitView.time += dt;
  const ranked = rankWorkloads();
  const count = splitView.count;
  const offset = splitView.offset;

  // Select workloads for current page
  splitView.targets = [];
  for (let i = 0; i < count; i++) {
    const idx = offset + i;
    if (idx < ranked.length) {
      splitView.targets.push(ranked[idx]);
    }
  }

  // Position each camera looking at its workload with gentle orbit
  for (let i = 0; i < splitView.targets.length; i++) {
    const target = splitView.targets[i];
    const cam = splitView.cameras[i];
    const orbitAngle = splitView.time * 0.2 + i * 0.5; // slight phase offset per viewport
    const radius = 8;
    const height = 6;

    cam.position.set(
      target.worldPos.x + Math.cos(orbitAngle) * radius,
      target.worldPos.y + height,
      target.worldPos.z + Math.sin(orbitAngle) * radius,
    );
    cam.lookAt(target.worldPos);
  }
}

// ── Rendering ───────────────────────────────────────────────────

function renderSplitView() {
  if (!splitView.active) return false;

  const layout = LAYOUTS[splitView.count];
  if (!layout) return false;

  const w = window.innerWidth;
  const h = window.innerHeight;
  const cellW = Math.floor(w / layout.cols);
  const cellH = Math.floor(h / layout.rows);

  renderer.setScissorTest(true);
  renderer.autoClear = false;
  renderer.clear();

  for (let i = 0; i < splitView.count; i++) {
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols);
    const x = col * cellW;
    const y = h - (row + 1) * cellH; // WebGL Y is bottom-up

    renderer.setViewport(x, y, cellW, cellH);
    renderer.setScissor(x, y, cellW, cellH);

    if (i < splitView.targets.length) {
      const cam = splitView.cameras[i];
      cam.aspect = cellW / cellH;
      cam.updateProjectionMatrix();
      renderer.render(scene, cam);

      // Draw label overlay
      drawViewportLabel(x, y, cellW, cellH, splitView.targets[i]);
    } else {
      // Empty viewport — just black
      renderer.setClearColor(0x020202, 1);
      renderer.clear();
    }
  }

  renderer.setScissorTest(false);
  renderer.autoClear = true;

  return true; // signal that we handled rendering
}

// ── Viewport labels (2D canvas overlay) ─────────────────────────

let _labelCanvas = null;
let _labelCtx = null;

function ensureLabelOverlay() {
  if (_labelCanvas) return;
  _labelCanvas = document.createElement('canvas');
  _labelCanvas.id = 'splitview-labels';
  _labelCanvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:50;';
  document.body.appendChild(_labelCanvas);
}

function removeLabelOverlay() {
  if (_labelCanvas) {
    _labelCanvas.remove();
    _labelCanvas = null;
    _labelCtx = null;
  }
}

function drawViewportLabel(x, y, cellW, cellH, target) {
  if (!_labelCanvas) return;
  if (!_labelCtx) {
    _labelCanvas.width = window.innerWidth;
    _labelCanvas.height = window.innerHeight;
    _labelCtx = _labelCanvas.getContext('2d');
  }

  // Convert WebGL coords (bottom-up) to CSS coords (top-down)
  const cssY = window.innerHeight - y - cellH;

  _labelCtx.font = '12px monospace';
  _labelCtx.fillStyle = target.hasError ? '#ff4444' : '#00ff88';
  _labelCtx.fillText(
    `${target.wlKind}/${target.wlName} (${target.nsName})`,
    x + 6,
    cssY + 16,
  );
}

function clearLabelOverlay() {
  if (_labelCtx && _labelCanvas) {
    _labelCanvas.width = window.innerWidth;
    _labelCanvas.height = window.innerHeight;
    _labelCtx = _labelCanvas.getContext('2d');
  }
}

// ── Toggle & Navigation ─────────────────────────────────────────

const CYCLE = [0, 4, 6, 8]; // 0 = off

function toggleSplitView() {
  const currentIdx = CYCLE.indexOf(splitView.count);
  const nextIdx = (currentIdx + 1) % CYCLE.length;
  const nextCount = CYCLE[nextIdx];

  if (nextCount === 0) {
    // Turning off
    splitView.active = false;
    splitView.count = 0;
    splitView.offset = 0;
    removeLabelOverlay();

    // Restore full viewport
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    renderer.setScissor(0, 0, window.innerWidth, window.innerHeight);
    renderer.setScissorTest(false);
  } else {
    splitView.active = true;
    splitView.count = nextCount;
    splitView.offset = 0;
    ensureCameras(nextCount);
    ensureLabelOverlay();
  }

  updateSplitViewHUD();
  updateControlsHint();
}

function navigateSplitView(direction) {
  if (!splitView.active) return;
  const ranked = rankWorkloads();
  const maxOffset = Math.max(0, ranked.length - splitView.count);

  splitView.offset = Math.max(0, Math.min(maxOffset, splitView.offset + direction * splitView.count));
  updateSplitViewHUD();
}

// ── HUD ─────────────────────────────────────────────────────────

function updateSplitViewHUD() {
  let el = document.getElementById('splitview-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'splitview-indicator';
    el.style.cssText = 'position:fixed;bottom:10px;left:50%;transform:translateX(-50%);color:#00aaff;font-family:monospace;font-size:13px;background:rgba(0,0,0,0.7);padding:4px 12px;border:1px solid #00aaff;border-radius:4px;z-index:100;pointer-events:none;transition:opacity 0.3s;';
    document.body.appendChild(el);
  }

  if (splitView.active) {
    const ranked = rankWorkloads();
    const errorCount = ranked.filter(t => t.hasError).length;
    const page = Math.floor(splitView.offset / splitView.count) + 1;
    const totalPages = Math.ceil(ranked.length / splitView.count);
    el.style.opacity = '1';
    el.textContent = `SPLIT ${splitView.count}x | ${errorCount} errors | Page ${page}/${totalPages} [N/P: navigate, S: cycle]`;
  } else {
    el.style.opacity = '0';
  }
}

export {
  splitView,
  toggleSplitView,
  navigateSplitView,
  updateSplitCameras,
  renderSplitView,
  clearLabelOverlay,
};

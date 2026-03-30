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
  targets: [],     // { nsName, worldPos, bbox }[]
  offset: 0,       // pagination offset for N/P
  time: 0,         // elapsed time for gentle orbit
  dots: [],        // minimap dot sprites for split cameras
  // Tour mode (T while in split)
  tour: false,
  tourAngle: 0,     // current orbit angle for the tour
  tourLaps: 0,      // completed laps on current page
  tourLapsTarget: 2,
  tourOrbitSpeed: 0.4, // radians/s
};

// Grid layouts for each split count
const LAYOUTS = {
  4: { cols: 2, rows: 2 },
  6: { cols: 3, rows: 2 },
  8: { cols: 4, rows: 2 },
};

// Colors for each camera viewport (used in labels + minimap dots)
const CAM_COLORS = [
  '#ff4444', '#00aaff', '#ffaa00', '#00ff88',
  '#cc44ff', '#ff8844', '#44cccc', '#ffcc00',
];
const CAM_COLORS_HEX = [
  0xff4444, 0x00aaff, 0xffaa00, 0x00ff88,
  0xcc44ff, 0xff8844, 0x44cccc, 0xffcc00,
];

// ── Namespace ranking (errors first, then alphabetical) ─────────

function rankNamespaces() {
  const errorNamespaces = [];
  const healthyNamespaces = [];

  for (const [nsName, ns] of state.namespaces) {
    let hasError = false;
    for (const [, mesh] of ns.pods) {
      const pod = mesh.userData.pod;
      if (pod && ERROR_STATUSES.has(pod.status)) {
        hasError = true;
        break;
      }
    }

    // Compute bounding box from the namespace group (platform + all children)
    const worldPos = new THREE.Vector3();
    ns.group.getWorldPosition(worldPos);

    const bbox = new THREE.Box3();
    // Use the platform mesh for base size (it defines the namespace island)
    if (ns.platform) {
      const platBox = new THREE.Box3().setFromObject(ns.platform);
      bbox.union(platBox);
    }
    // Also include all pod positions
    for (const [, mesh] of ns.pods) {
      const wp = new THREE.Vector3();
      mesh.getWorldPosition(wp);
      bbox.expandByPoint(wp);
    }

    if (bbox.isEmpty()) {
      bbox.setFromCenterAndSize(worldPos, new THREE.Vector3(10, 2, 10));
    } else {
      bbox.expandByScalar(3);
    }

    const entry = { nsName, worldPos, bbox, hasError };
    if (hasError) {
      errorNamespaces.push(entry);
    } else {
      healthyNamespaces.push(entry);
    }
  }

  errorNamespaces.sort((a, b) => a.nsName.localeCompare(b.nsName));
  healthyNamespaces.sort((a, b) => a.nsName.localeCompare(b.nsName));

  return [...errorNamespaces, ...healthyNamespaces];
}

// ── Camera management ───────────────────────────────────────────

function ensureCameras(count) {
  while (splitView.cameras.length < count) {
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
    splitView.cameras.push(cam);
  }
}

function fitCameraToBox(cam, bbox, center) {
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const maxDim = Math.max(size.x, size.z, 6); // minimum 6 units
  const fov = cam.fov * (Math.PI / 180);
  // Distance to see the full bbox width + generous margin
  const distance = (maxDim / 2) / Math.tan(fov / 2) * 1.4;

  // Elevated position looking down at ~45°
  cam.position.set(
    center.x,
    center.y + distance * 0.9,
    center.z + distance * 0.5,
  );
  cam.lookAt(center);
}

function orbitCameraAroundBox(cam, bbox, center, angle) {
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const maxDim = Math.max(size.x, size.z, 6);
  const fov = cam.fov * (Math.PI / 180);
  const distance = (maxDim / 2) / Math.tan(fov / 2) * 1.4;

  cam.position.set(
    center.x + Math.cos(angle) * distance * 0.5,
    center.y + distance * 0.9,
    center.z + Math.sin(angle) * distance * 0.5,
  );
  cam.lookAt(center);
}

function updateSplitCameras(dt) {
  if (!splitView.active) return;

  splitView.time += dt;
  const ranked = rankNamespaces();
  const count = splitView.count;
  const offset = splitView.offset;

  // Select namespaces for current page
  splitView.targets = [];
  for (let i = 0; i < count; i++) {
    const idx = offset + i;
    if (idx < ranked.length) {
      splitView.targets.push(ranked[idx]);
    }
  }

  // Tour mode: orbit cameras and auto-advance pages
  if (splitView.tour) {
    splitView.tourAngle += splitView.tourOrbitSpeed * dt;

    if (splitView.tourAngle >= Math.PI * 2) {
      splitView.tourAngle -= Math.PI * 2;
      splitView.tourLaps++;

      if (splitView.tourLaps >= splitView.tourLapsTarget) {
        // Advance to next page
        splitView.tourLaps = 0;
        const maxOffset = Math.max(0, ranked.length - count);
        splitView.offset += count;
        if (splitView.offset > maxOffset) {
          splitView.offset = 0; // wrap around
        }
        updateSplitViewHUD();
      }
    }

    for (let i = 0; i < splitView.targets.length; i++) {
      const target = splitView.targets[i];
      const cam = splitView.cameras[i];
      const phaseOffset = i * 0.3;
      orbitCameraAroundBox(cam, target.bbox, target.worldPos, splitView.tourAngle + phaseOffset);
    }
  } else {
    // Static mode: fixed camera position
    for (let i = 0; i < splitView.targets.length; i++) {
      const target = splitView.targets[i];
      const cam = splitView.cameras[i];
      fitCameraToBox(cam, target.bbox, target.worldPos);
    }
  }

  // Update minimap dots
  updateMinimapDots();
}

// ── Minimap dots for split cameras ──────────────────────────────

function createDotTexture(color) {
  const size = 16;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.stroke();
  // Number in center
  return new THREE.CanvasTexture(c);
}

function createNumberedDotTexture(color, number) {
  const size = 24;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = 'bold 14px monospace';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(number), size / 2, size / 2);
  return new THREE.CanvasTexture(c);
}

function ensureMinimapDots(count) {
  // Remove excess dots
  while (splitView.dots.length > count) {
    const dot = splitView.dots.pop();
    scene.remove(dot);
    dot.material.map?.dispose();
    dot.material.dispose();
  }
  // Create new dots
  while (splitView.dots.length < count) {
    const idx = splitView.dots.length;
    const tex = createNumberedDotTexture(CAM_COLORS[idx % CAM_COLORS.length], idx + 1);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex,
      depthTest: false,
      transparent: true,
    }));
    sprite.scale.set(3, 3, 1);
    sprite.visible = false;
    scene.add(sprite);
    splitView.dots.push(sprite);
  }
}

function updateMinimapDots() {
  if (!splitView.active) {
    for (const dot of splitView.dots) dot.visible = false;
    return;
  }

  ensureMinimapDots(splitView.targets.length);

  for (let i = 0; i < splitView.dots.length; i++) {
    const dot = splitView.dots[i];
    if (i < splitView.targets.length) {
      const cam = splitView.cameras[i];
      dot.position.set(cam.position.x, 197, cam.position.z);
      dot.visible = true;
    } else {
      dot.visible = false;
    }
  }
}

function cleanupMinimapDots() {
  for (const dot of splitView.dots) {
    scene.remove(dot);
    dot.material.map?.dispose();
    dot.material.dispose();
  }
  splitView.dots = [];
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
    } else {
      renderer.setClearColor(0x020202, 1);
      renderer.clear();
    }
  }

  renderer.setScissorTest(false);
  renderer.autoClear = true;

  // Restore full viewport so minimap and other renderers work correctly
  renderer.setViewport(0, 0, w, h);
  renderer.setScissor(0, 0, w, h);

  // Draw 2D label overlay on top
  drawAllViewportLabels(layout, cellW, cellH);

  return true;
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

function drawAllViewportLabels(layout, cellW, cellH) {
  if (!_labelCanvas) return;

  const w = window.innerWidth;
  const h = window.innerHeight;

  // Resize canvas to match window
  if (_labelCanvas.width !== w || _labelCanvas.height !== h) {
    _labelCanvas.width = w;
    _labelCanvas.height = h;
  }
  _labelCtx = _labelCanvas.getContext('2d');
  _labelCtx.clearRect(0, 0, w, h);

  for (let i = 0; i < splitView.count; i++) {
    const col = i % layout.cols;
    const row = Math.floor(i / layout.cols);
    const cssX = col * cellW;
    const cssY = row * cellH;
    const color = CAM_COLORS[i % CAM_COLORS.length];

    // Viewport border
    _labelCtx.strokeStyle = color;
    _labelCtx.lineWidth = 1;
    _labelCtx.strokeRect(cssX, cssY, cellW, cellH);

    if (i < splitView.targets.length) {
      const target = splitView.targets[i];

      // Namespace label (top-left)
      _labelCtx.font = '13px monospace';
      _labelCtx.fillStyle = target.hasError ? '#ff4444' : '#00ff88';
      _labelCtx.fillText(
        `ns/${target.nsName}${target.hasError ? ' ⚠' : ''}`,
        cssX + 6,
        cssY + 16,
      );

      // Camera number (bottom-right)
      _labelCtx.font = 'bold 20px monospace';
      _labelCtx.fillStyle = color;
      _labelCtx.textAlign = 'right';
      _labelCtx.fillText(
        String(i + 1),
        cssX + cellW - 8,
        cssY + cellH - 8,
      );
      _labelCtx.textAlign = 'left'; // reset
    } else {
      // Empty viewport label
      _labelCtx.font = '12px monospace';
      _labelCtx.fillStyle = '#444444';
      _labelCtx.fillText('No namespace', cssX + 6, cssY + 16);
    }
  }
}

function clearLabelOverlay() {
  if (_labelCtx && _labelCanvas) {
    _labelCtx.clearRect(0, 0, _labelCanvas.width, _labelCanvas.height);
  }
}

// ── Toggle & Navigation ─────────────────────────────────────────

const CYCLE = [0, 4, 6, 8]; // 0 = off

function toggleSplitView() {
  const currentIdx = CYCLE.indexOf(splitView.count);
  const nextIdx = (currentIdx + 1) % CYCLE.length;
  const nextCount = CYCLE[nextIdx];

  if (nextCount === 0) {
    splitView.active = false;
    splitView.count = 0;
    splitView.offset = 0;
    splitView.tour = false;
    splitView.tourLaps = 0;
    splitView.tourAngle = 0;
    removeLabelOverlay();
    cleanupMinimapDots();

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
  const ranked = rankNamespaces();
  const maxOffset = Math.max(0, ranked.length - splitView.count);

  splitView.offset = Math.max(0, Math.min(maxOffset, splitView.offset + direction * splitView.count));
  splitView.tourLaps = 0;
  splitView.tourAngle = 0;
  updateSplitViewHUD();
}

function toggleSplitTour() {
  if (!splitView.active) return;
  splitView.tour = !splitView.tour;
  splitView.tourAngle = 0;
  splitView.tourLaps = 0;
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
    const ranked = rankNamespaces();
    const errorCount = ranked.filter(t => t.hasError).length;
    const page = Math.floor(splitView.offset / splitView.count) + 1;
    const totalPages = Math.max(1, Math.ceil(ranked.length / splitView.count));
    el.style.opacity = '1';
    const tourLabel = splitView.tour ? ' | TOUR ON' : '';
    el.textContent = `SPLIT ${splitView.count}x | ${errorCount} errors | Page ${page}/${totalPages}${tourLabel} [T: tour, N/P: navigate, S: cycle]`;
  } else {
    el.style.opacity = '0';
  }
}

export {
  splitView,
  toggleSplitView,
  toggleSplitTour,
  navigateSplitView,
  updateSplitCameras,
  renderSplitView,
  clearLabelOverlay,
};

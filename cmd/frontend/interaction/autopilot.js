import * as THREE from 'three';
import { state } from '../core/state.js';
import { camera } from '../core/scene.js';
import { computeLayoutExtent } from '../rendering/namespaces.js';
import { startFlyTo, cancelFlyTo, showPodLabels, clearPodLabels, euler, spot, updateControlsHint } from './camera.js';

// ── Autopilot — automatic camera tour ─────────────────────────

const autopilot = {
  active: false,
  phase: 'orbit',     // 'orbit' | 'flyto' | 'focus-orbit' | 'waiting'
  angle: 0,           // current orbit angle (radians)
  focusAngle: 0,      // orbit angle around focused workload
  focusLaps: 0,       // completed laps around focused workload
  focusTarget: null,   // { nsName, worldPos } being inspected
  queue: [],           // namespaces with errors to visit
  visitedSet: new Set(), // namespaces already visited in this cycle
  orbitRadius: 40,
  orbitHeight: 20,
  orbitSpeed: 0.15,    // radians per second (general tour)
  focusRadius: 12,
  focusHeight: 8,
  focusSpeed: 0.6,     // radians per second (around workload)
  focusLapsTarget: 2,
};

// ── Error detection ─────────────────────────────────────────────

const ERROR_STATUSES = new Set(['CrashLoopBackOff', 'Error', 'Failed', 'ImagePullBackOff']);

function findErrorNamespaces() {
  const result = [];
  for (const [nsName, ns] of state.namespaces) {
    let hasError = false;
    for (const [, mesh] of ns.pods) {
      const pod = mesh.userData.pod;
      if (pod && ERROR_STATUSES.has(pod.status)) {
        hasError = true;
        break;
      }
    }
    if (hasError) result.push(nsName);
  }
  return result;
}

function hasNewErrors() {
  const current = findErrorNamespaces();
  for (const ns of current) {
    if (!autopilot.visitedSet.has(ns)) return true;
  }
  return false;
}

// ── Orbit computation ───────────────────────────────────────────

function computeOrbitPosition(centerX, centerZ, radius, height, angle) {
  return new THREE.Vector3(
    centerX + Math.cos(angle) * radius,
    height,
    centerZ + Math.sin(angle) * radius,
  );
}

function lookAtSmooth(targetPos, factor) {
  const lookMat = new THREE.Matrix4();
  lookMat.lookAt(camera.position, targetPos, new THREE.Vector3(0, 1, 0));
  const targetQuat = new THREE.Quaternion().setFromRotationMatrix(lookMat);
  camera.quaternion.slerp(targetQuat, factor);
  euler.setFromQuaternion(camera.quaternion);
}

// ── Toggle ──────────────────────────────────────────────────────

function toggleAutopilot() {
  autopilot.active = !autopilot.active;

  if (autopilot.active) {
    autopilot.phase = 'orbit';
    autopilot.angle = Math.atan2(
      camera.position.z - 0,
      camera.position.x - 0,
    );
    autopilot.visitedSet.clear();
    autopilot.queue = [];
    autopilot.focusTarget = null;
    cancelFlyTo();
  } else {
    autopilot.phase = 'orbit';
    autopilot.focusTarget = null;
    clearPodLabels();
  }

  updateAutopilotHUD();
  updateControlsHint();
}

function stopAutopilot() {
  if (!autopilot.active) return;
  autopilot.active = false;
  autopilot.phase = 'orbit';
  autopilot.focusTarget = null;
  clearPodLabels();
  updateAutopilotHUD();
  updateControlsHint();
}

// ── HUD indicator ───────────────────────────────────────────────

function updateAutopilotHUD() {
  let el = document.getElementById('autopilot-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'autopilot-indicator';
    el.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);color:#00ff88;font-family:monospace;font-size:14px;background:rgba(0,0,0,0.7);padding:4px 12px;border:1px solid #00ff88;border-radius:4px;z-index:100;pointer-events:none;transition:opacity 0.3s;';
    document.body.appendChild(el);
  }

  if (autopilot.active) {
    el.style.opacity = '1';
    const phaseLabel = autopilot.phase === 'focus-orbit'
      ? `INSPECTING ${autopilot.focusTarget?.nsName || '...'}`
      : 'TOURING';
    el.textContent = `AUTOPILOT: ${phaseLabel} [T to stop]`;
  } else {
    el.style.opacity = '0';
  }
}

// ── Main update (called each frame) ─────────────────────────────

function updateAutopilot(dt) {
  if (!autopilot.active) return;

  const { cx, cz, extent } = computeLayoutExtent();
  autopilot.orbitRadius = Math.max(extent * 0.6, 30);
  autopilot.orbitHeight = Math.max(extent * 0.3, 15);

  switch (autopilot.phase) {

    // ── General orbit around the whole cluster ──────────────────
    case 'orbit': {
      autopilot.angle += autopilot.orbitSpeed * dt;

      const pos = computeOrbitPosition(cx, cz, autopilot.orbitRadius, autopilot.orbitHeight, autopilot.angle);
      camera.position.lerp(pos, 0.03);
      lookAtSmooth(new THREE.Vector3(cx, 0, cz), 0.03);

      // Check for errors periodically (every ~30 degrees of rotation)
      const errorNs = findErrorNamespaces();
      const unvisited = errorNs.filter(ns => !autopilot.visitedSet.has(ns));

      if (unvisited.length > 0) {
        autopilot.queue = unvisited;
        autopilot.phase = 'flyto';
      }

      // Full circle? Reset visited set so we can re-detect
      if (autopilot.angle > Math.PI * 2) {
        autopilot.angle -= Math.PI * 2;
        autopilot.visitedSet.clear();
      }
      break;
    }

    // ── Flying towards an error namespace ───────────────────────
    case 'flyto': {
      if (autopilot.queue.length === 0) {
        autopilot.phase = 'orbit';
        break;
      }

      const nsName = autopilot.queue[0];
      const ns = state.namespaces.get(nsName);
      if (!ns) {
        autopilot.queue.shift();
        break;
      }

      const worldPos = new THREE.Vector3();
      ns.group.getWorldPosition(worldPos);

      // Fly toward the namespace
      const targetPos = new THREE.Vector3(
        worldPos.x + autopilot.focusRadius,
        autopilot.focusHeight,
        worldPos.z,
      );

      camera.position.lerp(targetPos, 0.04);
      lookAtSmooth(worldPos, 0.04);

      // Close enough? Start focus orbit
      if (camera.position.distanceTo(targetPos) < 1) {
        autopilot.focusTarget = { nsName, worldPos };
        autopilot.focusAngle = 0;
        autopilot.focusLaps = 0;
        autopilot.phase = 'focus-orbit';
        autopilot.visitedSet.add(nsName);
        showPodLabels(nsName);
        updateAutopilotHUD();
      }
      break;
    }

    // ── Orbiting around a specific error namespace ──────────────
    case 'focus-orbit': {
      if (!autopilot.focusTarget) {
        autopilot.phase = 'orbit';
        break;
      }

      const { worldPos, nsName } = autopilot.focusTarget;
      autopilot.focusAngle += autopilot.focusSpeed * dt;

      const pos = computeOrbitPosition(worldPos.x, worldPos.z, autopilot.focusRadius, autopilot.focusHeight, autopilot.focusAngle);
      camera.position.lerp(pos, 0.06);
      lookAtSmooth(worldPos, 0.06);

      // Check for full laps
      if (autopilot.focusAngle > Math.PI * 2) {
        autopilot.focusAngle -= Math.PI * 2;
        autopilot.focusLaps++;

        if (autopilot.focusLaps >= autopilot.focusLapsTarget) {
          // Done with this namespace
          clearPodLabels();
          autopilot.focusTarget = null;
          autopilot.queue.shift();

          // Check for new errors that appeared during focus
          if (hasNewErrors()) {
            const errorNs = findErrorNamespaces();
            const unvisited = errorNs.filter(ns => !autopilot.visitedSet.has(ns));
            autopilot.queue = unvisited;
          }

          if (autopilot.queue.length > 0) {
            autopilot.phase = 'flyto';
          } else {
            autopilot.phase = 'orbit';
          }
          updateAutopilotHUD();
        }
      }

      // Interrupt: new error appeared in a different namespace
      const newErrors = findErrorNamespaces().filter(
        ns => !autopilot.visitedSet.has(ns) && ns !== nsName,
      );
      if (newErrors.length > 0 && autopilot.focusLaps >= 1) {
        // Finish current lap early, queue the new errors
        clearPodLabels();
        autopilot.focusTarget = null;
        autopilot.queue = newErrors;
        autopilot.phase = 'flyto';
        updateAutopilotHUD();
      }
      break;
    }
  }
}

export {
  autopilot,
  toggleAutopilot,
  stopAutopilot,
  updateAutopilot,
};

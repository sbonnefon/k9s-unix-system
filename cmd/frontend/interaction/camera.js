import * as THREE from 'three';
import { state } from '../core/state.js';
import {
  scene,
  canvas,
  camera,
  orthoCamera,
  eagleEye,
  activeCamera,
  updateOrthoFrustum,
  renderPass,
  ambient,
  spotlight,
  BEAM_TOP_RADIUS,
  BEAM_BOT_RADIUS,
  BEAM_SOURCE_OFFSET,
  beamClipPlane,
  beamMat,
  beamCone,
  glowMat,
  glowDisc,
  minimap,
  updateMinimapCamera,
} from '../core/scene.js';
import { statusColor } from '../core/materials.js';
import { makeLabel, markBillboardsDirty } from '../rendering/labels.js';
import { computeLayoutExtent } from '../rendering/namespaces.js';
import { setPointerLocked } from './raycast.js';

// ── Fly Camera Controller ──────────────────────────────────────
const velocity = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const keys = {};
let pointerLocked = false;

// Spotlight animation state
const spot = {
  active: false,
  fadingIn: false,
  fadingOut: false,
  intensity: 0,
  beamOpacity: 0,
  glowOpacity: 0,
  targetIntensity: 60,
  targetBeamOpacity: 0.03,
  targetGlowOpacity: 0.09,
  fadeSpeed: 2.5,
  nsName: null,
  podLabels: [],
};

const BASE_AMBIENT = 0.8;
const DIM_AMBIENT = 0.25;

function positionSpotlight(nsName) {
  const island = nsName === '__nodes__' ? state.nodeIsland : state.namespaces.get(nsName);
  if (!island) return;
  const wp = new THREE.Vector3();
  island.group.getWorldPosition(wp);

  const sourcePos = wp.clone().add(BEAM_SOURCE_OFFSET);
  spotlight.position.copy(sourcePos);
  spotlight.target.position.copy(wp);

  const coneEnd = wp.clone();
  const beamDir = new THREE.Vector3().subVectors(coneEnd, sourcePos).normalize();
  const sinTilt = Math.sqrt(beamDir.x * beamDir.x + beamDir.z * beamDir.z);
  const overshoot = (BEAM_BOT_RADIUS * sinTilt / Math.abs(beamDir.y)) * 1.5;
  coneEnd.addScaledVector(beamDir, overshoot);

  beamClipPlane.set(new THREE.Vector3(0, 1, 0), -wp.y);

  const dist = sourcePos.distanceTo(coneEnd);
  beamCone.scale.set(1, dist, 1);
  const mid = sourcePos.clone().add(coneEnd).multiplyScalar(0.5);
  beamCone.position.copy(mid);
  const upDir = new THREE.Vector3().subVectors(sourcePos, coneEnd).normalize();
  beamCone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), upDir);

  const distToGround = sourcePos.distanceTo(wp);
  const tParam = distToGround / dist;
  const rGround = BEAM_TOP_RADIUS + (BEAM_BOT_RADIUS - BEAM_TOP_RADIUS) * tParam;
  const cosTilt = Math.abs(beamDir.y);
  const semiMajor = rGround / cosTilt;
  const semiMinor = rGround;
  const discAngle = Math.atan2(-beamDir.z, beamDir.x);
  glowDisc.rotation.set(-Math.PI / 2, 0, discAngle);
  glowDisc.scale.set(semiMajor / 3.5, semiMinor / 3.5, 1);
  glowDisc.position.set(wp.x, wp.y + 0.05, wp.z);
}

function showPodLabels(nsName) {
  clearPodLabels();

  if (nsName === '__nodes__' && state.nodeIsland) {
    const island = state.nodeIsland;
    for (const [nodeName, blockMesh] of island.blocks) {
      const nodeInfo = state.nodes.get(nodeName);
      const nodeColor = nodeInfo && nodeInfo.status === 'Ready' ? '#44ccee' : '#ff6666';
      const label = makeLabel(nodeName, 48, nodeColor, { billboard: true });
      label.scale.set(0.14, 0.14, 0.14);
      label.position.set(blockMesh.position.x, 1.2, blockMesh.position.z);
      label.material.opacity = 0;
      island.group.add(label);
      spot.podLabels.push({ mesh: label, group: island.group });
    }
    return;
  }

  const ns = state.namespaces.get(nsName);
  if (!ns) return;
  for (const [podName, podMesh] of ns.pods) {
    const pod = podMesh.userData.pod;
    const podColor = pod ? '#' + new THREE.Color(statusColor(pod.status)).getHexString() : '#00ff88';
    const label = makeLabel(podName, 48, podColor, { billboard: true });
    label.scale.set(0.14, 0.14, 0.14);
    label.position.set(podMesh.position.x, podMesh.position.y + 1.0, podMesh.position.z);
    label.material.opacity = 0;
    ns.group.add(label);
    spot.podLabels.push({ mesh: label, group: ns.group });
  }
}

function clearPodLabels() {
  for (const { mesh, group } of spot.podLabels) {
    group.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.map?.dispose();
    mesh.material.dispose();
  }
  spot.podLabels = [];
  markBillboardsDirty();
}

function startSpotlight(nsName) {
  spot.nsName = nsName;
  positionSpotlight(nsName);
  beamCone.visible = true;
  glowDisc.visible = true;
  spot.fadingIn = true;
  spot.fadingOut = false;
  spot.active = true;
  showPodLabels(nsName);
}

function fadeOutSpotlight() {
  if (!spot.active && !spot.fadingOut) return;
  spot.fadingIn = false;
  spot.fadingOut = true;
}

function updateSpotlight(dt) {
  if (spot.fadingIn) {
    spot.intensity = Math.min(spot.intensity + spot.fadeSpeed * dt * spot.targetIntensity, spot.targetIntensity);
    spot.beamOpacity = Math.min(spot.beamOpacity + spot.fadeSpeed * dt * spot.targetBeamOpacity, spot.targetBeamOpacity);
    spot.glowOpacity = Math.min(spot.glowOpacity + spot.fadeSpeed * dt * spot.targetGlowOpacity, spot.targetGlowOpacity);
    ambient.intensity = Math.max(ambient.intensity - spot.fadeSpeed * dt * (BASE_AMBIENT - DIM_AMBIENT), DIM_AMBIENT);
    if (spot.intensity >= spot.targetIntensity) spot.fadingIn = false;
  }
  if (spot.fadingOut) {
    spot.intensity = Math.max(spot.intensity - spot.fadeSpeed * dt * spot.targetIntensity, 0);
    spot.beamOpacity = Math.max(spot.beamOpacity - spot.fadeSpeed * dt * spot.targetBeamOpacity, 0);
    spot.glowOpacity = Math.max(spot.glowOpacity - spot.fadeSpeed * dt * spot.targetGlowOpacity, 0);
    ambient.intensity = Math.min(ambient.intensity + spot.fadeSpeed * dt * (BASE_AMBIENT - DIM_AMBIENT), BASE_AMBIENT);
    if (spot.intensity <= 0) {
      spot.fadingOut = false;
      spot.active = false;
      beamCone.visible = false;
      glowDisc.visible = false;
      spot.nsName = null;
      clearPodLabels();
    }
  }
  spotlight.intensity = spot.intensity;
  beamMat.opacity = spot.beamOpacity;
  glowMat.opacity = spot.glowOpacity;

  const podLabelOpacity = spot.intensity / spot.targetIntensity * 0.85;
  for (const { mesh } of spot.podLabels) {
    mesh.material.opacity = podLabelOpacity;
  }
}

// Fly-to animation state
const flyTo = {
  active: false,
  startPos: new THREE.Vector3(),
  startQuat: new THREE.Quaternion(),
  endPos: new THREE.Vector3(),
  endQuat: new THREE.Quaternion(),
  progress: 0,
  duration: 1.4,
};

function cancelFlyTo() {
  if (!flyTo.active && !spot.active) return;
  flyTo.active = false;
  euler.setFromQuaternion(camera.quaternion);
  fadeOutSpotlight();
}

function startFlyTo(nsName) {
  const island = nsName === '__nodes__' ? state.nodeIsland : state.namespaces.get(nsName);
  if (!island) return;

  fadeOutSpotlight();

  const worldPos = new THREE.Vector3();
  island.group.getWorldPosition(worldPos);

  flyTo.startPos.copy(camera.position);
  flyTo.startQuat.copy(camera.quaternion);
  flyTo.endPos.set(worldPos.x, worldPos.y + 10, worldPos.z + 12);

  const lookMat = new THREE.Matrix4();
  lookMat.lookAt(flyTo.endPos, worldPos, new THREE.Vector3(0, 1, 0));
  flyTo.endQuat.setFromRotationMatrix(lookMat);

  flyTo.progress = 0;
  flyTo.active = true;
  flyTo.targetNs = nsName;
  velocity.set(0, 0, 0);
}

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function updateFlyTo(dt) {
  if (!flyTo.active) return;
  flyTo.progress = Math.min(1, flyTo.progress + dt / flyTo.duration);
  const t = easeInOut(flyTo.progress);
  camera.position.lerpVectors(flyTo.startPos, flyTo.endPos, t);
  camera.quaternion.slerpQuaternions(flyTo.startQuat, flyTo.endQuat, t);
  if (flyTo.progress >= 1) {
    flyTo.active = false;
    euler.setFromQuaternion(camera.quaternion);
    if (flyTo.targetNs) startSpotlight(flyTo.targetNs);
  }
}

function toggleEagleEye() {
  eagleEye.active = !eagleEye.active;

  if (eagleEye.active) {
    if (pointerLocked) document.exitPointerLock();
    cancelFlyTo();

    const { cx, cz, extent } = computeLayoutExtent();
    eagleEye.panX = cx;
    eagleEye.panZ = cz;
    eagleEye.zoom = extent;
    orthoCamera.position.set(eagleEye.panX, 100, eagleEye.panZ);
    orthoCamera.lookAt(eagleEye.panX, 0, eagleEye.panZ);
    updateOrthoFrustum();
    renderPass.camera = orthoCamera;
  } else {
    renderPass.camera = camera;
    euler.setFromQuaternion(camera.quaternion);
  }
  updateControlsHint();
}

function toggleMinimap() {
  minimap.visible = !minimap.visible;
  const el = document.getElementById('minimap');
  el.style.display = minimap.visible ? 'block' : 'none';
  if (minimap.visible) {
    const { extent } = computeLayoutExtent();
    updateMinimapCamera(camera, extent);
  }
  updateControlsHint();
}

function updateControlsHint() {
  const hint = document.getElementById('controls-hint');
  if (eagleEye.active) {
    hint.textContent = 'EAGLE EYE \u2022 WASD/Arrows: Pan \u2022 Scroll: Zoom \u2022 E: Exit \u2022 M: Minimap';
  } else {
    hint.textContent = 'WASD/Arrows: Move \u00b7 Mouse: Look \u00b7 Shift: Fast \u00b7 Space/Ctrl: Up/Down \u00b7 Click: Lock cursor \u00b7 Esc: Unlock \u00b7 E: Eagle Eye \u00b7 M: Minimap';
  }
}

function updateCamera(dt) {
  if (eagleEye.active) {
    const speed = keys['ShiftLeft'] || keys['ShiftRight'] ? 60 : 25;
    const dx = ((keys['KeyD'] || keys['ArrowRight']) ? 1 : 0) - ((keys['KeyA'] || keys['ArrowLeft']) ? 1 : 0);
    const dz = ((keys['KeyS'] || keys['ArrowDown']) ? 1 : 0) - ((keys['KeyW'] || keys['ArrowUp']) ? 1 : 0);
    eagleEye.panX += dx * speed * dt;
    eagleEye.panZ += dz * speed * dt;
    orthoCamera.position.set(eagleEye.panX, 100, eagleEye.panZ);
    orthoCamera.lookAt(eagleEye.panX, 0, eagleEye.panZ);
    return;
  }

  if (flyTo.active) { updateFlyTo(dt); return; }

  const speed = keys['ShiftLeft'] || keys['ShiftRight'] ? 40 : 15;
  const direction = new THREE.Vector3();

  if (keys['KeyW'] || keys['ArrowUp']) direction.z -= 1;
  if (keys['KeyS'] || keys['ArrowDown']) direction.z += 1;
  if (keys['KeyA'] || keys['ArrowLeft']) direction.x -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) direction.x += 1;
  if (keys['Space']) direction.y += 1;
  if (keys['ControlLeft'] || keys['ControlRight']) direction.y -= 1;

  direction.normalize();
  direction.applyQuaternion(camera.quaternion);

  velocity.lerp(direction.multiplyScalar(speed), 0.1);
  camera.position.addScaledVector(velocity, dt);

  // Update minimap camera to follow main camera
  if (minimap.visible) {
    const { extent } = computeLayoutExtent();
    updateMinimapCamera(camera, extent);
  }
}

// ── Keyboard events ─────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  keys[e.code] = true;

  if (e.code === 'KeyE' && !e.repeat) {
    toggleEagleEye();
    return;
  }

  if (e.code === 'KeyM' && !e.repeat) {
    toggleMinimap();
    return;
  }

  const movement = ['KeyW','KeyS','KeyA','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','ControlLeft','ControlRight'];
  if (movement.includes(e.code)) {
    if ((e.code === 'KeyW' || e.code === 'KeyS') && spot.active && !flyTo.active) return;
    cancelFlyTo();
  }
});
document.addEventListener('keyup', (e) => { keys[e.code] = false; });

// Scroll-to-zoom in Eagle Eye mode
canvas.addEventListener('wheel', (e) => {
  if (!eagleEye.active) return;
  e.preventDefault();
  eagleEye.zoom = Math.max(10, Math.min(600, eagleEye.zoom + e.deltaY * 0.1));
  updateOrthoFrustum();
}, { passive: false });

// Click to fly-to or lock pointer
canvas.addEventListener('click', (e) => {
  if (pointerLocked) return;
  const clickMouse = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  );
  const clickRay = new THREE.Raycaster();
  clickRay.setFromCamera(clickMouse, activeCamera());

  const targets = [];
  scene.traverse((obj) => {
    if (obj.userData.type === 'namespace') targets.push(obj);
    if (obj.userData.type === 'label') targets.push(obj);
  });
  const hits = clickRay.intersectObjects(targets);
  if (hits.length > 0) {
    const hit = hits[0].object;
    const nsName = hit.userData.name ?? hit.parent?.userData?.name;
    if (nsName) {
      if (eagleEye.active) toggleEagleEye();
      startFlyTo(nsName);
      return;
    }
  }
  if (!eagleEye.active) canvas.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
  setPointerLocked(pointerLocked);
});

document.addEventListener('mousemove', (e) => {
  if (!pointerLocked) return;
  cancelFlyTo();
  euler.setFromQuaternion(camera.quaternion);
  euler.y -= e.movementX * 0.002;
  euler.x -= e.movementY * 0.002;
  euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, euler.x));
  camera.quaternion.setFromEuler(euler);
});

export {
  velocity,
  euler,
  keys,
  spot,
  flyTo,
  cancelFlyTo,
  startFlyTo,
  toggleEagleEye,
  toggleMinimap,
  showPodLabels,
  clearPodLabels,
  updateCamera,
  updateSpotlight,
  updateControlsHint,
};

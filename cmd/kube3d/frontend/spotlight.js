import * as THREE from 'three';
import { state, selection, NODE_BLOCK_SIZE, POD_BASE_SIZE } from './state.js';
import {
  spotlight, BEAM_TOP_RADIUS, BEAM_BOT_RADIUS, BEAM_SOURCE_OFFSET,
  beamClipPlane, beamMat, beamCone, glowMat, glowDisc, ambient,
} from './scene.js';
import { makeLabel } from './labels.js';
import { disposeMesh } from './materials.js';
import { hideDetailPanel } from './detail-panel.js';

// ── Spotlight Presets ──────────────────────────────────────────
export const SPOT_NS = { intensity: 24, beamOpacity: 0.015, glowOpacity: 0.04, beamWidth: 1.6 };
export const SPOT_RES = { intensity: 60, beamOpacity: 0.03, glowOpacity: 0.09, beamWidth: 0.45 };

export const BASE_AMBIENT = 0.8;
const DIM_AMBIENT = 0.25;

// ── Spotlight State ────────────────────────────────────────────
export const spot = {
  active: false,
  fadingIn: false,
  fadingOut: false,
  intensity: 0,
  beamOpacity: 0,
  glowOpacity: 0,
  targetIntensity: SPOT_NS.intensity,
  targetBeamOpacity: SPOT_NS.beamOpacity,
  targetGlowOpacity: SPOT_NS.glowOpacity,
  fadeSpeed: 2.5,
  nsName: null,
  podLabels: [],
};

// ── Positioning ────────────────────────────────────────────────
export function positionSpotlight(nsName) {
  const island = nsName === '__nodes__' ? state.nodeIsland : state.namespaces.get(nsName);
  if (!island) return;
  const wp = new THREE.Vector3();
  island.group.getWorldPosition(wp);

  const w = selection.phase === 'resource' ? SPOT_RES.beamWidth : SPOT_NS.beamWidth;

  const sourcePos = wp.clone().add(BEAM_SOURCE_OFFSET);
  spotlight.position.copy(sourcePos);
  spotlight.target.position.copy(wp);
  spotlight.angle = Math.PI / 6 * w;

  const botR = BEAM_BOT_RADIUS * w;
  const coneEnd = wp.clone();
  const beamDir = new THREE.Vector3().subVectors(coneEnd, sourcePos).normalize();
  const sinTilt = Math.sqrt(beamDir.x * beamDir.x + beamDir.z * beamDir.z);
  const overshoot = (botR * sinTilt / Math.abs(beamDir.y)) * 1.5;
  coneEnd.addScaledVector(beamDir, overshoot);

  beamClipPlane.set(new THREE.Vector3(0, 1, 0), -wp.y);

  const dist = sourcePos.distanceTo(coneEnd);
  beamCone.scale.set(w, dist, w);
  const mid = sourcePos.clone().add(coneEnd).multiplyScalar(0.5);
  beamCone.position.copy(mid);
  const upDir = new THREE.Vector3().subVectors(sourcePos, coneEnd).normalize();
  beamCone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), upDir);

  const distToGround = sourcePos.distanceTo(wp);
  const tParam = distToGround / dist;
  const rGround = BEAM_TOP_RADIUS + (botR - BEAM_TOP_RADIUS) * tParam;
  const cosTilt = Math.abs(beamDir.y);
  const semiMajor = rGround / cosTilt;
  const semiMinor = rGround;
  const discAngle = Math.atan2(-beamDir.z, beamDir.x);
  glowDisc.rotation.set(-Math.PI / 2, 0, discAngle);
  glowDisc.scale.set(semiMajor / 3.5, semiMinor / 3.5, 1);
  glowDisc.position.set(wp.x, wp.y + 0.05, wp.z);
}

export function startSpotlight(nsName) {
  spot.nsName = nsName;
  spot.targetIntensity = SPOT_NS.intensity;
  spot.targetBeamOpacity = SPOT_NS.beamOpacity;
  spot.targetGlowOpacity = SPOT_NS.glowOpacity;
  positionSpotlight(nsName);
  beamCone.visible = true;
  glowDisc.visible = true;
  spot.fadingIn = true;
  spot.fadingOut = false;
  spot.active = true;
  selection.phase = 'namespace';
  selection.nsName = nsName;
  selection.resourceMesh = null;
  showPodLabels(nsName);
}

// Spotlight a specific resource (positions beam only — caller handles fly-to and detail panel)
export function startResourceSpotlight(resourceMesh) {
  const wp = new THREE.Vector3();
  resourceMesh.getWorldPosition(wp);

  const groundPos = new THREE.Vector3();
  resourceMesh.parent.getWorldPosition(groundPos);
  const surfaceY = groundPos.y;

  const w = SPOT_RES.beamWidth;

  const sourcePos = wp.clone().add(BEAM_SOURCE_OFFSET);
  spotlight.position.copy(sourcePos);
  spotlight.target.position.copy(wp);
  spotlight.angle = Math.PI / 6 * w;

  const botR = BEAM_BOT_RADIUS * w;
  const coneEnd = wp.clone();
  const beamDir = new THREE.Vector3().subVectors(coneEnd, sourcePos).normalize();
  const sinTilt = Math.sqrt(beamDir.x * beamDir.x + beamDir.z * beamDir.z);
  const overshoot = (botR * sinTilt / Math.abs(beamDir.y)) * 1.5;
  coneEnd.addScaledVector(beamDir, overshoot);

  beamClipPlane.set(new THREE.Vector3(0, 1, 0), -surfaceY);

  const dist = sourcePos.distanceTo(coneEnd);
  beamCone.scale.set(w, dist, w);
  const mid = sourcePos.clone().add(coneEnd).multiplyScalar(0.5);
  beamCone.position.copy(mid);
  const upDir = new THREE.Vector3().subVectors(sourcePos, coneEnd).normalize();
  beamCone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), upDir);

  const groundTarget = new THREE.Vector3(wp.x, surfaceY, wp.z);
  const distToGround = sourcePos.distanceTo(groundTarget);
  const tParam = distToGround / dist;
  const rGround = BEAM_TOP_RADIUS + (botR - BEAM_TOP_RADIUS) * tParam;
  const cosTilt = Math.abs(beamDir.y);
  const semiMajor = rGround / cosTilt;
  const semiMinor = rGround;
  const discAngle = Math.atan2(-beamDir.z, beamDir.x);
  glowDisc.rotation.set(-Math.PI / 2, 0, discAngle);
  glowDisc.scale.set(semiMajor / 3.5, semiMinor / 3.5, 1);
  glowDisc.position.set(wp.x, surfaceY + 0.05, wp.z);

  spot.targetIntensity = SPOT_RES.intensity;
  spot.targetBeamOpacity = SPOT_RES.beamOpacity;
  spot.targetGlowOpacity = SPOT_RES.glowOpacity;
  spot.fadingIn = true;
  spot.fadingOut = false;

  selection.phase = 'resource';
  selection.resourceMesh = resourceMesh;
}

export function fadeOutSpotlight() {
  if (!spot.active && !spot.fadingOut) return;
  spot.fadingIn = false;
  spot.fadingOut = true;
  selection.phase = 'none';
  selection.nsName = null;
  selection.resourceMesh = null;
  hideDetailPanel();
}

function lerpTo(current, target, step) {
  if (current < target) return Math.min(current + step * target, target);
  return Math.max(current - step * Math.abs(current), target);
}

export function updateSpotlight(dt) {
  if (spot.fadingIn) {
    const step = spot.fadeSpeed * dt;
    spot.intensity = lerpTo(spot.intensity, spot.targetIntensity, step);
    spot.beamOpacity = lerpTo(spot.beamOpacity, spot.targetBeamOpacity, step);
    spot.glowOpacity = lerpTo(spot.glowOpacity, spot.targetGlowOpacity, step);
    ambient.intensity = Math.max(ambient.intensity - spot.fadeSpeed * dt * (BASE_AMBIENT - DIM_AMBIENT), DIM_AMBIENT);
    if (Math.abs(spot.intensity - spot.targetIntensity) < 0.1) spot.fadingIn = false;
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

// ── Pod Labels ─────────────────────────────────────────────────
export function showPodLabels(nsName) {
  clearPodLabels();

  if (nsName === '__nodes__' && state.nodeIsland) {
    const island = state.nodeIsland;
    for (const [nodeName, blockMesh] of island.blocks) {
      const label = makeLabel(nodeName, 28, 1.6, 0.75);
      label.scale.set(0.12, 0.12, 0.12);
      label.position.set(blockMesh.position.x, 0.15, blockMesh.position.z + NODE_BLOCK_SIZE / 2 + 0.6);
      label.material.opacity = 0;
      island.group.add(label);
      spot.podLabels.push({ mesh: label, group: island.group });
    }
    return;
  }

  const ns = state.namespaces.get(nsName);
  if (!ns) return;
  for (const [podName, podMesh] of ns.pods) {
    const label = makeLabel(podName, 28, 1.6, 0.75);
    label.scale.set(0.12, 0.12, 0.12);
    const d = podMesh.geometry.parameters.depth || POD_BASE_SIZE;
    label.position.set(podMesh.position.x, 0.15, podMesh.position.z + d / 2 + 0.6);
    label.material.opacity = 0;
    ns.group.add(label);
    spot.podLabels.push({ mesh: label, group: ns.group });
  }
}

export function clearPodLabels() {
  for (const { mesh, group } of spot.podLabels) {
    group.remove(mesh);
    disposeMesh(mesh);
  }
  spot.podLabels = [];
}

import * as THREE from 'three';
import { statusColor, POD_BASE_SIZE, POD_MIN_SIZE, POD_MAX_SIZE } from './state.js';

// ── Platform & Pod Materials ───────────────────────────────────
export const platformMaterial = new THREE.MeshPhongMaterial({
  color: 0x882244,
  emissive: 0x331122,
  shininess: 30,
  transparent: true,
  opacity: 0.85,
});

export function podMaterial(status) {
  const color = statusColor(status);
  return new THREE.MeshPhongMaterial({
    color,
    emissive: new THREE.Color(color).multiplyScalar(0.3),
    shininess: 60,
    transparent: true,
    opacity: 0.9,
  });
}

export function disposeMaterial(material) {
  if (!material) return;
  if (Array.isArray(material)) {
    for (const mat of material) disposeMaterial(mat);
    return;
  }
  const textures = new Set();
  for (const value of Object.values(material)) {
    if (value && value.isTexture) textures.add(value);
  }
  for (const texture of textures) texture.dispose();
  material.dispose();
}

export function disposeMesh(mesh) {
  if (!mesh) return;
  mesh.geometry?.dispose();
  disposeMaterial(mesh.material);
}

// ── Resource Sizing ────────────────────────────────────────────
const CPU_MIN = 100;
const CPU_MAX = 2000;
const MEM_MIN = 64 * 1024 * 1024;
const MEM_MAX = 2 * 1024 * 1024 * 1024;

export function podWidth(cpuMillis) {
  if (!cpuMillis || cpuMillis <= 0) return POD_BASE_SIZE;
  const t = Math.max(0, Math.min(1, (cpuMillis - CPU_MIN) / (CPU_MAX - CPU_MIN)));
  return POD_MIN_SIZE + t * (POD_MAX_SIZE - POD_MIN_SIZE);
}

export function podDepth(memBytes) {
  if (!memBytes || memBytes <= 0) return POD_BASE_SIZE;
  const t = Math.max(0, Math.min(1, (memBytes - MEM_MIN) / (MEM_MAX - MEM_MIN)));
  return POD_MIN_SIZE + t * (POD_MAX_SIZE - POD_MIN_SIZE);
}

// ── Node Island Materials ──────────────────────────────────────
export const nodePlatformMaterial = new THREE.MeshPhongMaterial({
  color: 0x224466,
  emissive: 0x112244,
  shininess: 30,
  transparent: true,
  opacity: 0.85,
});

const NODE_BLOCK_COLORS = {
  Ready:    0x00ccff,
  NotReady: 0xff4444,
};

export function nodeBlockMaterial(status) {
  const color = NODE_BLOCK_COLORS[status] ?? 0x00ccff;
  return new THREE.MeshPhongMaterial({
    color,
    emissive: new THREE.Color(color).multiplyScalar(0.3),
    shininess: 60,
    transparent: true,
    opacity: 0.9,
  });
}

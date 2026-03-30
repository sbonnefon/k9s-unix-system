import * as THREE from 'three';
import { state, POD_BASE_SIZE, POD_Y_OFFSET } from '../core/state.js';
import { statusColor, podMaterial, podWidth, podDepth } from '../core/materials.js';
import { ensureNamespace } from './namespaces.js';
import { invalidateMeshCache } from '../interaction/raycast.js';

// Shared pod geometries -- created once, reused for all pods of same type
const _sharedGeo = {
  box: new THREE.BoxGeometry(POD_BASE_SIZE, POD_BASE_SIZE, POD_BASE_SIZE),
  cylinder: new THREE.CylinderGeometry(POD_BASE_SIZE * 0.5, POD_BASE_SIZE * 0.5, POD_BASE_SIZE, 6),
  octahedron: new THREE.OctahedronGeometry(POD_BASE_SIZE * 0.5),
  cone: new THREE.ConeGeometry(POD_BASE_SIZE * 0.45, POD_BASE_SIZE, 5),
};

// Pod geometry based on owner kind -- returns shared geometry
function podGeometry(ownerKind) {
  switch (ownerKind) {
    case 'StatefulSet':  return _sharedGeo.cylinder;
    case 'DaemonSet':    return _sharedGeo.octahedron;
    case 'Job':
    case 'CronJob':      return _sharedGeo.cone;
    default:             return _sharedGeo.box;
  }
}

// Container count rings around a pod mesh
function addContainerRings(parentGroup, mesh, containerCount, podColor) {
  // Remove old rings
  const oldRings = parentGroup.children.filter(c => c.userData._ringFor === mesh.uuid);
  for (const r of oldRings) {
    parentGroup.remove(r);
    r.geometry.dispose();
    r.material.dispose();
  }
  if (containerCount <= 1) return;

  const bbox = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3();
  bbox.getSize(size);
  const baseRadius = Math.max(size.x, size.z) * 0.55;

  for (let i = 1; i < containerCount; i++) {
    const ringRadius = baseRadius + i * 0.15;
    const ringGeo = new THREE.TorusGeometry(ringRadius, 0.03, 6, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: podColor,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(mesh.position);
    ring.position.y = 0.05 + i * 0.12;
    ring.userData = { _ringFor: mesh.uuid };
    parentGroup.add(ring);
  }
}

function addOrUpdatePod(nsName, pod) {
  const ns = ensureNamespace(nsName);

  const w = podWidth(pod.cpuRequest);
  const d = podDepth(pod.memoryRequest);
  const height = POD_BASE_SIZE + Math.min(pod.restarts * 0.15, 2);
  const sx = w / POD_BASE_SIZE;
  const sy = height / POD_BASE_SIZE;
  const sz = d / POD_BASE_SIZE;

  if (ns.pods.has(pod.name)) {
    const existing = ns.pods.get(pod.name);
    // material is pooled — don't dispose, just reassign
    existing.material = podMaterial(pod.status);
    existing.geometry = podGeometry(pod.ownerKind);
    existing.scale.set(sx, sy, sz);
    existing.userData = { type: 'pod', pod };
    addContainerRings(ns.group, existing, pod.containerCount || 1, statusColor(pod.status));
    return;
  }

  const geo = podGeometry(pod.ownerKind);
  const mat = podMaterial(pod.status);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(sx, sy, sz);
  mesh.userData = { type: 'pod', pod };
  ns.pods.set(pod.name, mesh);
  ns.group.add(mesh);
  addContainerRings(ns.group, mesh, pod.containerCount || 1, statusColor(pod.status));
  invalidateMeshCache();
}

function removePod(nsName, podName) {
  const ns = state.namespaces.get(nsName);
  if (!ns) return;
  const mesh = ns.pods.get(podName);
  if (mesh) {
    // Remove container rings
    const rings = ns.group.children.filter(c => c.userData._ringFor === mesh.uuid);
    for (const r of rings) {
      ns.group.remove(r);
      r.geometry.dispose();
      r.material.dispose();
    }
    ns.group.remove(mesh);
    // geometry is shared, material is pooled -- don't dispose either
    ns.pods.delete(podName);
    invalidateMeshCache();
  }
}

// ── Pod animation ──────────────────────────────────────────────
function animatePods(time) {
  for (const [, ns] of state.namespaces) {
    let i = 0;
    for (const [, mesh] of ns.pods) {
      const pod = mesh.userData.pod;
      const h = mesh.geometry.parameters.height || POD_BASE_SIZE;
      if (pod && pod.status === 'Running') {
        mesh.position.y = POD_Y_OFFSET + h / 2 + Math.sin(time * 2 + i * 0.5) * 0.05;
      } else if (pod && (pod.status === 'CrashLoopBackOff' || pod.status === 'Error')) {
        mesh.position.y = POD_Y_OFFSET + h / 2 + Math.sin(time * 12 + i) * 0.4;
      }
      i++;
    }
  }
}

export {
  podGeometry,
  addContainerRings,
  addOrUpdatePod,
  removePod,
  animatePods,
};

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

// Pod geometry key based on owner kind
function podGeoKey(ownerKind) {
  switch (ownerKind) {
    case 'StatefulSet':  return 'cylinder';
    case 'DaemonSet':    return 'octahedron';
    case 'Job':
    case 'CronJob':      return 'cone';
    default:             return 'box';
  }
}

// Pod geometry based on owner kind -- returns shared geometry
function podGeometry(ownerKind) {
  return _sharedGeo[podGeoKey(ownerKind)];
}

// ── InstancedMesh management ────────────────────────────────────
// Each namespace maintains up to 4 InstancedMesh objects (one per geo type)
// stored in ns.instancedMeshes = { box: InstancedMesh, ... }
// Each pod mesh (invisible) has a corresponding instance in the InstancedMesh.

const MAX_INSTANCES_PER_NS = 200; // preallocated per geo type per namespace
const _tmpMatrix = new THREE.Matrix4();
const _tmpColor = new THREE.Color();

// Create or retrieve the InstancedMesh for a namespace + geometry type
function ensureInstancedMesh(ns, geoKey) {
  if (!ns.instancedMeshes) ns.instancedMeshes = {};
  if (ns.instancedMeshes[geoKey]) return ns.instancedMeshes[geoKey];

  const geo = _sharedGeo[geoKey];
  // MeshPhong material: per-instance color drives diffuse; emissive uses same
  // instance color at 30% via onBeforeCompile to match original podMaterial look.
  const mat = new THREE.MeshPhongMaterial({
    shininess: 60,
    transparent: true,
    opacity: 0.9,
    emissive: 0xffffff,
    emissiveIntensity: 0.3,
  });
  // Patch shader so emissive uses the instance color (vColor) instead of uniform
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `
      #include <emissivemap_fragment>
      #ifdef USE_INSTANCING_COLOR
        totalEmissiveRadiance *= vColor;
      #endif
      `,
    );
  };
  const im = new THREE.InstancedMesh(geo, mat, MAX_INSTANCES_PER_NS);
  im.count = 0;
  im.userData = { type: 'instancedPods', geoKey };
  im.frustumCulled = false;
  ns.group.add(im);
  ns.instancedMeshes[geoKey] = im;
  return im;
}

// Registry: maps "nsName/podName" -> { geoKey, instanceId }
const _instanceRegistry = new Map();

// Track which namespace InstancedMeshes need color buffer upload
const _colorDirtySet = new Set(); // Set of InstancedMesh

function allocateInstance(ns, nsName, podName, geoKey) {
  const im = ensureInstancedMesh(ns, geoKey);
  const instanceId = im.count;
  im.count++;
  const regKey = nsName + '/' + podName;
  _instanceRegistry.set(regKey, { geoKey, instanceId });

  // Store reverse mapping on the InstancedMesh for swap-remove
  if (!im._podNames) im._podNames = [];
  im._podNames[instanceId] = regKey;

  return { im, instanceId };
}

function deallocateInstance(ns, nsName, podName) {
  const regKey = nsName + '/' + podName;
  const entry = _instanceRegistry.get(regKey);
  if (!entry) return;

  const im = ns.instancedMeshes[entry.geoKey];
  if (!im) { _instanceRegistry.delete(regKey); return; }

  const lastIdx = im.count - 1;
  const removeIdx = entry.instanceId;

  if (removeIdx !== lastIdx) {
    // Swap with last instance
    const lastMatrix = new THREE.Matrix4();
    im.getMatrixAt(lastIdx, lastMatrix);
    im.setMatrixAt(removeIdx, lastMatrix);

    const lastColor = new THREE.Color();
    im.getColorAt(lastIdx, lastColor);
    im.setColorAt(removeIdx, lastColor);

    // Update registry for the swapped instance
    const swappedRegKey = im._podNames[lastIdx];
    if (swappedRegKey && _instanceRegistry.has(swappedRegKey)) {
      _instanceRegistry.get(swappedRegKey).instanceId = removeIdx;
    }
    im._podNames[removeIdx] = swappedRegKey;
  }

  im.count--;
  im._podNames.length = im.count;
  _instanceRegistry.delete(regKey);

  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
}

// Sync a single instance's transform from its invisible mesh
function syncInstanceTransform(ns, nsName, podName, mesh) {
  const regKey = nsName + '/' + podName;
  const entry = _instanceRegistry.get(regKey);
  if (!entry) return;
  const im = ns.instancedMeshes[entry.geoKey];
  if (!im) return;

  _tmpMatrix.compose(mesh.position, mesh.quaternion, mesh.scale);
  im.setMatrixAt(entry.instanceId, _tmpMatrix);
  im.instanceMatrix.needsUpdate = true;
}

// Sync a single instance's color
function syncInstanceColor(ns, nsName, podName, status) {
  const regKey = nsName + '/' + podName;
  const entry = _instanceRegistry.get(regKey);
  if (!entry) return;
  const im = ns.instancedMeshes[entry.geoKey];
  if (!im) return;

  _tmpColor.set(statusColor(status));
  im.setColorAt(entry.instanceId, _tmpColor);
  _colorDirtySet.add(im);
}

// Flush pending color buffer uploads (called once per frame or after batch updates)
function flushInstanceColors() {
  for (const im of _colorDirtySet) {
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }
  _colorDirtySet.clear();
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

  // Temporarily make mesh visible for bounding box computation
  const wasVisible = mesh.visible;
  mesh.visible = true;
  const bbox = new THREE.Box3().setFromObject(mesh);
  mesh.visible = wasVisible;
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
  const geoKey = podGeoKey(pod.ownerKind);

  if (ns.pods.has(pod.name)) {
    const existing = ns.pods.get(pod.name);
    const oldGeoKey = podGeoKey(existing.userData.pod?.ownerKind);

    // If geometry type changed, deallocate old instance and allocate new
    if (oldGeoKey !== geoKey) {
      deallocateInstance(ns, nsName, pod.name);
      // Update mesh geometry reference (for raycast bounding)
      existing.geometry = podGeometry(pod.ownerKind);
      const { im, instanceId } = allocateInstance(ns, nsName, pod.name, geoKey);
      syncInstanceColor(ns, nsName, pod.name, pod.status);
    } else {
      syncInstanceColor(ns, nsName, pod.name, pod.status);
    }

    // material is pooled — keep for raycasting highlight support
    existing.material = podMaterial(pod.status);
    existing.geometry = podGeometry(pod.ownerKind);
    existing.scale.set(sx, sy, sz);
    existing.visible = false; // rendering done by InstancedMesh
    existing.userData = { type: 'pod', pod };
    syncInstanceTransform(ns, nsName, pod.name, existing);
    flushInstanceColors();
    addContainerRings(ns.group, existing, pod.containerCount || 1, statusColor(pod.status));
    return;
  }

  const geo = podGeometry(pod.ownerKind);
  const mat = podMaterial(pod.status);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(sx, sy, sz);
  mesh.userData = { type: 'pod', pod };
  mesh.visible = false; // invisible: rendering done by InstancedMesh
  ns.pods.set(pod.name, mesh);
  ns.group.add(mesh);

  // Allocate instance in the appropriate InstancedMesh
  allocateInstance(ns, nsName, pod.name, geoKey);
  syncInstanceTransform(ns, nsName, pod.name, mesh);
  syncInstanceColor(ns, nsName, pod.name, pod.status);
  flushInstanceColors();

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

    // Deallocate from InstancedMesh
    deallocateInstance(ns, nsName, podName);

    ns.group.remove(mesh);
    // geometry is shared, material is pooled -- don't dispose either
    ns.pods.delete(podName);
    invalidateMeshCache();
  }
}

// ── Pod animation ──────────────────────────────────────────────
function animatePods(time) {
  for (const [nsName, ns] of state.namespaces) {
    let i = 0;
    for (const [podName, mesh] of ns.pods) {
      const pod = mesh.userData.pod;
      const h = mesh.geometry.parameters.height || POD_BASE_SIZE;
      if (pod && pod.status === 'Running') {
        mesh.position.y = POD_Y_OFFSET + h / 2 + Math.sin(time * 2 + i * 0.5) * 0.05;
        syncInstanceTransform(ns, nsName, podName, mesh);
      } else if (pod && (pod.status === 'CrashLoopBackOff' || pod.status === 'Error')) {
        mesh.position.y = POD_Y_OFFSET + h / 2 + Math.sin(time * 12 + i) * 0.4;
        syncInstanceTransform(ns, nsName, podName, mesh);
      }
      i++;
    }
  }
}

// Sync all instance transforms after layout changes (called by layoutNamespaces)
function syncAllInstances() {
  for (const [nsName, ns] of state.namespaces) {
    for (const [podName, mesh] of ns.pods) {
      syncInstanceTransform(ns, nsName, podName, mesh);
    }
  }
}

// Set material opacity on all namespace InstancedMeshes (for depth transparency)
function setNamespaceInstancedOpacity(ns, opacity) {
  if (!ns.instancedMeshes) return;
  for (const geoKey in ns.instancedMeshes) {
    const im = ns.instancedMeshes[geoKey];
    if (im && im.material) {
      im.material.opacity = opacity;
    }
  }
}

// Hover highlight: brighten an instance color for the hovered pod
const _hoverSavedColor = new THREE.Color();
let _hoverInstanceRef = null; // { im, instanceId }

function applyInstanceHover(nsName, podName) {
  const regKey = nsName + '/' + podName;
  const entry = _instanceRegistry.get(regKey);
  if (!entry) return;
  const ns = state.namespaces.get(nsName);
  if (!ns || !ns.instancedMeshes) return;
  const im = ns.instancedMeshes[entry.geoKey];
  if (!im) return;

  im.getColorAt(entry.instanceId, _hoverSavedColor);
  _hoverInstanceRef = { im, instanceId: entry.instanceId, color: _hoverSavedColor.clone() };

  // Brighten the instance color
  const bright = _hoverSavedColor.clone().multiplyScalar(2.5);
  bright.r = Math.min(bright.r, 1);
  bright.g = Math.min(bright.g, 1);
  bright.b = Math.min(bright.b, 1);
  im.setColorAt(entry.instanceId, bright);
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
}

function removeInstanceHover() {
  if (!_hoverInstanceRef) return;
  const { im, instanceId, color } = _hoverInstanceRef;
  im.setColorAt(instanceId, color);
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  _hoverInstanceRef = null;
}

// Clean up InstancedMeshes when a namespace is removed
function cleanupNamespaceInstances(ns, nsName) {
  // Remove all registry entries for this namespace
  for (const [podName] of ns.pods) {
    const regKey = nsName + '/' + podName;
    _instanceRegistry.delete(regKey);
  }
  // Remove InstancedMesh objects from the group
  if (ns.instancedMeshes) {
    for (const geoKey in ns.instancedMeshes) {
      const im = ns.instancedMeshes[geoKey];
      if (im) {
        ns.group.remove(im);
        im.dispose();
      }
    }
    ns.instancedMeshes = null;
  }
}

export {
  podGeometry,
  podGeoKey,
  addContainerRings,
  addOrUpdatePod,
  removePod,
  animatePods,
  syncAllInstances,
  setNamespaceInstancedOpacity,
  cleanupNamespaceInstances,
  applyInstanceHover,
  removeInstanceHover,
};

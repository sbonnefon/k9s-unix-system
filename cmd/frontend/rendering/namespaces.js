import * as THREE from 'three';
import {
  state,
  PLATFORM_GAP,
  PLATFORM_Y,
  PLATFORM_HEIGHT,
  POD_STRIDE,
  POD_Y_OFFSET,
  NODE_BLOCK_SIZE,
  WORKLOAD_Y,
  WORKLOAD_BOX_HEIGHT,
} from '../core/state.js';
import { scene, camera } from '../core/scene.js';
import { platformMaterial, forbiddenPlatformMaterial } from '../core/materials.js';
import { makeLabel, makeBeveledPlatformGeo } from './labels.js';
import { rebuildNodeIsland, layoutNodeIsland } from './nodes.js';
import { invalidateMeshCache } from '../interaction/raycast.js';

// These will be set by app.js to break circular dependency with camera.js
let _euler = null;
let _spot = null;
let _showPodLabels = null;

function setLayoutDeps({ euler, spot, showPodLabels }) {
  _euler = euler;
  _spot = spot;
  _showPodLabels = showPodLabels;
}

// ── Namespace/Pod Management ───────────────────────────────────
function ensureNamespace(name, forbidden = false) {
  if (state.namespaces.has(name)) {
    const ns = state.namespaces.get(name);
    ns.forbidden = ns.forbidden || forbidden;
    return ns;
  }
  const group = new THREE.Group();
  group.userData = { type: 'namespace', name };
  scene.add(group);
  const ns = { group, platform: null, pods: new Map(), label: null, forbidden, wireframe: null, platWidth: 0, platDepth: 0 };
  state.namespaces.set(name, ns);
  return ns;
}

function removeNamespace(name) {
  const ns = state.namespaces.get(name);
  if (!ns) return;
  for (const [, mesh] of ns.pods) {
    // geometry is shared -- don't dispose it
    mesh.material.dispose();
  }
  if (ns.platform) ns.platform.material.dispose();
  if (ns.wireframe) ns.wireframe.material.dispose();
  scene.remove(ns.group);
  state.namespaces.delete(name);
}

// ── Namespace Layout ───────────────────────────────────────────
function layoutNamespaces() {
  // Build the node island first so we can include it in the grid
  if (state.nodes.size > 0) {
    rebuildNodeIsland();
    layoutNodeIsland();
  }

  // Collect all islands: node island (if any) + namespace groups
  const entries = []; // { group, platWidth, platDepth }
  if (state.nodeIsland && state.nodeIsland.blocks.size > 0) {
    const blockStride = NODE_BLOCK_SIZE + 1.2;
    const blockCols = Math.max(2, Math.ceil(Math.sqrt(state.nodeIsland.blocks.size)));
    const blockRows = Math.max(1, Math.ceil(state.nodeIsland.blocks.size / blockCols));
    entries.push({
      group: state.nodeIsland.group,
      platWidth: blockCols * blockStride + 2,
      platDepth: blockRows * blockStride + 2,
    });
  }

  const nsList = [...state.namespaces.keys()].sort();
  for (const nsName of nsList) {
    const ns = state.namespaces.get(nsName);
    const podCount = ns.pods.size;

    // Build CronJob -> Job name map for this namespace (CronJob owns Job owns Pod)
    const nsCronJobToJobs = new Map();
    for (const wl of state.workloads) {
      if (wl.kind === 'Job' && wl.namespace === nsName) {
        for (const cj of state.workloads) {
          if (cj.kind === 'CronJob' && cj.namespace === nsName && wl.name.startsWith(cj.name + '-')) {
            if (!nsCronJobToJobs.has(cj.name)) nsCronJobToJobs.set(cj.name, []);
            nsCronJobToJobs.get(cj.name).push(wl.name);
          }
        }
      }
    }

    // Determine which workloads have matching pods (used for orphan detection + sizing)
    const wlHasPods = new Set();
    for (const wl of state.workloads) {
      if (wl.namespace !== nsName) continue;
      for (const [, podMesh] of ns.pods) {
        const pod = podMesh.userData.pod;
        if (!pod) continue;
        if (pod.ownerKind === wl.kind && pod.ownerName === wl.name) {
          wlHasPods.add(wl.kind + '/' + wl.name);
          break;
        }
        if (wl.kind === 'CronJob') {
          const jobNames = nsCronJobToJobs.get(wl.name) || [];
          if (pod.ownerKind === 'Job' && jobNames.includes(pod.ownerName)) {
            wlHasPods.add(wl.kind + '/' + wl.name);
            break;
          }
        }
      }
    }

    const orphanWls = state.workloads.filter(wl =>
      wl.namespace === nsName && !wlHasPods.has(wl.kind + '/' + wl.name)
    );

    // Slightly more cols than rows -> horizontal rectangle (~1.3:1 ratio)
    const podCols = podCount > 0
      ? Math.max(2, Math.ceil(Math.sqrt(podCount * 1.3)))
      : Math.max(2, Math.ceil(Math.sqrt(orphanWls.length * 1.3)));

    // Estimate rows: simulate the flow layout (fill row, then next)
    let estRows = 0;
    if (podCount > 0) {
      let c = 0;
      const wlGroupsForSize = new Map();
      let ungroupedCount = 0;
      for (const [, podMesh] of ns.pods) {
        const pod = podMesh.userData.pod;
        if (pod && pod.ownerKind && pod.ownerName) {
          const key = pod.ownerKind + '/' + pod.ownerName;
          wlGroupsForSize.set(key, (wlGroupsForSize.get(key) || 0) + 1);
        } else {
          ungroupedCount++;
        }
      }
      for (const [, count] of wlGroupsForSize) {
        if (c > 0 && c + count > podCols && count <= podCols) {
          estRows++;
          c = 0;
        }
        for (let i = 0; i < count; i++) {
          if (c >= podCols) { c = 0; estRows++; }
          c++;
        }
      }
      for (let i = 0; i < ungroupedCount; i++) {
        if (c >= podCols) { c = 0; estRows++; }
        c++;
      }
      if (c > 0) estRows++;
      estRows = Math.max(1, estRows);
    }

    // Pod zone: only as large as needed (0 if no pods)
    const podZoneDepth = podCount > 0 ? estRows * POD_STRIDE + 2 : 0;
    let platWidth = podCols * POD_STRIDE + 2;

    // Orphan zone
    let orphanZoneDepth = 0;
    if (orphanWls.length > 0) {
      const orphanSpacing = 2.5;
      const orphanCols = Math.max(2, Math.min(orphanWls.length, Math.floor(platWidth / orphanSpacing)));
      const orphanRows = Math.ceil(orphanWls.length / orphanCols);
      const orphanWidth = orphanCols * orphanSpacing + 1;
      orphanZoneDepth = orphanRows * orphanSpacing + 1;
      platWidth = Math.max(platWidth, orphanWidth + 2);
    }

    // Total platform = pod zone + orphan zone (minimum size for label visibility)
    let platDepth = Math.max(podZoneDepth + orphanZoneDepth, 3);

    ns.platWidth = platWidth;
    ns.platDepth = platDepth;
    ns.orphanZoneDepth = orphanZoneDepth;
    ns.podZoneDepth = podZoneDepth;
    entries.push({ group: ns.group, platWidth, platDepth, nsName });
  }

  const cols = Math.max(1, Math.ceil(Math.sqrt(entries.length)));
  const rows = Math.ceil(entries.length / cols);

  // Compute max width per column and max depth per row to prevent overlaps
  const colWidths = new Array(cols).fill(0);
  const rowDepths = new Array(rows).fill(0);
  entries.forEach((entry, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    colWidths[col] = Math.max(colWidths[col], entry.platWidth);
    rowDepths[row] = Math.max(rowDepths[row], entry.platDepth);
  });

  // Build cumulative offsets (center of each column/row)
  const colX = [];
  let cx = 0;
  for (let c = 0; c < cols; c++) {
    colX.push(cx + colWidths[c] / 2);
    cx += colWidths[c] + PLATFORM_GAP;
  }
  const totalWidth = cx - PLATFORM_GAP;

  const rowZ = [];
  let rz = 0;
  for (let r = 0; r < rows; r++) {
    rowZ.push(rz + rowDepths[r] / 2);
    rz += rowDepths[r] + PLATFORM_GAP;
  }
  const totalDepth = rz - PLATFORM_GAP;

  entries.forEach((entry, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = colX[col] - totalWidth / 2;
    const z = rowZ[row] - totalDepth / 2;
    entry.group.position.set(x, PLATFORM_Y, z);

    // Skip node island -- already built by rebuildNodeIsland/layoutNodeIsland
    if (!entry.nsName) return;

    const ns = state.namespaces.get(entry.nsName);

    // Rebuild platform geometry
    if (ns.platform) {
      ns.platform.material.dispose();
      ns.group.remove(ns.platform);
    }
    if (ns.wireframe) {
      ns.wireframe.material.dispose();
      ns.group.remove(ns.wireframe);
      ns.wireframe = null;
    }
    const platGeo = makeBeveledPlatformGeo(entry.platWidth, PLATFORM_HEIGHT, entry.platDepth);
    const mat = ns.forbidden ? forbiddenPlatformMaterial.clone() : platformMaterial.clone();
    ns.platform = new THREE.Mesh(platGeo, mat);
    ns.platform.position.y = -PLATFORM_HEIGHT / 2;
    ns.platform.userData = { type: 'namespace', name: entry.nsName };
    ns.group.add(ns.platform);

    // Add wireframe edges for forbidden namespaces
    if (ns.forbidden) {
      const edgesGeo = new THREE.EdgesGeometry(platGeo);
      const edgesMat = new THREE.LineBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.5 });
      ns.wireframe = new THREE.LineSegments(edgesGeo, edgesMat);
      ns.wireframe.position.y = -PLATFORM_HEIGHT / 2;
      ns.group.add(ns.wireframe);
    }

    // Reposition label
    if (ns.label) ns.group.remove(ns.label);
    ns.label = ns.forbidden
      ? makeLabel(entry.nsName.toUpperCase(), 64, '#666666')
      : makeLabel(entry.nsName.toUpperCase(), 64, '#cc6699');
    ns.label.position.set(0, 0.15, entry.platDepth / 2 + 2);
    ns.group.add(ns.label);

    // Lay out pods grouped by workload owner, filling rows left-to-right
    // 1. Build workload groups: ownerKey -> [podMesh, ...]
    const wlGroups = new Map(); // "Kind/Name" -> [podMesh]
    const ungrouped = [];       // pods with no owner
    for (const [, podMesh] of ns.pods) {
      const pod = podMesh.userData.pod;
      if (pod && pod.ownerKind && pod.ownerName) {
        const key = pod.ownerKind + '/' + pod.ownerName;
        if (!wlGroups.has(key)) wlGroups.set(key, []);
        wlGroups.get(key).push(podMesh);
      } else {
        ungrouped.push(podMesh);
      }
    }

    // 2. Sort groups: active workloads first, then by kind priority
    const kindOrder = { Deployment: 0, StatefulSet: 1, DaemonSet: 2, ReplicaSet: 3, Job: 4, CronJob: 5 };
    const isGroupActive = (pods) => pods.some(m => {
      const p = m.userData.pod;
      return p && (p.status === 'Running' || p.ready);
    });
    const sortedGroups = [...wlGroups.entries()].sort((a, b) => {
      const activeA = isGroupActive(a[1]) ? 0 : 1;
      const activeB = isGroupActive(b[1]) ? 0 : 1;
      if (activeA !== activeB) return activeA - activeB;
      const kindA = a[0].split('/')[0];
      const kindB = b[0].split('/')[0];
      return (kindOrder[kindA] ?? 9) - (kindOrder[kindB] ?? 9);
    });

    // 3. Flow layout: fill rows left-to-right, keep groups contiguous
    const gridCols = Math.max(2, Math.ceil(Math.sqrt(ns.pods.size * 1.3)));
    let curCol = 0, curRow = 0;
    const allPlaced = [];

    const placeGroup = (pods) => {
      if (curCol > 0 && curCol + pods.length > gridCols && pods.length <= gridCols) {
        curCol = 0;
        curRow++;
      }
      for (const podMesh of pods) {
        if (curCol >= gridCols) {
          curCol = 0;
          curRow++;
        }
        allPlaced.push({ mesh: podMesh, col: curCol, row: curRow });
        curCol++;
      }
    };

    for (const [, pods] of sortedGroups) {
      placeGroup(pods);
    }
    if (ungrouped.length > 0) {
      placeGroup(ungrouped);
    }

    // 4. Position pods with correct centering
    const totalRows = (curCol > 0 ? curRow + 1 : curRow) || 1;
    const podZoneOffsetZ = -(ns.orphanZoneDepth || 0) / 2;
    for (const { mesh, col, row } of allPlaced) {
      const h = mesh.geometry.parameters.height || 0.7;
      mesh.position.set(
        col * POD_STRIDE - (gridCols * POD_STRIDE) / 2 + POD_STRIDE / 2,
        POD_Y_OFFSET + h / 2,
        row * POD_STRIDE - (totalRows * POD_STRIDE) / 2 + POD_STRIDE / 2 + podZoneOffsetZ
      );
    }
  });

  // On first layout, pull camera back to show all islands
  if (!layoutNamespaces._initialDone && entries.length > 0) {
    layoutNamespaces._initialDone = true;
    const extent = Math.max(totalWidth, totalDepth, 20);
    const fovRad = THREE.MathUtils.degToRad(camera.fov / 2);
    const aspect = camera.aspect;
    const distForWidth = totalWidth / (2 * Math.tan(fovRad) * aspect);
    const distForDepth = totalDepth / (2 * Math.tan(fovRad));
    const dist = Math.max(distForWidth, distForDepth, 25) * 1.3;
    camera.position.set(0, dist * 0.45, dist);
    camera.lookAt(0, 0, 0);
    if (_euler) _euler.setFromQuaternion(camera.quaternion);
  }

  // Refresh pod labels if spotlight is active
  if (_spot && _spot.active && _spot.nsName && _showPodLabels) {
    _showPodLabels(_spot.nsName);
    for (const { mesh } of _spot.podLabels) {
      mesh.material.opacity = 0.85;
    }
  }
  invalidateMeshCache();
}

function computeLayoutExtent() {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [, ns] of state.namespaces) {
    const pos = ns.group.position;
    minX = Math.min(minX, pos.x);
    maxX = Math.max(maxX, pos.x);
    minZ = Math.min(minZ, pos.z);
    maxZ = Math.max(maxZ, pos.z);
  }
  if (state.nodeIsland) {
    const pos = state.nodeIsland.group.position;
    minX = Math.min(minX, pos.x);
    maxX = Math.max(maxX, pos.x);
    minZ = Math.min(minZ, pos.z);
    maxZ = Math.max(maxZ, pos.z);
  }
  if (!isFinite(minX)) return { cx: 0, cz: 0, extent: 60 };
  const cx2 = (minX + maxX) / 2;
  const cz2 = (minZ + maxZ) / 2;
  const w = maxX - minX + 20; // padding
  const h = maxZ - minZ + 20;
  const aspect = window.innerWidth / window.innerHeight;
  const extent = Math.max(h, w / aspect) * 1.2;
  return { cx: cx2, cz: cz2, extent: Math.max(extent, 60) };
}

export {
  ensureNamespace,
  removeNamespace,
  layoutNamespaces,
  computeLayoutExtent,
  setLayoutDeps,
};

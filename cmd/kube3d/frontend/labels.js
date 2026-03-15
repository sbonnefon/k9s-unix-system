import * as THREE from 'three';
import { podWorkload, workloadKey, POD_STRIDE, POD_BASE_SIZE } from './state.js';

export function makeLabel(text, fontSize = 64, worldHeight = 2.5, opacity = 0.9, fontFamily = "'Share Tech Mono', monospace", fontWeight = '400') {
  const cvs = document.createElement('canvas');
  const ctx = cvs.getContext('2d');
  const fontStr = `${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx.font = fontStr;
  const metrics = ctx.measureText(text);
  cvs.width = Math.ceil(metrics.width) + 20;
  cvs.height = fontSize + 20;
  ctx.font = fontStr;
  ctx.fillStyle = '#00ff88';
  ctx.shadowColor = '#00ff88';
  ctx.shadowBlur = 8;
  ctx.fillText(text, 10, fontSize);
  const texture = new THREE.CanvasTexture(cvs);
  texture.minFilter = THREE.LinearFilter;
  const aspect = cvs.width / cvs.height;
  const planeW = aspect * worldHeight;
  const planeH = worldHeight;
  const geo = new THREE.PlaneGeometry(planeW, planeH);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 999;
  mesh.rotation.x = -Math.PI / 2;
  mesh.userData = { type: 'label' };
  return mesh;
}

export function makeBeveledPlatformGeo(width, height, depth) {
  const bevel = 0.07;
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, -depth / 2);
  shape.lineTo( width / 2, -depth / 2);
  shape.lineTo( width / 2,  depth / 2);
  shape.lineTo(-width / 2,  depth / 2);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
  });

  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -height / 2, 0);
  return geo;
}

export function buildWorkloadGroups(nsName, ns) {
  const groups = new Map();
  for (const [, podMesh] of ns.pods) {
    const pod = podMesh.userData.pod;
    const owner = podWorkload(pod);
    const key = workloadKey(nsName, owner.kind, owner.name);
    let group = groups.get(key);
    if (!group) {
      group = { key, kind: owner.kind, name: owner.name, pods: [] };
      groups.set(key, group);
    }
    group.pods.push(podMesh);
  }

  const result = [...groups.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
    return left.name.localeCompare(right.name);
  });

  for (const group of result) {
    group.cols = Math.max(1, Math.ceil(Math.sqrt(group.pods.length)));
    group.rows = Math.max(1, Math.ceil(group.pods.length / group.cols));
    group.width = group.cols * POD_STRIDE + 1;
    group.depth = group.rows * POD_STRIDE + 1;
  }

  return result;
}

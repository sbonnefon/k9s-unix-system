import * as THREE from 'three';
import { scene, activeCamera } from '../core/scene.js';

// ── Text Labels (canvas texture -> flat on ground) ─────────────
function makeLabel(text, fontSize = 64, color = '#00ff88', { billboard = false } = {}) {
  const padding = 14;
  const cvs = document.createElement('canvas');
  const ctx = cvs.getContext('2d');
  const fontStr = `${fontSize}px 'Share Tech Mono', monospace`;
  ctx.font = fontStr;
  const metrics = ctx.measureText(text);
  cvs.width = Math.ceil(metrics.width) + padding * 2;
  cvs.height = fontSize + padding * 2;
  // Dark background for contrast
  ctx.fillStyle = 'rgba(0, 8, 4, 0.75)';
  ctx.fillRect(0, 0, cvs.width, cvs.height);
  // Border
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, cvs.width - 2, cvs.height - 2);
  ctx.globalAlpha = 1;
  // Text
  ctx.font = fontStr;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.fillText(text, padding, fontSize + padding / 2);
  const texture = new THREE.CanvasTexture(cvs);
  texture.minFilter = THREE.LinearFilter;
  const aspect = cvs.width / cvs.height;
  const scaleFactor = fontSize / 64;
  const planeH = 2.5 * scaleFactor;
  const planeW = aspect * planeH;
  const geo = new THREE.PlaneGeometry(planeW, planeH);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  if (billboard) {
    // Billboard labels are updated each frame to face the camera
    mesh.userData = { type: 'label', billboard: true };
  } else {
    mesh.rotation.x = -Math.PI / 2; // lay flat on ground
    mesh.userData = { type: 'label' };
  }
  return mesh;
}

function makeBeveledPlatformGeo(width, height, depth) {
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

// ── Billboard labels (face camera) ────────────────────────────
let _billboardMeshes = [];
let _billboardCacheDirty = true;

function markBillboardsDirty() { _billboardCacheDirty = true; }

function updateBillboards() {
  const cam = activeCamera();
  if (_billboardCacheDirty) {
    _billboardMeshes = [];
    scene.traverse((obj) => {
      if (obj.isMesh && obj.userData.billboard) _billboardMeshes.push(obj);
    });
    _billboardCacheDirty = false;
  }
  for (const mesh of _billboardMeshes) {
    mesh.quaternion.copy(cam.quaternion);
  }
}

export {
  makeLabel,
  makeBeveledPlatformGeo,
  markBillboardsDirty,
  updateBillboards,
};

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// ── Renderer & Scene ───────────────────────────────────────────
export const canvas = document.getElementById('canvas');
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x020202);
renderer.localClippingEnabled = true;

export const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x020202, 0.012);

// ── Cameras ────────────────────────────────────────────────────
export const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(0, 12, 25);
camera.lookAt(0, 0, 0);

export const ORTHO_DEFAULT_ZOOM = 60;
export const orthoCamera = (() => {
  const aspect = window.innerWidth / window.innerHeight;
  const half = ORTHO_DEFAULT_ZOOM / 2;
  return new THREE.OrthographicCamera(
    -half * aspect, half * aspect, half, -half, 0.1, 500,
  );
})();
orthoCamera.position.set(0, 100, 0);
orthoCamera.lookAt(0, 0, 0);

export const eagleEye = {
  active: false,
  zoom: ORTHO_DEFAULT_ZOOM,
  panX: 0,
  panZ: 0,
};

export function activeCamera() {
  return eagleEye.active ? orthoCamera : camera;
}

export function updateOrthoFrustum() {
  const aspect = window.innerWidth / window.innerHeight;
  const half = eagleEye.zoom / 2;
  orthoCamera.left   = -half * aspect;
  orthoCamera.right  =  half * aspect;
  orthoCamera.top    =  half;
  orthoCamera.bottom = -half;
  orthoCamera.updateProjectionMatrix();
}

// ── Post-processing ────────────────────────────────────────────
export const renderPass = new RenderPass(scene, camera);
export const composer = new EffectComposer(renderer);
composer.addPass(renderPass);
export const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2),
  0.6, 0.4, 0.85,
);
composer.addPass(bloom);

// ── Sky ────────────────────────────────────────────────────────
const skyGeo = new THREE.SphereGeometry(400, 32, 32);
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
  uniforms: {},
  vertexShader: `
    varying vec3 vWorldPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: `
    varying vec3 vWorldPos;
    void main() {
      float h = normalize(vWorldPos).y;
      vec3 top    = vec3(0.01, 0.01, 0.01);
      vec3 green  = vec3(0.04, 0.25, 0.10);
      vec3 bottom = vec3(0.01, 0.01, 0.01);

      vec3 col;
      if (h > 0.0) {
        float t = smoothstep(0.0, 0.12, h);
        col = mix(green, top, t);
      } else {
        col = bottom;
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
scene.add(new THREE.Mesh(skyGeo, skyMat));

// ── Lights ─────────────────────────────────────────────────────
export const ambient = new THREE.AmbientLight(0x334455, 0.8);
scene.add(ambient);
export const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
dirLight.position.set(10, 20, 10);
scene.add(dirLight);
export const pointLight = new THREE.PointLight(0x00ff88, 0.4, 100);
pointLight.position.set(0, 15, 0);
scene.add(pointLight);

// ── Spotlight Geometry ─────────────────────────────────────────
export const spotlight = new THREE.SpotLight(0xffffff, 0, 60, Math.PI / 6, 0.5, 1.2);
spotlight.position.set(0, 30, 0);
spotlight.target.position.set(0, 0, 0);
scene.add(spotlight);
scene.add(spotlight.target);

export const BEAM_TOP_RADIUS = 0.1;
export const BEAM_BOT_RADIUS = 3.5;
export const BEAM_SEGMENTS = 32;
export const BEAM_SOURCE_OFFSET = new THREE.Vector3(10, 26, -6);

export const beamClipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
export const beamMat = new THREE.MeshBasicMaterial({
  color: 0xddeeff,
  transparent: true,
  opacity: 0,
  side: THREE.DoubleSide,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  clippingPlanes: [beamClipPlane],
});

export const beamCone = new THREE.Mesh(
  new THREE.CylinderGeometry(BEAM_TOP_RADIUS, BEAM_BOT_RADIUS, 1, BEAM_SEGMENTS, 1, true),
  beamMat,
);
beamCone.visible = false;
scene.add(beamCone);

const glowGeo = new THREE.CircleGeometry(3.5, 48);
export const glowMat = new THREE.MeshBasicMaterial({
  color: 0xffeedd,
  transparent: true,
  opacity: 0,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
export const glowDisc = new THREE.Mesh(glowGeo, glowMat);
glowDisc.rotation.x = -Math.PI / 2;
glowDisc.visible = false;
scene.add(glowDisc);

// ── Ground Plane ───────────────────────────────────────────────
const groundGeo = new THREE.PlaneGeometry(200, 200);
const groundMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 });
const groundPlane = new THREE.Mesh(groundGeo, groundMat);
groundPlane.rotation.x = -Math.PI / 2;
groundPlane.position.y = -0.5;
scene.add(groundPlane);

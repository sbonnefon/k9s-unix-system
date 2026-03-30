import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// ── Scene Setup ────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x020202);
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x020202, 0.003);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(0, 12, 25);
camera.lookAt(0, 0, 0);

// Eagle Eye: overhead orthographic camera
const ORTHO_DEFAULT_ZOOM = 60;
const orthoCamera = (() => {
  const aspect = window.innerWidth / window.innerHeight;
  const half = ORTHO_DEFAULT_ZOOM / 2;
  return new THREE.OrthographicCamera(
    -half * aspect, half * aspect, half, -half, 0.1, 5000,
  );
})();
orthoCamera.position.set(0, 100, 0);
orthoCamera.lookAt(0, 0, 0);

const eagleEye = {
  active: false,
  zoom: ORTHO_DEFAULT_ZOOM,
  panX: 0,
  panZ: 0,
};

function activeCamera() {
  return eagleEye.active ? orthoCamera : camera;
}

function updateOrthoFrustum() {
  const aspect = window.innerWidth / window.innerHeight;
  const half = eagleEye.zoom / 2;
  orthoCamera.left   = -half * aspect;
  orthoCamera.right  =  half * aspect;
  orthoCamera.top    =  half;
  orthoCamera.bottom = -half;
  orthoCamera.updateProjectionMatrix();
}

// Post-processing
const renderPass = new RenderPass(scene, camera);
const composer = new EffectComposer(renderer);
composer.addPass(renderPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 0.6, 0.4, 0.85);
composer.addPass(bloom);

// Horizon gradient sky (Jurassic Park FSN style)
const skyGeo = new THREE.SphereGeometry(4000, 32, 32);
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
      vec3 bg    = vec3(0.008, 0.008, 0.008);
      vec3 green = vec3(0.03, 0.18, 0.08);

      vec3 col;
      if (h > 0.0) {
        float t = smoothstep(0.0, 0.04, h);
        col = mix(green, bg, t);
      } else {
        col = bg;
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
const sky = new THREE.Mesh(skyGeo, skyMat);
scene.add(sky);

// Lights
const ambient = new THREE.AmbientLight(0x334455, 0.8);
scene.add(ambient);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
dirLight.position.set(10, 20, 10);
scene.add(dirLight);
const pointLight = new THREE.PointLight(0x00ff88, 0.4, 100);
pointLight.position.set(0, 15, 0);
scene.add(pointLight);

// Spotlight (Jurassic Park style -- starts hidden)
const spotlight = new THREE.SpotLight(0xffffff, 0, 60, Math.PI / 6, 0.5, 1.2);
spotlight.position.set(0, 30, 0);
spotlight.target.position.set(0, 0, 0);
scene.add(spotlight);
scene.add(spotlight.target);

// FSN-style cone beam (angled, like the Jurassic Park movie)
const BEAM_TOP_RADIUS = 0.1;
const BEAM_BOT_RADIUS = 3.5;
const BEAM_SEGMENTS = 32;
const BEAM_SOURCE_OFFSET = new THREE.Vector3(10, 26, -6);

const beamClipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const beamMat = new THREE.MeshBasicMaterial({
  color: 0xddeeff,
  transparent: true,
  opacity: 0,
  side: THREE.DoubleSide,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  clippingPlanes: [beamClipPlane],
});

// Unit-height cone scaled dynamically to match beam length
const beamCone = new THREE.Mesh(
  new THREE.CylinderGeometry(BEAM_TOP_RADIUS, BEAM_BOT_RADIUS, 1, BEAM_SEGMENTS, 1, true),
  beamMat,
);
beamCone.visible = false;
scene.add(beamCone);

// Ground glow disc
const glowGeo = new THREE.CircleGeometry(3.5, 48);
const glowMat = new THREE.MeshBasicMaterial({
  color: 0xffeedd,
  transparent: true,
  opacity: 0,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
const glowDisc = new THREE.Mesh(glowGeo, glowMat);
glowDisc.rotation.x = -Math.PI / 2;
glowDisc.visible = false;
scene.add(glowDisc);

// Solid black ground plane
const groundGeo = new THREE.PlaneGeometry(600, 600);
const groundMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 });
const groundPlane = new THREE.Mesh(groundGeo, groundMat);
groundPlane.rotation.x = -Math.PI / 2;
groundPlane.position.y = -0.5;
scene.add(groundPlane);

// ── Minimap ──────────────────────────────────────────────────────
const minimapCanvas = document.getElementById('minimap-canvas');
const minimapRenderer = new THREE.WebGLRenderer({ canvas: minimapCanvas, antialias: false, alpha: true });
minimapRenderer.setPixelRatio(1); // low-res for perf
minimapRenderer.setClearColor(0x000000, 0.6);

const MINIMAP_SIZE = 200;
const minimapCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
minimapCamera.position.set(0, 200, 0);
minimapCamera.lookAt(0, 0, 0);

const minimap = {
  visible: false,
  zoom: 60,
};

// Camera position dot — rendered as a small sprite on the minimap
const dotTexture = (() => {
  const size = 16;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = 1;
  ctx.stroke();
  return new THREE.CanvasTexture(c);
})();

const dotSprite = new THREE.Sprite(new THREE.SpriteMaterial({
  map: dotTexture,
  depthTest: false,
  transparent: true,
}));
dotSprite.scale.set(2, 2, 1);
dotSprite.visible = false;
scene.add(dotSprite);

// Frustum cone — shows camera look direction on minimap
const frustumGeo = new THREE.ConeGeometry(1.5, 4, 3);
frustumGeo.rotateX(Math.PI / 2);
const frustumMat = new THREE.MeshBasicMaterial({
  color: 0x00ff88,
  transparent: true,
  opacity: 0.5,
  depthTest: false,
});
const frustumCone = new THREE.Mesh(frustumGeo, frustumMat);
frustumCone.visible = false;
scene.add(frustumCone);

function updateMinimapCamera(mainCamera, extent) {
  const half = (extent || minimap.zoom) / 2;
  const aspect = 1; // square minimap
  minimapCamera.left   = -half * aspect;
  minimapCamera.right  =  half * aspect;
  minimapCamera.top    =  half;
  minimapCamera.bottom = -half;
  minimapCamera.position.set(mainCamera.position.x, 200, mainCamera.position.z);
  minimapCamera.lookAt(mainCamera.position.x, 0, mainCamera.position.z);
  minimapCamera.updateProjectionMatrix();

  // Update dot position
  dotSprite.position.set(mainCamera.position.x, 199, mainCamera.position.z);
  dotSprite.visible = minimap.visible;

  // Update frustum cone direction
  frustumCone.position.set(mainCamera.position.x, 198, mainCamera.position.z);
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(mainCamera.quaternion);
  frustumCone.rotation.y = Math.atan2(-dir.x, -dir.z);
  frustumCone.visible = minimap.visible;
}

function renderMinimap() {
  if (!minimap.visible) return;
  minimapRenderer.render(scene, minimapCamera);
}

function resizeMinimap() {
  minimapRenderer.setSize(MINIMAP_SIZE, MINIMAP_SIZE);
}
resizeMinimap();

export {
  canvas,
  renderer,
  scene,
  camera,
  ORTHO_DEFAULT_ZOOM,
  orthoCamera,
  eagleEye,
  activeCamera,
  updateOrthoFrustum,
  renderPass,
  composer,
  ambient,
  pointLight,
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
  renderMinimap,
  resizeMinimap,
};

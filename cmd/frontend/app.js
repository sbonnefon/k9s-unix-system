import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// ── State ──────────────────────────────────────────────────────
const state = {
  namespaces: new Map(), // name -> { group, platform, pods: Map<name, mesh>, label }
  nodes: new Map(),      // name -> NodeInfo
  nodeIsland: null,      // { group, platform, blocks: Map<name, mesh>, label }
  services: [],          // [{name, namespace, type, clusterIP, selector}]
  serviceLines: null,    // THREE.Group holding connection lines
  ingresses: [],         // [{name, namespace, rules}]
  ingressGroup: null,    // THREE.Group for ingress visuals
  pvcs: [],              // [{name, namespace, status, capacity}]
  pvcGroup: null,        // THREE.Group for PVC disks
  workloads: [],         // [{name, namespace, kind, replicas, readyReplicas}]
  workloadGroup: null,   // THREE.Group for workload group outlines + labels
  resources: [],         // [{name, namespace, kind, data}]
  resourceGroup: null,   // THREE.Group for generic resource markers
};

// Layer visibility
const layers = {
  services: true,
  ingresses: true,
  pvcs: true,
  workloads: true,
  forbidden: true,
  nodes: true,
  configmaps: false,
  secrets: false,
  serviceaccounts: false,
  hpa: false,
  networkpolicies: false,
  pdb: false,
  replicasets: false,
  rbac: false,
  'other-resources': false,
};

const PLATFORM_GAP = 12;
const POD_BASE_SIZE = 0.7;
const POD_MIN_SIZE = 0.5;
const POD_MAX_SIZE = 1.8;
const POD_GAP = 1.5;
const POD_STRIDE = POD_MAX_SIZE + POD_GAP;
const PLATFORM_Y = 0;
const PLATFORM_HEIGHT = 0.3;
const LABEL_Y_OFFSET = 0.5;
const NODE_BLOCK_SIZE = 1.2;

// Layer heights — stacking order from bottom to top
const WORKLOAD_Y = PLATFORM_HEIGHT;          // workload outlines sit on top of platform
const WORKLOAD_BOX_HEIGHT = PLATFORM_HEIGHT; // same thickness as namespace platform
const PVC_Y = WORKLOAD_Y + WORKLOAD_BOX_HEIGHT + 0.05; // PVCs on top of workload
const POD_Y_OFFSET = WORKLOAD_Y + WORKLOAD_BOX_HEIGHT + 0.15; // pods on top of workload layer

const STATUS_COLORS = {
  Running:            0x00ff88,
  Succeeded:          0x00aaff,
  Pending:            0xffcc00,
  ContainerCreating:  0xffcc00,
  PodInitializing:    0xffcc00,
  Failed:             0xff4444,
  Error:              0xff4444,
  CrashLoopBackOff:   0xff2222,
  ImagePullBackOff:   0xff6600,
  Terminating:        0xff8800,
  Unknown:            0x888888,
};

function statusColor(status) {
  return STATUS_COLORS[status] ?? 0x00ff88;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + 'Ki';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + 'Mi';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'Gi';
}

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
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.6, 0.4, 0.85);
composer.addPass(bloom);

// Horizon gradient sky (Jurassic Park FSN style)
// Use a very large radius so the sphere is never perceived as a dome
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
      // Match fog/clear color exactly to avoid visible sphere edge
      vec3 bg    = vec3(0.008, 0.008, 0.008);
      vec3 green = vec3(0.03, 0.18, 0.08);

      vec3 col;
      if (h > 0.0) {
        // Very narrow horizon glow that fades quickly to background
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

// Spotlight (Jurassic Park style – starts hidden)
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

  // Extend cone generously past ground — a clipping plane at ground level
  // will cut it cleanly. The base circle is perpendicular to the tilted beam
  // axis, so it must overshoot to cover the full ground footprint.
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

  // Shape the glow disc to match the cone's elliptical ground footprint.
  // The cone radius at ground level is smaller than BEAM_BOT_RADIUS (base is
  // below ground due to overshoot), and the tilt stretches it into an ellipse.
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
  _billboardCacheDirty = true;
}

// Solid black ground plane
const groundGeo = new THREE.PlaneGeometry(600, 600);
const groundMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 });
const groundPlane = new THREE.Mesh(groundGeo, groundMat);
groundPlane.rotation.x = -Math.PI / 2;
groundPlane.position.y = -0.5;
scene.add(groundPlane);

// ── Materials ──────────────────────────────────────────────────
const platformMaterial = new THREE.MeshPhongMaterial({
  color: 0x882244,
  emissive: 0x331122,
  shininess: 30,
  transparent: true,
  opacity: 0.85,
});

const forbiddenPlatformMaterial = new THREE.MeshPhongMaterial({
  color: 0x111111,
  emissive: 0x000000,
  shininess: 10,
  transparent: true,
  opacity: 0.6,
});

function podMaterial(status) {
  const color = statusColor(status);
  return new THREE.MeshPhongMaterial({
    color,
    emissive: new THREE.Color(color).multiplyScalar(0.3),
    shininess: 60,
    transparent: true,
    opacity: 0.9,
  });
}

// ── Resource Sizing ────────────────────────────────────────────
// CPU: 100m → POD_MIN_SIZE, 2000m+ → POD_MAX_SIZE
// Memory: 64Mi → POD_MIN_SIZE, 2Gi+ → POD_MAX_SIZE
const CPU_MIN = 100;
const CPU_MAX = 2000;
const MEM_MIN = 64 * 1024 * 1024;
const MEM_MAX = 2 * 1024 * 1024 * 1024;

function podWidth(cpuMillis) {
  if (!cpuMillis || cpuMillis <= 0) return POD_BASE_SIZE;
  const t = Math.max(0, Math.min(1, (cpuMillis - CPU_MIN) / (CPU_MAX - CPU_MIN)));
  return POD_MIN_SIZE + t * (POD_MAX_SIZE - POD_MIN_SIZE);
}

function podDepth(memBytes) {
  if (!memBytes || memBytes <= 0) return POD_BASE_SIZE;
  const t = Math.max(0, Math.min(1, (memBytes - MEM_MIN) / (MEM_MAX - MEM_MIN)));
  return POD_MIN_SIZE + t * (POD_MAX_SIZE - POD_MIN_SIZE);
}

// ── Node Island Materials ───────────────────────────────────────
const nodePlatformMaterial = new THREE.MeshPhongMaterial({
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

function nodeBlockMaterial(status) {
  const color = NODE_BLOCK_COLORS[status] ?? 0x00ccff;
  return new THREE.MeshPhongMaterial({
    color,
    emissive: new THREE.Color(color).multiplyScalar(0.3),
    shininess: 60,
    transparent: true,
    opacity: 0.9,
  });
}

// ── Text Labels (canvas texture → flat on ground) ─────────────
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

    // Build CronJob → Job name map for this namespace (CronJob owns Job owns Pod)
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

    // Slightly more cols than rows → horizontal rectangle (~1.3:1 ratio)
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

    // Skip node island — already built by rebuildNodeIsland/layoutNodeIsland
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
    //    Active = has running/ready pods; Inactive = succeeded/failed/pending only
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
      // If this group won't fit the remainder of the current row
      // and it could fit on a fresh row, wrap to next row first
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

    // 4. Position pods with correct centering — offset into pod zone (top of platform)
    //    The platform = pod zone (top) + orphan zone (bottom, positive Z)
    //    Pods should be centered in the pod zone, shifted up by orphanZoneDepth/2
    const totalRows = (curCol > 0 ? curRow + 1 : curRow) || 1;
    const podZoneOffsetZ = -(ns.orphanZoneDepth || 0) / 2;
    for (const { mesh, col, row } of allPlaced) {
      const h = mesh.geometry.parameters.height || POD_BASE_SIZE;
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
    euler.setFromQuaternion(camera.quaternion);
  }

  // Refresh pod labels if spotlight is active
  if (spot.active && spot.nsName) {
    showPodLabels(spot.nsName);
    for (const { mesh } of spot.podLabels) {
      mesh.material.opacity = 0.85;
    }
  }
  invalidateMeshCache();
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

// Shared pod geometries — created once, reused for all pods of same type
const _sharedGeo = {
  box: new THREE.BoxGeometry(POD_BASE_SIZE, POD_BASE_SIZE, POD_BASE_SIZE),
  cylinder: new THREE.CylinderGeometry(POD_BASE_SIZE * 0.5, POD_BASE_SIZE * 0.5, POD_BASE_SIZE, 6),
  octahedron: new THREE.OctahedronGeometry(POD_BASE_SIZE * 0.5),
  cone: new THREE.ConeGeometry(POD_BASE_SIZE * 0.45, POD_BASE_SIZE, 5),
};

// Pod geometry based on owner kind — returns shared geometry
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
    existing.material.dispose();
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
    // geometry is shared — don't dispose it
    mesh.material.dispose();
    ns.pods.delete(podName);
    invalidateMeshCache();
  }
}

function removeNamespace(name) {
  const ns = state.namespaces.get(name);
  if (!ns) return;
  for (const [, mesh] of ns.pods) {
    // geometry is shared — don't dispose it
    mesh.material.dispose();
  }
  if (ns.platform) ns.platform.material.dispose();
  if (ns.wireframe) ns.wireframe.material.dispose();
  scene.remove(ns.group);
  state.namespaces.delete(name);
}

// ── Node Island ────────────────────────────────────────────────
function ensureNodeIsland() {
  if (state.nodeIsland) return state.nodeIsland;
  const group = new THREE.Group();
  group.userData = { type: 'namespace', name: '__nodes__' };
  scene.add(group);
  state.nodeIsland = { group, platform: null, blocks: new Map(), label: null };
  return state.nodeIsland;
}

function rebuildNodeIsland() {
  const island = ensureNodeIsland();

  // Remove old blocks
  for (const [, mesh] of island.blocks) {
    island.group.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
  island.blocks.clear();

  // Create a block per node
  const nodeList = [...state.nodes.keys()].sort();
  for (const name of nodeList) {
    const info = state.nodes.get(name);
    const geo = new THREE.BoxGeometry(NODE_BLOCK_SIZE, NODE_BLOCK_SIZE, NODE_BLOCK_SIZE);
    const mat = nodeBlockMaterial(info.status);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = { type: 'nodeBlock', node: info };
    island.blocks.set(name, mesh);
    island.group.add(mesh);
  }
}

function layoutNodeIsland() {
  const island = state.nodeIsland;
  if (!island) return;

  const blockCount = island.blocks.size;
  if (blockCount === 0) return;

  const blockStride = NODE_BLOCK_SIZE + 1.2;
  const blockCols = Math.max(2, Math.ceil(Math.sqrt(blockCount)));
  const blockRows = Math.max(1, Math.ceil(blockCount / blockCols));
  const platWidth = blockCols * blockStride + 2;
  const platDepth = blockRows * blockStride + 2;

  // Rebuild platform
  if (island.platform) {
    island.platform.material.dispose();
    island.group.remove(island.platform);
  }
  const platGeo = makeBeveledPlatformGeo(platWidth, PLATFORM_HEIGHT, platDepth);
  island.platform = new THREE.Mesh(platGeo, nodePlatformMaterial.clone());
  island.platform.position.y = -PLATFORM_HEIGHT / 2;
  island.platform.userData = { type: 'namespace', name: '__nodes__' };
  island.group.add(island.platform);

  // Rebuild label
  if (island.label) island.group.remove(island.label);
  island.label = makeLabel('NODES', 64, '#5599bb');
  island.label.position.set(0, 0.15, platDepth / 2 + 2);
  island.group.add(island.label);

  // Lay out blocks
  let idx = 0;
  for (const [, mesh] of island.blocks) {
    const pc = idx % blockCols;
    const pr = Math.floor(idx / blockCols);
    mesh.position.set(
      pc * blockStride - (blockCols * blockStride) / 2 + blockStride / 2,
      NODE_BLOCK_SIZE / 2,
      pr * blockStride - (blockRows * blockStride) / 2 + blockStride / 2,
    );
    idx++;
  }

  return { platWidth, platDepth };
}

// ── Service Connection Lines ───────────────────────────────────
function selectorMatchesLabels(selector, labels) {
  if (!selector || !labels) return false;
  for (const [k, v] of Object.entries(selector)) {
    if (labels[k] !== v) return false;
  }
  return true;
}

// Resolve URLs for a pod: Ingress → Service → Pod chain
function podURLs(pod) {
  if (!pod || !pod.labels) return [];
  const urls = [];
  // Find services that select this pod
  const matchedSvcs = state.services.filter(
    s => s.namespace === pod.namespace && selectorMatchesLabels(s.selector, pod.labels)
  );
  // Find ingresses that target those services
  // Check both same-namespace ingresses AND cross-namespace (serviceNamespace field)
  for (const ing of state.ingresses) {
    for (const rule of ing.rules || []) {
      if (!rule.serviceName) continue;
      // Determine which namespace this rule targets
      const targetNs = rule.serviceNamespace || ing.namespace;
      if (targetNs !== pod.namespace) continue;
      if (matchedSvcs.some(s => s.name === rule.serviceName)) {
        const proto = 'https://';
        const host = rule.host || '';
        const path = rule.path && rule.path !== '/' ? rule.path : '';
        if (host) {
          urls.push(proto + host + path);
        }
      }
    }
  }
  return [...new Set(urls)]; // deduplicate
}

function rebuildServiceLines() {
  if (state.serviceLines) {
    scene.remove(state.serviceLines);
    state.serviceLines.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  const group = new THREE.Group();
  group.userData = { type: 'serviceLines' };

  const TUBE_RADIUS = 0.06;
  const TUBE_SEGMENTS = 20;
  const TUBE_RADIAL = 6;

  for (const svc of state.services) {
    if (!svc.selector || Object.keys(svc.selector).length === 0) continue;

    const ns = state.namespaces.get(svc.namespace);
    if (!ns) continue;

    // Find matching pods
    const matchedMeshes = [];
    for (const [, podMesh] of ns.pods) {
      const pod = podMesh.userData.pod;
      if (pod && selectorMatchesLabels(svc.selector, pod.labels)) {
        matchedMeshes.push(podMesh);
      }
    }

    if (matchedMeshes.length < 1) continue;

    const worldPos = (mesh) => {
      const v = new THREE.Vector3();
      mesh.getWorldPosition(v);
      return v;
    };

    // Compute service anchor point: center above all matched pods
    const center = new THREE.Vector3();
    for (const m of matchedMeshes) center.add(worldPos(m));
    center.divideScalar(matchedMeshes.length);
    center.y += 2.5;

    // Service hub — a small glowing sphere at the anchor point
    const hubGeo = new THREE.SphereGeometry(0.18, 12, 12);
    const hubMat = new THREE.MeshPhongMaterial({
      color: 0x00aaff, emissive: 0x00aaff, emissiveIntensity: 0.8,
      transparent: true, opacity: 0.9,
    });
    const hub = new THREE.Mesh(hubGeo, hubMat);
    hub.position.copy(center);
    hub.userData = {
      type: 'service',
      service: svc,
      matchedPodCount: matchedMeshes.length,
    };
    group.add(hub);

    // Draw tubes from hub to each matched pod
    const tubeMat = new THREE.MeshPhongMaterial({
      color: 0x00aaff,
      emissive: 0x004466,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });

    for (const podMesh of matchedMeshes) {
      const target = worldPos(podMesh);
      const mid = center.clone().add(target).multiplyScalar(0.5);
      mid.y += 1.0;
      const curve = new THREE.QuadraticBezierCurve3(center, mid, target);
      const tubeGeo = new THREE.TubeGeometry(curve, TUBE_SEGMENTS, TUBE_RADIUS, TUBE_RADIAL, false);
      const tube = new THREE.Mesh(tubeGeo, tubeMat.clone());
      tube.userData = {
        type: 'service',
        service: svc,
        matchedPodCount: matchedMeshes.length,
      };
      group.add(tube);
    }
  }

  state.serviceLines = group;
  scene.add(group);
  invalidateMeshCache();
  applyLayerVisibility();
}

// ── Ingress Rendering ───────────────────────────────────────────
function rebuildIngresses() {
  if (state.ingressGroup) {
    scene.remove(state.ingressGroup);
    state.ingressGroup.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  const group = new THREE.Group();
  group.userData = { type: 'ingressGroup' };

  // Group ingresses by namespace — one gate per namespace
  const ingressesByNs = new Map();
  for (const ing of state.ingresses) {
    const list = ingressesByNs.get(ing.namespace) || [];
    list.push(ing);
    ingressesByNs.set(ing.namespace, list);
  }

  for (const [nsName, nsIngresses] of ingressesByNs) {
    const ns = state.namespaces.get(nsName);
    if (!ns || !ns.platform) continue;

    const platGeo = ns.platform.geometry;
    const platW = platGeo.parameters.width || 4;
    const nsWorldPos = new THREE.Vector3();
    ns.group.getWorldPosition(nsWorldPos);

    // Single arch per namespace
    const archX = nsWorldPos.x - platW / 2 - 1.5;
    const archZ = nsWorldPos.z;
    const archColor = 0xffaa00;
    const postMat = new THREE.MeshBasicMaterial({ color: archColor, transparent: true, opacity: 0.6 });
    const archData = { type: 'ingressArch', namespace: nsName, ingresses: nsIngresses };

    // Left post
    const postGeo = new THREE.BoxGeometry(0.1, 2.5, 0.1);
    const leftPost = new THREE.Mesh(postGeo, postMat.clone());
    leftPost.position.set(archX, 1.25, archZ - 0.8);
    leftPost.userData = archData;
    group.add(leftPost);

    // Right post
    const rightPost = new THREE.Mesh(postGeo.clone(), postMat.clone());
    rightPost.position.set(archX, 1.25, archZ + 0.8);
    rightPost.userData = archData;
    group.add(rightPost);

    // Top bar — wider for easier clicking
    const barGeo = new THREE.BoxGeometry(0.3, 0.3, 1.7);
    const bar = new THREE.Mesh(barGeo, postMat.clone());
    bar.position.set(archX, 2.5, archZ);
    bar.userData = archData;
    group.add(bar);

    // Count label above arch
    const routeCount = nsIngresses.reduce((n, ing) => n + (ing.rules || []).length, 0);
    const label = makeLabel(`${nsIngresses.length} ING · ${routeCount} routes`, 28, '#ffaa00', { billboard: true });
    label.scale.set(0.3, 0.3, 0.3);
    label.position.set(archX, 3.0, archZ);
    group.add(label);

    // Lines from arch to target services' pods (all ingresses combined)
    for (const ing of nsIngresses) {
      for (const rule of ing.rules || []) {
        if (!rule.serviceName) continue;
        const targetNs = rule.serviceNamespace || ing.namespace;
        const svc = state.services.find(s => s.name === rule.serviceName && s.namespace === targetNs);
        if (!svc || !svc.selector) continue;

        // Find pods in the target namespace (may differ from ingress namespace)
        const targetNsState = state.namespaces.get(targetNs);
        if (!targetNsState) continue;
        for (const [, podMesh] of targetNsState.pods) {
          const pod = podMesh.userData.pod;
          if (!pod || !selectorMatchesLabels(svc.selector, pod.labels)) continue;

          const podWorld = new THREE.Vector3();
          podMesh.getWorldPosition(podWorld);
          const archPos = new THREE.Vector3(archX, 2.0, archZ);
          const mid = archPos.clone().add(podWorld).multiplyScalar(0.5);
          mid.y += 1.5;

          const curve = new THREE.QuadraticBezierCurve3(archPos, mid, podWorld);
          const points = curve.getPoints(16);
          const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
          const lineMat = new THREE.LineBasicMaterial({
            color: archColor,
            transparent: true,
            opacity: 0.2,
            depthWrite: false,
          });
          group.add(new THREE.Line(lineGeo, lineMat));
        }
      }
    }
  }

  state.ingressGroup = group;
  scene.add(group);
  invalidateMeshCache();
  applyLayerVisibility();
}

// ── PVC Rendering ───────────────────────────────────────────────
function rebuildPVCs() {
  if (state.pvcGroup) {
    scene.remove(state.pvcGroup);
    state.pvcGroup.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  const group = new THREE.Group();
  group.userData = { type: 'pvcGroup' };

  for (const pvc of state.pvcs) {
    const ns = state.namespaces.get(pvc.namespace);
    if (!ns) continue;

    // Find pods that reference this PVC
    for (const [, podMesh] of ns.pods) {
      const pod = podMesh.userData.pod;
      if (!pod || !pod.pvcNames || !pod.pvcNames.includes(pvc.name)) continue;

      const podWorld = new THREE.Vector3();
      podMesh.getWorldPosition(podWorld);

      // Disk beneath the pod
      const radius = 0.45;
      const diskGeo = new THREE.CylinderGeometry(radius, radius, 0.12, 16);
      const diskColor = pvc.status === 'Bound' ? 0x8844cc
        : pvc.status === 'Pending' ? 0xffcc00
        : 0xff4444;
      const diskMat = new THREE.MeshPhongMaterial({
        color: diskColor,
        emissive: new THREE.Color(diskColor).multiplyScalar(0.3),
        transparent: true,
        opacity: 0.7,
      });
      const disk = new THREE.Mesh(diskGeo, diskMat);
      disk.position.set(podWorld.x, PVC_Y, podWorld.z);
      disk.userData = { type: 'pvc', pvc, podName: pod.name };
      group.add(disk);
    }
  }

  state.pvcGroup = group;
  scene.add(group);
  applyLayerVisibility();
}

// ── Workload Group Rendering ────────────────────────────────────
function rebuildWorkloadGroups() {
  if (state.workloadGroup) {
    scene.remove(state.workloadGroup);
    state.workloadGroup.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  const group = new THREE.Group();
  group.userData = { type: 'workloadGroup' };

  // Workload kind abbreviations and colors
  const WL_ABBREV = { Deployment: 'deploy', StatefulSet: 'sts', DaemonSet: 'ds', CronJob: 'cj', Job: 'job' };
  const WL_COLORS = { Deployment: 0x00ff88, StatefulSet: 0x00aaff, DaemonSet: 0x44ccaa, CronJob: 0xffaa00, Job: 0xffcc66 };

  // For CronJobs, pods are owned by Jobs (not CronJobs directly).
  // Build a map of CronJob name -> Job names so we can find their pods.
  const cronJobToJobs = new Map();
  for (const wl of state.workloads) {
    if (wl.kind === 'Job') {
      // Job names from CronJobs follow the pattern: <cronjob-name>-<timestamp>
      // Try to match with existing CronJobs in the same namespace
      for (const cjWl of state.workloads) {
        if (cjWl.kind === 'CronJob' && cjWl.namespace === wl.namespace && wl.name.startsWith(cjWl.name + '-')) {
          if (!cronJobToJobs.has(cjWl.namespace + '/' + cjWl.name)) {
            cronJobToJobs.set(cjWl.namespace + '/' + cjWl.name, []);
          }
          cronJobToJobs.get(cjWl.namespace + '/' + cjWl.name).push(wl.name);
        }
      }
    }
  }

  // Track which pods are already claimed to avoid double-matching
  const claimedPods = new Set();

  // Process workloads: most specific owners first (Job before CronJob),
  // then active before inactive (for orphan ordering)
  const wlSorted = [...state.workloads].sort((a, b) => {
    const order = { Job: 0, Deployment: 1, StatefulSet: 2, DaemonSet: 3, CronJob: 4 };
    return (order[a.kind] ?? 5) - (order[b.kind] ?? 5);
  });

  // Pre-count orphans per namespace for centering
  const orphanTotals = {};
  for (const wl of wlSorted) {
    const ns = state.namespaces.get(wl.namespace);
    if (!ns) continue;
    let hasPod = false;
    for (const [, podMesh] of ns.pods) {
      const pod = podMesh.userData.pod;
      if (!pod) continue;
      if (pod.ownerKind === wl.kind && pod.ownerName === wl.name) { hasPod = true; break; }
      if (wl.kind === 'CronJob') {
        const jobNames = cronJobToJobs.get(wl.namespace + '/' + wl.name) || [];
        if (pod.ownerKind === 'Job' && jobNames.includes(pod.ownerName)) { hasPod = true; break; }
      }
    }
    if (!hasPod) orphanTotals[wl.namespace] = (orphanTotals[wl.namespace] || 0) + 1;
  }
  const orphanCounters = {};

  for (const wl of wlSorted) {
    const ns = state.namespaces.get(wl.namespace);
    if (!ns) continue;

    // Find matching pods (only unclaimed ones)
    const matchedMeshes = [];
    for (const [podName, podMesh] of ns.pods) {
      if (claimedPods.has(wl.namespace + '/' + podName)) continue;
      const pod = podMesh.userData.pod;
      if (!pod) continue;

      let matched = false;
      if (pod.ownerKind === wl.kind && pod.ownerName === wl.name) {
        matched = true;
      }
      // CronJob: match pods owned by child Jobs
      if (!matched && wl.kind === 'CronJob') {
        const jobNames = cronJobToJobs.get(wl.namespace + '/' + wl.name) || [];
        if (pod.ownerKind === 'Job' && jobNames.includes(pod.ownerName)) {
          matched = true;
        }
      }
      if (matched) {
        matchedMeshes.push(podMesh);
        claimedPods.add(wl.namespace + '/' + podName);
      }
    }

    const outlineColor = WL_COLORS[wl.kind] || 0x00ff88;
    let cx, cz, w, d;

    if (matchedMeshes.length === 0) {
      // Place orphan workloads in the orphan zone (bottom of namespace platform)
      if (!orphanCounters[wl.namespace]) orphanCounters[wl.namespace] = 0;
      const orphanIdx = orphanCounters[wl.namespace]++;
      const nsGroup = ns.group;
      const halfD = (ns.platDepth || 6) / 2;
      const ozDepth = ns.orphanZoneDepth || 3;
      const totalOrphans = orphanTotals[wl.namespace] || 1;
      const orphanSpacing = 2.5;
      const orphanCols = Math.max(2, Math.min(totalOrphans, Math.floor((ns.platWidth || 6) / orphanSpacing)));
      const col = orphanIdx % orphanCols;
      const row = Math.floor(orphanIdx / orphanCols);
      const totalOrphanCols = Math.min(orphanCols, totalOrphans);
      // Orphan zone starts at (platDepth/2 - orphanZoneDepth) in local coords
      // Center orphans within that zone
      const orphanRows = Math.ceil(totalOrphans / orphanCols);
      const orphanBlockDepth = orphanRows * orphanSpacing;
      const orphanZoneCenter = halfD - ozDepth / 2;
      cx = nsGroup.position.x + (col - (totalOrphanCols - 1) / 2) * orphanSpacing;
      cz = nsGroup.position.z + orphanZoneCenter - orphanBlockDepth / 2 + row * orphanSpacing + orphanSpacing / 2;
      w = 2.0;
      d = 2.0;
    } else {
      // Compute bounding box of matched pods
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const mesh of matchedMeshes) {
        const wp = new THREE.Vector3();
        mesh.getWorldPosition(wp);
        minX = Math.min(minX, wp.x);
        maxX = Math.max(maxX, wp.x);
        minZ = Math.min(minZ, wp.z);
        maxZ = Math.max(maxZ, wp.z);
      }
      const pad = 0.5;
      w = Math.max(maxX - minX + pad * 2, 1.5);
      d = Math.max(maxZ - minZ + pad * 2, 1.5);
      cx = (minX + maxX) / 2;
      cz = (minZ + maxZ) / 2;
    }

    // Workload box
    const outlineGeo = new THREE.BoxGeometry(w, WORKLOAD_BOX_HEIGHT, d);
    const outlineMat = new THREE.MeshBasicMaterial({
      color: outlineColor,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
    });
    const outline = new THREE.Mesh(outlineGeo, outlineMat);
    outline.position.set(cx, WORKLOAD_Y + WORKLOAD_BOX_HEIGHT / 2, cz);
    outline.userData = {
      type: 'workload',
      workload: { name: wl.name, namespace: wl.namespace, kind: wl.kind, replicas: wl.replicas, readyReplicas: wl.readyReplicas, schedule: wl.schedule, suspended: wl.suspended, lastSchedule: wl.lastSchedule, activeJobs: wl.activeJobs },
    };
    group.add(outline);

    // Wireframe edges
    const edgesGeo = new THREE.EdgesGeometry(outlineGeo);
    const edgesMat = new THREE.LineBasicMaterial({
      color: outlineColor,
      transparent: true,
      opacity: 0.4,
    });
    const edges = new THREE.LineSegments(edgesGeo, edgesMat);
    edges.position.copy(outline.position);
    group.add(edges);

    // Label
    const abbrev = WL_ABBREV[wl.kind] || wl.kind.toLowerCase();
    let labelText, labelColor;
    if (wl.kind === 'CronJob') {
      labelColor = wl.suspended ? '#ff4444' : '#ffaa00';
      labelText = `${abbrev}/${wl.name} ${wl.schedule || '?'}${wl.suspended ? ' SUSPENDED' : ''}`;
    } else if (wl.kind === 'Job') {
      labelColor = wl.readyReplicas >= wl.replicas ? '#ffcc66' : '#ffcc00';
      labelText = `${abbrev}/${wl.name} ${wl.readyReplicas}/${wl.replicas}`;
    } else {
      const healthy = wl.readyReplicas >= wl.replicas;
      // Use workload-type color when healthy, warning color otherwise
      const WL_LABEL_COLORS = { Deployment: '#00ff88', StatefulSet: '#00aaff', DaemonSet: '#44ccaa', ReplicaSet: '#448899' };
      labelColor = healthy ? (WL_LABEL_COLORS[wl.kind] || '#00ff88') : '#ffcc00';
      labelText = `${abbrev}/${wl.name} ${wl.readyReplicas}/${wl.replicas}`;
    }
    const label = makeLabel(labelText, 28, labelColor, { billboard: true });
    label.scale.set(0.35, 0.35, 0.35);
    label.position.set(cx, WORKLOAD_Y + WORKLOAD_BOX_HEIGHT + 1.5, cz - d / 2 - 0.1);
    group.add(label);
  }

  state.workloadGroup = group;
  scene.add(group);
  applyLayerVisibility();
}

// ── Generic Resource Rendering ──────────────────────────────────

const RESOURCE_COLORS = {
  ConfigMap: 0x66bbcc,
  Secret: 0xcc6666,
  ServiceAccount: 0x88cc44,
  Endpoints: 0x777777,
  ResourceQuota: 0x777777,
  LimitRange: 0x777777,
  PersistentVolume: 0x777777,
  HPA: 0xdd8844,
  NetworkPolicy: 0xcc44aa,
  PDB: 0xaa88dd,
  ReplicaSet: 0x448899,
  Role: 0x998844,
  RoleBinding: 0x998844,
  ClusterRole: 0x998844,
  ClusterRoleBinding: 0x998844,
};

// Map resource kind to layer key
function resourceLayerKey(kind) {
  switch (kind) {
    case 'ConfigMap': return 'configmaps';
    case 'Secret': return 'secrets';
    case 'ServiceAccount': return 'serviceaccounts';
    case 'HPA': return 'hpa';
    case 'NetworkPolicy': return 'networkpolicies';
    case 'PDB': return 'pdb';
    case 'ReplicaSet': return 'replicasets';
    case 'Role': case 'RoleBinding': case 'ClusterRole': case 'ClusterRoleBinding': return 'rbac';
    default: return 'other-resources';
  }
}

const RESOURCE_MARKER_SIZE = 0.2;
const RESOURCE_Y = -0.1; // slightly below platform surface, flush with ground
const RESOURCE_SPACING = RESOURCE_MARKER_SIZE * 2.5;
const RESOURCE_EDGE_GAP = 1.2; // gap between platform edge and first marker

function rebuildResources() {
  if (state.resourceGroup) {
    scene.remove(state.resourceGroup);
    state.resourceGroup.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  const group = new THREE.Group();
  group.userData = { type: 'resourceGroup' };

  // Group resources by namespace, then by layer
  const byNs = new Map(); // nsName -> resources[]
  for (const res of state.resources) {
    const nsKey = res.namespace || '__cluster__';
    if (!byNs.has(nsKey)) byNs.set(nsKey, []);
    byNs.get(nsKey).push(res);
  }

  for (const [nsName, nsResources] of byNs) {
    const ns = state.namespaces.get(nsName);
    if (!ns && nsName !== '__cluster__') continue;

    const cx = ns ? ns.group.position.x : -20;
    const cz = ns ? ns.group.position.z : -20;
    const halfW = ns ? (ns.platWidth || 6) / 2 : 4;
    const halfD = ns ? (ns.platDepth || 6) / 2 : 4;

    // Group by layer key for visibility
    const byLayer = new Map();
    for (const res of nsResources) {
      const lk = resourceLayerKey(res.kind);
      if (!byLayer.has(lk)) byLayer.set(lk, []);
      byLayer.get(lk).push(res);
    }

    // Distribute layer groups around three edges: left, right, bottom
    // Each layer gets a "strip" along one edge
    const layerEntries = [...byLayer.entries()];
    const edgeSlots = []; // { side, offset } for each layer strip

    // Assign edges: cycle through left, bottom, right
    const sides = ['left', 'bottom', 'right'];
    const sideCounters = { left: 0, bottom: 0, right: 0 };

    for (let li = 0; li < layerEntries.length; li++) {
      const side = sides[li % sides.length];
      edgeSlots.push({ side, stripIdx: sideCounters[side] });
      sideCounters[side]++;
    }

    for (let li = 0; li < layerEntries.length; li++) {
      const [layerKey, resources] = layerEntries[li];
      const { side, stripIdx } = edgeSlots[li];

      const subGroup = new THREE.Group();
      subGroup.userData = { layerKey };
      subGroup.visible = !!layers[layerKey];

      // Compute how many items fit along the edge, then wrap into rows/cols
      const platH = halfD * 2; // island height (Z extent)
      const platW = halfW * 2; // island width (X extent)

      let maxAlong, maxPerp; // max items along edge, perpendicular rows/cols
      if (side === 'left' || side === 'right') {
        // Along Z axis, wrap into columns going outward (X)
        maxAlong = Math.max(1, Math.floor(platH / RESOURCE_SPACING));
      } else {
        // Along X axis, wrap into rows going outward (Z)
        maxAlong = Math.max(1, Math.floor(platW / RESOURCE_SPACING));
      }
      const wrapCols = Math.ceil(resources.length / maxAlong);

      // Base offset for this strip (multiple strips per side stack outward)
      const stripBase = stripIdx * (wrapCols * RESOURCE_SPACING + RESOURCE_SPACING);

      for (let i = 0; i < resources.length; i++) {
        const res = resources[i];
        const color = RESOURCE_COLORS[res.kind] || 0x777777;

        const geo = new THREE.BoxGeometry(RESOURCE_MARKER_SIZE, RESOURCE_MARKER_SIZE * 0.6, RESOURCE_MARKER_SIZE);
        const mat = new THREE.MeshPhongMaterial({
          color,
          emissive: new THREE.Color(color).multiplyScalar(0.4),
          transparent: true,
          opacity: 0.8,
        });
        const mesh = new THREE.Mesh(geo, mat);

        const along = i % maxAlong;   // position along the edge
        const perp = Math.floor(i / maxAlong); // which row/col outward

        let mx, mz;
        if (side === 'left') {
          mx = cx - halfW - RESOURCE_EDGE_GAP - stripBase - perp * RESOURCE_SPACING;
          mz = cz - halfD + along * RESOURCE_SPACING + RESOURCE_SPACING / 2;
        } else if (side === 'right') {
          mx = cx + halfW + RESOURCE_EDGE_GAP + stripBase + perp * RESOURCE_SPACING;
          mz = cz - halfD + along * RESOURCE_SPACING + RESOURCE_SPACING / 2;
        } else {
          mx = cx - halfW + along * RESOURCE_SPACING + RESOURCE_SPACING / 2;
          mz = cz + halfD + RESOURCE_EDGE_GAP + stripBase + perp * RESOURCE_SPACING;
        }

        mesh.position.set(mx, RESOURCE_Y + RESOURCE_MARKER_SIZE / 2, mz);
        mesh.userData = { type: 'resource', resource: res };
        subGroup.add(mesh);
      }

      // Summary label at the start of each strip
      if (resources.length > 0) {
        const kindCounts = {};
        for (const r of resources) kindCounts[r.kind] = (kindCounts[r.kind] || 0) + 1;
        const labelParts = Object.entries(kindCounts).map(([k, v]) => `${v}`);
        const firstKind = resources[0].kind;
        const labelText = `${firstKind} ${labelParts.join('+')}`;
        const color = RESOURCE_COLORS[firstKind] || 0x777777;
        const hexColor = '#' + new THREE.Color(color).getHexString();
        const label = makeLabel(labelText, 20, hexColor, { billboard: true });
        label.scale.set(0.2, 0.2, 0.2);

        let lx, lz;
        if (side === 'left') {
          lx = cx - halfW - RESOURCE_EDGE_GAP - stripBase;
          lz = cz - halfD - 0.3;
        } else if (side === 'right') {
          lx = cx + halfW + RESOURCE_EDGE_GAP + stripBase;
          lz = cz - halfD - 0.3;
        } else {
          lx = cx - halfW - 0.3;
          lz = cz + halfD + RESOURCE_EDGE_GAP + stripBase;
        }
        label.position.set(lx, RESOURCE_Y + 0.8, lz);
        subGroup.add(label);
      }

      group.add(subGroup);
    }
  }

  state.resourceGroup = group;
  scene.add(group);
  applyLayerVisibility();
}

// ── Layer Visibility ────────────────────────────────────────────
function applyLayerVisibility() {
  if (state.serviceLines) state.serviceLines.visible = layers.services;
  if (state.ingressGroup) state.ingressGroup.visible = layers.ingresses;
  if (state.pvcGroup) state.pvcGroup.visible = layers.pvcs;
  if (state.workloadGroup) state.workloadGroup.visible = layers.workloads;
  if (state.nodeIsland) state.nodeIsland.group.visible = layers.nodes;

  for (const [, ns] of state.namespaces) {
    if (ns.forbidden) {
      ns.group.visible = layers.forbidden;
    }
  }

  // Resource sub-groups visibility
  if (state.resourceGroup) {
    for (const child of state.resourceGroup.children) {
      if (child.userData && child.userData.layerKey) {
        child.visible = !!layers[child.userData.layerKey];
      }
    }
  }
}

// Wire up layer toggle checkboxes
document.querySelectorAll('#layer-panel input[data-layer]').forEach((cb) => {
  cb.addEventListener('change', () => {
    layers[cb.dataset.layer] = cb.checked;
    applyLayerVisibility();
  });
});

// ── HUD Update ─────────────────────────────────────────────────
function updateHUD() {
  let pods = 0;
  for (const [, ns] of state.namespaces) pods += ns.pods.size;
  document.getElementById('ns-count').textContent = state.namespaces.size;
  document.getElementById('pod-count').textContent = pods;
  document.getElementById('node-count').textContent = state.nodes.size;
  document.getElementById('svc-count').textContent = state.services.length;
  document.getElementById('ing-count').textContent = state.ingresses.length;
  document.getElementById('pvc-count').textContent = state.pvcs.length;
  document.getElementById('wl-count').textContent = state.workloads.length;
  document.getElementById('res-count').textContent = state.resources.length;
}

// ── Context Switcher ───────────────────────────────────────────
async function loadContexts() {
  try {
    const res = await fetch('/api/contexts');
    const data = await res.json();
    const sel = document.getElementById('ctx-select');
    sel.innerHTML = '';
    for (const ctx of (data.contexts || []).sort()) {
      const opt = document.createElement('option');
      opt.value = ctx;
      opt.textContent = ctx;
      sel.appendChild(opt);
    }
    sel.value = data.active || data.current;
  } catch (e) {
    console.error('Failed to load contexts:', e);
  }
}

document.getElementById('ctx-select').addEventListener('change', async (e) => {
  const newCtx = e.target.value;
  const sel = e.target;
  const switching = document.getElementById('ctx-switching');
  sel.disabled = true;
  switching.style.display = 'inline';

  try {
    const res = await fetch('/api/context/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: newCtx }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Context switch failed:', err);
      // Revert selection
      await loadContexts();
    }
    // The server will push a new snapshot via WebSocket automatically
  } catch (e) {
    console.error('Context switch error:', e);
    await loadContexts();
  } finally {
    sel.disabled = false;
    switching.style.display = 'none';
  }
});

loadContexts();

// ── WebSocket ──────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    document.getElementById('loading').style.display = 'none';
  };

  ws.onmessage = (e) => {
    const event = JSON.parse(e.data);
    handleEvent(event);
  };

  ws.onclose = () => {
    document.getElementById('loading').style.display = 'block';
    document.getElementById('loading').textContent = 'RECONNECTING...';
    setTimeout(connectWS, 3000);
  };
}

function handleEvent(event) {
  switch (event.type) {
    case 'snapshot':
      // Update active context in dropdown
      if (event.context) {
        const sel = document.getElementById('ctx-select');
        if (sel.value !== event.context) sel.value = event.context;
        document.getElementById('ctx-switching').style.display = 'none';
      }
      // Clear existing
      for (const [name] of state.namespaces) removeNamespace(name);
      for (const ns of event.snapshot) {
        ensureNamespace(ns.name, ns.forbidden || false);
        for (const pod of ns.pods ?? []) {
          addOrUpdatePod(ns.name, pod);
        }
      }
      // Nodes
      state.nodes.clear();
      for (const node of event.nodes ?? []) {
        state.nodes.set(node.name, node);
      }
      // Services
      state.services = event.services ?? [];
      // Ingresses
      state.ingresses = event.ingresses ?? [];
      // PVCs
      state.pvcs = event.pvcs ?? [];
      // Workloads
      state.workloads = event.workloads ?? [];
      // Resources
      state.resources = event.resources ?? [];
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngresses();
      rebuildPVCs();
      rebuildWorkloadGroups();
      rebuildResources();
      updateHUD();
      break;

    case 'pod_added':
    case 'pod_modified':
      addOrUpdatePod(event.namespace, event.pod);
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngresses();
      rebuildPVCs();
      rebuildWorkloadGroups();
      updateHUD();
      break;

    case 'pod_deleted':
      removePod(event.namespace, event.pod.name);
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngresses();
      rebuildPVCs();
      rebuildWorkloadGroups();
      updateHUD();
      break;

    case 'ns_added':
      ensureNamespace(event.namespace);
      layoutNamespaces();
      updateHUD();
      break;

    case 'ns_deleted':
      removeNamespace(event.namespace);
      layoutNamespaces();
      rebuildServiceLines();
      rebuildIngresses();
      rebuildPVCs();
      rebuildWorkloadGroups();
      updateHUD();
      break;

    case 'node_updated':
      state.nodes.set(event.node.name, event.node);
      layoutNamespaces();
      updateHUD();
      break;

    case 'node_deleted':
      state.nodes.delete(event.node.name);
      layoutNamespaces();
      updateHUD();
      break;

    case 'svc_updated':
      if (event.service) {
        const idx = state.services.findIndex(s => s.name === event.service.name && s.namespace === event.service.namespace);
        if (idx >= 0) state.services[idx] = event.service;
        else state.services.push(event.service);
      }
      rebuildServiceLines();
      updateHUD();
      break;

    case 'svc_deleted':
      if (event.service) {
        state.services = state.services.filter(s => !(s.name === event.service.name && s.namespace === event.service.namespace));
      }
      rebuildServiceLines();
      rebuildIngresses();
      updateHUD();
      break;

    case 'ingress_updated':
      if (event.ingress) {
        const idx = state.ingresses.findIndex(i => i.name === event.ingress.name && i.namespace === event.ingress.namespace);
        if (idx >= 0) state.ingresses[idx] = event.ingress;
        else state.ingresses.push(event.ingress);
      }
      rebuildIngresses();
      updateHUD();
      break;

    case 'ingress_deleted':
      if (event.ingress) {
        state.ingresses = state.ingresses.filter(i => !(i.name === event.ingress.name && i.namespace === event.ingress.namespace));
      }
      rebuildIngresses();
      updateHUD();
      break;

    case 'pvc_updated':
      if (event.pvc) {
        const idx = state.pvcs.findIndex(p => p.name === event.pvc.name && p.namespace === event.pvc.namespace);
        if (idx >= 0) state.pvcs[idx] = event.pvc;
        else state.pvcs.push(event.pvc);
      }
      rebuildPVCs();
      updateHUD();
      break;

    case 'pvc_deleted':
      if (event.pvc) {
        state.pvcs = state.pvcs.filter(p => !(p.name === event.pvc.name && p.namespace === event.pvc.namespace));
      }
      rebuildPVCs();
      updateHUD();
      break;

    case 'workload_updated':
      if (event.workload) {
        const idx = state.workloads.findIndex(w => w.name === event.workload.name && w.namespace === event.workload.namespace && w.kind === event.workload.kind);
        if (idx >= 0) state.workloads[idx] = event.workload;
        else state.workloads.push(event.workload);
      }
      rebuildWorkloadGroups();
      updateHUD();
      break;

    case 'workload_deleted':
      if (event.workload) {
        state.workloads = state.workloads.filter(w => !(w.name === event.workload.name && w.namespace === event.workload.namespace && w.kind === event.workload.kind));
      }
      rebuildWorkloadGroups();
      updateHUD();
      break;

    case 'resource_updated':
      if (event.resource) {
        const idx = state.resources.findIndex(r => r.name === event.resource.name && r.namespace === event.resource.namespace && r.kind === event.resource.kind);
        if (idx >= 0) state.resources[idx] = event.resource;
        else state.resources.push(event.resource);
      }
      rebuildResources();
      updateHUD();
      break;

    case 'resource_deleted':
      if (event.resource) {
        state.resources = state.resources.filter(r => !(r.name === event.resource.name && r.namespace === event.resource.namespace && r.kind === event.resource.kind));
      }
      rebuildResources();
      updateHUD();
      break;
  }
}

// ── Fly Camera Controller ──────────────────────────────────────
const velocity = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');
const keys = {};
let pointerLocked = false;

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

  // Fade out any existing spotlight before flying to new target
  fadeOutSpotlight();

  const worldPos = new THREE.Vector3();
  island.group.getWorldPosition(worldPos);

  flyTo.startPos.copy(camera.position);
  flyTo.startQuat.copy(camera.quaternion);
  flyTo.endPos.set(worldPos.x, worldPos.y + 10, worldPos.z + 12);

  // Compute end orientation: camera looking at the namespace center
  const lookMat = new THREE.Matrix4();
  lookMat.lookAt(flyTo.endPos, worldPos, new THREE.Vector3(0, 1, 0));
  flyTo.endQuat.setFromRotationMatrix(lookMat);

  flyTo.progress = 0;
  flyTo.active = true;
  flyTo.targetNs = nsName;
  velocity.set(0, 0, 0);
}

// Smooth ease-in-out curve
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

document.addEventListener('keydown', (e) => {
  keys[e.code] = true;

  // Toggle Eagle Eye with E key
  if (e.code === 'KeyE' && !e.repeat) {
    toggleEagleEye();
    return;
  }

  const movement = ['KeyW','KeyS','KeyA','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','ControlLeft','ControlRight'];
  if (movement.includes(e.code)) {
    // W/S zoom without cancelling the spotlight (other keys still dismiss it)
    if ((e.code === 'KeyW' || e.code === 'KeyS') && spot.active && !flyTo.active) return;
    cancelFlyTo();
  }
});
document.addEventListener('keyup', (e) => { keys[e.code] = false; });

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
  if (!isFinite(minX)) return { cx: 0, cz: 0, extent: ORTHO_DEFAULT_ZOOM };
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const w = maxX - minX + 20; // padding
  const h = maxZ - minZ + 20;
  const aspect = window.innerWidth / window.innerHeight;
  const extent = Math.max(h, w / aspect) * 1.2;
  return { cx, cz, extent: Math.max(extent, ORTHO_DEFAULT_ZOOM) };
}

function toggleEagleEye() {
  eagleEye.active = !eagleEye.active;

  if (eagleEye.active) {
    // Exit pointer lock when entering eagle eye
    if (pointerLocked) document.exitPointerLock();
    cancelFlyTo();

    // Auto-fit: center on layout and zoom to show everything
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

// Scroll-to-zoom in Eagle Eye mode
canvas.addEventListener('wheel', (e) => {
  if (!eagleEye.active) return;
  e.preventDefault();
  eagleEye.zoom = Math.max(10, Math.min(600, eagleEye.zoom + e.deltaY * 0.1));
  updateOrthoFrustum();
}, { passive: false });

function updateControlsHint() {
  const hint = document.getElementById('controls-hint');
  if (eagleEye.active) {
    hint.textContent = 'EAGLE EYE \u2022 WASD/Arrows: Pan \u2022 Scroll: Zoom \u2022 E: Exit';
  } else {
    hint.textContent = 'WASD/Arrows: Move \u00b7 Mouse: Look \u00b7 Shift: Fast \u00b7 Space/Ctrl: Up/Down \u00b7 Click: Lock cursor \u00b7 Esc: Unlock \u00b7 E: Eagle Eye';
  }
}

canvas.addEventListener('click', (e) => {
  if (pointerLocked) return;
  // Raycast against namespace labels and platforms
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
}

// ── Raycasting (hover tooltip) ─────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hoveredMesh = null;
const tooltip = document.getElementById('tooltip');

let _mouseDirty = false;
document.addEventListener('mousemove', (e) => {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  _mouseDirty = true;

  // Tooltip position
  tooltip.style.left = (e.clientX + 16) + 'px';
  tooltip.style.top = (e.clientY + 16) + 'px';
});

// Cached mesh arrays — rebuilt only when scene changes
let _cachedHoverTargets = [];
let _cachedNsTargets = [];
let _meshCacheDirty = true;

function invalidateMeshCache() {
  _meshCacheDirty = true;
  _billboardCacheDirty = true;
}

const HOVERABLE_TYPES = new Set(['pod', 'nodeBlock', 'resource', 'workload', 'pvc', 'ingressArch', 'namespace', 'service']);

function rebuildMeshCache() {
  if (!_meshCacheDirty) return;
  _cachedHoverTargets = [];
  _cachedNsTargets = [];
  scene.traverse((obj) => {
    if (obj.isMesh && HOVERABLE_TYPES.has(obj.userData.type)) {
      _cachedHoverTargets.push(obj);
    }
    if (obj.userData.type === 'namespace' || obj.userData.type === 'label' || obj.userData.type === 'ingressArch') {
      _cachedNsTargets.push(obj);
    }
  });
  _meshCacheDirty = false;
}

// Store original material state for unhover restore
let _hoverSavedState = null;

function applyHoverHighlight(mesh) {
  const mat = mesh.material;
  _hoverSavedState = {
    emissiveIntensity: mat.emissiveIntensity,
    opacity: mat.opacity,
    emissive: mat.emissive ? mat.emissive.clone() : null,
  };
  if (mat.emissive) {
    mat.emissiveIntensity = Math.max(mat.emissiveIntensity * 3, 2);
  }
  // Boost opacity for transparent objects (workloads, ingress arches, etc.)
  if (mat.transparent && mat.opacity < 0.5) {
    mat.opacity = Math.min(mat.opacity * 3, 0.6);
  }
}

function removeHoverHighlight(mesh) {
  if (!_hoverSavedState) return;
  const mat = mesh.material;
  if (_hoverSavedState.emissive) {
    mat.emissiveIntensity = _hoverSavedState.emissiveIntensity;
  }
  mat.opacity = _hoverSavedState.opacity;
  _hoverSavedState = null;
}

function buildTooltipHTML(mesh) {
  const ud = mesh.userData;
  switch (ud.type) {
    case 'pod': {
      const pod = ud.pod;
      const statusClass = pod.status === 'Running' ? 'status-running'
        : ['Pending', 'ContainerCreating', 'PodInitializing'].includes(pod.status) ? 'status-pending'
        : 'status-error';
      const matchedSvcs = state.services
        .filter(s => s.namespace === pod.namespace && selectorMatchesLabels(s.selector, pod.labels))
        .map(s => s.name);
      return `
        <div class="pod-name">${pod.name}</div>
        <div class="pod-ns">ns/${pod.namespace}${pod.nodeName ? ' · node/' + pod.nodeName : ''}</div>
        ${pod.ownerKind ? `<div style="opacity:0.8">${pod.ownerKind}/${pod.ownerName}</div>` : ''}
        <div class="pod-status ${statusClass}">● ${pod.status}</div>
        <div>Ready: ${pod.ready ? 'YES' : 'NO'} &middot; Restarts: ${pod.restarts} &middot; Containers: ${pod.containerCount || 1}</div>
        ${pod.cpuRequest || pod.memoryRequest ? `<div>CPU: ${pod.cpuRequest ? pod.cpuRequest + 'm' : '—'} &middot; Mem: ${pod.memoryRequest ? formatBytes(pod.memoryRequest) : '—'}</div>` : ''}
        ${matchedSvcs.length ? `<div style="color:#00aaff">svc/${matchedSvcs.join(', svc/')}</div>` : ''}
        ${pod.pvcNames && pod.pvcNames.length ? `<div style="color:#8844cc">pvc/${pod.pvcNames.join(', pvc/')}</div>` : ''}
        ${(() => { const u = podURLs(pod); return u.length ? `<div style="color:#ffaa00">${u.join(', ')}</div>` : ''; })()}
        <div>Age: ${pod.age}</div>
        <div style="opacity:0.5; margin-top:4px">Double-click for actions</div>
      `;
    }
    case 'nodeBlock': {
      const node = ud.node;
      const statusClass = node.status === 'Ready' ? 'status-running' : 'status-error';
      return `
        <div class="pod-name">${node.name}</div>
        <div class="pod-ns">node</div>
        <div class="pod-status ${statusClass}">● ${node.status}</div>
        ${node.cpuCapacity ? `<div>CPU: ${node.cpuCapacity}m &middot; Mem: ${formatBytes(node.memoryCapacity)}</div>` : ''}
      `;
    }
    case 'resource': {
      const res = ud.resource;
      const color = '#' + new THREE.Color(RESOURCE_COLORS[res.kind] || 0x777777).getHexString();
      const dataEntries = res.data ? Object.entries(res.data).map(([k, v]) => `<div style="opacity:0.7">${k}: ${v}</div>`).join('') : '';
      return `
        <div class="pod-name" style="color:${color}">${res.kind}</div>
        <div class="pod-ns">${res.name}${res.namespace ? ' · ns/' + res.namespace : ' (cluster)'}</div>
        ${dataEntries}
      `;
    }
    case 'workload': {
      const wl = ud.workload;
      const WL_COLORS_HEX = { Deployment: '#00ff88', StatefulSet: '#00aaff', DaemonSet: '#44ccaa', CronJob: '#ffaa00', Job: '#ffcc66' };
      const color = WL_COLORS_HEX[wl.kind] || '#00ff88';
      let info = '';
      if (wl.kind === 'CronJob') {
        info = `<div>Schedule: ${wl.schedule || '?'}</div>`;
        if (wl.suspended) info += `<div style="color:#ff4444">SUSPENDED</div>`;
        if (wl.lastSchedule) info += `<div>Last: ${wl.lastSchedule}</div>`;
        if (wl.activeJobs !== undefined) info += `<div>Active jobs: ${wl.activeJobs}</div>`;
      } else if (wl.kind === 'Job') {
        info = `<div>Completions: ${wl.readyReplicas}/${wl.replicas}</div>`;
      } else {
        const healthy = wl.readyReplicas >= wl.replicas;
        info = `<div>Replicas: ${wl.readyReplicas}/${wl.replicas} ${healthy ? '' : '<span style="color:#ffcc00">NOT READY</span>'}</div>`;
      }
      return `
        <div class="pod-name" style="color:${color}">${wl.kind}</div>
        <div class="pod-ns">${wl.name} · ns/${wl.namespace}</div>
        ${info}
        <div style="opacity:0.5; margin-top:4px">Double-click to edit</div>
      `;
    }
    case 'pvc': {
      const pvc = ud.pvc;
      const statusColor = pvc.status === 'Bound' ? '#8844cc' : pvc.status === 'Pending' ? '#ffcc00' : '#ff4444';
      return `
        <div class="pod-name" style="color:#8844cc">PersistentVolumeClaim</div>
        <div class="pod-ns">${pvc.name} · ns/${pvc.namespace}</div>
        <div style="color:${statusColor}">● ${pvc.status}</div>
        ${pvc.capacity ? `<div>Capacity: ${pvc.capacity}</div>` : ''}
        ${ud.podName ? `<div style="opacity:0.7">Mounted by: ${ud.podName}</div>` : ''}
      `;
    }
    case 'ingressArch': {
      const nsIngresses = ud.ingresses || [];
      const routeCount = nsIngresses.reduce((n, ing) => n + (ing.rules || []).length, 0);
      let routes = '';
      for (const ing of nsIngresses.slice(0, 5)) {
        for (const rule of (ing.rules || []).slice(0, 3)) {
          routes += `<div style="opacity:0.7">${rule.host || '—'}${rule.path || '/'} → svc/${rule.serviceName || '?'}</div>`;
        }
      }
      if (routeCount > 8) routes += `<div style="opacity:0.5">...and ${routeCount - 8} more</div>`;
      return `
        <div class="pod-name" style="color:#ffaa00">Ingress</div>
        <div class="pod-ns">ns/${ud.namespace} · ${nsIngresses.length} ingress(es) · ${routeCount} route(s)</div>
        ${routes}
        <div style="opacity:0.5; margin-top:4px">Click for route details</div>
      `;
    }
    case 'namespace': {
      const nsName = ud.name;
      if (nsName === '__nodes__') return null;
      const ns = state.namespaces.get(nsName);
      const podCount = ns ? ns.pods.size : 0;
      const wlCount = state.workloads.filter(w => w.namespace === nsName).length;
      const svcCount = state.services.filter(s => s.namespace === nsName).length;
      const ingCount = state.ingresses.filter(i => i.namespace === nsName).length;
      return `
        <div class="pod-name" style="color:#cc6699">${nsName}</div>
        <div class="pod-ns">namespace</div>
        <div>${podCount} pod(s) &middot; ${wlCount} workload(s)</div>
        <div>${svcCount} service(s) &middot; ${ingCount} ingress(es)</div>
        <div style="opacity:0.5; margin-top:4px">Click to spotlight</div>
      `;
    }
    case 'service': {
      const svc = ud.service;
      const portsStr = (svc.ports || []).map(p => `${p.port}${p.name ? '/' + p.name : ''} → ${p.targetPort} (${p.protocol})`).join('<br>');
      return `
        <div class="pod-name" style="color:#00aaff">Service</div>
        <div class="pod-ns">${svc.name} · ns/${svc.namespace}</div>
        <div>Type: ${svc.type} &middot; ClusterIP: ${svc.clusterIP || 'None'}</div>
        ${portsStr ? `<div style="opacity:0.8">${portsStr}</div>` : ''}
        <div style="opacity:0.7">${ud.matchedPodCount || 0} matching pod(s)</div>
        <div style="opacity:0.5; margin-top:4px">Double-click for actions</div>
      `;
    }
    default:
      return null;
  }
}

function updateRaycast() {
  if (!_mouseDirty) return;
  _mouseDirty = false;

  rebuildMeshCache();
  raycaster.setFromCamera(mouse, activeCamera());

  // Cursor hint for clickable targets
  if (!pointerLocked) {
    const nsHits = raycaster.intersectObjects(_cachedNsTargets);
    canvas.style.cursor = nsHits.length > 0 ? 'pointer' : 'default';
  }

  const intersects = raycaster.intersectObjects(_cachedHoverTargets);

  if (hoveredMesh) {
    removeHoverHighlight(hoveredMesh);
    hoveredMesh = null;
  }

  if (intersects.length > 0) {
    hoveredMesh = intersects[0].object;
    applyHoverHighlight(hoveredMesh);
    canvas.style.cursor = 'pointer';

    const html = buildTooltipHTML(hoveredMesh);
    if (html) {
      tooltip.innerHTML = html;
      tooltip.style.display = 'block';
    } else {
      tooltip.style.display = 'none';
    }
  } else {
    tooltip.style.display = 'none';
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

// ── Depth transparency ─────────────────────────────────────────
const DEPTH_FADE_START = 60;
const DEPTH_FADE_END = 250;
const DEPTH_MIN_OPACITY = 0.25;

const BASE_PLATFORM_OPACITY = 0.85;
const BASE_POD_OPACITY = 0.9;
const BASE_LABEL_OPACITY = 0.9;

function depthOpacityFactor(distance) {
  if (distance <= DEPTH_FADE_START) return 1;
  if (distance >= DEPTH_FADE_END) return DEPTH_MIN_OPACITY;
  const t = (distance - DEPTH_FADE_START) / (DEPTH_FADE_END - DEPTH_FADE_START);
  return 1 - t * (1 - DEPTH_MIN_OPACITY);
}

const _depthTmpVec = new THREE.Vector3();
const _lastCamPos = new THREE.Vector3();
let _depthDirty = true;

function markDepthDirty() { _depthDirty = true; }

function updateDepthTransparency() {
  const camPos = activeCamera().position;
  // Skip if camera hasn't moved significantly (saves 300+ material updates per frame)
  if (!_depthDirty && _lastCamPos.distanceToSquared(camPos) < 0.01) return;
  _lastCamPos.copy(camPos);
  _depthDirty = false;

  for (const [, ns] of state.namespaces) {
    ns.group.getWorldPosition(_depthTmpVec);
    const dist = eagleEye.active ? 0 : camPos.distanceTo(_depthTmpVec);
    const f = depthOpacityFactor(dist);

    if (ns.platform) ns.platform.material.opacity = BASE_PLATFORM_OPACITY * f;
    if (ns.label) ns.label.material.opacity = BASE_LABEL_OPACITY * f;

    for (const [, mesh] of ns.pods) {
      mesh.material.opacity = BASE_POD_OPACITY * f;
    }
  }

  // Node island
  if (state.nodeIsland) {
    state.nodeIsland.group.getWorldPosition(_depthTmpVec);
    const dist = eagleEye.active ? 0 : camPos.distanceTo(_depthTmpVec);
    const f = depthOpacityFactor(dist);
    if (state.nodeIsland.platform) state.nodeIsland.platform.material.opacity = BASE_PLATFORM_OPACITY * f;
    if (state.nodeIsland.label) state.nodeIsland.label.material.opacity = BASE_LABEL_OPACITY * f;
    for (const [, mesh] of state.nodeIsland.blocks) {
      mesh.material.opacity = BASE_POD_OPACITY * f;
    }
  }
}

// ── Billboard labels (face camera) ────────────────────────────
let _billboardMeshes = [];
let _billboardCacheDirty = true;

function invalidateBillboardCache() { _billboardCacheDirty = true; }

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

// ── Pod Actions (double-click menu) ────────────────────────────
const podMenu = document.getElementById('pod-menu');
const podMenuTitle = document.getElementById('pod-menu-title');
const outputPanel = document.getElementById('output-panel');
const outputTitle = document.getElementById('output-title');
const outputBody = document.getElementById('output-body');
const outputClose = document.getElementById('output-close');
const killConfirm = document.getElementById('kill-confirm');
const killPodName = document.getElementById('kill-pod-name');
const killYes = document.getElementById('kill-yes');
const killNo = document.getElementById('kill-no');

let selectedPod = null;   // { name, namespace }
let selectedService = null; // { name, namespace, ports }
let logAbort = null;       // AbortController for log streaming

// ── Service Actions (double-click menu) ─────────────────────────
const svcMenu = document.getElementById('svc-menu');
const svcMenuTitle = document.getElementById('svc-menu-title');

function closeSvcMenu() {
  svcMenu.style.display = 'none';
  selectedService = null;
}

document.getElementById('svc-menu-describe').addEventListener('click', () => {
  if (selectedService) { doServiceDescribe(selectedService); }
});
document.getElementById('svc-menu-endpoints').addEventListener('click', () => {
  if (selectedService) { doServiceEndpoints(selectedService); }
});

async function doServiceDescribe(svc) {
  closeOutputPanel();
  outputTitle.textContent = `DESCRIBE  svc/${svc.namespace}/${svc.name}`;
  outputBody.textContent = 'Loading...';
  outputPanel.style.display = 'flex';

  try {
    const resp = await fetch(`/api/service/describe?namespace=${encodeURIComponent(svc.namespace)}&name=${encodeURIComponent(svc.name)}`);
    if (!resp.ok) throw new Error(await resp.text());
    const desc = await resp.json();

    let out = '';
    out += `Name:       ${desc.name}\n`;
    out += `Namespace:  ${desc.namespace}\n`;
    out += `Type:       ${desc.type}\n`;
    out += `ClusterIP:  ${desc.clusterIP || 'None'}\n`;
    if (desc.externalIPs && desc.externalIPs.length) out += `External:   ${desc.externalIPs.join(', ')}\n`;
    out += `Age:        ${desc.age}\n`;
    if (desc.selector && Object.keys(desc.selector).length) {
      out += `Selector:\n`;
      for (const [k, v] of Object.entries(desc.selector)) {
        out += `  ${k}=${v}\n`;
      }
    }
    if (desc.labels && Object.keys(desc.labels).length) {
      out += `Labels:\n`;
      for (const [k, v] of Object.entries(desc.labels)) {
        out += `  ${k}=${v}\n`;
      }
    }
    out += `\n--- PORTS ---\n`;
    for (const p of (desc.ports || [])) {
      out += `  ${p.name || '(unnamed)'}  ${p.port} → ${p.targetPort}  ${p.protocol}${p.nodePort ? '  NodePort: ' + p.nodePort : ''}\n`;
    }
    if (desc.events && desc.events.length) {
      out += `\n--- EVENTS ---\n`;
      for (const ev of desc.events) {
        out += `  ${ev}\n`;
      }
    }

    const escaped = out.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    outputBody.innerHTML = escaped;
  } catch (err) {
    outputBody.textContent = `ERROR: ${err.message}`;
  }
}

async function doServiceEndpoints(svc) {
  closeOutputPanel();
  outputTitle.textContent = `ENDPOINTS  svc/${svc.namespace}/${svc.name}`;
  outputBody.textContent = 'Loading...';
  outputPanel.style.display = 'flex';

  try {
    const resp = await fetch(`/api/service/endpoints?namespace=${encodeURIComponent(svc.namespace)}&name=${encodeURIComponent(svc.name)}`);
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();

    let out = `Endpoints for svc/${data.namespace}/${data.name}\n`;
    out += `${'─'.repeat(50)}\n\n`;

    const subsets = data.subsets || [];
    if (subsets.length === 0) {
      out += '  (no endpoints)\n';
    }
    for (const sub of subsets) {
      const ports = (sub.ports || []).map(p => `${p.port}/${p.protocol}${p.name ? ' (' + p.name + ')' : ''}`).join(', ');
      out += `Ports: ${ports || '(none)'}\n\n`;
      out += `  ${'IP'.padEnd(18)} ${'POD'.padEnd(40)} ${'NODE'.padEnd(24)} READY\n`;
      out += `  ${'─'.repeat(18)} ${'─'.repeat(40)} ${'─'.repeat(24)} ${'─'.repeat(5)}\n`;
      for (const addr of (sub.addresses || [])) {
        const ready = addr.ready ? '✓' : '✗';
        out += `  ${(addr.ip || '').padEnd(18)} ${(addr.podName || '—').padEnd(40)} ${(addr.nodeName || '—').padEnd(24)} ${ready}\n`;
      }
      out += '\n';
    }

    const escaped = out.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    outputBody.innerHTML = escaped;
  } catch (err) {
    outputBody.textContent = `ERROR: ${err.message}`;
  }
}

async function doServicePortForward(svc, port) {
  closeSvcMenu();
  outputTitle.textContent = `PORT-FORWARD  svc/${svc.namespace}/${svc.name}:${port}`;
  outputBody.textContent = 'Starting port-forward...';
  outputPanel.style.display = 'flex';

  try {
    const resp = await fetch('/api/service/portforward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: svc.namespace, name: svc.name, port }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();

    let out = '';
    if (data.status === 'already_running') {
      out += `Port-forward already active!\n\n`;
    } else {
      out += `Port-forward started successfully.\n\n`;
    }
    out += `  Service:    svc/${svc.namespace}/${svc.name}\n`;
    out += `  Remote:     :${port}\n`;
    out += `  Local:      http://localhost:${data.localPort}\n`;
    out += `\nOpen http://localhost:${data.localPort} in your browser.\n`;
    out += `\nTo stop: double-click service again or call DELETE /api/service/portforward\n`;

    const escaped = out.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const withLinks = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" style="color:#44ccaa;text-decoration:underline;pointer-events:auto;cursor:pointer">$1</a>');
    outputBody.innerHTML = withLinks;
  } catch (err) {
    outputBody.textContent = `ERROR: ${err.message}`;
  }
}

function closePodMenu() {
  podMenu.style.display = 'none';
  selectedPod = null;
}

function closeOutputPanel() {
  outputPanel.style.display = 'none';
  outputBody.textContent = '';
  if (logAbort) { logAbort.abort(); logAbort = null; }
}

function closeKillConfirm() {
  killConfirm.style.display = 'none';
}

canvas.addEventListener('dblclick', (e) => {
  const dblMouse = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  );
  const dblRay = new THREE.Raycaster();
  dblRay.setFromCamera(dblMouse, activeCamera());

  // Collect pod, workload, and service meshes
  const podMeshes = [];
  const wlMeshes = [];
  const svcMeshes = [];
  scene.traverse((obj) => {
    if (obj.isMesh && obj.userData.type === 'pod') podMeshes.push(obj);
    if (obj.isMesh && obj.userData.type === 'workload') wlMeshes.push(obj);
    if (obj.isMesh && obj.userData.type === 'service') svcMeshes.push(obj);
  });

  // Prioritize pod hits over service/workload hits
  const podHits = dblRay.intersectObjects(podMeshes);
  if (podHits.length > 0) {
    const pod = podHits[0].object.userData.pod;
    if (!pod) return;

    selectedPod = { name: pod.name, namespace: pod.namespace, labels: pod.labels };
    podMenuTitle.textContent = pod.name;

    const urls = podURLs(pod);
    const openUrlItem = document.getElementById('pod-menu-open-url');
    if (urls.length > 0) {
      openUrlItem.style.display = 'flex';
      openUrlItem.dataset.urls = JSON.stringify(urls);
    } else {
      openUrlItem.style.display = 'none';
    }

    podMenu.style.left = e.clientX + 'px';
    podMenu.style.top = e.clientY + 'px';
    podMenu.style.display = 'block';
    e.stopPropagation();
    return;
  }

  // Check service hits
  const svcHits = dblRay.intersectObjects(svcMeshes);
  if (svcHits.length > 0) {
    const svc = svcHits[0].object.userData.service;
    if (!svc) return;
    selectedService = { name: svc.name, namespace: svc.namespace, ports: svc.ports || [] };
    svcMenuTitle.textContent = `svc/${svc.name}`;
    // Show/hide port-forward items based on ports
    const pfContainer = document.getElementById('svc-menu-pf-ports');
    pfContainer.innerHTML = '';
    for (const p of (svc.ports || [])) {
      const item = document.createElement('div');
      item.className = 'menu-item';
      item.style.color = '#44ccaa';
      item.innerHTML = `<span class="menu-key" style="border-color:#44ccaa;color:#44ccaa">P</span> Port-forward :${p.port}`;
      item.addEventListener('click', () => doServicePortForward(svc, p.port));
      pfContainer.appendChild(item);
    }
    svcMenu.style.left = e.clientX + 'px';
    svcMenu.style.top = e.clientY + 'px';
    svcMenu.style.display = 'block';
    e.stopPropagation();
    return;
  }

  // Check workload hits
  const wlHits = dblRay.intersectObjects(wlMeshes);
  if (wlHits.length > 0) {
    const wl = wlHits[0].object.userData.workload;
    if (!wl) return;
    openWorkloadEdit(wl);
    e.stopPropagation();
    return;
  }
});

// Close menu on click outside (but not when clicking on the output panel or the menu itself)
document.addEventListener('click', (e) => {
  if (podMenu.style.display === 'block' && !podMenu.contains(e.target) && !outputPanel.contains(e.target)) {
    closePodMenu();
    closeOutputPanel();
  }
  if (svcMenu.style.display === 'block' && !svcMenu.contains(e.target) && !outputPanel.contains(e.target)) {
    closeSvcMenu();
    closeOutputPanel();
  }
  if (wlEditPanel.style.display === 'block' && !wlEditPanel.contains(e.target)) {
    closeWorkloadEdit();
  }
});

// Highlight active menu item
function setActiveMenuItem(id) {
  podMenu.querySelectorAll('.menu-item').forEach(el => el.style.background = '');
  if (id) {
    const el = document.getElementById(id);
    if (el) el.style.background = 'rgba(0, 255, 136, 0.15)';
  }
}

// Reposition pod menu to left side so it doesn't overlap with output panel
function repositionPodMenu() {
  if (podMenu.style.display !== 'block') return;
  const menuRect = podMenu.getBoundingClientRect();
  // Keep menu on left half when output panel is open
  if (outputPanel.style.display === 'flex') {
    const maxX = window.innerWidth * 0.5 - menuRect.width - 10;
    if (menuRect.left > maxX) {
      podMenu.style.left = Math.max(10, maxX) + 'px';
    }
  }
}

// Menu item clicks — keep menu open for describe/logs, close for kill/url
document.getElementById('pod-menu-describe').addEventListener('click', () => {
  if (selectedPod) { doPodDescribe(selectedPod); setActiveMenuItem('pod-menu-describe'); repositionPodMenu(); }
});
document.getElementById('pod-menu-logs').addEventListener('click', () => {
  if (selectedPod) { doPodLogs(selectedPod); setActiveMenuItem('pod-menu-logs'); repositionPodMenu(); }
});
document.getElementById('pod-menu-kill').addEventListener('click', () => {
  if (selectedPod) showKillConfirm(selectedPod);
  closePodMenu();
});
document.getElementById('pod-menu-open-url').addEventListener('click', () => {
  const openUrlItem = document.getElementById('pod-menu-open-url');
  const urls = JSON.parse(openUrlItem.dataset.urls || '[]');
  for (const url of urls) window.open(url, '_blank');
});

// ── Ingress arch click → route list panel ──────────────────────
const ingressPanel = document.getElementById('ingress-panel');

function closeIngressPanel() {
  ingressPanel.style.display = 'none';
  ingressPanel.innerHTML = '';
}

canvas.addEventListener('click', (e) => {
  // Close if already open
  if (ingressPanel.style.display === 'block') {
    closeIngressPanel();
  }

  const mouse = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(mouse, activeCamera());

  const archMeshes = [];
  scene.traverse((obj) => {
    if (obj.isMesh && obj.userData.type === 'ingressArch') archMeshes.push(obj);
  });
  const hits = ray.intersectObjects(archMeshes);
  if (hits.length === 0) return;

  const data = hits[0].object.userData;
  if (!data.namespace) return;

  const nsIngresses = data.ingresses || state.ingresses.filter(i => i.namespace === data.namespace);

  let html = `<div class="ing-header">Routes — ns/${data.namespace} (${nsIngresses.length} ingresses)</div>`;
  for (const ni of nsIngresses) {
    for (const rule of ni.rules || []) {
      const host = rule.host || '—';
      const path = rule.path && rule.path !== '/' ? rule.path : '/';
      const url = rule.host ? 'https://' + rule.host + (rule.path || '') : '';
      html += `<div class="ing-route" ${url ? `data-url="${url}"` : ''}>`;
      html += `<div>${ni.name}</div>`;
      html += `<div>${host}${path}</div>`;
      if (rule.serviceName) html += `<div class="ing-svc">→ svc/${rule.serviceName}${rule.servicePort ? ':' + rule.servicePort : ''}</div>`;
      html += `</div>`;
    }
  }

  ingressPanel.innerHTML = html;
  ingressPanel.style.left = Math.min(e.clientX, window.innerWidth - 320) + 'px';
  ingressPanel.style.top = e.clientY + 'px';
  ingressPanel.style.display = 'block';

  // Click on a route to open its URL
  ingressPanel.querySelectorAll('.ing-route[data-url]').forEach(el => {
    el.addEventListener('click', () => {
      window.open(el.dataset.url, '_blank');
    });
  });

  e.stopPropagation();
});

// Close ingress panel on Escape or click outside
document.addEventListener('click', (e) => {
  if (ingressPanel.style.display === 'block' && !ingressPanel.contains(e.target)) {
    closeIngressPanel();
  }
});

// Keyboard shortcuts when menu is open
document.addEventListener('keydown', (e) => {
  // Kill confirm dialog
  if (killConfirm.style.display === 'block') {
    if (e.key === 'y' || e.key === 'Y') { doKillPod(); return; }
    if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') { closeKillConfirm(); return; }
    return;
  }

  // Ingress panel
  if (ingressPanel.style.display === 'block') {
    if (e.key === 'Escape') { closeIngressPanel(); return; }
  }

  // Workload edit panel
  if (wlEditPanel.style.display === 'block') {
    if (e.key === 'Escape') { closeWorkloadEdit(); return; }
  }

  // Output panel
  if (outputPanel.style.display === 'flex') {
    if (e.key === 'Escape') { closeOutputPanel(); return; }
  }

  // Service menu shortcuts — D/E keep menu open, Escape closes it
  if (svcMenu.style.display === 'block' && selectedService) {
    if (e.key === 'd' || e.key === 'D') { doServiceDescribe(selectedService); return; }
    if (e.key === 'e' || e.key === 'E') { doServiceEndpoints(selectedService); return; }
    if (e.key === 'Escape') { closeSvcMenu(); closeOutputPanel(); return; }
  }

  // Pod menu shortcuts — D/L keep menu open, K/Escape close it
  if (podMenu.style.display === 'block' && selectedPod) {
    if (e.key === 'd' || e.key === 'D') { doPodDescribe(selectedPod); setActiveMenuItem('pod-menu-describe'); repositionPodMenu(); return; }
    if (e.key === 'l' || e.key === 'L') { doPodLogs(selectedPod); setActiveMenuItem('pod-menu-logs'); repositionPodMenu(); return; }
    if (e.key === 'k' || e.key === 'K') { showKillConfirm(selectedPod); closePodMenu(); return; }
    if (e.key === 'o' || e.key === 'O') {
      const openUrlItem = document.getElementById('pod-menu-open-url');
      if (openUrlItem.style.display !== 'none') {
        const urls = JSON.parse(openUrlItem.dataset.urls || '[]');
        for (const url of urls) window.open(url, '_blank');
      }
      return;
    }
    if (e.key === 'Escape') { closePodMenu(); closeOutputPanel(); return; }
  }
});

// Close output panel
outputClose.addEventListener('click', closeOutputPanel);

async function doPodDescribe(pod) {
  closeOutputPanel();
  outputTitle.textContent = `DESCRIBE  ${pod.namespace}/${pod.name}`;
  outputBody.textContent = 'Loading...';
  outputPanel.style.display = 'flex';

  try {
    const resp = await fetch(`/api/pod/describe?namespace=${encodeURIComponent(pod.namespace)}&name=${encodeURIComponent(pod.name)}`);
    if (!resp.ok) throw new Error(await resp.text());
    const desc = await resp.json();

    let out = '';
    out += `Name:       ${desc.name}\n`;
    out += `Namespace:  ${desc.namespace}\n`;
    out += `Node:       ${desc.node}\n`;
    out += `Status:     ${desc.status}\n`;
    out += `IP:         ${desc.ip}\n`;
    if (desc.startTime) out += `Start Time: ${desc.startTime}\n`;
    if (desc.labels && Object.keys(desc.labels).length) {
      out += `Labels:\n`;
      for (const [k, v] of Object.entries(desc.labels)) {
        out += `  ${k}=${v}\n`;
      }
    }
    out += `\n--- CONTAINERS ---\n`;
    for (const c of (desc.containers || [])) {
      out += `\n  ${c.name}\n`;
      out += `    Image:    ${c.image}\n`;
      out += `    Ready:    ${c.ready}\n`;
      out += `    Restarts: ${c.restartCount}\n`;
      out += `    State:    ${c.state}${c.reason ? ' (' + c.reason + ')' : ''}\n`;
    }
    out += `\n--- CONDITIONS ---\n`;
    for (const cond of (desc.conditions || [])) {
      out += `  ${cond}\n`;
    }
    if (desc.events && desc.events.length) {
      out += `\n--- EVENTS ---\n`;
      for (const ev of desc.events) {
        out += `  ${ev}\n`;
      }
    }

    // Resolve URLs for this pod
    const urls = podURLs({ ...pod, labels: desc.labels });
    if (urls.length) {
      out += `\n--- URLS ---\n`;
      for (const u of urls) {
        out += `  ${u}\n`;
      }
    }

    // Render with clickable URLs
    const escaped = out.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const withLinks = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" style="color:#ffaa00;text-decoration:underline;pointer-events:auto;cursor:pointer">$1</a>');
    outputBody.innerHTML = withLinks;
  } catch (err) {
    outputBody.textContent = `ERROR: ${err.message}`;
  }
}

async function doPodLogs(pod) {
  closeOutputPanel();
  if (logAbort) logAbort.abort();
  logAbort = new AbortController();

  outputTitle.textContent = `LOGS  ${pod.namespace}/${pod.name}  (streaming)`;
  outputBody.textContent = '';
  outputPanel.style.display = 'flex';

  try {
    const resp = await fetch(
      `/api/pod/logs?namespace=${encodeURIComponent(pod.namespace)}&name=${encodeURIComponent(pod.name)}`,
      { signal: logAbort.signal },
    );
    if (!resp.ok) throw new Error(await resp.text());

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      // Parse SSE lines
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          outputBody.textContent += line.slice(6) + '\n';
          // Auto-scroll to bottom
          outputBody.scrollTop = outputBody.scrollHeight;
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      outputBody.textContent += `\n--- ERROR: ${err.message} ---\n`;
    }
  }
}

let pendingKillPod = null;

function showKillConfirm(pod) {
  pendingKillPod = pod;
  killPodName.textContent = `${pod.namespace}/${pod.name}`;
  killConfirm.style.display = 'block';
}

killYes.addEventListener('click', doKillPod);
killNo.addEventListener('click', closeKillConfirm);

async function doKillPod() {
  if (!pendingKillPod) return;
  const pod = pendingKillPod;
  closeKillConfirm();

  closeOutputPanel();
  outputTitle.textContent = `KILL  ${pod.namespace}/${pod.name}`;
  outputBody.textContent = 'Deleting pod...';
  outputPanel.style.display = 'flex';

  try {
    const resp = await fetch(
      `/api/pod/delete?namespace=${encodeURIComponent(pod.namespace)}&name=${encodeURIComponent(pod.name)}`,
      { method: 'DELETE' },
    );
    if (!resp.ok) throw new Error(await resp.text());
    const result = await resp.json();
    outputBody.textContent = `Pod ${result.namespace}/${result.pod} deleted successfully.`;
  } catch (err) {
    outputBody.textContent = `ERROR: ${err.message}`;
  }
  pendingKillPod = null;
}

// ── Workload Edit Panel ────────────────────────────────────────
const wlEditPanel = document.getElementById('wl-edit-panel');
const wlEditTitle = document.getElementById('wl-edit-title');
const wlReplicaVal = document.getElementById('wl-replica-val');
const wlReadyVal = document.getElementById('wl-ready-val');
const wlContainers = document.getElementById('wl-containers');
const wlEditStatus = document.getElementById('wl-edit-status');

let editingWorkload = null;

function closeWorkloadEdit() {
  wlEditPanel.style.display = 'none';
  editingWorkload = null;
  wlEditStatus.style.display = 'none';
}

function showWlStatus(msg, isError) {
  wlEditStatus.textContent = msg;
  wlEditStatus.className = isError ? 'error' : 'success';
  wlEditStatus.style.display = 'block';
  if (!isError) setTimeout(() => { wlEditStatus.style.display = 'none'; }, 3000);
}

// ── Friendly cron schedule helpers ──────────────────────────────
const CRON_PRESETS = [
  { label: 'Every minute',      cron: '* * * * *' },
  { label: 'Every 5 minutes',   cron: '*/5 * * * *' },
  { label: 'Every 15 minutes',  cron: '*/15 * * * *' },
  { label: 'Every 30 minutes',  cron: '*/30 * * * *' },
  { label: 'Every hour',        cron: '0 * * * *' },
  { label: 'Every 6 hours',     cron: '0 */6 * * *' },
  { label: 'Every 12 hours',    cron: '0 */12 * * *' },
  { label: 'Daily at midnight', cron: '0 0 * * *' },
  { label: 'Daily at 6:00',     cron: '0 6 * * *' },
  { label: 'Weekly (Mon 00:00)',cron: '0 0 * * 1' },
  { label: 'Monthly (1st 00:00)',cron: '0 0 1 * *' },
];

function cronToHuman(cron) {
  if (!cron) return '?';
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;
  const [min, hour, dom, mon, dow] = parts;

  // Check presets first
  for (const p of CRON_PRESETS) {
    if (p.cron === cron.trim()) return p.label;
  }

  // Build a rough human description
  let desc = '';
  if (min === '*' && hour === '*') desc = 'Every minute';
  else if (min.startsWith('*/') && hour === '*') desc = `Every ${min.slice(2)} min`;
  else if (hour.startsWith('*/') && min === '0') desc = `Every ${hour.slice(2)}h`;
  else if (hour !== '*' && min !== '*') desc = `At ${hour.padStart(2,'0')}:${min.padStart(2,'0')}`;
  else desc = cron;

  if (dom !== '*') desc += ` on day ${dom}`;
  if (mon !== '*') desc += ` in month ${mon}`;
  if (dow !== '*') {
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const d = parseInt(dow, 10);
    desc += ` on ${days[d] || dow}`;
  }
  return desc;
}

function renderCronEditor(schedule) {
  let html = '<div class="wl-section-title">SCHEDULE</div>';
  // Human-readable display
  html += `<div style="font-size:16px;font-weight:bold;color:#ffaa00;margin-bottom:8px">${cronToHuman(schedule)}</div>`;
  // Editable cron expression
  html += `<div class="wl-res-grid" style="grid-template-columns:1fr;margin-bottom:10px">`;
  html += `<div class="wl-res-field"><label>CRON EXPRESSION</label><input type="text" id="wl-cron-input" value="${schedule || ''}" style="font-size:14px;color:#ffaa00;border-color:rgba(255,170,0,0.3)"></div>`;
  html += `</div>`;
  // Preset buttons
  html += `<div class="wl-section-title">QUICK PRESETS</div>`;
  html += `<div style="display:flex;flex-wrap:wrap;gap:4px">`;
  for (const p of CRON_PRESETS) {
    const active = p.cron === schedule?.trim();
    html += `<button class="wl-cron-preset" data-cron="${p.cron}" style="padding:3px 8px;font-size:10px;border:1px solid ${active ? '#ffaa00' : 'rgba(255,170,0,0.3)'};background:${active ? 'rgba(255,170,0,0.15)' : 'transparent'};color:#ffaa00;font-family:inherit;cursor:pointer">${p.label}</button>`;
  }
  html += `</div>`;
  return html;
}

async function openWorkloadEdit(wl) {
  closeWorkloadEdit();
  editingWorkload = { ...wl };

  const WL_ABBREV = { Deployment: 'deploy', StatefulSet: 'sts', DaemonSet: 'ds', CronJob: 'cj', Job: 'job' };
  const abbrev = WL_ABBREV[wl.kind] || wl.kind.toLowerCase();
  wlEditTitle.textContent = `${abbrev}/${wl.name}`;

  // Show/hide sections based on kind
  const replicaSection = wlReplicaVal.closest('.wl-section');
  const actionsDiv = document.querySelector('#wl-edit-panel .wl-actions');
  const applyBtn = document.getElementById('wl-apply-btn');
  const restartBtn = document.getElementById('wl-restart-btn');
  const scaleZeroBtn = document.getElementById('wl-scale-zero-btn');

  const isCronJob = wl.kind === 'CronJob';
  const isJob = wl.kind === 'Job';
  const isDaemonSet = wl.kind === 'DaemonSet';

  // Replicas section: hide for CronJob/Job, show for others
  replicaSection.style.display = (isCronJob || isJob) ? 'none' : '';
  // Scale to 0: hide for CronJob/Job/DaemonSet
  scaleZeroBtn.style.display = (isCronJob || isJob || isDaemonSet) ? 'none' : '';
  // Restart: available for Deployment/StatefulSet/DaemonSet
  restartBtn.style.display = (isCronJob || isJob) ? 'none' : '';

  if (!isCronJob && !isJob) {
    wlReplicaVal.textContent = wl.replicas || 0;
    wlReadyVal.textContent = wl.readyReplicas || 0;
  }

  wlContainers.innerHTML = '<div style="opacity:0.5">Loading...</div>';
  wlEditPanel.style.display = 'block';

  // Fetch full details
  try {
    const resp = await fetch(`/api/workload/describe?namespace=${encodeURIComponent(wl.namespace)}&name=${encodeURIComponent(wl.name)}&kind=${encodeURIComponent(wl.kind)}`);
    if (!resp.ok) throw new Error(await resp.text());
    const desc = await resp.json();

    editingWorkload.replicas = desc.replicas;
    editingWorkload.containers = desc.containers;
    editingWorkload.schedule = desc.schedule;
    editingWorkload.suspended = desc.suspended;

    if (!isCronJob && !isJob) {
      wlReplicaVal.textContent = desc.replicas;
      wlReadyVal.textContent = desc.readyReplicas;
    }

    let html = '';

    // CronJob: schedule editor + suspend/trigger buttons
    if (isCronJob) {
      html += `<div style="padding:0 0 8px 0">${renderCronEditor(desc.schedule)}</div>`;

      // Suspend status + toggle
      html += `<div style="margin:8px 0;display:flex;align-items:center;gap:10px">`;
      html += `<span style="font-size:12px;opacity:0.6">STATUS:</span>`;
      html += `<span style="color:${desc.suspended ? '#ff4444' : '#00ff88'};font-weight:bold">${desc.suspended ? 'SUSPENDED' : 'ACTIVE'}</span>`;
      html += `<button id="wl-cj-suspend" class="wl-action-btn ${desc.suspended ? '' : 'warn'}" style="font-size:11px;padding:3px 10px">${desc.suspended ? 'RESUME' : 'SUSPEND'}</button>`;
      html += `<button id="wl-cj-trigger" class="wl-action-btn" style="font-size:11px;padding:3px 10px;color:#00aaff;border-color:#00aaff">TRIGGER NOW</button>`;
      html += `</div>`;

      if (desc.lastSchedule) {
        const ago = ((Date.now() - new Date(desc.lastSchedule).getTime()) / 1000 / 60).toFixed(0);
        html += `<div style="font-size:11px;opacity:0.5;margin-bottom:6px">Last scheduled: ${ago}min ago (${desc.activeJobs} active jobs)</div>`;
      }

      // Change Apply to "Save Schedule" for CronJobs
      applyBtn.textContent = 'SAVE SCHEDULE';
    } else {
      applyBtn.textContent = 'APPLY';
    }

    // Container resource fields (for all kinds)
    if (desc.containers && desc.containers.length > 0) {
      html += `<div class="wl-section-title" style="margin-top:8px">CONTAINER RESOURCES</div>`;
      for (const c of desc.containers) {
        html += `<div class="wl-container" data-container="${c.name}">`;
        html += `<div class="wl-container-name">${c.name}</div>`;
        html += `<div class="wl-res-grid">`;
        html += `<div class="wl-res-field"><label>CPU REQ</label><input type="text" data-field="cpuRequest" value="${c.cpuRequest || ''}"></div>`;
        html += `<div class="wl-res-field"><label>CPU LIM</label><input type="text" data-field="cpuLimit" value="${c.cpuLimit || ''}"></div>`;
        html += `<div class="wl-res-field"><label>MEM REQ</label><input type="text" data-field="memoryRequest" value="${c.memoryRequest || ''}"></div>`;
        html += `<div class="wl-res-field"><label>MEM LIM</label><input type="text" data-field="memoryLimit" value="${c.memoryLimit || ''}"></div>`;
        html += `</div></div>`;
      }
    }

    wlContainers.innerHTML = html;

    // Wire up CronJob-specific buttons
    if (isCronJob) {
      // Preset buttons
      wlContainers.querySelectorAll('.wl-cron-preset').forEach(btn => {
        btn.addEventListener('click', () => {
          const cronInput = document.getElementById('wl-cron-input');
          if (cronInput) cronInput.value = btn.dataset.cron;
          // Update all preset highlights
          wlContainers.querySelectorAll('.wl-cron-preset').forEach(b => {
            b.style.borderColor = b.dataset.cron === btn.dataset.cron ? '#ffaa00' : 'rgba(255,170,0,0.3)';
            b.style.background = b.dataset.cron === btn.dataset.cron ? 'rgba(255,170,0,0.15)' : 'transparent';
          });
        });
      });

      // Suspend/Resume
      const suspendBtn = document.getElementById('wl-cj-suspend');
      if (suspendBtn) {
        suspendBtn.addEventListener('click', async () => {
          try {
            const newSuspended = !editingWorkload.suspended;
            const resp = await fetch('/api/cronjob/suspend', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ namespace: wl.namespace, name: wl.name, suspended: newSuspended }),
            });
            if (!resp.ok) throw new Error(await resp.text());
            editingWorkload.suspended = newSuspended;
            showWlStatus(newSuspended ? 'CronJob suspended' : 'CronJob resumed', false);
            // Refresh panel
            openWorkloadEdit(editingWorkload);
          } catch (err) {
            showWlStatus(`Error: ${err.message}`, true);
          }
        });
      }

      // Trigger now
      const triggerBtn = document.getElementById('wl-cj-trigger');
      if (triggerBtn) {
        triggerBtn.addEventListener('click', async () => {
          try {
            const resp = await fetch('/api/cronjob/trigger', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ namespace: wl.namespace, name: wl.name }),
            });
            if (!resp.ok) throw new Error(await resp.text());
            const result = await resp.json();
            showWlStatus(`Job ${result.job} triggered`, false);
          } catch (err) {
            showWlStatus(`Error: ${err.message}`, true);
          }
        });
      }
    }
  } catch (err) {
    wlContainers.innerHTML = `<div style="color:#ff4444">Failed: ${err.message}</div>`;
  }
}

// Replica +/- buttons
document.getElementById('wl-replica-minus').addEventListener('click', () => {
  if (!editingWorkload) return;
  const cur = parseInt(wlReplicaVal.textContent, 10);
  if (cur > 0) wlReplicaVal.textContent = cur - 1;
});
document.getElementById('wl-replica-plus').addEventListener('click', () => {
  if (!editingWorkload) return;
  const cur = parseInt(wlReplicaVal.textContent, 10);
  wlReplicaVal.textContent = cur + 1;
});

// Apply button — handles both scale/resources AND cronjob schedule
document.getElementById('wl-apply-btn').addEventListener('click', async () => {
  if (!editingWorkload) return;
  const wl = editingWorkload;

  try {
    // CronJob: save schedule
    if (wl.kind === 'CronJob') {
      const cronInput = document.getElementById('wl-cron-input');
      const newSchedule = cronInput ? cronInput.value.trim() : '';
      if (newSchedule && newSchedule !== wl.schedule) {
        const resp = await fetch('/api/cronjob/schedule', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ namespace: wl.namespace, name: wl.name, schedule: newSchedule }),
        });
        if (!resp.ok) throw new Error(await resp.text());
        editingWorkload.schedule = newSchedule;
      }
      showWlStatus('Schedule saved', false);
      return;
    }

    // Scale if changed (Deployment/StatefulSet)
    const newReplicas = parseInt(wlReplicaVal.textContent, 10);
    if (newReplicas !== wl.replicas && wl.kind !== 'Job' && wl.kind !== 'DaemonSet') {
      const resp = await fetch('/api/workload/scale', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace: wl.namespace, name: wl.name, kind: wl.kind, replicas: newReplicas }),
      });
      if (!resp.ok) throw new Error(await resp.text());
    }

    // Collect container resources from inputs
    const containerEls = wlContainers.querySelectorAll('.wl-container');
    if (containerEls.length > 0) {
      const containers = [];
      let changed = false;
      containerEls.forEach(el => {
        const name = el.dataset.container;
        const orig = wl.containers?.find(c => c.name === name);
        const c = { name };
        for (const field of ['cpuRequest', 'cpuLimit', 'memoryRequest', 'memoryLimit']) {
          const input = el.querySelector(`input[data-field="${field}"]`);
          c[field] = input ? input.value.trim() : '';
          if (orig && c[field] !== (orig[field] || '')) changed = true;
        }
        containers.push(c);
      });

      if (changed) {
        const resp = await fetch('/api/workload/resources', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ namespace: wl.namespace, name: wl.name, kind: wl.kind, containers }),
        });
        if (!resp.ok) throw new Error(await resp.text());
      }
    }

    showWlStatus('Applied successfully', false);
    editingWorkload.replicas = newReplicas;
  } catch (err) {
    showWlStatus(`Error: ${err.message}`, true);
  }
});

// Restart button
document.getElementById('wl-restart-btn').addEventListener('click', async () => {
  if (!editingWorkload) return;
  const wl = editingWorkload;
  try {
    const resp = await fetch('/api/workload/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: wl.namespace, name: wl.name, kind: wl.kind }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    showWlStatus('Rolling restart initiated', false);
  } catch (err) {
    showWlStatus(`Error: ${err.message}`, true);
  }
});

// Scale to 0 button
document.getElementById('wl-scale-zero-btn').addEventListener('click', async () => {
  if (!editingWorkload) return;
  const wl = editingWorkload;
  try {
    const resp = await fetch('/api/workload/scale', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace: wl.namespace, name: wl.name, kind: wl.kind, replicas: 0 }),
    });
    if (!resp.ok) throw new Error(await resp.text());
    wlReplicaVal.textContent = '0';
    editingWorkload.replicas = 0;
    showWlStatus('Scaled to 0', false);
  } catch (err) {
    showWlStatus(`Error: ${err.message}`, true);
  }
});

// Close workload edit panel
document.getElementById('wl-edit-close').addEventListener('click', closeWorkloadEdit);

// ── Resize ─────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  updateOrthoFrustum();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ── Animation Loop ─────────────────────────────────────────────
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  const time = clock.getElapsedTime();

  updateCamera(dt);
  updateRaycast();
  updateSpotlight(dt);
  animatePods(time);
  updateDepthTransparency();
  updateBillboards();

  // Slowly rotate point light
  pointLight.position.x = Math.sin(time * 0.3) * 20;
  pointLight.position.z = Math.cos(time * 0.3) * 20;

  composer.render();
}

// ── Boot ───────────────────────────────────────────────────────
animate();
connectWS();

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

// ── Resource Sizing ────────────────────────────────────────────
// CPU: 100m → POD_MIN_SIZE, 2000m+ → POD_MAX_SIZE
// Memory: 64Mi → POD_MIN_SIZE, 2Gi+ → POD_MAX_SIZE
const CPU_MIN = 100;
const CPU_MAX = 2000;
const MEM_MIN = 64 * 1024 * 1024;
const MEM_MAX = 2 * 1024 * 1024 * 1024;

export {
  state,
  layers,
  PLATFORM_GAP,
  POD_BASE_SIZE,
  POD_MIN_SIZE,
  POD_MAX_SIZE,
  POD_GAP,
  POD_STRIDE,
  PLATFORM_Y,
  PLATFORM_HEIGHT,
  LABEL_Y_OFFSET,
  NODE_BLOCK_SIZE,
  WORKLOAD_Y,
  WORKLOAD_BOX_HEIGHT,
  PVC_Y,
  POD_Y_OFFSET,
  STATUS_COLORS,
  CPU_MIN,
  CPU_MAX,
  MEM_MIN,
  MEM_MAX,
};

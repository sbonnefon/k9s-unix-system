import * as THREE from 'three';
import { scene, activeCamera } from '../core/scene.js';
import { state } from '../core/state.js';
import { canvas } from '../core/scene.js';

// ── Ingress arch click -> route list panel ──────────────────────
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

// Close ingress panel on click outside
document.addEventListener('click', (e) => {
  if (ingressPanel.style.display === 'block' && !ingressPanel.contains(e.target)) {
    closeIngressPanel();
  }
});

export {
  ingressPanel,
  closeIngressPanel,
};

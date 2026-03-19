import { closeOutputPanel, outputPanel, outputTitle, outputBody } from './pod-menu.js';

// ── Service Actions (double-click menu) ─────────────────────────
const svcMenu = document.getElementById('svc-menu');
const svcMenuTitle = document.getElementById('svc-menu-title');

// Shared mutable ref for selectedService so pod-menu.js dblclick handler can set it
const selectedServiceRef = { value: null };

function closeSvcMenu() {
  svcMenu.style.display = 'none';
  selectedServiceRef.value = null;
}

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

document.getElementById('svc-menu-describe').addEventListener('click', () => {
  if (selectedServiceRef.value) { doServiceDescribe(selectedServiceRef.value); }
});
document.getElementById('svc-menu-endpoints').addEventListener('click', () => {
  if (selectedServiceRef.value) { doServiceEndpoints(selectedServiceRef.value); }
});

export {
  svcMenu,
  svcMenuTitle,
  selectedServiceRef,
  closeSvcMenu,
  doServiceDescribe,
  doServiceEndpoints,
  doServicePortForward,
};

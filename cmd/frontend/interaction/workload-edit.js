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

  for (const p of CRON_PRESETS) {
    if (p.cron === cron.trim()) return p.label;
  }

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
  html += `<div style="font-size:16px;font-weight:bold;color:#ffaa00;margin-bottom:8px">${cronToHuman(schedule)}</div>`;
  html += `<div class="wl-res-grid" style="grid-template-columns:1fr;margin-bottom:10px">`;
  html += `<div class="wl-res-field"><label>CRON EXPRESSION</label><input type="text" id="wl-cron-input" value="${schedule || ''}" style="font-size:14px;color:#ffaa00;border-color:rgba(255,170,0,0.3)"></div>`;
  html += `</div>`;
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

  const replicaSection = wlReplicaVal.closest('.wl-section');
  const applyBtn = document.getElementById('wl-apply-btn');
  const restartBtn = document.getElementById('wl-restart-btn');
  const scaleZeroBtn = document.getElementById('wl-scale-zero-btn');

  const isCronJob = wl.kind === 'CronJob';
  const isJob = wl.kind === 'Job';
  const isDaemonSet = wl.kind === 'DaemonSet';

  replicaSection.style.display = (isCronJob || isJob) ? 'none' : '';
  scaleZeroBtn.style.display = (isCronJob || isJob || isDaemonSet) ? 'none' : '';
  restartBtn.style.display = (isCronJob || isJob) ? 'none' : '';

  if (!isCronJob && !isJob) {
    wlReplicaVal.textContent = wl.replicas || 0;
    wlReadyVal.textContent = wl.readyReplicas || 0;
  }

  wlContainers.innerHTML = '<div style="opacity:0.5">Loading...</div>';
  wlEditPanel.style.display = 'block';

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

    if (isCronJob) {
      html += `<div style="padding:0 0 8px 0">${renderCronEditor(desc.schedule)}</div>`;
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

      applyBtn.textContent = 'SAVE SCHEDULE';
    } else {
      applyBtn.textContent = 'APPLY';
    }

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

    if (isCronJob) {
      wlContainers.querySelectorAll('.wl-cron-preset').forEach(btn => {
        btn.addEventListener('click', () => {
          const cronInput = document.getElementById('wl-cron-input');
          if (cronInput) cronInput.value = btn.dataset.cron;
          wlContainers.querySelectorAll('.wl-cron-preset').forEach(b => {
            b.style.borderColor = b.dataset.cron === btn.dataset.cron ? '#ffaa00' : 'rgba(255,170,0,0.3)';
            b.style.background = b.dataset.cron === btn.dataset.cron ? 'rgba(255,170,0,0.15)' : 'transparent';
          });
        });
      });

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
            openWorkloadEdit(editingWorkload);
          } catch (err) {
            showWlStatus(`Error: ${err.message}`, true);
          }
        });
      }

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

// Apply button
document.getElementById('wl-apply-btn').addEventListener('click', async () => {
  if (!editingWorkload) return;
  const wl = editingWorkload;

  try {
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

    const newReplicas = parseInt(wlReplicaVal.textContent, 10);
    if (newReplicas !== wl.replicas && wl.kind !== 'Job' && wl.kind !== 'DaemonSet') {
      const resp = await fetch('/api/workload/scale', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namespace: wl.namespace, name: wl.name, kind: wl.kind, replicas: newReplicas }),
      });
      if (!resp.ok) throw new Error(await resp.text());
    }

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

export {
  wlEditPanel,
  closeWorkloadEdit,
  openWorkloadEdit,
  CRON_PRESETS,
  cronToHuman,
};

// ── Resource Actions (ConfigMap view/edit) ──────────────────────
const resourceMenu = document.getElementById('resource-menu');
const resourceMenuTitle = document.getElementById('resource-menu-title');
const resourceEditPanel = document.getElementById('resource-edit-panel');
const resourceEditTitle = document.getElementById('resource-edit-title');
const resourceEditBody = document.getElementById('resource-edit-body');
const resourceEditClose = document.getElementById('resource-edit-close');
const resourceEditStatus = document.getElementById('resource-edit-status');
const resourceSaveBtn = document.getElementById('resource-save-btn');

const outputPanel = document.getElementById('output-panel');
const outputTitle = document.getElementById('output-title');
const outputBody = document.getElementById('output-body');

let selectedResource = null;

function openResourceMenu(res, x, y) {
  selectedResource = res;
  resourceMenuTitle.textContent = `${res.kind}/${res.name}`;
  resourceMenu.style.left = x + 'px';
  resourceMenu.style.top = y + 'px';
  resourceMenu.style.display = 'block';
}

function closeResourceMenu() {
  resourceMenu.style.display = 'none';
  selectedResource = null;
}

async function doResourceDescribe(res) {
  const target = res || selectedResource;
  if (!target) return;
  closeResourceMenu();

  outputTitle.textContent = `DESCRIBE  ${target.namespace}/${target.name}`;
  outputBody.textContent = 'Loading...';
  outputPanel.style.display = 'flex';

  try {
    const resp = await fetch(
      `/api/resource/describe?namespace=${encodeURIComponent(target.namespace)}&name=${encodeURIComponent(target.name)}&kind=${encodeURIComponent(target.kind)}`
    );
    if (!resp.ok) throw new Error(await resp.text());
    const desc = await resp.json();

    let out = '';
    out += `Name:      ${desc.name}\n`;
    out += `Namespace: ${desc.namespace}\n`;
    out += `Kind:      ${desc.kind}\n`;
    out += `\n--- DATA ---\n`;
    if (desc.data) {
      for (const [k, v] of Object.entries(desc.data)) {
        if (v.includes('\n')) {
          out += `${k}:\n`;
          for (const line of v.split('\n')) {
            out += `  ${line}\n`;
          }
        } else {
          out += `${k}: ${v}\n`;
        }
      }
    }
    outputBody.textContent = out;
  } catch (err) {
    outputBody.textContent = `ERROR: ${err.message}`;
  }
}

async function openResourceEdit(res) {
  const target = res || selectedResource;
  if (!target) return;
  closeResourceMenu();

  resourceEditTitle.textContent = `EDIT ${target.kind}/${target.name}`;
  resourceEditBody.innerHTML = '<div style="opacity:0.5">Loading...</div>';
  resourceEditStatus.style.display = 'none';
  resourceEditPanel.style.display = 'block';

  try {
    const resp = await fetch(
      `/api/resource/describe?namespace=${encodeURIComponent(target.namespace)}&name=${encodeURIComponent(target.name)}&kind=${encodeURIComponent(target.kind)}`
    );
    if (!resp.ok) throw new Error(await resp.text());
    const desc = await resp.json();

    resourceEditBody.innerHTML = '';
    const data = desc.data || {};
    for (const [k, v] of Object.entries(data)) {
      const label = document.createElement('div');
      label.className = 'resource-key-label';
      label.textContent = k;
      resourceEditBody.appendChild(label);

      const textarea = document.createElement('textarea');
      textarea.className = 'resource-value-input';
      textarea.dataset.key = k;
      textarea.value = v;
      resourceEditBody.appendChild(textarea);
    }

    // Wire save button
    resourceSaveBtn.onclick = async () => {
      const newData = {};
      resourceEditBody.querySelectorAll('.resource-value-input').forEach((ta) => {
        newData[ta.dataset.key] = ta.value;
      });

      resourceEditStatus.textContent = 'Saving...';
      resourceEditStatus.className = '';
      resourceEditStatus.style.display = 'block';

      try {
        const patchResp = await fetch('/api/resource/edit', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            namespace: target.namespace,
            name: target.name,
            kind: target.kind,
            data: newData,
          }),
        });
        if (!patchResp.ok) throw new Error(await patchResp.text());
        resourceEditStatus.textContent = 'Updated successfully';
        resourceEditStatus.className = 'success';
      } catch (err) {
        resourceEditStatus.textContent = `Error: ${err.message}`;
        resourceEditStatus.className = 'error';
      }
    };
  } catch (err) {
    resourceEditBody.innerHTML = `<div style="color:#ff4444">ERROR: ${err.message}</div>`;
  }
}

function closeResourceEdit() {
  resourceEditPanel.style.display = 'none';
  resourceEditBody.innerHTML = '';
  resourceEditStatus.style.display = 'none';
}

resourceEditClose.addEventListener('click', closeResourceEdit);

document.getElementById('resource-menu-view').addEventListener('click', () => {
  if (selectedResource) doResourceDescribe();
});
document.getElementById('resource-menu-edit').addEventListener('click', () => {
  if (selectedResource) openResourceEdit();
});

function getSelectedResource() {
  return selectedResource;
}

export {
  openResourceMenu,
  closeResourceMenu,
  doResourceDescribe,
  openResourceEdit,
  closeResourceEdit,
  getSelectedResource,
};

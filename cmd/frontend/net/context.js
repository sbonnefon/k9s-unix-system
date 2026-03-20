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
      await loadContexts();
    }
  } catch (e) {
    console.error('Context switch error:', e);
    await loadContexts();
  } finally {
    sel.disabled = false;
    switching.style.display = 'none';
  }
});

export { loadContexts };

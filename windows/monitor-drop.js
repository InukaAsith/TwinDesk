// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Monitor 2: drop files onto the Mac's screen. Paths come from the preload
// (webUtils.getPathForFile); main sends them; progress comes back for the little status line.
(function () {
  const api = window.monitor;
  const status = document.getElementById('drop-status');
  const playerI18n = window.PlayerI18n;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    document.body.classList.remove('dragging');
    if (!hasFiles(e)) return;
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => api.pathFor(f)).filter(Boolean);
    const p = window.monitorNorm ? window.monitorNorm(e) : null;
    if (paths.length) api.drop(paths, p ? p.x : null, p ? p.y : null);
  });

  let hideTimer = null;
  let lastProgress = null;
  const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  function renderProgress(v) {
    if (v.current) {
      const c = v.current;
      const pct = c.size ? Math.floor((c.sent / c.size) * 100) : 100;
      playerI18n.text(status, c.count > 1 ? 'Sending {name} ({index} of {count}), {percent}%  {sent} / {size}' : 'Sending {name}, {percent}%  {sent} / {size}', {
        name: c.name, index: c.index + 1, count: c.count, percent: pct, sent: mb(c.sent), size: mb(c.size),
      });
      status.className = '';
    } else if (v.last) {
      const text = v.last.messageKey ? playerI18n.t(v.last.messageKey, { name: v.peerName, Name: v.peerName, ...v.last.messageVars }) : v.last.text;
      const name = v.last.itemCount > 1 ? playerI18n.t('{count} items', { count: v.last.itemCount }) : v.last.name;
      playerI18n.literal(status, (name ? name + ': ' : '') + text);
      status.className = v.last.ok ? 'ok' : 'bad';
    }
  }
  playerI18n.onChange(() => {
    if (lastProgress && !status.classList.contains('hidden')) renderProgress(lastProgress);
  });
  api.onDropProgress((v) => {
    clearTimeout(hideTimer);
    lastProgress = v;
    renderProgress(v);
    if (!v.current && v.last) hideTimer = setTimeout(() => { status.className = 'hidden'; }, 6000);
  });
})();

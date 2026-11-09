// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Monitor 2 input: mouse, wheel and keys over the drawn video rectangle → in.* (normalized 0–1).
// F9/F11 are handled in main (before-input-event) and never reach this page.
(function () {
  const P = window.MacShareProtocol;
  const T = P.T;
  const api = window.monitor;
  const video = document.getElementById('video');
  const test = new URLSearchParams(location.search).get('test') === '1';

  // DOM MouseEvent.button → P.BUTTON
  const BUTTONS = { 0: P.BUTTON.LEFT, 1: P.BUTTON.MIDDLE, 2: P.BUTTON.RIGHT, 3: P.BUTTON.BACK, 4: P.BUTTON.FORWARD };
  const LINE_PX = 40;

  const heldKeys = new Set();
  const heldButtons = new Set(); // P.BUTTON values
  let pendingMove = null;
  let lastPos = { x: 0.5, y: 0.5 }; // last position sent, for the release on blur
  let rafQueued = false;
  let enabled = true; // false while the Mac's "Receive input" is off: no capture, nothing sent

  function send(m) {
    if (test) return;
    api.send(m);
  }

  // The rectangle the video is drawn in (object-fit: contain letterboxes it).
  function drawnRect() {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !r.width || !r.height) return null;
    const scale = Math.min(r.width / vw, r.height / vh);
    const w = vw * scale, h = vh * scale;
    return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
  }

  // Normalized position, or null outside the picture (unless clamping for a drag/release).
  function norm(e, clamp) {
    const r = drawnRect();
    if (!r) return null;
    let x = (e.clientX - r.x) / r.w;
    let y = (e.clientY - r.y) / r.h;
    const inside = x >= 0 && x <= 1 && y >= 0 && y <= 1;
    if (!inside && !clamp) return null;
    x = Math.min(1, Math.max(0, x));
    y = Math.min(1, Math.max(0, y));
    return { x, y };
  }

  window.monitorNorm = (e) => norm(e, false); // also used by monitor-drop.js
  // A pen: a pen on the Mac too (shared/viewer-pen.js).
  window.TDViewerPen.attach({ norm, send, enabled: () => enabled });
  window.monitorInputEnabled = () => enabled; // also used by monitor-apps.js

  function flushMove() {
    rafQueued = false;
    if (!pendingMove) return;
    send({ t: T.IN_MOVE, x: pendingMove.x, y: pendingMove.y });
    lastPos = pendingMove;
    pendingMove = null;
  }

  window.addEventListener('mousemove', (e) => {
    if (!enabled || window.TDViewerPen.recent()) return; // a pen's mouse: viewer-pen.js sent it
    const p = norm(e, heldButtons.size > 0);
    if (!p) return;
    pendingMove = p; // latest position wins
    if (!rafQueued) { rafQueued = true; requestAnimationFrame(flushMove); }
  });

  window.addEventListener('mousedown', (e) => {
    if (!enabled || window.TDViewerPen.recent()) return; // a pen's mouse: viewer-pen.js sent it
    e.preventDefault();
    const b = BUTTONS[e.button];
    const p = norm(e, false);
    if (b === undefined || !p) return;
    flushMove();
    heldButtons.add(b);
    lastPos = p;
    send({ t: T.IN_DOWN, x: p.x, y: p.y, b });
    if (test) console.log('[monitor] click at ' + p.x.toFixed(4) + ', ' + p.y.toFixed(4));
  });

  window.addEventListener('mouseup', (e) => {
    if (!enabled || window.TDViewerPen.recent()) return; // a pen's mouse: viewer-pen.js sent it
    e.preventDefault();
    const b = BUTTONS[e.button];
    if (b === undefined || !heldButtons.has(b)) return;
    const p = norm(e, true);
    if (!p) return;
    flushMove();
    heldButtons.delete(b);
    lastPos = p;
    send({ t: T.IN_UP, x: p.x, y: p.y, b });
  });

  window.addEventListener('contextmenu', (e) => e.preventDefault());
  // Back/forward buttons would otherwise navigate the page.
  window.addEventListener('auxclick', (e) => e.preventDefault());

  window.addEventListener('wheel', (e) => {
    if (!enabled) return;
    e.preventDefault();
    if (!norm(e, false)) return;
    const k = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? window.innerHeight : 1;
    const dx = e.deltaX * k, dy = e.deltaY * k;
    if (dx || dy) send({ t: T.IN_WHEEL, dx, dy });
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (!enabled) return;
    e.preventDefault(); // so Ctrl+W, Ctrl+R, Tab, Alt… reach the Mac
    if (!e.code) return;
    heldKeys.add(e.code);
    send({ t: T.IN_KEY_DOWN, code: e.code }); // repeats are sent as more key downs
  });

  window.addEventListener('keyup', (e) => {
    if (!enabled) return;
    e.preventDefault();
    if (!e.code) return;
    heldKeys.delete(e.code);
    send({ t: T.IN_KEY_UP, code: e.code });
  });

  // Release everything still held when the window loses focus (the Mac also releases on its side).
  window.addEventListener('blur', releaseAll);

  function releaseAll() {
    pendingMove = null;
    for (const code of heldKeys) send({ t: T.IN_KEY_UP, code });
    heldKeys.clear();
    for (const b of heldButtons) send({ t: T.IN_UP, x: lastPos.x, y: lastPos.y, b });
    heldButtons.clear();
  }

  api.onInputEnabled((on) => {
    if (on === enabled) return;
    enabled = on;
    // Off: the Mac already released everything it injected; just forget what we held.
    heldKeys.clear();
    heldButtons.clear();
    pendingMove = null;
    document.body.classList.toggle('input-off', !on);
  });
})();

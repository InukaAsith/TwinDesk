// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Mac app windows: one PC window per `app.windows` entry, opened from this renderer so
// it can show the same video stream, cropped to that window's rectangle. Input inside it is sent
// as in.* with coordinates mapped back to the whole picture. Closing it closes the Mac window.
(function () {
  const P = window.MacShareProtocol;
  const T = P.T;
  const api = window.monitor;
  const mainVideo = document.getElementById('video');
  const BUTTONS = { 0: P.BUTTON.LEFT, 1: P.BUTTON.MIDDLE, 2: P.BUTTON.RIGHT, 3: P.BUTTON.BACK, 4: P.BUTTON.FORWARD };
  const open = new Map(); // wid → entry
  const playerI18n = window.PlayerI18n;

  function title(e) {
    if (e.win.closed) return;
    playerI18n.literal(e.win.document.querySelector('title'), e.rect.title || playerI18n.t('Mac app'));
    e.win.document.documentElement.lang = playerI18n.locale;
  }
  playerI18n.onChange(() => { for (const e of open.values()) title(e); });

  const enabled = () => !window.monitorInputEnabled || window.monitorInputEnabled();
  const clamp = (v) => Math.min(1, Math.max(0, v));

  api.onAppWindows((list) => {
    const seen = new Set();
    for (const w of list) {
      seen.add(w.wid);
      let e = open.get(w.wid);
      if (!e || e.win.closed) {
        if (e) e.release();
        e = create(w);
      }
      if (!e) continue;
      e.rect = w;
      title(e);
      layout(e);
    }
    for (const [wid, e] of open) {
      if (seen.has(wid)) continue;
      e.release();
      e.closing = true; // gone on the Mac: close here without sending app.close
      open.delete(wid);
      if (!e.win.closed) e.win.close();
    }
  });

  api.onInputEnabled((on) => {
    if (on) return;
    for (const e of open.values()) {
      e.pending = null;
      e.keys.clear();
      e.buttons.clear();
    }
  });

  // A new session replaces the stream: point every app window at it.
  mainVideo.addEventListener('resize', () => { for (const e of open.values()) layout(e); }); // picture size changed
  mainVideo.addEventListener('loadedmetadata', () => {
    for (const e of open.values()) if (e.video.srcObject !== mainVideo.srcObject) { e.video.srcObject = mainVideo.srcObject; e.video.play().catch(() => {}); }
  });

  function create(w) {
    const win = window.open('about:blank', 'app-' + w.wid, 'width=800,height=600');
    if (!win) return null;
    const doc = win.document;
    doc.title = w.title || playerI18n.t('Mac app');
    const s = doc.body.style; // CSSOM only: the inherited CSP has no inline styles
    s.margin = '0'; s.overflow = 'hidden'; s.background = '#000'; s.cursor = 'none';
    doc.documentElement.style.height = '100%';
    const video = doc.createElement('video');
    video.muted = true; video.autoplay = true; video.playsInline = true;
    video.style.position = 'absolute'; video.style.objectFit = 'fill';
    video.srcObject = mainVideo.srcObject;
    doc.body.append(video);
    video.play().catch(() => {});
    const e = { wid: w.wid, win, video, rect: w, keys: new Set(), buttons: new Set(), pending: null, raf: false, last: { x: w.x, y: w.y } };
    open.set(w.wid, e);
    wire(e);
    return e;
  }

  // The video is scaled so the window's rectangle of the picture fits the window (centred, never
  // stretched); e.fit keeps the numbers for mapping input back.
  function layout(e) {
    if (e.win.closed) return;
    const r = e.rect, iw = e.win.innerWidth, ih = e.win.innerHeight;
    if (iw < 10 || ih < 10) { e.win.setTimeout(() => layout(e), 50); return; } // not sized yet
    const pw = mainVideo.videoWidth || 16, ph = mainVideo.videoHeight || 9; // picture size
    const cw = r.w * pw, ch = r.h * ph; // crop in picture pixels
    const s = Math.min(iw / cw, ih / ch);
    const ox = (iw - cw * s) / 2, oy = (ih - ch * s) / 2;
    e.fit = { s, ox, oy, cw, ch };
    const st = e.video.style;
    st.width = (pw * s) + 'px'; st.height = (ph * s) + 'px';
    st.left = (ox - r.x * pw * s) + 'px'; st.top = (oy - r.y * ph * s) + 'px';
  }

  function map(e, ev) {
    const r = e.rect, f = e.fit;
    if (!f) return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    return { x: clamp(r.x + ((ev.clientX - f.ox) / (f.cw * f.s)) * r.w), y: clamp(r.y + ((ev.clientY - f.oy) / (f.ch * f.s)) * r.h) };
  }

  function wire(e) {
    const w = e.win;
    const send = (m) => { if (enabled()) api.send(m); };
    const flushMove = () => {
      e.raf = false;
      if (!e.pending) return;
      send({ t: T.IN_MOVE, x: e.pending.x, y: e.pending.y });
      e.last = e.pending;
      e.pending = null;
    };
    e.release = () => {
      e.pending = null;
      for (const code of e.keys) send({ t: T.IN_KEY_UP, code });
      for (const b of e.buttons) send({ t: T.IN_UP, x: e.last.x, y: e.last.y, b });
      e.keys.clear(); e.buttons.clear();
    };
    w.addEventListener('resize', () => layout(e));
    w.addEventListener('focus', () => api.send({ t: T.APP_FOCUS, wid: e.wid }));
    w.addEventListener('unload', () => { // the user closed it on the PC
      e.release();
      if (open.get(e.wid) !== e) return;
      if (!e.closing) api.send({ t: T.APP_CLOSE, wid: e.wid });
      open.delete(e.wid);
    });
    w.addEventListener('mousemove', (ev) => {
      if (!enabled()) return;
      e.pending = map(e, ev);
      if (e.raf) return;
      e.raf = true;
      w.requestAnimationFrame(flushMove);
    });
    w.addEventListener('mousedown', (ev) => {
      if (!enabled()) return;
      ev.preventDefault();
      flushMove();
      const b = BUTTONS[ev.button];
      if (b === undefined) return;
      const p = map(e, ev);
      e.buttons.add(b); e.last = p;
      send({ t: T.IN_DOWN, x: p.x, y: p.y, b });
    });
    w.addEventListener('mouseup', (ev) => {
      if (!enabled()) return;
      ev.preventDefault();
      flushMove();
      const b = BUTTONS[ev.button];
      if (b === undefined || !e.buttons.has(b)) return;
      const p = map(e, ev);
      e.buttons.delete(b); e.last = p;
      send({ t: T.IN_UP, x: p.x, y: p.y, b });
    });
    w.addEventListener('contextmenu', (ev) => ev.preventDefault());
    w.addEventListener('auxclick', (ev) => ev.preventDefault());
    w.addEventListener('wheel', (ev) => {
      if (!enabled()) return;
      ev.preventDefault();
      flushMove();
      const k = ev.deltaMode === 1 ? 40 : ev.deltaMode === 2 ? w.innerHeight : 1;
      if (ev.deltaX || ev.deltaY) send({ t: T.IN_WHEEL, dx: ev.deltaX * k, dy: ev.deltaY * k });
    }, { passive: false });
    w.addEventListener('keydown', (ev) => {
      if (!enabled()) return;
      ev.preventDefault();
      flushMove();
      if (!ev.code) return;
      e.keys.add(ev.code);
      send({ t: T.IN_KEY_DOWN, code: ev.code });
    });
    w.addEventListener('keyup', (ev) => {
      if (!enabled()) return;
      ev.preventDefault();
      flushMove();
      if (!ev.code) return;
      e.keys.delete(ev.code);
      send({ t: T.IN_KEY_UP, code: ev.code });
    });
    w.addEventListener('blur', e.release);
  }
})();

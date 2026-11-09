// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A pen in a desktop screen viewer (a Windows or Linux touch screen's stylus, a drawing tablet, an
// Apple Pencil over Sidecar): a pen on the other computer too, with its pressure, tilt and eraser
// (in.mm/md/mu with `pen`, shared/protocol.js P.penOf), not the mouse the system makes of it. The
// page's mouse handlers skip the mouse events that follow a pen's (TDViewerPen.recent()).
// A stroke's samples go each in its own in.mm, as far apart as the pen made them (at most a frame
// behind): a burst of pen moves is merged into its last one by macOS and Windows, which loses the
// points between. fast() true: once per event instead, the earlier ones in `pts` (P.penPoints).
// attach({ norm(e, clamp) → {x, y} | null, send(m), enabled(), fast?() }).
(function () {
  const RECENT_MS = 500;
  const PEN_BUTTON = { 0: 0, 5: 0, 2: 1 }; // the tip or the eraser: left; the side button: right
  const DEG = 180 / Math.PI;
  let at = 0; // when a pen last did anything

  function tilt(e) {
    const alt = e.altitudeAngle, az = e.azimuthAngle;
    if (typeof alt === 'number' && typeof az === 'number' && alt > 0) {
      if (alt >= Math.PI / 2 - 1e-6) return [0, 0];
      const t = Math.tan(alt);
      return [Math.round(Math.atan(Math.cos(az) / t) * DEG * 10) / 10, Math.round(Math.atan(Math.sin(az) / t) * DEG * 10) / 10];
    }
    return [Math.round(e.tiltX || 0), Math.round(e.tiltY || 0)];
  }

  function attach(o) {
    const held = new Set();
    let last = null; // {x, y, pen}
    let strokeP = 0;
    const pace = (() => {
      const GAP_MAX = 8, LAG_MAX = 20; // ms
      let q = [], timer = 0, due = 0, prevT = 0;
      function run() {
        timer = 0;
        const now = performance.now();
        while (q.length && q[0].due <= now + 0.5) o.send(q.shift().m);
        if (q.length) timer = setTimeout(run, Math.max(0, q[0].due - now));
      }
      return {
        add(m, t) {
          const now = performance.now();
          if (!q.length && due <= now) { due = now; prevT = t; o.send(m); return; }
          due = Math.max(now, due + Math.min(GAP_MAX, Math.max(0, t - prevT)));
          if (due - now > LAG_MAX) due = now;
          prevT = t;
          q.push({ m, due });
          if (!timer) timer = setTimeout(run, Math.max(0, q[0].due - now));
        },
        flush() {
          if (timer) { clearTimeout(timer); timer = 0; }
          for (const x of q) o.send(x.m);
          q = [];
          due = 0;
        },
      };
    })();
    function state(e) {
      const c = (e.buttons & 33) !== 0;
      let p = c ? Math.min(1, Math.max(0, e.pressure || 0)) : 0;
      if (c && p === 0) p = strokeP || 0.2;
      strokeP = c ? p : 0;
      const [tx, ty] = tilt(e);
      return { p: Math.round(p * 10000) / 10000, tx, ty, tw: Math.round(e.twist || 0) % 360,
        c, er: (e.buttons & 32) !== 0 || e.button === 5, bar: (e.buttons & 2) !== 0 };
    }
    function put(t, e, b) {
      pace.flush();
      const p = o.norm(e, held.size > 0 || t !== 'in.mm');
      if (!p) return out();
      last = { x: p.x, y: p.y, pen: state(e) };
      o.send(b === undefined ? { t, x: p.x, y: p.y, pen: last.pen } : { t, x: p.x, y: p.y, b, pen: last.pen });
    }
    function out() {
      pace.flush();
      if (last && !last.pen.out) {
        for (const b of held) o.send({ t: 'in.mu', x: last.x, y: last.y, b, pen: { ...last.pen, c: false, p: 0 } });
        held.clear();
        last.pen = { ...last.pen, c: false, p: 0, bar: false, out: true };
        o.send({ t: 'in.mm', x: last.x, y: last.y, pen: last.pen });
      }
      last = null;
    }
    const mine = (e) => e.pointerType === 'pen' && o.enabled();
    window.addEventListener('pointerdown', (e) => {
      if (!mine(e)) return;
      at = performance.now();
      e.preventDefault();
      const b = PEN_BUTTON[e.button];
      if (b === undefined) return;
      held.add(b);
      put('in.md', e, b);
    }, true);
    window.addEventListener('pointermove', (e) => {
      if (!mine(e)) return;
      at = performance.now();
      const all = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (!held.size) return put('in.mm', e);
      if (!(o.fast && o.fast())) {
        for (const s of all.length ? all : [e]) {
          const p = o.norm(s, true);
          if (!p) continue;
          last = { x: p.x, y: p.y, pen: state(s) };
          pace.add({ t: 'in.mm', x: p.x, y: p.y, pen: last.pen }, s.timeStamp);
        }
        return;
      }
      if (all.length < 2) return put('in.mm', e);
      pace.flush();
      // The stroke's samples since the last event in one in.mm (`pts`, P.penPoints), the last as x, y.
      const pts = [];
      for (const s of all.slice(0, -1)) {
        const p = o.norm(s, true);
        if (p) { const st = state(s); pts.push([p.x, p.y, st.p, st.tx, st.ty]); }
      }
      const p = o.norm(e, true);
      if (!p) return;
      last = { x: p.x, y: p.y, pen: state(e) };
      o.send(pts.length ? { t: 'in.mm', x: p.x, y: p.y, pen: last.pen, pts } : { t: 'in.mm', x: p.x, y: p.y, pen: last.pen });
    }, true);
    window.addEventListener('pointerup', (e) => {
      if (!mine(e)) return;
      at = performance.now();
      const b = PEN_BUTTON[e.button];
      if (b === undefined || !held.has(b)) return;
      held.delete(b);
      put('in.mu', e, b);
    }, true);
    const away = (e) => { if (e.pointerType === 'pen') { at = performance.now(); out(); } };
    window.addEventListener('pointercancel', away, true);
    document.documentElement.addEventListener('pointerleave', away);
    window.addEventListener('blur', out);
    return { release: out };
  }

  window.TDViewerPen = { attach, recent: () => performance.now() - at < RECENT_MS };
})();

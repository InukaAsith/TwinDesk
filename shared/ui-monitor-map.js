// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Multi-device tab's monitor map (#225): every device's monitors drawn where they sit on the desk
// (state.layout.map, from mesh/layout-sync.js and shared/layout-world.js). Drag a device by any of its
// monitors and drop it: it goes where it may (touching another one, off the others, edges lined up
// within a few pixels), on every device at once. The lit lines are this device's edges where the
// pointer crosses, so a monitor that only touches by a corner, or doesn't touch, shows none.
//   const mm = MonitorMap.create({ move(id, x, y, snap), keyMove })  // x, y: the plane's pixels
//   body.append(mm.el); mm.draw(map, people, selfId)                  // people: Map id -> { name, os, connected, self }
'use strict';

(function () {
  const HEIGHT = 260; // the map's height in the page; its width is the card's
  const PAD = 0.12; // room around the devices, of the larger side
  const SNAP_PX = 10; // how close (on screen) an edge lines up with another one when dropped
  const STEP_PX = 12; // an arrow key moves a device this far on screen

  function create(opts) {
    const el = document.createElement('div');
    el.className = 'mm';
    el.setAttribute('role', 'group');
    const stage = document.createElement('div');
    stage.className = 'mm-stage';
    el.append(stage);
    let view = null; // { scale, ox, oy, world }
    let drag = null;
    let lastArgs = null;

    const toScreen = (x, y) => ({ x: (x - view.ox) * view.scale, y: (y - view.oy) * view.scale });

    function draw(map, people, selfId) {
      lastArgs = [map, people, selfId];
      if (drag) return; // after the drop
      if (!map || !Array.isArray(map.monitors)) return void stage.replaceChildren();
      const width = el.clientWidth || 520;
      const mons = map.monitors;
      if (!mons.length) return void stage.replaceChildren();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const m of mons) {
        x0 = Math.min(x0, m.x); y0 = Math.min(y0, m.y);
        x1 = Math.max(x1, m.x + m.w); y1 = Math.max(y1, m.y + m.h);
      }
      const pad = Math.max(x1 - x0, y1 - y0) * PAD;
      const bw = x1 - x0 + 2 * pad, bh = y1 - y0 + 2 * pad;
      const scale = Math.min(width / bw, HEIGHT / bh);
      // centred in the map
      view = { scale, world: map.world || {}, ox: x0 - pad - (width / scale - bw) / 2, oy: y0 - pad - (HEIGHT / scale - bh) / 2 };
      el.style.height = HEIGHT + 'px';

      const byDev = new Map();
      for (const m of mons) {
        if (!byDev.has(m.dev)) byDev.set(m.dev, []);
        byDev.get(m.dev).push(m);
      }
      const nodes = [];
      for (const [dev, list] of byDev) {
        const info = people.get(dev) || { name: dev.slice(0, 8), os: '', connected: false, self: false };
        const online = map.online ? map.online[dev] !== false : true;
        let gx = Infinity, gy = Infinity, gx1 = -Infinity, gy1 = -Infinity;
        for (const m of list) {
          gx = Math.min(gx, m.x); gy = Math.min(gy, m.y);
          gx1 = Math.max(gx1, m.x + m.w); gy1 = Math.max(gy1, m.y + m.h);
        }
        const g = document.createElement('button');
        g.type = 'button';
        g.className = 'mm-dev' + (dev === selfId ? ' here' : '') + (online ? '' : ' off');
        g.dataset.dev = dev;
        g.setAttribute('data-literal', '');
        const at = toScreen(gx, gy);
        Object.assign(g.style, { left: at.x + 'px', top: at.y + 'px', width: (gx1 - gx) * scale + 'px', height: (gy1 - gy) * scale + 'px' });
        const state = dev === selfId ? '' : online ? '' : ' — ' + I18n.t('Not connected');
        g.title = info.name + state;
        g.setAttribute('aria-label', I18n.t('{name}: drag to move it, or use the arrow keys', { name: info.name }) + state);
        let biggest = list[0];
        for (const m of list) {
          if (m.w * m.h > biggest.w * biggest.h) biggest = m;
          const s = document.createElement('span');
          s.className = 'mm-mon';
          Object.assign(s.style, { left: (m.x - gx) * scale + 'px', top: (m.y - gy) * scale + 'px', width: m.w * scale + 'px', height: m.h * scale + 'px' });
          g.append(s);
        }
        const label = document.createElement('span');
        label.className = 'mm-label';
        Object.assign(label.style, { left: (biggest.x - gx) * scale + 'px', top: (biggest.y - gy) * scale + 'px', width: biggest.w * scale + 'px', height: biggest.h * scale + 'px' });
        if (typeof UI !== 'undefined' && UI.osIcon && biggest.h * scale >= 44) label.append(UI.osIcon(info.os));
        const name = document.createElement('span');
        name.className = 'mm-name';
        name.textContent = info.name;
        label.append(name);
        g.append(label);
        g.addEventListener('pointerdown', (e) => onDown(e, dev, g));
        g.addEventListener('keydown', (e) => onKey(e, dev));
        nodes.push(g);
      }
      // Our edges where the pointer crosses (map.edges: side, from-to along it, at = the edge's line), and
      // in red where a computer that isn't connected stops it (map.blocked).
      const lines = [...(map.edges || []), ...(map.blocked || []).map((e) => ({ ...e, blocked: true }))];
      for (const e of lines) {
        if (!Number.isFinite(e.at)) continue;
        const line = document.createElement('span');
        line.className = 'mm-edge ' + e.side + (e.blocked ? ' blocked' : '');
        if (e.blocked) line.title = I18n.t('{name} is not connected: the pointer stops here', { name: (people.get(e.dev) || { name: String(e.dev).slice(0, 8) }).name });
        const vertical = e.side === 'left' || e.side === 'right';
        const a = vertical ? toScreen(e.at, e.from) : toScreen(e.from, e.at);
        const len = (e.to - e.from) * scale;
        Object.assign(line.style, vertical
          ? { left: a.x - 2 + 'px', top: a.y + 'px', width: '4px', height: len + 'px' }
          : { left: a.x + 'px', top: a.y - 2 + 'px', width: len + 'px', height: '4px' });
        nodes.push(line);
      }
      const focused = stage.contains(document.activeElement) ? document.activeElement.dataset.dev : null;
      stage.replaceChildren(...nodes);
      if (focused) { const f = nodes.find((n) => n.dataset && n.dataset.dev === focused); if (f) f.focus({ preventScroll: true }); } // arrow keys go on
    }

    function onDown(e, dev, g) {
      if (e.button !== 0 || !view || !view.world[dev]) return;
      e.preventDefault();
      g.focus({ preventScroll: true });
      g.setPointerCapture(e.pointerId);
      drag = { dev, g, x: e.clientX, y: e.clientY, dx: 0, dy: 0, id: e.pointerId };
      g.classList.add('dragging');
      const move = (ev) => {
        if (ev.pointerId !== drag.id) return;
        drag.dx = ev.clientX - drag.x;
        drag.dy = ev.clientY - drag.y;
        g.style.transform = `translate(${drag.dx}px, ${drag.dy}px)`;
      };
      const up = (ev) => {
        if (ev.pointerId !== drag.id) return;
        g.removeEventListener('pointermove', move);
        g.removeEventListener('pointerup', up);
        g.removeEventListener('pointercancel', up);
        const d = drag;
        drag = null;
        g.classList.remove('dragging');
        if (ev.type === 'pointerup' && Math.hypot(d.dx, d.dy) >= 3) {
          const w = view.world[dev];
          opts.move(dev, Math.round(w.x + d.dx / view.scale), Math.round(w.y + d.dy / view.scale), Math.round(SNAP_PX / view.scale));
        } else g.style.transform = '';
        if (lastArgs) draw(...lastArgs); // the old place until the new state comes
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up);
      g.addEventListener('pointercancel', up);
    }

    function onKey(e, dev) {
      const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!dir || !view || !view.world[dev]) return;
      e.preventDefault();
      const w = view.world[dev];
      const step = STEP_PX / view.scale;
      // snap 0: one step at a time, it only lines up when it gets there
      opts.move(dev, Math.round(w.x + dir[0] * step), Math.round(w.y + dir[1] * step), 0);
    }

    // The card's width changed: draw again at the new size.
    if (typeof ResizeObserver === 'function') {
      let w = 0;
      new ResizeObserver(() => {
        if (el.clientWidth !== w && lastArgs && !drag) { w = el.clientWidth; draw(...lastArgs); }
      }).observe(el);
    }

    return { el, draw };
  }

  window.MonitorMap = { create };
})();

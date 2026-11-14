// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Cursor tab's crossing map (Mac, PC and Linux, one-to-one): both computers' monitors to scale,
// as their systems arrange them. Drag the other computer along any side; it slides in against our
// monitors and snaps to touching (shared/kvm-geom.js), and the stretches where the monitors touch,
// the only places the pointer crosses, are drawn in the accent colour. Before the other computer has
// sent its monitors (or an older TwinDesk never does) it is a placeholder rectangle: dragging it
// still picks the side. Styles: shared/kvm-map-ui.css. A plain <script> after shared/kvm-geom.js
// (window.KvmMapUI).
(function (root) {
  'use strict';

  const tr = (text, vars) => root.I18n ? root.I18n.t(text, vars) : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
  const G = root.KvmGeom;
  const NS = 'http://www.w3.org/2000/svg';
  const PLACEHOLDER = [{ id: '?', x: 0, y: 0, w: 1600, h: 1000 }];
  const ME = [{ id: 'me', x: 0, y: 0, w: 1600, h: 1000 }]; // our own monitors before main reports them

  function svg(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
    if (parent) parent.appendChild(n);
    return n;
  }

  function div(cls, text) {
    const n = document.createElement('div');
    n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  // opts: onMove(side, along) when a drag ends somewhere new; onIdentify().
  function create(opts) {
    const el = div('kvm-map');
    el.setAttribute('data-literal', '');
    const box = svg('svg', { class: 'kvm-map-svg', role: 'img' });
    el.appendChild(box);
    const legend = div('kvm-map-legend');
    const meKey = div('kvm-map-key mine'), themKey = div('kvm-map-key theirs');
    legend.append(meKey, themKey);
    const foot = div('kvm-map-foot');
    const hint = div('kvm-map-hint');
    const identify = document.createElement('button');
    identify.className = 'btn small kvm-map-identify';
    identify.textContent = tr('Identify');
    identify.title = tr('Show each monitor’s number on it, on both computers');
    identify.onclick = () => opts.onIdentify();
    foot.append(hint, identify);
    el.append(legend, foot);

    let data = null; // the last update
    let drag = null; // while dragging: {start, from, side, along, view}

    const lists = () => ({ mine: data.mine.length ? data.mine : ME, theirs: data.theirs.length ? data.theirs : PLACEHOLDER });

    // Our monitors with room for theirs all round (steady while dragging).
    function viewOf(mine, theirs) {
      const mb = G.bounds(mine), tb = G.bounds(theirs);
      const px = tb.w + mb.w * 0.04, py = tb.h + mb.h * 0.04;
      return { x: mb.x - px, y: mb.y - py, w: mb.w + 2 * px, h: mb.h + 2 * py };
    }

    function render(side, along) {
      const { mine, theirs } = lists();
      const known = data.theirs.length > 0;
      const v = drag ? drag.view : viewOf(mine, theirs);
      box.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
      while (box.firstChild) box.removeChild(box.firstChild);
      const unit = Math.max(v.w, v.h) / 100; // about 1 % of the view

      const draw = (list, off, cls, numbers) => {
        const g = svg('g', { class: cls }, box);
        const order = G.numbered(list);
        for (const m of list) {
          const x = m.x + off.x, y = m.y + off.y;
          svg('rect', { x: x + unit * 0.2, y: y + unit * 0.2, width: Math.max(1, m.w - unit * 0.4), height: Math.max(1, m.h - unit * 0.4), rx: unit * 0.7 }, g);
          if (numbers) {
            const t = svg('text', { x: x + m.w / 2, y: y + m.h / 2, 'font-size': Math.min(m.w, m.h) * 0.4, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
            t.textContent = String(order.indexOf(m.id) + 1);
          }
        }
        return g;
      };
      draw(mine, { x: 0, y: 0 }, 'kvm-map-mine', data.mine.length > 0);
      const off = G.placement(mine, theirs, { side, along });
      draw(theirs, off, `kvm-map-theirs${known ? '' : ' placeholder'}${drag ? ' dragging' : ''}`, known).addEventListener('pointerdown', start);

      // Where they touch: the only places the pointer crosses.
      if (known) {
        const vert = side === 'left' || side === 'right';
        for (const c of G.contact(mine, theirs, { side, along })) {
          const d = mine.find((m) => m.id === c.mine.display);
          const at = side === 'right' ? d.x + d.w : side === 'left' ? d.x : side === 'bottom' ? d.y + d.h : d.y;
          const line = svg('line', vert ? { x1: at, x2: at, y1: c.mine.from, y2: c.mine.to } : { y1: at, y2: at, x1: c.mine.from, x2: c.mine.to }, box);
          line.setAttribute('class', 'kvm-map-touch');
        }
      }
    }

    function point(e) {
      const p = box.createSVGPoint();
      p.x = e.clientX;
      p.y = e.clientY;
      return p.matrixTransform(box.getScreenCTM().inverse());
    }

    function start(e) {
      if (!data) return;
      e.preventDefault();
      const { mine, theirs } = lists();
      const tb = G.bounds(theirs);
      const off = G.placement(mine, theirs, { side: data.side, along: data.along });
      drag = { start: point(e), from: { x: tb.x + off.x, y: tb.y + off.y }, side: data.side, along: data.along, view: viewOf(mine, theirs) };
      box.setPointerCapture(e.pointerId);
      box.addEventListener('pointermove', move);
      box.addEventListener('pointerup', end);
      box.addEventListener('pointercancel', end);
      box.addEventListener('lostpointercapture', end);
      render(drag.side, drag.along);
    }

    function move(e) {
      if (!drag) return;
      const p = point(e);
      const { mine, theirs } = lists();
      const mb = G.bounds(mine), tb = G.bounds(theirs);
      const x = drag.from.x + p.x - drag.start.x, y = drag.from.y + p.y - drag.start.y;
      // Follow the closest valid placement of the actual display groups, not their box centres.
      const side = G.closestSide(mine, theirs, x, y, drag.side);
      const vert = side === 'left' || side === 'right';
      let along = vert ? y - mb.y : x - mb.x;
      if (data.theirs.length) along = G.snap(mine, theirs, side, along);
      else along = Math.round(Math.min(Math.max(along, -(vert ? tb.h : tb.w) + G.MIN_TOUCH), (vert ? mb.h : mb.w) - G.MIN_TOUCH));
      drag.side = side;
      drag.along = along;
      render(side, along);
    }

    function end() {
      if (!drag) return;
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', end);
      box.removeEventListener('pointercancel', end);
      box.removeEventListener('lostpointercapture', end);
      const { side, along } = drag;
      drag = null;
      if (side !== data.side || along !== data.along) {
        data = { ...data, side, along }; // shown at once; the state confirms it
        opts.onMove(side, along);
      }
      render(data.side, data.along);
    }

    // d: {mine, theirs, side, along, me, them}. along null: centred.
    function update(d) {
      const side = d.side || 'right';
      data = { mine: d.mine || [], theirs: d.theirs || [], side, along: 0, me: d.me || tr('This computer'), them: d.them || tr('The other computer') };
      const { mine, theirs } = lists();
      data.along = typeof d.along === 'number' ? d.along : G.centred(mine, theirs, side);
      meKey.textContent = data.me;
      themKey.textContent = data.them;
      hint.textContent = data.theirs.length
        ? tr('Drag {name} to where it is on your desk. The pointer crosses only where the screens touch (highlighted).', { name: data.them })
        : tr('Drag {name} to the side it is on. Its screens show here once it’s connected (with an up-to-date TwinDesk).', { name: data.them });
      box.setAttribute('aria-label', tr('{name} is {side} {me}', { name: data.them, side: tr({ left: 'to the left of', right: 'to the right of', top: 'above', bottom: 'below' }[side]), me: data.me }));
      identify.hidden = !data.mine.length;
      if (!drag) render(side, data.along);
    }

    return { el, update };
  }

  root.KvmMapUI = { create };
})(typeof self !== 'undefined' ? self : this);

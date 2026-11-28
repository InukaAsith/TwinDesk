// TwinDesk — Copyright (C) 2026 pengusto, inukaasith. GPL-3.0, see LICENSE.
// The Cursor portals card (Mouse, at the bottom), for one-to-one and Multi-device alike: a switch, and
// when it's on a drawing of this Mac's displays and the other computer's. Click an edge on each side, drag
// the two handles to pick the part of it, choose the keys to hold, Add. The preview plays the crossing: the
// pointer comes close, the portal opens on that edge, it goes through and comes out on the other computer.
//
//   const p = CursorPortalsUI.create();  body.append(p.el);  p.update(state)
//   state.input.portals = { supported, on, mine: [displays], peers: [{ id, name, os, displays, rules }] }
//   api.setPortals({ rules, peer }) saves one computer's list; api.setKvm({ portalsOn }) the switch.
// Phones never show: a portal leads to a computer.
'use strict';

const CursorPortalsUI = {
  create() {
    const { el, api } = UI;
    const t = (s, v) => (window.I18n ? I18n.t(s, v) : s);
    const NS = 'http://www.w3.org/2000/svg';
    const svgEl = (tag, attrs = {}) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      return e;
    };

    const VW = 300, VH = 180, PAD = 16;
    const COLORS = ['#bf5af2', '#ff9f0a', '#30d158', '#64d2ff', '#ff375f', '#ffd60a'];
    const SIDE_NAMES = { top: t('top'), bottom: t('bottom'), left: t('left'), right: t('right') };
    const MODS = [
      { name: 'Command', label: '⌘', title: t('Command') },
      { name: 'Control', label: '⌃', title: t('Control') },
      { name: 'Alt', label: '⌥', title: t('Option') },
      { name: 'Shift', label: '⇧', title: t('Shift') },
    ];

    let state = null; // the last s.input.portals
    let where = 'home';
    let peerId = '';
    const pick = { src: null, dst: null, mods: new Set(['Command']), key: '' };
    let drawKey = '';

    // ---- the switch and the card ----
    const sw = UI.switch((v) => api.setKvm({ portalsOn: v }), { label: t('Cursor portals') });
    const intro = UI.row(t('Use cursor portals'), t('Send the pointer from part of an edge here to a chosen place on another computer’s screen. Each portal has its own key to hold, so Hold key to switch is off while portals are on.'), [sw]);
    const note = el('div', { class: 'cp-note', attrs: { role: 'status' } });

    const peerSeg = el('div', { class: 'seg cp-peers', attrs: { role: 'radiogroup', 'aria-label': t('Computer') } });

    // ---- the drawing: two panels ----
    const panel = (cls, label) => {
      const svg = svgEl('svg', { viewBox: `0 0 ${VW} ${VH}`, class: 'cp-svg', role: 'group', 'aria-label': label });
      const title = el('div', { class: 'cp-panel-title', text: label });
      return { svg, title, el: el('div', { class: `cp-panel ${cls}` }, [title, svg]), box: null, displays: [] };
    };
    const mineP = panel('cp-mine', t('This Mac'));
    const theirsP = panel('cp-theirs', t('Other computer'));
    const arrow = el('div', { class: 'cp-arrow', text: '→', attrs: { 'aria-hidden': 'true' } });
    const stage = el('div', { class: 'cp-stage' }, [mineP.el, arrow, theirsP.el]);
    const stageHint = el('div', { class: 'cp-hint', text: t('Click an edge on each side, then drag the handles to set how much of it the portal covers.') });

    // ---- keys and add ----
    const chips = MODS.map((m) => {
      const b = el('button', { class: 'cp-chip', text: m.label, title: m.title, attrs: { type: 'button', 'aria-label': m.name, 'aria-pressed': 'false' } });
      b.onclick = () => { if (pick.mods.has(m.name)) pick.mods.delete(m.name); else pick.mods.add(m.name); paintChips(); check(); };
      return { m, b };
    });
    const paintChips = () => { for (const { m, b } of chips) { b.classList.toggle('on', pick.mods.has(m.name)); b.setAttribute('aria-pressed', String(pick.mods.has(m.name))); } };
    const keyOptions = [{ value: '', label: t('No other key') }, ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => ({ value: `Key${c}`, label: c })),
      ...'0123456789'.split('').map((c) => ({ value: `Digit${c}`, label: c })),
      ...Array.from({ length: 20 }, (_, i) => ({ value: `F${i + 1}`, label: `F${i + 1}` })),
      ...['Space', 'Tab', 'Escape', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
        'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].map((value) => ({ value, label: value }))];
    const key = UI.select(keyOptions, (v) => { pick.key = v; check(); });
    key.el.setAttribute('aria-label', t('Additional shortcut key'));
    const keysRow = UI.row(t('Hold to go through'), t('Held while the pointer reaches the portal. Needed on an edge that touches another display here.'), [el('div', { class: 'cp-chips' }, chips.map((c) => c.b)), key.el]);
    const status = el('span', { class: 'cp-status', attrs: { role: 'status' } });
    const add = UI.button(t('Add portal'), () => addRule());
    const addRow = el('div', { class: 'cp-add' }, [status, add]);
    const list = el('div', { class: 'cp-list' });
    const editor = el('div', { class: 'cp-editor' }, [peerSeg, stage, stageHint, keysRow, addRow, list]);

    const wrap = UI.card(t('Cursor portals'), [intro, note, editor]);
    wrap.classList.add('cp-card');

    // ---- geometry ----
    const fit = (displays) => {
      if (!displays.length) return null;
      const x0 = Math.min(...displays.map((d) => d.x)), y0 = Math.min(...displays.map((d) => d.y));
      const x1 = Math.max(...displays.map((d) => d.x + d.w)), y1 = Math.max(...displays.map((d) => d.y + d.h));
      const k = Math.min((VW - 2 * PAD) / Math.max(1, x1 - x0), (VH - 2 * PAD) / Math.max(1, y1 - y0));
      const ox = (VW - (x1 - x0) * k) / 2 - x0 * k, oy = (VH - (y1 - y0) * k) / 2 - y0 * k;
      return { k, ox, oy, rect: (d) => ({ x: ox + d.x * k, y: oy + d.y * k, w: d.w * k, h: d.h * k }) };
    };
    // An edge as a line in the drawing: start point, direction along it, length, and the outward normal.
    const edgeLine = (r, side) => {
      if (side === 'top') return { x: r.x, y: r.y, dx: 1, dy: 0, len: r.w, nx: 0, ny: -1 };
      if (side === 'bottom') return { x: r.x, y: r.y + r.h, dx: 1, dy: 0, len: r.w, nx: 0, ny: 1 };
      if (side === 'left') return { x: r.x, y: r.y, dx: 0, dy: 1, len: r.h, nx: -1, ny: 0 };
      return { x: r.x + r.w, y: r.y, dx: 0, dy: 1, len: r.h, nx: 1, ny: 0 };
    };
    const at = (e, f) => ({ x: e.x + e.dx * e.len * f, y: e.y + e.dy * e.len * f });
    const order = (displays) => displays.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const dispLabel = (displays, id) => { const i = order(displays).findIndex((d) => d.id === id); return i < 0 ? t('Display unavailable') : `${i + 1}`; };
    const snap = (v) => Math.round(Math.max(0, Math.min(1, v)) * 20) / 20;

    const peer = () => (state && state.peers || []).find((p) => p.id === peerId) || null;
    const rules = () => { const p = peer(); return p && Array.isArray(p.rules) ? p.rules : []; };

    // ---- drawing one panel ----
    function drawPanel(P, displays, end, otherRules, mine) {
      P.displays = displays;
      const svg = P.svg;
      svg.replaceChildren();
      const g = fit(displays);
      P.box = g;
      if (!g) {
        const txt = svgEl('text', { x: VW / 2, y: VH / 2, 'text-anchor': 'middle', class: 'cp-empty' });
        txt.textContent = t('No displays yet');
        svg.append(txt);
        return;
      }
      for (const d of order(displays)) {
        const r = g.rect(d);
        svg.append(svgEl('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 4, class: 'cp-disp' }));
        const label = svgEl('text', { x: r.x + r.w / 2, y: r.y + r.h / 2 + 5, 'text-anchor': 'middle', class: 'cp-disp-n' });
        label.textContent = dispLabel(displays, d.id);
        svg.append(label);
      }
      // saved portals, each in its colour
      otherRules.forEach((rule, i) => {
        const e = mine ? rule.source : rule.target;
        const d = displays.find((x) => x.id === e.display);
        if (!d) return;
        const L = edgeLine(g.rect(d), e.side);
        const a = at(L, e.from), b = at(L, e.to);
        svg.append(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'cp-saved', stroke: COLORS[i % COLORS.length] }));
      });
      // the edges to click
      for (const d of order(displays)) {
        const r = g.rect(d);
        for (const side of ['top', 'bottom', 'left', 'right']) {
          const L = edgeLine(r, side);
          const b = at(L, 1);
          const hit = svgEl('line', { x1: L.x, y1: L.y, x2: b.x, y2: b.y, class: 'cp-edge', tabindex: 0, role: 'button',
            'aria-label': `${mine ? t('This Mac') : t('Other computer')}, ${t('display')} ${dispLabel(displays, d.id)}, ${SIDE_NAMES[side]} ${t('edge')}` });
          const choose = () => {
            const cur = pick[end];
            pick[end] = cur && cur.display === d.id && cur.side === side ? cur : { display: d.id, side, from: 0, to: 1 };
            redraw();
          };
          hit.onclick = choose;
          hit.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { if (ev.preventDefault) ev.preventDefault(); choose(); } };
          svg.append(hit);
        }
      }
      // the chosen edge: its range and two handles
      const sel = pick[end];
      const d = sel && displays.find((x) => x.id === sel.display);
      if (!d) { if (sel) pick[end] = null; return; }
      const L = edgeLine(g.rect(d), sel.side);
      const a = at(L, sel.from), b = at(L, sel.to);
      svg.append(svgEl('line', { x1: L.x, y1: L.y, x2: at(L, 1).x, y2: at(L, 1).y, class: 'cp-edge-on' }));
      const bar = svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'cp-range' });
      svg.append(bar);
      // the portal shape that opens in the preview
      const mid = at(L, (sel.from + sel.to) / 2);
      const len = Math.max(6, (sel.to - sel.from) * L.len);
      const portal = svgEl('ellipse', { cx: mid.x, cy: mid.y, rx: L.dx ? len / 2 : 4, ry: L.dy ? len / 2 : 4, class: 'cp-portal' });
      svg.append(portal);
      P.portal = portal;
      P.line = L;
      P.sel = sel;
      for (const which of ['from', 'to']) {
        const p = at(L, sel[which]);
        const h = svgEl('circle', { cx: p.x, cy: p.y, r: 6.5, class: 'cp-handle', tabindex: 0, role: 'slider',
          'aria-label': `${end === 'src' ? t('Source') : t('Destination')} ${which === 'from' ? t('start') : t('end')}`,
          'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(sel[which] * 100) });
        const setTo = (v) => {
          v = snap(v);
          if (which === 'from') sel.from = Math.min(v, sel.to - 0.05);
          else sel.to = Math.max(v, sel.from + 0.05);
          sel.from = Math.max(0, snap(sel.from)); sel.to = Math.min(1, snap(sel.to));
          redraw();
        };
        h.onkeydown = (ev) => {
          const step = { ArrowLeft: -0.05, ArrowDown: -0.05, ArrowRight: 0.05, ArrowUp: 0.05 }[ev.key];
          if (step === undefined) return;
          if (ev.preventDefault) ev.preventDefault();
          setTo(sel[which] + step);
        };
        h.onpointerdown = (ev) => {
          if (ev.preventDefault) ev.preventDefault();
          if (h.setPointerCapture && ev.pointerId !== undefined) h.setPointerCapture(ev.pointerId);
          const move = (e) => {
            const rect = svg.getBoundingClientRect();
            const vx = (e.clientX - rect.left) * VW / rect.width, vy = (e.clientY - rect.top) * VH / rect.height;
            const f = L.dx ? (vx - L.x) / L.len : (vy - L.y) / L.len;
            const v = snap(f);
            if (which === 'from') sel.from = Math.max(0, Math.min(v, sel.to - 0.05));
            else sel.to = Math.min(1, Math.max(v, sel.from + 0.05));
            const q = at(L, sel[which]);
            h.setAttribute('cx', q.x); h.setAttribute('cy', q.y);
            const a2 = at(L, sel.from), b2 = at(L, sel.to);
            bar.setAttribute('x1', a2.x); bar.setAttribute('y1', a2.y); bar.setAttribute('x2', b2.x); bar.setAttribute('y2', b2.y);
          };
          const up = () => { h.onpointermove = null; h.onpointerup = null; redraw(); };
          h.onpointermove = move;
          h.onpointerup = up;
          h.onpointercancel = up;
        };
        svg.append(h);
      }
    }

    // ---- the preview: pointer closes in, the portal opens, through, out the other side ----
    const cursorM = svgEl('path', { d: 'M0 0 L0 13 L3.5 9.5 L6 15 L8 14 L5.5 8.5 L10 8.5 Z', class: 'cp-cursor' });
    const cursorT = svgEl('path', { d: 'M0 0 L0 13 L3.5 9.5 L6 15 L8 14 L5.5 8.5 L10 8.5 Z', class: 'cp-cursor' });
    let anim = 0;
    const ease = (x) => x * x * (3 - 2 * x);
    function frame(now) {
      anim = 0;
      if (!wrap.isConnected || !state || !state.on || !mineP.sel || !theirsP.sel || !pick.src || !pick.dst) return;
      const T = 3200, p = (now % T) / T;
      const L1 = mineP.line, L2 = theirsP.line;
      const m1 = at(L1, (pick.src.from + pick.src.to) / 2), m2 = at(L2, (pick.dst.from + pick.dst.to) / 2);
      const IN = 46; // how far inside the display the pointer starts / ends
      const place = (c, x, y, o) => { c.setAttribute('transform', `translate(${x} ${y})`); c.style.opacity = String(o); };
      let open1 = 0, open2 = 0;
      if (p < 0.45) { // approaching: inward start, moving out to the edge
        const q = ease(p / 0.45);
        place(cursorM, m1.x - L1.nx * IN * (1 - q), m1.y - L1.ny * IN * (1 - q), 1);
        open1 = Math.max(0, (q - 0.55) / 0.45); // opens when close
        place(cursorT, m2.x, m2.y, 0);
      } else if (p < 0.55) { // through
        open1 = 1 - (p - 0.45) / 0.1; open2 = (p - 0.45) / 0.1;
        place(cursorM, m1.x, m1.y, 0);
        place(cursorT, m2.x, m2.y, 0);
      } else if (p < 0.9) { // coming out on the other computer
        const q = ease((p - 0.55) / 0.35);
        open2 = Math.max(0, 1 - q * 1.6);
        place(cursorT, m2.x - L2.nx * IN * q, m2.y - L2.ny * IN * q, 1);
        place(cursorM, m1.x, m1.y, 0);
      } else {
        place(cursorT, m2.x - L2.nx * IN, m2.y - L2.ny * IN, 1 - (p - 0.9) / 0.1);
        place(cursorM, m1.x, m1.y, 0);
      }
      mineP.portal.style.opacity = String(open1);
      theirsP.portal.style.opacity = String(open2);
      const sc = (P, o) => { const c = at(P.line, (P.sel.from + P.sel.to) / 2); P.portal.setAttribute('transform', `translate(${c.x} ${c.y}) scale(${0.3 + 0.7 * o}) translate(${-c.x} ${-c.y})`); };
      sc(mineP, open1); sc(theirsP, open2);
      anim = requestAnimationFrame(frame);
    }
    const play = () => {
      if (typeof requestAnimationFrame !== 'function' || anim) return;
      if (!mineP.sel || !theirsP.sel) return;
      if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) { // shown open, no motion
        mineP.portal.style.opacity = '1'; theirsP.portal.style.opacity = '1';
        return;
      }
      mineP.svg.append(cursorM);
      theirsP.svg.append(cursorT);
      anim = requestAnimationFrame(frame);
    };

    const xIcon = () => { const v = svgEl('svg', { viewBox: '0 0 20 20' }); v.append(svgEl('path', { d: 'M5 5 15 15 M15 5 5 15' })); return v; };
    // ---- checks, add, list ----
    function draft() {
      if (!pick.src || !pick.dst) return null;
      return { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        source: { ...pick.src }, target: { ...pick.dst }, modifiers: [...pick.mods].sort(), key: pick.key };
    }
    function problem(rule) {
      const p = peer();
      if (!state || !state.supported) return t('Update TwinDesk on both computers to use portals.');
      if (where !== 'home') return t('Bring the pointer back to this Mac to change portals.');
      if (!p) return t('Connect a computer to set up a portal.');
      if (!rule) return !pick.src ? t('Click an edge of a display on this Mac.') : t('Click an edge of a display on {name}.', { name: p.name });
      if (!CursorPortals.normalize([...rules(), rule])) return t('This part of the edge already has a portal. Move the handles or remove the other one.');
      if (!CursorPortals.usableSource(state.mine || [], rule)) return t('This edge touches another display here: choose a key to hold.');
      if (!CursorPortals.usableTarget(p.displays || [], rule.target)) return t('That display isn’t available on {name}.', { name: p.name });
      return '';
    }
    function check() {
      const why = problem(draft());
      status.textContent = why;
      add.disabled = !!why;
    }
    function addRule() {
      const rule = draft();
      if (problem(rule)) return check();
      const next = CursorPortals.normalize([...rules(), rule]);
      api.setPortals({ rules: next, peer: peerId });
      pick.src = null; pick.dst = null;
      drawKey = '';
      redraw();
    }
    const dot = (c) => { const d = el('span', { class: 'cp-dot' }); d.style.background = c; return d; };
    function drawList() {
      const p = peer();
      list.replaceChildren(...rules().map((rule, i) => {
        const shortcut = [...rule.modifiers.map((m) => (MODS.find((x) => x.name === m) || { label: m }).label), rule.key].filter(Boolean).join(' ') || t('No key');
        const pct = (e) => `${Math.round(e.from * 100)}–${Math.round(e.to * 100)}%`;
        const text = `${t('Display')} ${dispLabel(state.mine || [], rule.source.display)} ${SIDE_NAMES[rule.source.side]} ${pct(rule.source)} → ${p ? p.name : ''} ${t('display')} ${dispLabel(p ? p.displays : [], rule.target.display)} ${SIDE_NAMES[rule.target.side]} ${pct(rule.target)}`;
        const remove = el('button', { class: 'cp-remove', title: t('Remove'), attrs: { type: 'button', 'aria-label': t('Remove') } }, [xIcon()]);
        remove.disabled = where !== 'home';
        remove.onclick = () => api.setPortals({ rules: rules().filter((r) => r.id !== rule.id), peer: peerId });
        return el('div', { class: 'cp-rule' }, [
          dot(COLORS[i % COLORS.length]),
          el('span', { class: 'cp-rule-text', text }),
          el('span', { class: 'cp-keys', text: shortcut }),
          remove,
        ]);
      }));
    }
    function redraw() {
      const p = peer();
      theirsP.title.textContent = p ? p.name : t('Other computer');
      mineP.sel = null; theirsP.sel = null;
      drawPanel(mineP, (state && state.mine) || [], 'src', rules(), true);
      drawPanel(theirsP, (p && p.displays) || [], 'dst', rules(), false);
      if (anim && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(anim);
      anim = 0;
      play();
      drawList();
      check();
    }

    return {
      el: wrap,
      // state: the whole app state (s.input.portals, s.kvm.portalsOn)
      update(s) {
        const ps = (s.input && s.input.portals) || null;
        const on = !!(s.kvm && s.kvm.portalsOn);
        const peers = ((ps && ps.peers) || []).filter((x) => !P_isPhone(x.os));
        // no computer: a phone's session (or nothing) shows no card
        wrap.hidden = !ps || (UI.isPhone && UI.isPhone(s) && !peers.length);
        if (!ps) return;
        state = { ...ps, peers, on };
        where = (s.input && s.input.where) || 'home';
        sw.set(on);
        editor.hidden = !on;
        if (!peers.some((x) => x.id === peerId)) { peerId = peers.length ? peers[0].id : ''; pick.dst = null; }
        // the computer picker (Multi-device: several)
        peerSeg.hidden = peers.length < 2;
        const segKey = JSON.stringify(peers.map((x) => [x.id, x.name])) + peerId;
        if (peerSeg.dataset.k !== segKey) {
          peerSeg.dataset.k = segKey;
          peerSeg.replaceChildren(...peers.map((x) => {
            const b = el('button', { text: x.name, attrs: { role: 'radio', type: 'button', 'aria-checked': String(x.id === peerId) } });
            b.classList.toggle('on', x.id === peerId);
            b.onclick = () => { peerId = x.id; pick.dst = null; drawKey = ''; peerSeg.dataset.k = ''; this.update(s); };
            return b;
          }));
        }
        note.textContent = !on ? '' : !ps.supported ? t('Update TwinDesk on both computers to use portals.') : !peers.length ? t('Connect a computer to set up a portal.') : '';
        note.hidden = !note.textContent;
        paintChips();
        if (key.el.value !== pick.key) key.set(pick.key);
        if (!on) { if (anim && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(anim); anim = 0; return; }
        const k = JSON.stringify([ps.mine, peers, peerId, where, ps.supported]);
        if (k === drawKey) return;
        drawKey = k;
        redraw();
      },
    };
  }
};

function P_isPhone(os) { return os === 'android' || os === 'ios'; }

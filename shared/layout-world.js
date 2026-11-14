// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The mesh's monitor map (#225): every device's monitors where they really are, as in the system's
// display settings, and where the pointer crosses from one device to another.
//
// A world is { [deviceId]: { x, y } }: where the top-left of the device's monitors (the bounding box of
// its displays, in its own OS coordinates, points) sits in one shared plane. Displays come from each
// device ({ [deviceId]: [{ id, x, y, w, h }] }, shared/screen-mesh.js normalizeDisplays); a device that
// sent none (a phone, an older app) counts as one screen of a usual size.
//
// Crossing: a piece of this device's outer edge (a monitor's edge with no monitor of its own beyond
// it) leads to the monitor of another device that touches it there. When that device is offline the
// way goes on through it, to what touches it on the far side (#225: A | B | C with B away, A and C
// meet), and back to it when it comes back (nothing stored changes). Empty space stops the pointer.
// Along the edge the pointer keeps its place: one plane, so the same coordinate on both sides.
//
// The helpers know nothing of this: they get zones per side (0–1 along their bounding box, what they
// report as `offset`) and main maps a crossing (side, offset) to the device and its offset (`cross`).
//
// Pure JavaScript, no I/O: CommonJS in main and tests, a plain <script> in renderers (window.LayoutWorld).
(function (root) {
  'use strict';

  const SIDES = ['left', 'right', 'top', 'bottom'];
  const OPPOSITE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
  const LIMIT = 200000; // |x| and |y| of a position (untrusted input)
  const MAX_DEVICES = 10;
  const MIN_TOUCH = 40; // points: a shorter overlap doesn't count as a way through
  const PC = [{ id: 'screen', x: 0, y: 0, w: 1920, h: 1080 }];
  const PHONE = [{ id: 'screen', x: 0, y: 0, w: 412, h: 915 }];

  const vertical = (side) => side === 'left' || side === 'right';
  const isPos = (n) => Number.isFinite(n) && Math.abs(n) <= LIMIT;

  // An untrusted world made valid: integer positions, at most MAX_DEVICES, ids up to 64 characters.
  function normalize(value) {
    const out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const id of Object.keys(value).sort()) {
      const p = value[id];
      if (!id || id.length > 64 || !p || !isPos(p.x) || !isPos(p.y)) continue;
      if (Object.keys(out).length >= MAX_DEVICES) break;
      out[id] = { x: Math.round(p.x), y: Math.round(p.y) };
    }
    return out;
  }

  // The rectangle every display covers: { x, y, w, h }, or null.
  function bounds(list) {
    if (!list || !list.length) return null;
    const x0 = Math.min(...list.map((d) => d.x)), y0 = Math.min(...list.map((d) => d.y));
    const x1 = Math.max(...list.map((d) => d.x + d.w)), y1 = Math.max(...list.map((d) => d.y + d.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // A device's displays, or a usual screen for one that sent none.
  function screensOf(displays, id, phone) {
    const list = displays && Array.isArray(displays[id]) ? displays[id].filter((d) => d && d.w > 0 && d.h > 0) : [];
    return list.length ? list : phone ? PHONE : PC;
  }

  // Every monitor in the plane: [{ dev, id, x, y, w, h }]. ids: the devices to place (in the world).
  // phone(id): true for a phone (its usual screen is a phone's).
  function placed(world, displays, ids, phone = () => false) {
    const out = [];
    for (const dev of ids) {
      const at = world[dev];
      if (!at) continue;
      const list = screensOf(displays, dev, phone(dev));
      const b = bounds(list);
      for (const d of list) out.push({ dev, id: d.id, x: at.x + d.x - b.x, y: at.y + d.y - b.y, w: d.w, h: d.h });
    }
    return out;
  }

  // The world from the grid of shared/layout.js ({ id: { x, y } } cells), for a layout no one arranged
  // here yet. A row's devices side by side, touching (vertically centred on the row); rows one under the
  // other, touching (the top row's devices on its bottom, the others' on their row's top); a row starts
  // under the device of the row above in its column, when there is one.
  function fromCells(cells, displays, phone = () => false) {
    const ids = Object.keys(cells || {});
    const size = {};
    for (const id of ids) { const b = bounds(screensOf(displays, id, phone(id))); size[id] = { w: b.w, h: b.h }; }
    const ys = [...new Set(ids.map((id) => cells[id].y))].sort((a, b) => a - b);
    const out = {};
    let top = 0;
    ys.forEach((y, ri) => {
      const row = ids.filter((id) => cells[id].y === y).sort((a, b) => cells[a].x - cells[b].x);
      const h = Math.max(...row.map((id) => size[id].h));
      let right = null;
      for (const id of row) {
        const above = ri > 0 ? ids.find((k) => cells[k].y === ys[ri - 1] && cells[k].x === cells[id].x) : null;
        const x = right !== null ? right : above ? out[above].x : 0;
        const yy = ri === 0 && ys.length > 1 ? top + h - size[id].h : ri === 0 ? top + Math.round((h - size[id].h) / 2) : top;
        out[id] = { x: Math.round(x), y: Math.round(yy) };
        right = x + size[id].w;
      }
      top += h;
    });
    return out;
  }

  // The world for these devices: the stored positions; a device without one goes to the right of
  // everything, at the top (in id order, so every device computes the same). No stored world at all:
  // the one from the grid.
  function complete(world, cells, displays, ids, phone = () => false) {
    const stored = normalize(world);
    const known = ids.filter((id) => stored[id]);
    let out = {};
    if (!known.length) {
      const sub = {};
      for (const id of ids) if (cells && cells[id]) sub[id] = cells[id];
      out = fromCells(sub, displays, phone);
    } else for (const id of known) out[id] = stored[id];
    for (const id of [...ids].sort()) {
      if (out[id]) continue;
      const mons = placed(out, displays, Object.keys(out), phone);
      const b = bounds(mons);
      out[id] = b ? { x: b.x + b.w, y: b.y } : { x: 0, y: 0 };
    }
    return out;
  }

  // Along / across a side: the monitor's extent along it, and the coordinate of its edge on it.
  const along = (m, side) => (vertical(side) ? [m.y, m.y + m.h] : [m.x, m.x + m.w]);
  const edgeAt = (m, side) => (side === 'right' ? m.x + m.w : side === 'left' ? m.x : side === 'bottom' ? m.y + m.h : m.y);
  // How far `c` is ahead of an edge at `e` going out through `side` (negative: behind it).
  const ahead = (c, side, e) => (side === 'right' ? c.x - e : side === 'left' ? e - (c.x + c.w) : side === 'bottom' ? c.y - e : e - (c.y + c.h));

  // [a, b] minus every interval in cuts: the pieces left.
  function subtract(a, b, cuts) {
    let pieces = [[a, b]];
    for (const [c, d] of cuts) {
      const next = [];
      for (const [p, q] of pieces) {
        if (d <= p || c >= q) { next.push([p, q]); continue; }
        if (c > p) next.push([p, c]);
        if (d < q) next.push([d, q]);
      }
      pieces = next;
    }
    return pieces.filter(([p, q]) => q - p >= 1);
  }

  // Where device selfId's edges lead: { left: [...], right: [...], top: [...], bottom: [...] }, each
  // stretch { from, to, dev, display, gap } in plane coordinates along the side, in order. ids: every
  // device of the map; present(id): the ones that may be crossed to (online). An offline one is passed
  // through (gap: how far), empty space is not.
  function stretches(world, displays, ids, selfId, present = () => true, phone = () => false) {
    const all = placed(world, displays, ids, phone);
    const mine = all.filter((m) => m.dev === selfId);
    const others = all.filter((m) => m.dev !== selfId);
    const out = { left: [], right: [], top: [], bottom: [] };
    const far = (c, side) => edgeAt(c, side); // an offline monitor's edge on the way out
    for (const side of SIDES) {
      const res = [];
      for (const m of mine) {
        const e = edgeAt(m, side);
        // Our own monitors beyond this edge: the edge isn't outer there.
        const own = mine.filter((o) => o !== m && Math.abs(ahead(o, side, e)) < 1).map((o) => along(o, side));
        for (const [a, b] of subtract(...along(m, side), own)) {
          const cands = others.filter((c) => ahead(c, side, e) > -1).map((c) => ({ c, span: along(c, side) }))
            .filter((x) => Math.min(b, x.span[1]) - Math.max(a, x.span[0]) >= 1);
          if (!cands.length) continue;
          const marks = [...new Set([a, b, ...cands.flatMap((x) => x.span).filter((v) => v > a && v < b)])].sort((p, q) => p - q);
          for (let i = 0; i < marks.length - 1; i++) {
            const p = marks[i], q = marks[i + 1];
            const here = cands.filter((x) => x.span[0] <= p && x.span[1] >= q).map((x) => x.c);
            // Walk out from the edge: what touches the front; offline ones are crossed, the front moving
            // to their far edge.
            let front = e, best = null;
            for (let step = 0; step < MAX_DEVICES * 8 && !best; step++) {
              const touchingNow = here.filter((c) => Math.abs(ahead(c, side, front)) < 1);
              if (!touchingNow.length) break;
              const live = touchingNow.filter((c) => present(c.dev)).sort((u, v) => (u.dev < v.dev ? -1 : u.dev > v.dev ? 1 : 0));
              if (live.length) { best = live[0]; break; }
              const next = touchingNow.reduce((f, c) => (Math.abs(far(c, side) - e) > Math.abs(f - e) ? far(c, side) : f), front);
              if (next === front) break;
              front = next;
            }
            if (!best) continue;
            const gap = Math.abs(front - e);
            const last = res[res.length - 1];
            if (last && last.dev === best.dev && last.display === best.id && Math.abs(last.to - p) < 1) last.to = q;
            else res.push({ from: p, to: q, dev: best.dev, display: best.id, gap });
          }
        }
      }
      out[side] = res.filter((s) => s.to - s.from >= 8).sort((u, v) => u.from - v.from); // slivers (rounding) aren't a way
    }
    return out;
  }

  // The device's bounding box along a side, in the plane: { start, len }.
  function spanOf(world, displays, id, side, phone = () => false) {
    const b = bounds(placed(world, displays, [id], phone));
    if (!b) return null;
    return vertical(side) ? { start: b.y, len: b.h } : { start: b.x, len: b.w };
  }

  // The stretches as the helpers read them: "right:0.1250-0.5000,top:0.0000-1.0000", every side named.
  // No stretch anywhere: "none".
  function zonesText(world, displays, selfId, st, phone = () => false) {
    const parts = [];
    for (const side of SIDES) {
      const s = spanOf(world, displays, selfId, side, phone);
      if (!s) continue;
      const f = (v) => Math.min(1, Math.max(0, (v - s.start) / Math.max(1, s.len)));
      const merged = [];
      for (const x of st[side] || []) {
        const z = [f(x.from), f(x.to)];
        const last = merged[merged.length - 1];
        if (last && z[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], z[1]);
        else merged.push(z);
      }
      for (const [a, b] of merged) parts.push(`${side}:${a.toFixed(4)}-${b.toFixed(4)}`);
    }
    return parts.length ? parts.join(',') : 'none';
  }

  // The sides with somewhere to go.
  const sidesOf = (st) => SIDES.filter((s) => st[s] && st[s].length);

  // A crossing: the pointer left device fromId through `side` at `offset` (0–1 along its bounding box).
  // { to, offset } — the device and where along its facing side (opposite) it comes in — or null. Off
  // every stretch (rounding): the nearest one.
  function cross(world, displays, ids, fromId, side, offset, present = () => true, phone = () => false) {
    if (!SIDES.includes(side)) return null;
    const st = stretches(world, displays, ids, fromId, present, phone)[side];
    if (!st.length) return null;
    const s = spanOf(world, displays, fromId, side, phone);
    const a = s.start + Math.min(1, Math.max(0, Number(offset) || 0)) * s.len;
    const dist = (x) => (a < x.from ? x.from - a : a > x.to ? a - x.to : 0);
    const best = st.reduce((u, v) => (dist(v) < dist(u) ? v : u));
    const p = Math.min(best.to - 0.5, Math.max(best.from + 0.5, a));
    const t = spanOf(world, displays, best.dev, OPPOSITE[side], phone);
    return { to: best.dev, offset: Math.min(1, Math.max(0, (p - t.start) / Math.max(1, t.len))) };
  }

  // ---- the editor ----

  const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;

  // A person dropped device id with its top-left at (x, y): where it goes. Never on top of another
  // device (pushed out the shortest way), always touching one by an edge (the gap closed the
  // shortest way), and pulled onto aligned edges or centres within `snap` points. The others don't move.
  function drop(world, displays, ids, id, x, y, snap = 60, phone = () => false) {
    const rest = ids.filter((k) => k !== id && world[k]);
    const others = placed(world, displays, rest, phone);
    const at = { x: Math.round(x), y: Math.round(y) };
    if (!others.length) return at;
    const mineAt = (p) => placed({ [id]: p }, displays, [id], phone);
    // 1. Off the others: the smallest move that clears every overlap (a few rounds for crowded places).
    for (let round = 0; round < 8; round++) {
      const mine = mineAt(at);
      let best = null;
      for (const m of mine) {
        for (const o of others) {
          if (!overlap(m, o)) continue;
          for (const [dx, dy] of [[o.x - (m.x + m.w), 0], [o.x + o.w - m.x, 0], [0, o.y - (m.y + m.h)], [0, o.y + o.h - m.y]]) {
            const p = { x: at.x + dx, y: at.y + dy };
            const bad = mineAt(p).filter((mm) => others.some((oo) => overlap(mm, oo))).length;
            const cost = Math.abs(dx) + Math.abs(dy) + bad * 1e6;
            if (!best || cost < best.cost) best = { p, cost };
          }
        }
      }
      if (!best) break;
      at.x = best.p.x; at.y = best.p.y;
    }
    // 2. Touching: close the smallest gap to a monitor that overlaps it along that gap's direction; with
    // nothing straight ahead anywhere, slide along to the nearest corner first.
    const touching = (p) => mineAt(p).some((m) => others.some((o) => {
      const h = Math.min(m.y + m.h, o.y + o.h) - Math.max(m.y, o.y), w = Math.min(m.x + m.w, o.x + o.w) - Math.max(m.x, o.x);
      return (h >= 1 && (Math.abs(m.x + m.w - o.x) < 1 || Math.abs(o.x + o.w - m.x) < 1)) || (w >= 1 && (Math.abs(m.y + m.h - o.y) < 1 || Math.abs(o.y + o.h - m.y) < 1));
    }));
    const clear = (p) => !mineAt(p).some((m) => others.some((o) => overlap(m, o)));
    if (!touching(at)) {
      let best = null;
      for (const m of mineAt(at)) {
        for (const o of others) {
          const opts = [];
          const h = Math.min(m.y + m.h, o.y + o.h) - Math.max(m.y, o.y), w = Math.min(m.x + m.w, o.x + o.w) - Math.max(m.x, o.x);
          // Slide along first when they don't face each other: to overlap by at least MIN_TOUCH.
          const need = (len, other) => Math.min(MIN_TOUCH, len, other);
          const slideY = h >= need(m.h, o.h) ? 0 : (m.y + m.h / 2 < o.y + o.h / 2 ? o.y + need(m.h, o.h) - (m.y + m.h) : o.y + o.h - need(m.h, o.h) - m.y);
          const slideX = w >= need(m.w, o.w) ? 0 : (m.x + m.w / 2 < o.x + o.w / 2 ? o.x + need(m.w, o.w) - (m.x + m.w) : o.x + o.w - need(m.w, o.w) - m.x);
          opts.push([o.x - (m.x + m.w), slideY], [o.x + o.w - m.x, slideY], [slideX, o.y - (m.y + m.h)], [slideX, o.y + o.h - m.y]);
          for (const [dx, dy] of opts) {
            const p = { x: at.x + dx, y: at.y + dy };
            if (!clear(p) || !touching(p)) continue;
            const cost = Math.hypot(dx, dy);
            if (!best || cost < best.cost) best = { p, cost };
          }
        }
      }
      if (best) { at.x = best.p.x; at.y = best.p.y; }
    }
    // 3. Aligned edges and centres, within snap, if it still touches and overlaps nothing.
    const mb = bounds(mineAt(at));
    const pulls = { x: [], y: [] };
    for (const o of others) {
      for (const [mine, theirs] of [[0, 0], [mb.w, o.w], [mb.w / 2, o.w / 2]]) pulls.x.push(o.x + theirs - mine - mb.x + at.x);
      for (const [mine, theirs] of [[0, 0], [mb.h, o.h], [mb.h / 2, o.h / 2]]) pulls.y.push(o.y + theirs - mine - mb.y + at.y);
    }
    for (const axis of ['x', 'y']) {
      let pick = null;
      for (const v of pulls[axis]) {
        if (Math.abs(v - at[axis]) > snap) continue;
        const p = { ...at, [axis]: Math.round(v) };
        if (!clear(p) || !touching(p)) continue;
        if (pick === null || Math.abs(v - at[axis]) < Math.abs(pick - at[axis])) pick = p[axis];
      }
      if (pick !== null) at[axis] = pick;
    }
    return { x: Math.round(at.x), y: Math.round(at.y) };
  }

  const api = { SIDES, OPPOSITE, MIN_TOUCH, normalize, bounds, screensOf, placed, fromCells, complete, stretches, spanOf, zonesText, sidesOf, cross, drop };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LayoutWorld = api;
})(typeof self !== 'undefined' ? self : this);

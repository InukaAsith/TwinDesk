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
  // skip: an offline computer is passed through (true, the default) or stops the pointer (false). Pieces
  // an offline computer stops (skip off, or nothing beyond it) are in out.blocked: [{ side, from, to, at,
  // dev }] (the Multi-device tab draws them red); they lead nowhere.
  function stretches(world, displays, ids, selfId, present = () => true, phone = () => false, skip = true) {
    const all = placed(world, displays, ids, phone);
    const mine = all.filter((m) => m.dev === selfId);
    const others = all.filter((m) => m.dev !== selfId);
    const out = { left: [], right: [], top: [], bottom: [] };
    const blocked = [];
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
            let front = e, best = null, stop = null;
            for (let step = 0; step < MAX_DEVICES * 8 && !best; step++) {
              const touchingNow = here.filter((c) => Math.abs(ahead(c, side, front)) < 1);
              if (!touchingNow.length) break;
              const live = touchingNow.filter((c) => present(c.dev)).sort((u, v) => (u.dev < v.dev ? -1 : u.dev > v.dev ? 1 : 0));
              if (live.length) { best = live[0]; break; }
              const pc = touchingNow.filter((c) => !phone(c.dev)).sort((u, v) => (u.dev < v.dev ? -1 : 1))[0];
              if (pc && !stop) stop = pc; // the first offline computer on the way
              if (!skip) break;
              const next = touchingNow.reduce((f, c) => (Math.abs(far(c, side) - e) > Math.abs(f - e) ? far(c, side) : f), front);
              if (next === front) break;
              front = next;
            }
            if (!best) {
              if (stop) {
                const lb = blocked[blocked.length - 1];
                if (lb && lb.side === side && lb.dev === stop.dev && lb.at === e && Math.abs(lb.to - p) < 1) lb.to = q;
                else blocked.push({ side, from: p, to: q, at: e, dev: stop.dev });
              }
              continue;
            }
            const gap = Math.abs(front - e);
            const last = res[res.length - 1];
            if (last && last.dev === best.dev && last.display === best.id && last.at === e && Math.abs(last.to - p) < 1) last.to = q;
            else res.push({ from: p, to: q, at: e, dev: best.dev, display: best.id, gap }); // at: our edge's line
          }
        }
      }
      out[side] = res.filter((s) => s.to - s.from >= 8).sort((u, v) => u.from - v.from); // slivers (rounding) aren't a way
    }
    Object.defineProperty(out, 'blocked', { value: blocked.filter((b) => b.to - b.from >= 8), enumerable: false });
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
  function cross(world, displays, ids, fromId, side, offset, present = () => true, phone = () => false, skip = true) {
    if (!SIDES.includes(side)) return null;
    const st = stretches(world, displays, ids, fromId, present, phone, skip)[side];
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
    if (phone(id)) { const sub = {}; for (const k of rest) sub[k] = world[k]; return leaf(sub, displays, id, { x, y }, phone); }
    return fit(placed(world, displays, rest, phone), (p) => placed({ [id]: p }, displays, [id], phone), { x, y }, snap);
  }

  // Where a group of monitors may go, among `others`: mineAt(p) gives the group's monitors with its
  // origin at p, start is where it was put. Off the others, touching one, aligned within snap.
  function fit(others, mineAt, start, snap) {
    const at = { x: Math.round(start.x), y: Math.round(start.y) };
    if (!others.length) return at;
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

  // How long a piece of edge two monitors share (0: they don't touch).
  function shared(m, o) {
    const h = Math.min(m.y + m.h, o.y + o.h) - Math.max(m.y, o.y), w = Math.min(m.x + m.w, o.x + o.w) - Math.max(m.x, o.x);
    if (h >= 1 && (Math.abs(m.x + m.w - o.x) < 1 || Math.abs(o.x + o.w - m.x) < 1)) return h;
    if (w >= 1 && (Math.abs(m.y + m.h - o.y) < 1 || Math.abs(o.y + o.h - m.y) < 1)) return w;
    return 0;
  }

  // A group of monitors (base, where they are) moved flush against the others: one of its monitors
  // against a side of one of theirs, lined up at the start, the end or the middle, or where it is
  // along it. The move that is short and gives a real shared edge (half the shorter side, or more)
  // wins over one that only touches by a sliver. Returns the move { x, y }, or null.
  function dock(others, base) {
    let best = null;
    for (const g of base) {
      for (const m of others) {
        for (const side of SIDES) {
          const v = vertical(side);
          const dAcross = side === 'right' ? m.x + m.w - g.x : side === 'left' ? m.x - (g.x + g.w) : side === 'bottom' ? m.y + m.h - g.y : m.y - (g.y + g.h);
          const g0 = v ? g.y : g.x, gl = v ? g.h : g.w, m0 = v ? m.y : m.x, ml = v ? m.h : m.w;
          const t = Math.min(MIN_TOUCH, gl, ml);
          const alongs = [m0 - g0, m0 + ml - gl - g0, m0 + (ml - gl) / 2 - g0, Math.max(m0 - gl + t, Math.min(m0 + ml - t, g0)) - g0];
          for (const a of alongs) {
            const d = v ? { x: dAcross, y: Math.round(a) } : { x: Math.round(a), y: dAcross };
            const moved = base.map((b) => ({ ...b, x: b.x + d.x, y: b.y + d.y }));
            if (moved.some((b) => others.some((o) => overlap(b, o)))) continue;
            let contact = 0, need = 0;
            for (const b of moved) for (const o of others) { const c = shared(b, o); if (c) { contact += c; need = Math.max(need, Math.min(vertical(side) ? b.h : b.w, vertical(side) ? o.h : o.w) / 2); } }
            if (!contact) continue;
            const cost = Math.hypot(d.x, d.y) + 4 * Math.max(0, need - contact);
            if (!best || cost < best.cost) best = { d, cost };
          }
        }
      }
    }
    return best && best.d;
  }

  // Two monitors side by side or one above the other, sharing a piece of edge.
  function touches(m, o) {
    const h = Math.min(m.y + m.h, o.y + o.h) - Math.max(m.y, o.y), w = Math.min(m.x + m.w, o.x + o.w) - Math.max(m.x, o.x);
    return (h >= 1 && (Math.abs(m.x + m.w - o.x) < 1 || Math.abs(o.x + o.w - m.x) < 1)) || (w >= 1 && (Math.abs(m.y + m.h - o.y) < 1 || Math.abs(o.y + o.h - m.y) < 1));
  }

  // The devices in groups that touch: [[id, …], …], each group in id order.
  function groupsOf(world, displays, ids, phone = () => false) {
    const mons = placed(world, displays, ids, phone);
    const up = {};
    const find = (k) => (up[k] === k ? k : (up[k] = find(up[k])));
    for (const id of ids) if (world[id]) up[id] = id;
    for (let i = 0; i < mons.length; i++) {
      for (let j = i + 1; j < mons.length; j++) {
        if (mons[i].dev !== mons[j].dev && touches(mons[i], mons[j])) up[find(mons[i].dev)] = find(mons[j].dev);
      }
    }
    const by = {};
    for (const id of Object.keys(up).sort()) (by[find(id)] = by[find(id)] || []).push(id);
    return Object.values(by);
  }

  // Where a phone goes, near `want`: against the outer edge of one computer's monitor, touching that
  // computer and nothing else. Phones are leaves: one between two computers would cut the line the
  // pointer takes from one to the other (it ends a chain, L.reach), so it never sits there, nor
  // against another phone. world: the others, already placed.
  function leaf(world, displays, id, want, phone = () => false) {
    const others = placed(world, displays, Object.keys(world), phone);
    const pcs = others.filter((m) => !phone(m.dev));
    const at = { x: Math.round(want.x), y: Math.round(want.y) };
    if (!pcs.length) return at;
    const mineAt = (p) => placed({ [id]: p }, displays, [id], phone);
    const mb = bounds(mineAt({ x: 0, y: 0 }));
    let best = null;
    for (const m of pcs) {
      for (const side of SIDES) {
        const v = vertical(side);
        const len = v ? mb.h : mb.w, mlen = v ? m.h : m.w, m0 = v ? m.y : m.x, w0 = v ? at.y : at.x;
        const t = Math.min(MIN_TOUCH, len, mlen);
        const lo = m0 - len + t, hi = m0 + mlen - t;
        const alongs = [Math.max(lo, Math.min(hi, w0)), m0, m0 + mlen - len, m0 + (mlen - len) / 2].filter((a) => a >= lo - 0.5 && a <= hi + 0.5);
        const across = side === 'right' ? m.x + m.w : side === 'left' ? m.x - mb.w : side === 'bottom' ? m.y + m.h : m.y - mb.h;
        for (const a of alongs) {
          const p = v ? { x: across, y: Math.round(a) } : { x: Math.round(a), y: across };
          const mine = mineAt(p);
          if (mine.some((mm) => others.some((o) => overlap(mm, o)))) continue;
          const devs = new Set(others.filter((o) => mine.some((mm) => touches(mm, o))).map((o) => o.dev));
          if (devs.size !== 1 || !devs.has(m.dev)) continue;
          // Short, and against a real piece of the edge (half the phone's side, or the monitor's), not a sliver.
          const contact = mine.reduce((n, mm) => n + others.reduce((k, o) => k + shared(mm, o), 0), 0);
          const cost = Math.hypot(p.x - at.x, p.y - at.y) + 4 * Math.max(0, Math.min(len, mlen) / 2 - contact);
          if (!best || cost < best.cost) best = { p, cost };
        }
      }
    }
    return best ? best.p : at;
  }

  // The world in one piece, with no monitor over another: a device whose monitors changed size (or
  // that came in at the corner of the others) leaves no gap or overlap, and a device dragged out of a
  // row leaves no hole in it (the rest close up). Overlaps first, in id order (`keep` first: it stays
  // where it is); then every group apart slides to touch the others, the nearest first, the biggest
  // group (or keep's) staying. Every device computes the same from the same world and displays.
  function settle(world, displays, ids, phone = () => false, keep = null) {
    const here = ids.filter((id) => world[id]).sort();
    const order = here.filter((id) => !phone(id)); // the computers first, in one piece by themselves
    if (keep && order.includes(keep)) order.unshift(...order.splice(order.indexOf(keep), 1));
    const out = {};
    for (const id of order) {
      const others = placed(out, displays, Object.keys(out), phone);
      const mineAt = (p) => placed({ [id]: p }, displays, [id], phone);
      const at = world[id];
      out[id] = mineAt(at).some((m) => others.some((o) => overlap(m, o))) ? fit(others, mineAt, at, 0) : { x: at.x, y: at.y };
    }
    for (let round = 0; round < 2 * MAX_DEVICES; round++) {
      const groups = groupsOf(out, displays, order, phone);
      if (groups.length < 2) break;
      groups.sort((a, b) => (keep ? b.includes(keep) - a.includes(keep) : 0) || b.length - a.length || (a[0] < b[0] ? -1 : 1));
      const main = bounds(placed(out, displays, groups[0], phone));
      const gap = (b) => Math.hypot(Math.max(0, b.x - (main.x + main.w), main.x - (b.x + b.w)), Math.max(0, b.y - (main.y + main.h), main.y - (b.y + b.h)));
      const g = groups.slice(1).map((ids2) => ({ ids: ids2, d: gap(bounds(placed(out, displays, ids2, phone))) })).sort((a, b) => a.d - b.d)[0].ids;
      const base = placed(out, displays, g, phone);
      const others = placed(out, displays, order.filter((k) => !g.includes(k)), phone);
      const shifted = (p) => base.map((m) => ({ ...m, x: m.x + p.x, y: m.y + p.y }));
      let d = dock(others, base) || fit(others, shifted, { x: 0, y: 0 }, 0);
      if (!shifted(d).some((m) => others.some((o) => touches(m, o)))) {
        // Nowhere straight ahead: beside the main group's rightmost monitor, at its top.
        const right = placed(out, displays, groups[0], phone).sort((a, b) => b.x + b.w - (a.x + a.w) || a.y - b.y)[0];
        const gb = bounds(base);
        d = fit(others, shifted, { x: right.x + right.w - gb.x, y: right.y - gb.y }, 0);
      }
      for (const k of g) out[k] = { x: out[k].x + d.x, y: out[k].y + d.y };
    }
    // Then the phones, each a leaf on one computer (keep's first, so it goes where it was dropped).
    const phones = here.filter((id) => phone(id));
    if (keep && phones.includes(keep)) phones.unshift(...phones.splice(phones.indexOf(keep), 1));
    for (const id of phones) out[id] = leaf(out, displays, id, world[id], phone);
    return out;
  }

  const api = { SIDES, OPPOSITE, MIN_TOUCH, normalize, bounds, screensOf, placed, fromCells, complete, stretches, spanOf, zonesText, sidesOf, cross, drop, settle, groupsOf, leaf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LayoutWorld = api;
})(typeof self !== 'undefined' ? self : this);

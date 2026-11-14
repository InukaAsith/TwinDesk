// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The crossing map (one-to-one): where two computers' monitors touch, and where the pointer lands.
// Each computer reports its displays (kvm.displays, shared/screen-mesh.js normalizeDisplays: OS
// coordinates, points). The arrangement is `{side, along}`: the other computer is on `side` of this
// one, and its bounding box starts `along` points further along that side than ours (down for left
// and right, across for top and bottom). The other computer stores `{side: opposite, along: -along}`.
//
// Across the side, the other computer slides in until one of its monitors meets one of ours (as in
// the system's display settings: never overlapping, never a gap). Where a monitor of each meets,
// edge to edge, is a stretch. The pointer crosses only inside a stretch and lands at the same
// position along it on the other side. The helpers know nothing of this: they get the stretches as
// zones (0–1 along their side, measured on the bounding box, what they already report as `offset`),
// and main maps an offset on one side to the offset on the other (mapOffset).
//
// Pure JavaScript, no I/O: CommonJS in main and tests, a plain <script> in renderers (window.KvmGeom).
(function (root) {
  'use strict';

  const SIDES = ['left', 'right', 'top', 'bottom'];
  const OPPOSITE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
  const MIN_TOUCH = 40; // points: less than this along a side doesn't count as touching
  const SNAP = 24; // points: aligning edges or centres pulls the other computer in from this far
  const STEP = 8; // points: how finely snap looks for the nearest place that touches

  const vertical = (side) => side === 'left' || side === 'right';

  // The rectangle every display covers together: { x, y, w, h }. Empty list: null.
  function bounds(displays) {
    if (!displays || !displays.length) return null;
    const x0 = Math.min(...displays.map((d) => d.x));
    const y0 = Math.min(...displays.map((d) => d.y));
    const x1 = Math.max(...displays.map((d) => d.x + d.w));
    const y1 = Math.max(...displays.map((d) => d.y + d.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Start and length of the bounding box along `side`.
  function span(displays, side) {
    const b = bounds(displays);
    if (!b) return null;
    return vertical(side) ? { start: b.y, len: b.h } : { start: b.x, len: b.w };
  }

  // A display's extent along the side, and across it: [smaller coordinate, larger].
  const along = (d, side) => (vertical(side) ? [d.y, d.y + d.h] : [d.x, d.x + d.w]);
  const across = (d, side) => (vertical(side) ? [d.x, d.x + d.w] : [d.y, d.y + d.h]);

  // Where the other computer's displays go in our coordinates: { x, y } to add to theirs. Along the
  // side from `along`; across it, as close as it gets without overlapping one of ours. Null: unknown.
  function placement(mine, theirs, arrange) {
    if (!arrange || !SIDES.includes(arrange.side)) return null;
    const mb = bounds(mine), tb = bounds(theirs);
    if (!mb || !tb) return null;
    const side = arrange.side, v = vertical(side);
    const shiftAlong = (v ? mb.y : mb.x) + (arrange.along || 0) - (v ? tb.y : tb.x);
    const out = side === 'right' || side === 'bottom'; // theirs goes toward larger coordinates
    let shiftAcross = null;
    for (const m of mine) {
      const [ma, mz] = along(m, side), [mlo, mhi] = across(m, side);
      for (const t of theirs) {
        const [ta, tz] = along(t, side), [tlo, thi] = across(t, side);
        if (Math.min(mz, tz + shiftAlong) - Math.max(ma, ta + shiftAlong) <= 0) continue; // side by side, never meet
        const s = out ? mhi - tlo : mlo - thi;
        if (shiftAcross === null || (out ? s > shiftAcross : s < shiftAcross)) shiftAcross = s;
      }
    }
    if (shiftAcross === null) { // nothing faces anything: against the bounding box
      const [blo, bhi] = across({ x: mb.x, y: mb.y, w: mb.w, h: mb.h }, side), [tlo, thi] = across({ x: tb.x, y: tb.y, w: tb.w, h: tb.h }, side);
      shiftAcross = out ? bhi - tlo : blo - thi;
    }
    return v ? { x: shiftAcross, y: shiftAlong } : { x: shiftAlong, y: shiftAcross };
  }

  // The touching stretches: [{mine: {display, from, to}, theirs: {display, from, to}}], each in its
  // own computer's coordinates along the side, in order along the side.
  function contact(mine, theirs, arrange) {
    const p = placement(mine, theirs, arrange);
    if (!p) return [];
    const side = arrange.side, v = vertical(side), out = side === 'right' || side === 'bottom';
    const sa = v ? p.y : p.x, sx = v ? p.x : p.y;
    const res = [];
    for (const m of mine) {
      const [ma, mz] = along(m, side), [mlo, mhi] = across(m, side);
      for (const t of theirs) {
        const [ta, tz] = along(t, side), [tlo, thi] = across(t, side);
        if (Math.abs(out ? tlo + sx - mhi : thi + sx - mlo) >= 1) continue; // not edge to edge
        const lo = Math.max(ma, ta + sa), hi = Math.min(mz, tz + sa);
        if (hi - lo < 1) continue;
        res.push({ mine: { display: m.id, from: lo, to: hi }, theirs: { display: t.id, from: lo - sa, to: hi - sa } });
      }
    }
    return res.sort((a, c) => a.mine.from - c.mine.from);
  }

  // The longest stretch for an arrangement (0: they don't touch).
  const touch = (mine, theirs, arrange) => contact(mine, theirs, arrange).reduce((n, c) => Math.max(n, c.mine.to - c.mine.from), 0);

  // 0–1 along a stretch, for our coordinate `pointAlong` (clamped to the stretch).
  function exitPoint(stretch, pointAlong) {
    const { from, to } = stretch.mine;
    return Math.min(1, Math.max(0, (pointAlong - from) / Math.max(1e-9, to - from)));
  }

  // Their coordinate along the side for `t` (0–1) along a stretch.
  function entryPoint(stretch, t) {
    const { from, to } = stretch.theirs;
    return from + Math.min(1, Math.max(0, t)) * (to - from);
  }

  // The stretches as zones for the helper: [[from, to]] as 0–1 of our bounding box along the side.
  function zones(mine, theirs, arrange) {
    const s = span(mine, arrange && arrange.side);
    if (!s) return [];
    const f = (a) => Math.min(1, Math.max(0, (a - s.start) / Math.max(1, s.len)));
    const out = [];
    for (const c of contact(mine, theirs, arrange)) {
      const z = [f(c.mine.from), f(c.mine.to)];
      const last = out[out.length - 1];
      if (last && z[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], z[1]);
      else out.push(z);
    }
    return out;
  }

  // Zones as the helpers read them (their JSON readers skip arrays): "0.1250-0.5000,0.7500-1.0000".
  // No stretches: "none" (nothing crosses). Unknown layout (no displays from the other side): null.
  function zonesText(mine, theirs, arrange) {
    if (!bounds(mine) || !bounds(theirs) || !arrange) return null;
    const z = zones(mine, theirs, arrange);
    return z.length ? z.map(([a, b]) => `${a.toFixed(4)}-${b.toFixed(4)}`).join(',') : 'none';
  }

  // Our offset (0–1 along our side, what the helper reports) to theirs (0–1 along their facing side,
  // where their helper lands the pointer): the same position along the touching stretch. Outside
  // every stretch it uses the nearest one. Unknown layout: the offset unchanged.
  function mapOffset(mine, theirs, arrange, offset) {
    const cs = contact(mine, theirs, arrange);
    if (!cs.length) return offset;
    const m = span(mine, arrange.side), t = span(theirs, arrange.side);
    const a = m.start + Math.min(1, Math.max(0, offset)) * m.len;
    const dist = (c) => (a < c.mine.from ? c.mine.from - a : a > c.mine.to ? a - c.mine.to : 0);
    const c = cs.reduce((best, x) => (dist(x) < dist(best) ? x : best));
    const b = entryPoint(c, exitPoint(c, a));
    return Math.min(1, Math.max(0, (b - t.start) / Math.max(1, t.len)));
  }

  // The other computer centred on ours along `side`.
  function centred(mine, theirs, side) {
    const m = span(mine, side), t = span(theirs, side);
    return m && t ? Math.round((m.len - t.len) / 2) : 0;
  }

  // Pick the arrangement closest to the dragged group's bounding-box origin. Using the centres of
  // the two bounding boxes misidentifies the side when their displays form an irregular shape.
  function closestSide(mine, theirs, x, y, previous) {
    const mb = bounds(mine), tb = bounds(theirs);
    if (!mb || !tb || !Number.isFinite(x) || !Number.isFinite(y)) return previous || 'right';
    let best = null;
    for (const side of SIDES) {
      const a = vertical(side) ? y - mb.y : x - mb.x;
      const p = placement(mine, theirs, { side, along: a });
      const distance = Math.hypot(p.x + tb.x - x, p.y + tb.y - y);
      if (!best || distance < best.distance - 1e-6 || (Math.abs(distance - best.distance) <= 1e-6 && side === previous)) best = { side, distance };
    }
    return best.side;
  }

  // `along` moved to the nearest place where the two touch by at least MIN_TOUCH (or all of the
  // shorter monitor), and pulled onto aligned monitor edges or centres within SNAP points.
  function snap(mine, theirs, side, value) {
    const m = span(mine, side), t = span(theirs, side);
    if (!m || !t) return value;
    const shortest = Math.min(...mine.map((d) => along(d, side)[1] - along(d, side)[0]), ...theirs.map((d) => along(d, side)[1] - along(d, side)[0]));
    const need = Math.min(MIN_TOUCH, shortest) - 1e-6;
    const ok = (a) => touch(mine, theirs, { side, along: a }) >= need;
    let v = value;
    if (!ok(v)) {
      let found = null;
      for (let d = STEP, lim = m.len + t.len; d <= lim && found === null; d += STEP) {
        if (ok(value - d)) found = value - d;
        else if (ok(value + d)) found = value + d;
      }
      if (found === null) return Math.round(value);
      // Close in on the exact limit between STEP points.
      let lo = found, hi = found > value ? found - STEP : found + STEP; // ok at lo, not at hi
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        if (ok(mid)) lo = mid; else hi = mid;
      }
      v = lo;
    }
    // Aligned starts, ends and centres of the boxes and of each pair of monitors.
    const marks = [0, m.len - t.len, (m.len - t.len) / 2];
    for (const a of mine) {
      for (const b of theirs) {
        const [af, at] = along(a, side), [bf, bt] = along(b, side);
        marks.push(af - bf - m.start + t.start, at - bt - m.start + t.start, (af + at - bf - bt) / 2 - m.start + t.start);
      }
    }
    let pull = null;
    for (const k of marks) if (Math.abs(k - v) <= SNAP && ok(k) && (pull === null || Math.abs(k - v) < Math.abs(pull - v))) pull = k;
    return Math.round(pull !== null ? pull : v);
  }

  // A saved arrangement made valid: `along` null (or missing) means centred.
  function normalize(arrange, mine, theirs) {
    const side = arrange && SIDES.includes(arrange.side) ? arrange.side : 'right';
    const a = arrange && typeof arrange.along === 'number' && Number.isFinite(arrange.along) ? arrange.along : null;
    const known = bounds(mine) && bounds(theirs);
    if (a === null) return { side, along: known ? snap(mine, theirs, side, centred(mine, theirs, side)) : centred(mine, theirs, side) };
    return { side, along: known ? snap(mine, theirs, side, a) : a };
  }

  // Display ids in the order they are numbered (1, 2, …): left to right, then top to bottom. The map
  // and Identify use the same numbers.
  function numbered(displays) {
    return (displays || []).slice().sort((a, b) => a.x - b.x || a.y - b.y).map((d) => d.id);
  }

  // The arrangement as the other computer sees it.
  function mirror(arrange) {
    return { side: OPPOSITE[arrange.side], along: arrange.along === null ? null : -arrange.along };
  }

  const api = { SIDES, OPPOSITE, MIN_TOUCH, bounds, span, placement, contact, exitPoint, entryPoint, zones, zonesText, mapOffset, centred, closestSide, snap, normalize, mirror, numbered };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KvmGeom = api;
})(typeof self !== 'undefined' ? self : this);

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A touchpad's pinch on an Android phone (#222, #228): the zoom gesture (`k.ge` g 'zoom', v the
// change of magnification since the last one, phase begin | change | end, from a Mac trackpad or a
// Linux touchpad, linux-helper/src/wl.c) becomes two fingers on the phone's screen, on each side of
// the pointer along the long side, that move apart or together.
//   With wireless debugging (scrcpy's control channel, ctl.touch) the fingers stay down for the whole
//   pinch; scrcpy's server makes the second one a pointer-down.
//   Without it (shared/phoneinput.js, ctl.pinch) Accessibility can't hold a touch open across
//   messages: every PINCH_MS of pinching goes as one two-finger stroke.
// The fingers start at least 1.2 inches (30 mm) apart: Android's ScaleGestureDetector ignores two
// fingers closer than about 27 mm, so a pinch in from nearer never zoomed. At the edge of the room
// they lift and come down again where there's room, so a long pinch keeps zooming.
//   const p = new Pinch(); p.feed(ctl, msg, {x, y, buttons}, {w, h, dpi}) -> true when it was a zoom
//   p.active: fingers are down (the bridge holds the pointer and the wheel meanwhile); p.cancel()
'use strict';

const ACTION = { DOWN: 0, UP: 1, MOVE: 2 }; // scrcpy's (../<platform>/scrcpy.js)
const IDS = [1001, 1002]; // the two fingers: not the mouse (-1) or a phone view's (0…9)
const IDLE_MS = 600; // no `end` came (the link dropped it): the fingers lift by themselves
const PINCH_MS = 150; // Accessibility: one stroke per this much pinching
const NEAR_IN = 0.6; // each finger this far from the middle at the nearest (1.2 in apart)
const FAR_IN = 1.6; // … and at most this far

// Where the two fingers go on this screen, for a pinch at `at`.
function room(at, d) {
  const w = d.w, h = d.h, short = Math.min(w, h);
  // No dpi from an old app: a phone's short side is about 2.7 inches.
  const dpi = Number(d.dpi) > 50 && Number(d.dpi) < 2000 ? Number(d.dpi) : short / 2.7;
  const margin = Math.max(8, Math.round(dpi * 0.3)); // off the edges, where the system's gestures are
  const vertical = h > w; // along the long side: portrait, up and down
  const length = vertical ? h : w, cross = vertical ? w : h;
  let max = Math.min((length - 2 * margin) / 2 - 1, length * 0.3, dpi * FAR_IN);
  let min = Math.min(dpi * NEAR_IN, max * 0.6);
  max = Math.max(max, 9); min = Math.max(4, Math.min(min, max - 4));
  const pa = Number(vertical ? at.y : at.x), pc = Number(vertical ? at.x : at.y);
  const along = Math.max(margin + max, Math.min(length - 1 - margin - max, Number.isFinite(pa) ? pa : length / 2));
  const across = Math.max(margin, Math.min(cross - 1 - margin, Number.isFinite(pc) ? pc : cross / 2));
  return { x: vertical ? across : along, y: vertical ? along : across, vertical, min, max };
}

class Pinch {
  constructor() {
    this.on = false; // fingers down (scrcpy)
    this.batch = null; // a stroke being gathered (Accessibility)
    this.timer = null;
  }

  get active() { return this.on || !!this.batch; }

  feed(ctl, m, at, d) {
    if (!m || m.g !== 'zoom') return false;
    if (m.phase === 'end') { this._end(); return true; }
    // A button held is a drag, not a pinch; nothing to put the fingers on: let go.
    if (!ctl || !at || at.buttons || !d || !(d.w > 0) || !(d.h > 0)) { this._end(); return true; }
    if (m.phase === 'begin') this._end();
    if (this.active && (this.ctl !== ctl || this.d.w !== d.w || this.d.h !== d.h)) this._end(); // another session or a turn
    const v = Number(m.v);
    if (Number.isFinite(v) && v !== 0) {
      const k = Math.max(0.5, Math.min(2, 1 + v)); // the fingers' gap changes as the magnification does
      if (typeof ctl.touch === 'function') this._touch(ctl, at, d, v, k);
      else if (typeof ctl.pinch === 'function') this._stroke(ctl, at, d, v, k);
    }
    if (this.on) this._idle();
    return true;
  }

  cancel() {
    if (this.batch) { clearTimeout(this.batch.timer); this.batch = null; }
    this._up();
  }

  // ---- scrcpy: two fingers held ----

  _touch(ctl, at, d, v, k) {
    if (!this.on) this._down(ctl, at, d, v);
    let r = this.r * k;
    // At the edge of the room and still going: lift, and come down again where there's room.
    if ((v > 0 && r > this.g.max && this.r >= this.g.max - 0.5) || (v < 0 && r < this.g.min && this.r <= this.g.min + 0.5)) {
      this._up();
      this._down(ctl, at, d, v);
      r = this.r * k;
    }
    this.r = Math.max(this.g.min, Math.min(this.g.max, r));
    this._at(ACTION.MOVE);
  }

  _down(ctl, at, d, v) {
    this.g = room(at, d);
    this.r = v > 0 ? this.g.min : this.g.max; // spreading starts near, pinching in starts far
    Object.assign(this, { ctl, d, on: true });
    this._at(ACTION.DOWN);
  }

  _at(action) {
    const { ctl, d, g, r } = this;
    for (const [i, s] of [[0, -1], [1, 1]]) ctl.touch(action, IDS[i], g.vertical ? g.x : g.x + s * r, g.vertical ? g.y + s * r : g.y, d.w, d.h);
  }

  _idle() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._end(), IDLE_MS);
    if (this.timer.unref) this.timer.unref();
  }

  _up() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.on) return;
    this.on = false;
    try { this._at(ACTION.UP); } catch (_) { /* the session went */ }
  }

  // ---- Accessibility: one stroke per PINCH_MS ----

  _stroke(ctl, at, d, v, k) {
    let b = this.batch;
    if (b && Math.sign(v) !== b.dir) { this._flush(); b = null; } // the other way: a stroke of its own
    if (!b) {
      const g = room(at, d);
      const from = v > 0 ? g.min : g.max;
      b = this.batch = { ctl, d, g, dir: Math.sign(v), from, to: from, timer: setTimeout(() => this._flush(), PINCH_MS) };
      Object.assign(this, { ctl, d });
    }
    b.to = Math.max(b.g.min, Math.min(b.g.max, b.to * k));
  }

  _flush() {
    const b = this.batch;
    if (!b) return;
    clearTimeout(b.timer);
    this.batch = null;
    if (Math.abs(b.to - b.from) >= 2) {
      try { b.ctl.pinch(b.g.x, b.g.y, b.from, b.to, b.g.vertical); } catch (_) { /* the session went */ }
    }
  }

  _end() {
    this._flush();
    this._up();
  }
}

module.exports = { Pinch, room };

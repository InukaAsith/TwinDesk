// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A touchpad's pinch on an Android phone (#222): the zoom gesture (`k.ge` g 'zoom', v the change of
// magnification since the last one, phase begin | change | end, from a Mac trackpad or a Linux
// touchpad, linux-helper/src/wl.c) becomes two fingers on the phone's screen, on each side of the
// pointer, that move apart or together. scrcpy's server makes the second finger a pointer-down.
//   const p = new Pinch(); p.feed(ctl, msg, {x, y}, {w, h}) -> true when the message was a zoom
'use strict';

const ACTION = { DOWN: 0, UP: 1, MOVE: 2 }; // scrcpy's (../<platform>/scrcpy.js)
const IDS = [1001, 1002]; // the two fingers: not the mouse (-1) or a phone view's (0…9)
const IDLE_MS = 600; // no `end` came (the link dropped it): the fingers lift by themselves

class Pinch {
  constructor() {
    this.on = false;
    this.timer = null;
  }

  feed(ctl, m, at, d) {
    if (!m || m.g !== 'zoom') return false;
    if (!ctl || !at || !d || !(d.w > 0) || !(d.h > 0)) return true;
    if (m.phase === 'end') { this._up(); return true; }
    if (!this.on || m.phase === 'begin') this._down(ctl, at, d);
    const v = Number(m.v);
    if (Number.isFinite(v) && v !== 0) {
      this.r = Math.max(this.min, Math.min(this.max, this.r * Math.max(0.5, Math.min(2, 1 + v))));
      this._at(ACTION.MOVE);
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._up(), IDLE_MS);
    if (this.timer.unref) this.timer.unref();
    return true;
  }

  _down(ctl, at, d) {
    if (this.on) this._up();
    const short = Math.min(d.w, d.h);
    this.min = Math.max(8, short * 0.03);
    this.max = short * 0.45;
    // The middle, at the pointer but far enough from the sides that both fingers stay on the screen.
    const room = Math.min(this.max, short * 0.12);
    this.cx = Math.max(room + 1, Math.min(d.w - room - 1, Number(at.x) || d.w / 2));
    this.cy = Math.max(1, Math.min(d.h - 1, Number(at.y) || d.h / 2));
    this.max = Math.min(this.max, this.cx - 1, d.w - 1 - this.cx);
    this.r = Math.min(room, this.max);
    Object.assign(this, { ctl, d, on: true });
    this._at(ACTION.DOWN);
  }

  _at(action) {
    const { ctl, d } = this;
    ctl.touch(action, IDS[0], this.cx - this.r, this.cy, d.w, d.h);
    ctl.touch(action, IDS[1], this.cx + this.r, this.cy, d.w, d.h);
  }

  _up() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.on) return;
    this.on = false;
    try { this._at(ACTION.UP); } catch (_) { /* the session went */ }
  }
}

module.exports = { Pinch };

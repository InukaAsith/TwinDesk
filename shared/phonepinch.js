// TwinDesk — Copyright (C) 2026. GPL-3.0, see LICENSE.
// Translate one trackpad pinch into two bounded scrcpy touch contacts.
'use strict';
class PhonePinch {
  constructor() { this.active = null; this.timer = null; this.blocked = false; }
  end() {
    clearTimeout(this.timer); this.timer = null;
    const s = this.active; this.active = null;
    if (!s || s.ctl.closed) return;
    for (const id of [1, 0]) {
      const offset = id ? s.r : -s.r;
      s.ctl.touch(1, id, s.x + (s.horizontal ? offset : 0), s.y + (s.horizontal ? 0 : offset), s.w, s.h, 0);
    }
  }
  cancel() { this.end(); this.blocked = true; }
  gesture(ctl, display, pointer, msg) {
    if (msg.phase === 'begin') this.blocked = false;
    if (msg.phase === 'end') { this.end(); return; }
    if (this.blocked) return;
    if (!ctl || ctl.closed || typeof ctl.touch !== 'function' || !display || !pointer || pointer.buttons || pointer.mouse === false) { this.cancel(); return; }
    const w = Number(display.w), h = Number(display.h);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 64 || h < 64 || w > 65535 || h > 65535) { this.cancel(); return; }
    if (this.active && (this.active.ctl !== ctl || this.active.w !== w || this.active.h !== h)) { this.cancel(); return; }
    const v = Number(msg.v);
    if (!Number.isFinite(v) || v === 0) return;
    if (!this.active) {
      const dpi = Number(display.dpi) > 0 && Number(display.dpi) < 2000 ? Number(display.dpi) : 160;
      const margin = Math.max(8, Math.ceil(dpi * 48 / 160));
      const horizontal = w >= h, length = horizontal ? w : h, cross = horizontal ? h : w;
      const min = Math.ceil(dpi * 0.6), max = Math.floor(Math.min((length - 2 * margin - 2) / 2, length * 0.3, dpi * 1.6));
      if (min >= max || cross <= 2 * margin) { this.cancel(); return; }
      const r = v > 0 ? min : max;
      const along = Math.max(margin + max, Math.min(length - 1 - margin - max, Number(horizontal ? pointer.x : pointer.y) || 0));
      const across = Math.max(margin, Math.min(cross - 1 - margin, Number(horizontal ? pointer.y : pointer.x) || 0));
      const x = horizontal ? along : across, y = horizontal ? across : along;
      this.active = { ctl, x, y, w, h, r, min, max, horizontal };
      for (const id of [0, 1]) {
        const offset = id ? r : -r;
        ctl.touch(0, id, x + (horizontal ? offset : 0), y + (horizontal ? 0 : offset), w, h);
      }
    }
    const s = this.active;
    const next = s.r * Math.exp(Math.max(-0.5, Math.min(0.5, v)) * 1.6);
    if ((next > s.max && v > 0 && s.r >= s.max) || (next < s.min && v < 0 && s.r <= s.min)) {
      this.end();
      return this.gesture(ctl, display, pointer, { ...msg, phase: 'change' });
    }
    s.r = Math.max(s.min, Math.min(s.max, next));
    for (const id of [0, 1]) {
      const offset = id ? s.r : -s.r;
      ctl.touch(2, id, s.x + (s.horizontal ? offset : 0), s.y + (s.horizontal ? 0 : offset), w, h);
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.end(), 500);
    if (this.timer.unref) this.timer.unref();
  }
}
module.exports = { PhonePinch };

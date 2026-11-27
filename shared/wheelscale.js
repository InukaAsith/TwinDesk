// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Another computer's wheel on this Mac a little faster or slower (Cursor › Scrolling speed here,
// kvm.scrollSpeed, #315): the driving computer's scroll setting doesn't reach the Mac, whose own
// wheel speed only applies to its own mouse. Line steps (wheel notches) and pixels are whole numbers
// once injected, so the fractions are carried to the next event: at 1.5× two notches make three lines,
// at 0.5× every other notch scrolls one.
//   const w = new WheelScale(); w.scale(dx, dy, speed) → { dx, dy } (both 0: nothing to scroll yet)
'use strict';

const MIN = 0.25;
const MAX = 4;

const clampSpeed = (v) => (Number.isFinite(Number(v)) ? Math.max(MIN, Math.min(MAX, Number(v))) : 1);

class WheelScale {
  constructor() {
    this.rx = 0;
    this.ry = 0;
  }

  scale(dx, dy, speed) {
    const f = clampSpeed(speed);
    if (f === 1) return { dx, dy }; // as before: the helper rounds
    this.rx += dx * f;
    this.ry += dy * f;
    const ox = Math.trunc(this.rx);
    const oy = Math.trunc(this.ry);
    this.rx -= ox;
    this.ry -= oy;
    return { dx: ox, dy: oy };
  }
}

module.exports = { WheelScale, clampSpeed, MIN, MAX };

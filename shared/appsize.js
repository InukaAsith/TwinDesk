// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// An app window's virtual display size (mac|windows|linux phoneview.js, scrcpy new_display and its
// resizes): a phone-like shape. Each side a multiple of 16 (what video encoders and camera apps
// expect: some, a phone maker's Camera among them, stop on a size like 873×1917), and no flatter or
// taller than 22:9 either way (a sliver of a window would give a display no app is made for).
// The window shows the picture fitted, so a few pixels' difference is a thin edge at most.
//   appSize(w, h) → [w, h]
'use strict';

const STEP = 16;
const MAX_RATIO = 22 / 9;
const MIN = 320;

function appSize(w, h) {
  w = Math.max(MIN, Number(w) || MIN);
  h = Math.max(MIN, Number(h) || MIN);
  if (h / w > MAX_RATIO) h = w * MAX_RATIO;
  if (w / h > MAX_RATIO) w = h * MAX_RATIO;
  const step = (n) => Math.max(MIN, Math.round(n / STEP) * STEP);
  return [step(w), step(h)];
}

module.exports = { appSize };

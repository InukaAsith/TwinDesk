// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A phone window turning with what it shows (#258), Mac, Windows and Linux phoneview.js.
// An app window: its app runs on a virtual display of the window's size (scrcpy new_display + flex).
// An app that wants landscape (a video in full screen) turns that display round; its picture then
// came in landscape into a portrait window, small between bars. Now the window turns with it, and
// the display keeps its size underneath (the window's resize swaps back while it's turned), so the
// app isn't asked to lay out again. It turns back when the app does.
// The window's Auto-rotate (the side rail, Phone › settings.phone.autoRotate, on unless switched off)
// turns this off: the window keeps its shape. For the phone's screen it's the same: off, the mirror
// window no longer turns when the phone does.
'use strict';

const { appSize } = require('./appsize.js');

const autoRotate = (settings) => ((settings && settings.phone) || {}).autoRotate !== false;

// The picture's size changed (the session's 'size'). Returns true when the window was turned.
function appSized(v, size, auto) {
  const land = size.width > size.height;
  if (v.baseLand === undefined) v.baseLand = land; // the display as it was made
  v.turned = land !== v.baseLand;
  const w = v.win;
  const st = v.stage;
  if (!auto || !st || !w || w.isDestroyed() || w.isFullScreen() || w.isMaximized()) return false;
  if ((st.w > st.h) === land || st.w === st.h) return false;
  const b = w.getContentBounds();
  w.setContentBounds({ x: b.x, y: b.y, width: Math.max(200, Math.round(b.width - st.w + st.h)), height: Math.max(200, Math.round(b.height - st.h + st.w)) });
  return true;
}

// The window's area changed (the renderer's 'resize' {w, h: device pixels, cw, ch: its own}): the
// size for the virtual display, its sides swapped back while the app has it turned round.
function appResized(v, m) {
  if (Number.isFinite(m.cw) && Number.isFinite(m.ch) && m.cw > 0 && m.ch > 0) v.stage = { w: m.cw, h: m.ch };
  let [w, h] = appSize(m.w, m.h);
  if (v.turned) [w, h] = [h, w];
  v.baseLand = w > h;
  return [w, h];
}

module.exports = { autoRotate, appSized, appResized };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/appturn.js (#258): an app window turns with its app's display, and its display keeps its size.
'use strict';
const assert = require('assert');
const { appSized, appResized, autoRotate } = require('../appturn.js');

function win(w, h) {
  const b = { x: 10, y: 20, width: w, height: h };
  return { b, isDestroyed: () => false, isFullScreen: () => false, isMaximized: () => false, getContentBounds: () => ({ ...b }), setContentBounds: (n) => Object.assign(b, n) };
}

// A portrait window (a 40 px bar above its 400 × 720 picture area).
const v = { win: win(400, 760) };
assert.deepStrictEqual(appResized(v, { w: 800, h: 1440, cw: 400, ch: 720 }), [800, 1440]);
assert.strictEqual(appSized(v, { width: 800, height: 1440 }, true), false); // as made: nothing to do
// The app goes landscape: its display turns, the window follows (bar kept).
assert.strictEqual(appSized(v, { width: 1440, height: 800 }, true), true);
assert.deepStrictEqual([v.win.b.width, v.win.b.height], [720, 440]);
// The window's resize that follows: the display keeps its portrait size underneath.
assert.deepStrictEqual(appResized(v, { w: 1440, h: 800, cw: 720, ch: 400 }), [800, 1440]);
assert.strictEqual(appSized(v, { width: 1440, height: 800 }, true), false); // already landscape
// The app turns back: so does the window, and the display stays as it was.
assert.strictEqual(appSized(v, { width: 800, height: 1440 }, true), true);
assert.deepStrictEqual([v.win.b.width, v.win.b.height], [400, 760]);
assert.deepStrictEqual(appResized(v, { w: 800, h: 1440, cw: 400, ch: 720 }), [800, 1440]);
// Made landscape by hand (Rotate the window): the display follows the window, nothing turned.
assert.deepStrictEqual(appResized(v, { w: 1440, h: 800, cw: 720, ch: 400 }), [1440, 800]);
assert.strictEqual(appSized(v, { width: 1440, height: 800 }, true), false);
assert.strictEqual(v.turned, false);
// Auto-rotate off: the window keeps its shape.
const o = { win: win(400, 760) };
appResized(o, { w: 800, h: 1440, cw: 400, ch: 720 });
appSized(o, { width: 800, height: 1440 }, false);
assert.strictEqual(appSized(o, { width: 1440, height: 800 }, false), false);
assert.deepStrictEqual([o.win.b.width, o.win.b.height], [400, 760]);
assert.strictEqual(autoRotate({ phone: {} }), true);
assert.strictEqual(autoRotate({ phone: { autoRotate: false } }), false);
console.log('passed: appturn');

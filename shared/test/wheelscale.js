// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// WheelScale (#315): another computer's wheel scaled on the Mac, fractions carried, never lost.
'use strict';
const assert = require('assert');
const { WheelScale, clampSpeed } = require('../wheelscale.js');

// 1×: untouched, fractions and all (the helper rounds them, as before).
assert.deepStrictEqual(new WheelScale().scale(0.4, -3, 1), { dx: 0.4, dy: -3 });
// 1.5×: two notches make three lines.
let w = new WheelScale();
const sum = (n, dy, f) => { let t = 0; for (let i = 0; i < n; i++) t += w.scale(0, dy, f).dy; return t; };
assert.strictEqual(sum(2, 1, 1.5), 3);
// 0.5×: every other notch scrolls one; nothing is lost.
w = new WheelScale();
assert.deepStrictEqual([1, 2, 3, 4].map(() => w.scale(0, 1, 0.5).dy), [0, 1, 0, 1]);
// Up and down keep their sign, the carried part too.
w = new WheelScale();
assert.strictEqual(sum(4, -1, 0.75), -3);
// 4× pixels from a trackpad.
w = new WheelScale();
assert.deepStrictEqual(w.scale(2, 10, 4), { dx: 8, dy: 40 });
// Out of range or nonsense: clamped, or 1.
assert.strictEqual(clampSpeed(10), 4);
assert.strictEqual(clampSpeed(0), 0.25);
assert.strictEqual(clampSpeed('x'), 1);
console.log('wheelscale: ok');

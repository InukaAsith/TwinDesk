// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/appsize.js: multiples of 16, at least 320, no shape past 22:9.
// Run with: node shared/test/appsize.js
'use strict';
const assert = require('assert');
const { appSize } = require('../appsize.js');
assert.deepStrictEqual(appSize(873, 1917), [880, 1920]);
assert.deepStrictEqual(appSize(824, 1656), [832, 1664]);
for (const [w, h] of [[873, 1917], [100, 5000], [5000, 100], [0, 0], [1999, 1001]]) {
  const [a, b] = appSize(w, h);
  assert.ok(a % 16 === 0 && b % 16 === 0 && a >= 320 && b >= 320, `${w}x${h}`);
  assert.ok(Math.max(a, b) / Math.min(a, b) <= 22 / 9 + 0.05, `${w}x${h} → ${a}x${b}`);
}
console.log('appsize: ok');

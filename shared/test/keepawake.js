// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const { keepAwake } = require('../keepawake.js');
const calls = [];
let n = 0;
const psb = { start: (k) => (calls.push(['start', k]), ++n), stop: (id) => calls.push(['stop', id]) };
let want = false;
const a = keepAwake(() => want, psb);
assert.strictEqual(a.on, false);
want = true; a.update(); a.update();
assert.strictEqual(a.on, true);
want = false; a.update();
assert.deepStrictEqual(calls, [['start', 'prevent-display-sleep'], ['stop', 1]]);
want = true; a.update(); a.stop();
assert.strictEqual(a.on, false);
assert.deepStrictEqual(calls.slice(-1), [['stop', 2]]);
const b = keepAwake(() => { throw new Error('not ready'); }, psb); b.stop();
console.log('keepawake: ok');

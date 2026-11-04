// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tests for shared/pairfail.js: the lockout after repeated failed pairings.
// Run with: node shared/test/pairfail.js
'use strict';

const assert = require('assert');
const { PairFails, MAX } = require('../pairfail.js');

// MAX-1 failures don't lock, the MAXth one does; other addresses are unaffected.
const f = new PairFails();
for (let i = 0; i < MAX - 1; i++) f.fail('192.168.1.9');
assert.ok(!f.locked('192.168.1.9'));
f.fail('192.168.1.9');
assert.ok(f.locked('192.168.1.9'));
assert.ok(!f.locked('192.168.1.10'));

// A successful pairing (clear) lets the address pair again.
f.clear('192.168.1.9');
assert.ok(!f.locked('192.168.1.9'));

// Attempts older than the window fall away.
const real = Date.now;
Date.now = () => real() - 11 * 60 * 1000;
for (let i = 0; i < MAX; i++) f.fail('10.0.0.2');
Date.now = real;
assert.ok(!f.locked('10.0.0.2'));

// Our own Bluetooth/wired pipe never locks.
f.fail('127.0.0.1');
assert.ok(!f.locked('127.0.0.1'));

console.log('pairfail: ok');

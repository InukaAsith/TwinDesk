// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/pairfor.js: one two-way switch for one device of the mesh (#245). The selected device goes by the
// settings; every other one by the pair PairSync remembers for it, or the settings when there is none.
// Run with: node shared/test/pairfor.js
'use strict';

const assert = require('assert');
const { pairFor } = require('../pairfor.js');

const settings = {
  pairSync: {
    B: { audio: { out: true, in: false }, cursor: { out: true, in: true }, values: {} },
    C: { audio: { out: false }, cursor: { out: false, in: false }, values: {} },
  },
};

// The selected device (or none asked about, or no mesh): the settings' switch as it is.
assert.strictEqual(pairFor(settings, 'C', 'C', 'audio', 'out', true), true);
assert.strictEqual(pairFor(settings, 'C', null, 'audio', 'out', false), false);
assert.strictEqual(pairFor(settings, null, undefined, 'cursor', 'out', true), true);

// Another device: its own pair.
assert.strictEqual(pairFor(settings, 'C', 'B', 'audio', 'out', false), true, 'B sends while C (off) is selected');
assert.strictEqual(pairFor(settings, 'C', 'B', 'audio', 'in', true), false);
assert.strictEqual(pairFor(settings, 'B', 'C', 'cursor', 'out', true), false, 'C does not share, whatever B’s pair says');
assert.strictEqual(pairFor(settings, 'C', 'B', 'cursor', 'in', false), true);

// Nothing remembered for that device, that feature or that direction: the settings' switch.
assert.strictEqual(pairFor(settings, 'B', 'D', 'audio', 'out', true), true);
assert.strictEqual(pairFor(settings, 'B', 'C', 'audio', 'in', true), true);
assert.strictEqual(pairFor(settings, 'B', 'C', 'files', 'out', false), false);
assert.strictEqual(pairFor({}, 'B', 'C', 'audio', 'out', true), true);
assert.strictEqual(pairFor(null, 'B', 'C', 'audio', 'out', true), true);

console.log('passed: pairFor');

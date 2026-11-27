// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/consent.js: each device's own two-way switch. The selected device's is the settings; every other
// device's is its saved pair (settings.pairSync), else the settings; setting one for a device that isn't
// selected saves it and tells that device, from our side.
// Run: node shared/test/consent.test.js
'use strict';

const assert = require('assert');
const { consent } = require('../consent.js');
const { FEATURES } = require('../../windows/pairsync.js');

const settings = {
  clipboard: { send: true, receive: false },
  files: { dropToMac: true, acceptFromMac: true },
  pairSync: { B: { clipboard: { out: false, in: true }, values: {} } },
};
let selected = 'A';
const sent = [];
let saves = 0;
const c = consent({ features: FEATURES, settings: () => settings, selectedId: () => selected, send: (id, m) => sent.push([id, m]), save: () => saves++ });
const changes = [];
c.on('change', (id) => changes.push(id));

// The selected device: the settings, whatever its saved pair says.
settings.pairSync.A = { clipboard: { out: false, in: true } };
assert.strictEqual(c.get('A', 'clipboard', 'out'), true, 'the selected device: the settings');
assert.strictEqual(c.get('A', 'clipboard', 'in'), false);
// Another device: its saved pair; a feature it has no pair for, or a device never seen: the settings.
assert.strictEqual(c.get('B', 'clipboard', 'out'), false, 'B: its own pair');
assert.strictEqual(c.get('B', 'clipboard', 'in'), true);
assert.strictEqual(c.get('B', 'files', 'out'), true, 'nothing saved for files: the settings');
assert.strictEqual(c.get('Z', 'clipboard', 'out'), true, 'a device never paired: the settings');
assert.strictEqual(c.get(null, 'clipboard', 'in'), false, 'no device: the settings');
assert.strictEqual(c.get('B', 'nope', 'out'), false, 'a feature this app hasn’t');
assert.strictEqual(c.any(['A', 'B'], 'clipboard', 'out'), true);
assert.strictEqual(c.any(['B'], 'clipboard', 'out'), false);

// Selecting B (a crossing): B's switch is the settings now; A goes by its saved pair.
selected = 'B';
assert.strictEqual(c.get('B', 'clipboard', 'out'), true, 'selected now: the settings');
assert.strictEqual(c.get('A', 'clipboard', 'out'), false, 'A: its own saved pair');
selected = 'A';

// set() for a device that isn't selected: saved, told to it from our side, 'change'.
assert.strictEqual(c.set('C', 'clipboard', 'in', false), true);
assert.deepStrictEqual(settings.pairSync.C.clipboard, { in: false });
assert.strictEqual(c.get('C', 'clipboard', 'in'), false);
assert.strictEqual(c.get('C', 'clipboard', 'out'), true, 'the other way: still the settings');
assert.deepStrictEqual(sent.pop(), ['C', { t: 'pair.sync', feature: 'clipboard', dir: 'in', on: false }]);
assert.strictEqual(saves, 1);
assert.deepStrictEqual(changes, ['C']);
// The selected device's switch is the settings: set() leaves it to the caller.
assert.strictEqual(c.set('A', 'clipboard', 'in', true), false);
assert.strictEqual(c.set('C', 'remote', 'out', true), false, 'no such way for that feature');
assert.strictEqual(sent.length, 0);

// PairSync stashed a pair for a device: 'change' with its id.
c.changed('B');
assert.deepStrictEqual(changes, ['C', 'B']);

console.log('consent: ok');

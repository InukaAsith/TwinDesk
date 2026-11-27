// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/pairsync-mesh.js: the two-way switches per pair on the bus. Every device's pair is kept and told on
// its own session; the settings hold the pair of the device the pages show, and follow the selection;
// a change on the pages goes to that device only; a pair.sync from any device is kept for it.
// Run: node shared/test/pairsync-mesh.test.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { FEATURES, VALUES } = require('../../windows/pairsync.js');
const { pairSyncMesh } = require('../pairsync-mesh.js');

const features = { clipboard: FEATURES.clipboard, audio: FEATURES.audio, cursor: FEATURES.cursor };
const values = { gestures: VALUES.gestures, keyboard: VALUES.keyboard, speed: VALUES.speed }; // speed: a phone's only
const settings = {
  clipboard: { send: true, receive: true }, audio: { send: true, receive: false }, kvm: { driveOther: true, beDriven: true, gestures: true, keyboard: true, speed: 1 },
  pairSync: { B: { clipboard: { out: false, in: true }, audio: { out: false, in: false }, cursor: { out: true, in: false }, values: { gestures: false } } },
};
const hub = new EventEmitter();
hub.selectedId = 'A';
const sent = [];
const on = new Map();
const welcomes = [];
const bus = { on: (t, fn) => on.set(t, fn), onPeer: (ev, fn) => ev === 'welcome' && welcomes.push(fn), send: (id, m) => { sent.push([id, m]); return true; } };
const applied = [];
const roles = { A: 'guest', B: 'host', C: 'guest' };
const paired = [];
const ps = pairSyncMesh({
  bus, hub, features, values, settings: () => settings, save: () => {},
  setFeature: (f, dir, v) => { const [sec, key] = features[f][dir]; settings[sec][key] = v; applied.push(`${f}.${dir}=${v}`); },
  setValue: (k, v) => { const [sec, key] = values[k].path; settings[sec][key] = v; applied.push(`${k}=${v}`); },
  peerRole: (id) => roles[id], peerOs: () => 'win', onPair: (id) => paired.push(id),
});

// A (shown, our guest) connects: it is told its pair, the settings.
for (const fn of welcomes) fn('A');
assert.deepStrictEqual(sent.pop(), ['A', { t: 'pair.sync', all: { clipboard: { out: true, in: true }, audio: { out: true, in: false }, cursor: { out: true, in: true }, values: { gestures: true, keyboard: true } } }], 'speed is a phone’s only');
// B is our host: its {all} comes from it, and is kept for it (directions flipped to ours), not in the settings.
for (const fn of welcomes) fn('B');
assert.strictEqual(sent.length, 0, 'not the host for B: B tells');
on.get('pair.sync')({ all: { clipboard: { out: true, in: false }, values: { gestures: false } } }, 'B');
assert.deepStrictEqual(settings.pairSync.B.clipboard, { out: false, in: true }, 'B’s out (true) is our in');
assert.strictEqual(settings.clipboard.send, true, 'the settings stay A’s');
assert.deepStrictEqual(paired, ['A', 'B'], 'A’s first pair (the settings) kept when it connected, then B’s');

// The pages change A's switch: A is told, the pair kept; B isn't.
settings.audio.receive = true;
ps.check();
assert.deepStrictEqual(sent, [['A', { t: 'pair.sync', feature: 'audio', dir: 'in', on: true }]]);
assert.deepStrictEqual(settings.pairSync.A.audio, { out: true, in: true });
sent.length = 0;
ps.check();
assert.strictEqual(sent.length, 0, 'nothing new: nothing sent');

// The pointer crosses to B: the settings take B's pair (with their side effects), nothing goes back out.
hub.selectedId = 'B';
hub.emit('selected', 'B');
assert.deepStrictEqual(applied.sort(), ['audio.in=false', 'audio.out=false', 'clipboard.out=false', 'cursor.in=false', 'gestures=false'].sort());
assert.deepStrictEqual([settings.clipboard.send, settings.audio.send, settings.kvm.beDriven, settings.kvm.gestures], [false, false, false, false]);
ps.check();
assert.strictEqual(sent.length, 0, 'mirrored, not changed: nothing told');
// Back to A: its own pair, as it was.
hub.selectedId = 'A';
hub.emit('selected', 'A');
assert.deepStrictEqual([settings.clipboard.send, settings.audio.send, settings.audio.receive, settings.kvm.beDriven], [true, true, true, true]);

// A pair.sync from the shown device goes into the settings at once; from another, it's only kept.
on.get('pair.sync')({ feature: 'clipboard', dir: 'out', on: false }, 'A'); // A stops sending us its clipboard: our in
assert.strictEqual(settings.clipboard.receive, false);
on.get('pair.sync')({ key: 'keyboard', value: false }, 'B');
assert.strictEqual(settings.pairSync.B.values.keyboard, false);
assert.strictEqual(settings.kvm.keyboard, true, 'B isn’t shown');
on.get('pair.sync')({ key: 'speed', value: 2 }, 'B');
assert.strictEqual(settings.pairSync.B.values.speed, undefined, 'not a phone: no speed');
// A device met for the first time when selected: the settings are its pair.
hub.selectedId = 'C';
hub.emit('selected', 'C');
assert.deepStrictEqual(settings.pairSync.C.clipboard, { out: true, in: false });
console.log('pairsync-mesh: ok');

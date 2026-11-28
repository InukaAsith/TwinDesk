// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/papps-mesh.js: another computer's apps per device. Switch changes reach every device's unit; the
// Apps tab's list and Open are the selected device's; a window going home is whichever unit has it; the
// view counts every device's windows, so a crossing (another device selected) closes none (#313).
// Run: node shared/test/papps-mesh.test.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { appsSet, pcAppsSet } = require('../papps-mesh.js');

let selected = 'A';
const set = appsSet({
  selectedId: () => selected, viewAs: 'getter',
  empty: { apps: [], windows: [] },
  merge: (v, all) => ({ ...v, windows: all.flatMap((x) => x.windows) }),
  all: ['applySettings'], selected: ['open'], any: ['returnWindow'], anyGet: ['focused'],
});
const unit = (id, wins) => {
  const u = new EventEmitter();
  Object.assign(u, { id, applied: 0, opened: [], wins, focusedNow: false });
  u.applySettings = () => { u.applied++; };
  u.open = (app) => { u.opened.push(app); return id; };
  u.returnWindow = (w) => u.wins.includes(w);
  Object.defineProperty(u, 'focused', { get: () => u.focusedNow });
  Object.defineProperty(u, 'view', { get: () => ({ apps: [id + '-app'], windows: u.wins }) });
  return u;
};
const A = set.ensure('A', () => unit('A', [1, 2]));
const B = set.ensure('B', () => unit('B', [7]));
assert.strictEqual(set.ensure('A', () => { throw new Error('made twice'); }), A);

set.applySettings();
assert.deepStrictEqual([A.applied, B.applied], [1, 1], 'a switch reaches every device');
assert.strictEqual(set.open('calc'), 'A');
assert.deepStrictEqual(set.view, { apps: ['A-app'], windows: [1, 2, 7] }, 'A’s list, every window');
selected = 'B';
assert.deepStrictEqual(set.view.windows, [1, 2, 7], 'a crossing to B: A’s windows are still there');
assert.deepStrictEqual(set.view.apps, ['B-app']);
set.open('notes');
assert.deepStrictEqual(B.opened, ['notes']);
assert.strictEqual(set.returnWindow(2), true, 'A’s window, while B is selected');
assert.strictEqual(set.returnWindow(9), false);
assert.strictEqual(set.focused, false);
A.focusedNow = true;
assert.strictEqual(set.focused, true);
let changes = 0;
set.on('change', () => changes++);
B.emit('change');
assert.strictEqual(changes, 1, 'its events come from the set');
selected = 'Z';
assert.deepStrictEqual(set.view, { apps: [], windows: [1, 2, 7] }, 'no unit for the selected device: empty list, the windows still');
assert.strictEqual(set.open('x'), undefined);
// pcAppsSet: this computer's windows on the other devices, a PcApps each (Move windows to several at once).
{
  const hub = new EventEmitter();
  hub.selectedId = 'B';
  hub._connectedIds = () => ['A', 'B'];
  hub.sessions = { get: () => null };
  hub.scoped = (id) => ({ id, on() {}, send: () => true, status: { state: 'connected' }, bind(n) { this.id = n; } });
  const made = [];
  const pc = (id) => {
    const u = { id, moved: new Map(), back: 0, released: 0, applied: 0 };
    u.bringBack = () => { u.back++; u.moved.clear(); };
    u.input = { release: () => { u.released++; } };
    u.apply = () => { u.applied++; };
    u.view = () => ({ allow: true, moved: u.moved.size, streaming: 1 });
    return u;
  };
  const set = pcAppsSet({ hub, empty: () => ({ moved: 0 }), make: (link, id) => { made.push([id, link.id]); return pc(id); } });
  assert.deepStrictEqual(made, [['A', 'A'], ['B', 'B']], 'one per connected device, each on its own link');
  hub.emit('peerAdded', 'C');
  assert.strictEqual(set.units.length, 3, 'one more as a device comes');
  set.unit('A').moved.set(1, {});
  set.unit('C').moved.set(2, {}).set(3, {});
  assert.strictEqual(set.moved.size, 3, 'windows on two devices at once');
  assert.deepStrictEqual(set.view(), { allow: true, moved: 3, streaming: 3 }, 'the selected device’s, with every device’s windows');
  set.input.release();
  set.apply();
  assert.deepStrictEqual(set.units.map((u) => [u.released, u.applied]), [[1, 1], [1, 1], [1, 1]]);
  set.bringBack();
  assert.strictEqual(set.moved.size, 0, 'all home');
  assert.strictEqual(set.unit('Z'), null);
}
console.log('papps-mesh: ok');

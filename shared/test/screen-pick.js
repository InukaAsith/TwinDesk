// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// A phone picks which real Mac display to mirror. Run with: node shared/test/screen-pick.js
'use strict';

const assert = require('assert');
const Pick = require('../screen-pick.js');

const MAC = [
  { id: 1, label: 'Built-in Display', pixelWidth: 3024, pixelHeight: 1964, virtual: false, primary: true },
  { id: 2, label: 'LG UltraFine', pixelWidth: 1920, pixelHeight: 1080, virtual: false, primary: false },
  { id: 9, label: 'TwinDesk (virtual)', pixelWidth: 1920, pixelHeight: 1080, virtual: true, primary: false },
];

// Main path: a phone selects the second real display while legacy and Extend controls stay unchanged.
{
  const state = Pick.stateFields(MAC, { id: 1, virtual: false });
  assert.deepStrictEqual(state.displays.map((d) => d.id), ['1', '2']);
  assert.strictEqual(state.displays[1].name, 'LG UltraFine');
  assert.strictEqual(state.displayId, '1');
  const pick = Pick.viewerPick({ share: true, displayId: '2' }, MAC, {});
  assert.deepStrictEqual(pick, { ok: true, displayId: 2 });
  assert.strictEqual(Pick.stateFields(MAC, { id: pick.displayId, virtual: false }).displayId, '2');
  assert.ok(!Pick.stateFields(MAC, { id: 9, virtual: true }).displayId);
  assert.deepStrictEqual(Pick.pickDisplay({ share: true, mode: 'mirror' }, MAC), { ok: true, skip: true });
  assert.deepStrictEqual(Pick.pickDisplay({ mode: 'extend', displayId: '2' }, MAC), { ok: true, skip: true });
  assert.deepStrictEqual(Pick.viewerPick({ share: false, close: true, displayId: '1' }, MAC, {}), { ok: true, skip: true });
}

// Failure path: unknown, virtual, held and mesh selections do not select a display.
{
  assert.deepStrictEqual(Pick.viewerPick({ share: true, displayId: '99' }, MAC, {}), { ok: false, error: 'display' });
  assert.deepStrictEqual(Pick.viewerPick({ share: true, displayId: 9 }, MAC, {}), { ok: false, error: 'display' });
  assert.deepStrictEqual(Pick.viewerPick({ share: true, displayId: '2' }, MAC, { mesh: true }), { ok: false, error: 'mesh' });
  assert.deepStrictEqual(Pick.viewerPick({ share: true, displayId: '2' }, MAC, { held: true }), { ok: false, error: 'held' });
  assert.deepStrictEqual(Pick.stateFields(MAC, { id: 1, virtual: false }, false), {});
}

console.log('screen-pick: second display selected; invalid and unavailable picks refused');

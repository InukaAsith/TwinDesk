// Tests for shared/sidebar-model.js: the sidebar's device tiles and the sections per device kind.
// Run with: node shared/test/sidebar-model.js
'use strict';

const assert = require('assert');
const M = require('../sidebar-model.js');

const peers = [
  { id: 'm', name: 'MacBook', os: 'mac', state: 'connected', connected: true, rtt: 4, selected: false },
  { id: 'p', name: 'Pixel', os: 'android', state: 'connected', connected: true, rtt: 30, selected: true },
  { id: 'w', name: 'Desk PC', os: 'win', state: 'waiting', connected: false, rtt: null, selected: false },
  { id: 'l', name: 'Lab', os: 'linux', state: 'via', connected: false, selected: false, via: ['MacBook', 'Pixel'] },
];

// tiles: computers and phones, the phone is not duplicated when it is also in `phones`
{
  const t = M.buildTiles({ peers, phones: [{ id: 'p', name: 'Pixel', connected: true, sub: '30 ms · 80%' }, { id: 'n', name: 'Nearby', connected: false }], transport: 'Bluetooth' });
  assert.deepStrictEqual(t.map((x) => x.id), ['p', 'm', 'n', 'w', 'l'], 'connected first, via last, no duplicates');
  const byId = Object.fromEntries(t.map((x) => [x.id, x]));
  assert.strictEqual(byId.p.kind, 'phone');
  assert.strictEqual(byId.p.selected, true);
  assert.strictEqual(byId.p.sub, '30 ms · 80%');
  assert.strictEqual(byId.m.kind, 'computer');
  assert.strictEqual(byId.m.selected, false);
  assert.strictEqual(byId.m.action, 'select');
  assert.strictEqual(byId.m.sub, '4 ms', 'transport only on the selected tile');
  assert.strictEqual(byId.n.action, 'connect');
  assert.strictEqual(byId.w.action, 'none');
  assert.strictEqual(byId.w.sub, 'Waiting for it to connect');
  assert.strictEqual(byId.l.state, 'via');
  assert.strictEqual(byId.l.action, 'none', 'via: not clickable');
  assert.strictEqual(byId.l.sub, 'via MacBook, Pixel');
}

// a phone only in peers (not nearby) still gets a tile; transport shows on the selected computer
{
  const ps = peers.map((x) => ({ ...x, selected: x.id === 'm' }));
  const t = M.buildTiles({ peers: ps, phones: [], transport: 'Bluetooth' });
  const byId = Object.fromEntries(t.map((x) => [x.id, x]));
  assert.strictEqual(byId.p.kind, 'phone');
  assert.strictEqual(byId.p.selected, false);
  assert.strictEqual(byId.m.sub, '4 ms · Bluetooth');
  assert.strictEqual(byId.m.selected, true);
}

// a nearby phone that is connected while a computer is selected is not selected
{
  const ps = peers.map((x) => ({ ...x, selected: x.id === 'm' }));
  const t = M.buildTiles({ peers: ps, phones: [{ id: 'p', name: 'Pixel', connected: true }] });
  assert.strictEqual(t.find((x) => x.id === 'p').selected, false);
  assert.strictEqual(t.find((x) => x.id === 'm').selected, true);
}

// nothing: empty; one device: one selected tile
assert.deepStrictEqual(M.buildTiles({}), []);
{
  const one = M.singlePeer({ id: 'x', name: 'Mac', os: 'mac' }, 'connected', 7);
  const t = M.buildTiles({ peers: one });
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].selected, true);
  assert.strictEqual(t[0].sub, '7 ms');
  assert.deepStrictEqual(M.singlePeer(null, 'connected'), []);
  const off = M.buildTiles({ peers: M.singlePeer({ id: 'x', name: 'Mac', os: 'mac' }, 'reconnecting') });
  assert.strictEqual(off[0].state, 'connecting');
  assert.strictEqual(off[0].selected, false);
}

// kinds and sections
assert.strictEqual(M.selectedKind(peers), 'phone');
assert.strictEqual(M.selectedKind(peers.map((x) => ({ ...x, selected: x.id === 'm' }))), 'computer');
assert.strictEqual(M.selectedKind(peers.map((x) => ({ ...x, selected: x.id === 'w' }))), 'none', 'selected but not connected');
assert.strictEqual(M.selectedKind([]), 'none');
for (const id of ['calls', 'messages', 'media', 'pfiles', 'mount', 'phone']) {
  assert.ok(M.sectionVisible(id, 'phone'), id + ' for a phone');
  assert.ok(!M.sectionVisible(id, 'computer'), id + ' not for a computer');
}
for (const id of ['mac-pc', 'receive', 'apps', 'terminal']) {
  assert.ok(!M.sectionVisible(id, 'phone'), id + ' not for a phone');
  assert.ok(M.sectionVisible(id, 'computer'));
}
for (const id of ['overview', 'general', 'about', 'files', 'cursor']) assert.ok(M.sectionVisible(id, 'phone') && M.sectionVisible(id, 'computer'), id + ' for both');
assert.ok(!M.isScoped('general') && !M.isScoped('overview') && M.isScoped('files') && M.isScoped('calls'));

// first section / target section
const winIds = ['overview', 'calls', 'messages', 'media', 'mac-pc', 'pc-mac', 'cursor', 'files', 'phone', 'general'];
assert.strictEqual(M.firstSection('phone', winIds), 'phone');
assert.strictEqual(M.firstSection('computer', winIds), 'mac-pc');
assert.strictEqual(M.firstSection('computer', ['overview', 'receive', 'share']), 'receive', 'the Mac names it receive');
assert.strictEqual(M.firstSection('none', winIds), 'overview');
assert.strictEqual(M.targetSection('files', 'phone', winIds), 'files', 'stays when it exists for the new kind');
assert.strictEqual(M.targetSection('calls', 'computer', winIds), 'mac-pc', 'phone-only section: the computer\'s first');
assert.strictEqual(M.targetSection('terminal', 'phone', winIds), 'phone', 'not available: the phone\'s first');
assert.strictEqual(M.targetSection('overview', 'phone', winIds), 'phone', 'global: the device\'s first');
assert.strictEqual(M.targetSection(null, 'computer', ['general']), 'general', 'last resort: whatever exists');

console.log('sidebar-model: all passed');

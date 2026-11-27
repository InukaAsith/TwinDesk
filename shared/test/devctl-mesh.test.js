// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/devctl-mesh.js: a DevCtl per device, one DevLocal. A device that isn't selected can ring this
// computer; another device going doesn't stop that ring, the device that rang going does; Overview shows
// the selected device's state. On the facade only the selected device was answered (#313).
// Run: node shared/test/devctl-mesh.test.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { DevCtl } = require('../devctl.js');
const { devCtlSet } = require('../devctl-mesh.js');

function fakeLink(id) {
  const e = new EventEmitter();
  e.sent = [];
  e.current = { deviceId: id, name: 'Dev-' + id, os: 'win' };
  return { on: (ev, fn) => e.on(ev, fn), send: (m) => { e.sent.push(m); return true; }, get current() { return e.current; }, e };
}

const local = {
  did: [], stops: 0, ringFrom: '',
  can: () => ({ ring: true, ringStop: true }),
  state: async () => ({ ringing: false }),
  do: async (m) => { local.did.push(m.do); },
  stop() { local.stops++; },
};

async function main() {
  const links = {};
  let selected = 'A';
  const set = devCtlSet({
    selectedId: () => selected, local,
    make: (id) => new DevCtl({ link: (links[id] = fakeLink(id)), local, sharedLocal: true, version: '3.2.1', watching: () => false }),
  });
  set.ensure('A');
  set.ensure('B');
  set.ensure('A');
  assert.strictEqual(set.byId.size, 2, 'one each, made once');
  for (const id of ['A', 'B']) links[id].e.emit('welcome', {});
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(links.B.e.sent.some((m) => m.t === 'dev.state'), 'B, not selected, is told this computer’s state');

  // B rings this computer while A is selected.
  links.B.e.emit('dev.do', { do: 'ring' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(local.did, ['ring'], 'B’s dev.do reached this computer');
  assert.strictEqual(local.ringFrom, 'Dev-B');
  // A goes: B's ring goes on. B goes: it stops.
  links.A.e.emit('closed');
  assert.strictEqual(local.stops, 0, 'another device going doesn’t stop B’s ring');
  links.B.e.emit('closed');
  assert.strictEqual(local.stops, 1, 'the device that rang going does');

  // Overview: the selected device's state.
  links.A.e.emit('welcome', {});
  links.A.e.emit('dev.state', { can: { ring: true }, volume: 0.5 });
  links.B.e.emit('welcome', {});
  links.B.e.emit('dev.state', { can: { lock: true }, volume: 0.2 });
  assert.strictEqual(set.view.volume, 0.5, 'A’s');
  selected = 'B';
  assert.strictEqual(set.view.volume, 0.2, 'now B’s');
  await set.do({ do: 'lock' });
  assert.ok(links.B.e.sent.some((m) => m.t === 'dev.do' && m.do === 'lock'), 'Overview’s buttons go to the selected device');
  assert.ok(!links.A.e.sent.some((m) => m.t === 'dev.do'));
  // The ring stopping by itself: every device is told.
  const before = links.A.e.sent.length + links.B.e.sent.length;
  local.onStop();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(links.A.e.sent.length + links.B.e.sent.length >= before + 2, 'both told');
  set.stop();
  console.log('devctl-mesh: ok');
}

main().catch((e) => { console.error(e); process.exit(1); });

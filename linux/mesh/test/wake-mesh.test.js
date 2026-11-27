// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// linux/wake.js in Multi-device (the hub's bus): every device is told how to wake this computer when it
// connects, and a device's wol.info is kept whichever device is selected. On the facade only the
// selected device was told or heard, so a device never selected here couldn't wake this one (#313).
// Run: node linux/mesh/test/wake-mesh.test.js
'use strict';

const assert = require('assert');
const P = require('../../../shared/protocol.js');
const Wake = require('../../wake.js');

const T = P.T;
const handlers = { welcome: [], msg: new Map() };
const sent = [];
const bus = {
  onPeer: (ev, fn) => ev === 'welcome' && handlers.welcome.push(fn),
  on: (t, fn) => handlers.msg.set(t, fn),
  send: (id, m) => { sent.push([id, m]); return true; },
};
const sessions = { A: { name: 'Ryzen9', os: P.OS.WIN }, B: { name: 'MacBook', os: P.OS.MAC } };
const link = { on: () => { throw new Error('the facade isn’t used in Multi-device'); } };
const settings = { wake: { peers: {} } };
let saves = 0;
const wake = new Wake({
  link, bus, peer: (id) => sessions[id] || null, settings, save: () => saves++, onChange: () => {}, address: () => '192.168.1.5',
});

// Both devices connect (neither need be selected): each is told how to wake this computer.
for (const fn of handlers.welcome) { fn('A'); fn('B'); }
assert.deepStrictEqual(sent.map(([id, m]) => [id, m.t]), [['A', T.WOL_INFO], ['B', T.WOL_INFO]]);
assert.strictEqual(sent[0][1].address, '192.168.1.5');

// B, not selected, tells its own: kept under B, with its name and os from its session.
const info = handlers.msg.get(T.WOL_INFO);
info({ macs: ['AA:BB:CC:DD:EE:FF', 'bad'], address: '192.168.1.9' }, 'B');
assert.deepStrictEqual(settings.wake.peers.B && { ...settings.wake.peers.B, at: 0 }, { name: 'MacBook', os: P.OS.MAC, macs: ['aa:bb:cc:dd:ee:ff'], address: '192.168.1.9', at: 0 });
assert.strictEqual(saves, 1);
// The same again (every connect sends it): not saved again.
info({ macs: ['aa:bb:cc:dd:ee:ff'], address: '192.168.1.9' }, 'B');
assert.strictEqual(saves, 1, 'unchanged: no save');
// A device the hub doesn't know, or no address at all: nothing kept.
info({ macs: ['aa:bb:cc:dd:ee:01'] }, 'Z');
info({ macs: [] }, 'A');
assert.deepStrictEqual(Object.keys(settings.wake.peers), ['B']);

console.log('wake-mesh: ok');

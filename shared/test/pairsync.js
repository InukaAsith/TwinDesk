// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume's switches between two computers joined back to back (windows/ and linux/pairsync.js, and
// mac/pairsync.js as the host): one switch for the pair, whichever side flips it.
// Run with: node shared/test/pairsync.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { PairSync: PcSync } = require('../../windows/pairsync.js');
const { PairSync: MacSync } = require('../../mac/pairsync.js');
const P = require('../protocol.js');

const base = (rezume) => ({
  pairSync: {},
  monitor: { pacing: 'fast' }, sharing: { pace: 'fast' },
  kvm: { gestures: true, ble: true, keyboard: true, speed: 1, reverseScroll: false },
  rezume: { on: false, send: true, receive: true, ...rezume },
});

// A PC on each end: a hosts. Each side's sends arrive at the other, its settings pushed as main.js does.
function pcs(a, b, savedA, savedB, only) {
  const bus = { a: new EventEmitter(), b: new EventEmitter() };
  const mk = (me, other, settings, saved, hosting) => {
    if (saved) settings.pairSync.peer = saved;
    const link = {
      on: (t, fn) => bus[me].on(t, fn),
      send: (m) => bus[other].emit(m.t, JSON.parse(JSON.stringify(m))),
      snapshot: () => ({ session: { id: 'peer' } }),
      status: { state: 'connected' },
      peerOs: P.OS.MAC,
      hosting,
    };
    const sync = new PcSync({ link, settings, save() {}, only, set: (sec, part) => { Object.assign(settings[sec], part); sync.check(); } });
    return sync;
  };
  const x = mk('a', 'b', a, savedA, true);
  const y = mk('b', 'a', b, savedB, false);
  bus.b.emit('welcome');
  bus.a.emit('welcome');
  return { a, b, flip: (s, part) => { Object.assign(s, part); x.check(); y.check(); } };
}

// Off and on, from each side: the other side's switch follows, and the ways stay as they were.
{
  const p = pcs(base(), base());
  assert.strictEqual(p.b.rezume.on, false);
  p.flip(p.b.rezume, { on: true });
  assert.strictEqual(p.a.rezume.on, true, 'on from the guest reaches the host');
  p.flip(p.a.rezume, { on: false });
  assert.strictEqual(p.b.rezume.on, false, 'off from the host reaches the guest');
  assert.ok(p.b.rezume.send && p.b.rezume.receive && p.a.rezume.send && p.a.rezume.receive, 'turning it off leaves the ways on');
  p.flip(p.b.rezume, { on: true });
  assert.strictEqual(p.a.rezume.on, true, 'and on again from the side that was told off');
  p.flip(p.b.rezume, { on: false });
  p.flip(p.a.rezume, { on: true });
  assert.strictEqual(p.b.rezume.on, true, 'on again from the other side too');
}

// A way turned off on one side is the other's opposite way, and doesn't touch the switch.
{
  const p = pcs(base({ on: true }), base({ on: true }));
  p.flip(p.a.rezume, { receive: false });
  assert.strictEqual(p.b.rezume.send, false);
  assert.strictEqual(p.b.rezume.on, true);
  assert.strictEqual(p.a.rezume.on, true);
}

// Turned on while not connected: saved values don't turn it off again, and the host's win.
{
  const saved = { rezume: { out: false, in: false }, values: { rezume: false } };
  const p = pcs(base({ on: true }), base(), saved, saved);
  assert.strictEqual(p.a.rezume.on, true, 'the host keeps its switch');
  assert.strictEqual(p.b.rezume.on, true, 'the guest follows the host');
  assert.ok(p.a.rezume.send && p.a.rezume.receive, 'the saved ways are not restored');
}

// Stuck by the old build (on, both ways off, a saved entry without the switch): both ways come back.
{
  const old = { rezume: { out: false, in: false }, values: {} };
  const p = pcs(base({ on: true, send: false, receive: false }), base({ on: true, send: false, receive: false }), old, old);
  assert.ok(p.a.rezume.send && p.a.rezume.receive && p.b.rezume.send && p.b.rezume.receive);
}

// Both ways off by hand, saved by this build: stays off.
{
  const now = { rezume: { out: false, in: false }, values: { rezume: true } };
  const p = pcs(base({ on: true, send: false, receive: false }), base({ on: true, send: false, receive: false }), now, now);
  assert.ok(!p.a.rezume.send && !p.a.rezume.receive);
}

// An app without ReZume (Multi-device) doesn't sync its switch.
{
  const p = pcs(base(), base(), null, null, ['clipboard']);
  p.flip(p.b.rezume, { on: true });
  assert.strictEqual(p.a.rezume.on, false);
}

// The Mac hosting a phone: the phone's on and off, and all values on connect carry the switch.
{
  const server = new EventEmitter();
  const sent = [];
  server.current = { deviceId: 'phone', os: P.OS.ANDROID, role: 'guest' };
  server.send = (_c, m) => sent.push(m);
  server.sendToClient = (m) => sent.push(m);
  const s = base({ on: true, send: false, receive: false });
  s.pairSync.phone = { rezume: { out: false, in: false }, values: {} };
  const applied = [];
  const sync = new MacSync({ server, getSettings: () => s, saveSettings() {}, apply: (f, d, v) => {
    applied.push([f, d, v]);
    if (f === 'value' && d === 'rezume') s.rezume.on = v;
    if (f === 'rezume') s.rezume[d === 'out' ? 'send' : 'receive'] = v;
  } });
  server.emit('client', server.current);
  assert.ok(s.rezume.send && s.rezume.receive, 'stuck ways healed through the action, so ReZume hears');
  assert.deepStrictEqual(applied.slice(0, 2), [['rezume', 'out', true], ['rezume', 'in', true]]);
  const all = sent.find((m) => m.all).all;
  assert.strictEqual(all.values.rezume, true);
  assert.deepStrictEqual(all.rezume, { out: true, in: true });
  server.emit(`t:${P.T.PAIR_SYNC}`, { key: 'rezume', value: false });
  assert.strictEqual(s.rezume.on, false, 'off from the phone');
  assert.ok(s.rezume.send && s.rezume.receive, 'its ways stay');
  sent.length = 0;
  s.rezume.on = true;
  sync.check();
  assert.deepStrictEqual(sent, [{ t: P.T.PAIR_SYNC, key: 'rezume', value: true }], 'on here reaches the phone');
}

console.log('pairsync: passed');

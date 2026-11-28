// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/sound-route.js (Audio › the mixer): the receiver keeps each sender's route and plays it, the
// sender's pick reaches it as audio.route, what plays goes back as audio.outs, Keep speakers in sync;
// and linux/loopback.js's sorting of the sound server's streams (no loop, no feedback).
// Run: node shared/test/sound-route.test.js
'use strict';

const assert = require('assert');
const { Routes, normOuts, normRoutes, normList, SYNC_MS } = require('../sound-route.js');
const P = require('../protocol.js');
const lb = require('../../linux/loopback.js')._test;

const T = P.T;

// ---- normalising ----
assert.deepStrictEqual(normOuts([{ id: 'a', vol: 0.704 }, { id: 'a', vol: 1 }, { id: 'b', vol: 7 }, null, { id: 'c', vol: -1 }]),
  [{ id: 'a', vol: 0.7 }, { id: 'b', vol: 1 }, { id: 'c', vol: 0 }], 'clamped, rounded, de-duplicated');
assert.strictEqual(normOuts('x'), null, 'not a route');
assert.deepStrictEqual(normOuts([]), [], 'no speakers is a route (silent)');
assert.strictEqual(normOuts(Array.from({ length: 20 }, (_, i) => ({ id: 'o' + i, vol: 1 }))).length, 8, 'eight speakers at most');
assert.deepStrictEqual(normRoutes({ A: [{ id: 'x', vol: 1 }], B: 'bad', '': [] }), { A: [{ id: 'x', vol: 1 }] });
assert.deepStrictEqual(normList([{ id: 'x', name: 'HDMI', def: 1 }, { id: 3 }]), [{ id: 'x', name: 'HDMI', def: true }]);

// ---- one edge, both ends ----
function end(id, peer) {
  const cfg = { volume: 0.8, routes: {} };
  const sent = [], win = [];
  let saved = 0, receiving = false;
  const r = new Routes({
    send: (m) => sent.push(m), toWin: (m) => win.push(m), peerId: () => peer, cfg: () => cfg,
    save: () => saved++, receiving: () => receiving,
  });
  return { r, cfg, sent, win, saves: () => saved, play: (on) => { receiving = on; } };
}

// The receiver B plays A's sound; its window lists its speakers.
const B = end('B', 'A');
B.play(true);
B.r.onWin({ outs: [{ id: 'hdmi', name: 'Sonos Beam (HDMI)', def: true }, { id: 'usb', name: 'Headphones (USB)' }], lat: 24 });
let told = B.sent.filter((m) => m.t === T.AUDIO_OUTS).pop();
assert.ok(told, 'its speakers go to the sender');
assert.deepStrictEqual(told.route, [{ id: 'hdmi', vol: 0.8 }], 'no route: the default speaker at the Volume, as it plays');
assert.strictEqual(told.lat, 24);

// The sender A picks two of B's speakers.
const A = end('A', 'B');
A.r.onOuts(told);
assert.strictEqual(A.r.view().remote.outs.length, 2, 'the sender sees the receiver’s speakers');
A.r.setRemote([{ id: 'hdmi', vol: 0.7 }, { id: 'usb', vol: 0.35 }]);
const pick = A.sent.pop();
assert.strictEqual(pick.t, T.AUDIO_ROUTE);
assert.deepStrictEqual(A.r.view().remote.route, [{ id: 'hdmi', vol: 0.7 }, { id: 'usb', vol: 0.35 }], 'shown at once');

// B keeps it (its settings, by the sender's id), plays it and says so.
B.sent.length = 0;
B.r.onRoute(pick);
assert.deepStrictEqual(B.cfg.routes.A, [{ id: 'hdmi', vol: 0.7 }, { id: 'usb', vol: 0.35 }], 'kept by the receiver');
assert.strictEqual(B.saves(), 1, 'saved');
assert.deepStrictEqual(B.win.pop(), { t: 'route', outs: [{ id: 'hdmi', vol: 0.7 }, { id: 'usb', vol: 0.35 }], sync: 0, volume: 0.8 }, 'played');
assert.strictEqual(B.sent.length, 1, 'told once');
assert.deepStrictEqual(B.sent[0].route, B.cfg.routes.A);

// B's own page changes one; the sender hears it.
B.sent.length = 0;
assert.ok(B.r.setLocal([{ id: 'usb', vol: 0.5 }]));
assert.deepStrictEqual(B.sent[0].route, [{ id: 'usb', vol: 0.5 }]);

// A garbled route changes nothing.
B.r.onRoute({ t: T.AUDIO_ROUTE, outs: 'all' });
assert.deepStrictEqual(B.cfg.routes.A, [{ id: 'usb', vol: 0.5 }]);

// Keep speakers in sync: the sender says it, the receiver's window holds to it.
A.r.sayingSync(true);
assert.deepStrictEqual(A.sent.pop(), { t: T.AUDIO_ROUTE, sync: SYNC_MS });
B.r.onRoute({ t: T.AUDIO_ROUTE, sync: SYNC_MS });
assert.strictEqual(B.win.pop().sync, SYNC_MS);
assert.deepStrictEqual(B.cfg.routes.A, [{ id: 'usb', vol: 0.5 }], 'sync alone leaves the route');

// Not playing: nothing told (the sender hears again when it plays).
B.play(false);
B.sent.length = 0;
B.r.onWin({ outs: [{ id: 'usb', name: 'Headphones (USB)' }], lat: 0 });
assert.strictEqual(B.sent.length, 0, 'quiet while its sound doesn’t play here');

// The delay jitters by a millisecond: not said again.
const C = end('C', 'A');
C.play(true);
C.r.onWin({ outs: [{ id: 'x', name: 'X', def: true }], lat: 30 });
const n = C.sent.length;
C.r.onWin({ outs: [{ id: 'x', name: 'X', def: true }], lat: 31 });
assert.strictEqual(C.sent.length, n, 'under 3 ms: not sent');
C.r.onWin({ outs: [{ id: 'x', name: 'X', def: true }], lat: 40 });
assert.strictEqual(C.sent.length, n + 1);

// A link that went: what the peer said is forgotten.
A.r.reset();
assert.strictEqual(A.r.view().remote, null);

// ---- linux/loopback.js: where each stream goes while sending ----
const list = lb.parseInputs([
  'Sink Input #10', '\tOwner Module: n/a', '\tProperties:', '\t\tapplication.name = "Firefox"', '\t\tapplication.process.id = "500"',
  '', 'Sink Input #11', '\tOwner Module: n/a', '\tProperties:', '\t\tapplication.name = "TwinDesk"', '\t\tapplication.process.id = "42"',
  '', 'Sink Input #12', '\tOwner Module: 77', '\tProperties:', '\t\tmedia.name = "Loopback from TwinDesk-Capture"',
  '', 'Sink Input #13', '\tOwner Module: n/a', '\tProperties:', '\t\tnode.name = "output.loopback-1234"', '\t\tapplication.process.id = "900"',
  '', 'Sink Input #14', '\tOwner Module: n/a', '\tProperties:', '\t\tmedia.name = "event"',
].join('\n'));
assert.deepStrictEqual(list.map((i) => i.id), ['10', '11', '12', '13', '14']);
const mods = { play: '77', remap: '78', cap: '76' };
const pids = new Set([42]);
const where = list.map((i) => lb.whereTo(i, mods, pids, 'alsa_output.speakers'));
assert.deepStrictEqual(where, [lb.CAP, 'alsa_output.speakers', null, null, null],
  'other apps into our sink, TwinDesk to the speakers, loopbacks and pid-less streams left alone');

console.log('sound-route: all passed');

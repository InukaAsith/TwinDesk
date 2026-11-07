// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The pairing QR link is single-use: a pairing that went through consumes the nonce, so a link
// seen twice pairs only once. All three hostpair implementations, driven with a fake server and a
// stub store (paired.json never touches disk).
// Run with: node shared/test/qr-pairing.js
'use strict';

const assert = require('assert');
const path = require('path');
const P = require('../protocol.js');

// hostpair.js and pairing.js require('./store'): hand them a stub instead of the real one.
for (const dir of ['windows', 'linux', 'mac']) {
  const p = require.resolve(path.join(__dirname, '..', '..', dir, 'store.js'));
  require.cache[p] = { exports: { read: (n, fb) => fb, write: () => {}, remove: () => {} }, loaded: true, id: p, filename: p };
}
const impls = {
  windows: require('../../windows/hostpair.js').Pairing,
  linux: require('../../linux/hostpair.js').Pairing,
  mac: require('../../mac/pairing.js').Pairing,
};

const fakeServer = (sent) => {
  const { EventEmitter } = require('events');
  const s = new EventEmitter();
  s.sent = sent;
  s.send = (ctx, m) => sent.push(m);
  s.fail = (ctx, code, why) => { throw new Error(`server.fail ${code}: ${why}`); };
  s.closeDevice = () => {};
  s.current = null;
  s.phoneGrace = null;
  s.phoneHolds = () => false;
  s.endPhoneGrace = () => {};
  return s;
};

const ctx = { address: '203.0.113.7', ws: { close() {} } };

// A QR-style pairing to completion on one implementation: start with the nonce in `wired`
// (as mains pass it to isWired and isQr), reveal, confirm, Allow. Returns the pairing object.
function pairOnce(Pairing, qrPairBox, sent) {
  const pairing = new Pairing(fakeServer(sent), { id: 'host-id', name: 'Host', fp: '00' });
  // What the mains wire: the predicate knows the nonce, the consume hook drops it.
  pairing.isQr = (n) => !!qrPairBox.qrPair && n === qrPairBox.qrPair.nonce && Date.now() < qrPairBox.qrPair.until;
  pairing.consumeQr = () => { qrPairBox.qrPair = null; };
  const nw = P.randomHex(16);
  pairing._onMessage(ctx, { t: P.T.PAIR_START, v: P.PROTOCOL_VERSION, id: 'phone-1', name: 'Phone', os: P.OS.ANDROID, commit: P.commitOf(nw), wired: 'scanned-nonce' });
  assert.ok(pairing.pending && pairing.pending.qr, 'a valid QR nonce marks the pair qr');
  pairing._onMessage(ctx, { t: P.T.PAIR_REVEAL, nonce: nw });
  assert.ok(pairing.pending.code, 'reveal produced the code');
  pairing._onMessage(ctx, { t: P.T.PAIR_CONFIRM });
  pairing.respond(true);
  assert.strictEqual(pairing.pending, null, 'pairing finished');
  assert.ok(sent.some((m) => m.t === P.T.PAIR_OK), 'PAIR_OK went out');
  return pairing;
}

for (const [name, Pairing] of Object.entries(impls)) {
  const sent = [];
  const box = { qrPair: { nonce: 'scanned-nonce', until: Date.now() + 600000 } };
  const pairing = pairOnce(Pairing, box, sent);
  assert.strictEqual(box.qrPair, null, `${name}: a completed QR pairing consumes the nonce`);
  // The same link seen again: no qr flag, so it is an ordinary pair.start.
  const nw = P.randomHex(16);
  pairing._onMessage(ctx, { t: P.T.PAIR_START, v: P.PROTOCOL_VERSION, id: 'phone-2', name: 'Phone', os: P.OS.ANDROID, commit: P.commitOf(nw), wired: 'scanned-nonce' });
  assert.ok(pairing.pending && !pairing.pending.qr, `${name}: a reused link no longer counts as QR`);
  pairing._onMessage(ctx, { t: P.T.PAIR_CANCEL });
}

console.log('qr-pairing: ok');
process.exit(0);

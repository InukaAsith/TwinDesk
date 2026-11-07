// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tests for shared/pairfail.js: the lockout after repeated failed pairings.
// Run with: node shared/test/pairfail.js
'use strict';

const assert = require('assert');
const { PairFails, MAX } = require('../pairfail.js');

// MAX-1 failures don't lock, the MAXth one does; other addresses are unaffected.
const f = new PairFails();
for (let i = 0; i < MAX - 1; i++) f.fail('192.168.1.9');
assert.ok(!f.locked('192.168.1.9'));
f.fail('192.168.1.9');
assert.ok(f.locked('192.168.1.9'));
assert.ok(!f.locked('192.168.1.10'));

// A successful pairing (clear) lets the address pair again.
f.clear('192.168.1.9');
assert.ok(!f.locked('192.168.1.9'));

// Attempts older than the window fall away.
const real = Date.now;
Date.now = () => real() - 11 * 60 * 1000;
for (let i = 0; i < MAX; i++) f.fail('10.0.0.2');
Date.now = real;
assert.ok(!f.locked('10.0.0.2'));

// Our own Bluetooth/wired pipe never locks.
f.fail('127.0.0.1');
assert.ok(!f.locked('127.0.0.1'));

// The six host implementations, driven with a fake server. Every one must lock out after MAX
// failed attempts, and a cancel or a dropped socket after an accepted pair.start must count
// (before the fix the two macOS hosts had no lockout at all, and no host counted a cancel or an
// early close, so the lockout never armed against a peer that started and walked away).
const { EventEmitter } = require('events');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../protocol.js');

// windows/hostpair.js and linux/hostpair.js read their store.js, which wants electron's userData
// path; stub electron with a temp dir so the real classes load under plain node (same pattern as
// drop-async.js).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairfail-'));
const load = Module._load;
Module._load = function (id, ...args) {
  return id === 'electron' ? { app: { getPath: () => dir } } : load.call(this, id, ...args);
};
const { Pairing: MacHost } = require('../../mac/pairing.js');
const { Pairing: MacMeshHost } = require('../../mac/mesh/pairing.js');
const { Pairing: WinHost } = require('../../windows/hostpair.js');
const { Pairing: WinMeshHost } = require('../../windows/mesh/hostpair.js');
const { Pairing: LinuxHost } = require('../../linux/hostpair.js');
const { Pairing: LinuxMeshHost } = require('../../linux/mesh/hostpair.js');
Module._load = load;
require('../../mac/store.js').init(path.join(dir, 'mac'));

const FP = 'ab'.repeat(32);
const mem = () => {
  const files = {};
  return { read: (n, fb) => (n in files ? files[n] : fb), write: (n, o) => { files[n] = o; } };
};
const hosts = {
  'mac/pairing.js': (s) => new MacHost(s, { macId: 'mac', macName: 'Mac', fp: FP }),
  'mac/mesh/pairing.js': (s) => new MacMeshHost(s, { macId: 'mac', macName: 'Mac', fp: FP }, { storage: mem() }),
  'windows/hostpair.js': (s) => new WinHost(s, { id: 'pc', name: 'PC', fp: FP }),
  'windows/mesh/hostpair.js': (s) => new WinMeshHost(s, { id: 'pc', name: 'PC', fp: FP }, { storage: mem() }),
  'linux/hostpair.js': (s) => new LinuxHost(s, { id: 'pc', name: 'PC', fp: FP }),
  'linux/mesh/hostpair.js': (s) => new LinuxMeshHost(s, { id: 'pc', name: 'PC', fp: FP }, { storage: mem() }),
};

// The server the pairing talks to: 'preauth' and 'closed' events, send/fail recorded.
class FakeServer extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.current = null;
  }
  send(ctx, msg) { this.sent.push(msg); }
  fail(ctx, code, message) { this.sent.push({ t: 'fail', code }); }
  closeDevice() {}
  authenticate(ctx, who, msg) { this.sent.push(msg); }
  phoneHolds() { return false; }
}

const ADDR = '10.0.0.9';
const mkctx = () => ({ address: ADDR, ws: { closed: false, close() { this.closed = true; } } });
const startPair = (server, c) => {
  const nw = P.randomHex(16);
  server.emit('preauth', c, { t: P.T.PAIR_START, v: P.PROTOCOL_VERSION, id: 'peer', name: 'Peer', os: P.OS.WIN, commit: P.commitOf(nw) });
  return nw;
};
// A fresh well-formed pair.start: 'accepted' (and disarmed again) or 'refused' by the lockout.
const probe = (server, pairing) => {
  const c = mkctx();
  server.emit('preauth', c, { t: P.T.PAIR_START, v: P.PROTOCOL_VERSION, id: 'peer', name: 'Peer', os: P.OS.WIN, commit: '0'.repeat(64) });
  if (pairing.pending) {
    pairing._clear(); // probe only: leave no failure and no live timer behind
    return 'accepted';
  }
  assert.ok(server.sent.some((m) => m.t === 'fail' && m.code === P.E.PAIR_REFUSED), 'a refused start fails with pair_refused');
  return 'refused';
};

for (const [name, make] of Object.entries(hosts)) {
  // pair.start then pair.cancel counts, once per attempt: the close the cancel causes must not
  // add a second failure.
  let server = new FakeServer();
  let pairing = make(server);
  for (let i = 0; i < 3; i++) {
    const c = mkctx();
    startPair(server, c);
    assert.ok(pairing.pending, `${name}: start accepted`);
    server.emit('preauth', c, { t: P.T.PAIR_CANCEL });
    assert.ok(c.ws.closed, `${name}: cancel closes the socket`);
    server.emit('closed', c);
    assert.ok(!pairing.pending, `${name}: cancel clears the pending pairing`);
  }
  assert.strictEqual(probe(server, pairing), 'accepted', `${name}: 3 cancels is not a lockout yet`);
  for (let i = 3; i < MAX; i++) {
    const c = mkctx();
    startPair(server, c);
    server.emit('preauth', c, { t: P.T.PAIR_CANCEL });
    server.emit('closed', c);
  }
  assert.strictEqual(probe(server, pairing), 'refused', `${name}: ${MAX} cancelled pairings lock the address`);

  // pair.start then the socket drops with no cancel counts the same way.
  server = new FakeServer();
  pairing = make(server);
  for (let i = 0; i < 3; i++) {
    const c = mkctx();
    startPair(server, c);
    assert.ok(pairing.pending, `${name}: start accepted`);
    server.emit('closed', c);
    assert.ok(!pairing.pending);
  }
  assert.strictEqual(probe(server, pairing), 'accepted', `${name}: 3 dropped pairings is not a lockout yet`);
  for (let i = 3; i < MAX; i++) {
    const c = mkctx();
    startPair(server, c);
    server.emit('closed', c);
  }
  assert.strictEqual(probe(server, pairing), 'refused', `${name}: ${MAX} dropped pairings lock the address`);

  // A pair.cancel with no accepted pair.start counts nothing.
  server = new FakeServer();
  pairing = make(server);
  for (let i = 0; i < MAX + 2; i++) {
    const c = mkctx();
    server.emit('preauth', c, { t: P.T.PAIR_CANCEL });
    server.emit('closed', c);
  }
  assert.strictEqual(probe(server, pairing), 'accepted', `${name}: bare cancels never lock`);

  // A bad pair.reveal aborts and counts; the close that follows adds nothing.
  server = new FakeServer();
  pairing = make(server);
  for (let i = 0; i < 3; i++) {
    const c = mkctx();
    startPair(server, c);
    server.emit('preauth', c, { t: P.T.PAIR_REVEAL, nonce: '00'.repeat(16) });
    server.emit('closed', c);
  }
  assert.strictEqual(probe(server, pairing), 'accepted', `${name}: 3 bad reveals is not a lockout yet`);
  for (let i = 3; i < MAX; i++) {
    const c = mkctx();
    startPair(server, c);
    server.emit('preauth', c, { t: P.T.PAIR_REVEAL, nonce: '00'.repeat(16) });
    server.emit('closed', c);
  }
  assert.strictEqual(probe(server, pairing), 'refused', `${name}: ${MAX} bad reveals lock the address`);

  // A malformed pair.start counts too.
  server = new FakeServer();
  pairing = make(server);
  for (let i = 0; i < MAX; i++) {
    const c = mkctx();
    server.emit('preauth', c, { t: P.T.PAIR_START, v: P.PROTOCOL_VERSION, id: 'peer', commit: 'xyz' });
    server.emit('closed', c);
  }
  assert.strictEqual(probe(server, pairing), 'refused', `${name}: ${MAX} malformed starts lock the address`);

  // A finished pairing clears the count: MAX-1 cancels, one success, then MAX-1 more cancels
  // still leave the address unlocked.
  server = new FakeServer();
  pairing = make(server);
  const cancelCycle = () => {
    const c = mkctx();
    startPair(server, c);
    server.emit('preauth', c, { t: P.T.PAIR_CANCEL });
    server.emit('closed', c);
  };
  for (let i = 0; i < MAX - 1; i++) cancelCycle();
  const c = mkctx();
  const nw = startPair(server, c);
  server.emit('preauth', c, { t: P.T.PAIR_REVEAL, nonce: nw });
  server.emit('preauth', c, { t: P.T.PAIR_CONFIRM });
  pairing.respond(true);
  assert.ok(pairing.paired.some((e) => e.id === 'peer'), `${name}: the pairing finished`);
  assert.ok(server.sent.some((m) => m.t === P.T.PAIR_OK), `${name}: pair.ok sent`);
  for (let i = 0; i < MAX - 1; i++) cancelCycle();
  assert.strictEqual(probe(server, pairing), 'accepted', `${name}: a success cleared the earlier failures`);
}

console.log('pairfail: ok');

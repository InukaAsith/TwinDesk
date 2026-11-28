// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device lanes on the helper's native lane (#273), with native/tdfast's example peer standing
// in for the helper: each device's lane gets a helper lane of its own; the swap waits until the
// lane's port is next handed out (never under a hello in flight); an older helper (no `lane` in its
// answer) leaves the JS lane as it was; close() frees the helper's lane.
// Needs: cargo build --release --example peer (in native/tdfast); skipped without it.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const BIN = path.join(__dirname, '..', '..', 'native', 'tdfast', 'target', 'release', 'examples', process.platform === 'win32' ? 'peer.exe' : 'peer');
if (!fs.existsSync(BIN)) { console.log('inputlane-mesh-native: skipped (build native/tdfast\'s example peer first)'); process.exit(0); }
process.env.TWINDESK_LANE_LOSS = '0';
const L = require('../inputlane.js');

const until = async (cond, what, ms = 8000) => {
  const t = Date.now();
  while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out: ' + what); await new Promise((r) => setTimeout(r, 5)); }
};

// The helper's `lane` command over the example peer. old: answers bind as a helper without numbered lanes.
function fakeHelper({ old = false } = {}) {
  const p = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const h = new EventEmitter();
  h.running = true;
  h.sent = [];
  h.injected = [];
  const waiting = [];
  readline.createInterface({ input: p.stdout }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.ev === 'port') { const w = waiting.shift(); if (w) w(old ? { port: m.port } : { port: m.port, ...(m.lane ? { lane: m.lane } : {}) }); }
    else if (m.ev === 'up') h.emit('event', 'lane', { up: true, rtt: m.rtt, ...(m.lane ? { lane: m.lane } : {}) });
    else if (m.ev === 'down') h.emit('event', 'lane', { up: false, ...(m.lane ? { lane: m.lane } : {}) });
    else if (m.ev === 'event') h.emit('event', 'laneEv', { msg: m.msg, ...(m.lane ? { lane: m.lane } : {}) });
    else if (m.ev === 'move') h.injected.push(m);
  });
  const cmd = (o) => p.stdin.write(JSON.stringify(old ? { ...o, lane: undefined } : o) + '\n');
  h.request = (name, args) => (h.running ? new Promise((res) => { waiting.push(res); cmd(args); }) : Promise.reject(new Error('helper not running')));
  h.send = (name, args) => { h.sent.push(args); if (h.running) cmd(args); };
  h.kill = () => { h.running = false; p.kill(); };
  return h;
}

(async () => {
  // 1. A lane whose port went out in a hello: still JS; the swap waits for the next hello.
  {
    const h = fakeHelper();
    const a = L.linkLane(); // the guest side of a device's link
    await a.bind();
    const jsPort = a.port;
    const hello = a.helloField();
    assert.strictEqual(hello.port, jsPort);
    L.meshNative(h); // the helper becomes ready while that hello is in flight
    await until(() => a._natPending, 'the helper lane bound');
    assert.ok(!a.native, 'not swapped under a hello in flight');
    assert.strictEqual(a.port, jsPort);
    // The welcome for that hello: a JS session on the JS port, as advertised.
    const host = new L.InputLane();
    await host.bind();
    const offer = host.offer(hello, '127.0.0.1');
    assert.ok(a.accept(offer, '127.0.0.1'));
    await until(() => a.up && host.up, 'the JS session up');
    a.stop(); host.stop();
    // The next hello: now the helper's lane.
    const hello2 = a.helloField();
    assert.ok(a.native, 'native from the next hello');
    assert.notStrictEqual(hello2.port, jsPort);
    const offer2 = host.offer(hello2, '127.0.0.1');
    assert.ok(a.accept(offer2, '127.0.0.1'));
    await until(() => a.up && host.up, 'the native session up');
    assert.ok(h.sent.some((x) => x.op === 'start' && x.lane === a.laneId));
    // Driven through the helper's lane: it injects the moves itself.
    const d = new L.LaneDriven({ route: () => 9, move: () => assert.fail('JS move on a native lane'), deliver: () => {}, native: () => (a.native ? a : null) });
    d.take(9);
    const t = new L.MoveTotals(); t.reset(9);
    host.sendMove(t.add(4, -3));
    await until(() => h.injected.some((m) => m.lane === a.laneId && m.dx === 4 && m.dy === -3), 'the helper injected it');
    // A second device: its own lane, its own port, both up.
    const pool = new L.LanePool();
    await until(() => pool.spare && pool.spare.native, 'the spare is native at once (nothing handed out yet)');
    const b = pool.spare;
    assert.notStrictEqual(b.laneId, a.laneId);
    const guest = new L.InputLane(); await guest.bind();
    const ctx = {};
    const w = pool.offer(ctx, guest.helloField(), '127.0.0.1');
    assert.strictEqual(ctx.ilLane, b);
    assert.ok(guest.accept(w, '127.0.0.1'));
    await until(() => b.up && guest.up, 'device 2 up');
    assert.ok(a.up, 'device 1 still up');
    // Its events come only to it.
    const evA = [], evB = [];
    a.on('event', (m) => evA.push(m)); b.on('event', (m) => evB.push(m));
    guest.sendEvent({ t: 'k.kd', code: 'KeyB', es: guest.nextEs() });
    await until(() => evB.length === 1, 'device 2 event');
    assert.strictEqual(evA.length, 0);
    // Closing a device's lane frees the helper's.
    pool.drop(ctx);
    assert.ok(h.sent.some((x) => x.op === 'close' && x.lane === b.laneId));
    await until(() => !guest.up, 'device 2 lane gone', 5000);
    assert.ok(a.up, 'device 1 unaffected');
    a.close(); pool.close(); host.close(); guest.close();
    assert.ok(h.sent.some((x) => x.op === 'close' && x.lane === a.laneId));
    // Closed lanes leave nothing on the helper, which lives on: a device that reconnects gets a new lane each time.
    assert.strictEqual(h.listenerCount('event'), 0, 'closed lanes: no event listener left on the helper');
    assert.strictEqual(h.listenerCount('exit'), 0, 'closed lanes: no exit listener left on the helper');
    h.kill();
  }
  // 2. An older helper (its bind answers lane 0's port, no `lane`): the lane stays JS.
  {
    const h = fakeHelper({ old: true });
    const c = L.linkLane();
    await c.bind();
    const port = c.port;
    L.meshNative(h);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!c.native && !c._natPending, 'an older helper: JS as before');
    assert.strictEqual(c.helloField().port, port);
    c.close();
    h.kill();
  }
  console.log('inputlane-mesh-native: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

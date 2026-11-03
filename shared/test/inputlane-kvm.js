// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The input lane end to end through two real kvm.js state machines (windows/kvm.js; mac/ and linux/
// use the same glue): real lanes on 127.0.0.1 losing 30% of their packets, and a slow WSS (TCP, in
// order). Every click and key lands where the moves before it took the pointer, once, in order;
// moves get there on the lane well before the WSS; and an app without the lane still works.
// Run with: node shared/test/inputlane-kvm.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const Module = require('module');
const P = require('../protocol.js');

const load = Module._load;
const mock = function (id, ...args) {
  if (id === 'electron') return {};
  if (id === '../shared/kvm-map.js') return { KvmMap: class extends EventEmitter { zones() { return null; } reset() {} sendDisplays() {} toPeer(v) { return v; } } };
  return load.call(this, id, ...args);
};
Module._load = mock;
const Kvm = require('../../windows/kvm.js');
Module._load = load;
const L = require('../inputlane.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(2);
  }
};

// One computer: a link-shaped object (what windows/peer.js gives kvm.js), its kvm, what it injected.
function computer(name, withLane) {
  const link = Object.assign(new EventEmitter(), {
    status: { state: 'connected' }, authed: true, peerOs: P.OS.WIN, lastRx: Date.now(), bufferedAmount: 0, hosting: false,
    il: withLane ? new L.InputLane() : null,
  });
  link.lane = () => (link.il && link.il.started ? link.il : null);
  link.wssDelay = 40;
  link.send = (m) => {
    const copy = JSON.parse(JSON.stringify(m));
    setTimeout(() => { link.other.lastRx = Date.now(); link.other.emit(copy.t, copy); }, link.wssDelay);
    return true;
  };
  const injected = [];
  const helper = Object.assign(new EventEmitter(), { send: (cmd, args) => injected.push({ cmd, ...args }), request: async () => ({}), stop() {} });
  const settings = { kvm: { speed: 1, linked: true, beDriven: true, driveOther: true, mouse: true, keyboard: true, pcSide: 'left', linkedBy: {} }, keys: { swapCtrlCmd: false }, files: {} };
  Module._load = mock;
  const kvm = new Kvm({ link, helper, settings, fileRecv: { onRelease() {} }, fileDrop: {}, clip: { sendIfChanged() {} }, onChange() {} });
  Module._load = load;
  return { name, link, kvm, helper, injected };
}

function pair(aLane, bLane) {
  const a = computer('A', aLane);
  const b = computer('B', bLane);
  a.link.other = b.link;
  b.link.other = a.link;
  return { a, b };
}

// What B's helper was told, as one list: the pointer's total at each click/key, in order.
function story(injected) {
  let x = 0;
  let y = 0;
  const out = [];
  for (const c of injected) {
    if (c.cmd !== 'inject' || !c.ev) continue;
    if (c.ev.t === P.T.K_MOVE) { x += c.ev.dx; y += c.ev.dy; continue; }
    out.push(`${c.ev.t}${c.ev.code ? ':' + c.ev.code : ''}@${Math.round(x)},${Math.round(y)}`);
  }
  return { out, x, y };
}

const ev = (who, e) => who.helper.emit('event', 'ev', { ev: e });

async function play(a) {
  for (let i = 0; i < 20; i++) { ev(a, { t: P.T.K_MOVE, dx: 1, dy: 0 }); await wait(1); }
  ev(a, { t: P.T.K_DOWN, b: 0 });
  for (let i = 0; i < 10; i++) { ev(a, { t: P.T.K_MOVE, dx: 2, dy: 1 }); await wait(1); }
  ev(a, { t: P.T.K_UP, b: 0 });
  for (let i = 0; i < 5; i++) { ev(a, { t: P.T.K_MOVE, dx: -1, dy: 0 }); await wait(1); }
  ev(a, { t: P.T.K_KEY_DOWN, code: 'KeyA' });
  ev(a, { t: P.T.K_KEY_UP, code: 'KeyA' });
  ev(a, { t: P.T.K_WHEEL, dx: 0, dy: 3 });
  for (let i = 0; i < 3; i++) { ev(a, { t: P.T.K_MOVE, dx: 0, dy: 2 }); await wait(1); }
}
const EXPECTED = ['k.md@20,0', 'k.mu@40,10', 'k.kd:KeyA@35,10', 'k.ku:KeyA@35,10', 'k.wh@35,10'];

const keepAlive = setInterval(() => {}, 1000);
(async () => {
  const quiet = console.log;
  console.log = (...m) => { if (!/^\[(lane|kvm)\]/.test(String(m[0]))) quiet(...m); };

  // ---- both with the lane, 30% loss on it ----
  for (let run = 0; run < 3; run++) {
    process.env.TWINDESK_LANE_LOSS = '0.3';
    const { a, b } = pair(true, true);
    delete process.env.TWINDESK_LANE_LOSS;
    await a.link.il.bind();
    await b.link.il.bind();
    assert.ok(b.link.il.accept(a.link.il.offer(b.link.il.helloField(), '127.0.0.1'), '127.0.0.1'));
    await until(() => a.link.il.up && b.link.il.up);
    a.kvm._take({ side: 'left', offset: 0.5 });
    await until(() => b.kvm.mode === 'driven' && a.kvm.acceptTimer === null);
    a.link.il.loss = 0; // the timing without loss; then 30% for the rest
    const t0 = Date.now();
    ev(a, { t: P.T.K_MOVE, dx: 5, dy: 5 });
    await until(() => story(b.injected).x === 5);
    assert.ok(Date.now() - t0 < 30, `a move gets there on the lane, not the 40 ms WSS (${Date.now() - t0} ms)`);
    a.link.il.loss = 0.3;
    b.injected.length = 0;
    await play(a);
    await wait(150); // the WSS copies too
    await until(() => story(b.injected).y === 16, 2000).catch(() => {}); // a lost last move: the next ping's resend heals it
    const s = story(b.injected);
    assert.deepStrictEqual(s.out, EXPECTED, `run ${run}: every event once, in order, where it belongs`);
    assert.deepStrictEqual([s.x, s.y], [35, 16], 'the pointer ends where it should');
    assert.ok(!b.injected.some((c) => c.ev && ('es' in c.ev || 'mn' in c.ev)), 'the helper never sees the lane’s fields');
    a.kvm._setMode('home', '');
    b.kvm._setMode('home', '');
    a.link.il.close();
    b.link.il.close();
  }

  // ---- lane down (the other side went quiet): moves and events on WSS, with totals ----
  {
    const { a, b } = pair(true, true);
    await a.link.il.bind();
    await b.link.il.bind();
    b.link.il.accept(a.link.il.offer(b.link.il.helloField(), '127.0.0.1'), '127.0.0.1');
    await until(() => a.link.il.up);
    a.kvm._take({ side: 'left', offset: 0.5 });
    await until(() => b.kvm.mode === 'driven');
    // B stops answering pings and drops what comes on the lane (a firewall shut it).
    b.link.il.sock.removeAllListeners('message');
    await until(() => !a.link.il.up, 2000);
    b.injected.length = 0;
    const sent = [];
    const send = a.link.send;
    a.link.send = (m) => { sent.push(m); return send(m); };
    await play(a);
    await wait(150);
    assert.ok(sent.some((m) => m.t === P.T.K_MOVE && Number.isInteger(m.mn)), 'k.mm with totals on WSS');
    assert.deepStrictEqual(story(b.injected).out, EXPECTED);
    a.kvm._setMode('home', '');
    b.kvm._setMode('home', '');
    a.link.il.close();
    b.link.il.close();
  }

  // ---- an app without the lane (an older one): today's messages both ways ----
  for (const [aLane, bLane] of [[true, false], [false, true], [false, false]]) {
    const { a, b } = pair(aLane, bLane);
    a.kvm._take({ side: 'left', offset: 0.5 });
    await until(() => b.kvm.mode === 'driven');
    const sent = [];
    const send = a.link.send;
    a.link.send = (m) => { sent.push(m); return send(m); };
    await play(a);
    await wait(150);
    assert.ok(!sent.some((m) => 'es' in m || 'mn' in m), 'no lane: no new fields on the wire');
    assert.deepStrictEqual(story(b.injected).out, EXPECTED, `lane ${aLane}/${bLane}`);
    a.kvm._setMode('home', '');
    b.kvm._setMode('home', '');
    if (a.link.il) a.link.il.close();
    if (b.link.il) b.link.il.close();
  }

  // ---- a lane started on one side only (the other's accept failed): the new fields are ignored ----
  {
    const { a, b } = pair(true, false);
    await a.link.il.bind();
    a.link.il.offer({ v: 1, port: 9 }, '127.0.0.1'); // nobody answers there
    a.kvm._take({ side: 'left', offset: 0.5 });
    await until(() => b.kvm.mode === 'driven');
    await play(a);
    await wait(150);
    assert.deepStrictEqual(story(b.injected).out, EXPECTED, 'an app that ignores es/mn still gets it all');
    a.kvm._setMode('home', '');
    b.kvm._setMode('home', '');
    a.link.il.close();
  }

  console.log = quiet;
  clearInterval(keepAlive);
  console.log('inputlane-kvm: ok');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

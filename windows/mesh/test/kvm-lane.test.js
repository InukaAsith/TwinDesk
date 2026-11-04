// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The input lane (shared/inputlane.js, docs/protocol.md) in the multi-device app: two computers with
// real Server, Pairing, LinkManager, Mesh, Hub, LayoutSync and Kvm (fake helpers), paired on real
// sockets. A drives B: moves go over B's lane (not the bus), clicks and keys come in order and once,
// and a B without a lane (an older app) gets everything on the WSS as before.
// Run with: node windows/mesh/test/kvm-lane.test.js  (NODE_PATH as in CI)
'use strict';

process.env.TWINDESK_LANE_LOSS = '0.3'; // every packet A or B sends: 30% lost

const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('../../../shared/protocol.js');
const { Mesh } = require('../../../shared/mesh.js');
const { Server } = require('../server.js');
const { Pairing } = require('../hostpair.js');
const { LinkManager } = require('../links.js');
const { Hub } = require('../hub.js');
const Kvm = require('../kvm.js');
const LayoutSync = require('../layout-sync.js');
const { normalize } = require('../settings.js');
const { runTests } = require('./lib/run.js');
const { loadTestCert } = require('./lib/testcert.js');
const { close, waitFor, pair, memoryStorage } = require('./lib/mesh.js');

const T = P.T;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RecHelper extends EventEmitter {
  constructor() {
    super();
    this.running = true;
    this.error = '';
    this.sent = [];
  }

  send(name, args) {
    this.sent.push({ name, args });
  }

  request() {
    return Promise.resolve({});
  }

  stop() {}
}

async function hubNode(name, { lane = true } = {}) {
  const cert = loadTestCert();
  const id = crypto.randomUUID();
  const server = new Server({ pfx: cert.pfx, passphrase: cert.passphrase, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  if (!lane) { // an app from before the lane: no `il` in its hello, none in its welcome
    server.ilPool.close();
    server.ilPool.offer = () => null;
  }
  const st = memoryStorage();
  const pairing = new Pairing(server, { id, name, fp: cert.fp }, { storage: st });
  const links = new LinkManager({ device: { id, name }, storage: st, hostPairing: pairing });
  links.bindServer(server);
  if (!lane) {
    const add = links._newLink.bind(links);
    links._newLink = (e) => {
      const l = add(e);
      if (l.ilLane) l.ilLane.close();
      l.ilLane = null;
      return l;
    };
  }
  const mesh = new Mesh({ selfId: id });
  const hub = new Hub({ device: { id, name }, links, server, pairing, mesh });
  const n = { name, id, fp: cert.fp, port: server.port, server, pairing, links, mesh, hub, bus: [], settings: normalize({ kvm: { mouse: true, keyboard: true } }) };
  n.layoutSync = new LayoutSync({
    bus: hub.bus,
    mesh,
    selfId: id,
    storage: { get: () => n.settings.layout, set: (l) => { n.settings.layout = l; } },
    knownIds: () => hub.peers().map((p) => p.id),
    onChange: () => { if (n.kvm) n.kvm.layoutChanged(); },
  });
  n.helper = new RecHelper();
  n.kvm = new Kvm({
    hub, layoutSync: n.layoutSync, helper: n.helper,
    clip: { sendIfChanged: () => true },
    fileDrop: { prepareDrag: () => null, beginDrag() {}, cancelRelease() {} },
    fileRecv: { onRelease() {} },
    dragRecv: null,
    settings: n.settings, save: () => {}, onChange: () => {},
  });
  for (const t of [T.K_MOVE, T.K_DOWN, T.K_UP, T.K_KEY_DOWN]) hub.bus.on(t, (m) => n.bus.push(m));
  return n;
}

// What B's helper was told to inject: the sum of the moves, and the rest in order.
function injected(n) {
  const evs = n.helper.sent.filter((x) => x.name === 'inject').map((x) => x.args.ev);
  const moves = evs.filter((e) => e.t === T.K_MOVE);
  return {
    dx: moves.reduce((s, e) => s + e.dx, 0),
    dy: moves.reduce((s, e) => s + e.dy, 0),
    rest: evs.filter((e) => e.t !== T.K_MOVE).map((e) => (e.code ? `${e.t}:${e.code}` : `${e.t}:${e.b}`)),
  };
}

async function drive(opts) {
  const A = await hubNode('A');
  const B = await hubNode('B', opts);
  await pair(A, B);
  const up = (a, b) => { const s = a.hub.sessions.get(b.id); return !!s && s.connected; };
  await waitFor(() => up(A, B) && up(B, A), 'A and B linked');
  assert.strictEqual(A.layoutSync.place(A.id, 0, 0), true);
  assert.strictEqual(A.layoutSync.place(B.id, 1, 0), true);
  await waitFor(() => B.kvm.edges.left === A.id, 'B knows A is on its left');
  A.helper.emit('event', 'edge', { side: 'right', offset: 0.5 });
  await waitFor(() => B.kvm.mode === 'driven', 'B is driven');
  await waitFor(() => A.kvm.mode === 'driving', 'A drives');
  return { A, B };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the lane carries A\'s moves to B (none on the bus), exact under 30% loss; clicks and keys in order, once', async () => {
  const { A, B } = await drive();
  try {
    const lane = A.hub.sessions.get(B.id).lane();
    assert.ok(lane, 'A has a lane to B');
    await waitFor(() => lane.up, 'the lane is up');
    let x = 0;
    let y = 0;
    for (let i = 0; i < 200; i++) {
      const dx = (i % 7) - 2;
      const dy = (i % 5) - 1;
      x += dx; y += dy;
      A.helper.emit('event', 'ev', { ev: { t: T.K_MOVE, dx, dy } });
      if (i === 50) A.helper.emit('event', 'ev', { ev: { t: T.K_DOWN, b: 0 } });
      if (i === 60) A.helper.emit('event', 'ev', { ev: { t: T.K_UP, b: 0 } });
      if (i === 120) A.helper.emit('event', 'ev', { ev: { t: T.K_KEY_DOWN, code: 'KeyA' } });
      if (i % 10 === 0) await sleep(3);
    }
    const speed = B.settings.kvm.speed || 1;
    await waitFor(() => { const g = injected(B); return Math.abs(g.dx - x * speed) < 1e-6 && Math.abs(g.dy - y * speed) < 1e-6; }, 'B ends exactly where A\'s moves took it');
    const g = injected(B);
    assert.deepStrictEqual(g.rest, ['k.md:0', 'k.mu:0', 'k.kd:KeyA'], 'each click and key once, in order');
    assert.strictEqual(B.bus.filter((m) => m.t === T.K_MOVE).length, 0, 'no k.mm on the bus while the lane is up');
    assert.ok(B.bus.filter((m) => m.t === T.K_DOWN).every((m) => Number.isInteger(m.es)), 'the WSS copy of a click is numbered');
  } finally {
    close(A, B);
  }
});

test('B without a lane (an older app): A sends everything on the WSS as before', async () => {
  const { A, B } = await drive({ lane: false });
  try {
    assert.strictEqual(A.hub.sessions.get(B.id).lane(), null, 'no lane to B');
    A.helper.emit('event', 'ev', { ev: { t: T.K_MOVE, dx: 5, dy: 2 } });
    A.helper.emit('event', 'ev', { ev: { t: T.K_DOWN, b: 0 } });
    await waitFor(() => B.bus.some((m) => m.t === T.K_DOWN), 'B gets the click');
    const mm = B.bus.filter((m) => m.t === T.K_MOVE);
    assert.ok(mm.length >= 1 && mm.every((m) => m.mn === undefined), 'plain k.mm');
    assert.strictEqual(B.bus.find((m) => m.t === T.K_DOWN).es, undefined, 'a plain click');
    await waitFor(() => injected(B).rest.length === 1, 'B injects the click');
    assert.strictEqual(injected(B).dx, 5 * (B.settings.kvm.speed || 1));
  } finally {
    close(A, B);
  }
});

runTests(tests);

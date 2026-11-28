// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A file drag going back home with the pointer (Multi-device, as the one-to-one kvm.js): A drives B;
// on B an Explorer drag held with A's button ends at B's way back (DropEdge.cs, `return {drag:
// {paths}}`): B's files go to A as a drag (through A's FileDrop on B: prepareDrag(paths, A)), and A,
// told in kvm.home {drag: {count}}, expects them at its pointer (dragRecv.expectHome(B)). Before, the
// return's drag was dropped and so were the files.
// Run with: node linux/mesh/test/kvm-dragback.test.js
'use strict';

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
const { close, waitFor, pair, pairPhone, helloPhone, memoryStorage } = require('./lib/mesh.js');

const T = P.T;
const TRIANGLE = [['A', 'B'], ['A', 'C'], ['B', 'C']]; // [dialer, host]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// A computer: Server + Pairing + LinkManager + Mesh + Hub + LayoutSync. Extra ids for the layout (a phone
// this computer does not pair with, but places next to it) go in n.extra.
async function hubNode(name) {
  const cert = loadTestCert();
  const id = crypto.randomUUID();
  const server = new Server({ key: cert.key, cert: cert.cert, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const storage = memoryStorage();
  const pairing = new Pairing(server, { id, name, fp: cert.fp }, { storage });
  const links = new LinkManager({ device: { id, name }, storage, hostPairing: pairing });
  links.bindServer(server);
  const mesh = new Mesh({ selfId: id });
  const hub = new Hub({ device: { id, name }, links, server, pairing, mesh });
  const n = { name, id, port: server.port, fp: cert.fp, server, pairing, links, mesh, hub, log: [], kvm: null, extra: [], settings: normalize({ kvm: { mouse: true, keyboard: true } }) }; // saved settings with the cursor on (a fresh install has it off)
  n.layoutSync = new LayoutSync({
    bus: hub.bus,
    mesh,
    selfId: id,
    storage: { get: () => n.settings.layout, set: (l) => { n.settings.layout = l; } },
    knownIds: () => [...hub.peers().map((p) => p.id), ...n.extra],
    onChange: () => { if (n.kvm) n.kvm.layoutChanged(); },
  });
  return n;
}

async function world(names, pairs) {
  const N = {};
  for (const name of names) N[name] = await hubNode(name);
  for (const [a, b] of pairs) await pair(N[a], N[b]);
  const up = (a, b) => { const s = a.hub.sessions.get(b.id); return !!s && s.connected; };
  await waitFor(() => pairs.every(([a, b]) => up(N[a], N[b]) && up(N[b], N[a])), 'every pair linked on both sides');
  return N;
}

const all = (N) => Object.values(N);
const closeAll = (N) => close(...all(N));

// The helper of a computer as Kvm sees it: send() is recorded, and the test emits its events.
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

  last(name) {
    for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].name === name) return this.sent[i].args;
    return undefined;
  }

  count(name) {
    return this.sent.filter((x) => x.name === name).length;
  }

  stop() {}
}

// A real Kvm on node n, with a recording helper and the kvm messages of its bus recorded.
function kvmOn(n) {
  n.helper = new RecHelper();
  n.kvm = new Kvm({
    hub: n.hub,
    layoutSync: n.layoutSync,
    helper: n.helper,
    clip: { sendIfChanged: () => true },
    fileDrop: n.fileDrop || { prepareDrag: () => null, beginDrag() {}, cancelRelease() {} },
    fileRecv: { onRelease() {} },
    dragRecv: n.dragRecv || null,
    settings: n.settings,
    save: () => {},
    onChange: () => {},
  });
  for (const t of [T.KVM_TAKE, T.KVM_RELEASE, T.KVM_HOME, T.KVM_ACCEPT, T.KVM_NEXT, T.K_MOVE]) {
    n.hub.bus.on(t, (m, from) => n.log.push({ t, from, m }));
  }
  return n.kvm;
}

const got = (n, t) => n.log.filter((x) => x.t === t);

// A drives `to` through `side` of A (the helper saw the edge), and `to` accepts.
async function driveVia(A, to, side, offset = 0.5) {
  const before = got(to, T.KVM_TAKE).length;
  A.helper.emit('event', 'edge', { side, offset });
  await waitFor(() => got(to, T.KVM_TAKE).length === before + 1, `${to.name} gets kvm.take`);
  const take = got(to, T.KVM_TAKE)[before];
  to.hub.bus.send(A.id, { t: T.KVM_ACCEPT, route: take.m.route });
  await waitFor(() => A.kvm.mode === 'driving' && A.kvm.partner === to.id, `A drives ${to.name}`);
  return take;
}

// The row A B C on A's layout, and the same on every node (the layout is synced).
async function row(N, cells = { A: [0, 0], B: [1, 0], C: [2, 0] }) {
  const { A } = N;
  for (const name of Object.keys(cells)) {
    assert.strictEqual(A.layoutSync.place(N[name].id, ...cells[name]), true, `place ${name}`);
  }
  await waitFor(() => all(N).every((n) => n.layoutSync.get() && n.layoutSync.get().rev === A.layoutSync.get().rev), 'the layout on every computer');
}

test('a drag held on the way back goes home with the pointer: its files follow as a drag there', async () => {
  const N = await world(['A', 'B'], [['B', 'A']]);
  try {
    const { A, B } = N;
    for (const n of [A, B]) Object.assign(n.settings.files, { edgeDrag: true, dropToMac: true, acceptFromMac: true });
    const prepared = [];
    const begun = [];
    B.fileDrop = { prepareDrag: (paths, to) => { prepared.push({ paths, to }); return { drag: 'd1', count: paths.length }; }, beginDrag: (d) => begun.push(d), cancelRelease() {} };
    const expected = [];
    A.dragRecv = { expectHome: (from) => expected.push(from), dragging: false, cur: null, onHome() {}, onRelease() {}, cancel() {} };
    kvmOn(A); kvmOn(B);
    await row(N, { A: [0, 0], B: [1, 0] });
    await waitFor(() => B.kvm.dragPolicyBy.get(A.id) === true, 'B hears A takes drags');
    await driveVia(A, B, 'right');
    B.helper.emit('event', 'return', { side: 'left', offset: 0.5, drag: { paths: ['C:\\Users\\me\\report.pdf'] } });
    await waitFor(() => got(A, T.KVM_HOME).length === 1, 'A gets kvm.home');
    assert.deepStrictEqual(got(A, T.KVM_HOME)[0].m.drag, { count: 1 }, 'kvm.home says the files follow');
    assert.deepStrictEqual(prepared, [{ paths: ['C:\\Users\\me\\report.pdf'], to: A.id }], 'B sends them to A, its driver');
    assert.strictEqual(begun.length, 1, 'after kvm.home: drag.start, then the files');
    await waitFor(() => expected.length === 1, 'A expects them');
    assert.deepStrictEqual(expected, [B.id], 'from B');
    assert.strictEqual(A.kvm.mode, 'home');
  } finally {
    closeAll(N);
  }
});

runTests(tests);

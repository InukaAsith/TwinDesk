// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Selection and cursor sharing (#245): real Kvm instances with fake helpers on real sockets, and the real
// PairSync on A's facade (the selected device), as mesh/main.js wires it. In the row C - A - B, C doesn't
// share its mouse and keyboard: selecting C (a crossing, a reconnect, the Overview) must not stop A from
// reaching B, a take C refuses selects back what was selected, and selecting a device whose cursor switch
// is off doesn't send home the device A drives.
// Run with: node windows/mesh/test/kvm-selection.test.js  (NODE_PATH as in CI)
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
const { PairSync } = require('../../pairsync.js');
const { normalize } = require('../settings.js');
const { runTests } = require('./lib/run.js');
const { loadTestCert } = require('./lib/testcert.js');
const { close, waitFor, pair, memoryStorage } = require('./lib/mesh.js');

const T = P.T;
const TRIANGLE = [['A', 'B'], ['A', 'C'], ['B', 'C']]; // [dialer, host]
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

async function hubNode(name) {
  const cert = loadTestCert();
  const id = crypto.randomUUID();
  const server = new Server({ pfx: cert.pfx, passphrase: cert.passphrase, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const storage = memoryStorage();
  const pairing = new Pairing(server, { id, name, fp: cert.fp }, { storage });
  const links = new LinkManager({ device: { id, name }, storage, hostPairing: pairing });
  links.bindServer(server);
  const mesh = new Mesh({ selfId: id });
  const hub = new Hub({ device: { id, name }, links, server, pairing, mesh });
  const n = { name, id, port: server.port, fp: cert.fp, server, pairing, links, mesh, hub, log: [], kvm: null, settings: normalize({ kvm: { mouse: true, keyboard: true } }) };
  n.layoutSync = new LayoutSync({
    bus: hub.bus,
    mesh,
    selfId: id,
    storage: { get: () => n.settings.layout, set: (l) => { n.settings.layout = l; } },
    knownIds: () => hub.peers().map((p) => p.id),
    onChange: () => { if (n.kvm) n.kvm.layoutChanged(); },
  });
  return n;
}

async function world() {
  const N = {};
  for (const name of ['A', 'B', 'C']) N[name] = await hubNode(name);
  for (const [a, b] of TRIANGLE) await pair(N[a], N[b]);
  const up = (a, b) => { const s = a.hub.sessions.get(b.id); return !!s && s.connected; };
  await waitFor(() => TRIANGLE.every(([a, b]) => up(N[a], N[b]) && up(N[b], N[a])), 'every pair linked on both sides');
  return N;
}

const closeAll = (N) => close(...Object.values(N));

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

  stop() {}
}

function kvmOn(n) {
  n.helper = new RecHelper();
  n.kvm = new Kvm({
    hub: n.hub,
    layoutSync: n.layoutSync,
    helper: n.helper,
    clip: { sendIfChanged: () => true },
    fileDrop: { prepareDrag: () => null, beginDrag() {}, cancelRelease() {} },
    fileRecv: { onRelease() {} },
    dragRecv: null,
    settings: n.settings,
    save: () => {},
    onChange: () => {},
  });
  for (const t of [T.KVM_TAKE, T.KVM_REFUSE]) n.hub.bus.on(t, (m, from) => n.log.push({ t, from, m }));
  return n.kvm;
}

// The two-way switches on A's facade, applied to A's settings as ipc.set does.
function pairSyncOn(n) {
  n.pairSync = new PairSync({
    link: n.hub.facade,
    settings: n.settings,
    save: () => {},
    set: (section, partial) => Object.assign(n.settings[section], partial),
    only: ['clipboard', 'notifs', 'apps', 'audio', 'cursor', 'terminal', 'files'],
    bus: n.hub.bus,
    peerRole: (id) => { const s = n.hub.sessions.get(id); return s ? s.role : null; },
    peerOs: (id) => { const s = n.hub.sessions.get(id); return s ? s.peerOs : null; },
  });
  return n.pairSync;
}

const got = (n, t) => n.log.filter((x) => x.t === t);

// The row C - A - B on every computer.
async function row(N) {
  const { A } = N;
  const cells = { C: [0, 0], A: [1, 0], B: [2, 0] };
  for (const name of Object.keys(cells)) assert.strictEqual(A.layoutSync.place(N[name].id, ...cells[name]), true, `place ${name}`);
  await waitFor(() => Object.values(N).every((n) => n.layoutSync.get() && n.layoutSync.get().rev === A.layoutSync.get().rev), 'the layout on every computer');
  await waitFor(() => A.layoutSync.neighbors().left === N.C.id && A.layoutSync.neighbors().right === N.B.id, 'A sees C on its left and B on its right');
}

// The pairs A remembers: B shares the mouse and keyboard with A, C doesn't.
function pairs(N) {
  const { A, B } = N;
  A.settings.pairSync = {
    [B.id]: { cursor: { out: true, in: true }, values: {} },
    [N.C.id]: { cursor: { out: false, in: false }, values: {} },
  };
}

test('C is selected and its pair does not share the mouse: A still crosses to B, and B may still drive A', async () => {
  const N = await world();
  try {
    const { A, B } = N;
    kvmOn(A); kvmOn(B); kvmOn(N.C);
    pairs(N);
    pairSyncOn(A);
    await row(N);
    A.hub.select(B.id);
    assert.strictEqual(A.hub.select(N.C.id), true);
    // What #245 saw: C's pair is the one in A's settings now.
    assert.strictEqual(A.settings.kvm.driveOther, false, 'the settings show the selected pair (C)');
    assert.strictEqual(A.settings.kvm.beDriven, false);
    // A's pointer leaves to the right: B is taken.
    const before = got(B, T.KVM_TAKE).length;
    A.helper.emit('event', 'edge', { side: 'right', offset: 0.5 });
    await waitFor(() => got(B, T.KVM_TAKE).length === before + 1, 'B gets kvm.take');
    await waitFor(() => A.kvm.mode === 'driving' && A.kvm.partner === B.id, 'A drives B');
    assert.strictEqual(A.hub.selectedId, B.id, 'the crossing selected B');
    await waitFor(() => B.kvm.mode === 'driven', 'B accepted');
    B.helper.emit('event', 'return', { side: 'left', offset: 0.5 });
    await waitFor(() => A.kvm.mode === 'home', 'A is home');

    // C selected again; B's pointer crossing to A is still accepted (B's pair says A may be driven by B).
    A.hub.select(N.C.id);
    assert.strictEqual(A.settings.kvm.beDriven, false, 'the settings show C’s pair');
    const refusedBefore = got(B, T.KVM_REFUSE).length;
    B.hub.select(A.id);
    B.helper.emit('event', 'edge', { side: 'left', offset: 0.5 });
    await waitFor(() => A.kvm.mode === 'driven' && A.kvm.partner === B.id, 'A is driven by B');
    assert.strictEqual(got(B, T.KVM_REFUSE).length, refusedBefore, 'A did not refuse B');
  } finally {
    closeAll(N);
  }
});

test('C refuses the take (sharing off there): A goes home and B is selected again', async () => {
  const N = await world();
  try {
    const { A, B } = N;
    kvmOn(A); kvmOn(B); kvmOn(N.C);
    N.C.settings.kvm.beDriven = false; // C: other devices may not use its mouse and keyboard
    await row(N);
    A.hub.select(B.id);
    A.helper.emit('event', 'edge', { side: 'left', offset: 0.5 });
    await waitFor(() => got(N.C, T.KVM_TAKE).length === 1, 'C gets kvm.take');
    await waitFor(() => got(A, T.KVM_REFUSE).length === 1, 'C refuses');
    await waitFor(() => A.kvm.mode === 'home', 'A is home');
    await waitFor(() => A.hub.selectedId === B.id, 'B is selected again');
    assert.strictEqual(A.kvm.selBack, null);

    // And B can be reached as before.
    A.helper.emit('event', 'edge', { side: 'right', offset: 0.5 });
    await waitFor(() => got(B, T.KVM_TAKE).length === 1, 'B gets kvm.take');
    await waitFor(() => A.kvm.mode === 'driving' && A.kvm.partner === B.id, 'A drives B');
    await waitFor(() => B.kvm.mode === 'driven', 'B accepted');
    assert.strictEqual(A.kvm.selBack, null, 'an accepted take forgets the selection before it');
  } finally {
    closeAll(N);
  }
});

test('selecting a device whose cursor switch is off does not send home the device A drives', async () => {
  const N = await world();
  try {
    const { A, B } = N;
    kvmOn(A); kvmOn(B); kvmOn(N.C);
    await row(N);
    A.settings.kvm.linkedBy = { ...A.settings.kvm.linkedBy, [N.C.id]: false };
    A.hub.select(B.id);
    A.helper.emit('event', 'edge', { side: 'right', offset: 0.5 });
    await waitFor(() => A.kvm.mode === 'driving' && A.kvm.partner === B.id, 'A drives B');
    await waitFor(() => B.kvm.mode === 'driven', 'B accepted');
    A.hub.select(N.C.id); // the Overview's Use, or a reconnect
    assert.strictEqual(A.kvm.linked, false, 'the switch shows C’s pair');
    assert.strictEqual(A.kvm.mode, 'driving', 'A still drives B');
    assert.strictEqual(A.kvm.partner, B.id);
    assert.strictEqual(A.settings.kvm.linkedBy[B.id] !== false, true, 'B’s own switch is untouched');
  } finally {
    closeAll(N);
  }
});

runTests(tests);

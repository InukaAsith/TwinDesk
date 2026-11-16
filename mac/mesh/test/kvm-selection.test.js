// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Selecting a device on the Mac no longer turns off what runs with another one (#245): real Kvm instances
// (mac/mesh/kvm.js) with fake helpers on real sockets, C - A - B in a row. The settings hold the selected
// device's pair (PairSync); every other device goes by settings.pairSync[id] (shared/pairfor.js).
// Run with: node mac/mesh/test/kvm-selection.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const P = require('../../../shared/protocol.js');
const store = require('../store.js');
const { Kvm } = require('../kvm.js');
const LayoutSync = require('../layout-sync.js');
const { runTests } = require('../../../windows/mesh/test/lib/run.js');
const { node: baseNode, close, waitFor, pair, hello, memoryStorage } = require('./lib/mesh.js');

store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-kvm-chain-')));

const T = P.T;
const TRIANGLE = [['A', 'B'], ['A', 'C'], ['B', 'C']];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function settingsObj() {
  return {
    kvm: {
      pcSide: 'right', mouse: true, keyboard: true, driveOther: true, beDriven: true, linked: true, linkedBy: {},
      resistancePx: 120, speed: 1, reverseScroll: false, gestures: true, hotkeySwitch: false,
    },
    keys: { swapCtrlCmd: true, hotkey: 'AltRight' },
    phone: {},
    layout: null,
  };
}

// A computer: the real hub with its links, and a LayoutSync kept in its settings (as main.js keeps it).
async function node(name, opts = {}) {
  const n = await baseNode(name, opts);
  n.log = [];
  n.extra = [];
  n.settings = settingsObj();
  n.ls = new LayoutSync({
    bus: n.hub.bus,
    mesh: n.mesh,
    selfId: n.id,
    storage: { get: () => n.settings.layout, set: (l) => { n.settings.layout = l; } },
    knownIds: () => [...n.hub.peers().map((p) => p.id), ...n.extra],
    onChange: () => { if (n.kvm) n.kvm.layoutChanged(); },
  });
  return n;
}

async function world(names, pairs) {
  const N = {};
  for (const name of names) N[name] = await node(name);
  for (const [a, b] of pairs) await pair(N[a], N[b]);
  const up = (a, b) => { const s = a.hub.sessions.get(b.id); return !!s && s.connected; };
  await waitFor(() => pairs.every(([a, b]) => up(N[a], N[b]) && up(N[b], N[a])), 'every pair linked on both sides');
  return N;
}

const all = (N) => Object.values(N);
const closeAll = (N) => close(...all(N));

// The helper of a computer as Kvm sees it: send() and request() are recorded, the test emits its events.
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

  request(name, args) {
    this.sent.push({ name, args });
    return Promise.resolve({});
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
  const fileSend = Object.assign(new EventEmitter(), { dragOn: false, peerDrag: false, planDrag: () => null, startDrag: () => null, cancelDrag() {} });
  const drop = { dragIn: { dragging: false, armDrag() {}, onDriven() {}, cancel() {}, release() {} }, cancelDrag() {}, release() {}, armDrag() {} };
  n.kvm = new Kvm({
    hub: n.hub,
    layoutSync: n.ls,
    helper: n.helper,
    getSettings: () => n.settings,
    clipboard: { sendIfChanged: () => true },
    input: { releaseAll() {} },
    drop,
    fileSend,
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
    assert.strictEqual(A.ls.place(N[name].id, ...cells[name]), true, `place ${name}`);
  }
  await waitFor(() => all(N).every((n) => n.ls.get() && n.ls.get().rev === A.ls.get().rev), 'the layout on every computer');
}


const CELLS = { C: [0, 0], A: [1, 0], B: [2, 0] };

test('C’s pair has cursor sharing off: selecting C (its pair in the settings) leaves the edge to B live', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    kvmOn(A); kvmOn(B); kvmOn(C);
    await row(N, CELLS);
    A.settings.pairSync = { [B.id]: { cursor: { out: true, in: true } }, [C.id]: { cursor: { out: false, in: false } } };
    A.hub.select(C.id);
    A.settings.kvm.driveOther = false; // PairSync adopted C's pair
    A.settings.kvm.beDriven = false;
    A.kvm.config();
    assert.deepStrictEqual(A.kvm._edgeConfig().sides, ['right'], 'only the edge to B is watched (C is off)');
    assert.strictEqual(A.kvm._canDriveTo(B.id), true, 'B can still be driven');
    assert.strictEqual(A.kvm._canDriveTo(C.id), false, 'C can’t');
    await driveVia(A, B, 'right');
    assert.strictEqual(A.hub.selectedId, B.id);
  } finally {
    closeAll(N);
  }
});

test('a take that is refused selects back the device that was selected', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    kvmOn(A); kvmOn(B); kvmOn(C);
    await row(N, CELLS);
    A.hub.select(B.id);
    C.settings.kvm.beDriven = false; // C doesn't let others drive it
    A.helper.emit('event', 'edge', { side: 'left', offset: 0.5 });
    assert.strictEqual(A.hub.selectedId, C.id, 'the crossing selected C');
    await waitFor(() => A.kvm.mode === 'home', 'A is home (C refused)');
    await waitFor(() => A.hub.selectedId === B.id, 'B is selected again');
  } finally {
    closeAll(N);
  }
});

test('selecting a device whose cursor switch is off shows it without sending home the device being driven', async () => {
  const N = await world(['A', 'B', 'C'], TRIANGLE);
  try {
    const { A, B, C } = N;
    kvmOn(A); kvmOn(B); kvmOn(C);
    await row(N, CELLS);
    A.settings.kvm.linkedBy = { [C.id]: false };
    await driveVia(A, B, 'right');
    A.hub.select(C.id);
    assert.strictEqual(A.settings.kvm.linked, false, 'the switch shows C’s');
    assert.strictEqual(A.kvm.mode, 'driving', 'A still drives B');
    assert.strictEqual(A.kvm.partner, B.id);
    assert.strictEqual(got(B, T.KVM_RELEASE).length, 0, 'B was not sent home');
    assert.strictEqual(A.kvm._linkedFor(B.id), true, 'B goes by its own memory');
  } finally {
    closeAll(N);
  }
});

runTests(tests);

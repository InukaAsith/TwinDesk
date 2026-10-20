// Share screen to several devices: every connected device gets a PcScreen of its own on a link scoped to
// it (hub.scoped); the stream table enforces one virtual display. The PcScreen here is a fake.
// Run with: node windows/test/pcscreenset.test.js  (NODE_PATH as in CI)
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const P = require('../../shared/protocol.js');
const { Mesh } = require('../../shared/mesh.js');
const { Server } = require('../server.js');
const { Pairing } = require('../hostpair.js');
const { LinkManager } = require('../links.js');
const { Hub } = require('../hub.js');
const { PcScreenSet } = require('../pcscreenset.js');
const { runTests } = require('./lib/run.js');
const { loadTestCert } = require('./lib/testcert.js');
const { close, waitFor, pairPhone, helloPhone, memoryStorage } = require('./lib/mesh.js');

const T = P.T;
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
  return { name, id, port: server.port, fp: cert.fp, server, pairing, links, mesh, hub };
}

// This PC: the main display and two to its left (x = -1920), as the OS reports them.
const MODEL = () => [
  { id: '1', name: 'Main', x: 0, y: 0, w: 2560, h: 1440, scale: 1, primary: true },
  { id: '2', name: 'Left', x: -1920, y: 0, w: 1920, h: 1080, scale: 1, primary: false },
  { id: '3', name: 'Far left', x: -3840, y: 0, w: 1920, h: 1080, scale: 1, primary: false },
];

function fakePc(log) {
  return (link, extendFree) => {
    const pc = {
      mode: 'off', monitorId: null, busy: false, status: { status: 'off', error: '' }, welcomed: 0, got: [],
      welcome() { pc.welcomed++; },
      async setMode(m) {
        if (m === 'extend' && !extendFree()) { pc.status.error = 'taken'; return; }
        pc.mode = m;
      },
      applyInput() {}, apply() { log.push('apply'); }, sizeExtend() {}, sendState() {}, shutdown() {},
      _extendSize: () => [1920, 1080],
      view: () => ({ mode: pc.mode }),
    };
    link.on(T.SCREEN_POLICY, (m) => pc.got.push(m));
    return pc;
  };
}

test('one unit per device, each on its own scoped link', async () => {
  const A = await hubNode('A');
  const clients = [];
  try {
    const log = [];
    const set = new PcScreenSet({ hub: A.hub, make: fakePc(log), model: MODEL });
    assert.strictEqual(set.all.length, 1, 'one waits before any device');
    assert.ok(set.view().displays.length === 3, 'the display model is in the view');

    const p1 = await pairPhone(A, { name: 'One' });
    const p2 = await pairPhone(A, { name: 'Two' });
    clients.push(p1.client, p2.client);
    await helloPhone(p1.client, { id: p1.id, name: 'One', token: p1.token });
    await waitFor(() => set.byId.has(p1.id), 'device one has its unit');
    await helloPhone(p2.client, { id: p2.id, name: 'Two', token: p2.token });
    await waitFor(() => set.byId.has(p2.id), 'device two has its unit');
    assert.strictEqual(set.all.length, 2);
    assert.strictEqual(set.first, set.byId.get(p1.id), 'the first device took the waiting unit');
    assert.strictEqual(set.byId.get(p2.id).welcomed, 1);

    // what a device sends reaches only its own unit
    p2.client.send({ t: T.SCREEN_POLICY, accept: true });
    await waitFor(() => set.byId.get(p2.id).got.length === 1, 'unit two heard it');
    assert.strictEqual(set.byId.get(p1.id).got.length, 0, 'unit one did not');

    // the scoped link sends to its device only
    const heard = [];
    p1.client.on && p1.client.on('message', (m) => heard.push(m));
    assert.strictEqual(set.byId.get(p2.id).link.send({ t: T.SCREEN_STATE, on: false }), true);

    // targets: each its own choice; one virtual display
    assert.strictEqual((await set.setTarget(p1.id, { mode: 'mirror', displayId: '2' })).ok, true);
    assert.strictEqual(set.byId.get(p1.id).mode, 'mirror');
    assert.strictEqual(set.byId.get(p1.id).monitorId, '2');
    assert.strictEqual((await set.setTarget(p2.id, { mode: 'extend' })).ok, true);
    assert.strictEqual(set.byId.get(p2.id).mode, 'extend');
    const r = await set.setTarget(p1.id, { mode: 'extend' });
    assert.strictEqual(r.ok, false, 'the virtual display is taken');
    assert.strictEqual(r.error, 'virtual-limit');
    assert.strictEqual(set.byId.get(p1.id).mode, 'mirror', 'and the target kept what it had');
    assert.strictEqual((await set.setTarget(p1.id, { mode: 'mirror', displayId: '99' })).ok, false, 'unknown display');
    const v = set.view();
    assert.deepStrictEqual(v.targets.map((t) => t.mode).sort(), ['extend', 'mirror']);

    // the single-peer API follows the selection
    A.hub.select(p2.id);
    assert.strictEqual(set.active, set.byId.get(p2.id));
    await set.setMode('off');
    assert.strictEqual(set.byId.get(p2.id).mode, 'off');
    assert.strictEqual(set.byId.get(p1.id).mode, 'mirror', 'the other target is untouched');

    // one leaves: its choice is dropped, the other stays
    p2.client.close();
    await waitFor(() => !A.hub.sessions.get(p2.id).connected, 'device two is gone');
    assert.ok(!set.table[p2.id]);
    assert.strictEqual(set.view().targets.length, 1);
  } finally {
    for (const c of clients) { try { c.close(); } catch (_) { /* already */ } }
    close(A);
  }
});

runTests(tests);

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Debug (shared/debug-start.js, shared/meshdebug.js; docs/debug.md) on real sockets: real Server, Pairing,
// LinkManager and Hub per node, wired as mesh/main.js does. A device two links away answers through the
// one between; a device that didn't let us in says so; a 5 MB log comes whole while the links stay up
// (its pieces wait for the socket, so the pings keep going); a device without Debug is "no answer".
// Run with: node linux/mesh/test/debug.test.js
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Mesh } = require('../../../shared/mesh.js');
const { Server } = require('../server.js');
const { Pairing } = require('../hostpair.js');
const { LinkManager } = require('../links.js');
const { Hub } = require('../hub.js');
const { startDebug } = require('../../../shared/debug-start.js');
const { runTests } = require('./lib/run.js');
const { loadTestCert } = require('./lib/testcert.js');
const { close, waitFor, pair, memoryStorage } = require('./lib/mesh.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-mesh-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// A computer as mesh/main.js makes it; debug: false leaves Debug out (an older app).
async function node(name, { debug = true } = {}) {
  const cert = loadTestCert();
  const id = crypto.randomUUID();
  const server = new Server({ key: cert.key, cert: cert.cert, port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const storage = memoryStorage();
  storage.write('pairings.json', []);
  const pairing = new Pairing(server, { id, name, fp: cert.fp }, { storage });
  const links = new LinkManager({ device: { id, name }, storage, hostPairing: pairing });
  links.bindServer(server);
  const mesh = new Mesh({ selfId: id });
  const hub = new Hub({ device: { id, name }, links, server, pairing, mesh });
  const n = { name, id, fp: cert.fp, port: server.port, server, pairing, links, storage, mesh, hub };
  n.settings = { device: { name }, mesh: {} };
  if (debug) {
    n.dbg = startDebug({ app: { getVersion: () => '9.9.9' }, hub, device: { id, name }, settings: n.settings, save: () => {}, kvm: () => null });
    n.log = path.join(tmp, `${name}.log`);
    fs.writeFileSync(n.log, `${name} started\n`);
    n.dbg.local.files = async () => [{ name: 'TwinDesk.log', path: n.log, size: fs.statSync(n.log).size }];
  }
  return n;
}

const up = (a, b) => { const s = a.hub.sessions.get(b.id); return !!s && s.connected; };
const linked = (a, b) => up(a, b) && up(b, a);
const code = (p) => p.then(() => 'ok', (e) => e.code);
const allow = (n, ...others) => { n.settings.mesh.debug = { allow: others.map((o) => o.id), anyCommandUntil: 0, verbose: { tags: [], until: 0 } }; };

async function world(specs, pairs) {
  const N = {};
  for (const [name, o] of Object.entries(specs)) N[name] = await node(name, o);
  for (const [a, b] of pairs) await pair(N[a], N[b]);
  await waitFor(() => pairs.every(([a, b]) => linked(N[a], N[b])), 'every pair linked');
  return N;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('A asks C through B (A–C not linked): status and hello come back; C not letting A in says so', async () => {
  const N = await world({ A: {}, B: {}, C: {} }, [['A', 'B'], ['B', 'C']]);
  const { A, B, C } = N;
  try {
    assert.ok(!up(A, C), 'A and C are not linked');
    await waitFor(() => A.hub.mesh.known().some((k) => k.id === C.id && k.via.includes(B.id)), 'A knows C through B');
    assert.strictEqual(await code(A.dbg.debug.ask(C.id, 'status')), 'not allowed');
    assert.strictEqual((await A.dbg.debug.ask(C.id, 'hello')).data.allowed, false);
    allow(C, A, B);
    const h = await A.dbg.debug.ask(C.id, 'hello');
    assert.strictEqual(h.data.allowed, true);
    assert.strictEqual(h.data.name, 'C');
    const st = await A.dbg.debug.ask(C.id, 'status');
    assert.strictEqual(st.data.device.id, C.id);
    assert.ok(Array.isArray(st.data.sessions) && st.data.sessions.some((s) => s.id === B.id && s.socket && typeof s.socket.rxAgo === 'number'), 'C\'s link to B, with its last-heard age');
    // A relay can't speak for another: C lets A in, not B, so A's request through B is refused.
    allow(C, A);
    assert.strictEqual(await code(A.dbg.debug.ask(C.id, 'status')), 'not allowed');
    assert.ok(A.dbg.activity().some((e) => e.dir === 'out' && e.op === 'status'), 'A\'s Activity has it');
    assert.ok(C.dbg.activity().some((e) => e.dir === 'in' && e.op === 'status' && e.name === 'A'), 'C\'s Activity has it');
  } finally {
    close(...Object.values(N));
  }
});

test('a 5 MB log through B comes whole, and every link stays up while it goes', async () => {
  const N = await world({ A: {}, B: {}, C: {} }, [['A', 'B'], ['B', 'C']]);
  const { A, B, C } = N;
  try {
    allow(C, A, B);
    await waitFor(() => A.hub.mesh.known().some((k) => k.id === C.id), 'A knows C');
    const line = 'kvm edge top while home, partner 48a3e5f2 — é\n';
    const body = line.repeat(Math.ceil((5 * 1024 * 1024) / Buffer.byteLength(line)));
    fs.writeFileSync(C.log, body);
    const closes = [];
    for (const n of [A, B, C]) n.hub.on('change', () => { for (const m of [A, B, C]) if (m !== n && n.hub.sessions.get(m.id) && !n.hub.sessions.get(m.id).connected) closes.push(`${n.name}-${m.name}`); });
    const t0 = Date.now();
    const r = await A.dbg.debug.ask(C.id, 'log', { file: 'TwinDesk.log' });
    assert.strictEqual(r.bin.length, Buffer.byteLength(body));
    assert.ok(r.bin.equals(Buffer.from(body)), 'byte for byte');
    assert.ok(linked(A, B) && linked(B, C), 'the links are up');
    assert.deepStrictEqual(closes, [], 'no link closed meanwhile');
    console.log(`  5 MB through B in ${Date.now() - t0} ms`);
    const g = await A.dbg.debug.ask(C.id, 'log', { file: 'TwinDesk.log', grep: 'partner', tail: 0 });
    assert.ok(g.data.lines > 1000);
  } finally {
    close(...Object.values(N));
  }
});

test('a device without Debug (an older app) is "no answer", not a hang', async () => {
  const N = await world({ A: {}, B: { debug: false } }, [['A', 'B']]);
  const { A, B } = N;
  try {
    const t0 = Date.now();
    assert.strictEqual(await code(A.dbg.debug.ask(B.id, 'hello')), 'no answer');
    assert.ok(Date.now() - t0 < 15000);
    assert.strictEqual(A.dbg.debug.answers(B.id), false, 'not asked again for a while');
  } finally {
    close(...Object.values(N));
  }
});

(async () => {
  setInterval(() => {}, 1000); // meshdebug's timers are unref'd, as in the app
  await runTests(tests);
})();

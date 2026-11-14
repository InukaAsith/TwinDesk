// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The files engine in Multi-device (shared/meshfx2.js, shared/meshfx2-engine.js): files go through
// it both ways with every session at once, and a device reaches only its own session's files.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const P = require('../../../shared/protocol.js');
const { runTests } = require('./lib/run.js');
const { node, close, waitFor, pair, linked } = require('./lib/mesh.js');

const T = P.T;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshfx2-'));
const file = (name, bytes) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, crypto.randomBytes(bytes));
  return p;
};
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sessionsOf = (n) => (n.hub ? n.hub.sessions : n.sessions);
const sess = (a, b) => sessionsOf(a).get(b.id);
const shut = (...ns) => { for (const n of ns) { const m = sessionsOf(n).fxShared.fx2; if (m) m.fx2.close(); } close(...ns); };

// A receiver as the apps' (drop.js, filerecv.js): files it expects go to its tmp, adopted when checked.
function receiver(n) {
  const r = { expect: new Map(), done: new Map() };
  sessionsOf(n).fxShared.hooks.push({
    target: (id) => (r.expect.has(id) ? r.expect.get(id) : null),
    untarget: () => {},
    adopt: (id) => r.done.set(id, 'ok'),
    fail: (id, why) => r.done.set(id, 'failed: ' + why),
  });
  return r;
}

async function sendOne(from, r, id, p) {
  r.expect.set(id, path.join(dir, `in-${id}`));
  const sum = await from.fx.send(id, p, fs.statSync(p).size, () => {});
  from.send({ t: T.FILE_END, id, sha256: sum, ...from.fx.endFields(id) });
  await waitFor(() => r.done.has(id), `${id} adopted`);
  assert.strictEqual(r.done.get(id), 'ok');
  assert.strictEqual(sha(r.expect.get(id)), sha(p), 'the same bytes');
  assert.strictEqual(from.fx.last.way, 'fx2', 'through the files engine');
}

test('two guests of one host: files both ways through the engine, at once', async () => {
  const A = await node('A');
  const B = await node('B');
  const C = await node('C');
  try {
    await pair(B, A);
    await pair(C, A);
    await waitFor(() => linked(A, B) && linked(A, C), 'B and C linked to A');
    const aB = sess(A, B), aC = sess(A, C), bA = sess(B, A), cA = sess(C, A);
    assert.ok(aB.ctx.fx2 > 0 && bA.link.fx2Port === aB.ctx.fx2, 'the welcome gave the engine port');
    assert.strictEqual(aB.fx.describe().next, 'fx2');
    assert.strictEqual(bA.fx.describe().next, 'fx2');
    const onA = receiver(A), onB = receiver(B), onC = receiver(C);
    // All at once: B and C up to A, A down to both.
    await Promise.all([
      sendOne(bA, onA, 'b-up', file('b-up', 9 * 1024 * 1024 + 3)), // big: parallel ranges
      sendOne(cA, onA, 'c-up', file('c-up', 300 * 1024)),
      sendOne(aB, onB, 'a-down-b', file('a-down-b', 2 * 1024 * 1024)),
      sendOne(aC, onC, 'a-down-c', file('a-down-c', 1024)),
    ]);
  } finally {
    shut(A, B, C);
  }
});

test('a device reaches only its own session\'s files; one leaving stops only its own', async () => {
  const A = await node('A');
  const B = await node('B');
  const C = await node('C');
  try {
    await pair(B, A);
    await pair(C, A);
    await waitFor(() => linked(A, B) && linked(A, C), 'B and C linked to A');
    const aB = sess(A, B), aC = sess(A, C);
    const p = file('secret', 5000);
    const served = aB.fx2v.serve('secret', p, 5000, () => {}).catch((e) => e); // for B
    await new Promise((r) => setTimeout(r, 50));
    const get = (token) => new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: aB.ctx.fx2, path: '/twindesk/fx2/secret?i=0&off=0&len=5000&total=5000', method: 'GET', headers: { 'x-twindesk-fx': token }, rejectUnauthorized: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(await get(aC.ctx.fx), 404, "C's token: not its file");
    assert.strictEqual(await get(P.randomHex(16)), 403, 'no session: refused');
    assert.strictEqual(await get(aB.ctx.fx), 200, "B's token: its file");
    assert.ok(Array.isArray(await served), 'served to B');

    // C's session resets: B's file in flight goes on.
    const p2 = file('long', 1000);
    const keep = aB.fx2v.serve('keep', p2, 1000, () => {}).then(() => 'done', (e) => e.message);
    aC.fx2v.reset();
    await new Promise((r) => setTimeout(r, 50));
    const keepGet = await new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: aB.ctx.fx2, path: '/twindesk/fx2/keep?i=0&off=0&len=1000&total=1000', method: 'GET', headers: { 'x-twindesk-fx': aB.ctx.fx }, rejectUnauthorized: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(keepGet, 200);
    assert.strictEqual(await keep, 'done');
  } finally {
    shut(A, B, C);
  }
});

runTests(tests, 'fastfiles2');

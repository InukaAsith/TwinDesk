// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Fast files in Multi-device (session.js, server.js, link.js, peer.js): each session its own token
// (hello fx: 1, welcome fx), the bytes over HTTPS both ways on real loopback nodes, and a request with
// another session's token or none goes nowhere.
'use strict';
process.env.TWINDESK_NO_FX2 = '1'; // the fx way (v1) here; fastfiles2.test.js has the files engine

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const P = require('../../../shared/protocol.js');
const { runTests } = require('../../../windows/mesh/test/lib/run.js');
const { node, close, waitFor, pair, linked } = require('./lib/mesh.js');
const { fxOf } = require('../peer.js');

const T = P.T;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshfx-'));
const file = (name, bytes) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, crypto.randomBytes(bytes));
  return p;
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// What a session's features get of a file: its chunks (Buffers) and file.end.
function collect(session) {
  const got = new Map();
  const of = (id) => got.get(id) || got.set(id, { parts: [], end: null }).get(id);
  session.on(T.FILE_CHUNK, (m) => of(m.id).parts.push(Buffer.from(m.data)));
  session.on(T.FILE_END, (m) => { of(m.id).end = m; });
  return got;
}

async function sendOne(from, to, got, id, p) {
  const sum = await from.fx.send(id, p, fs.statSync(p).size, () => {});
  from.send({ t: T.FILE_END, id, sha256: sum });
  await waitFor(() => got.get(id) && got.get(id).end, `file.end of ${id}`);
  const all = Buffer.concat(got.get(id).parts);
  assert.strictEqual(sha(all), sha(fs.readFileSync(p)), 'the same bytes');
  assert.strictEqual(got.get(id).end.sha256, sum);
}

test('both ways: the guest PUTs, the host serves a pull; each session its own token', async () => {
  const A = await node('A');
  const B = await node('B');
  try {
    await pair(B, A); // B dials A: A is the host
    await waitFor(() => linked(A, B), 'A and B linked');
    const onA = A.hub.sessions.get(B.id); // A's session of B (host side)
    const onB = B.hub.sessions.get(A.id); // B's session of A (guest side)
    assert.ok(onA.ctx && /^[0-9a-f]{32}$/.test(onA.ctx.fx), 'the host made a token');
    assert.strictEqual(onB.link.fx, onA.ctx.fx, 'the guest got it');
    assert.ok(onA.fx.usable() && onB.fx.usable());
    const gotA = collect(onA);
    const gotB = collect(onB);
    await sendOne(onB, onA, gotA, 'up1', file('up.bin', 3 * 1024 * 1024 + 17));
    await sendOne(onA, onB, gotB, 'down1', file('down.bin', 2 * 1024 * 1024 + 5));
    assert.strictEqual(onA.fx.describe().next, 'fx');
    assert.strictEqual(onA.fx.last.way, 'fx');

    // The facade (peer.js) goes to the route's session.
    const fx = fxOf({ session: onB, hub: B.hub });
    assert.strictEqual(fx.usable(), true);
    assert.strictEqual(fx.describe().next, 'fx');
    assert.strictEqual(fxOf({ session: null, hub: B.hub }).usable(), false);
    await assert.rejects(fxOf({ session: null, hub: B.hub }).send('x', 'y', 1, () => {}), (e) => e.early === true);
  } finally {
    close(A, B);
  }
});

test('a request with a wrong token, or none, is not served', async () => {
  const A = await node('A');
  const B = await node('B');
  try {
    await pair(B, A);
    await waitFor(() => linked(A, B), 'A and B linked');
    const status = (headers, method = 'GET') => new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: A.port, path: '/twindesk/fx/x', method, headers, rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(await status({}), 404);
    assert.strictEqual(await status({ 'x-twindesk-fx': P.randomHex(16) }), 404);
    assert.strictEqual(await status({ 'x-twindesk-fx': A.hub.sessions.get(B.id).ctx.fx }, 'POST'), 405); // the session's: it answers itself
  } finally {
    close(A, B);
  }
});

runTests(tests, 'fastfiles');

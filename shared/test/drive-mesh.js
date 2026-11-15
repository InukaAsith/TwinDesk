// TwinDesk Drive in Multi-device (shared/drive-host.js createMesh): this computer hosts two computers
// and a phone. Each computer gets a link of its own, a file from one reaches the other through here,
// the HTTPS requests go to the link of the token they carry, and a phone never gets a link.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Drive } = require('../drive.js');
const { DriveLink } = require('../drive-link.js');
const { createMesh } = require('../drive-host.js');
const P = require('../protocol.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'td-drivemesh-'));
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=td', '-keyout', path.join(base, 'k.pem'), '-out', path.join(base, 'c.pem')], { stdio: 'ignore' });
} catch {
  console.log('drive-mesh: skipped (no openssl)');
  process.exit(0);
}
const key = fs.readFileSync(path.join(base, 'k.pem'));
const cert = fs.readFileSync(path.join(base, 'c.pem'));
const fp = P.normFingerprint(new crypto.X509Certificate(cert).fingerprint256);
const clone = (m) => JSON.parse(JSON.stringify(m));
const later = Date.now() + 60000;

const write = (dir, rel, text) => {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  const t = new Date(Date.now() - 10000);
  fs.utimesSync(f, t, t);
};
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return null; } };
const wait = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};

(async () => {
  // This computer (A): the mesh host, as the app has it, on a fake hub.
  const aDir = path.join(base, 'A', 'Drive');
  const busH = new Map();
  const peerH = { welcome: [], closed: [], transport: [] };
  const tokens = { B: crypto.randomBytes(16).toString('hex'), C: crypto.randomBytes(16).toString('hex'), phone: crypto.randomBytes(16).toString('hex') };
  const connected = new Set();
  const guests = {}; // id -> the computer's DriveLink
  const toPhone = [];
  let request = null;
  const mesh = {
    on: (t, fn) => { if (!busH.has(t)) busH.set(t, []); busH.get(t).push(fn); },
    onPeer: (ev, fn) => peerH[ev].push(fn),
    send: (id, m) => {
      if (id === 'phone') toPhone.push(m);
      else setImmediate(() => guests[id] && guests[id].onMessage(clone(m)));
      return true;
    },
    session: (id) => (connected.has(id) ? { host: true, token: tokens[id], address: '127.0.0.1', transport: 'ip' } : null),
    peerName: (id) => id,
    isComputer: (id) => id !== 'phone',
    connectedIds: () => [...connected],
    setRequest: (fn) => { request = fn; },
  };
  const settings = { drive: { on: false, folder: aDir } };
  const A = createMesh({ settings, save: () => {}, me: 'A', meName: 'A', userData: path.join(base, 'A'), trash: async (p) => fs.rmSync(p), mesh });
  assert.strictEqual(request, null, 'off: nothing hooked');

  const server = https.createServer({ key, cert }, (req, res) => {
    if (!(request && request(req, res))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // The other computers: guests of A, each with its own token.
  const engines = {};
  async function computer(id) {
    const dir = path.join(base, id, 'Drive');
    const d = new Drive({ me: id, meName: id, folder: () => dir, indexFile: path.join(base, id, 'i.json'), watch: false, now: () => later, trash: async (a) => fs.rmSync(a) });
    d.dir = dir;
    engines[id] = d;
    await d.start();
    guests[id] = new DriveLink({
      drive: d,
      send: (m) => setImmediate(() => { for (const fn of busH.get(m.t) || []) fn(clone(m), id); }),
      session: () => ({ host: false, token: tokens[id], address: '127.0.0.1', port, fp, transport: 'ip' }),
      peerName: () => 'A',
    });
    return d;
  }
  const up = (id) => { connected.add(id); for (const fn of peerH.welcome) fn(id); if (guests[id]) guests[id].start(); };
  const down = (id) => { connected.delete(id); for (const fn of peerH.closed) fn(id); if (guests[id]) guests[id].stop(); };

  const B = await computer('B');
  const C = await computer('C');
  write(aDir, 'from-a.txt', 'a bytes');
  write(B.dir, 'docs/from-b.txt', 'b bytes');

  up('B'); // before Drive is on here: it starts with whoever is connected
  await A.setOn(true);
  assert.ok(request, 'on: the server hooked');
  assert.ok(await wait(() => read(B.dir, 'from-a.txt') === 'a bytes'), 'B gets A\'s');
  assert.ok(await wait(() => read(aDir, 'docs/from-b.txt') === 'b bytes'), 'A gets B\'s');

  up('C');
  up('phone');
  assert.ok(await wait(() => read(C.dir, 'docs/from-b.txt') === 'b bytes'), 'B\'s reaches C through A');
  assert.ok(await wait(() => read(C.dir, 'from-a.txt') === 'a bytes'), 'C gets A\'s');
  assert.strictEqual(toPhone.length, 0, 'a phone gets no Drive messages');

  // A change on C goes on to B.
  write(C.dir, 'from-c.txt', 'c bytes');
  await C.scan();
  assert.ok(await wait(() => read(B.dir, 'from-c.txt') === 'c bytes'), 'C\'s reaches B through A');

  const v = A.view();
  assert.strictEqual(v.on, true);
  assert.strictEqual(v.connected, true);
  assert.deepStrictEqual(v.peer.split(', ').sort(), ['B', 'C']);

  // Requests: each token reaches its own link; another computer's token, or none, is refused.
  const status = (headers, p = 'from-a.txt') => new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port, path: '/twindesk/drive/f?p=' + p + '&h=' + 'a'.repeat(64), rejectUnauthorized: false, headers }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.end();
  });
  assert.strictEqual(await status({}), 403);
  assert.strictEqual(await status({ 'x-twindesk-drive': 'f'.repeat(32) }), 403);
  assert.strictEqual(await status({ 'x-twindesk-drive': tokens.phone }), 403, 'the phone has no link');
  assert.strictEqual(await status({ 'x-twindesk-drive': tokens.B }), 404); // B's link: not a version it has

  // B leaves: its link goes, and its token with it.
  down('B');
  assert.strictEqual(await status({ 'x-twindesk-drive': tokens.B }), 403);
  assert.deepStrictEqual(A.view().peer, 'C');

  // Off: nothing hooked, no links.
  await A.setOn(false);
  assert.strictEqual(request, null);
  assert.strictEqual(A.view().connected, false);

  for (const id of ['B', 'C']) { guests[id].destroy(); await engines[id].stop(); }
  server.close();
  fs.rmSync(base, { recursive: true, force: true });
  console.log('drive-mesh: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

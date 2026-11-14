// TwinDesk Drive over a session (shared/drive-link.js): two engines, a real HTTPS server on
// 127.0.0.1 with a throwaway certificate, the session's messages handed across by hand.
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
const P = require('../protocol.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'td-drivelink-'));
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=td', '-keyout', path.join(base, 'k.pem'), '-out', path.join(base, 'c.pem')], { stdio: 'ignore' });
} catch {
  console.log('drive-link: skipped (no openssl)');
  process.exit(0);
}
const key = fs.readFileSync(path.join(base, 'k.pem'));
const cert = fs.readFileSync(path.join(base, 'c.pem'));
const fp = P.normFingerprint(new crypto.X509Certificate(cert).fingerprint256);
const token = crypto.randomBytes(16).toString('hex');
const later = Date.now() + 60000;

function engine(id) {
  const dir = path.join(base, id, 'Drive');
  const d = new Drive({ me: id, meName: id, folder: () => dir, indexFile: path.join(base, id, 'i.json'), watch: false, now: () => later, trash: async (a) => fs.rmSync(a) });
  d.dir = dir;
  return d;
}
const write = (d, rel, text) => {
  const f = path.join(d.dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  const t = new Date(later - 10000);
  fs.utimesSync(f, t, t);
};
const read = (d, rel) => { try { return fs.readFileSync(path.join(d.dir, rel), 'utf8'); } catch { return null; } };
const wait = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};

(async () => {
  const H = engine('host'), G = engine('guest');
  await H.start();
  await G.start();
  write(H, 'from-host.txt', 'host bytes');
  write(G, 'docs/from-guest.txt', 'guest bytes');
  write(G, 'big.bin', crypto.randomBytes(3 * 1024 * 1024).toString('base64'));

  let host, guest, port;
  let guestFp = fp;
  const server = https.createServer({ key, cert }, (req, res) => {
    if (!host.request(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  host = new DriveLink({ drive: H, send: (m) => setImmediate(() => guest.onMessage(JSON.parse(JSON.stringify(m)))), session: () => ({ host: true, token, address: '127.0.0.1', transport: 'ip' }), peerName: () => 'guest' });
  guest = new DriveLink({ drive: G, send: (m) => setImmediate(() => host.onMessage(JSON.parse(JSON.stringify(m)))), session: () => ({ host: false, token, address: '127.0.0.1', port, fp: guestFp, transport: 'ip' }), peerName: () => 'host' });

  host.start();
  guest.start();
  assert.ok(await wait(() => read(G, 'from-host.txt') === 'host bytes'), 'the guest GETs from the host');
  assert.ok(await wait(() => read(H, 'docs/from-guest.txt') === 'guest bytes'), 'the host gets the guest\'s by PUT');
  assert.ok(await wait(() => read(H, 'big.bin') === read(G, 'big.bin')), 'a big file');

  // A change while connected goes across as an update.
  write(H, 'from-host.txt', 'edited on host');
  fs.utimesSync(path.join(H.dir, 'from-host.txt'), new Date(later - 5000), new Date(later - 5000));
  await H.scan();
  assert.ok(await wait(() => read(G, 'from-host.txt') === 'edited on host'));

  // Not the session's token, or no token: refused.
  const status = (headers) => new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port, path: '/twindesk/drive/f?p=from-host.txt&h=' + 'a'.repeat(64), rejectUnauthorized: false, headers }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.end();
  });
  assert.strictEqual(await status({}), 403);
  assert.strictEqual(await status({ 'x-twindesk-drive': 'f'.repeat(32) }), 403);
  assert.strictEqual(await status({ 'x-twindesk-drive': token }), 404); // the right token, not a version it has

  // A host whose certificate isn't the paired one gets nothing (the guest never sends its token).
  guestFp = 'ab'.repeat(32);
  write(H, 'secret.txt', 'not for impostors');
  await H.scan();
  await new Promise((r) => setTimeout(r, 800));
  assert.strictEqual(read(G, 'secret.txt'), null);
  guestFp = fp;
  guest.kick();
  assert.ok(await wait(() => read(G, 'secret.txt') === 'not for impostors'));

  // An app without Drive never says hello: nothing runs.
  const lone = new DriveLink({ drive: engine('lone'), send: () => {}, session: () => ({ host: true, token, address: '127.0.0.1', transport: 'ip' }) });
  assert.strictEqual(lone.ready, false);
  lone.destroy();

  host.destroy();
  guest.destroy();
  await H.stop();
  await G.stop();
  server.close();
  fs.rmSync(base, { recursive: true, force: true });
  console.log('drive-link: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A paired Android coming back by itself after a long drop (shared/reclaim.js) on the Windows and
// Linux hosts (#266), as on the Mac (shared/test/reclaim.js): the return is remembered, refused when
// the computer is busy (never a takeover), and gone after Disconnect.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-reclaim-'));
let userData = root;
const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { app: { getPath: () => userData, isPackaged: false } };
  return realLoad.apply(this, arguments);
};
for (const d of ['windows', 'linux']) {
  process.env.NODE_PATH = [process.env.NODE_PATH, path.join(__dirname, `../../${d}/node_modules`)].filter(Boolean).join(path.delimiter);
}
Module._initPaths();
const P = require('../protocol');
const ANDROID = 'android', DESKTOP = 'desktop', TOKEN = 'test-token';

execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test', '-keyout', path.join(root, 'key'), '-out', path.join(root, 'cert')], { stdio: 'ignore' });
execFileSync('openssl', ['pkcs12', '-export', '-inkey', path.join(root, 'key'), '-in', path.join(root, 'cert'), '-out', path.join(root, 'pfx'), '-passout', 'pass:x'], { stdio: 'ignore' });
const key = fs.readFileSync(path.join(root, 'key')), cert = fs.readFileSync(path.join(root, 'cert')), pfx = fs.readFileSync(path.join(root, 'pfx'));

function socket(server) {
  const sent = [];
  const ws = { OPEN: 1, readyState: 1, send(raw) { sent.push(JSON.parse(raw)); }, close() { this.readyState = 3; }, terminate() { this.readyState = 3; } };
  const ctx = { ws, authed: false, address: '127.0.0.1', transport: 'ip', connectedAt: Date.now(), lastRx: Date.now(), released: false, alt: null };
  ws.ctx = ctx;
  server.sockets.add(ctx);
  return { ws, ctx, sent };
}
const send = (server, sock, msg) => server._onMessage(sock.ctx, Buffer.from(JSON.stringify(msg)), false, sock.ws);
function hello(server, reclaim = false, id = ANDROID) {
  const sock = socket(server);
  send(server, sock, { t: 'hello', v: P.PROTOCOL_VERSION, id, name: id, os: id === ANDROID ? P.OS.ANDROID : P.OS.WIN, token: TOKEN, ...(reclaim ? { rc: 1, resume: '0' } : {}) });
  return sock;
}
const error = (sock) => sock.sent.find((m) => m.t === P.T.ERROR);
const closed = (server, sock) => { sock.ws.close(); server._onSocketClose(sock.ws); };

function run(d) {
  userData = path.join(root, d);
  fs.mkdirSync(userData, { recursive: true });
  const store = require(`../../${d}/store`);
  const { Server } = require(`../../${d}/server`);
  const { Pairing } = require(`../../${d}/hostpair`);
  const { Discovery } = require(`../../${d}/discovery`);
  const { Phone } = require(`../../${d}/phone`);
  assert.strictEqual(new Discovery({ id: 'pc', name: 'PC', rc: true })._beaconMsg().rc, 1);
  assert.strictEqual(new Discovery({ id: 'pc', name: 'PC' })._beaconMsg().rc, undefined);
  store.write('paired.json', [ANDROID, DESKTOP].map((id) => ({ id, name: id, os: id === ANDROID ? P.OS.ANDROID : P.OS.WIN, tokenHash: P.sha256Hex(TOKEN) })));
  const make = () => {
    const server = new Server(d === 'windows' ? { pfx, passphrase: 'x' } : { key, cert });
    server.https.close();
    let busy = false;
    const pairing = new Pairing(server, { id: 'pc', name: 'PC', fp: 'ab'.repeat(32) }, { busy: () => busy, yieldTo: () => {} });
    return { server, pairing, busy: (on) => { busy = on; } };
  };
  let h = make();
  const first = hello(h.server);
  assert.ok(first.ctx.authed, d + ': plain hello');
  assert.strictEqual(first.sent[0].rc, 1);
  assert.strictEqual(h.pairing.returnPhone, ANDROID);
  closed(h.server, first);
  h.server.endPhoneGrace();
  h.server.close();
  // After a restart, the remembered phone comes back by itself.
  h = make();
  assert.strictEqual(h.pairing.returnPhone, ANDROID, d + ': remembered on disk');
  const back = hello(h.server, true);
  assert.ok(back.ctx.authed, d + ': reclaim');
  closed(h.server, back);
  h.server.endPhoneGrace();
  // Busy (a guest of another computer): refused, never a takeover.
  h.busy(true);
  assert.strictEqual(error(hello(h.server, true)).code, 'busy');
  h.busy(false);
  // Disconnect here: no coming back.
  const phone = new Phone({ server: h.server, raw: h.server, discovery: { found: new Map(), list: () => [] }, pairing: h.pairing });
  phone.disconnect();
  assert.strictEqual(h.pairing.returnPhone, null, d + ': Disconnect revokes');
  assert.strictEqual(error(hello(h.server, true)).code, 'released');
  // A plain hello (the person tapped Connect) still works and remembers again.
  const again = hello(h.server);
  assert.ok(again.ctx.authed);
  assert.strictEqual(h.pairing.returnPhone, ANDROID);
  closed(h.server, again);
  h.server.endPhoneGrace();
  // A computer connects meanwhile: it holds the session and is the last owner now.
  const pc = hello(h.server, false, DESKTOP);
  assert.ok(pc.ctx.authed);
  assert.ok(error(hello(h.server, true)), d + ': reclaim refused');
  assert.strictEqual(h.server.current, pc.ctx, d + ': the computer keeps the session');
  h.server.close();
  console.log(`reclaim-winlinux: ${d} ok`);
}
try { run('windows'); run('linux'); } finally { fs.rmSync(root, { recursive: true, force: true }); }

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Real held Server/Pairing routing and commit gates; no listening sockets or devices.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
process.env.NODE_PATH = [process.env.NODE_PATH, path.join(__dirname, '../../mac/node_modules')].filter(Boolean).join(path.delimiter);
require('module').Module._initPaths();
const P = require('../protocol');
const { Discovery } = require('../../mac/discovery');
const store = require('../../mac/store');
const { Pairing } = require('../../mac/pairing');
const { Server } = require('../../mac/server');
const { Phone } = require('../../mac/phone');
const ID = { macId: 'mac', macName: 'Mac', fp: 'ab'.repeat(32) };
const ANDROID = 'android', DESKTOP = 'desktop', TOKEN = 'test-token';

function socket(server) {
  const sent = [];
  const ws = { OPEN: 1, readyState: 1, send(raw) { sent.push(JSON.parse(raw)); }, close() { this.readyState = 3; }, terminate() { this.readyState = 3; } };
  const ctx = { ws, authed: false, address: '127.0.0.1', transport: 'ip', connectedAt: Date.now(), lastRx: Date.now(), released: false, alt: null };
  ws.ctx = ctx;
  server.sockets.add(ctx);
  return { ws, ctx, sent };
}
function send(server, sock, msg) { server._onMessage(sock.ctx, Buffer.from(JSON.stringify(msg)), false, sock.ws); }
function hello(server, reclaim = false, id = ANDROID) {
  const sock = socket(server);
  send(server, sock, { t: 'hello', v: P.PROTOCOL_VERSION, id, name: id, os: id === ANDROID ? P.OS.ANDROID : P.OS.WIN, token: TOKEN,
    ...(reclaim ? { rc: 1, resume: '0', fx: 1, fx2: 1 } : {}) });
  return sock;
}
function error(sock) { return sock.sent.find((m) => m.t === P.T.ERROR); }
function closed(server, sock) { sock.ws.close(); server._onSocketClose(sock.ws); }
function bye(server, sock, retry = false) { send(server, sock, { t: 'bye', ...(retry ? { retry: true } : {}) }); server._onSocketClose(sock.ws); }
function host(dir, tls, initialize = true) {
  store.init(dir);
  if (initialize) store.write('paired.json', [ANDROID, DESKTOP].map((id) => ({ id, name: id, os: id === ANDROID ? P.OS.ANDROID : P.OS.WIN, tokenHash: P.sha256Hex(TOKEN) })));
  const server = new Server(tls, { hold: true });
  let busy = false;
  const yields = [];
  const pairing = new Pairing(server, ID, { busy: () => busy, yieldTo: () => yields.push(true) });
  return { server, pairing, yields, busy(on) { busy = on; } };
}
async function deferred(server, mutate) {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  server.fxOn = true;
  server.fx2Wait = () => wait;
  const sock = hello(server, true);
  assert.strictEqual(sock.ctx.authed, false);
  assert.strictEqual(sock.sent.length, 0);
  mutate(sock);
  release();
  await wait;
  await new Promise(setImmediate);
  return sock;
}

async function mainPath(dir, tls) {
  const beacon = new Discovery(ID, P.PORT, { rc: true })._beaconMsg();
  assert.strictEqual(beacon.rc, 1);
  assert.strictEqual(new Discovery(ID)._beaconMsg().rc, undefined);
  let h = host(dir, tls);
  try {
    const first = hello(h.server);
    assert.strictEqual(first.ctx.authed, true);
    assert.strictEqual(first.sent[0].rc, 1);
    assert.strictEqual(h.pairing.returnPhone, ANDROID);
    closed(h.server, first);
    h.server.endPhoneGrace();
    assert.strictEqual(h.server.current, null);
    // Restart with the persisted last-owner consent, after the legacy grace is gone.
    h.server.close();
    h = host(dir, tls, false);
    const returned = await deferred(h.server, () => {});
    assert.strictEqual(returned.ctx.authed, true);
    assert.strictEqual(h.server.current, returned.ctx);
    assert.deepStrictEqual(h.yields, []);
    // Background pause after the Mac committed welcome: no stale grace, and no durable Stop.
    bye(h.server, returned, true);
    assert.strictEqual(h.server.current, null);
    assert.strictEqual(h.server.phoneGrace, null);
    assert.strictEqual(h.pairing.returnPhone, ANDROID);
    const again = await deferred(h.server, () => {});
    assert.strictEqual(again.ctx.authed, true);
    const newest = await deferred(h.server, () => {});
    bye(h.server, again);
    assert.strictEqual(h.server.current, newest.ctx, 'superseded same-phone BYE cannot end the replacement');
    assert.strictEqual(h.pairing.returnPhone, ANDROID, 'superseded BYE cannot revoke the new session consent');
    bye(h.server, newest);
    assert.strictEqual(h.pairing.returnPhone, null);
    assert.strictEqual(h.server.phoneGrace, null);
    assert.strictEqual(error(hello(h.server, true)).code, P.E.RELEASED);
    assert.strictEqual(hello(h.server).ctx.authed, true, 'explicit Connect restores consent');
  } finally { h.server.close(); }
}

async function failurePath(dir, tls) {
  const h = host(dir, tls);
  const { server, pairing } = h;
  const free = () => { server.current = null; server.endPhoneGrace(); };
  try {
    hello(server);
    free();
    const raced = await deferred(server, () => { hello(server, false, DESKTOP); });
    assert.strictEqual(error(raced).code, P.E.RELEASED);
    assert.strictEqual(server.current.deviceId, DESKTOP);
    assert.deepStrictEqual(h.yields, []);
    free();
    assert.strictEqual(error(hello(server, true)).code, P.E.RELEASED, 'replacement durably revokes old owner');
    hello(server);
    free();
    h.busy(true);
    assert.strictEqual(error(hello(server, true)).code, P.E.BUSY);
    h.busy(false);
    const phone = new Phone({ server, raw: server, pairing, discovery: { list() { return []; }, get() { return null; } } });
    assert.strictEqual(server.phoneGrace, null);
    assert.deepStrictEqual(phone.view.returning, { id: ANDROID, name: ANDROID }, 'return stays visible after grace expires');
    let phoneChanges = 0;
    phone.on('change', () => phoneChanges++);
    const stopped = await deferred(server, () => { phone.disconnect(); });
    assert.ok(phoneChanges > 0, 'Disconnect refreshes the pending return UI');
    assert.strictEqual(stopped.ctx.released, true);
    assert.strictEqual(stopped.ctx.authed, false);
    assert.ok(!stopped.sent.some((m) => m.t === P.T.WELCOME));
    assert.strictEqual(store.read('phone-return.json', null), null);
    assert.strictEqual(phone.view.returning, null, 'Disconnect clears the visible pending return');
    assert.strictEqual(error(hello(server, true)).code, P.E.RELEASED);
    hello(server);
    free();
    const cancelled = await deferred(server, (sock) => { bye(server, sock); });
    assert.strictEqual(cancelled.ctx.authed, false);
    assert.strictEqual(pairing.returnPhone, null);
    hello(server);
    free();
    const superseded = await deferred(server, (pending) => {
      server.fxOn = false;
      const newer = hello(server, true);
      assert.strictEqual(newer.ctx.authed, true);
      closed(server, newer);
      server.endPhoneGrace();
      bye(server, pending);
    });
    assert.strictEqual(superseded.ctx.authed, false);
    assert.strictEqual(pairing.returnPhone, ANDROID, 'pending old BYE cannot revoke a newer disconnected session');
    pairing.forget(ANDROID);
    assert.strictEqual(error(hello(server, true)).code, P.E.BAD_TOKEN);
    assert.strictEqual(store.read('phone-return.json', null), null);
    const write = store.write;
    store.write('phone-return.json', { id: ANDROID });
    pairing.returnPhone = ANDROID;
    try {
      store.write = (name, value) => { if (name === 'phone-return.json') throw Object.assign(Error('disk full'), { code: 'ENOSPC' }); return write(name, value); };
      assert.doesNotThrow(() => pairing.clearReturn(), 'storage failure cannot escape into Disconnect');
      assert.strictEqual(pairing.returnPhone, null);
      assert.strictEqual(fs.existsSync(store.filePath('phone-return.json')), false, 'failed atomic clear removes positive consent');
      assert.doesNotThrow(() => pairing.rememberReturn({ os: P.OS.ANDROID, deviceId: ANDROID }));
      assert.strictEqual(pairing.returnPhone, null, 'failed write cannot authorize return');
    } finally { store.write = write; }
    store.write('phone-return.json', { id: ANDROID });
    pairing.returnPhone = ANDROID;
    const unlink = fs.unlinkSync;
    try {
      store.write = (name, value) => { if (name === 'phone-return.json') throw Object.assign(Error('read only'), { code: 'EROFS' }); return write(name, value); };
      fs.unlinkSync = () => { throw Object.assign(Error('read only'), { code: 'EROFS' }); };
      assert.strictEqual(pairing.clearReturn(ANDROID), false);
      assert.strictEqual(pairing.returnPhone, null);
    } finally { store.write = write; fs.unlinkSync = unlink; }
    assert.strictEqual(pairing.clearReturn(ANDROID), true, 'retry durable revocation when storage recovers');
    assert.strictEqual(store.read('phone-return.json', 'missing'), null);
  } finally { server.close(); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test', '-keyout', path.join(root, 'key'), '-out', path.join(root, 'cert')], { stdio: 'ignore' });
const tls = { keyPem: fs.readFileSync(path.join(root, 'key')), certPem: fs.readFileSync(path.join(root, 'cert')) };
(async () => {
  try { await mainPath(path.join(root, 'main'), tls); await failurePath(path.join(root, 'fail'), tls); console.log('reclaim: ok'); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exitCode = 1; });

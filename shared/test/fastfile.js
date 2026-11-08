// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tests for shared/fastfile.js: a host and a guest in one process, a real HTTPS server (a
// throwaway self-signed certificate from openssl), files both ways, file.end waiting for the last
// bytes, and the cases that must fall back to file.chunk.
// Run with: node shared/test/fastfile.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const P = require('../protocol.js');
const { FastFiles } = require('../fastfile.js');

const T = P.T;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastfile-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test',
  '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
const key = fs.readFileSync(path.join(dir, 'key.pem'));
const cert = fs.readFileSync(path.join(dir, 'cert.pem'));
const fp = P.normFingerprint(new crypto.X509Certificate(cert).fingerprint256);
const token = P.randomHex(16);

const file = (name, bytes) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, crypto.randomBytes(bytes));
  return p;
};
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// A receiver like the apps': file.chunk (Buffer) in order, then file.end.
function receiver() {
  const got = new Map(); // id -> {parts, seq, end}
  const fn = (m) => {
    const r = got.get(m.id) || got.set(m.id, { parts: [], seq: 0, end: null, bytes: 0 }).get(m.id);
    if (m.t === T.FILE_CHUNK) {
      assert.ok(Buffer.isBuffer(m.data), 'data is a Buffer');
      assert.strictEqual(m.seq, r.seq++, 'chunks in order');
      assert.strictEqual(r.end, null, 'no chunk after file.end');
      r.parts.push(m.data);
      r.bytes += m.data.length;
    }
    if (m.t === T.FILE_END) r.end = m;
    if (m.t === T.FILE_CANCEL) r.cancelled = true;
  };
  fn.got = got;
  return fn;
}

function pair(opts = {}) {
  const host = {}, guest = {};
  host.rx = receiver();
  guest.rx = receiver();
  // The control socket: messages arrive in order, a little later.
  const wire = (to) => (m) => setImmediate(() => { if (!to.fx.incoming(m)) to.rx(m); });
  host.fx = new FastFiles({
    session: () => ({ host: true, token, transport: 'ip', address: '127.0.0.1' }),
    deliver: (m) => host.rx(m),
    send: wire(guest),
  });
  guest.fx = new FastFiles({
    session: () => ({ host: false, token: opts.token || token, transport: opts.transport || 'ip', address: opts.address || '127.0.0.1', port: host.port, fp: opts.fp || fp }),
    deliver: (m) => guest.rx(m),
    send: wire(host),
  });
  host.send = wire(guest);
  guest.send = wire(host);
  return new Promise((resolve) => {
    host.server = https.createServer({ key, cert }, (req, res) => {
      if (!host.fx.request(req, res)) { res.writeHead(404); res.end(); }
    });
    host.server.listen(0, '127.0.0.1', () => {
      host.port = host.server.address().port;
      resolve({ host, guest, close: () => { host.fx.reset(); guest.fx.reset(); host.server.close(); } });
    });
  });
}

// Send as the apps do: fx.send, then file.end with the SHA-256 on the control socket.
async function send(from, id, p) {
  const size = fs.statSync(p).size;
  let counted = 0;
  const digest = await from.fx.send(id, p, size, (n) => { counted += n; });
  assert.strictEqual(counted, size, 'onBytes adds up');
  from.send({ t: T.FILE_END, id, sha256: digest });
  return digest;
}

const until = async (cond, ms = 5000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function check(rx, id, p) {
  await until(() => rx.got.get(id) && rx.got.get(id).end);
  const r = rx.got.get(id);
  const data = Buffer.concat(r.parts);
  assert.ok(data.equals(fs.readFileSync(p)), 'same bytes');
  assert.strictEqual(r.end.sha256, sha(p), 'file.end carries the hash');
}

(async () => {
  {
    const { host, guest, close } = await pair();
    assert.ok(guest.fx.usable() && host.fx.usable(), 'usable on the network');
    // Guest → host (PUT), a big one and an empty one.
    const big = file('big.bin', 24 * 1024 * 1024 + 123);
    const empty = file('empty.bin', 0);
    await Promise.all([send(guest, 'a', big), send(guest, 'e', empty)]);
    await check(host.rx, 'a', big);
    await check(host.rx, 'e', empty);
    assert.ok(host.rx.got.get('a').parts.length < 100, 'big chunks, not 64 KB ones');
    // Host → guest (file.pull + GET), several at once: file.end waits for the last bytes.
    const files = [1, 2, 3, 4, 5].map((i) => file(`h${i}.bin`, i * 3 * 1024 * 1024 + i));
    await Promise.all(files.map((p, i) => send(host, `h${i}`, p)));
    for (let i = 0; i < files.length; i++) await check(guest.rx, `h${i}`, files[i]);
    // Many small ones.
    const small = Array.from({ length: 300 }, (_, i) => file(`s${i}.bin`, 100 + i));
    const t0 = Date.now();
    for (let i = 0; i < small.length; i += 4) await Promise.all(small.slice(i, i + 4).map((p, j) => send(guest, `s${i + j}`, p)));
    for (let i = 0; i < small.length; i++) await check(host.rx, `s${i}`, small[i]);
    console.log(`  300 small files: ${Date.now() - t0} ms`);
    // … as many at once as parallelFor says (16 while they're small).
    assert.strictEqual(guest.fx.parallelFor(100), 16);
    assert.strictEqual(guest.fx.parallelFor(5 * 1024 * 1024), 4);
    const small2 = Array.from({ length: 300 }, (_, i) => file(`t${i}.bin`, 100 + i));
    const t1 = Date.now();
    for (let i = 0; i < small2.length; i += 16) await Promise.all(small2.slice(i, i + 16).map((p, j) => send(guest, `t${i + j}`, p)));
    for (let i = 0; i < small2.length; i++) await check(host.rx, `t${i}`, small2[i]);
    console.log(`  300 small files, 16 at once: ${Date.now() - t1} ms`);
    close();
  }

  // Backpressure: while the receiver's disk is behind (pressure() gives a promise) the transfer
  // waits, with the bytes left in the socket; then it goes on, every byte in order.
  {
    const { host, guest, close } = await pair();
    let stalled = null;
    let pauses = 0;
    host.fx.pressure((id) => {
      if (id !== 'bp' || stalled || pauses >= 2) return null;
      const r = host.rx.got.get('bp');
      if (!r || r.bytes < (pauses + 1) * 4 * 1024 * 1024) return null;
      pauses++;
      if (pauses === 2) return new Promise((resolve) => setTimeout(resolve, 100)); // the second: a short one
      return new Promise((resolve) => { stalled = resolve; });
    });
    const big = file('bp.bin', 20 * 1024 * 1024);
    const sent = send(guest, 'bp', big);
    await until(() => stalled);
    const at = host.rx.got.get('bp').bytes;
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(host.rx.got.get('bp').bytes - at <= 1024 * 1024, 'paused: (almost) nothing more came');
    const go = stalled;
    stalled = null;
    go();
    await sent;
    await check(host.rx, 'bp', big);
    assert.strictEqual(pauses, 2, 'paused twice, went on both times');
    close();
  }

  // Not the paired computer (another fingerprint): nothing goes, e.early, and fast files stop.
  {
    const { guest, close } = await pair({ fp: 'ab'.repeat(32) });
    const p = file('x.bin', 1000);
    await assert.rejects(guest.fx.send('x', p, 1000, () => {}), (e) => e.early === true);
    assert.strictEqual(guest.fx.usable(), false, 'broken for the session');
    close();
  }

  // A wrong token: refused before any byte, e.early.
  {
    const { host, guest, close } = await pair({ token: 'f'.repeat(32) });
    const p = file('y.bin', 1000);
    await assert.rejects(guest.fx.send('y', p, 1000, () => {}), (e) => e.early === true);
    assert.strictEqual(host.rx.got.size, 0, 'nothing delivered');
    close();
  }

  // The guest can't reach the host for a pull: it says so, and the host's send is e.early.
  {
    const { host, guest, close } = await pair({ fp: 'cd'.repeat(32) });
    const p = file('z.bin', 5000);
    await assert.rejects(host.fx.send('z', p, 5000, () => {}), (e) => e.early === true);
    assert.strictEqual(host.fx.usable(), false);
    assert.strictEqual(guest.rx.got.size, 0, 'nothing delivered');
    close();
  }

  // Bluetooth: never. Links netlink made (Wi-Fi Direct, a hotspot): yes, and the bytes keep them
  // up (active(), netlink.touch('files')), as file.chunk does.
  {
    const a = await pair({ transport: 'ble' });
    assert.strictEqual(a.guest.fx.usable(), false, 'Bluetooth');
    a.close();
    const a2 = await pair({ address: 'ble:AA:BB' });
    assert.strictEqual(a2.guest.fx.usable(), false, 'a Bluetooth address');
    a2.close();
    for (const address of ['192.168.49.1', '10.42.0.1', '192.168.137.1', '172.20.10.1']) {
      const b = await pair({ address });
      assert.strictEqual(b.guest.fx.usable(), true, `a link made for it (${address})`);
      b.close();
    }
    const { host, guest, close } = await pair();
    let sent = 0, got = 0;
    guest.fx.active = () => sent++;
    host.fx.active = () => got++;
    const p = file('act.bin', 3 * 1024 * 1024);
    await send(guest, 'act', p);
    await check(host.rx, 'act', p);
    assert.ok(sent > 0 && got > 0, 'active() on both sides while bytes move');
    close();
    const c = await pair({ address: '169.254.10.2' });
    assert.strictEqual(c.guest.fx.usable(), true, 'a cable (link-local)');
    c.close();
  }

  // Cancelled half-way by the receiver: the sender's promise fails (not early), nothing more arrives.
  {
    const { host, guest, close } = await pair();
    const p = file('c.bin', 64 * 1024 * 1024);
    const sending = guest.fx.send('c', p, 64 * 1024 * 1024, () => {});
    await until(() => host.rx.got.get('c') && host.rx.got.get('c').bytes > 0);
    host.send({ t: T.FILE_CANCEL, id: 'c' }); // the receiver cancels
    host.fx.cancel('c');
    await assert.rejects(sending, (e) => !e.early);
    const at = host.rx.got.get('c').bytes;
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(host.rx.got.get('c').bytes, at, 'nothing after the cancel');
    assert.ok(at < 64 * 1024 * 1024);
    assert.strictEqual(guest.fx.usable(), true, 'a cancel doesn’t stop fast files');
    close();
  }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows: a cancelled stream may still hold a file */ }
  console.log('fastfile: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

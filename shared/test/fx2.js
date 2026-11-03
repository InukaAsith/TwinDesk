// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tests for fast files v2 (shared/fx2.js, shared/fx2-engine.js, its glue in shared/fastfile.js): a host and
// a guest in one process, each with its own files engine and real HTTPS, files both ways in ranges,
// receivers that only get adopt(), a bad hash, and every fallback to fx.
// Run with: node shared/test/fx2.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync, fork } = require('child_process');
const P = require('../protocol.js');
const { FastFiles, receiverHook } = require('../fastfile.js');
const { Fx2 } = require('../fx2.js');
const { plan } = require('../fx2-engine.js');

const T = P.T;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx2-'));
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
const until = async (cond, what = 'condition', ms = 15000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

// A receiver like the apps': its files (accepted before any byte), fx2's hook, and file.chunk /
// file.end for the fx way.
function receiver(name) {
  const r = { files: new Map(), done: new Map(), chunks: new Map(), ends: new Map() };
  r.accept = (id, size) => {
    const tmp = path.join(dir, `${name}-${id}.part`);
    const f = { id, tmp, size, got: 0, seq: 0, out: fs.createWriteStream(tmp, { flags: 'wx' }) };
    r.files.set(id, f);
    return f;
  };
  r.hook = receiverHook({
    find: (id) => r.files.get(id),
    end: (f) => f.out.end(() => { r.files.delete(f.id); r.done.set(f.id, { ok: true, verified: f.verified, data: fs.readFileSync(f.tmp) }); }),
    fail: (f, why) => { f.out.destroy(); r.files.delete(f.id); r.done.set(f.id, { ok: false, why }); },
  });
  r.deliver = (m) => {
    if (m.t === T.FILE_CHUNK) {
      const f = r.files.get(m.id);
      assert.ok(f && !f.fx2, `${name}: a chunk for ${m.id} comes only the fx way`);
      f.out.write(m.data);
      f.seq++;
      f.got += m.data.length;
      r.chunks.set(m.id, (r.chunks.get(m.id) || 0) + 1);
    }
    if (m.t === T.FILE_END) {
      r.ends.set(m.id, m);
      const f = r.files.get(m.id);
      if (f) f.out.end(() => { r.files.delete(m.id); r.done.set(m.id, { ok: true, verified: false, data: fs.readFileSync(f.tmp) }); });
    }
  };
  return r;
}

async function pair(opts = {}) {
  const host = { rx: receiver('host') };
  const guest = { rx: receiver('guest') };
  host.fx2 = opts.hostFx2 === false ? null : new Fx2({ tls: { key, cert } });
  guest.fx2 = opts.guestFx2 === false ? null : new Fx2();
  if (host.fx2) await new Promise((r) => (host.fx2.port ? r() : host.fx2.once('port', r)));
  const wire = (to) => (m) => setImmediate(() => { if (!to.fx.incoming(m)) to.rx.deliver(m); });
  // welcome's fx2 only when the guest's hello said fx2 and the host has an engine (as server.js does)
  const fx2On = !!(host.fx2 && guest.fx2);
  host.fx = new FastFiles({
    session: () => ({ host: true, token, transport: 'ip', address: '127.0.0.1', fx2: fx2On }),
    deliver: (m) => host.rx.deliver(m), send: wire(guest), fx2: host.fx2,
  });
  guest.fx = new FastFiles({
    session: () => ({ host: false, token, transport: 'ip', address: '127.0.0.1', port: host.port, fp, fx2: fx2On, fx2Port: opts.fx2Port || (host.fx2 ? host.fx2.port : 0) }),
    deliver: (m) => guest.rx.deliver(m), send: wire(host), fx2: guest.fx2,
  });
  host.fx.receiver(host.rx.hook);
  guest.fx.receiver(guest.rx.hook);
  host.fx.reset();
  guest.fx.reset();
  host.send = wire(guest);
  guest.send = wire(host);
  await new Promise((resolve) => {
    host.server = https.createServer({ key, cert }, (req, res) => { if (!host.fx.request(req, res)) { res.writeHead(404); res.end(); } });
    host.server.listen(0, '127.0.0.1', resolve);
  });
  host.port = host.server.address().port;
  const close = () => {
    host.fx.reset(); guest.fx.reset(); host.server.close();
    if (host.fx2) host.fx2.close();
    if (guest.fx2) guest.fx2.close();
  };
  return { host, guest, close };
}

// As the apps do: offer (the receiver accepts), fx.send, then file.end with endFields.
async function send(from, to, id, p, end = (m) => m) {
  const size = fs.statSync(p).size;
  to.rx.accept(id, size);
  let counted = 0;
  const sha256 = await from.fx.send(id, p, size, (n) => { counted += n; });
  assert.strictEqual(counted, size, 'onBytes adds up');
  from.send(end({ t: T.FILE_END, id, sha256, ...from.fx.endFields(id) }));
}

async function arrived(to, id, p) {
  await until(() => to.rx.done.has(id), `${id} arrives`);
  const d = to.rx.done.get(id);
  assert.ok(d.ok, `${id}: ok (${d.why || ''})`);
  assert.ok(d.data.equals(fs.readFileSync(p)), `${id}: the same bytes`);
  return d;
}

(async () => {
  // The ranges.
  assert.deepStrictEqual(plan(0), [{ i: 0, off: 0, len: 0 }]);
  assert.deepStrictEqual(plan(8 * 1024 * 1024).length, 1, 'up to 8 MB: one range');
  const pl = plan(30 * 1024 * 1024 + 7);
  assert.strictEqual(pl.length, 4, 'bigger: 4 ranges');
  assert.strictEqual(pl.reduce((s, r) => s + r.len, 0), 30 * 1024 * 1024 + 7);
  for (let i = 1; i < pl.length; i++) assert.strictEqual(pl[i].off, pl[i - 1].off + pl[i - 1].len);

  {
    const { host, guest, close } = await pair();
    try {
      assert.ok(guest.fx.usable2() && host.fx.usable2(), 'fx2 on both');
      // Guest → host (PUT ranges): a big one, a small one, an empty one.
      const big = file('g-big.bin', 30 * 1024 * 1024 + 7);
      const small = file('g-small.bin', 5000);
      const empty = file('g-empty.bin', 0);
      const t0 = Date.now();
      await Promise.all([send(guest, host, 'a', big), send(guest, host, 'b', small), send(guest, host, 'c', empty)]);
      for (const [id, p] of [['a', big], ['b', small], ['c', empty]]) {
        const d = await arrived(host, id, p);
        assert.ok(d.verified, `${id}: adopted (the hashes checked by fastfile.js)`);
      }
      console.log(`  guest → host, 30 MB in 4 ranges: ${Date.now() - t0} ms`);
      assert.strictEqual(host.rx.chunks.size, 0, 'no file.chunk');
      assert.strictEqual(host.rx.ends.size, 0, 'file.end never reaches the receiver');
      // Host → guest (file.pull {fx2} + GET ranges).
      const hb = file('h-big.bin', 20 * 1024 * 1024 + 3);
      const hs = file('h-small.bin', 777);
      await Promise.all([send(host, guest, 'h1', hb), send(host, guest, 'h2', hs)]);
      assert.ok((await arrived(guest, 'h1', hb)).verified);
      assert.ok((await arrived(guest, 'h2', hs)).verified);
      assert.strictEqual(guest.rx.chunks.size, 0, 'no file.chunk');
      // A hash that doesn't match: the file fails.
      const bad = file('bad.bin', 10 * 1024 * 1024);
      await send(guest, host, 'x', bad, (m) => ({ ...m, fx2: m.fx2.map((h, i) => (i ? h : 'f'.repeat(64))) }));
      await until(() => host.rx.done.has('x'), 'x settles');
      assert.deepStrictEqual(host.rx.done.get('x'), { ok: false, why: 'checksum mismatch' });
      // Many small ones at once.
      const many = Array.from({ length: 64 }, (_, i) => file(`m${i}.bin`, 100 + i));
      await Promise.all(many.map((p, i) => send(guest, host, `m${i}`, p)));
      for (let i = 0; i < many.length; i++) await arrived(host, `m${i}`, many[i]);
      // Cancel mid-way: nothing more arrives, the next file still goes.
      const c1 = file('cancel.bin', 40 * 1024 * 1024);
      host.rx.accept('k', 40 * 1024 * 1024);
      const pk = guest.fx.send('k', c1, 40 * 1024 * 1024, () => {});
      await until(() => host.rx.files.get('k') && host.rx.files.get('k').fx2, 'k targeted');
      guest.fx.cancel('k');
      host.fx.incoming({ t: T.FILE_CANCEL, id: 'k' });
      await assert.rejects(pk, /Cancelled/);
      await send(guest, host, 'after', small);
      await arrived(host, 'after', small);
    } finally {
      close();
    }
  }

  // The guest's engine can't reach the host's (wrong port): before any byte, so this file and the
  // rest go the fx way.
  {
    const { host, guest, close } = await pair({ fx2Port: 1 });
    try {
      const p = file('fb1.bin', 3 * 1024 * 1024);
      await send(guest, host, 'f1', p);
      const d = await arrived(host, 'f1', p);
      assert.strictEqual(d.verified, false, 'the fx way: chunks, its own checksum');
      assert.ok(host.rx.chunks.get('f1') > 0);
      assert.ok(guest.fx.broken2 && !guest.fx.usable2(), 'fx2 off for the rest of the session');
      // Host → guest: the guest's GET fails before any byte, it says file.pull {failed, fx2}: fx.
      const q = file('fb2.bin', 2 * 1024 * 1024);
      await send(host, guest, 'f2', q);
      const e = await arrived(guest, 'f2', q);
      assert.strictEqual(e.verified, false);
      assert.ok(host.fx.broken2, 'the host too');
    } finally {
      close();
    }
  }

  // An app without fx2 (an older one): welcome has no fx2, everything goes the fx way.
  for (const opts of [{ guestFx2: false }, { hostFx2: false }]) {
    const { host, guest, close } = await pair(opts);
    try {
      assert.ok(!guest.fx.usable2() && !host.fx.usable2(), 'no fx2');
      const k = Object.keys(opts)[0];
      const p = file(`old-${k}.bin`, 1024 * 1024);
      await send(guest, host, `${k}1`, p);
      assert.strictEqual((await arrived(host, `${k}1`, p)).verified, false);
      await send(host, guest, `${k}2`, p);
      assert.strictEqual((await arrived(guest, `${k}2`, p)).verified, false);
    } finally {
      close();
    }
  }

  // The engine as a process of its own (a utility process in the app; a forked node here).
  {
    const child = fork(path.join(__dirname, '..', 'fx2-engine.js'), [], { stdio: 'ignore' });
    const port = await new Promise((resolve) => {
      child.on('message', (m) => m.ev === 'port' && resolve(m.port));
      child.send({ op: 'listen', tls: { key: key.toString(), cert: cert.toString() } });
    });
    assert.ok(port > 0, 'the forked engine listens');
    child.kill();
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('fx2: ok');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

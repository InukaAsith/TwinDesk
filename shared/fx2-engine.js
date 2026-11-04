// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Fast files v2 (docs/protocol.md, capability `fx2`): the engine. It moves file bytes, TLS and
// hashing off the app's main thread: it runs in an Electron utility process (shared/fx2.js starts it),
// or in the same process where there is none (plain node, the tests).
//
// It has its own HTTPS server on an ephemeral port with the session's identity; the guest pins it as
// it pins the session. Requests: PUT|GET /twindesk/fx2/<id>?i=&off=&len=&total=, the fx token in
// x-twindesk-fx. A file up to 8 MB goes as one range, a bigger one as 4 parallel ranges; the receiver
// truncates the file to its size up front and writes each range at its offset. Each side hashes each
// range (SHA-256) while it streams; file.end carries the sender's, so nothing is read twice.
//
// Messages, main -> engine:
//   {op:'listen', tls}                                    -> {ev:'port', port} (0: none)
//   {op:'tokens', list}                                    the fx tokens our server takes
//   {op:'serve', id, path, size}                           host: the guest GETs it
//   {op:'put', id, path, size, to}                         guest: PUT it (to: {host, port, fp, token})
//   {op:'pull', id, path, size, to}                        guest: GET it into path
//   {op:'target', id, path}                                host: answer to 'want' (path null: refused)
//   {op:'cancel', id}, {op:'reset'}
// engine -> main:
//   {ev:'want', id, size}                                  host: a PUT came for a file not targeted yet
//   {ev:'bytes', id, dir, n}                               progress ('send' | 'recv')
//   {ev:'done', id, dir, hashes}                           every range through; hashes in range order
//   {ev:'failed', id, dir, early, message}                 early: no byte went (send it another way)
'use strict';

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const PATH = '/twindesk/fx2/';
const HEADER = 'x-twindesk-fx';
const ONE_RANGE_MAX = 8 * 1024 * 1024;
const RANGES = 4;
const ALIGN = 1024 * 1024;
const READ_BYTES = 1024 * 1024;
const WRITE_BYTES = 1024 * 1024; // gathered before a write at an offset
const IDLE_MS = 30000;
const BYTES_MS = 50; // progress at most this often per file

// [{i, off, len}] for a file of `size` bytes (the same on both sides).
function plan(size) {
  size = Number(size) || 0;
  if (size <= ONE_RANGE_MAX) return [{ i: 0, off: 0, len: size }];
  const step = Math.ceil(size / RANGES / ALIGN) * ALIGN;
  const out = [];
  for (let off = 0, i = 0; off < size; off += step, i++) out.push({ i, off, len: Math.min(step, size - off) });
  return out;
}

const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const normFp = (fp) => String(fp || '').replace(/:/g, '').toLowerCase();

function early(message) {
  const e = new Error(message);
  e.early = true;
  return e;
}

// Writes into a file at offsets: one fd per file, writes gathered to WRITE_BYTES, the source paused
// while one is on its way.
class RangeWriter {
  constructor(fd, off, len, src) {
    Object.assign(this, { fd, pos: off, left: len, src, parts: [], size: 0, busy: false, err: null, got: 0 });
    this.hash = crypto.createHash('sha256');
    this.waiters = [];
  }

  // A buffer from the network: false when it's more than the range.
  push(b) {
    if (b.length > this.left - this.size) return false;
    this.hash.update(b);
    this.parts.push(b);
    this.size += b.length;
    if (this.size >= WRITE_BYTES) this._write();
    return true;
  }

  _write() {
    if (this.busy || !this.size || this.err) return;
    const buf = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.size);
    this.parts = [];
    this.size = 0;
    this.busy = true;
    if (this.src) this.src.pause();
    const pos = this.pos;
    this.pos += buf.length;
    this.left -= buf.length;
    const go = (from) => fs.write(this.fd, buf, from, buf.length - from, pos + from, (err, n) => {
      if (!err && from + n < buf.length) return go(from + n);
      this.busy = false;
      if (err) this.err = err;
      this.got += buf.length;
      if (this.src && !this.err) this.src.resume();
      if (this.size >= WRITE_BYTES) this._write();
      else if (!this.busy) for (const w of this.waiters.splice(0)) w();
    });
    go(0);
  }

  // Everything written: resolves with the range's hash (rejects on a write error or a short range).
  finish() {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.size) return this._write();
        if (this.busy) return;
        if (this.err) return reject(this.err);
        if (this.left !== 0) return reject(new Error('size mismatch'));
        resolve(this.hash.digest('hex'));
      };
      this.waiters.push(check);
      check();
    });
  }
}

class Engine {
  constructor(post) {
    this.post = post;
    this.server = null;
    this.port = 0;
    this.tokens = [];
    this.serving = new Map(); // id -> {path, size, ranges, hashes, left, reqs}
    this.incoming = new Map(); // id -> {size, path|null (waiting), fd, ranges, hashes, left, queue, reqs}
    this.outgoing = new Map(); // id -> {reqs, done}
    this.pulls = new Map(); // id -> {reqs, done}
    this.counts = new Map(); // id\0dir -> bytes not told yet
    this.countTimer = null;
    this.agent = this._agent();
  }

  _agent() {
    return new https.Agent({ keepAlive: true, maxSockets: 32, rejectUnauthorized: false, maxCachedSessions: 0 });
  }

  handle(m) {
    try {
      switch (m && m.op) {
        case 'listen': return this._listen(m.tls);
        case 'tokens': this.tokens = Array.isArray(m.list) ? m.list.filter((t) => typeof t === 'string' && t) : []; return;
        case 'serve': return this._serve(m);
        case 'put': return this._put(m);
        case 'pull': return this._pull(m);
        case 'target': return this._target(m.id, m.path);
        case 'cancel': return this._cancel(m.id, 'Cancelled');
        case 'reset': return this._reset();
      }
    } catch (e) {
      if (m && m.id) this._failed(m.id, m.op === 'pull' || m.op === 'target' ? 'recv' : 'send', e);
    }
  }

  // ---- the server (as the host) ----

  _listen(tls) {
    if (this.server) return this.post({ ev: 'port', port: this.port });
    const opts = {};
    for (const k of ['key', 'cert', 'pfx', 'ca']) if (tls && tls[k]) opts[k] = typeof tls[k] === 'string' ? tls[k] : Buffer.from(tls[k]);
    if (tls && tls.passphrase) opts.passphrase = tls.passphrase;
    let s;
    try { s = https.createServer(opts, (req, res) => this._request(req, res)); } catch (e) {
      console.warn(`[fx2] no server: ${e.message}`);
      return this.post({ ev: 'port', port: 0 });
    }
    s.on('error', (e) => {
      console.warn(`[fx2] server: ${e.code || e.message}`);
      if (!this.port) this.post({ ev: 'port', port: 0 });
    });
    s.keepAliveTimeout = 60000;
    s.listen(0, '0.0.0.0', () => {
      this.server = s;
      this.port = s.address().port;
      this.post({ ev: 'port', port: this.port });
    });
  }

  _request(req, res) {
    const fail = (code) => { res.writeHead(code); res.end(); };
    if (!req.url.startsWith(PATH)) return fail(404);
    if (!this.tokens.some((t) => same(req.headers[HEADER], t))) return fail(403);
    let url;
    try { url = new URL(req.url, 'https://x'); } catch (_) { return fail(400); }
    let id;
    try { id = decodeURIComponent(url.pathname.slice(PATH.length)); } catch (_) { id = ''; }
    const q = (k) => Number(url.searchParams.get(k));
    const r = { i: q('i'), off: q('off'), len: q('len'), total: q('total') };
    if (!id || id.length > 100 || !Object.values(r).every(Number.isSafeInteger)) return fail(400);
    const want = plan(r.total)[r.i];
    if (!want || want.off !== r.off || want.len !== r.len) return fail(400);
    req.setTimeout(IDLE_MS, () => req.destroy());
    if (req.method === 'GET') return this._get(id, r, req, res);
    if (req.method === 'PUT') return this._putIn(id, r, req, res);
    return fail(405);
  }

  // GET: a range of a file we serve.
  _get(id, r, req, res) {
    const s = this.serving.get(id);
    if (!s || s.size !== r.total || s.hashes[r.i] !== undefined || s.busy.has(r.i)) {
      res.writeHead(404);
      return res.end();
    }
    s.busy.add(r.i);
    const hash = crypto.createHash('sha256');
    const rs = r.len ? fs.createReadStream(s.path, { start: r.off, end: r.off + r.len - 1, highWaterMark: READ_BYTES }) : null;
    s.reqs.add(res);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': r.len });
    const gone = (e) => {
      if (this.serving.get(id) !== s) return;
      if (rs) rs.destroy();
      this._failed(id, 'send', e || new Error('the transfer stopped'), s.sent === 0);
    };
    res.on('close', () => { if (!res.writableFinished) gone(); });
    res.on('error', gone);
    res.on('finish', () => {
      if (this.serving.get(id) !== s) return;
      s.reqs.delete(res);
      s.hashes[r.i] = hash.digest('hex');
      if (--s.left === 0) {
        this.serving.delete(id);
        this._flushCount(id, 'send');
        this.post({ ev: 'done', id, dir: 'send', hashes: s.hashes });
      }
    });
    if (!rs) return res.end();
    rs.on('error', gone);
    rs.on('data', (b) => { hash.update(b); s.sent += b.length; this._count(id, 'send', b.length); });
    rs.pipe(res);
  }

  _serve(m) {
    const ranges = plan(m.size);
    this.serving.set(m.id, { path: m.path, size: Number(m.size), hashes: new Array(ranges.length), left: ranges.length, busy: new Set(), reqs: new Set(), sent: 0 });
  }

  // PUT: a range of a file the guest sends us. The first one asks main where it goes ('want').
  _putIn(id, r, req, res) {
    let f = this.incoming.get(id);
    if (!f) {
      const ranges = plan(r.total);
      f = { size: r.total, path: undefined, fd: null, hashes: new Array(ranges.length), left: ranges.length, queue: [], reqs: new Set(), busy: new Set(), got: 0 };
      this.incoming.set(id, f);
      this.post({ ev: 'want', id, size: r.total });
    }
    if (f.size !== r.total || f.hashes[r.i] !== undefined || f.busy.has(r.i)) {
      res.writeHead(409);
      return res.end();
    }
    f.busy.add(r.i);
    req.pause();
    f.reqs.add(req);
    const go = () => this._takeRange(id, f, r, req, () => { res.writeHead(200); res.end(); }, (code) => { res.writeHead(code); res.end(); });
    if (f.path === undefined) f.queue.push(go);
    else go();
  }

  _target(id, path) {
    const f = this.incoming.get(id);
    if (!f || f.path !== undefined) return;
    if (!path) {
      this.incoming.delete(id);
      for (const req of f.reqs) req.destroy();
      return;
    }
    try {
      f.fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o644);
      fs.ftruncateSync(f.fd, f.size);
    } catch (e) {
      return this._failed(id, 'recv', e, true);
    }
    f.path = path;
    for (const go of f.queue.splice(0)) go();
  }

  // The body of a range (a PUT's or a GET response's) into the file at its offset.
  _takeRange(id, f, r, src, ok, refuse) {
    if (this.incoming.get(id) !== f && this.pulls.get(id) !== f) return refuse && refuse(410);
    const w = new RangeWriter(f.fd, r.off, r.len, src);
    src.on('data', (b) => {
      if (!w.push(b)) {
        src.destroy();
        return this._failed(id, 'recv', new Error('more data than offered'));
      }
      f.got += b.length;
      this._count(id, 'recv', b.length);
    });
    src.on('error', () => {});
    src.on('close', () => { if (!src.complete && !w.done) this._failed(id, 'recv', new Error('the transfer stopped'), f.got === 0); });
    src.on('end', () => {
      w.done = true;
      w.finish().then((hex) => {
        if (this.incoming.get(id) !== f && this.pulls.get(id) !== f) return;
        f.reqs.delete(src);
        f.hashes[r.i] = hex;
        if (ok) ok();
        if (--f.left === 0) this._received(id, f);
      }, (e) => this._failed(id, 'recv', e));
    });
    src.resume();
  }

  _received(id, f) {
    if (this.incoming.get(id) === f) this.incoming.delete(id);
    if (this.pulls.get(id) === f) this.pulls.delete(id);
    try { fs.closeSync(f.fd); } catch (e) { return this.post({ ev: 'failed', id, dir: 'recv', early: false, message: e.message }); }
    f.fd = null;
    this._flushCount(id, 'recv');
    this.post({ ev: 'done', id, dir: 'recv', hashes: f.hashes });
  }

  // ---- the client (as the guest) ----

  _req(to, method, id, r, size) {
    return https.request({
      host: to.host, port: to.port, method, agent: this.agent,
      path: `${PATH}${encodeURIComponent(id)}?i=${r.i}&off=${r.off}&len=${r.len}&total=${size}`,
      headers: { [HEADER]: to.token, ...(method === 'PUT' ? { 'content-type': 'application/octet-stream', 'content-length': r.len } : {}) },
    });
  }

  // Go once the socket is the host's (its fingerprint the paired one): nothing, not even the
  // token, is written before.
  _pinned(req, fp, go) {
    req.on('socket', (sock) => {
      const check = () => {
        const cert = sock.getPeerCertificate() || {};
        if (!fp || !cert.fingerprint256 || normFp(cert.fingerprint256) !== normFp(fp)) return req.destroy(early('not the paired computer'));
        go();
      };
      if ((sock.getPeerCertificate() || {}).fingerprint256) check();
      else sock.once('secureConnect', check);
    });
  }

  _put(m) {
    const ranges = plan(m.size);
    const o = { reqs: new Set(), hashes: new Array(ranges.length), left: ranges.length, sent: 0 };
    this.outgoing.set(m.id, o);
    for (const r of ranges) {
      const req = this._req(m.to, 'PUT', m.id, r, m.size);
      o.reqs.add(req);
      const hash = crypto.createHash('sha256');
      req.setTimeout(IDLE_MS, () => req.destroy(new Error('stalled')));
      req.on('error', (e) => this.outgoing.get(m.id) === o && this._failed(m.id, 'send', o.sent ? e : early(e.message), !o.sent));
      req.on('response', (res) => {
        res.resume();
        res.on('end', () => {
          if (this.outgoing.get(m.id) !== o) return;
          if (res.statusCode !== 200) return this._failed(m.id, 'send', early(`HTTP ${res.statusCode}`), !o.sent);
          o.reqs.delete(req);
          o.hashes[r.i] = hash.digest('hex');
          if (--o.left === 0) {
            this.outgoing.delete(m.id);
            this._flushCount(m.id, 'send');
            this.post({ ev: 'done', id: m.id, dir: 'send', hashes: o.hashes });
          }
        });
      });
      this._pinned(req, m.to.fp, () => {
        if (this.outgoing.get(m.id) !== o) return;
        if (!r.len) return req.end();
        const rs = fs.createReadStream(m.path, { start: r.off, end: r.off + r.len - 1, highWaterMark: READ_BYTES });
        o.reqs.add(rs);
        rs.on('data', (b) => { hash.update(b); o.sent += b.length; this._count(m.id, 'send', b.length); });
        rs.on('error', (e) => { req.destroy(); this._failed(m.id, 'send', e); });
        rs.pipe(req);
      });
    }
  }

  _pull(m) {
    const ranges = plan(m.size);
    let fd;
    try {
      fd = fs.openSync(m.path, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o644);
      fs.ftruncateSync(fd, Number(m.size));
    } catch (e) {
      return this._failed(m.id, 'recv', early(e.message), true);
    }
    const f = { size: Number(m.size), path: m.path, fd, hashes: new Array(ranges.length), left: ranges.length, reqs: new Set(), got: 0 };
    this.pulls.set(m.id, f);
    for (const r of ranges) {
      const req = this._req(m.to, 'GET', m.id, r, m.size);
      f.reqs.add(req);
      req.setTimeout(IDLE_MS, () => req.destroy(new Error('stalled')));
      req.on('error', (e) => this.pulls.get(m.id) === f && this._failed(m.id, 'recv', e, f.got === 0));
      req.on('response', (res) => {
        if (this.pulls.get(m.id) !== f) return res.destroy();
        if (res.statusCode !== 200) {
          res.resume();
          return this._failed(m.id, 'recv', new Error(`HTTP ${res.statusCode}`), f.got === 0);
        }
        f.reqs.add(res);
        this._takeRange(m.id, f, r, res, null, null);
      });
      this._pinned(req, m.to.fp, () => { if (this.pulls.get(m.id) === f) req.end(); });
    }
  }

  // ---- the rest ----

  _count(id, dir, n) {
    const k = `${id}\0${dir}`;
    this.counts.set(k, (this.counts.get(k) || 0) + n);
    if (this.countTimer) return;
    this.countTimer = setTimeout(() => {
      this.countTimer = null;
      for (const [key, v] of this.counts) {
        const [i, d] = key.split('\0');
        this.post({ ev: 'bytes', id: i, dir: d, n: v });
      }
      this.counts.clear();
    }, BYTES_MS);
  }

  _flushCount(id, dir) {
    const k = `${id}\0${dir}`;
    const v = this.counts.get(k);
    if (!v) return;
    this.counts.delete(k);
    this.post({ ev: 'bytes', id, dir, n: v });
  }

  // A file failed (once): everything of it stops; main hears why.
  _failed(id, dir, err, isEarly = false) {
    const had = this._stop(id, dir);
    if (!had) return;
    this.counts.delete(`${id}\0${dir}`);
    this.post({ ev: 'failed', id, dir, early: !!(isEarly || (err && err.early)), message: (err && err.message) || 'failed' });
  }

  _stop(id, dir) {
    let had = false;
    const kill = (set) => { for (const x of set) try { x.destroy(); } catch (_) { /* gone */ } };
    if (dir !== 'recv') {
      const s = this.serving.get(id);
      if (s) { this.serving.delete(id); kill(s.reqs); had = true; }
      const o = this.outgoing.get(id);
      if (o) { this.outgoing.delete(id); kill(o.reqs); had = true; }
    }
    if (dir !== 'send') {
      for (const map of [this.incoming, this.pulls]) {
        const f = map.get(id);
        if (!f) continue;
        map.delete(id);
        kill(f.reqs);
        if (f.fd !== null && f.fd !== undefined) {
          const fd = f.fd;
          f.fd = null;
          setTimeout(() => { try { fs.closeSync(fd); } catch (_) { /* closed */ } }, 50); // after writes in flight
        }
        had = true;
      }
    }
    return had;
  }

  _cancel(id) {
    this._stop(id, null);
    this.counts.delete(`${id}\0send`);
    this.counts.delete(`${id}\0recv`);
  }

  _reset() {
    for (const map of [this.serving, this.outgoing, this.incoming, this.pulls]) for (const id of [...map.keys()]) this._cancel(id);
    this.agent.destroy();
    this.agent = this._agent();
  }
}

// In a utility process (Electron) or a forked child (node): wire the engine to the parent.
if (require.main === module || process.parentPort) {
  const port = process.parentPort;
  if (port) {
    const engine = new Engine((m) => port.postMessage(m));
    port.on('message', (e) => engine.handle(e.data));
  } else if (process.send) {
    const engine = new Engine((m) => process.send(m));
    process.on('message', (m) => engine.handle(m));
    process.on('disconnect', () => process.exit(0));
  }
}

module.exports = { Engine, plan, PATH, HEADER };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Fast files (one-to-one): the bytes of an accepted file go over HTTPS on the session's port, as a
// plain stream, instead of base64 file.chunk messages on the control socket. Nothing else changes:
// file.offer / accept / end / done / cancel go as before, and the receiving side gets the bytes as
// file.chunk messages (data a Buffer) from deliver(), so the receivers need only take a Buffer.
//
// Only when both apps said so (hello {fx: 1}, welcome {fx: token}, the token a secret of this
// session) and the session runs on the network, a cable or a link netlink.js made (Wi-Fi Direct, a
// hotspot), never through Bluetooth: that keeps file.chunk. An older app never says so. On a link
// netlink.js made, the bytes keep it up as file.chunk does (active(): netlink.touch('files')).
//
// The guest connects, as it does for the session: it PUTs what it sends, and GETs what the host
// sends when the host says file.pull. It pins the host's certificate as the session does; the host
// checks the token. file.end, which can overtake the last bytes of a GET, waits for them.
//
// Something wrong before any byte went (no answer, refused): the sender sends that file the old
// way and the rest of the session uses file.chunk.
//
// Fast files v2 (docs/protocol.md, `fx2`: hello {fx2: 1}, welcome {fx2: {port}}): with an app that
// can, the bytes go through the files engine (shared/fx2.js, a utility process) instead, big files as
// parallel ranges, and file.end carries the hashes of the ranges ({fx2: [hex]}). The receiving app
// checks them itself and hands the finished file to its receiver (receiver() hooks: target, adopt,
// fail), so receivers never see those bytes or that file.end. Anything wrong before a byte went: the
// file goes the fx way, and so do the rest of the session's.
//
// Unencrypted file transfers (docs/protocol.md, `fxPlain`; Files › Encrypt file transfers off): the
// guest's hello {fxPlain: 1} when it allows it (a phone always does: its computer decides), the host's
// welcome {fxPlain: {port, fx2Port, token}} when it allows it too. The bytes then go over plain HTTP
// on those ports (fx and fx2 alike) with a token of their own, so the session's token never goes in
// the clear. The session stays on TLS, and so do file.end's hashes, which the receiver checks: a
// file can be read on the network, not changed. An app without it never says either: TLS as before.
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const P = require('./protocol.js');
const awake = require('./awake.js');

const T = P.T;
const PATH = '/twindesk/fx/';
const HEADER = 'x-twindesk-fx';
const PARALLEL = 4; // files in flight at once
const PARALLEL_SMALL = 16; // … while the next one is small (a folder of small files: round trips, not bytes)
const SMALL_BYTES = 1024 * 1024;
const READ_BYTES = 1024 * 1024; // read from disk at a time
const CHUNK_BYTES = 512 * 1024; // bytes per file.chunk handed to the receiver
const PULL_MS = 10000; // the guest didn't come for a file: it goes the old way
const IDLE_MS = 30000; // no bytes this long: the transfer failed
const RETRY2_MS = 60000; // fx2 failed before a byte went: the fx way this long, then fx2 is tried again (#143)

// No TLS session resumption: a resumed connection has no peer certificate to pin.
const agent = () => new https.Agent({ keepAlive: true, maxSockets: PARALLEL_SMALL + 2, rejectUnauthorized: false, maxCachedSessions: 0 });
const plainAgent = () => new http.Agent({ keepAlive: true, maxSockets: PARALLEL_SMALL + 2 });
const TOKEN = /^[0-9a-f]{32}$/;
const okPort = (n) => Number.isInteger(n) && n > 0 && n < 65536;
const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

function early(message) {
  const e = new Error(message);
  e.early = true; // nothing went: send it the old way
  return e;
}

class FastFiles {
  // opts: session() -> null | {host, token, transport, address, port?, fp?} (host: we are the server;
  //   port, fp: the host's, when we are the guest); deliver(msg): to the feature code as if from the
  //   peer; send(msg): to the peer.
  constructor(opts) {
    this.o = opts;
    // fx2 (opts.fx2, shared/fx2.js): out2 id -> {resolve, reject, timer, sent} (host, waiting for the
    // guest's GETs); in2 id -> {hook, hashes, end} (a file the engine brings in); ends id -> hashes for
    // file.end; hooks: the receivers'.
    this.fx2 = opts.fx2 || null;
    this.broken2Until = 0; // broken2 (below): fx2 failed early, the fx way until then
    this.why2 = ''; // … and why, for Engines in use and the fallback notice
    this.onFallback = null; // (info {from, to, why}) the app says it once (main.js)
    this.out2 = new Map();
    this.in2 = new Map();
    this.ends = new Map();
    this.hooks = [];
    this.tokens2 = '';
    if (this.fx2) {
      this.fx2.want = (id, size) => this._target(id, size);
      this.fx2.doneRecv = (id, hashes) => this._got2(id, hashes);
      this.fx2.failedRecv = (id, isEarly, message) => this._recvFailed2(id, isEarly, message);
      this.fx2.bytesRecv = (id, n) => this._progress2(id, n);
    }
    this.arriving = new Map(); // id -> {seq, parts, size, held, stream}
    this.outgoing = new Map(); // id -> host: {path, size, onBytes, resolve, reject, timer, res?}; guest: {req}
    this.broken = false;
    this.agent = agent();
    this.plainAgent = plainAgent();
    this.pressures = []; // receivers': (id) -> a promise while their disk is behind, else null
    // Unencrypted file transfers: on (the setting), and our plain server's port once it listens.
    this.plainOn = false;
    this.plainServer = null;
    this.plainPort = 0;
    // () on bytes either way: a link made for files (netlink.js) stays up while they move.
    this.active = null;
    // The last file's way (Settings › General › Advanced, shared/engines.js): {way: 'fx2' | 'fx' |
    // 'chunk', dir: 'send' | 'recv', plain, at}.
    this.last = null;
  }

  _note(way, dir) {
    const s = this.o.session();
    this.last = { way, dir, plain: way !== 'chunk' && this._plainNow(s), at: Date.now() };
  }

  // The app sent a file.chunk (the old way): for describe()'s last.
  sentChunk() {
    if (!this.last || this.last.way !== 'chunk' || this.last.dir !== 'send') this._note('chunk', 'send');
  }

  _plainNow(s) {
    return !!s && this.plainOn && !!(s.host ? s.plainToken : s.plain);
  }

  // What the next file uses and why (shared/engines.js): {next: 'fx2' | 'fx' | 'chunk', why: '' |
  // 'peer' (the other app can't) | 'bluetooth' | 'failed' (it failed this session) | 'off' (here) |
  // 'engine' (ours isn't up), plain, last}.
  describe() {
    const s = this.o.session();
    const out = { next: 'chunk', why: '', plain: false, last: this.last };
    if (!s || !s.token) return { ...out, why: 'peer' };
    if (s.transport === 'ble' || String(s.address || '').startsWith('ble:')) return { ...out, why: 'bluetooth' };
    if (this.broken) return { ...out, why: 'failed' };
    out.plain = this._plainNow(s);
    if (this.usable2()) return { ...out, next: 'fx2' };
    return { ...out, next: 'fx', why: !this.fx2 ? 'off' : this.broken2 ? 'failed' : !s.fx2 ? 'peer' : 'engine', detail: this.broken2 ? this.why2 : '' };
  }

  // fx2 failed before a byte went: the fx way for RETRY2_MS, not for the whole session (a passing
  // hiccup, the engine restarting, doesn't keep a session slow).
  get broken2() { return Date.now() < this.broken2Until; }
  set broken2(v) { this.broken2Until = v ? Date.now() + RETRY2_MS : 0; if (!v) this.why2 = ''; }

  _fellBack(from, to, why) {
    console.warn(`[files] ${from} -> ${to}: ${why}`);
    if (this.onFallback) try { this.onFallback({ from, to, why: String(why || '').slice(0, 200) }); } catch (_) { /* the app's */ }
  }

  _active() {
    awake.touch();
    if (this.active) try { this.active(); } catch (_) { /* the app's */ }
  }

  // ---- unencrypted file transfers (fxPlain) ----

  // Files › Encrypt file transfers, off = on here: our plain servers listen (as the host), and we
  // say so in hello (as the guest). A session already going keeps what it agreed, except that our
  // plain servers close when it's turned back off (its files then go the TLS way).
  setPlain(on) {
    on = !!on;
    if (on === this.plainOn) return;
    this.plainOn = on;
    if (on) this._listenPlain();
    else {
      if (this.plainServer) this.plainServer.close();
      this.plainServer = null;
      this.plainPort = 0;
      this.plainAgent.destroy();
      this.plainAgent = plainAgent();
    }
    if (this.fx2) this.fx2.setPlain(on);
    this.tokens2 = null;
    this._syncTokens();
  }

  _listenPlain() {
    const srv = http.createServer((req, res) => {
      if (this.request(req, res, true)) return;
      res.writeHead(404);
      res.end();
    });
    srv.keepAliveTimeout = 60000;
    srv.requestTimeout = 0; // not Node's 5-min cap on a whole request: a big upload outlasts it; idle timeouts catch stalls
    srv.on('error', (e) => console.warn(`[fx] plain server: ${e.code || e.message}`));
    srv.listen(0, '0.0.0.0', () => {
      if (this.plainServer !== srv) return srv.close();
      this.plainPort = srv.address().port;
      console.log(`[fx] unencrypted files on port ${this.plainPort}`);
    });
    this.plainServer = srv;
  }

  // The guest's hello field.
  plainHello() {
    return this.plainOn ? { fxPlain: 1 } : {};
  }

  // The host's welcome field for a session (ctx: fx, fxPlainWanted from its hello); sets ctx.fxPlain,
  // the session's plain token ('' when it stays encrypted).
  plainOffer(ctx) {
    const ok = !!ctx && !!ctx.fx && ctx.fxPlainWanted === true && this.plainOn && this.plainPort > 0;
    if (ctx) ctx.fxPlain = ok ? P.randomHex(16) : '';
    if (!ok) return {};
    const fx2Port = this.fx2 && this.fx2.plainPort > 0 ? this.fx2.plainPort : 0;
    return { fxPlain: { port: this.plainPort, ...(fx2Port ? { fx2Port } : {}), token: ctx.fxPlain } };
  }

  // The guest's side of welcome {fxPlain}: {port, fx2Port, token}, or null (encrypted).
  static parsePlain(msg) {
    const p = msg && msg.fxPlain;
    if (!p || typeof p !== 'object' || !okPort(p.port) || typeof p.token !== 'string' || !TOKEN.test(p.token)) return null;
    return { port: p.port, fx2Port: okPort(p.fx2Port) ? p.fx2Port : 0, token: p.token };
  }

  // As guest: where our requests go — plain when both agreed (and we still allow it), else the session's port over TLS.
  _to(s) {
    if (this.plainOn && s.plain && okPort(s.plain.port)) return { mod: http, port: s.plain.port, token: s.plain.token, agent: this.plainAgent, plain: true };
    return { mod: https, port: s.port, token: s.token, agent: this.agent, plain: false };
  }

  _to2(s) {
    if (this.plainOn && s.plain && okPort(s.plain.fx2Port)) return { host: s.address, port: s.plain.fx2Port, token: s.plain.token, plain: true };
    return { host: s.address, port: s.fx2Port, fp: s.fp, token: s.token };
  }

  // A receiver's backpressure: after each chunk, fn(id) -> a promise (the transfer waits for it)
  // or null. The bytes stay in the socket meanwhile, not in memory.
  pressure(fn) {
    this.pressures.push(fn);
  }

  // A receiver's hook for fx2 files: {target(id, size) -> tmp path | Promise | null (not ours, not
  // the size it accepted, or bytes already came), untarget(id) (it goes the old way after all), adopt(id) (every byte is in
  // tmp and checked: finish as file.end would), fail(id, why), progress?(id, n)}.
  receiver(hook) {
    this.hooks.push(hook);
  }

  // fx2 for the next file: fx can, and both apps have the engine.
  usable2() {
    if (!this.fx2 || this.broken2 || !this.usable()) return false;
    const s = this.o.session();
    return !!s.fx2 && (s.host ? this.fx2.ready : this.fx2.client && Number.isInteger(s.fx2Port));
  }

  // file.end's extra field for a file that went through fx2 (once), else nothing.
  endFields(id) {
    const h = this.ends.get(id);
    this.ends.delete(id);
    return h ? { fx2: h } : {};
  }

  // The host's engine takes the session's token (and only it).
  _syncTokens() {
    if (!this.fx2) return;
    const s = this.o.session();
    const t = s && s.host && s.fx2 && s.token ? s.token : '';
    const pt = t && this.plainOn && s.plainToken ? s.plainToken : '';
    if (t + pt === this.tokens2) return;
    this.tokens2 = t + pt;
    this.fx2.setTokens(t ? [t] : [], pt ? [pt] : []);
  }

  // Fast files for the next file: both sides can, on the network, a cable or a link made for it.
  usable() {
    const s = this.o.session();
    return !this.broken && !!s && !!s.token && s.transport !== 'ble' && !String(s.address || '').startsWith('ble:');
  }

  // How many files go at once.
  get parallel() {
    return this.usable() ? PARALLEL : 1;
  }

  // … when the next file has `size` bytes.
  parallelFor(size) {
    if (!this.usable()) return 1;
    return Number(size) < SMALL_BYTES ? PARALLEL_SMALL : PARALLEL;
  }

  // The session ended or another one started.
  reset() {
    this.broken = false;
    this.broken2 = false;
    if (this.fx2) this.fx2.reset();
    for (const id of [...this.out2.keys()]) this._fail2(id, new Error('the other computer disconnected'));
    for (const [id, r] of [...this.in2]) {
      this.in2.delete(id);
      try { r.hook.fail(id, 'disconnected'); } catch (_) { /* gone */ }
    }
    this.ends.clear();
    this.tokens2 = null;
    this._syncTokens();
    for (const id of [...this.arriving.keys()]) this._drop(id, true, false);
    for (const id of [...this.outgoing.keys()]) this._fail(id, new Error('the other computer disconnected'));
    this.agent.destroy();
    this.agent = agent();
    this.plainAgent.destroy();
    this.plainAgent = plainAgent();
  }

  // ---- sending ----

  // Sends an accepted file; resolves with its SHA-256 (send file.end then). Rejects with e.early
  // when nothing went. onBytes(n) as bytes go.
  send(id, path, size, onBytes) {
    if (!onBytes.awake) { // the computer stays awake while the bytes go (shared/awake.js)
      const tell = onBytes;
      onBytes = (n) => { this._active(); tell(n); };
      onBytes.awake = true;
    }
    if (this.outgoing.has(id) || this.out2.has(id)) return Promise.reject(new Error('file is already transferring'));
    const s = this.o.session();
    if (!s || !s.token) return Promise.reject(early('no fast files'));
    if (this.usable2()) {
      return this._send2(s, id, path, size, onBytes).catch((e) => {
        if (!e.early) throw e;
        this.broken2 = true;
        this.why2 = e.message;
        this._fellBack('fx2', 'fx', e.message);
        return this.send(id, path, size, onBytes);
      });
    }
    return s.host ? this._offerPull(id, path, size, onBytes) : this._put(s, id, path, size, onBytes);
  }

  // Stop sending or receiving this file (cancelled on either side).
  cancel(id) {
    this._fail(id, new Error('Cancelled'));
    this._drop(id, true, false);
    this._fail2(id, new Error('Cancelled'));
    if (this.in2.has(id)) this.in2.delete(id);
    this.ends.delete(id);
    if (this.fx2) this.fx2.cancel(id);
  }

  // ---- fx2: sending ----

  // Resolves with a SHA-256 for file.end's sha256 (over the ranges' hashes); endFields() adds them.
  _send2(s, id, path, size, onBytes) {
    const done = (hashes) => {
      this.ends.set(id, hashes);
      this._note('fx2', 'send');
      return crypto.createHash('sha256').update(hashes.join(',')).digest('hex');
    };
    if (!s.host) {
      return this.fx2.put(id, path, size, this._to2(s), onBytes).then(done);
    }
    this._syncTokens();
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, sent: 0 };
      w.timer = setTimeout(() => this._fail2(id, early('no pull')), PULL_MS);
      this.out2.set(id, w);
      this.fx2.serve(id, path, size, (n) => {
        clearTimeout(w.timer);
        w.sent += n;
        onBytes(n);
      }).then((hashes) => {
        if (this.out2.get(id) !== w) return;
        this.out2.delete(id);
        clearTimeout(w.timer);
        resolve(done(hashes));
      }, (e) => {
        if (this.out2.get(id) !== w) return;
        if (e.early && !w.sent) return; // the guest's file.pull {failed} (or the timer) says it
        this._fail2(id, e);
      });
      try {
        if (this.o.send({ t: T.FILE_PULL, id, fx2: 1, size }) === false) this._fail2(id, early('control connection unavailable'));
      } catch (e) { this._fail2(id, early(e.message)); }
    });
  }

  _fail2(id, err) {
    const w = this.out2.get(id);
    if (!w) return;
    this.out2.delete(id);
    clearTimeout(w.timer);
    if (this.fx2) this.fx2.cancel(id);
    if (!(err.early && !w.sent)) delete err.early;
    w.reject(err);
  }

  // ---- fx2: receiving ----

  // Where an incoming file goes (a receiver's tmp), or null; it's then tracked until its file.end.
  async _target(id, size) {
    for (const hook of this.hooks) {
      let p = null;
      try { p = await hook.target(id, size); } catch (_) { p = null; }
      if (p) {
        this.in2.set(id, { hook, hashes: null, end: null });
        return p;
      }
    }
    return null;
  }

  // As guest: the host said file.pull {fx2}.
  async _pull2(id, size) {
    const s = this.o.session();
    const failed = () => this.o.send({ t: T.FILE_PULL, id, failed: true, fx2: 1 });
    if (!s || s.host || !s.token || !this.fx2 || !this.fx2.client || !Number.isInteger(s.fx2Port)) return failed();
    if (this.arriving.has(id) || !Number.isSafeInteger(size) || size < 0) return failed();
    const file = await this._target(id, size);
    if (!file) return failed();
    this.fx2.pull(id, file, size, this._to2(s), (n) => this._progress2(id, n)).then(
      (hashes) => this._got2(id, hashes),
      (e) => this._recvFailed2(id, !!e.early, e.message),
    );
  }

  _progress2(id, n) {
    this._active();
    const r = this.in2.get(id);
    if (r && r.hook.progress) try { r.hook.progress(id, n); } catch (_) { /* the receiver's */ }
  }

  _got2(id, hashes) {
    const r = this.in2.get(id);
    if (!r) return;
    r.hashes = hashes;
    this._note('fx2', 'recv');
    this._settle2(id, r);
  }

  _recvFailed2(id, isEarly, message) {
    const r = this.in2.get(id);
    if (!r) return;
    this.in2.delete(id);
    if (isEarly) {
      try { if (r.hook.untarget) r.hook.untarget(id); } catch (_) { /* the receiver's */ }
      const s = this.o.session();
      if (s && !s.host) this.o.send({ t: T.FILE_PULL, id, failed: true, fx2: 1 }); // the host sends it the fx way
      return;
    }
    try { r.hook.fail(id, message || 'the transfer stopped'); } catch (_) { /* the receiver's */ }
  }

  // Both the bytes and file.end are in: the hashes match, or the file failed.
  _settle2(id, r) {
    if (!r.hashes || !r.end) return;
    this.in2.delete(id);
    const theirs = r.end.fx2;
    const ok = Array.isArray(theirs) && theirs.length === r.hashes.length && theirs.every((h, i) => typeof h === 'string' && h.toLowerCase() === r.hashes[i]);
    try {
      if (ok) r.hook.adopt(id);
      else r.hook.fail(id, 'checksum mismatch');
    } catch (e) {
      console.warn(`[fx2] ${id}: ${e.message}`);
    }
  }

  // As guest: PUT it to the host.
  _put(s, id, path, size, onBytes) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      let sent = 0, done = false;
      const w = {};
      const finish = (err, sha) => {
        if (done) return;
        done = true;
        if (this.outgoing.get(id) === w) this.outgoing.delete(id);
        if (w.rs) w.rs.destroy();
        if (!err) { this._note('fx', 'send'); return resolve(sha); }
        if (err.early) { if (!this.broken) this._fellBack('fx', 'file.chunk', err.message); this.broken = true; }
        reject(err);
      };
      const to = this._to(s);
      const req = to.mod.request({
        host: s.address, port: to.port, method: 'PUT', path: PATH + encodeURIComponent(id), agent: to.agent,
        headers: { [HEADER]: to.token, 'content-type': 'application/octet-stream', 'content-length': size },
      });
      w.req = req;
      w.fail = (e) => { req.destroy(); if (w.res) w.res.destroy(); finish(e); };
      this.outgoing.set(id, w);
      req.setTimeout(IDLE_MS, () => req.destroy(new Error('stalled')));
      req.on('error', (e) => finish(sent ? e : early(e.message)));
      req.on('response', (res) => {
        if (done) return res.destroy();
        w.res = res;
        res.on('error', (e) => finish(e));
        res.on('aborted', () => finish(new Error('the transfer stopped')));
        res.on('close', () => { if (!res.complete) finish(new Error('the transfer stopped')); });
        res.resume();
        res.on('end', () => {
          if (done) return;
          if (res.statusCode === 200) return finish(null, hash.digest('hex'));
          req.destroy(); // refused before it took any of it
          finish(early(`HTTP ${res.statusCode}`));
        });
      });
      this._pinned(req, s.fp, () => {
        if (done) return;
        const rs = fs.createReadStream(path, { highWaterMark: READ_BYTES });
        w.rs = rs;
        rs.on('data', (b) => { if (done) return; hash.update(b); sent += b.length; onBytes(b.length); });
        rs.on('error', (e) => { req.destroy(); finish(e); });
        rs.pipe(req);
      }, to.plain);
    });
  }

  // As host: say file.pull, serve the guest's GET (request()).
  _offerPull(id, path, size, onBytes) {
    return new Promise((resolve, reject) => {
      const w = { path, size, onBytes, resolve, reject, sent: 0 };
      w.timer = setTimeout(() => this._fail(id, early('no pull')), PULL_MS);
      this.outgoing.set(id, w);
      try {
        if (this.o.send({ t: T.FILE_PULL, id }) === false) this._fail(id, early('control connection unavailable'));
      } catch (e) { this._fail(id, early(e.message)); }
    });
  }

  _serve(id, req, res) {
    const w = this.outgoing.get(id);
    if (!w || !w.path || w.res) {
      res.writeHead(404);
      return res.end();
    }
    clearTimeout(w.timer);
    w.res = res;
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(w.path, { highWaterMark: READ_BYTES });
    w.rs = rs;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': w.size });
    req.setTimeout(IDLE_MS, () => res.destroy());
    rs.on('data', (b) => { if (this.outgoing.get(id) !== w) return; hash.update(b); w.sent += b.length; w.onBytes(b.length); });
    rs.on('error', (e) => { if (this.outgoing.get(id) === w) this._fail(id, e); });
    res.on('error', (e) => { if (this.outgoing.get(id) === w) this._fail(id, e); });
    res.on('finish', () => {
      if (this.outgoing.get(id) !== w) return;
      this.outgoing.delete(id);
      rs.destroy();
      this._note('fx', 'send');
      w.resolve(hash.digest('hex'));
    });
    res.on('close', () => this.outgoing.get(id) === w && !res.writableFinished && this._fail(id, new Error('the transfer stopped')));
    rs.pipe(res);
  }

  _fail(id, err) {
    const w = this.outgoing.get(id);
    if (!w) return;
    if (w.fail) return w.fail(err); // a PUT
    this.outgoing.delete(id);
    clearTimeout(w.timer);
    if (w.rs) w.rs.destroy();
    if (w.res) w.res.destroy();
    if (err.early && !w.sent) { if (!this.broken) this._fellBack('fx', 'file.chunk', err.message); this.broken = true; }
    else delete err.early;
    w.reject(err);
  }

  // ---- receiving ----

  // Every message from the peer before the feature code sees it: true when it was ours (or waits).
  incoming(msg) {
    if (msg.t === T.FILE_CHUNK) { // the old way's bytes
      awake.touch();
      if (!this.last || this.last.way !== 'chunk' || this.last.dir !== 'recv') this._note('chunk', 'recv');
    }
    switch (msg.t) {
      case T.FILE_END: {
        const r2 = this.in2.get(msg.id);
        if (r2) {
          r2.end = msg;
          this._settle2(msg.id, r2);
          return true;
        }
        const r = this.arriving.get(msg.id);
        if (!r) return false;
        r.held = msg; // overtook the last bytes: delivered when they're in
        return true;
      }
      case T.FILE_PULL:
        if (msg.fx2) {
          if (msg.failed) this._fail2(msg.id, early('the other computer couldn’t fetch it'));
          else this._pull2(String(msg.id), Number(msg.size));
          return true;
        }
        if (msg.failed) this._fail(msg.id, early('the other computer couldn’t fetch it'));
        else this._pull(String(msg.id));
        return true;
      case T.FILE_CANCEL:
        this.cancel(msg.id);
        return false;
      default:
        return false;
    }
  }

  // Our server's HTTPS requests (plain: our plain server's): true when it was one of ours.
  request(req, res, plain = false) {
    if (!req.url.startsWith(PATH)) return false;
    const s = this.o.session();
    const token = !s || !s.host ? '' : plain ? (this.plainOn && s.plainToken) || '' : s.token;
    if (!token || !same(req.headers[HEADER], token)) {
      res.writeHead(403);
      res.end();
      return true;
    }
    let id;
    try { id = decodeURIComponent(req.url.slice(PATH.length)); } catch { id = ''; }
    if (!id || id.length > 100) {
      res.writeHead(400);
      res.end();
    } else if (req.method === 'GET') this._serve(id, req, res);
    else if (req.method === 'PUT') {
      req.setTimeout(IDLE_MS, () => req.destroy());
      this._receive(id, req, () => { res.writeHead(200); res.end(); });
    } else {
      res.writeHead(405);
      res.end();
    }
    return true;
  }

  // As guest: GET what the host offered.
  _pull(id) {
    const s = this.o.session();
    const failed = () => this.o.send({ t: T.FILE_PULL, id, failed: true });
    if (!s || s.host || !s.token) return failed();
    const r = this._track(id, null);
    // Not https.get: that sends the request (and the token) before the certificate is checked.
    const to = this._to(s);
    const req = to.mod.request({ host: s.address, port: to.port, method: 'GET', path: PATH + encodeURIComponent(id), agent: to.agent, headers: { [HEADER]: to.token } });
    r.stream = req;
    const fail = () => {
      if (this.arriving.get(id) !== r) return;
      if (r.seq === 0 && !r.size) { // nothing arrived: the host sends it the old way
        this._drop(id, true, false);
        return failed();
      }
      this._drop(id, true);
    };
    req.setTimeout(IDLE_MS, () => req.destroy(new Error('stalled')));
    req.on('error', fail);
    req.on('response', (res) => {
      if (this.arriving.get(id) !== r) return res.destroy();
      if (res.statusCode !== 200) {
        res.resume();
        return fail();
      }
      r.stream = res;
      this._receive(id, res, null, r);
      res.on('close', () => !res.complete && fail());
    });
    this._pinned(req, s.fp, () => { if (this.arriving.get(id) === r) req.end(); }, to.plain);
  }

  _track(id, stream) {
    this._drop(id, true, false);
    const r = { seq: 0, parts: [], size: 0, held: null, stream };
    this.arriving.set(id, r);
    return r;
  }

  // The body of a PUT or a GET's response, as file.chunk messages.
  _receive(id, stream, ok, r = this._track(id, stream)) {
    stream.on('data', (b) => {
      if (this.arriving.get(id) !== r) return;
      this._active();
      r.parts.push(b);
      r.size += b.length;
      if (r.size >= CHUNK_BYTES) this._flush(id, r);
    });
    stream.on('end', () => {
      if (this.arriving.get(id) !== r) return;
      this._flush(id, r);
      if (this.arriving.get(id) !== r) return;
      this._note('fx', 'recv');
      if (ok) ok();
      if (this.arriving.get(id) === r) this._drop(id, false);
    });
    stream.on('error', () => { if (this.arriving.get(id) === r) this._drop(id, true); });
    stream.on('close', () => this.arriving.get(id) === r && !stream.complete && this._drop(id, false));
  }

  _flush(id, r) {
    if (!r.size) return;
    const data = r.parts.length === 1 ? r.parts[0] : Buffer.concat(r.parts, r.size);
    r.parts = [];
    r.size = 0;
    this.o.deliver({ t: T.FILE_CHUNK, id, seq: r.seq++, data });
    if (r.paused || !r.stream || typeof r.stream.pause !== 'function') return;
    for (const fn of this.pressures) {
      let p = null;
      try { p = fn(id); } catch (_) { p = null; }
      if (!p || typeof p.then !== 'function') continue;
      const stream = r.stream;
      r.paused = true;
      stream.pause();
      const go = () => {
        r.paused = false;
        if (this.arriving.get(id) === r && r.stream === stream) stream.resume();
      };
      p.then(go, go);
      return;
    }
  }

  // Done with an incoming file: a waiting file.end goes on (complete or not: the receiver checks).
  _drop(id, destroy, deliverEnd = true) {
    const r = this.arriving.get(id);
    if (!r) return;
    this.arriving.delete(id);
    if (destroy && r.stream) r.stream.destroy();
    if (deliverEnd && r.held) this.o.deliver(r.held);
  }

  // Go on once the socket is the host's (its certificate's fingerprint is the one paired with).
  // Nothing is written before: the headers (and the token) go with the first write or end().
  // plain: plain HTTP (fxPlain), no certificate to pin: go at once.
  _pinned(req, fp, go, plain = false) {
    if (plain) return go();
    req.on('socket', (sock) => {
      const check = () => {
        const cert = sock.getPeerCertificate() || {};
        if (!fp || !cert.fingerprint256 || P.normFingerprint(cert.fingerprint256) !== fp) return req.destroy(early('not the paired computer'));
        go();
      };
      if ((sock.getPeerCertificate() || {}).fingerprint256) check(); // a kept-alive socket
      else sock.once('secureConnect', check);
    });
  }
}

// For receivers that write with a stream: a promise while more than `high` bytes wait in it.
function streamPressure(out, high = 8 * 1024 * 1024) {
  if (!out || out.destroyed || !(out.writableLength > high)) return null;
  return new Promise((resolve) => {
    const done = () => {
      out.removeListener('drain', done);
      out.removeListener('close', done);
      resolve();
    };
    out.once('drain', done);
    out.once('close', done);
  });
}

// Resolves true once a write stream is open (false: it failed or closed first).
function streamReady(out) {
  if (!out || out.destroyed) return Promise.resolve(false);
  if (!out.pending) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v) => () => {
      out.removeListener('ready', ok);
      out.removeListener('error', bad);
      out.removeListener('close', bad);
      resolve(v);
    };
    const ok = done(true);
    const bad = done(false);
    out.once('ready', ok);
    out.once('error', bad);
    out.once('close', bad);
  });
}

// A receiver's fx2 hook (FastFiles.receiver) from what it knows of its files: o.find(id) -> its file
// {tmp, size, got, seq, out?} while it waits for bytes, else null; o.open?(f) -> false when it
// can't create the file (one opened only with its first chunk); o.end(f) -> as file.end with a
// checksum that matches (f.verified is set: the hashes were checked by fastfile.js); o.fail(f, why);
// o.progress?(f, n).
function receiverHook(o) {
  const find = (id) => { try { return o.find(id) || null; } catch (_) { return null; } };
  return {
    async target(id, size) {
      const f = find(id);
      if (!f || f.fx2 || f.got || f.seq || Number(f.size) !== size || !f.tmp) return null;
      if (o.open && !o.open(f)) return null;
      if (f.out && !(await streamReady(f.out))) return null; // its own open goes first: the engine's doesn't truncate
      if (find(id) !== f || f.got || f.seq) return null;
      f.fx2 = true;
      return f.tmp;
    },
    untarget(id) {
      const f = find(id);
      if (f) f.fx2 = false;
    },
    progress(id, n) {
      const f = find(id);
      if (!f || !f.fx2) return;
      const add = Math.max(0, Math.min(n, Number(f.size) - f.got));
      f.got += add;
      if (o.progress && add) o.progress(f, add);
    },
    adopt(id) {
      const f = find(id);
      if (!f || !f.fx2) return;
      f.got = Number(f.size);
      f.verified = true;
      o.end(f);
    },
    fail(id, why) {
      const f = find(id);
      if (f) o.fail(f, why || 'transfer failed');
    },
  };
}

module.exports = { FastFiles, PARALLEL, streamPressure, streamReady, receiverHook };

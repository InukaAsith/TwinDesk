// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Fast files (one-to-one): the bytes of an accepted file go over HTTPS on the session's port, as a
// plain stream, instead of base64 file.chunk messages on the control socket. Nothing else changes:
// file.offer / accept / end / done / cancel go as before, and the receiving side gets the bytes as
// file.chunk messages (data a Buffer) from deliver(), so the receivers need only take a Buffer.
//
// Only when both apps said so (hello {fx: 1}, welcome {fx: token}, the token a secret of this
// session) and the session runs on the network or a cable, never through Bluetooth or a link
// netlink.js made (Wi-Fi Direct, a hotspot): those keep file.chunk. An older app never says so.
//
// The guest connects, as it does for the session: it PUTs what it sends, and GETs what the host
// sends when the host says file.pull. It pins the host's certificate as the session does; the host
// checks the token. file.end, which can overtake the last bytes of a GET, waits for them.
//
// Something wrong before any byte went (no answer, refused): the sender sends that file the old
// way and the rest of the session uses file.chunk.
'use strict';

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const P = require('./protocol.js');
const { GROUP_NETS } = require('./netlink.js');

const T = P.T;
const PATH = '/twindesk/fx/';
const HEADER = 'x-twindesk-fx';
const PARALLEL = 4; // files in flight at once
const READ_BYTES = 1024 * 1024; // read from disk at a time
const CHUNK_BYTES = 512 * 1024; // bytes per file.chunk handed to the receiver
const PULL_MS = 10000; // the guest didn't come for a file: it goes the old way
const IDLE_MS = 30000; // no bytes this long: the transfer failed

// No TLS session resumption: a resumed connection has no peer certificate to pin.
const agent = () => new https.Agent({ keepAlive: true, maxSockets: PARALLEL + 2, rejectUnauthorized: false, maxCachedSessions: 0 });
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
    this.arriving = new Map(); // id -> {seq, parts, size, held, stream}
    this.outgoing = new Map(); // id -> host: {path, size, onBytes, resolve, reject, timer, res?}; guest: {req}
    this.broken = false;
    this.agent = agent();
  }

  // Fast files for the next file: both sides can, on the network or a cable.
  usable() {
    const s = this.o.session();
    return !this.broken && !!s && !!s.token && s.transport !== 'ble' && !GROUP_NETS.some((p) => String(s.address || '').startsWith(p));
  }

  // How many files go at once.
  get parallel() {
    return this.usable() ? PARALLEL : 1;
  }

  // The session ended or another one started.
  reset() {
    this.broken = false;
    for (const id of [...this.arriving.keys()]) this._drop(id, true, false);
    for (const id of [...this.outgoing.keys()]) this._fail(id, new Error('the other computer disconnected'));
    this.agent.destroy();
    this.agent = agent();
  }

  // ---- sending ----

  // Sends an accepted file; resolves with its SHA-256 (send file.end then). Rejects with e.early
  // when nothing went. onBytes(n) as bytes go.
  send(id, path, size, onBytes) {
    if (this.outgoing.has(id)) return Promise.reject(new Error('file is already transferring'));
    const s = this.o.session();
    if (!s || !s.token) return Promise.reject(early('no fast files'));
    return s.host ? this._offerPull(id, path, size, onBytes) : this._put(s, id, path, size, onBytes);
  }

  // Stop sending or receiving this file (cancelled on either side).
  cancel(id) {
    this._fail(id, new Error('Cancelled'));
    this._drop(id, true, false);
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
        if (!err) return resolve(sha);
        if (err.early) this.broken = true;
        reject(err);
      };
      const req = https.request({
        host: s.address, port: s.port, method: 'PUT', path: PATH + encodeURIComponent(id), agent: this.agent,
        headers: { [HEADER]: s.token, 'content-type': 'application/octet-stream', 'content-length': size },
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
      });
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
    if (err.early && !w.sent) this.broken = true;
    else delete err.early;
    w.reject(err);
  }

  // ---- receiving ----

  // Every message from the peer before the feature code sees it: true when it was ours (or waits).
  incoming(msg) {
    switch (msg.t) {
      case T.FILE_END: {
        const r = this.arriving.get(msg.id);
        if (!r) return false;
        r.held = msg; // overtook the last bytes: delivered when they're in
        return true;
      }
      case T.FILE_PULL:
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

  // Our server's HTTPS requests: true when it was one of ours.
  request(req, res) {
    if (!req.url.startsWith(PATH)) return false;
    const s = this.o.session();
    if (!s || !s.host || !same(req.headers[HEADER], s.token)) {
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
    const req = https.request({ host: s.address, port: s.port, method: 'GET', path: PATH + encodeURIComponent(id), agent: this.agent, headers: { [HEADER]: s.token } });
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
    this._pinned(req, s.fp, () => { if (this.arriving.get(id) === r) req.end(); });
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
      r.parts.push(b);
      r.size += b.length;
      if (r.size >= CHUNK_BYTES) this._flush(id, r);
    });
    stream.on('end', () => {
      if (this.arriving.get(id) !== r) return;
      this._flush(id, r);
      if (this.arriving.get(id) !== r) return;
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
  _pinned(req, fp, go) {
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

module.exports = { FastFiles, PARALLEL };

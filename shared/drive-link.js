// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Drive over one session (docs/drive.md): shared/drive.js's engine on each side, this in
// between. Loaded only while Drive is on.
//
// Messages, on the session (an app without Drive ignores them, so it never starts):
//   drive.hello  either {v: 1}: Drive is on here. Each side answers once with its own.
//   drive.index  either {entries, last}: everything this side has, in parts, after both said hello.
//   drive.update either {entries}: what changed here since.
//   drive.want   host->guest {id, p, h}: send me this file (the guest PUTs it).
//   drive.gone   guest->host {id}: I don't have that version any more.
// The bytes go over HTTPS on the session's port, as fast files' do (shared/fastfile.js): the guest
// connects, pinning the host's certificate, and shows the session's fast-files token, which the host
// checks with the address the session came from. The guest GETs what it downloads and PUTs what the
// host asks for. Never through Bluetooth: there Drive waits until the session is on Wi-Fi or a cable.
//
// new DriveLink({drive, send, session, peerName, onChange})
//   send(msg); session(): {host, token, address, port?, fp?, transport} or null (an app without fast
//   files: Drive doesn't run with it); peerName().
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream');
const P = require('./protocol.js');

const T = P.T;
const PATH = '/twindesk/drive/';
const HEADER = 'x-twindesk-drive';
const PART = 1000; // entries per message
const PARALLEL = 4;
const WANT_MS = 60000; // a PUT the guest doesn't start by then: given up (tried again later)
const IDLE_MS = 30000;
const RETRY_MS = 30000;

const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const plainAddr = (a) => String(a || '').replace(/^::ffff:/, '');

class DriveLink {
  constructor({ drive, send, session, peerName = () => '', onChange = () => {} }) {
    Object.assign(this, { drive, sendFn: send, session, peerName, onChange });
    this.theyHello = false;
    this.saidHello = false;
    this.queue = []; // downloads to do
    this.active = 0;
    this.wants = new Map(); // id -> {pull, resolve, timer} (host: waiting for the guest's PUT)
    this.agent = null;
    this.retryTimer = null;
    this.moving = 0;
    this.onChanged = (entries) => this._update(entries);
    drive.on('changed', this.onChanged);
  }

  get ready() {
    const s = this.session();
    return this.theyHello && !!s && !!s.token && s.transport !== 'ble';
  }

  // ---- the session ----
  // A session started, or moved off Bluetooth: say Drive is on here.
  start() {
    this.saidHello = true;
    this.sendFn({ t: T.DRIVE_HELLO, v: 1 });
    if (this.theyHello) this._sendIndex();
  }

  // The session moved (off Bluetooth onto Wi-Fi or a cable): what waited goes now.
  kick() {
    if (!this.ready) return;
    this.sendFn({ t: T.DRIVE_HELLO, v: 1, again: true });
    this._sendIndex();
  }

  // The session ended: what was on its way waits for the next one.
  stop() {
    this.theyHello = false;
    this.saidHello = false;
    for (const p of this.queue) this.drive.release(p);
    this.queue = [];
    for (const [id, w] of this.wants) this._wantDone(id, w, false);
    clearTimeout(this.retryTimer);
    if (this.agent) this.agent.destroy();
    this.agent = null;
  }

  destroy() {
    this.stop();
    this.drive.removeListener('changed', this.onChanged);
  }

  // A session message: true when it was Drive's.
  onMessage(m) {
    if (!m || typeof m.t !== 'string' || !m.t.startsWith('drive.')) return false;
    if (m.t === T.DRIVE_HELLO) {
      const first = !this.theyHello;
      this.theyHello = true;
      if (!this.saidHello) this.start();
      else if (first || m.again) this._sendIndex(); // again: it missed something, everything once more
    } else if (!this.theyHello) {
      return true;
    } else if (m.t === T.DRIVE_INDEX || m.t === T.DRIVE_UPDATE) {
      this._merge(Array.isArray(m.entries) ? m.entries.slice(0, PART) : []);
    } else if (m.t === T.DRIVE_WANT) {
      this._put(m);
    } else if (m.t === T.DRIVE_GONE) {
      const w = this.wants.get(String(m.id));
      if (w) this._wantDone(String(m.id), w, false);
    }
    return true;
  }

  _send(m) {
    if (this.ready) this.sendFn(m);
  }

  _sendIndex() {
    if (!this.ready) return;
    const all = this.drive.entries();
    for (let i = 0; i < all.length || i === 0; i += PART) {
      this.sendFn({ t: T.DRIVE_INDEX, entries: all.slice(i, i + PART), last: i + PART >= all.length });
    }
  }

  _update(entries) {
    for (let i = 0; i < entries.length; i += PART) this._send({ t: T.DRIVE_UPDATE, entries: entries.slice(i, i + PART) });
  }

  async _merge(entries) {
    const pulls = await this.drive.merge(entries, this.peerName());
    if (!this.ready) { for (const p of pulls) this.drive.release(p); return; }
    this.queue.push(...pulls);
    this._next();
  }

  // ---- downloads ----
  _next() {
    while (this.active < PARALLEL && this.queue.length && this.ready) {
      const p = this.queue.shift();
      this.active++;
      this.moving++;
      this.onChange();
      const s = this.session();
      const done = (ok) => {
        this.active--;
        this.moving--;
        if (!ok) this._retryLater();
        this.onChange();
        this._next();
      };
      (s.host ? this._want(p) : this._get(p, s)).then(done, () => done(false));
    }
  }

  // Failures (the file changed there meanwhile, a dropped connection) come back with the next index.
  _retryLater() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.ready && this.sendFn({ t: T.DRIVE_HELLO, v: 1, again: true }), RETRY_MS);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  // As guest: GET it from the host.
  _get(pull, s) {
    return new Promise((resolve) => {
      const tmp = this.drive.tempPath();
      const out = fs.createWriteStream(tmp);
      const fail = () => { out.destroy(); fs.rm(tmp, { force: true }, () => {}); this.drive.release(pull); resolve(false); };
      const q = `p=${encodeURIComponent(pull.p)}&h=${pull.h}`;
      const req = this._request(s, 'GET', PATH + 'f?' + q);
      req.on('response', (res) => {
        if (res.statusCode !== 200) { res.resume(); return fail(); }
        res.setTimeout(IDLE_MS, () => res.destroy());
        pipeline(res, out, (err) => (err ? fail() : this.drive.adopt(pull, tmp).then(resolve, () => resolve(false))));
      });
      req.on('error', fail);
      req.setTimeout(IDLE_MS, () => req.destroy());
    });
  }

  // As host: ask the guest to PUT it here.
  _want(pull) {
    return new Promise((resolve) => {
      const id = crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => this._wantDone(id, this.wants.get(id), false), WANT_MS);
      this.wants.set(id, { pull, resolve, timer, started: false });
      this.sendFn({ t: T.DRIVE_WANT, id, p: pull.p, h: pull.h });
    });
  }

  _wantDone(id, w, ok) {
    if (!w || this.wants.get(id) !== w) return;
    this.wants.delete(id);
    clearTimeout(w.timer);
    if (!ok) this.drive.release(w.pull);
    w.resolve(ok);
  }

  // As guest: the host asked for a file: PUT it.
  async _put(m) {
    const id = String(m.id || '').slice(0, 32);
    const s = this.session();
    const src = s && !s.host ? await this.drive.open(m.p, String(m.h || '')) : null;
    if (!src) return this.sendFn({ t: T.DRIVE_GONE, id });
    const q = `id=${id}`;
    const req = this._request(s, 'PUT', PATH + 'u?' + q, { 'content-length': src.size });
    req.on('error', () => {});
    req.on('response', (res) => res.resume());
    req.setTimeout(IDLE_MS, () => req.destroy());
    this._pinnedThen(req, s, () => pipeline(fs.createReadStream(src.abs), req, () => {}));
  }

  // A request to the host, with the token, held until its certificate is the paired one's.
  _request(s, method, url, headers = {}) {
    if (!this.agent) this.agent = new https.Agent({ keepAlive: true, maxSockets: PARALLEL + 1, rejectUnauthorized: false, maxCachedSessions: 0 });
    const req = https.request({ host: s.address, port: s.port, method, path: url, agent: this.agent, headers: { [HEADER]: s.token, ...headers } });
    if (method === 'GET') this._pinnedThen(req, s, () => req.end());
    return req;
  }

  _pinnedThen(req, s, go) {
    req.on('socket', (sock) => {
      const check = () => {
        const cert = sock.getPeerCertificate() || {};
        if (!s.fp || !cert.fingerprint256 || P.normFingerprint(cert.fingerprint256) !== s.fp) return req.destroy(new Error('not the paired computer'));
        go();
      };
      if ((sock.getPeerCertificate() || {}).fingerprint256) check();
      else sock.once('secureConnect', check);
    });
  }

  // ---- the host's HTTPS ----
  // true when it was Drive's.
  request(req, res) {
    if (!req.url.startsWith(PATH)) return false;
    const s = this.session();
    const deny = (code) => { res.writeHead(code); res.end(); return true; };
    if (!s || !s.host || !s.token || !this.theyHello || !same(req.headers[HEADER], s.token)) return deny(403);
    if (s.address && plainAddr(req.socket.remoteAddress) !== plainAddr(s.address)) return deny(403);
    let u;
    try { u = new URL(req.url, 'https://x'); } catch { return deny(400); }
    const route = u.pathname.slice(PATH.length);
    if (req.method === 'GET' && route === 'f') {
      this.drive.open(u.searchParams.get('p') || '', u.searchParams.get('h') || '').then((src) => {
        if (!src) return deny(404);
        res.writeHead(200, { 'content-length': src.size, 'content-type': 'application/octet-stream' });
        pipeline(fs.createReadStream(src.abs), res, () => {});
      }, () => deny(500));
      return true;
    }
    if (req.method === 'PUT' && route === 'u') {
      const id = u.searchParams.get('id') || '';
      const w = this.wants.get(id);
      if (!w || w.started) return deny(404);
      w.started = true;
      clearTimeout(w.timer);
      const tmp = this.drive.tempPath();
      const out = fs.createWriteStream(tmp);
      req.setTimeout(IDLE_MS, () => req.destroy());
      pipeline(req, out, (err) => {
        if (err) {
          fs.rm(tmp, { force: true }, () => {});
          this._wantDone(id, w, false);
          return deny(500);
        }
        this.drive.adopt(w.pull, tmp).then((ok) => {
          this._wantDone(id, w, ok);
          deny(ok ? 200 : 409);
        }, () => { this._wantDone(id, w, false); deny(500); });
      });
      return true;
    }
    return deny(404);
  }

  status() {
    return { connected: this.ready, moving: this.moving + this.queue.length };
  }
}

module.exports = { DriveLink, PATH, HEADER };

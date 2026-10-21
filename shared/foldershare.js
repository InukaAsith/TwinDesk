// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Shared folders with a phone, both ways, for the Mac, PC and Linux apps (FolderShare.kt on the
// phone). Made by phonehub.js while a phone is connected; on USB, Wi-Fi or Wi-Fi Direct, never
// through Bluetooth: there the phone says it shares one (share.offer {on: false, wifi}), and Open
// moves the session onto Wi-Fi Direct first (wifi(true), netlink.js), kept up while it's mounted.
//   - The phone's folder here: the phone serves the folder chosen in TwinDesk there over WebDAV
//     with TLS (share.offer {on, port, secret, name, cert}: its certificate comes through the
//     session, so it's pinned) and this computer mounts it as the Mount page mounts the phone
//     (Finder, a drive letter, GVFS: phonedrive.js's mounter) through a proxy on 127.0.0.1 here,
//     as the file managers want plain http. To the phone's address, or through `adb forward` when
//     the session runs through the cable. No adb otherwise.
//   - This computer's folder on the phone: a small file server here over HTTPS with the session's
//     own certificate, which the phone pinned when it paired (the folder, nothing above it, a
//     secret token as the URL's first segment), that the phone shows in Android's Files app and
//     every app's file picker (share.host {on, port, token, name}). Through the cable the phone
//     reaches it with `adb reverse`.
// Each end takes connections only from the other's address in the session (the cable: 127.0.0.1),
// and nothing crosses the network unencrypted.
// settings (hub), both off until switched on: shareMount (mount the phone's folder when it shares
// one), shareServe (share this computer's folder), shareFolder ('' = default).
//
// Events: 'change' (view).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('./protocol.js');

const op = (url) => String(url).replace(/^\/[^/?]+/, '/…'); // a request, for the log: never the token
const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === 'localhost';
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');

class FolderShare extends EventEmitter {
  // hub: phonehub.js (settings, save, phone, server). mounter: phonedrive.js's for this system.
  // adb: the phone bridge's (run), only for a phone on the cable. serialOf(deviceId): its USB serial.
  // chooseFolder(): a folder picked here. defaultFolder: shared when none was chosen.
  // tls(): the session server's certificate and key ({key, cert} or {pfx, passphrase}).
  // wifi(on): through Bluetooth, Wi-Fi Direct for the folder (resolves true once the session is on
  // it) or not any more; none where this computer has no Bluetooth sessions.
  constructor(hub, { mounter, adb, serialOf, chooseFolder, defaultFolder, tls, wifi }) {
    super();
    Object.assign(this, { hub, mounter, adb, serialOf, chooseFolder, defaultFolder, tls, wifi });
    this.offerBle = ''; // the folder's name while the phone shares one and the session is on Bluetooth
    this.wantMount = false; // Open through Bluetooth: mounted when the offer comes on Wi-Fi
    this.proxy = null; // 127.0.0.1 -> the phone's WebDAV over TLS, while mounted
    // The phone's folder here
    this.offer = null; // {port, secret, name} while the phone shares one
    this.mountPath = '';
    this.mountPort = 0; // the port as this computer reaches it (adb forward's through the cable)
    this.mountHost = '';
    this.busy = '';
    this.message = '';
    // This computer's folder on the phone
    this.server = null;
    this.port = 0;
    this.token = crypto.randomBytes(16).toString('hex');
    this.serveError = '';
    this.timer = setInterval(() => this._watch(), 5000);
  }

  get settings() {
    return this.hub.settings;
  }

  get folder() {
    return this.settings.shareFolder || this.defaultFolder;
  }

  _ctx() {
    const c = this.hub.phone;
    return c && c.transport !== 'ble' ? c : null;
  }

  // ---- the session ----

  // A phone's session started, or moved (Bluetooth <-> Wi-Fi): the offers again.
  started() {
    this.host();
  }

  async stopped() {
    this.offer = null;
    this.offerBle = '';
    this.wantMount = false;
    await this.unmount('');
    this._proxy(null);
    this._serve(false);
    this.emit('change');
  }

  stop() {
    clearInterval(this.timer);
    if (this.mountPath) {
      try { this.mounter.unmountSync(this.mountPath); } catch {}
    }
    this._serve(false);
    this._proxy(null);
  }

  // From the phone: {on, port, secret, name, cert (its certificate, DER in base64)}.
  onOffer(m) {
    const cert = str(m && m.cert, 8000);
    const ok = m && m.on && Number.isInteger(m.port) && m.port > 0 && m.port < 65536 && /^[a-f0-9]{16,64}$/.test(String(m.secret || '')) && /^[A-Za-z0-9+/=]{100,}$/.test(cert);
    const was = this.offer;
    this.offerBle = m && !m.on && m.wifi ? this._volume(str(m.name, 80)) : '';
    this.offer = ok ? { port: m.port, secret: m.secret, name: this._volume(str(m.name, 80)), cert: `-----BEGIN CERTIFICATE-----\n${cert.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n` } : null;
    const same = was && this.offer && was.port === this.offer.port && was.secret === this.offer.secret && was.cert === this.offer.cert;
    if (!this.offer || !same) this.unmount('').then(() => this._auto());
    else this._auto();
    this.emit('change');
  }

  _volume(name) {
    return name.replace(/[/:\\"<>|?*%#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Phone';
  }

  _auto() {
    if (this.offer && this.wantMount && !this.mountPath && !this.busy && this._ctx()) return this.mount();
    if (this.offer && this.settings.shareMount && !this.mountPath && !this.busy && this._ctx()) this.mount();
  }

  // Cable in or out moves the session (a new address): the phone sends its offer again then; this
  // only notices a volume ejected in the file manager.
  async _watch() {
    if (!this.mountPath || this.busy) return;
    if (!(await this.mounter.mountedAt(this.mountPort, this.mountHost))) {
      this.mountPath = '';
      this.message = '';
      if (this.wifi) this.wifi(false);
      this.emit('change');
    }
  }

  // ---- the phone's folder here ----

  async mount() {
    if (this.busy) return;
    if (this.mountPath) return this.reveal();
    const c = this.hub.phone;
    if (c && c.transport === 'ble' && this.offerBle && this.wifi) {
      // Wi-Fi Direct first: the phone offers it again there, and _auto mounts it then.
      this.wantMount = true;
      this._set('wifi', '');
      const ok = await this.wifi(true);
      this._set('', ok ? '' : 'Wi-Fi Direct with the phone didn’t come up');
      if (!ok) this.wantMount = false;
      return this._auto();
    }
    const ctx = this._ctx();
    if (!this.offer || !ctx) return;
    this.wantMount = false;
    this._set('mounting', '');
    try {
      let host = ctx.address;
      let port = this.offer.port;
      if (isLoopback(host)) { // through the cable
        const serial = this.serialOf && this.serialOf(ctx.deviceId);
        if (!serial || !this.adb) throw new Error('the phone is on the cable, but adb can’t reach it');
        const r = await this.adb.run(['-s', serial, 'forward', 'tcp:0', `tcp:${port}`], { timeout: 5000 });
        port = Number(String(r.out).trim());
        if (!port) throw new Error(`adb forward: ${String(r.err || r.out).trim()}`);
        host = '127.0.0.1';
      }
      const { secret, name, cert } = this.offer;
      const local = await this._proxy({ host, port, cert });
      const url = `http://127.0.0.1:${local}/${secret}/${encodeURIComponent(name)}`;
      this.mountHost = '127.0.0.1';
      this.mountPort = local;
      this.mountPath = await this.mounter.mount(url, { user: 'twindesk', password: secret, port: local, host: '127.0.0.1', volume: name });
      this._set('', '');
      this.reveal();
    } catch (e) {
      this._set('', `Couldn’t open it: ${String(e.message).split('\n')[0]}`);
      if (this.wifi) this.wifi(false);
    }
  }

  async unmount(message = '') {
    const at = this.mountPath;
    if (!at) return;
    this._set('unmounting', '');
    await this.mounter.unmount(at).catch(() => {});
    this.mountPath = '';
    this._proxy(null);
    if (this.wifi) this.wifi(false);
    this._set('', message);
  }

  // The file manager's plain http on 127.0.0.1 here, to the phone over TLS, its certificate pinned
  // (the one that came through the session: nothing else is trusted, whatever its name). Resolves
  // to the local port. null: closed.
  _proxy(to) {
    if (this.proxy) { this.proxy.server.close(); this.proxy.agent.destroy(); this.proxy = null; }
    if (!to) return Promise.resolve(0);
    const agent = new https.Agent({ keepAlive: true, maxSockets: 8, ca: to.cert, checkServerIdentity: () => undefined });
    const srv = http.createServer((req, res) => {
      const headers = { ...req.headers, host: `${to.host}:${to.port}` };
      if (headers.destination) {
        try { const u = new URL(headers.destination, 'http://127.0.0.1'); headers.destination = u.pathname; } catch { delete headers.destination; }
      }
      const up = https.request({ host: to.host, port: to.port, method: req.method, path: req.url, headers, agent }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', (e) => {
        console.log(`[share] ${req.method} ${req.url.replace(/^\/[^/]+/, '/…')}: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { 'Content-Length': 0 });
        res.end();
      });
      res.on('close', () => { if (!res.writableFinished) up.destroy(); });
      req.pipe(up);
    });
    srv.keepAliveTimeout = 30000;
    this.proxy = { server: srv, agent };
    return new Promise((resolve, reject) => {
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
    });
  }

  reveal() {
    if (this.mountPath) this.mounter.reveal(this.mountPath);
  }

  _set(busy, message) {
    this.busy = busy;
    this.message = message;
    this.emit('change');
  }

  // ---- this computer's folder on the phone ----

  // Tell the phone (again): on with where, or off.
  async host() {
    const ctx = this._ctx();
    const want = !!(this.settings.shareServe && ctx);
    if (!want) {
      if (this.hub.phone) this.hub.server.sendToClient({ t: P.T.SHARE_HOST, on: false, serve: !!this.settings.shareServe });
      return this._serve(false);
    }
    try {
      fs.mkdirSync(this.folder, { recursive: true });
      await this._serve(true);
      let port = this.port;
      if (isLoopback(ctx.address)) { // through the cable: the phone's 127.0.0.1:<port> is ours
        const serial = this.serialOf && this.serialOf(ctx.deviceId);
        const r = serial && this.adb ? await this.adb.run(['-s', serial, 'reverse', `tcp:${port}`, `tcp:${this.port}`], { timeout: 5000 }) : null;
        if (!r || r.err) throw new Error('adb reverse didn’t work through the cable');
        port = this.port;
      }
      this.serveError = '';
      this.hub.server.sendToClient({ t: P.T.SHARE_HOST, on: true, serve: true, port, token: this.token, name: `${path.basename(this.folder)} on ${os.hostname().replace(/\.local$/, '')}`.slice(0, 80) });
    } catch (e) {
      this.serveError = String(e.message).split('\n')[0];
      this.hub.server.sendToClient({ t: P.T.SHARE_HOST, on: false, serve: true });
    }
    this.emit('change');
  }

  _serve(on) {
    if (!on) {
      if (this.server) this.server.close();
      this.server = null;
      this.port = 0;
      return Promise.resolve();
    }
    if (this.server) return Promise.resolve();
    const tls = this.tls && this.tls();
    if (!tls) return Promise.reject(new Error('no certificate yet'));
    return new Promise((resolve, reject) => {
      const srv = https.createServer(tls, (req, res) => this._handle(req, res).catch((e) => {
        console.log(`[share] ${req.method} ${op(req.url)}: ${e.message}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }));
      // Only the phone in the session (the cable: adb reverse, from 127.0.0.1), before TLS even starts.
      srv.on('connection', (sock) => { if (!this._allowed(sock.remoteAddress)) sock.destroy(); });
      srv.keepAliveTimeout = 30000;
      srv.on('error', reject);
      srv.listen(0, '0.0.0.0', () => {
        this.server = srv;
        this.port = srv.address().port;
        resolve();
      });
    });
  }

  _allowed(address) {
    const ctx = this._ctx();
    const a = String(address || '').replace(/^::ffff:/, '');
    return !!ctx && !!a && a === String(ctx.address || '').replace(/^::ffff:/, '');
  }

  // A path the phone sent, inside the folder (null when it isn't). By its real path: a link inside
  // the folder that points out of it is outside. One that doesn't exist yet (a new file or
  // folder) goes by its parent's.
  async _local(rel) {
    const fsp = fs.promises;
    const root = await fsp.realpath(path.resolve(this.folder)).catch(() => null);
    if (!root) return null;
    const parts = String(rel || '').split('/').filter((p) => p && p !== '.');
    if (parts.some((p) => p === '..' || /[\u0000-\u001f\\]/.test(p))) return null;
    const inside = (p) => p === root || p.startsWith(root + path.sep);
    const p = path.join(root, ...parts);
    const real = await fsp.realpath(p).catch((e) => (e.code === 'ENOENT' ? null : undefined));
    if (real === undefined) return null;
    if (real) return inside(real) ? real : null;
    const parent = await fsp.realpath(path.dirname(p)).catch(() => null);
    return parent && inside(parent) ? path.join(parent, path.basename(p)) : null;
  }

  // /<token>/<op>?p=<path>[&name=]: list, stat, file (GET, PUT), mkdir, delete, rename.
  async _handle(req, res) {
    const u = new URL(req.url, 'http://x');
    const [token, op] = u.pathname.split('/').filter(Boolean);
    const done = (code, body = '', type = 'application/json') => {
      req.resume();
      res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    if (!this._allowed(req.socket.remoteAddress)) return req.socket.destroy(); // kept alive from before the session moved
    if (token !== this.token || !this.settings.shareServe) return done(404);
    const p = await this._local(u.searchParams.get('p'));
    if (!p) return done(400);
    const root = await fs.promises.realpath(path.resolve(this.folder));
    const entry = (f, st) => ({ name: path.basename(f), dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: Math.floor(st.mtimeMs) });
    const fsp = fs.promises;
    switch (`${req.method} ${op}`) {
      case 'GET list': {
        const names = await fsp.readdir(p).catch(() => null);
        if (!names) return done(404);
        const items = [];
        for (const n of names) {
          if (n === '.DS_Store' || n.startsWith('._') || /^(desktop\.ini|Thumbs\.db)$/i.test(n)) continue;
          const real = await fsp.realpath(path.join(p, n)).catch(() => '');
          if (!real || !(real === root || real.startsWith(root + path.sep))) continue; // a link out of the folder
          const st = await fsp.stat(real).catch(() => null);
          if (st && (st.isDirectory() || st.isFile())) items.push(entry(path.join(p, n), st));
        }
        let free = 0;
        try { const s = await fsp.statfs(p); free = s.bavail * s.bsize; } catch {}
        return done(200, JSON.stringify({ items, free }));
      }
      case 'GET stat': {
        const st = await fsp.stat(p).catch(() => null);
        return st ? done(200, JSON.stringify(entry(p, st))) : done(404);
      }
      case 'GET file':
      case 'HEAD file': {
        const st = await fsp.stat(p).catch(() => null);
        if (!st || !st.isFile()) return done(404);
        let start = 0;
        let end = st.size - 1;
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (range && st.size) {
          if (range[1]) start = Number(range[1]);
          if (range[2]) end = range[1] ? Math.min(Number(range[2]), end) : st.size - 1;
          if (!range[1] && range[2]) start = Math.max(0, st.size - Number(range[2]));
          if (start > end) return done(416);
        }
        const len = st.size ? end - start + 1 : 0;
        res.writeHead(range && st.size ? 206 : 200, {
          'Content-Type': 'application/octet-stream', 'Content-Length': len, 'Accept-Ranges': 'bytes',
          ...(range && st.size ? { 'Content-Range': `bytes ${start}-${end}/${st.size}` } : {}),
        });
        if (req.method === 'HEAD' || !len) return res.end();
        const s = fs.createReadStream(p, { start, end });
        s.on('error', () => res.destroy());
        res.on('close', () => s.destroy());
        return s.pipe(res);
      }
      case 'PUT file': {
        const tmp = `${p}.twindesk-part`;
        const ok = await new Promise((resolve) => {
          const out = fs.createWriteStream(tmp);
          out.on('error', () => resolve(false));
          out.on('finish', () => resolve(true));
          req.on('aborted', () => { out.destroy(); resolve(false); });
          req.pipe(out);
        });
        if (!ok) { fs.rm(tmp, { force: true }, () => {}); return done(409); }
        await fsp.rename(tmp, p);
        return done(201, JSON.stringify(entry(p, await fsp.stat(p))));
      }
      case 'POST mkdir':
        await fsp.mkdir(p);
        return done(201, JSON.stringify(entry(p, await fsp.stat(p))));
      case 'POST delete':
        if (p === root) return done(403);
        await fsp.rm(p, { recursive: true, force: true });
        return done(204);
      case 'POST rename': {
        const name = str(u.searchParams.get('name'), 255);
        if (!name || /[/\\\u0000-\u001f]/.test(name) || name === '.' || name === '..' || p === root) return done(400);
        const to = path.join(path.dirname(p), name);
        if (fs.existsSync(to)) return done(412);
        await fsp.rename(p, to);
        return done(200, JSON.stringify(entry(to, await fsp.stat(to))));
      }
      default:
        return done(405);
    }
  }

  // ---- from the window: {a: 'mount'|'unmount'|'open'|'choose'|'default', on?} ----

  async act(a, r = {}) {
    const s = this.settings;
    if (a === 'mount' || a === 'open') return this.mount();
    if (a === 'unmount') return this.unmount('');
    if (a === 'auto') {
      s.shareMount = !!r.on;
      this.hub.save();
      if (s.shareMount) this._auto(); else await this.unmount('');
    } else if (a === 'serve') {
      s.shareServe = !!r.on;
      this.hub.save();
      await this.host();
    } else if (a === 'choose' && this.chooseFolder) {
      const f = await this.chooseFolder();
      if (!f) return;
      s.shareFolder = f;
      this.hub.save();
      await this.host();
    } else if (a === 'default') {
      s.shareFolder = '';
      this.hub.save();
      await this.host();
    }
    this.emit('change');
  }

  get view() {
    return {
      phone: { offered: !!(this.offer || this.offerBle), name: this.offer ? this.offer.name : this.offerBle, wifi: !this.offer && !!this.offerBle && !!this.wifi, mounted: this.mountPath, busy: this.busy, message: this.message, auto: !!this.settings.shareMount },
      mine: { on: !!this.settings.shareServe, folder: this.folder, error: this.serveError, serving: !!this.server && !!this._ctx() },
    };
  }
}

module.exports = { FolderShare };

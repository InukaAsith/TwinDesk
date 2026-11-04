// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume's live documents (shared/rezume.js, setting `live`): the file itself, opened on the other
// computer and saved back here, instead of a copy. Between two computers only.
//   Sharing (here): share(path) serves that one file over WebDAV with TLS, the session's own
//   certificate (tls()), under a secret token as the URL's first segment. The volume shows only that
//   file and the files the app makes next to it while it saves (Word's ~$ lock file, its temporary
//   copy that is renamed over the original); nothing else of its folder is listed, read or written.
//   The system's own files (.DS_Store, ._*, desktop.ini, Thumbs.db) stay in memory. Everything shared
//   is stopped when the session ends (stop()).
//   Mounting (there): mount(info) reaches the first of the sharing computer's addresses that answers
//   with the certificate that came through the session (pinned: nothing else is trusted), puts a
//   plain-http proxy on 127.0.0.1 in front of it (the system's WebDAV clients want plain http) and
//   mounts that as phonedrive.js's mounter does (Finder, a drive letter through WebClient, GVFS).
//   Resolves to the file's path in the mounted volume. At most MAX_MOUNTS at once (the oldest goes);
//   all are unmounted with stop() and at shutdown.
// info (rz.done live): {port, token, volume, file, cert (DER, base64), hosts: [address]}
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const MAX_SHARES = 8;
const MAX_MOUNTS = 3;
const SIDECAR = /^(\.DS_Store|\._.*|desktop\.ini|Thumbs\.db|ehthumbs(_vista)?\.db|\.directory)$/i;
const HIDE = /^(\.metadata_never_index.*|\.Spotlight-V100|\.Trashes|\.fseventsd|\.hidden|\.localized|\.ql_disable.*|\.VolumeIcon\.icns|\.com\.apple\..*|\.TemporaryItems|\$RECYCLE\.BIN|System Volume Information|autorun\.inf|\.Trash(-\d+)?)$/i;
const TYPES = { pdf: 'application/pdf', txt: 'text/plain', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', mp3: 'audio/mpeg', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const typeOf = (name) => TYPES[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';
const okName = (n) => typeof n === 'string' && n.length > 0 && n.length <= 255 && n !== '.' && n !== '..' && !/[/\\\u0000]/.test(n);
// A volume's name: the document's, without what the file systems refuse.
const volumeOf = (file) => (path.parse(file).name.replace(/[\\/:*?"<>|#%\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Document') + ' (ReZume)';

// The certificate of a TLS context ({key, cert} or {pfx, passphrase}), DER.
function certDer(opts) {
  if (opts.cert) return new crypto.X509Certificate(opts.cert).raw;
  const sock = new tls.TLSSocket(null, { secureContext: tls.createSecureContext(opts) });
  const c = sock.getCertificate();
  sock.destroy();
  return c && c.raw;
}

// This computer's addresses the other one may reach (IPv4, not loopback).
function addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  }
  return out.slice(0, 8);
}

class LiveShare {
  // tls() → the session server's {key, cert} | {pfx, passphrase}; mounter: phonedrive.js's
  constructor({ tls: tlsOf, mounter }) {
    this.tlsOf = tlsOf;
    this.mounter = mounter || null;
    this.server = null;
    this.port = 0;
    this.shares = new Map(); // token → {dir, file, volume, made: Set(name), sidecars: Map(name → {data, mtime}), at}
    this.mounts = []; // [{at, proxy, agent, token}]
  }

  // ---- sharing ----

  async share(file) {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('Only a file can be shared');
    const opts = this.tlsOf && this.tlsOf();
    if (!opts) throw new Error('This computer has no certificate to share with yet');
    await this._listen(opts);
    for (const [k, s] of this.shares) if (s.dir === path.dirname(file) && s.file === path.basename(file)) this.shares.delete(k); // the same file again: one share
    if (this.shares.size >= MAX_SHARES) this.shares.delete(this.shares.keys().next().value);
    const token = crypto.randomBytes(16).toString('hex');
    const s = { dir: path.dirname(file), file: path.basename(file), volume: volumeOf(file), made: new Set(), sidecars: new Map(), at: Date.now() };
    this.shares.set(token, s);
    return { port: this.port, token, volume: s.volume, file: s.file, cert: Buffer.from(certDer(opts)).toString('base64'), hosts: addresses() };
  }

  _listen(opts) {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const srv = https.createServer(opts, (req, res) => this._handle(req, res).catch((e) => {
        console.log(`[rzlive] ${req.method}: ${e.message}`);
        if (!res.headersSent) res.writeHead(500, { 'Content-Length': 0 });
        res.end();
      }));
      srv.keepAliveTimeout = 30000;
      srv.on('error', reject);
      srv.listen(0, '0.0.0.0', () => {
        this.server = srv;
        this.port = srv.address().port;
        resolve();
      });
    });
  }

  // URL path → {token, s, name} (name '' for the volume itself), {above} for '/' and '/<token>', or null.
  _where(url) {
    let p = '';
    try { p = decodeURIComponent(String(url).split('?')[0]); } catch (_) { return null; }
    const segs = p.split('/').filter(Boolean);
    if (!segs.length) return { above: true };
    const s = this.shares.get(segs[0]);
    if (!s) return null;
    if (segs.length === 1) return { above: true, token: segs[0] };
    if (segs[1] !== s.volume || segs.length > 3) return null;
    const name = segs[2] || '';
    if (name && !okName(name)) return null;
    return { token: segs[0], s, name };
  }

  // Whether a name is part of the volume: the file, or one the app made through it.
  _ours(s, name) {
    return name === s.file || s.made.has(name) || s.sidecars.has(name);
  }

  _stat(s, name) {
    if (!name) return { dir: true, size: 0, mtime: s.at, name: s.volume };
    const sc = s.sidecars.get(name);
    if (sc) return { dir: false, size: sc.data.length, mtime: sc.mtime, name };
    if (!this._ours(s, name)) return null;
    try {
      const st = fs.statSync(path.join(s.dir, name));
      return st.isFile() ? { dir: false, size: st.size, mtime: st.mtimeMs, name } : null;
    } catch (_) { return null; }
  }

  _href(token, s, name) {
    return '/' + [token, s.volume, name].filter(Boolean).map(encodeURIComponent).join('/') + (name ? '' : '/');
  }

  _entry(href, st) {
    const d = new Date(st.mtime || Date.now());
    return `<D:response><D:href>${xml(href)}</D:href><D:propstat><D:prop>`
      + `<D:displayname>${xml(st.name)}</D:displayname>`
      + `<D:resourcetype>${st.dir ? '<D:collection/>' : ''}</D:resourcetype>`
      + (st.dir ? '' : `<D:getcontentlength>${st.size}</D:getcontentlength><D:getcontenttype>${typeOf(st.name)}</D:getcontenttype>`)
      + `<D:getlastmodified>${d.toUTCString()}</D:getlastmodified><D:creationdate>${d.toISOString()}</D:creationdate>`
      + `<D:getetag>"${st.size.toString(16)}-${Math.floor(st.mtime / 1000).toString(16)}"</D:getetag>`
      + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
  }

  async _handle(req, res) {
    const done = (code, headers = {}, body = '') => {
      req.resume();
      res.writeHead(code, { 'Content-Length': Buffer.byteLength(body), ...headers });
      res.end(body);
    };
    const multistatus = (body) => done(207, { 'Content-Type': 'application/xml; charset=utf-8' }, `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`);
    if (req.method === 'OPTIONS') return done(200, { DAV: '1, 2', 'MS-Author-Via': 'DAV', Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, COPY, MOVE, LOCK, UNLOCK' });
    const w = this._where(req.url);
    if (!w) return done(404);
    // '/' and '/<token>': empty folders (Windows looks at them while mapping the drive), only with a valid token.
    if (w.above) {
      if (!w.token) return done(404);
      if (req.method !== 'PROPFIND') return done(req.method === 'GET' || req.method === 'HEAD' ? 200 : 405);
      return multistatus(this._entry(`/${w.token}/`, { dir: true, size: 0, mtime: Date.now(), name: w.token }));
    }
    const { token, s, name } = w;
    const file = name ? path.join(s.dir, name) : '';
    if (name && HIDE.test(name)) return done(404);

    switch (req.method) {
      case 'PROPFIND': {
        const st = this._stat(s, name);
        if (!st) return done(404);
        let body = this._entry(this._href(token, s, name), st);
        if (st.dir && req.headers.depth !== '0') {
          for (const n of new Set([s.file, ...s.made, ...s.sidecars.keys()])) {
            const e = this._stat(s, n);
            if (e) body += this._entry(this._href(token, s, n), e);
          }
        }
        return multistatus(body);
      }
      case 'PROPPATCH':
        return multistatus(`<D:response><D:href>${xml(this._href(token, s, name))}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
      case 'LOCK': {
        const lock = `opaquelocktoken:${crypto.randomUUID()}`;
        return done(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${lock}>` },
          `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth><D:timeout>Second-600</D:timeout><D:locktoken><D:href>${lock}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`);
      }
      case 'UNLOCK':
        return done(204);
      case 'MKCOL':
        return done(403);
      case 'GET':
      case 'HEAD': {
        const st = this._stat(s, name);
        if (!st) return done(404);
        if (st.dir) return done(200, { 'Content-Type': 'text/plain' });
        const headers = { 'Content-Type': typeOf(name), 'Last-Modified': new Date(st.mtime).toUTCString(), 'Accept-Ranges': 'bytes' };
        let start = 0;
        let end = st.size - 1;
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (range && st.size) {
          if (range[1]) start = Number(range[1]);
          if (range[2]) end = range[1] ? Math.min(Number(range[2]), end) : st.size - 1;
          if (!range[1] && range[2]) start = Math.max(0, st.size - Number(range[2]));
          if (start > end) return done(416, { 'Content-Range': `bytes */${st.size}` });
          headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
        }
        const len = st.size ? end - start + 1 : 0;
        res.writeHead(range && st.size ? 206 : 200, { ...headers, 'Content-Length': len });
        if (req.method === 'HEAD' || !len) return res.end();
        const sc = s.sidecars.get(name);
        if (sc) return res.end(sc.data.subarray(start, end + 1));
        const rs = fs.createReadStream(file, { start, end });
        rs.on('error', () => res.destroy());
        rs.pipe(res);
        return undefined;
      }
      case 'PUT': {
        if (!name) return done(405);
        if (SIDECAR.test(name)) {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          s.sidecars.set(name, { data: Buffer.concat(chunks), mtime: Date.now() });
          return done(201);
        }
        // A new name next to the file is the app's own (a lock or a temporary copy), never one that
        // is already in the folder and wasn't shared.
        const isNew = !this._ours(s, name);
        if (isNew && fs.existsSync(file)) return done(403);
        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(file);
          ws.on('error', reject);
          ws.on('finish', resolve);
          req.on('aborted', () => ws.destroy(new Error('aborted')));
          req.pipe(ws);
        });
        if (isNew) s.made.add(name);
        return done(isNew ? 201 : 204);
      }
      case 'DELETE': {
        if (!name) return done(403);
        if (s.sidecars.delete(name)) return done(204);
        if (!this._ours(s, name)) return done(404);
        try { fs.unlinkSync(file); } catch (_) { return done(409); }
        s.made.delete(name);
        return done(204);
      }
      case 'MOVE':
      case 'COPY': {
        let dest = null;
        try { dest = this._where(new URL(String(req.headers.destination || ''), 'http://127.0.0.1').pathname); } catch (_) { dest = null; }
        if (!name || !dest || dest.above || dest.s !== s || !dest.name) return done(400);
        if (!this._ours(s, name)) return done(404);
        const to = path.join(s.dir, dest.name);
        const exists = this._ours(s, dest.name) && fs.existsSync(to);
        if (!this._ours(s, dest.name) && fs.existsSync(to)) return done(403); // never over a file that wasn't shared
        if (exists && String(req.headers.overwrite || 'T').toUpperCase() === 'F') return done(412);
        const sc = s.sidecars.get(name);
        if (sc) {
          s.sidecars.set(dest.name, { ...sc });
          if (req.method === 'MOVE') s.sidecars.delete(name);
          return done(201);
        }
        try {
          if (req.method === 'MOVE') fs.renameSync(file, to);
          else fs.copyFileSync(file, to);
        } catch (_) { return done(409); }
        if (dest.name !== s.file) s.made.add(dest.name);
        if (req.method === 'MOVE' && name !== s.file) s.made.delete(name);
        return done(exists ? 204 : 201);
      }
      default:
        return done(405);
    }
  }

  // ---- mounting ----

  async mount(info) {
    if (!this.mounter) throw new Error('Files can’t be opened in place on this computer');
    const ok = info && Number.isInteger(info.port) && info.port > 0 && info.port < 65536 && /^[a-f0-9]{32}$/.test(String(info.token || ''))
      && okName(info.file) && typeof info.volume === 'string' && okName(info.volume) && /^[A-Za-z0-9+/=]{100,8000}$/.test(String(info.cert || '')) && Array.isArray(info.hosts);
    if (!ok) throw new Error('The shared file could not be opened');
    const cert = `-----BEGIN CERTIFICATE-----\n${info.cert.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
    const host = await this._reach(info.hosts.filter((h) => typeof h === 'string' && net.isIPv4(h)).slice(0, 8), info.port, cert);
    if (!host) throw new Error('The other computer could not be reached over the network');
    while (this.mounts.length >= MAX_MOUNTS) await this._unmount(this.mounts[0]);
    const m = { at: '', token: info.token };
    const local = await this._proxy(m, { host, port: info.port, cert });
    const url = `http://127.0.0.1:${local}/${encodeURIComponent(info.token)}/${encodeURIComponent(info.volume)}`;
    try {
      m.at = await this.mounter.mount(url, { user: 'twindesk', password: crypto.randomBytes(12).toString('hex'), port: local, volume: info.volume, host: '127.0.0.1' });
    } catch (e) {
      this._closeProxy(m);
      throw e;
    }
    this.mounts.push(m);
    const p = /^[A-Z]:$/i.test(m.at) ? `${m.at}\\${info.file}` : path.join(m.at, info.file);
    console.log(`[rzlive] mounted ${info.volume}`);
    return p;
  }

  // The first address that answers with the pinned certificate.
  _reach(hosts, port, cert) {
    return new Promise((resolve) => {
      let left = hosts.length;
      let won = false;
      if (!left) return resolve('');
      for (const host of hosts) {
        const sock = tls.connect({ host, port, ca: cert, checkServerIdentity: () => undefined, timeout: 3000 }, () => {
          sock.destroy();
          if (!won) { won = true; resolve(host); }
        });
        const fail = () => { sock.destroy(); if (--left === 0 && !won) resolve(''); };
        sock.on('error', fail);
        sock.on('timeout', fail);
      }
    });
  }

  // Plain http on 127.0.0.1 here, to the other computer over TLS with its certificate pinned.
  _proxy(m, to) {
    const agent = new https.Agent({ keepAlive: true, maxSockets: 8, ca: to.cert, checkServerIdentity: () => undefined });
    const srv = http.createServer((req, res) => {
      const headers = { ...req.headers, host: `${to.host}:${to.port}` };
      delete headers.authorization; // Finder's (the token in the path is what counts)
      if (headers.destination) {
        try { headers.destination = new URL(headers.destination, 'http://127.0.0.1').pathname; } catch (_) { delete headers.destination; }
      }
      const up = https.request({ host: to.host, port: to.port, method: req.method, path: req.url, headers, agent }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Length': 0 });
        res.end();
      });
      res.on('close', () => { if (!res.writableFinished) up.destroy(); });
      req.pipe(up);
    });
    srv.keepAliveTimeout = 30000;
    m.proxy = srv;
    m.agent = agent;
    return new Promise((resolve, reject) => {
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
    });
  }

  _closeProxy(m) {
    if (m.proxy) m.proxy.close();
    if (m.agent) m.agent.destroy();
    m.proxy = m.agent = null;
  }

  async _unmount(m) {
    this.mounts = this.mounts.filter((x) => x !== m);
    if (m.at) await this.mounter.unmount(m.at).catch(() => {});
    this._closeProxy(m);
  }

  // The session ended: what we shared stops, what was mounted here goes.
  stop() {
    this.shares.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = 0;
    }
    for (const m of [...this.mounts]) this._unmount(m).catch(() => {});
  }

  // Quit: unmounted before the proxies go (a WebDAV volume without its server hangs the file manager).
  shutdown() {
    for (const m of this.mounts) {
      try { if (m.at) this.mounter.unmountSync(m.at); } catch (_) { /* already gone */ }
      this._closeProxy(m);
    }
    this.mounts = [];
    this.shares.clear();
    if (this.server) this.server.close();
    this.server = null;
  }
}

module.exports = { LiveShare, volumeOf, addresses };

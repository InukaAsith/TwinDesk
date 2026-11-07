// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Web: this computer as a web page for phones that can't run the TwinDesk app (an iPhone,
// an iPad, any browser). Its own server, beside the TwinDesk session: a computer or an Android phone
// stays connected while web devices come and go, and each web device is a device of its own in the
// sidebar.
//
// Reached at https://twindesk-xxxxxx.local:<port> (shared/web/mdnshost.js: the same name whatever
// address this computer gets), with a certificate from TwinDesk's own local authority
// (shared/web/webca.js; the phone installs it once from the page). Plain http on <port>+1 for the
// first visit (the QR code), the certificate, and phones that never install it.
//
// Pairing: the phone opens the QR code (or types the code shown here on the page) once. It gets a
// device id and a key; this computer keeps the key's hash (devices.json). Each visit after that the
// page says hello with them (kept in the page's storage and in its address, so an app installed on
// the Home Screen, which has storage of its own, has them too). Either side can forget the other.
//
// One WebSocket per open page (/ws): JSON messages {t, ...}:
//   phone → here: hello {id, key, name, os, model} | pair {code, name, os, model} | forget
//     clip.set {text} | chat {text} | chat.del {id} | notifs {on} | screen.start {video, audio, maxH}
//     screen.stop | rtc.answer {sdp} | rtc.ice {candidate} | remote.* (shared/phone-remote.js)
//     cam.offer/cam.ice/cam.stop, mic.offer/mic.ice/mic.stop (the phone's camera and microphone here)
//     ping {at} | vis {hidden} (the page is in the background: alerts go to its notifications)
//     push.sub {sub, alerts} | push.off | alerts {alerts} | push.test | seen (the badge is read)
//     dev.get | dev.do {do, on, level} (ring, lock, sleep… this computer: shared/devlocal.js)
//     mount.get | media.do {cmd} (play, pause, next, previous: what plays here)
//   here → phone: welcome {pc, token, device} | paired {id, key, pc, token} | unknown | bad-code {wait}
//     forgotten | clip {text, at} | chat.all {items} | chat.add {item} | chat.gone {id}
//     notif {item} | notifs.all {items} | screen.state {status} | rtc.offer {sdp} | rtc.ice {candidate}
//     cam.answer/cam.ice, mic.answer/mic.ice | remote.state | pong {at}
//     alert {kind, title, body, tag, go} (show it as a notification: the page is hidden, no push)
//     alerts {alerts, push, unread} | dev.state {can, state} | mount {…} | media.state {…}
// HTTP (the token from welcome/paired as ?t=): POST /api/up?name= (a file, the body as it is),
// GET /api/f/<id> (a file sent to the phone), GET /api/ping (CORS: the page checks which way works).
// For Shortcuts on an iPhone (or curl anywhere; the token also as the X-TwinDesk-Token header):
// GET /api/clip (this computer's clipboard, as text), POST /api/clip (the body onto it),
// POST /api/drop (the body as a message in the Drop). POST /share-target: what Android's share menu
// sends an installed page (web/sw.js takes it first; here only when it didn't).
//
// opts: dir (its files), webRoot (the page), tdRoot (the phone app's viewer and remote pages), self() → {id, name, os}, getCfg() → settings.web,
//   clipboard {readText(), writeText(t)}, receivedDir(), onReceived(paths, device), say(title, body),
//   capture (shared/web/webcap.js), camRecv (shared/web/webrecv.js), notifSource (EventEmitter
//   'notif'; want(on)), devLocal (shared/devlocal.js: can(), state(), do()), smbInfo() → the shared
//   folder for the Files app (or null), media (EventEmitter 'change'; state(), do(cmd)) or null,
//   extendable() → whether a screen of its own can be made for a web device (Extend).
// Alerts (clipboard, Drop messages, files, this computer's notifications) go to a device whose page
// isn't in front: as Web Push (shared/web/webpush.js) when it subscribed, or on its socket.
// Events: 'change' (view()), 'remote-bus' — see this.remoteBus.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const webca = require('./webca.js');
const { MdnsHost, ipv4s } = require('./mdnshost.js');
const { WebPush } = require('./webpush.js');

let WS;
try { WS = require('ws'); } catch (_) { WS = require.main.require('ws'); }

const DEFAULT_PORT = 47870;
const CHAT_KEEP = 300;
const NOTIF_KEEP = 100;
const CLIP_POLL_MS = 700;
const CODE_TRIES = 5;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.zip': 'application/zip',
};

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const ALERT_KINDS = ['clip', 'drop', 'files', 'notifs'];
const ALERT_DEFAULTS = { clip: true, drop: true, files: true, notifs: false, preview: true, badge: true };
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'image/gif': '.gif', 'image/webp': '.webp', 'video/quicktime': '.mov', 'video/mp4': '.mp4', 'application/pdf': '.pdf', 'text/plain': '.txt', 'audio/mp4': '.m4a', 'application/zip': '.zip' };
const OSES = new Set(['ios', 'ipados', 'android', 'mac', 'win', 'linux', 'other']);
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return dflt; }
}
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// A name not taken in that folder: "photo.jpg", "photo 2.jpg", …
function freeName(dir, name) {
  const safe = path.basename(String(name || 'file')).replace(/[\u0000-\u001f/\\:*?"<>|]/g, '_').slice(0, 180) || 'file';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    const p = path.join(dir, i === 1 ? safe : `${stem} ${i}${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, `${stem} ${Date.now()}${ext}`);
}

class WebHub extends EventEmitter {
  constructor(opts) {
    super();
    Object.assign(this, opts);
    this.files = path.join(this.dir, 'devices.json');
    fs.mkdirSync(path.join(this.dir, 'chats'), { recursive: true });
    this.devices = readJson(this.files, []).filter((d) => d && d.id && d.keyHash);
    this.secret = this._secret();
    this.code = newCode();
    this.tries = { n: 0, until: 0 };
    this.socks = new Map(); // device id -> Set of sockets (a page open in two tabs: two)
    this.pending = new Set(); // sockets before hello/pair
    this.chats = new Map(); // device id -> [items], loaded on first use
    this.notifs = []; // this computer's recent notifications, for the pages that show them
    this.clip = { text: '', at: 0, history: [] };
    this.screenDev = null; // the device the screen (or sound) goes to
    this.screen = { status: 'off', video: false, audio: false };
    this.running = false;
    this.error = '';
    // Remote input as shared/phone-remote.js expects a phone's session: on('t:remote.*'), current, sendToClient.
    this.remoteBus = new EventEmitter();
    this.remoteBus.current = null;
    this.remoteBus.sendToClient = (m) => this.remoteBus.dev && this._send(this.remoteBus.dev, m);
    // The screen viewer's input (the phone app's viewer.js: in.* normalized to the screen shared) as
    // a computer's input arrives in a session (mac/input.js and the others take it from here).
    this.inBus = new EventEmitter();
    this.inBus.current = null;
    if (this.capture) {
      this.capture.on('out', (m) => this.screenDev && this._send(this.screenDev, m));
      this.capture.on('status', (status) => {
        this.screen.status = status;
        if (this.screenDev) this._send(this.screenDev, { t: 'screen.state', status, on: status !== 'off', video: this.screen.video, audio: this.screen.audio });
        this.emit('change');
      });
    }
    if (this.camRecv) {
      this.camRecv.on('out', (dev, m) => this._send(dev, m));
      this.camRecv.on('change', () => this.emit('change'));
    }
    if (this.notifSource) this.notifSource.on('notif', (n) => this._notif(n));
    if (this.media) this.media.on('change', () => this._all({ t: 'media.state', ...this._media() }));
    try { this.push = new WebPush(this.dir); } catch (e) { console.warn('[web] push:', e.message); this.push = null; }
    this.alertTimers = new Map(); // device id + kind -> a clipboard alert waiting (they come fast)
  }

  get cfg() {
    return this.getCfg();
  }

  get port() {
    const p = Number(this.cfg.port);
    return p >= 1024 && p < 65000 ? p : DEFAULT_PORT;
  }

  get host() {
    const id = String(this.self().id || '').replace(/[^0-9a-f]/gi, '').slice(0, 6).toLowerCase() || 'pc';
    return `twindesk-${id}.local`;
  }

  _secret() {
    const f = path.join(this.dir, 'secret');
    try {
      const s = fs.readFileSync(f, 'utf8').trim();
      if (s.length >= 32) return s;
    } catch (_) {}
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  }

  // What a page uses for its file links and uploads: tied to the device, ends when it's forgotten.
  _token(dev) {
    return crypto.createHmac('sha256', this.secret).update(`${dev.id}:${dev.keyHash}`).digest('hex').slice(0, 40);
  }

  _byToken(t) {
    if (t && typeof t === 'object') t = t.headers['x-twindesk-token'] || new URL(t.url, 'http://x').searchParams.get('t');
    if (typeof t !== 'string' || t.length !== 40) return null;
    return this.devices.find((d) => crypto.timingSafeEqual(Buffer.from(this._token(d)), Buffer.from(t))) || null;
  }

  _saveDevices() {
    try { writeJson(this.files, this.devices); } catch (e) { console.warn('[web] devices:', e.message); }
  }

  // ---- the servers ----
  start() {
    if (this.running) return;
    this.running = true;
    this.error = '';
    try {
      this.certs = webca.load(this.dir, this.host);
    } catch (e) {
      this.error = 'Couldn’t make the certificate: ' + e.message;
      this.running = false;
      return void this.emit('change');
    }
    this.mdns = new MdnsHost(this.host);
    this.mdns.start();
    const handler = (secure) => (req, res) => this._http(req, res, secure).catch((e) => {
      console.warn('[web] http:', e.message);
      try { res.writeHead(500); res.end(); } catch (_) {}
    });
    this.https = https.createServer({ key: this.certs.leaf.keyPem, cert: this.certs.leaf.certPem + this.certs.ca.certPem }, handler(true));
    this.http = http.createServer(handler(false));
    this.wss = new WS.WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
    for (const srv of [this.https, this.http]) {
      srv.on('upgrade', (req, sock, head) => {
        if (!req.url.startsWith('/ws')) return sock.destroy();
        this.wss.handleUpgrade(req, sock, head, (ws) => this._socket(ws, req));
      });
      srv.on('error', (e) => {
        this.error = e.code === 'EADDRINUSE' ? `Port ${srv === this.https ? this.port : this.port + 1} is in use by another app` : e.message;
        console.warn('[web] server:', e.message);
        this.emit('change');
      });
    }
    this.https.listen(this.port);
    this.http.listen(this.port + 1);
    // The certificate names the addresses this computer has: a new one (another network) gets a new
    // certificate, while the old one keeps working by name.
    this.addrTimer = setInterval(() => this._addresses(), 10000);
    this.lastAddrs = ipv4s().map((i) => i.address).join(',');
    this.clipTimer = setInterval(() => this._pollClip(), CLIP_POLL_MS);
    this.emit('change');
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.addrTimer);
    clearInterval(this.clipTimer);
    for (const set of this.socks.values()) for (const ws of set) try { ws.close(1001); } catch (_) {}
    for (const ws of this.pending) try { ws.close(1001); } catch (_) {}
    this.socks.clear();
    this.pending.clear();
    this._screenStop();
    if (this.camRecv) this.camRecv.stopAll();
    this._remoteGone(null);
    try { this.https.close(); } catch (_) {}
    try { this.http.close(); } catch (_) {}
    try { this.wss.close(); } catch (_) {}
    if (this.mdns) this.mdns.stop();
    if (this.notifSource) this.notifSource.want(false);
    this.emit('change');
  }

  _addresses() {
    const now = ipv4s().map((i) => i.address).join(',');
    if (now === this.lastAddrs) return;
    this.lastAddrs = now;
    try {
      const c = webca.load(this.dir, this.host);
      if (c.fresh) {
        this.certs = c;
        this.https.setSecureContext({ key: c.leaf.keyPem, cert: c.leaf.certPem + c.ca.certPem });
      }
    } catch (e) { console.warn('[web] certificate:', e.message); }
    this.emit('change');
  }

  // ---- HTTP ----
  async _http(req, res, secure) {
    const u = new URL(req.url, 'http://x');
    const p = decodeURIComponent(u.pathname);
    const head = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (p === '/api/ping') {
      res.writeHead(200, { ...head, 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ ok: true, id: this.self().id, name: this.self().name, os: this.self().os, version: this.self().version || '', secure, host: this.host, port: this.port }));
    }
    if (p === '/twindesk.mobileconfig') {
      res.writeHead(200, { ...head, 'Content-Type': 'application/x-apple-aspen-config', 'Content-Disposition': 'attachment; filename="TwinDesk.mobileconfig"' });
      return res.end(webca.mobileconfig(this.certs.ca.certPem, this.self().name));
    }
    if (p === '/twindesk.cer') {
      res.writeHead(200, { ...head, 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="TwinDesk.cer"' });
      return res.end(require('./x509.js').derOf(this.certs.ca.certPem));
    }
    if (p === '/api/up' && req.method === 'POST') return this._upload(req, res, u);
    if (p === '/api/clip' || p === '/api/drop') return this._shortcut(req, res, p);
    if (p === '/share-target') { res.writeHead(303, { ...head, Location: '/' }); return res.end(); }
    if (p.startsWith('/api/f/') && (req.method === 'GET' || req.method === 'HEAD')) return this._download(req, res, u, p.slice(7));
    if (p === '/manifest.webmanifest') {
      // start_url carries what the page had after its #: an app added to the Home Screen opens paired.
      res.writeHead(200, { ...head, 'Content-Type': MIME['.webmanifest'] });
      return res.end(JSON.stringify({
        id: '/', name: `TwinDesk · ${this.self().name}`, short_name: 'TwinDesk', display: 'standalone', background_color: '#0b0d12', theme_color: '#0b0d12',
        start_url: '/' + (u.searchParams.get('h') ? '#' + u.searchParams.get('h') : ''), scope: '/',
        icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
        // Android: TwinDesk in the share menu (web/sw.js takes what's shared) and on a long press of the icon.
        share_target: { action: '/share-target', method: 'POST', enctype: 'multipart/form-data', params: { title: 'title', text: 'text', url: 'url', files: [{ name: 'files', accept: ['*/*'] }] } },
        shortcuts: [
          { name: 'Send files', url: '/?go=files', icons: [{ src: '/icon.png', sizes: '512x512' }] },
          { name: 'Clipboard', url: '/?go=clipboard', icons: [{ src: '/icon.png', sizes: '512x512' }] },
          { name: 'Touchpad', url: '/?go=touchpad', icons: [{ src: '/icon.png', sizes: '512x512' }] },
        ],
      }));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, head); return res.end(); }
    // The phone app's own screen viewer and remote (android/…/assets/web), as they are, with the bridge
    // that stands in for the app (web/td-bridge.js) loaded before them.
    const td = p.startsWith('/td/') && this.tdRoot;
    const root = td ? this.tdRoot : this.webRoot;
    const rel = p === '/' ? 'index.html' : td ? p.slice(4) : p.replace(/^\/+/, '');
    const file = path.join(root, rel);
    if (td && rel.endsWith('.html') && file.startsWith(root + path.sep) && fs.existsSync(file)) {
      const html = fs.readFileSync(file, 'utf8')
        .replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">')
        .replace(/(<script src=")/, '<link rel="stylesheet" href="/td-bridge.css"><script src="/td-bridge.js"></script>$1');
      res.writeHead(200, { ...head, 'Content-Type': MIME['.html'], 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'" });
      return res.end(html);
    }
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { ...head, 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      ...head, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss: http: https:; style-src 'self' 'unsafe-inline'",
      'Referrer-Policy': 'no-referrer',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  _upload(req, res, u) {
    const dev = this._byToken(req);
    if (!dev) { res.writeHead(401); return res.end(); }
    const dir = this.receivedDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    // A Shortcut may send a photo without its name: one from its type.
    let name = u.searchParams.get('name') || '';
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!path.extname(name) && EXT[type]) name = (name || `From ${dev.name} ${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}`) + EXT[type];
    const dest = freeName(dir, name);
    const part = dest + '.twindesk-part';
    const out = fs.createWriteStream(part);
    let size = 0;
    req.on('data', (c) => { size += c.length; });
    req.pipe(out);
    const fail = (e) => {
      out.destroy();
      fs.rm(part, { force: true }, () => {});
      if (!res.headersSent) { res.writeHead(500); res.end(e ? e.message : ''); }
    };
    req.on('aborted', () => fail());
    out.on('error', fail);
    out.on('finish', () => {
      if (req.aborted) return;
      fs.rename(part, dest, (e) => {
        if (e) return fail(e);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: path.basename(dest), size }));
        const item = this._chatAdd(dev.id, { from: 'phone', file: { name: path.basename(dest), size, path: dest } });
        this.onReceived([dest], dev, item);
      });
    });
  }

  _download(req, res, u, fid) {
    const dev = this._byToken(req);
    if (!dev) { res.writeHead(401); return res.end(); }
    const item = this._chat(dev.id).find((x) => x.file && x.file.fid === fid);
    const file = item && item.file.path;
    let st;
    try { st = fs.statSync(file); } catch (_) { st = null; }
    if (!st || !st.isFile()) { res.writeHead(404); return res.end('That file isn’t there any more'); }
    const name = path.basename(file);
    const type = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
    const inline = u.searchParams.get('view') === '1';
    const headers = {
      'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    };
    // Ranges: a video plays (and seeks) in the page; a big download resumes.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      start = Math.max(0, start);
      end = Math.min(st.size - 1, end);
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  // Shortcuts (an iPhone's Back Tap, its share sheet) and scripts: the clipboard and the Drop.
  _shortcut(req, res, p) {
    const dev = this._byToken(req);
    if (!dev) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('Not paired: copy the link again from TwinDesk Web › Shortcuts'); }
    dev.lastSeen = Date.now();
    if (p === '/api/clip' && (req.method === 'GET' || req.method === 'HEAD')) {
      let text = '';
      try { text = this.clipboard.readText() || ''; } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : text);
    }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 1 << 20) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Nothing to send'); }
      if (p === '/api/clip') {
        try { this.clipboard.writeText(text); } catch (_) {}
        this._clipChanged(text, dev.name, dev.id);
      } else {
        this._chatAdd(dev.id, { from: 'phone', text: text.slice(0, 20000) });
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(p === '/api/clip' ? `On ${this.self().name}’s clipboard` : `Sent to ${this.self().name}`);
    });
  }

  // ---- WebSocket ----
  _socket(ws, req) {
    ws.ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    ws.secure = !!req.socket.encrypted;
    ws.alive = true;
    this.pending.add(ws);
    const helloTimer = setTimeout(() => { if (!ws.dev) ws.close(4000, 'hello'); }, 15000);
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (data, binary) => {
      if (binary) return;
      let m;
      try { m = JSON.parse(String(data)); } catch (_) { return; }
      if (!m || typeof m.t !== 'string') return;
      try { this._message(ws, m); } catch (e) { console.warn('[web] message', m.t, e.message); }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.pending.delete(ws);
      const dev = ws.dev;
      if (!dev) return;
      const set = this.socks.get(dev);
      if (set) {
        set.delete(ws);
        if (!set.size) this.socks.delete(dev);
      }
      if (!this.socks.has(dev)) this._devGone(dev);
      this.emit('change');
    });
    // A phone that went away without closing (Wi-Fi off, the screen locked for long): gone in ~40 s.
    const beat = setInterval(() => {
      if (ws.readyState !== 1) return clearInterval(beat);
      if (!ws.alive) return ws.terminate();
      ws.alive = false;
      try { ws.ping(); } catch (_) {}
    }, 20000);
    ws.on('close', () => clearInterval(beat));
  }

  _pcInfo() {
    const s = this.self();
    return {
      id: s.id, name: s.name, os: s.os, version: s.version || '', host: this.host, port: this.port, ips: ipv4s().map((i) => i.address), control: this.cfg.control !== false,
      vapid: this.push ? this.push.publicKey : '', media: !!this.media, mount: !!this.smbInfo, devices: !!this.devLocal,
      extend: !!(this.extendable && this.extendable()),
    };
  }

  _welcome(ws, dev, m) {
    this.pending.delete(ws);
    ws.dev = dev.id;
    if (!this.socks.has(dev.id)) this.socks.set(dev.id, new Set());
    this.socks.get(dev.id).add(ws);
    // What it says about itself now (an iPhone's name can change; the address does all the time).
    const name = str(m.name, 60).trim();
    if (name) dev.name = name;
    if (OSES.has(m.os)) dev.os = m.os;
    if (m.model) dev.model = str(m.model, 60);
    dev.lastSeen = Date.now();
    dev.lastIp = ws.ip;
    this._saveDevices();
    const token = this._token(dev);
    this._sendWs(ws, { t: m.t === 'pair' ? 'paired' : 'welcome', id: dev.id, key: m.key || undefined, token, pc: this._pcInfo(), device: { id: dev.id, name: dev.name } });
    this._sendWs(ws, { t: 'clip', text: this.clip.text, at: this.clip.at, history: this.clip.history.slice(0, 20) });
    this._sendWs(ws, { t: 'chat.all', items: this._chat(dev.id).map((x) => this._public(x)) });
    if (dev.notifs) {
      this._sendWs(ws, { t: 'notifs.all', items: this.notifs });
      this._wantNotifs();
    }
    this._sendWs(ws, { t: 'screen.state', status: this.screenDev === dev.id ? this.screen.status : 'off' });
    this._sendWs(ws, this._alertsMsg(dev));
    if (this.devLocal) this._devState().then((x) => this._sendWs(ws, x));
    if (this.smbInfo) this._sendWs(ws, this._mount());
    if (this.media) this._sendWs(ws, { t: 'media.state', ...this._media() });
    this.emit('change');
  }

  _alertsOf(dev) {
    return { ...ALERT_DEFAULTS, ...(dev.alerts || {}) };
  }

  _alertsMsg(dev) {
    return { t: 'alerts', alerts: this._alertsOf(dev), push: !!dev.push, unread: dev.unread || 0 };
  }

  async _devState() {
    let can = {}, state = {};
    try { can = this.devLocal.can() || {}; state = (await this.devLocal.state()) || {}; } catch (_) {}
    return { t: 'dev.state', can, state };
  }

  _mount() {
    let info = null;
    try { info = this.smbInfo(); } catch (_) {}
    return { t: 'mount', ...(info || { on: false }) };
  }

  _media() {
    try { return this.media.state() || {}; } catch (_) { return {}; }
  }

  _message(ws, m) {
    if (!ws.dev) {
      if (m.t === 'hello') {
        const dev = this.devices.find((d) => d.id === m.id);
        if (!dev || typeof m.key !== 'string' || sha(m.key) !== dev.keyHash) return this._sendWs(ws, { t: 'unknown' });
        return this._welcome(ws, dev, m);
      }
      if (m.t === 'pair') {
        if (!this.cfg.on) return this._sendWs(ws, { t: 'bad-code', why: 'off' });
        const now = Date.now();
        if (now < this.tries.until) return this._sendWs(ws, { t: 'bad-code', wait: Math.ceil((this.tries.until - now) / 1000) });
        const code = String(m.code || '').replace(/\D/g, '');
        if (code.length !== 6 || !crypto.timingSafeEqual(Buffer.from(code), Buffer.from(this.code))) {
          if (++this.tries.n >= CODE_TRIES) {
            this.tries = { n: 0, until: now + 60000 };
            this.code = newCode(); // a code someone is guessing at isn't the code any more
            this.emit('change');
          }
          return this._sendWs(ws, { t: 'bad-code', wait: 0 });
        }
        this.tries = { n: 0, until: 0 };
        const key = crypto.randomBytes(24).toString('base64url');
        const dev = {
          id: crypto.randomUUID(), keyHash: sha(key), name: str(m.name, 60).trim() || 'Web device',
          os: OSES.has(m.os) ? m.os : 'other', model: str(m.model, 60), pairedAt: now, lastSeen: now, lastIp: ws.ip, notifs: true,
        };
        this.devices.push(dev);
        this.code = newCode(); // each code pairs one device
        this._saveDevices();
        this.say(`${dev.name} is paired`, 'It can open TwinDesk on this computer from now on.');
        return this._welcome(ws, dev, { ...m, key });
      }
      return;
    }
    const dev = this.devices.find((d) => d.id === ws.dev);
    if (!dev) return ws.close(4001, 'forgotten');
    dev.lastSeen = Date.now();
    const t = m.t;
    if (t === 'ping') return this._sendWs(ws, { t: 'pong', at: m.at });
    if (t === 'vis') { ws.hidden = !!m.hidden; if (!ws.hidden && dev.unread) { dev.unread = 0; this._saveDevices(); } return; }
    if (t === 'seen') { dev.unread = 0; this._saveDevices(); return; }
    if (t === 'push.sub') {
      const sub = m.sub || {};
      if (typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return;
      dev.push = { endpoint: sub.endpoint.slice(0, 2000), keys: { p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 100) } };
      if (m.alerts) dev.alerts = this._cleanAlerts(m.alerts);
      this._saveDevices();
      this._send(dev.id, this._alertsMsg(dev));
      return this.emit('change');
    }
    if (t === 'push.off') { delete dev.push; this._saveDevices(); this._send(dev.id, this._alertsMsg(dev)); return this.emit('change'); }
    if (t === 'alerts') { dev.alerts = this._cleanAlerts(m.alerts); this._saveDevices(); this._send(dev.id, this._alertsMsg(dev)); return this._wantNotifs(); }
    if (t === 'push.test') return this._alert(dev, 'test', { title: `${this.self().name}`, body: 'Notifications from TwinDesk work on this device.' }, ws);
    if (t === 'dev.get') return this.devLocal && this._devState().then((x) => this._sendWs(ws, x));
    if (t === 'dev.do') {
      if (!this.devLocal) return;
      const what = str(m.do, 20);
      if (!['ring', 'ringStop', 'lock', 'sleep', 'bluetooth', 'dnd', 'volume', 'mute'].includes(what)) return;
      Promise.resolve().then(() => this.devLocal.do({ do: what, on: !!m.on, ...(Number.isFinite(m.level) ? { level: m.level } : {}) }))
        .catch((e) => this._sendWs(ws, { t: 'dev.error', do: what, why: e.message }))
        .finally(() => setTimeout(() => this._devState().then((x) => this._send(dev.id, x)), 400));
      return;
    }
    if (t === 'mount.get') return this.smbInfo && this._sendWs(ws, this._mount());
    if (t === 'media.do') {
      const cmd = str(m.cmd, 20);
      if (this.media && ['play', 'pause', 'toggle', 'next', 'previous'].includes(cmd)) { try { this.media.do(cmd); } catch (_) {} }
      return;
    }
    if (t === 'forget') {
      this._sendWs(ws, { t: 'forgotten' });
      return this.forget(dev.id, false);
    }
    if (t === 'clip.set') {
      const text = str(m.text, 1 << 20);
      if (!text) return;
      this.clipboard.writeText(text);
      this._clipChanged(text, dev.name, dev.id);
      return;
    }
    if (t === 'chat') {
      const text = str(m.text, 20000).trim();
      if (text) this._chatAdd(dev.id, { from: 'phone', text });
      return;
    }
    if (t === 'chat.del') return this._chatDel(dev.id, str(m.id, 64));
    if (t === 'notifs') {
      dev.notifs = !!m.on;
      this._saveDevices();
      if (dev.notifs) this._sendWs(ws, { t: 'notifs.all', items: this.notifs });
      this._wantNotifs();
      return this.emit('change');
    }
    if (t === 'screen.start') return this._screenStart(dev, m, ws);
    if (t === 'screen.stop') return this.screenDev === dev.id && this._screenStop();
    if (t === 'rtc.answer' || t === 'rtc.ice') return this.screenDev === dev.id && this.capture && this.capture.remote(m);
    if (/^(cam|mic)\.(offer|ice|stop)$/.test(t)) return this.camRecv && this.camRecv.fromPhone(dev, m);
    if (t.startsWith('in.')) {
      if (this.screenDev === dev.id && this.screen.video && this.cfg.control !== false) this.inBus.emit(`t:${t}`, m);
      return;
    }
    if (t === 'rename') return this.rename(dev.id, m.name);
    if (t.startsWith('remote.')) {
      const bus = this.remoteBus;
      if (bus.dev !== dev.id) {
        if (bus.dev) { bus.current = null; bus.emit('closed'); }
        bus.dev = dev.id;
        bus.current = { id: dev.id, name: dev.name, os: 'android' }; // phone-remote.js takes a phone's input
      }
      return bus.emit(`t:${t}`, m);
    }
  }

  _devGone(id) {
    if (this.screenDev === id) this._screenStop();
    if (this.camRecv) this.camRecv.stopDevice(id);
    this._remoteGone(id);
    this._wantNotifs();
  }

  _remoteGone(id) {
    const bus = this.remoteBus;
    if (!bus.dev || (id && bus.dev !== id)) return;
    bus.dev = null;
    bus.current = null;
    bus.emit('closed');
  }

  _send(devId, m) {
    const set = this.socks.get(devId);
    if (!set) return false;
    for (const ws of set) this._sendWs(ws, m);
    return true;
  }

  _sendWs(ws, m) {
    if (ws.readyState === 1) ws.send(JSON.stringify(m));
  }

  _all(m, only = () => true) {
    for (const [id, set] of this.socks) if (only(id)) for (const ws of set) this._sendWs(ws, m);
  }

  // ---- screen and sound to one phone ----
  _screenStart(dev, m, ws) {
    if (!this.capture) return this._sendWs(ws, { t: 'screen.state', status: 'error: not on this computer' });
    if (this.cfg.screen === false) return this._sendWs(ws, { t: 'screen.state', status: 'error: Screen is off for web devices on this computer' });
    if (this.screenDev && this.screenDev !== dev.id) this._send(this.screenDev, { t: 'screen.state', status: 'off', why: `${dev.name} is watching now` });
    this.screenDev = dev.id;
    const video = m.video !== false;
    const audio = !!m.audio;
    const mode = m.mode === 'extend' && this.extendable && this.extendable() ? 'extend' : 'mirror';
    this.screen = { status: 'starting', video, audio, mode };
    this._send(dev.id, { t: 'stream.info', audio });
    if (video) this.inBus.current = { id: dev.id, name: dev.name };
    const maxH = Math.max(360, Math.min(2160, Number(m.maxH) || 1080));
    this.capture.start({ video, audio, mode, dev: { id: dev.id, name: dev.name, w: Number(m.w) || 0, h: Number(m.h) || 0 }, maxH, fps: Math.max(15, Math.min(60, Number(m.fps) || 60)), mbps: Math.max(2, Math.min(40, Number(m.mbps) || 12)) });
    this.emit('change');
  }

  _screenStop() {
    const dev = this.screenDev;
    this.screenDev = null;
    this.screen = { status: 'off', video: false, audio: false };
    if (this.capture) this.capture.stop();
    if (this.inBus.current) { this.inBus.current = null; this.inBus.emit('closed'); }
    if (dev) { this._send(dev, { t: 'stream.stop' }); this._send(dev, { t: 'screen.state', status: 'off', on: false }); }
    this.emit('change');
  }

  // The Web device's page here: stop what it's watching.
  stopScreen(devId) {
    if (!devId || this.screenDev === devId) this._screenStop();
  }

  // ---- clipboard ----
  _pollClip() {
    // While a page is open, or a device wants to hear about it with its page closed (push).
    if (!this.socks.size && !this.devices.some((d) => d.push && this._alertsOf(d).clip)) return;
    let text = '';
    try { text = this.clipboard.readText() || ''; } catch (_) { return; }
    if (text && text !== this.clip.text) this._clipChanged(text, this.self().name);
  }

  _clipChanged(text, from, fromDev) {
    const at = Date.now();
    this.clip.text = text;
    this.clip.at = at;
    this.clip.history = [{ text: text.slice(0, 20000), at, from }, ...this.clip.history.filter((h) => h.text !== text)].slice(0, 20);
    this._all({ t: 'clip', text, at, from, history: this.clip.history });
    // Copied here: tell the web devices whose pages aren't in front (not the one that sent it).
    if (!fromDev) for (const d of this.devices) this._alert(d, 'clip', { title: `Copied on ${this.self().name}`, body: text.replace(/\s+/g, ' ').trim().slice(0, 240), go: 'clipboard' });
    this.emit('change');
  }

  _cleanAlerts(a) {
    const o = { ...ALERT_DEFAULTS };
    for (const k of Object.keys(ALERT_DEFAULTS)) if (a && typeof a[k] === 'boolean') o[k] = a[k];
    return o;
  }

  // A web device hears about it when its page isn't in front: a visible page shows it itself.
  // Hidden but connected (iOS kept it running, a background tab) with no push: on its socket, for the
  // page to show as a notification. Push when subscribed: it works with the page closed too.
  _alert(dev, kind, { title, body, go }, testWs) {
    if (!dev) return;
    const a = this._alertsOf(dev);
    if (kind !== 'test' && !a[kind]) return;
    const set = this.socks.get(dev.id);
    const socks = set ? [...set] : [];
    if (kind !== 'test' && socks.some((ws) => !ws.hidden)) return;
    const key = `${dev.id}:${kind}`;
    const fire = () => {
      this.alertTimers.delete(key);
      if (kind !== 'test') dev.unread = (dev.unread || 0) + 1;
      const msg = {
        kind, tag: kind === 'clip' ? 'clip' : kind === 'test' ? 'test' : `${kind}-${Date.now()}`,
        title: str(title, 120), body: a.preview || kind === 'test' ? str(body, 400) : kind === 'clip' ? 'Open TwinDesk to copy it' : 'Open TwinDesk to see it',
        go: go || '', badge: a.badge ? dev.unread || 0 : 0, pc: this.self().name,
      };
      if (dev.push && this.push) {
        this.push.send(dev.push, msg, { ttl: kind === 'clip' ? 600 : 6 * 3600, urgency: kind === 'notifs' ? 'normal' : 'high', topic: kind === 'clip' ? 'clip' : undefined }).then((r) => {
          if (r.gone) {
            delete dev.push;
            this._saveDevices();
            this._send(dev.id, this._alertsMsg(dev));
            this.emit('change');
          }
          // Not delivered (no internet here, say): the page still gets it, when it's connected.
          if (!r.ok && !r.gone && socks.length) for (const ws of socks) this._sendWs(ws, { t: 'alert', ...msg });
          if (testWs) this._sendWs(testWs, { t: 'push.result', ok: r.ok, status: r.status, why: r.error || '' });
        });
      } else if (socks.length) {
        for (const ws of socks) this._sendWs(ws, { t: 'alert', ...msg });
        if (testWs) this._sendWs(testWs, { t: 'push.result', ok: true, local: true });
      } else return;
      this._saveDevices();
    };
    // A burst of copies: one alert, the last.
    if (kind === 'clip') {
      clearTimeout(this.alertTimers.get(key));
      this.alertTimers.set(key, setTimeout(fire, 1200));
    } else fire();
  }

  // ---- the Drop: messages and files, per device ----
  _chatFile(id) {
    return path.join(this.dir, 'chats', `${id.replace(/[^0-9a-f-]/gi, '')}.json`);
  }

  _chat(id) {
    if (!this.chats.has(id)) this.chats.set(id, readJson(this._chatFile(id), []));
    return this.chats.get(id);
  }

  _public(x) {
    return { id: x.id, from: x.from, text: x.text, at: x.at, file: x.file ? { fid: x.file.fid, name: x.file.name, size: x.file.size } : undefined };
  }

  _chatAdd(devId, item) {
    const list = this._chat(devId);
    const full = { id: crypto.randomUUID(), at: Date.now(), ...item };
    if (full.file && !full.file.fid) full.file.fid = crypto.randomBytes(9).toString('base64url');
    list.push(full);
    if (list.length > CHAT_KEEP) list.splice(0, list.length - CHAT_KEEP);
    try { writeJson(this._chatFile(devId), list); } catch (_) {}
    this._send(devId, { t: 'chat.add', item: this._public(full) });
    if (full.from === 'pc') {
      const dev = this.devices.find((d) => d.id === devId);
      if (full.file) this._alert(dev, 'files', { title: `${this.self().name} sent a file`, body: full.file.name, go: 'files' });
      else this._alert(dev, 'drop', { title: this.self().name, body: full.text, go: 'drop' });
    }
    this.emit('change');
    return full;
  }

  _chatDel(devId, id) {
    const list = this._chat(devId);
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    list.splice(i, 1);
    try { writeJson(this._chatFile(devId), list); } catch (_) {}
    this._send(devId, { t: 'chat.gone', id });
    this.emit('change');
  }

  // From the device's page here.
  sendText(devId, text) {
    text = str(text, 20000).trim();
    if (text && this.devices.some((d) => d.id === devId)) this._chatAdd(devId, { from: 'pc', text });
  }

  sendFiles(devId, paths) {
    if (!this.devices.some((d) => d.id === devId)) return 0;
    let n = 0;
    for (const p of (paths || []).slice(0, 200)) {
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (!st.isFile()) continue; // folders: not yet (a phone saves files, not folders)
      this._chatAdd(devId, { from: 'pc', file: { name: path.basename(p), size: st.size, path: p } });
      n++;
    }
    return n;
  }

  deleteItem(devId, id) {
    this._chatDel(devId, id);
  }

  clearChat(devId) {
    this.chats.set(devId, []);
    try { writeJson(this._chatFile(devId), []); } catch (_) {}
    this._send(devId, { t: 'chat.all', items: [] });
    this.emit('change');
  }

  // ---- notifications ----
  _wantNotifs() {
    if (!this.notifSource) return;
    // Open pages that show them, or devices that hear about them with their page closed (push).
    const on = this.devices.some((d) => d.notifs && (this.socks.has(d.id) || (d.push && this._alertsOf(d).notifs)));
    this.notifSource.want(on);
  }

  _notif(n) {
    const item = {
      id: str(n.id, 64) || crypto.randomUUID(), app: str(n.app), appName: str(n.appName, 100), title: str(n.title, 300),
      subtitle: str(n.subtitle, 300), body: str(n.body, 2000), at: Number(n.at) || Date.now(),
      icon: typeof n.icon === 'string' && n.icon.startsWith('data:image/') && n.icon.length < 60000 ? n.icon : undefined,
    };
    this.notifs = [item, ...this.notifs.filter((x) => x.id !== item.id)].slice(0, NOTIF_KEEP);
    this._all({ t: 'notif', item }, (id) => (this.devices.find((d) => d.id === id) || {}).notifs);
    for (const d of this.devices) {
      if (!d.notifs) continue;
      this._alert(d, 'notifs', { title: [item.appName, item.title].filter(Boolean).join(' · ') || this.self().name, body: [item.subtitle, item.body].filter(Boolean).join('\n'), go: 'notifications' });
    }
  }

  // ---- pairing, from here ----
  newCode() {
    this.code = newCode();
    this.tries = { n: 0, until: 0 };
    this.emit('change');
  }

  forget(id, tell = true) {
    const dev = this.devices.find((d) => d.id === id);
    if (!dev) return;
    if (tell) this._send(id, { t: 'forgotten' });
    this.devices = this.devices.filter((d) => d.id !== id);
    this._saveDevices();
    this.chats.delete(id);
    fs.rm(this._chatFile(id), { force: true }, () => {});
    const set = this.socks.get(id);
    this.socks.delete(id);
    if (set) for (const ws of set) setTimeout(() => { try { ws.close(4001, 'forgotten'); } catch (_) {} }, 300);
    this._devGone(id);
    this.emit('change');
  }

  rename(id, name) {
    const dev = this.devices.find((d) => d.id === id);
    if (!dev || !str(name, 60).trim()) return;
    dev.name = str(name, 60).trim();
    this._saveDevices();
    this.emit('change');
  }

  // ---- for the window ----
  links() {
    const ips = ipv4s();
    const lan = ips.find((i) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(i.address)) || ips[0];
    const ip = lan ? lan.address : '127.0.0.1';
    const q = `#pair=${this.code}`;
    return {
      // The QR code: plain http on the address (works before the certificate is trusted and where
      // .local names don't resolve); the page moves itself to the secure name when it can.
      qr: `http://${ip}:${this.port + 1}/${q}&h=${encodeURIComponent(this.host)}&p=${this.port}`,
      secure: `https://${this.host}:${this.port}/`,
      plain: `http://${ip}:${this.port + 1}/`,
      ip, host: this.host, port: this.port, all: ips.map((i) => i.address),
    };
  }

  view() {
    const online = (id) => this.socks.has(id);
    return {
      on: !!this.cfg.on,
      running: this.running,
      error: this.error || (this.mdns && this.mdns.error ? `Network name: ${this.mdns.error}` : ''),
      code: this.running ? this.code : '',
      links: this.running ? this.links() : null,
      screenAllowed: this.cfg.screen !== false,
      screen: { ...this.screen, dev: this.screenDev },
      cam: this.camRecv ? this.camRecv.view() : null,
      clip: { text: this.clip.text.slice(0, 2000), at: this.clip.at },
      devices: this.devices.map((d) => {
        const set = this.socks.get(d.id);
        const ws = set && [...set][0];
        return {
          id: d.id, name: d.name, os: d.os, model: d.model || '', pairedAt: d.pairedAt, lastSeen: d.lastSeen, ip: ws ? ws.ip : d.lastIp || '',
          online: online(d.id), secure: ws ? ws.secure : null, notifs: !!d.notifs, remote: this.remoteBus.dev === d.id,
          push: !!d.push, alerts: this._alertsOf(d), background: !!(ws && [...set].every((x) => x.hidden)),
          watching: this.screenDev === d.id ? this.screen : null,
          chat: this._chat(d.id).slice(-80).map((x) => ({ ...this._public(x), path: x.file ? x.file.path : undefined })),
        };
      }).sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen),
    };
  }
}

module.exports = { WebHub, DEFAULT_PORT };

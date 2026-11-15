// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General › Local API (Mac, Windows, Linux; off unless switched on): for the person's own scripts
// and tools on this computer (a Shortcut, a script, a launcher) to use TwinDesk:
//   GET  /v1/status                      → {connected, device}
//   POST /v1/send       {"paths": [...]} → the files go as Send files does (or wait for the device)
//   POST /v1/clipboard  {"text": "…"}    → on this computer's clipboard, shared by Clipboard's rules
// Only this computer: it listens on 127.0.0.1, on a port of its own, and wants the key with every
// request (Authorization: Bearer <key>). Both are written to local-api.json in TwinDesk's own folder
// (readable by this user only), and the key is new each time it starts. A web page can't use it:
// anything a browser sends (an Origin or Sec-Fetch-* header, a Host that isn't 127.0.0.1/localhost)
// is refused, and requests must be JSON.
// Off: no socket, no file.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const MAX_BODY = 256 * 1024;
const FILE = 'local-api.json';

class LocalApi {
  // dir: TwinDesk's own folder (userData). actions: {status() → {connected, device}, send(paths) →
  // 'sent'|'queued'|null, clipboard(text)}.
  constructor({ dir, actions }) {
    this.dir = dir;
    this.actions = actions;
    this.server = null;
    this.port = 0;
    this.token = '';
  }

  get file() { return path.join(this.dir, FILE); }
  get on() { return !!this.server; }

  apply(on) { return on ? this.start() : this.stop(); }

  start() {
    if (this.server) return Promise.resolve(this.port);
    this.token = crypto.randomBytes(24).toString('hex');
    const server = http.createServer((req, res) => this._handle(req, res));
    server.headersTimeout = 10000;
    server.requestTimeout = 15000;
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', (e) => { this.server = null; reject(e); });
      server.listen(0, '127.0.0.1', () => {
        this.port = server.address().port;
        try {
          fs.writeFileSync(this.file, JSON.stringify({ url: `http://127.0.0.1:${this.port}/v1/`, port: this.port, key: this.token }, null, 2) + '\n', { mode: 0o600 });
          try { fs.chmodSync(this.file, 0o600); } catch (_) { /* Windows: the user's own folder */ }
        } catch (e) { console.error('[api] ' + e.message); }
        resolve(this.port);
      });
    });
  }

  stop() {
    const s = this.server;
    this.server = null;
    this.port = 0;
    this.token = '';
    try { fs.rmSync(this.file, { force: true }); } catch (_) {}
    return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
  }

  view() { return { on: this.on, file: this.on ? this.file : '' }; }

  _handle(req, res) {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const h = req.headers;
    // A browser: never (a page could otherwise try ports on 127.0.0.1).
    if (h.origin || h['sec-fetch-site'] || h['sec-fetch-mode'] || h.referer) return send(403, { error: 'not from a browser' });
    const host = String(h.host || '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return send(403, { error: 'host' });
    const auth = /^Bearer ([0-9a-f]{48})$/i.exec(String(h.authorization || ''));
    if (!auth || !this.token || !crypto.timingSafeEqual(Buffer.from(auth[1].toLowerCase()), Buffer.from(this.token))) return send(401, { error: 'key' });
    const route = `${req.method} ${String(req.url || '').split('?')[0]}`;
    if (route === 'GET /v1/status') return send(200, this.actions.status());
    if (req.method !== 'POST') return send(404, { error: 'not found' });
    if (!/^application\/json\b/i.test(String(h['content-type'] || ''))) return send(415, { error: 'JSON only' });
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { send(413, { error: 'too large' }); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      let body;
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch (_) { return send(400, { error: 'bad JSON' }); }
      if (!body || typeof body !== 'object') return send(400, { error: 'bad JSON' });
      try {
        if (route === 'POST /v1/send') {
          const paths = (Array.isArray(body.paths) ? body.paths : []).filter((p) => typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p)).slice(0, 1000);
          if (!paths.length) return send(400, { error: 'no files' });
          const r = this.actions.send(paths);
          return send(200, { ok: r !== null && r !== false, status: r || 'not sent' });
        }
        if (route === 'POST /v1/clipboard') {
          if (typeof body.text !== 'string' || body.text.length > 200000) return send(400, { error: 'text' });
          this.actions.clipboard(body.text);
          return send(200, { ok: true });
        }
      } catch (e) { return send(500, { error: e.message }); }
      return send(404, { error: 'not found' });
    });
  }
}

module.exports = { LocalApi, FILE };

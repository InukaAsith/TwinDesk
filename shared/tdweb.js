// TwinDesk tdweb — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// HTTPS + WSS web server for the TwinDesk Web portal (iPhone / iPad PWA).
// Supports file drops, clipboard sync, second screen WebRTC streaming,
// and auto-detects both Wi-Fi and high-speed USB-C cable connections.
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
let WebSocketServer;
try {
  WebSocketServer = require('ws').WebSocketServer || require('ws').Server;
} catch (_) {}

class TdWebServer extends EventEmitter {
  constructor({
    getSettings,
    getIdentity,
    getClipboard,
    setClipboard,
    getDownloadsDir,
    onInput,
    webRoot,
  } = {}) {
    super();
    this.getSettings = getSettings || (() => ({}));
    this.getIdentity = getIdentity || (() => ({ name: os.hostname() }));
    this.getClipboard = getClipboard || (() => '');
    this.setClipboard = setClipboard || (() => {});
    this.getDownloadsDir = getDownloadsDir || (() => os.homedir());
    this.onInput = onInput || (() => {});

    const candidates = [
      webRoot,
      path.join(__dirname, '..', 'web'),
      path.join(process.resourcesPath || '', 'web'),
      path.join(process.resourcesPath || '', 'app', 'web'),
    ].filter(Boolean);
    this.webRoot = candidates.find((p) => fs.existsSync(p)) || path.join(__dirname, '..', 'web');

    this.server = null;
    this.wss = null;
    this.port = 47802;
    this.token = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6-character auth token
    this.clients = new Set();
    this.devices = new Map(); // ws -> { id, name, os, kind, via, connected, ip, rtt }
    this.activeDeviceId = null;
    this.sharedFiles = new Map(); // id -> { id, name, path, size, mime }
    this.chats = []; // in-memory chat/drop stream history
    this.running = false;
  }

  // Scans all network interfaces and identifies Wi-Fi vs. USB Cable
  static getNetworkLinks(port = 47802, token = '') {
    const ifaces = os.networkInterfaces();
    let wifiIp = null;
    let cableIp = null;

    for (const [name, addrs] of Object.entries(ifaces)) {
      if (!Array.isArray(addrs)) continue;
      const lower = name.toLowerCase();
      const isCableIface = lower.includes('apple') || lower.includes('usb') ||
                           lower.includes('rndis') || lower.includes('ncm') ||
                           lower.includes('gadget') || lower.includes('en5') || lower.includes('en6');

      for (const addr of addrs) {
        if (addr.family !== 'IPv4' || addr.internal) continue;
        const ip = addr.address;

        // Subnet 172.20.10.x is iOS USB tethering / personal hotspot
        // Subnet 169.254.x.x is link-local direct cable network
        if (ip.startsWith('172.20.10.') || (ip.startsWith('169.254.') && isCableIface)) {
          cableIp = ip;
        } else if (!wifiIp && (ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip))) {
          wifiIp = ip;
        }
      }
    }

    const tParam = token ? `?token=${token}` : '';
    return {
      wifiIp,
      cableIp,
      cableConnected: !!cableIp,
      wifiUrl: wifiIp ? `https://${wifiIp}:${port}/${tParam}` : null,
      cableUrl: cableIp ? `https://${cableIp}:${port}/${tParam}` : null,
      port,
      token,
    };
  }

  start({ port = 47802, credentials = {} } = {}) {
    if (this.server) return;
    this.port = port;

    const handler = (req, res) => this._handleHttp(req, res);

    // Use TLS credentials if provided, else fallback to HTTP for development
    if (credentials.key && credentials.cert) {
      this.server = https.createServer({ key: credentials.key, cert: credentials.cert }, handler);
    } else if (credentials.pfx) {
      this.server = https.createServer({ pfx: credentials.pfx, passphrase: credentials.passphrase }, handler);
    } else {
      // Create self-signed TLS fallback on the fly if needed
      this.server = http.createServer(handler);
    }

    if (WebSocketServer) {
      this.wss = new WebSocketServer({ noServer: true });
      this.server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        if (url.pathname === '/ws') {
          const clientToken = url.searchParams.get('token');
          if (clientToken !== this.token) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.wss.emit('connection', ws, req);
          });
        } else {
          socket.destroy();
        }
      });

      this.wss.on('connection', (ws) => this._handleWs(ws));
    }

    this.server.listen(port, '0.0.0.0', () => {
      this.running = true;
      const links = TdWebServer.getNetworkLinks(this.port, this.token);
      this.emit('started', links);
    });

    this.server.on('error', (err) => {
      this.running = false;
      this.emit('error', err);
    });
  }

  stop() {
    if (!this.server) return;
    for (const ws of this.clients) {
      try { ws.close(); } catch (_) {}
    }
    this.clients.clear();
    this.devices.clear();
    this.activeDeviceId = null;
    try { this.server.close(); } catch (_) {}
    this.server = null;
    this.wss = null;
    this.running = false;
    this.emit('stopped');
  }

  getDevices() {
    const arr = Array.from(this.devices.values());
    return arr.map((d) => ({
      id: d.id,
      name: d.name,
      os: d.os || 'ios',
      kind: d.kind || 'phone',
      via: d.via || 'Wi-Fi',
      connected: !!d.connected,
      selected: d.id === this.activeDeviceId || (!this.activeDeviceId && arr[0] && arr[0].id === d.id),
      sub: (d.via || 'Wi-Fi') + ' · Connected',
      rtt: d.rtt || 1,
      isWeb: true,
    }));
  }

  selectDevice(id) {
    this.activeDeviceId = id;
    this.emit('devices-change', this.getDevices());
  }

  getActiveDevice() {
    if (!this.devices.size) return null;
    if (this.activeDeviceId) {
      for (const d of this.devices.values()) {
        if (d.id === this.activeDeviceId) return d;
      }
    }
    return Array.from(this.devices.values())[0] || null;
  }

  disconnectDevice(id) {
    for (const [ws, d] of this.devices.entries()) {
      if (d.id === id) {
        try { ws.close(); } catch (_) {}
        this.devices.delete(ws);
        break;
      }
    }
    if (this.activeDeviceId === id) {
      const remaining = Array.from(this.devices.values());
      this.activeDeviceId = remaining[0] ? remaining[0].id : null;
    }
    this.emit('devices-change', this.getDevices());
  }

  broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === 1) { // OPEN
        try { ws.send(payload); } catch (_) {}
      }
    }
  }

  offerFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    const id = crypto.randomBytes(6).toString('hex');
    const name = path.basename(filePath);
    const info = { id, name, path: filePath, size: stat.size };
    this.sharedFiles.set(id, info);

    this.broadcast({
      t: 'file-offer',
      id,
      name,
      size: stat.size,
      url: `/api/download/${id}`,
    });
    return info;
  }

  notifyClipboard(text) {
    if (this._lastNotifiedClipboard === text) return;
    this._lastNotifiedClipboard = text;
    this.broadcast({ t: 'clipboard-update', text });
  }

  sendChat(text, toClipboard = false) {
    const msg = {
      t: 'chat',
      id: crypto.randomBytes(4).toString('hex'),
      from: 'host',
      text: String(text || '').slice(0, 10000),
      time: Date.now(),
      toClipboard: !!toClipboard,
    };
    this.chats.push(msg);
    if (this.chats.length > 50) this.chats.shift();
    this.broadcast(msg);
    this.emit('chat', msg);
    this.emit('chats-change', this.chats);
    return msg;
  }

  getChats() {
    return this.chats.slice();
  }

  _handleHttp(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // CORS headers for local LAN API access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // API: File Upload from phone -> stream to downloads folder
    if (pathname === '/api/upload' && req.method === 'POST') {
      const clientToken = url.searchParams.get('token');
      if (clientToken !== this.token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }

      const rawName = url.searchParams.get('name') || 'upload-' + Date.now();
      const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_');
      const destDir = this.getDownloadsDir();
      const destPath = path.join(destDir, safeName);

      const writeStream = fs.createWriteStream(destPath);
      let bytes = 0;

      req.on('data', (chunk) => {
        bytes += chunk.length;
        writeStream.write(chunk);
      });

      req.on('end', () => {
        writeStream.end();
        this.emit('file-received', { name: safeName, path: destPath, size: bytes });
        this.broadcast({
          t: 'file-uploaded',
          name: safeName,
          size: bytes,
          from: 'phone',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: safeName, size: bytes }));
      });

      req.on('error', (err) => {
        writeStream.destroy();
        try { fs.unlinkSync(destPath); } catch (_) {}
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    // API: File Download from computer -> stream to phone
    if (pathname.startsWith('/api/download/') && req.method === 'GET') {
      const id = pathname.slice('/api/download/'.length);
      const file = this.sharedFiles.get(id);
      if (!file || !fs.existsSync(file.path)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('File not found');
      }

      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`,
        'Content-Length': file.size,
      });
      const readStream = fs.createReadStream(file.path);
      readStream.pipe(res);
      return;
    }

    // API: Status
    if (pathname === '/api/status' && req.method === 'GET') {
      const links = TdWebServer.getNetworkLinks(this.port, this.token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        host: os.hostname(),
        name: this.getIdentity().name || 'TwinDesk',
        cableConnected: links.cableConnected,
        clipboard: this.getClipboard(),
      }));
    }

    // Icon route: serves shared/icon directly without copying
    if (pathname.startsWith('/icon/')) {
      const iconName = path.basename(pathname);
      const iconPath = path.join(__dirname, 'icon', iconName);
      if (fs.existsSync(iconPath)) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        return fs.createReadStream(iconPath).pipe(res);
      }
    }

    // Static Web Assets (PWA)
    let filePath = path.join(this.webRoot, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(this.webRoot, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
    };
    const contentType = mimes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not Found');
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  }

  _handleWs(ws) {
    this.clients.add(ws);
    const remoteIp = (ws._socket && ws._socket.remoteAddress) || '';
    const isCable = remoteIp.includes('172.20.10.') || remoteIp.includes('169.254.');
    const defaultVia = isCable ? 'Cable' : 'Wi-Fi';
    const devId = 'web-' + crypto.randomBytes(3).toString('hex');
    const dev = {
      id: devId,
      name: 'Web Device',
      os: 'ios',
      kind: 'phone',
      via: defaultVia,
      connected: true,
      ip: remoteIp,
      rtt: 1,
    };
    this.devices.set(ws, dev);
    if (!this.activeDeviceId) this.activeDeviceId = devId;

    this.emit('client-connected', { count: this.clients.size, device: dev });
    this.emit('devices-change', this.getDevices());

    // Send initial greeting with current clipboard and host identity
    ws.send(JSON.stringify({
      t: 'welcome',
      host: os.hostname(),
      name: this.getIdentity().name || 'TwinDesk',
      clipboard: this.getClipboard(),
      deviceId: devId,
      via: defaultVia,
      pairCode: this.token,
      chats: this.chats.slice(-20),
    }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8'));
        this._onWsMessage(ws, msg);
      } catch (_) {}
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      const d = this.devices.get(ws);
      this.devices.delete(ws);
      if (d && this.activeDeviceId === d.id) {
        const remaining = Array.from(this.devices.values());
        this.activeDeviceId = remaining[0] ? remaining[0].id : null;
      }
      this.emit('client-disconnected', { count: this.clients.size, device: d });
      this.emit('devices-change', this.getDevices());
    });
  }

  _onWsMessage(ws, m) {
    if (!m || typeof m !== 'object') return;

    if (m.t === 'client-info') {
      const d = this.devices.get(ws) || {};
      if (m.id) d.id = m.id;
      if (m.name) d.name = m.name;
      if (m.os) d.os = m.os;
      if (m.kind) d.kind = m.kind;
      if (m.via) d.via = m.via;
      this.devices.set(ws, d);
      this.emit('devices-change', this.getDevices());
    } else if (m.t === 'dev-action') {
      this.emit('dev-action', { action: m.action, value: m.value, device: this.devices.get(ws) });
    } else if (m.t === 'disconnect') {
      try { ws.close(); } catch (_) {}
    } else if (m.t === 'chat') {
      // Broadcast chat message to all connected clients and host
      const out = {
        t: 'chat',
        id: crypto.randomBytes(4).toString('hex'),
        from: m.from || 'phone',
        text: String(m.text || '').slice(0, 5000),
        time: Date.now(),
        toClipboard: !!m.toClipboard,
      };
      this.chats.push(out);
      if (this.chats.length > 50) this.chats.shift();
      this.broadcast(out);
      this.emit('chat', out);
      this.emit('chats-change', this.chats);

      // If text came from phone and user wants direct clipboard injection
      if (m.from === 'phone' && m.toClipboard) {
        this.setClipboard(out.text);
      }
    } else if (m.t === 'clipboard-set') {
      const text = String(m.text || '').slice(0, 500000);
      this.setClipboard(text);
      this.broadcast({ t: 'clipboard-update', text });
    } else if (m.t === 'clipboard-get') {
      ws.send(JSON.stringify({ t: 'clipboard-update', text: this.getClipboard() }));
    } else if (m.t === 'rtc-request') {
      this.emit('webrtc-request', { ws, kind: m.kind || 'screen' });
    } else if (m.t === 'rtc-offer' || m.t === 'rtc-answer' || m.t === 'rtc-ice') {
      // Forward WebRTC signals between host and client
      this.emit('webrtc-signal', m, ws);
    } else if (m.t === 'pointer') {
      // Apple Pencil / Touch event from iPad viewer
      this.onInput(m);
    }
  }
}

module.exports = { TdWebServer };

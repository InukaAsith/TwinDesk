// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// An iPhone's or iPad's session through its USB cable (ios/TwinDesk/Core/Usb.swift there). usbmuxd
// (the way Finder, Xcode and QuickTime reach a cabled, trusted device: macOS's own, Apple Mobile
// Device Service on Windows on TCP 127.0.0.1:27015, the usbmuxd package on Linux) connects to a
// TCP port on the device; nothing like `adb reverse` goes the other way. So this keeps a few
// connections open to the app's port (47820) on every iOS device on a cable, each greeted with
// this computer's id and name; when the app wants one of this computer's ports it writes "OPEN <port>" on one
// and this joins it to 127.0.0.1:<port> here (the session's server, the relay for WebRTC, the
// files engine: allowed() says which), and opens another to wait. To the server the session comes
// from 127.0.0.1, as an Android phone's through adb does: wired, its WebRTC through the relay.
// Without TwinDesk running on the device the connections are refused, and are tried again now and then.
//
// usbmuxd's protocol: a 16-byte little-endian header (length, version 1, type 8 = plist, tag) and
// an XML property list: Listen (Attached / Detached events), Connect {DeviceID, PortNumber in
// network byte order}; after a Connect's Result 0 the socket is the device's port.
'use strict';

const net = require('net');
const { EventEmitter } = require('events');

const SOCK = process.platform === 'win32' ? { host: '127.0.0.1', port: 27015 } : '/var/run/usbmuxd';
const APP_PORT = 47820;
const POOL = 3; // connections kept waiting per device
const RETRY_MS = 4000;
const MAX_LINE = 200;

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist(obj) {
  const v = (x) => (typeof x === 'number' ? `<integer>${x | 0}</integer>` : typeof x === 'boolean' ? (x ? '<true/>' : '<false/>') : `<string>${xmlEsc(x)}</string>`);
  const body = Object.entries(obj).map(([k, x]) => `<key>${xmlEsc(k)}</key>${v(x)}`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>`;
}

// The few things usbmuxd answers with: a dict of strings, integers and one nested dict (Properties).
function parse(xml) {
  const tokens = xml.match(/<key>[^<]*<\/key>|<string>[^<]*<\/string>|<string\/>|<integer>-?\d+<\/integer>|<true\/>|<false\/>|<dict>|<\/dict>|<data>[^<]*<\/data>|<array>|<\/array>/g) || [];
  let i = 0;
  const val = () => {
    const t = tokens[i++];
    if (!t) return undefined;
    if (t === '<dict>') {
      const o = {};
      while (i < tokens.length && tokens[i] !== '</dict>') {
        const k = /<key>([^<]*)<\/key>/.exec(tokens[i++]);
        o[k ? k[1] : ''] = val();
      }
      i++;
      return o;
    }
    if (t === '<array>') {
      const a = [];
      while (i < tokens.length && tokens[i] !== '</array>') a.push(val());
      i++;
      return a;
    }
    if (t === '<true/>') return true;
    if (t === '<false/>') return false;
    if (t === '<string/>') return '';
    let m = /<string>([^<]*)<\/string>/.exec(t);
    if (m) return m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    m = /<integer>(-?\d+)<\/integer>/.exec(t);
    if (m) return Number(m[1]);
    return null;
  };
  while (i < tokens.length && tokens[i] !== '<dict>') i++;
  return val() || {};
}

// One usbmuxd conversation: send(dict, tag) and 'message' events with each answer.
class Mux extends EventEmitter {
  constructor() {
    super();
    this.buf = Buffer.alloc(0);
    this.sock = net.connect(SOCK);
    this.sock.on('connect', () => this.emit('open'));
    this.sock.on('error', (e) => this.emit('error', e));
    this.sock.on('close', () => this.emit('close'));
    this.raw = false; // after Connect succeeded: the socket is the device's port
    this.sock.on('data', (d) => {
      if (this.raw) return;
      this.buf = Buffer.concat([this.buf, d]);
      while (this.buf.length >= 16) {
        const len = this.buf.readUInt32LE(0);
        if (len < 16 || len > 1 << 20) return this.sock.destroy();
        if (this.buf.length < len) return;
        const body = this.buf.subarray(16, len).toString('utf8');
        const rest = this.buf.subarray(len);
        this.buf = Buffer.alloc(0);
        this.emit('message', parse(body), rest);
        if (this.raw) return; // the rest belongs to the device's port
        this.buf = rest;
      }
    });
  }

  send(obj, tag = 1) {
    const body = Buffer.from(plist({ ClientVersionString: 'TwinDesk', ProgName: 'TwinDesk', kLibUSBMuxVersion: 3, ...obj }), 'utf8');
    const h = Buffer.alloc(16);
    h.writeUInt32LE(16 + body.length, 0);
    h.writeUInt32LE(1, 4);
    h.writeUInt32LE(8, 8);
    h.writeUInt32LE(tag, 12);
    this.sock.write(Buffer.concat([h, body]));
  }

  close() { this.sock.destroy(); }
}

class IosNet extends EventEmitter {
  // getId / getName: this computer's; allowed(port): whether the app may reach that port here.
  constructor({ getId, getName, allowed }) {
    super();
    Object.assign(this, { getId, getName, allowed });
    this.devices = new Map(); // DeviceID -> {serial, waiting: Set<sock>, retry, failing}
    this.listener = null;
    this.stopped = false;
    this._listen();
  }

  get view() {
    return { devices: [...this.devices.values()].map((d) => ({ serial: d.serial, app: d.app })) };
  }

  _listen() {
    if (this.stopped) return;
    const m = new Mux();
    this.listener = m;
    m.on('open', () => m.send({ MessageType: 'Listen' }));
    m.on('message', (msg) => {
      if (msg.MessageType === 'Attached' && msg.Properties && msg.Properties.ConnectionType === 'USB') this._attached(msg.DeviceID, msg.Properties.SerialNumber || '');
      else if (msg.MessageType === 'Detached') this._detached(msg.DeviceID);
    });
    m.on('error', () => {});
    m.on('close', () => {
      for (const id of [...this.devices.keys()]) this._detached(id);
      if (!this.stopped) setTimeout(() => this._listen(), RETRY_MS); // usbmuxd restarted (or isn't there)
    });
  }

  _attached(id, serial) {
    if (this.devices.has(id)) return;
    this.devices.set(id, { serial, waiting: new Set(), retry: null, app: false });
    this._fill(id);
  }

  _detached(id) {
    const d = this.devices.get(id);
    if (!d) return;
    clearTimeout(d.retry);
    for (const s of d.waiting) s.destroy();
    this.devices.delete(id);
    if (d.app) this.emit('change');
  }

  // Keep POOL connections waiting on the device's app.
  _fill(id) {
    const d = this.devices.get(id);
    if (!d || this.stopped) return;
    while (d.waiting.size + (d.opening || 0) < POOL) this._open(id, d);
  }

  _open(id, d) {
    d.opening = (d.opening || 0) + 1;
    const m = new Mux();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      d.opening--;
      if (ok) return;
      m.close();
      if (d.app) { d.app = false; this.emit('change'); }
      clearTimeout(d.retry);
      if (this.devices.get(id) === d) d.retry = setTimeout(() => this._fill(id), RETRY_MS); // TwinDesk isn't running there
    };
    m.on('open', () => m.send({ MessageType: 'Connect', DeviceID: id, PortNumber: ((APP_PORT & 0xff) << 8) | (APP_PORT >> 8) }));
    m.on('message', (msg, rest) => {
      if (msg.MessageType !== 'Result') return;
      if (msg.Number !== 0) return done(false);
      m.raw = true;
      done(true);
      if (!d.app) { d.app = true; this.emit('change'); }
      this._waiting(id, d, m.sock, rest);
    });
    m.on('error', () => done(false));
    m.on('close', () => done(false));
  }

  // A connection to the app: greet it, then wait for "OPEN <port>".
  _waiting(id, d, sock, rest) {
    d.waiting.add(sock);
    sock.setNoDelay(true);
    sock.write(`TDUSB1 ${this.getId()} ${encodeURIComponent(this.getName() || 'Mac')}\n`);
    let line = rest && rest.length ? Buffer.from(rest) : Buffer.alloc(0);
    const gone = () => {
      if (d.waiting.delete(sock)) setTimeout(() => this._fill(id), 200);
    };
    const onData = (chunk) => {
      line = Buffer.concat([line, chunk]);
      const nl = line.indexOf(10);
      if (nl < 0) { if (line.length > MAX_LINE) sock.destroy(); return; }
      sock.removeListener('data', onData);
      const m = /^OPEN (\d{1,5})$/.exec(line.subarray(0, nl).toString('utf8').trim());
      const after = line.subarray(nl + 1);
      d.waiting.delete(sock);
      this._fill(id); // another one waits in its place
      const port = m ? Number(m[1]) : 0;
      if (!port || !this.allowed(port)) return sock.destroy();
      this._join(sock, port, after);
    };
    sock.on('data', onData);
    sock.on('error', () => {});
    sock.on('close', gone);
  }

  _join(dev, port, first) {
    const local = net.connect({ host: '127.0.0.1', port });
    local.setNoDelay(true);
    dev.pause();
    local.on('connect', () => {
      if (first && first.length) local.write(first);
      dev.pipe(local);
      local.pipe(dev);
      dev.resume();
    });
    const end = () => { dev.destroy(); local.destroy(); };
    local.on('error', end);
    local.on('close', end);
    dev.on('close', end);
    dev.on('error', end);
  }

  stop() {
    this.stopped = true;
    if (this.listener) this.listener.close();
    for (const id of [...this.devices.keys()]) this._detached(id);
  }
}

module.exports = { IosNet, APP_PORT };

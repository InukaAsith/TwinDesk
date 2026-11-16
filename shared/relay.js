// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Your own relay (General › Your own relay): a server you run (relay/twindesk-relay.js, on any
// machine both can reach) that a phone away from this computer's network connects through. Off
// until an address is added; nothing else changes:
//   - The relay only pairs two connections and copies bytes. The session inside is the same TLS
//     with the pinned certificate and the same token as on the local network, so the relay sees
//     neither what's sent nor who the devices are (only an id it can't turn back into one).
//   - The phone tries it only when it can't see this computer on its network, every other attempt
//     (as with Tailscale), and only for a computer that told it about the relay.
//   - The relay's key (if it has one) keeps strangers from using it; it isn't the session's key.
// This computer keeps one idle connection to the relay while an address is set (a ping each
// minute), and opens another for each phone that asks; that one goes straight into the session's
// server (server.https 'connection'), so to the server it's a network connection like any other.
//
// Wire (line-based until spliced, then raw bytes):
//   computer → relay: "TDR1 host <id> <key>\n"         ← "ok\n", later "call <n>\n" per phone, "pong\n"
//   computer → relay: "ping\n" (each minute)
//   computer → relay (new socket): "TDR1 take <id> <n> <key>\n" ← "ok\n", then the phone's bytes
//   phone    → relay: "TDR1 join <id> <key>\n"          ← "ok\n" once the computer took it, "no\n" if absent
//
//   const r = new RelayHost({ server, addr: 'relay.example.com:47100', key, id }); r.start(); r.stop()
//   RelayHost.idOf(certFingerprint) → the id; parseAddr('host:port') → {host, port} | null
'use strict';

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const DEFAULT_PORT = 47100;
const PING_MS = 60000;
const DEAD_MS = 150000; // no pong this long: the control connection is gone
const TAKE_MS = 10000;

// "host", "host:port", "[v6]:port" → {host, port}; anything else null.
function parseAddr(s) {
  const v = String(s || '').trim();
  if (!v || v.length > 255 || /[\s/@]/.test(v)) return null;
  let m = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(v);
  if (!m) m = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(v);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : DEFAULT_PORT;
  return port > 0 && port < 65536 ? { host: m[1], port } : null;
}

const cleanKey = (k) => String(k || '').replace(/[^\x21-\x7e]/g, '').slice(0, 128);
// The id a phone asks the relay for: from this computer's certificate, not its name or address.
const idOf = (fp) => crypto.createHash('sha256').update(`twindesk-relay:${String(fp || '')}`).digest('hex').slice(0, 32);

// Reads one "\n"-ended line from a socket, then hands back what came after it.
function readLine(sock, ms, cb) {
  let buf = Buffer.alloc(0);
  let done = false;
  const finish = (err, line, rest) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    sock.removeListener('data', onData);
    sock.removeListener('error', onErr);
    sock.removeListener('close', onClose);
    cb(err, line, rest);
  };
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    const i = buf.indexOf(10);
    if (i >= 0) finish(null, buf.slice(0, i).toString('utf8').trim(), buf.slice(i + 1));
    else if (buf.length > 512) finish(new Error('bad reply'));
  };
  const onErr = (e) => finish(e);
  const onClose = () => finish(new Error('closed'));
  const timer = setTimeout(() => finish(new Error('timed out')), ms);
  sock.on('data', onData);
  sock.on('error', onErr);
  sock.on('close', onClose);
}

class RelayHost extends EventEmitter {
  // server: the session's server (its .https takes the relayed connections).
  constructor({ server, addr, key = '', id }) {
    super();
    this.server = server;
    this.to = parseAddr(addr);
    this.key = cleanKey(key) || '-';
    this.id = id;
    this.ctl = null;
    this.state = 'off'; // off | connecting | ready | failed
    this.error = '';
    this.wait = 5000;
    this.timer = null;
    this.running = false;
  }

  get view() { return { state: this.state, error: this.error }; }

  start() {
    if (this.running || !this.to || !this.id) return;
    this.running = true;
    this._connect();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    clearInterval(this.ping);
    if (this.ctl) this.ctl.destroy();
    this.ctl = null;
    this._set('off');
  }

  _set(state, error = '') {
    if (state === this.state && error === this.error) return;
    this.state = state;
    this.error = error;
    this.emit('state', this.view);
  }

  _retry(err) {
    clearInterval(this.ping);
    this.ctl = null;
    if (!this.running) return;
    this._set('failed', err);
    this.timer = setTimeout(() => this._connect(), this.wait);
    this.wait = Math.min(this.wait * 2, 5 * 60000);
  }

  _connect() {
    if (!this.running) return;
    this._set('connecting');
    const s = net.connect({ host: this.to.host, port: this.to.port });
    this.ctl = s;
    s.setNoDelay(true);
    s.setKeepAlive(true, 30000);
    let failed = false;
    const fail = (e) => { if (failed) return; failed = true; s.destroy(); if (this.ctl === s) this._retry(e); };
    s.once('connect', () => s.write(`TDR1 host ${this.id} ${this.key}\n`));
    readLine(s, 10000, (err, line, rest) => {
      if (err || line !== 'ok') return fail(err ? err.message : line === 'key' ? 'The relay’s key is wrong' : 'Not a TwinDesk relay');
      this.wait = 5000;
      this._set('ready');
      let buf = rest.toString('utf8');
      let last = Date.now();
      this.ping = setInterval(() => {
        if (Date.now() - last > DEAD_MS) return fail('The relay stopped answering');
        s.write('ping\n');
      }, PING_MS);
      const lines = (d) => {
        last = Date.now();
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          const m = /^call (\d{1,9})$/.exec(l);
          if (m) this._take(m[1]);
        }
        if (buf.length > 4096) fail('bad reply');
      };
      s.on('data', lines);
      lines(Buffer.alloc(0));
      s.on('error', (e) => fail(e.message));
      s.on('close', () => fail('The relay closed the connection'));
    });
    s.on('error', (e) => fail(e.code === 'ECONNREFUSED' ? 'Nothing answers at that address' : e.code === 'ENOTFOUND' ? 'No such address' : e.message));
  }

  // A phone asked: a connection of its own, handed to the session's server once spliced.
  _take(n) {
    const s = net.connect({ host: this.to.host, port: this.to.port });
    s.setNoDelay(true);
    s.once('connect', () => s.write(`TDR1 take ${this.id} ${n} ${this.key}\n`));
    s.on('error', () => s.destroy());
    readLine(s, TAKE_MS, (err, line, rest) => {
      if (err || line !== 'ok' || !this.server || !this.server.https) return s.destroy();
      if (rest.length) s.unshift(rest);
      this.server.https.emit('connection', s);
      this.emit('relayed');
    });
  }
}

// What the computer tells a device it pairs with (welcome.relay): set by the app (use()).
let current = () => null;
function use(fn) { current = typeof fn === 'function' ? fn : () => null; }
function welcome() {
  const r = current();
  return r && r.addr && r.id ? { addr: r.addr, key: cleanKey(r.key), id: r.id } : undefined;
}

// settings.net.relay as kept: {addr, key} (addr '' = none).
function clean(r) {
  const addr = r && parseAddr(r.addr) ? String(r.addr).trim() : '';
  return { addr, key: addr ? cleanKey(r && r.key) : '' };
}

// The app's one relay: started, changed or stopped from settings.net.relay (each app calls
// apply() on start and when the setting changes; nothing runs while no address is set).
let host = null;
let applied = '';
function apply({ server, fp, relay, onState = () => {} }) {
  const r = clean(relay);
  const k = JSON.stringify([r, fp]);
  if (k === applied) return;
  applied = k;
  if (host) host.stop();
  host = null;
  if (r.addr && server && fp) {
    host = new RelayHost({ server, addr: r.addr, key: r.key, id: idOf(fp) });
    host.on('state', onState);
    host.start();
  }
  use(() => (host ? { addr: r.addr, key: r.key, id: idOf(fp) } : null));
}
const view = () => (host ? { ...host.view, addr: host.to ? `${host.to.host}:${host.to.port}` : '' } : { state: 'off', error: '', addr: '' });

module.exports = { RelayHost, parseAddr, idOf, cleanKey, clean, readLine, use, welcome, apply, view, DEFAULT_PORT };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The one session this computer has, whichever side opened it (
// copy of windows/peer.js):
//   guest — we connected to a Mac or another computer (link.js), the usual case;
//   host  — a PC or another Linux computer connected to our server (server.js + hostpair.js).
// Feature code talks to this object exactly as it used to talk to link.js: on(type | 'welcome' |
// 'closed'), onState(), send(), snapshot(), bufferedAmount. As a host this computer is in its
// non-native role, so every message goes through P.swapRole both ways (like mac/peer.js).
'use strict';

const P = require('../shared/protocol.js');

// The Mac's apps (app.*) only come from a Mac; app windows (papp.*) with a PC or a Linux computer.
// Terminal (ssh.*) works with every computer.
const MAC_ONLY = /^app\./;

class Peer {
  constructor(link) {
    this.link = link;
    this.server = null;
    this.pairing = null;
    this.host = { on: false, error: '' }; // our server: listening or why not
    this.handlers = new Map();
    this.stateFns = [];
    this.unknown = new Set();
    this.swapIn = null;
    this.swapOut = null;
    this.hold = null; // (msg) -> true: held for Wi-Fi (netlink.js), sent later through sendNow
    this.tap = null; // (msg): every message from the peer (netlink.js)

    link.onState(() => this._changed());
    link.onAny = (msg) => this._deliver(msg);
    link.on('welcome', (msg) => this._emit('welcome', msg));
    link.on('closed', (msg) => this._emit('closed', msg));
    link.on('transport', () => { this._emit('transport', {}); this._changed(); });
  }

  // The host role, once identity.js has a certificate.
  attachHost(server, pairing) {
    this.server = server;
    this.pairing = pairing;
    server.on('listening', () => { this.host = { on: true, error: '' }; this._changed(); });
    server.on('listenError', (err) => {
      console.error('[server]', err.code || err.message);
      this.host = { on: false, error: err.code === 'EADDRINUSE' ? 'Port ' + P.PORT + ' is in use (another copy of TwinDesk?)' : err.code || err.message };
      this._changed();
    });
    server.on('client', (ctx) => {
      this.swapIn = P.newRoleSwapState(ctx.name);
      this.swapOut = P.newRoleSwapState(ctx.name);
      this._changed();
      this._emit('welcome', { macId: ctx.deviceId, macName: ctx.name, os: ctx.os });
    });
    server.on('closed', (ctx) => {
      if (ctx.authed && !server.current) {
        this._emit('closed', {});
        this._changed();
      }
    });
    server.on('rtt', () => this._changed());
    server.on('transport', (ctx) => {
      if (ctx !== server.current) return;
      this._emit('transport', {});
      this._changed();
    });
    server.on('message', (msg, ctx) => {
      if (ctx !== server.current) return;
      for (const m of P.swapRole(msg, this.swapIn)) this._deliver(m);
    });
    pairing.on('change', () => this._changed());
    pairing.on('request', () => this._changed());
  }

  // ---- what features use (same as link.js) ----

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  onState(fn) {
    this.stateFns.push(fn);
  }

  get hosting() {
    return !!(this.server && this.server.current);
  }

  // The other computer's OS while a session runs (else the stored pairing's).
  get peerOs() {
    if (this.hosting) return this.server.current.os || P.OS.WIN;
    const p = this.link.snapshot().paired;
    return p ? p.os : P.OS.MAC;
  }

  // The session for netlink.js: {deviceId, os, role ('guest' = they connected to us), transport}.
  get current() {
    if (this.hosting) {
      const c = this.server.current;
      return { deviceId: c.deviceId, os: c.os || P.OS.WIN, role: 'guest', transport: c.transport === 'ble' ? 'ble' : 'ip', address: c.address };
    }
    if (!this.link.authed) return null;
    const p = this.link.snapshot().paired;
    return p && { deviceId: p.macId, os: p.os, role: 'host', transport: this.link.transport === 'ble' ? 'ble' : 'ip', address: p.address };
  }

  send(obj) {
    if (!obj || !this._allowed(obj.t)) return false;
    // Through Bluetooth, files wait for Wi-Fi (netlink.js); they come back through sendNow.
    if (this.hold && this.hold(obj)) return true;
    return this.sendNow(obj);
  }

  sendNow(obj) {
    if (!obj || !this._allowed(obj.t)) return false;
    if (!this.hosting) return this.link.send(obj);
    for (const m of P.swapRole(obj, this.swapOut)) this.server.send(this.server.current, m);
    return true;
  }

  // A message as if the peer had sent it (the phone bridge answers for the phone's input).
  inject(msg) {
    if (this.hosting) this._deliver(msg);
  }

  // link.js's status shape: {state, rtt, message}.
  get status() {
    if (!this.hosting) return this.link.status;
    return { state: 'connected', rtt: this.server.current.rttMs, message: '' };
  }

  // Last time anything arrived (kvm.js silence check).
  get lastRx() {
    return this.hosting ? this.server.current.lastRx : this.link.lastRx;
  }

  get bufferedAmount() {
    return this.hosting ? this.server.current.ws.bufferedAmount : this.link.bufferedAmount;
  }

  // Link-shaped snapshot for the UI, plus the host side: guests (paired.json) and a pairing
  // request to Allow/Deny.
  snapshot() {
    const g = this.link.snapshot();
    const c = this.hosting ? this.server.current : null;
    const req = this.pairing && this.pairing.pendingView();
    return {
      link: c ? { state: 'connected', rtt: c.rttMs, message: '', macName: c.name, address: c.address } : g.link,
      pairing: req ? { phase: 'request', role: 'host', macName: req.name, os: req.os, code: req.code || '', allowed: req.allowed, wired: !!req.wired, address: '' } : g.pairing,
      paired: g.paired,
      guests: this.pairing ? this.pairing.list() : [],
      session: c ? { role: 'host', id: c.deviceId, name: c.name, os: c.os || P.OS.WIN }
        : g.link.state === 'connected' && g.paired ? { role: 'guest', id: g.paired.macId, name: g.paired.macName, os: g.paired.os } : null,
      host: { ...this.host },
    };
  }

  // ---- guest side (link.js) ----
  start() { this.link.start(); }
  startPairing(t) { this.link.startPairing(t); }
  confirmCode() { this.link.confirmCode(); }
  cancelPair() {
    if (this.pairing && this.pairing.pending) this.pairing.respond(false);
    else this.link.cancelPair();
  }
  forget() { this.link.forget(); }
  // Connect again or Take over the computer we're a guest of.
  connect(takeover) {
    if (this.hosting) this.server.release(); // switching from a guest of ours to our host
    this.link.connect(takeover);
  }

  // Disconnect, whichever side opened the session: a guest of ours doesn't come back by itself
  // (released), and as a guest we don't reconnect until Connect.
  disconnect() {
    if (this.hosting) this.server.release();
    else this.link.disconnect();
  }

  // Connect on a computer that connects to us: it was invited, and its hello takes the session over.
  expect(id) { if (this.pairing) this.pairing.expect(id); }

  // ---- host side ----
  respondPair(allow) { if (this.pairing) this.pairing.respond(allow); }
  forgetGuest(id) { if (this.pairing) this.pairing.forget(id); }

  _deliver(msg) {
    if (!this._allowed(msg.t)) return;
    if (this.tap) this.tap(msg);
    const fns = this.handlers.get(msg.t);
    if (fns) for (const fn of fns) fn(msg);
    else if (!this.unknown.has(msg.t)) {
      this.unknown.add(msg.t);
      console.log('[peer] ignoring message type', msg.t);
    }
  }

  _allowed(t) {
    if (MAC_ONLY.test(t)) return this.peerOs === P.OS.MAC;
    return true;
  }

  _emit(type, msg) {
    const fns = this.handlers.get(type);
    if (fns) for (const fn of fns) fn(msg);
  }

  _changed() {
    for (const fn of this.stateFns) fn();
  }
}

module.exports = Peer;

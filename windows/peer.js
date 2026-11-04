// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The one session this PC has, whichever side opened it:
//   guest — we connected to a Mac or another computer (link.js), the usual case;
//   host  — another PC or a Linux computer connected to our server (server.js + hostpair.js).
// Feature code talks to this object exactly as it used to talk to link.js: on(type | 'welcome' |
// 'closed'), onState(), send(), snapshot(), bufferedAmount. As a host this PC is in its
// non-native role, so every message goes through P.swapRole both ways (like mac/peer.js).
'use strict';

const P = require('../shared/protocol.js');
const { FastFiles } = require('../shared/fastfile.js');
const { Fx2, fx2Off } = require('../shared/fx2.js');
const { InputLane, laneOff } = require('../shared/inputlane.js');

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

    // Fast files with an app that can (shared/fastfile.js): file bytes over HTTPS on the host's port.
    // … and v2 (shared/fx2.js): through the files engine, a utility process; its server once we host.
    this.fx2 = fx2Off() ? null : new Fx2();
    if (this.fx2) link.fx2Hello = () => this.fx2.client;
    this.fx = new FastFiles({ session: () => this._fxSession(), deliver: (m) => this._deliver(m), send: (m) => this.sendNow(m), fx2: this.fx2 });

    // The input lane (shared/inputlane.js): moves and input over UDP with an app that can.
    this.il = laneOff() ? null : new InputLane();
    if (this.il) {
      this.il.bind();
      link.ilHello = () => this.il.helloField();
    }

    link.onState(() => this._changed());
    link.onAny = (msg) => this.fx.incoming(msg) || this._deliver(msg);
    link.on('welcome', (msg) => {
      this.fx.reset();
      const ws = link.ws;
      if (this.il && !(link.il && link.transport === 'ip' && ws && this.il.accept(link.il, (ws._socket && ws._socket.remoteAddress) || ws.address))) this.il.stop();
      this._emit('welcome', msg);
    });
    link.on('closed', (msg) => {
      this.fx.reset();
      if (this.il && this.il.role === 'guest') this.il.stop();
      this._emit('closed', msg);
    });
    link.on('transport', () => { this._emit('transport', {}); this._changed(); });
  }

  // The host role, once identity.js has a certificate.
  attachHost(server, pairing) {
    this.server = server;
    this.pairing = pairing;
    server.fxOn = true;
    if (this.fx2) {
      this.fx2.listen(server.tls);
      server.fx2Port = () => this.fx2.port;
    }
    if (this.il) server.ilOffer = (ctx) => (ctx.ilOn = this.il.offer(ctx.ilWanted, ctx.address));
    server.https.on('request', (req, res) => {
      if (this.fx.request(req, res)) return;
      if (require('../shared/nativescreen.js').NativeScreen.request(req, res)) return; // a phone's own screen (Mirroring › Native)
      res.writeHead(404);
      res.end();
    });
    server.on('listening', () => { this.host = { on: true, error: '' }; this._changed(); });
    server.on('listenError', (err) => {
      console.error('[server]', err.code || err.message);
      this.host = { on: false, error: err.code === 'EADDRINUSE' || err.code === 'EACCES' ? 'Port ' + P.PORT + ' is in use by another program (another copy of TwinDesk, or one in WSL). Trying again…' : err.code || err.message };
      this._changed();
    });
    server.on('client', (ctx) => {
      this.swapIn = P.newRoleSwapState(ctx.name);
      this.swapOut = P.newRoleSwapState(ctx.name);
      this.fx.reset();
      if (this.il && !ctx.ilOn) this.il.stop();
      this._changed();
      this._emit('welcome', { macId: ctx.deviceId, macName: ctx.name, os: ctx.os });
    });
    server.on('closed', (ctx) => {
      if (ctx.authed && !server.current) {
        this.fx.reset();
        if (this.il && this.il.role === 'host') this.il.stop();
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
      for (const m of P.swapRole(msg, this.swapIn)) if (!this.fx.incoming(m)) this._deliver(m);
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

  // Preserve link.js's authentication gate for features that use this adapter in either role.
  get authed() {
    return !!(this.hosting ? this.server.current.authed : this.link.authed);
  }

  // The other computer's OS while a session runs (else the stored pairing's).
  get peerOs() {
    if (this.hosting) return this.server.current.os || P.OS.WIN;
    const p = this.link.snapshot().paired;
    return p ? p.os : P.OS.MAC;
  }

  // The input lane while it can carry input (started with this session, and not through
  // Bluetooth), or null: input goes on WSS as it always has.
  lane() {
    if (!this.il || !this.il.started) return null;
    if (this.hosting) return this.server.current.transport === 'ble' ? null : this.il;
    return this.link.authed && this.link.transport === 'ip' ? this.il : null;
  }

  // The session for netlink.js: {deviceId, os, role ('guest' = they connected to us), transport}.
  get current() {
    if (this.hosting) {
      const c = this.server.current;
      return { deviceId: c.deviceId, os: c.os || P.OS.WIN, role: 'guest', transport: c.transport === 'ble' ? 'ble' : 'ip', address: c.address };
    }
    if (!this.link.authed) return null;
    const p = this.link.snapshot().paired;
    const address = this.link.transport !== 'ble' && this.link.ws ? this.link.ws.address : p && p.address;
    return p && { deviceId: p.macId, os: p.os, role: 'host', transport: this.link.transport === 'ble' ? 'ble' : 'ip', address };
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

  // For fast files: {host, token, transport, address, port?, fp?}, or null (an older app).
  _fxSession() {
    if (this.hosting) {
      const c = this.server.current;
      return c.fx ? { host: true, token: c.fx, transport: c.transport, address: c.address, fx2: !!c.fx2 } : null;
    }
    const ws = this.link.ws;
    if (!this.link.authed || !this.link.fxToken || !ws || !this.link.pairing) return null;
    return { host: false, token: this.link.fxToken, transport: this.link.transport, address: ws.address, port: ws.port, fp: this.link.pairing.fp, fx2: !!this.link.fx2Port, fx2Port: this.link.fx2Port };
  }

  get bufferedAmount() {
    return this.hosting ? this.server.current.ws.bufferedAmount : this.link.bufferedAmount;
  }

  // The link now, for the log's line every 30 s (shared/applog.js): null when not connected.
  linkSample() {
    const lane = this.lane();
    const lr = lane && lane.up ? lane.rttMs : null; // the input lane's (shared/inputlane.js)
    if (this.hosting) return { rtt: this.server.current.rttMs, lane: lr, queued: this.bufferedAmount || 0 };
    if (!this.link.authed) return null;
    return { rtt: this.link.status.rtt, lane: lr, queued: this.bufferedAmount || 0 };
  }

  // Link-shaped snapshot for the UI, plus the host side: guests (paired.json) and a pairing
  // request to Allow/Deny.
  snapshot() {
    const g = this.link.snapshot();
    const c = this.hosting ? this.server.current : null;
    const req = this.pairing && this.pairing.pendingView();
    return {
      link: c ? { state: 'connected', rtt: c.rttMs, message: '', macName: c.name, address: c.address } : g.link,
      pairing: req ? { phase: 'request', role: 'host', macName: req.name, os: req.os, code: req.code || '', allowed: req.allowed, wired: !!req.wired, qr: !!req.qr, address: '' } : g.pairing,
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

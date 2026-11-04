// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The one session this Mac has, whichever side opened it:
//   host  — a PC or a Mac connected to our server (server.js), the usual case;
//   guest — we connected to another Mac (link.js).
// Feature code talks to this object exactly as it used to talk to the server: on('client'),
// on('closed'), on('t:<type>'), current, sendToClient(msg), send(ctx, msg). As a guest this Mac
// is in its non-native role, so every message goes through P.swapRole both ways.
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { FastFiles } = require('../shared/fastfile.js');
const { Fx2, fx2Off } = require('../shared/fx2.js');
const { InputLane, laneOff } = require('../shared/inputlane.js');

class Peer extends EventEmitter {
  constructor(server, link) {
    super();
    this.server = server;
    this.link = link;
    this.unknown = new Set();
    this.swapIn = null;
    this.swapOut = null;
    // Fast files with an app that can (shared/fastfile.js): file bytes over HTTPS on our port.
    // … and v2 (shared/fx2.js): through the files engine, a utility process with its own server.
    this.fx2 = fx2Off() ? null : new Fx2({ tls: server.tls });
    if (this.fx2) {
      server.fx2Port = () => this.fx2.port;
      link.fx2Hello = () => this.fx2.client;
    }
    this.fx = new FastFiles({ session: () => this._fxSession(), deliver: (m) => this.current && this._deliver(m, this.current), send: (m) => this.sendNow(m), fx2: this.fx2 });
    server.fxOn = true;
    // The input lane (shared/inputlane.js): moves and input over UDP with an app that can.
    this.il = laneOff() ? null : new InputLane();
    if (this.il) {
      this.il.bind();
      link.ilHello = () => this.il.helloField();
      server.ilOffer = (ctx) => (ctx.ilOn = this.il.offer(ctx.ilWanted, ctx.address));
    }
    server.https.on('request', (req, res) => {
      if (this.fx.request(req, res)) return;
      if (require('../shared/nativescreen.js').NativeScreen.request(req, res)) return; // a phone's own screen (Mirroring › Native)
      res.writeHead(404);
      res.end();
    });

    server.on('client', (ctx) => {
      if (!ctx.os) ctx.os = P.OS.WIN;
      ctx.role = 'guest';
      this.fx.reset();
      if (this.il && !ctx.ilOn) this.il.stop();
      this.emit('client', ctx);
    });
    server.on('closed', (ctx) => {
      if (ctx.authed) this.emit('closed', ctx);
      if (ctx.authed && !server.current) this.fx.reset();
      if (ctx.authed && !server.current && this.il && this.il.role === 'host') this.il.stop();
      if (!server.current) link.poke();
    });
    server.on('rtt', (ctx) => this.emit('rtt', ctx));
    server.on('transport', (ctx) => this.emit('transport', ctx));
    server.on('message', (msg, ctx) => (ctx !== server.current || !this.fx.incoming(msg)) && this._deliver(msg, ctx));

    link.on('welcome', (ctx) => {
      this.swapIn = P.newRoleSwapState(ctx.name);
      this.swapOut = P.newRoleSwapState(ctx.name);
      this.fx.reset();
      if (this.il && !(ctx.il && this.il.accept(ctx.il, (ctx.ws && ctx.ws._socket && ctx.ws._socket.remoteAddress) || ctx.address))) this.il.stop();
      this.emit('client', ctx);
    });
    link.on('closed', (ctx) => {
      this.fx.reset();
      if (this.il && this.il.role === 'guest') this.il.stop();
      this.emit('closed', ctx);
    });
    link.on('rtt', (ctx) => this.emit('rtt', ctx));
    link.on('message', (msg) => {
      const ctx = link.ctx;
      if (!ctx) return;
      for (const m of P.swapRole(msg, this.swapIn)) if (!this.fx.incoming(m)) this._deliver(m, ctx);
    });
  }

  // For fast files: {host, token, transport, address, port?, fp?}, or null (an older app).
  _fxSession() {
    const c = this.current;
    if (!c || !c.fx) return null;
    if (c === this.link.ctx) return { host: false, token: c.fx, transport: 'ip', address: this.link.address, port: this.link.host.port, fp: this.link.host.fp, fx2: !!c.fx2Port, fx2Port: c.fx2Port };
    return { host: true, token: c.fx, transport: c.transport, address: c.address, fx2: !!c.fx2 };
  }

  // The input lane while it can carry input (started with this session, and not through
  // Bluetooth), or null: input goes on WSS as it always has.
  lane() {
    const c = this.current;
    if (!this.il || !this.il.started || !c || c.transport === 'ble') return null;
    return this.il;
  }

  // The authenticated session: {deviceId, name, os, role ('guest' = they connected to us,
  // 'host' = we connected to them), address, rttMs, lastRx, ws}.
  get current() {
    return this.server.current || this.link.ctx || null;
  }

  // Disconnect, whichever side opened the session: a device connected to us doesn't come back by
  // itself (released); as a guest we don't reconnect until Connect.
  disconnect() {
    if (this.server.current) return this.server.release();
    this.link.disconnect();
  }

  get sameOs() {
    const c = this.current;
    return !!c && c.os === P.OS.MAC;
  }

  // Ctrl/Cmd swap for keys from the peer (never between two Macs).
  keySwap(settings) {
    const c = this.current;
    return settings.keys.swapCtrlCmd !== false && P.keySwapNeeded(P.OS.MAC, c && c.os);
  }

  send(ctx, msg) {
    if (!ctx) return;
    // Through Bluetooth, files wait for Wi-Fi (netlink.js); they come back through sendNow.
    if (this.hold && ctx === this.current && this.hold(msg)) return;
    this._send(ctx, msg);
  }

  sendNow(msg) {
    this._send(this.current, msg);
  }

  _send(ctx, msg) {
    if (!ctx) return;
    if (ctx === this.link.ctx) {
      for (const m of P.swapRole(msg, this.swapOut)) this.link.send(m);
    } else {
      this.server.send(ctx, msg);
    }
  }

  sendToClient(msg) {
    this.send(this.current, msg);
  }

  // A message as if the peer had sent it (the phone bridge answers for the phone's input).
  inject(msg) {
    const c = this.current;
    if (c) this._deliver(msg, c);
  }

  _deliver(msg, ctx) {
    if (this.listenerCount(`t:${msg.t}`) === 0 && !this.unknown.has(msg.t)) {
      this.unknown.add(msg.t);
      console.log(`[peer] no handler for "${msg.t}" (ignored)`);
    }
    if (this.tap) this.tap(msg);
    this.emit(`t:${msg.t}`, msg, ctx);
    this.emit('message', msg, ctx);
  }
}

module.exports = { Peer };

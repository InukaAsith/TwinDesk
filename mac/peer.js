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

class Peer extends EventEmitter {
  constructor(server, link) {
    super();
    this.server = server;
    this.link = link;
    this.unknown = new Set();
    this.swapIn = null;
    this.swapOut = null;

    server.on('client', (ctx) => {
      if (!ctx.os) ctx.os = P.OS.WIN;
      ctx.role = 'guest';
      this.emit('client', ctx);
    });
    server.on('closed', (ctx) => {
      if (ctx.authed) this.emit('closed', ctx);
      if (!server.current) link.poke();
    });
    server.on('rtt', (ctx) => this.emit('rtt', ctx));
    server.on('transport', (ctx) => this.emit('transport', ctx));
    server.on('message', (msg, ctx) => this._deliver(msg, ctx));

    link.on('welcome', (ctx) => {
      this.swapIn = P.newRoleSwapState(ctx.name);
      this.swapOut = P.newRoleSwapState(ctx.name);
      this.emit('client', ctx);
    });
    link.on('closed', (ctx) => this.emit('closed', ctx));
    link.on('rtt', (ctx) => this.emit('rtt', ctx));
    link.on('message', (msg) => {
      const ctx = link.ctx;
      if (!ctx) return;
      for (const m of P.swapRole(msg, this.swapIn)) this._deliver(m, ctx);
    });
  }

  get computer() {
    return this.server.computer || this.link.ctx || null;
  }

  get phone() {
    return this.server.phone || null;
  }

  // The authenticated session: {deviceId, name, os, role ('guest' = they connected to us,
  // 'host' = we connected to them), address, rttMs, lastRx, ws}.
  get current() {
    return this.computer || this.phone || null;
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
    if (!msg) return;
    if (P.isPhoneType(msg.t)) {
      if (this.phone) this.send(this.phone, msg);
    } else if (P.isComputerType(msg.t)) {
      if (this.computer) this.send(this.computer, msg);
    } else {
      if (this.computer) this.send(this.computer, msg);
      if (this.phone) this.send(this.phone, msg);
    }
  }

  // A message as if the peer had sent it (the phone bridge answers for the phone's input).
  inject(msg) {
    const isPhone = P.isPhoneType(msg && msg.t);
    const c = isPhone ? (this.phone || this.current) : (this.computer || this.current);
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

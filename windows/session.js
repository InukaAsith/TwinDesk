// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// One Session per remote device. It hides how the link came about:
//   guest — we dialled the device (a Link from links.js), the usual case;
//   host  — the device dialled our server (a server ctx from server.js).
// A device can have both at once for a moment (mutual pairs); the guest link is used then.
// Feature code uses a Session exactly as it used to use the one-to-one peer: on(type | 'welcome' |
// 'closed'), onState(), send(), inject(), status, lastRx, bufferedAmount, snapshot().
// As a host this PC is in its non-native role, so every message goes through P.swapRole both ways,
// with per-session state (like peer.js). A Session only ever sees its own device's messages.
//
// Sessions (the hub) binds a LinkManager and a Server and keeps one Session per device id.
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

// The Mac's apps (app.*) only come from a Mac; app windows (papp.*) with a PC or a Linux computer.
const MAC_ONLY = /^app\./;

class Session extends EventEmitter {
  constructor(id, { server = null } = {}) {
    super();
    this.id = id;
    this.server = server;
    this.name = '';
    this.link = null; // guest role: Link (links.js)
    this.ctx = null; // host role: authenticated server ctx
    this.handlers = new Map();
    this.stateFns = [];
    this.unknown = new Set();
    this.swapIn = P.newRoleSwapState('');
    this.swapOut = P.newRoleSwapState('');
    this._subscribed = new WeakSet();
    this._up = false;
  }

  // ---- what features use (same as the one-to-one peer) ----

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  onState(fn) {
    this.stateFns.push(fn);
  }

  get linkUp() {
    return !!(this.link && this.link.authed);
  }

  get hostUp() {
    return !!(this.ctx && this.ctx.authed);
  }

  get connected() {
    return this.linkUp || this.hostUp;
  }

  get role() {
    return this.hostUp && !this.linkUp ? 'host' : 'guest';
  }

  get hosting() {
    return this.role === 'host' && this.connected;
  }

  // The other computer's OS: from the live connection, else from the stored pairing.
  get peerOs() {
    if (this.hosting) return this.ctx.os || P.OS.WIN;
    const p = this.link && this.link.pairing;
    return p && p.os ? p.os : P.OS.MAC;
  }

  send(obj) {
    if (!obj || !this._allowed(obj.t)) return false;
    if (this.hosting) {
      for (const m of P.swapRole(obj, this.swapOut)) this.server.send(this.ctx, m);
      return true;
    }
    return this.link ? this.link.send(obj) : false;
  }

  // A message as if the device had sent it.
  inject(msg) {
    if (this.connected) this._deliver(msg);
  }

  // {state, rtt, message} (link.js's shape).
  get status() {
    if (this.hosting) return { state: 'connected', rtt: this.ctx.rttMs, message: '' };
    if (this.link) return this.link.status;
    return { state: 'not_paired', rtt: null, message: '' };
  }

  // Last time anything arrived (0 if never).
  get lastRx() {
    if (this.hosting) return this.ctx.lastRx || 0;
    return (this.link && this.link.lastRx) || 0;
  }

  get bufferedAmount() {
    if (this.hosting) return this.ctx.ws.bufferedAmount;
    return this.link ? this.link.bufferedAmount : 0;
  }

  // Plain data for the UI. Never throws.
  snapshot() {
    try {
      const st = this.status;
      return {
        id: this.id,
        name: this.displayName(),
        os: this.peerOs,
        role: this.role,
        connected: this.connected,
        state: st.state,
        rtt: st.rtt,
        message: st.message,
      };
    } catch (e) {
      return { id: this.id, name: '', os: P.OS.WIN, role: 'guest', connected: false, state: 'error', rtt: null, message: '' };
    }
  }

  displayName() {
    if (this.hosting && this.ctx.name) return this.ctx.name;
    if (this.link && this.link.pairing && this.link.pairing.macName) return this.link.pairing.macName;
    return this.name || '';
  }

  // ---- connections (the hub calls these) ----

  // The guest link of this device (null: none). Its messages come only from this link.
  setLink(link) {
    if (link === this.link) return;
    this.link = link;
    if (link && !this._subscribed.has(link)) {
      this._subscribed.add(link);
      link.onAny = (msg) => {
        if (this.link === link) this._fromGuest(msg);
      };
      link.on('welcome', (msg) => this._sync(msg));
      link.on('closed', () => this._sync());
      link.onState(() => this.link === link && this._changed());
    }
    this._sync();
  }

  // The server ctx of this device (null: it went away). A new ctx replaces the old one.
  setCtx(ctx) {
    const prev = this.ctx;
    if (prev === ctx) return;
    this.ctx = ctx;
    if (ctx) {
      this.name = ctx.name || this.name;
      this.swapIn = P.newRoleSwapState(ctx.name);
      this.swapOut = P.newRoleSwapState(ctx.name);
    }
    if (prev && ctx && this._up) { // replaced: the features start clean again
      this._up = false;
      this._emit('closed', {});
    }
    this._sync();
  }

  // Messages from the host ctx (only the one that is current).
  fromHost(msg, ctx) {
    if (ctx !== this.ctx) return;
    for (const m of P.swapRole(msg, this.swapIn)) this._deliver(m);
  }

  // ---- internals ----

  _fromGuest(msg) {
    this._deliver(msg);
  }

  _deliver(msg) {
    if (!this._allowed(msg.t)) return;
    const fns = this.handlers.get(msg.t);
    if (fns) for (const fn of fns) fn(msg);
    else if (!this.unknown.has(msg.t)) {
      this.unknown.add(msg.t);
      console.log('[session] ignoring message type', msg.t, 'from', this.id);
    }
  }

  _allowed(t) {
    if (MAC_ONLY.test(t)) return this.peerOs === P.OS.MAC;
    return true;
  }

  // Emits 'welcome' when the device becomes connected and 'closed' when it stops being connected.
  // msg: the guest link's welcome message, when that is what came up.
  _sync(msg) {
    const up = this.connected;
    if (up === this._up) return this._changed();
    this._up = up;
    if (up) {
      const welcome = this.hosting ? { macId: this.ctx.deviceId, macName: this.ctx.name, os: this.ctx.os } : msg || {};
      this._emit('welcome', welcome);
    } else this._emit('closed', {});
    this._changed();
  }

  _emit(type, msg) {
    const fns = this.handlers.get(type);
    if (fns) for (const fn of fns) fn(msg);
  }

  _changed() {
    for (const fn of this.stateFns) fn();
  }
}

// One Session per device id, bound to a LinkManager (links.js) and a Server (server.js).
class Sessions extends EventEmitter {
  constructor({ links = null, server = null } = {}) {
    super();
    this.server = server;
    this.sessions = new Map(); // deviceId -> Session
    if (links) {
      links.on('add', (link) => this._linkAdded(link));
      links.on('remove', (id) => {
        const s = this.sessions.get(id);
        if (s) s.setLink(null);
      });
      for (const link of links.list()) this._linkAdded(link);
    }
    if (server) {
      server.on('client', (ctx) => this.ensure(ctx.deviceId).setCtx(ctx));
      server.on('closed', (ctx) => {
        const s = this.sessions.get(ctx.deviceId);
        if (s && s.ctx === ctx) s.setCtx(null);
      });
      server.on('message', (msg, ctx) => {
        const s = this.sessions.get(ctx.deviceId);
        if (s) s.fromHost(msg, ctx);
      });
    }
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  list() {
    return [...this.sessions.values()];
  }

  // The session of a device, created on first use.
  ensure(id) {
    let s = this.sessions.get(id);
    if (!s) {
      s = new Session(id, { server: this.server });
      this.sessions.set(id, s);
      this.emit('session', s);
    }
    return s;
  }

  _linkAdded(link) {
    const id = link.pairing && link.pairing.macId;
    if (id) this.ensure(id).setLink(link);
  }
}

module.exports = { Session, Sessions };

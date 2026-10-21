// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// One Session per remote device. It hides how the connection came about:
//   host  — the device connected to our server (a ctx from server.js): we are its host, the
//           usual case for a PC or a phone; this Mac is the native side, nothing is swapped;
//   guest — we dialled the device (a Link from link.js): this Mac is the non-native role there,
//           so every message goes through P.swapRole both ways (as peer.js did for one peer).
// A device can have both at once for a moment (mutual pairs); the guest link is used then.
// Feature code uses a Session through the route in hub.js; `on(type)`, `onState()`, `send()`,
// `inject()`, `status`, `lastRx`, `bufferedAmount`, `snapshot()` as before.
//
// Sessions binds a LinkManager (links.js) and a Server (server.js) and keeps one Session per device.
// The server can arrive later (attachServer), like the host pairing in the hub.
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

class Session extends EventEmitter {
  constructor(id, { server = null } = {}) {
    super();
    this.id = id;
    this.server = server;
    this.name = '';
    this.link = null; // guest role: Link (link.js)
    this.ctx = null; // host role: authenticated server ctx
    this.handlers = new Map();
    this.stateFns = [];
    this.unknown = new Set();
    this.swapIn = P.newRoleSwapState('');
    this.swapOut = P.newRoleSwapState('');
    this._subscribed = new WeakSet();
    this._up = false;
    this._linkMesh = false; // the guest link's welcome said mesh: 1
    this.meshCapable = false; // the device speaks the mesh (hello/welcome `mesh: 1`); set when it comes up
    this.taps = []; // hub: fn(msg) -> true when it consumed the message (see _deliver)
    this.lifeFns = []; // hub: fn(up, replaced) when the device becomes connected or stops being connected
  }

  // Hub hooks. A tap sees every message of this device before the handlers; returning true
  // keeps the message away from them.
  tap(fn) {
    this.taps.push(fn);
  }

  onLife(fn) {
    this.lifeFns.push(fn);
  }

  // Re-read the connection state and fire onLife when it changed (the hub calls it once at attach).
  refresh() {
    this._sync();
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

  // 'ble' while the session's socket runs through Bluetooth (blepipe.js), else 'ip'.
  get transport() {
    if (this.linkUp) return this.link.transport === 'ble' ? 'ble' : 'ip';
    return this.hostUp && this.ctx.transport === 'ble' ? 'ble' : 'ip';
  }

  // 'guest': the device connected to us (we are its host); 'host': we are its guest (we dialled it).
  get role() {
    return this.linkUp ? 'host' : 'guest';
  }

  // The device's OS: from the live connection, else from the stored pairing.
  get peerOs() {
    if (this.connected) {
      const c = this.linkUp ? this.link.pairing : this.ctx;
      const os = this.linkUp ? c && c.os : this.ctx.os;
      if (os) return os;
    }
    const p = this.link && this.link.pairing;
    return p && p.os ? p.os : P.OS.MAC;
  }

  // Guest link first (swapped), else the server ctx.
  send(obj) {
    if (!obj) return false;
    if (this.linkUp) {
      let sent = false;
      for (const m of P.swapRole(obj, this.swapOut)) sent = this.link.send(m) || sent;
      return sent;
    }
    if (this.hostUp && this.server) {
      this.server.send(this.ctx, obj);
      return true;
    }
    return false;
  }

  // A message as if the device had sent it.
  inject(msg) {
    if (this.connected) this._deliver(msg);
  }

  // {state, rtt, message} (link.js's shape).
  get status() {
    if (this.linkUp) return this.link.status;
    if (this.hostUp) return { state: 'connected', rtt: this.ctx.rttMs, message: '' };
    if (this.link) return this.link.status;
    return { state: 'not_paired', rtt: null, message: '' };
  }

  // Last time anything arrived (0 if never).
  get lastRx() {
    if (this.linkUp) return this.link.lastRx || 0;
    if (this.hostUp) return this.ctx.lastRx || 0;
    return 0;
  }

  get bufferedAmount() {
    if (this.linkUp) return this.link.bufferedAmount;
    if (this.hostUp && this.ctx.ws) return this.ctx.ws.bufferedAmount || 0;
    return 0;
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
      return { id: this.id, name: '', os: P.OS.MAC, role: 'guest', connected: false, state: 'error', rtt: null, message: '' };
    }
  }

  displayName() {
    if (this.linkUp && this.link.pairing && this.link.pairing.macName) return this.link.pairing.macName;
    if (this.hostUp && this.ctx.name) return this.ctx.name;
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
        if (this.link === link) this._fromLink(msg);
      };
      link.on('welcome', (msg) => {
        this._linkMesh = !!(msg && msg.mesh);
        this.swapIn = P.newRoleSwapState(link.pairing ? link.pairing.macName : '');
        this.swapOut = P.newRoleSwapState(link.pairing ? link.pairing.macName : '');
        this._sync(msg);
      });
      link.on('closed', () => this._sync());
      link.onState(() => this.link === link && this._changed());
      link.on('transport', () => this._changed()); // the session moved to Bluetooth or back (kvm, the Overview)
    }
    this._sync();
  }

  // The server ctx of this device (null: it went away). A new ctx replaces the old one.
  setCtx(ctx) {
    const prev = this.ctx;
    if (prev === ctx) return;
    // Replaced by a new socket of the same device: down (replaced), then up below, so the features start clean.
    if (prev && ctx && this._up) this._transition(false, {}, true);
    this.ctx = ctx;
    if (ctx) this.name = ctx.name || this.name;
    this._sync();
  }

  // Messages from the server ctx (only the one that is current): delivered as they are.
  fromHost(msg, ctx) {
    if (ctx !== this.ctx) return;
    this._deliver(msg);
  }

  // ---- internals ----

  _fromLink(msg) {
    for (const m of P.swapRole(msg, this.swapIn)) this._deliver(m);
  }

  _deliver(msg) {
    for (const tap of this.taps) if (tap(msg) === true) return;
    const fns = this.handlers.get(msg.t);
    if (fns) for (const fn of fns) fn(msg);
    else if (!this.unknown.has(msg.t)) {
      this.unknown.add(msg.t);
      console.log('[session] ignoring message type', msg.t, 'from', this.id);
    }
  }

  // Emits 'welcome' when the device becomes connected and 'closed' when it stops being connected.
  // msg: the guest link's welcome message, when that is what came up.
  _sync(msg) {
    const up = this.connected;
    if (up !== this._up) this._transition(up, msg);
    this._changed();
  }

  // The device came up or went down: features get welcome or closed, the hub gets onLife(up, replaced).
  _transition(up, msg, replaced = false) {
    this._up = up;
    if (up) {
      this.meshCapable = this.linkUp ? this._linkMesh : !!(this.ctx && this.ctx.mesh);
      const welcome = this.linkUp ? (msg || {}) : { macId: this.ctx.deviceId, macName: this.ctx.name, os: this.ctx.os };
      this._emit('welcome', welcome);
    } else this._emit('closed', {});
    for (const fn of this.lifeFns) fn(up, replaced);
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
    this.server = null;
    this.sessions = new Map(); // deviceId -> Session
    if (links) {
      links.on('add', (link) => this._linkAdded(link));
      links.on('remove', (id) => {
        const s = this.sessions.get(id);
        if (s) s.setLink(null);
      });
      for (const link of links.list()) this._linkAdded(link);
    }
    if (server) this.attachServer(server);
  }

  // Bind the server (server.js) when it exists: its authenticated clients become host ctxs.
  attachServer(server) {
    if (!server || this.server === server) return;
    this.server = server;
    for (const s of this.sessions.values()) s.server = server;
    server.on('client', (ctx) => this.ensure(ctx.deviceId).setCtx(ctx));
    server.on('closed', (ctx) => {
      const s = this.sessions.get(ctx.deviceId);
      if (s && s.ctx === ctx) s.setCtx(null);
    });
    server.on('transport', (ctx) => {
      const s = this.sessions.get(ctx.deviceId);
      if (s) s._changed();
    });
    server.on('message', (msg, ctx) => {
      const s = this.sessions.get(ctx.deviceId);
      if (s) s.fromHost(msg, ctx);
    });
    for (const ctx of server.clients.values()) this.ensure(ctx.deviceId).setCtx(ctx);
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

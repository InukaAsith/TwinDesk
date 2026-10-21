// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The hub joins the link layer (server.js, hostpair.js, links.js, session.js) to the mesh
// (shared/mesh.js), as docs/mesh.md describes. Plain Node: no Electron.
//
// Three views of the same connections:
//   mesh    every connected device (the Mesh registry) and the roster of direct links
//   bus     pooled features (clipboard, notifications): messages of ANY connected device, sends to any
//   facade  targeted features (files, screen, terminal, ...): the SELECTED device only, with the API
//           of the one-to-one Peer (peer.js)
//
// Selection: `selectedId` is a string (or null), `selected` is its Session (or null). Never mix them.
// The first device that connects while nothing is selected is selected; when the selected device
// drops, another connected one is picked. Every change of the selection tells the facade's handlers
// 'closed' and then, for the new device, 'welcome' with {macId, macName, os}.
//
// Events: 'change' (anything the UI shows), 'selected' (id or null), 'peerAdded' (id),
// 'peerRemoved' (id).
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { Sessions } = require('./session.js');

const ROSTER = 'mesh.roster';

function addTo(map, key, fn) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(fn);
}

class Hub extends EventEmitter {
  // device {id, name}; links: LinkManager (links.js); mesh: Mesh (shared/mesh.js), whose selfId is
  // device.id. server (Server, server.js) and pairing (Pairing, hostpair.js) may come now or later:
  // the certificate is read asynchronously, so main.js calls attachHost() when it exists.
  constructor({ device, links, server = null, pairing = null, mesh }) {
    super();
    this.device = device;
    this.links = links;
    this.server = null;
    this.pairing = null;
    this.mesh = mesh;
    this.selectedId = null;
    this.sessions = new Sessions({ links });
    this.bus = this._makeBus();
    this.facade = this._makeFacade();
    this._busHandlers = new Map(); // type -> [fn(msg, fromId)]
    this._peerHandlers = new Map(); // 'welcome' | 'closed' -> [fn(peerId, info)]
    this._facadeHandlers = new Map(); // type | 'welcome' | 'closed' -> [fn(arg)]
    this._facadeStateFns = [];
    this._host = { on: false, error: '' };

    links.on('add', () => this._change());
    links.on('remove', () => this._change());
    links.on('change', () => this._change());

    this.sessions.on('session', (s) => this._attach(s));
    for (const s of this.sessions.list()) this._attach(s);
    if (server && pairing) this.attachHost(server, pairing);
  }

  // No host role: the certificate could not be made (the status says why).
  hostFailed(message) {
    this._host = { on: false, error: String(message || '') };
    this._change();
  }

  // The host role (our server and the pairing responder). Devices that dial us, pending pairing
  // requests and the listen state appear from here on. Calling it again does nothing.
  attachHost(server, pairing) {
    if (this.server) return;
    this.server = server;
    this.pairing = pairing;
    this._host = { on: !!(server.https && server.https.listening), error: '' };
    server.on('listening', () => { this._host = { on: true, error: '' }; this._change(); });
    server.on('listenError', (err) => {
      this._host = {
        on: false,
        error: err.code === 'EADDRINUSE' ? 'Port ' + P.PORT + ' is in use (another copy of TwinDesk?)' : err.code || err.message,
      };
      this._change();
    });
    server.on('rtt', () => this._change());
    pairing.on('change', () => this._change());
    pairing.on('request', () => this._change());
    this.links.hostPairing = pairing; // mutual pairs: a device that holds us as its host
    this.links.bindServer(server);
    this.sessions.bindServer(server);
    if (this.selectedId) server.setPrimary(this.selectedId);
    this._change();
  }

  // The Session of the selected device (null: nothing selected).
  get selected() {
    return this.selectedId ? this.sessions.get(this.selectedId) : null;
  }

  // ---- connections ----

  start() {
    this.links.start();
  }

  // Pair with a computer (the guest side, as link.js). One pairing at a time.
  startPairing(target) {
    return this.links.startPairing(target);
  }

  confirmCode() {
    this.links.confirmCode();
  }

  // Cancels our pairing request, or refuses a pairing request from another device.
  cancelPair() {
    if (this.pairing && this.pairing.pending) this.pairing.respond(false);
    else this.links.cancelPair();
  }

  // Allow / deny a pairing request from another device (the host side).
  respondPair(allow) {
    if (this.pairing) this.pairing.respond(allow);
  }

  // Forget a device: its guest link (we dialled it) and its host entry (it dialled us), both.
  forgetPeer(id) {
    if (this.links.get(id)) this.links.forget(id);
    if (this.pairing && this.pairing.list().some((x) => x.id === id)) this.pairing.forget(id);
  }

  forgetGuest(id) {
    if (this.pairing) this.pairing.forget(id);
  }

  // Makes `id` the selected device. False when that device is not connected.
  select(id) {
    const s = id ? this.sessions.get(id) : null;
    if (!s || !s.connected) return false;
    this._select(id);
    return true;
  }

  // ---- what the UI shows ----

  // Every paired device, connected or not. state: 'connected' | the guest link's state (connecting,
  // reconnecting, ...) | 'waiting' (a device that dials us and is not connected now).
  // direct: its direct links from its roster (null when connected but not known, or not connected).
  peers() {
    const ids = [];
    const add = (id) => {
      if (id && id !== this.device.id && !ids.includes(id)) ids.push(id);
    };
    const guests = this.pairing ? this.pairing.list() : [];
    for (const link of this.links.list()) if (link.pairing) add(link.pairing.macId);
    for (const g of guests) add(g.id);
    for (const s of this.sessions.list()) if (s.connected) add(s.id);

    const out = [];
    for (const id of ids) {
      const s = this.sessions.get(id);
      const up = !!s && s.connected;
      const link = this.links.get(id);
      const gp = link && link.pairing ? link.pairing : null;
      const host = guests.find((x) => x.id === id) || null;
      if (!up && !gp && !host) continue;
      out.push({
        id,
        name: up ? s.displayName() : (gp && gp.macName) || (host && host.name) || '',
        os: up ? s.peerOs : gp ? gp.os || P.OS.MAC : host && host.os ? host.os : P.OS.WIN,
        state: up ? 'connected' : link ? link.status.state : 'waiting',
        rtt: up ? s.status.rtt : null,
        address: up && s.hosting ? s.ctx.address : gp ? gp.address : '',
        role: up ? s.role : gp ? 'guest' : 'host',
        selected: id === this.selectedId,
        connected: up,
        direct: up ? this.mesh.roster.direct(id) : null,
      });
    }
    return out;
  }

  // The old Peer.snapshot() shape for the selected device, plus `peers`. Never throws.
  snapshot() {
    try {
      return this._snapshot();
    } catch (e) {
      console.error('[hub] snapshot:', e.message);
      return { link: this._nothingLink(), pairing: null, paired: null, guests: [], session: null, host: { ...this._host }, peers: [] };
    }
  }

  _snapshot() {
    const s = this.selected;
    const hosting = !!s && s.hosting;
    const g = s && s.link ? s.link.snapshot() : null;
    let link;
    if (hosting) link = { state: 'connected', rtt: s.ctx.rttMs, message: '', macName: s.ctx.name, address: s.ctx.address };
    else link = g ? g.link : this._nothingLink();
    const req = this.pairing ? this.pairing.pendingView() : null;
    const ps = this.links.pairState();
    const pairing = req
      ? { phase: 'request', role: 'host', macName: req.name, os: req.os, code: req.code || '', allowed: req.allowed, address: '' }
      : ps ? { ...ps } : null;
    return {
      link,
      pairing,
      paired: g ? g.paired : null,
      guests: this.pairing ? this.pairing.list() : [],
      session: s ? { role: s.role, id: s.id, name: s.displayName(), os: s.peerOs } : null,
      host: { ...this._host },
      peers: this.peers(),
    };
  }

  // ---- internals: devices ----

  _attach(s) {
    s.tap((msg) => this._fromDevice(s, msg));
    s.onLife((up, replaced) => (up ? this._up(s) : this._down(s, replaced)));
    s.onState(() => this._stateOf(s));
    s.refresh(); // a device that is already connected comes up now
  }

  // A message of one device: roster messages are the mesh's, the rest goes to the bus (any device)
  // and to the facade (the selected device). True keeps it away from the session's own handlers.
  _fromDevice(s, msg) {
    if (msg.t === ROSTER) {
      if (this.mesh.handle(s.id, msg)) this._change();
      return true;
    }
    // The selected device's messages reach the net hook first (netlink.js: its net.* and file chunks).
    if (this.netTap && s.id === this.selectedId) this.netTap(msg);
    let consumed = false;
    const fns = this._busHandlers.get(msg.t);
    if (fns) {
      consumed = true;
      for (const fn of fns) fn(msg, s.id);
    }
    // A feature's type from a device that is not selected: nobody reads it here, and it is not unknown.
    if (this._facadeHandlers.has(msg.t)) {
      consumed = true;
      if (s.id === this.selectedId) this._facadeEmit(msg.t, msg);
    }
    return consumed;
  }

  _up(s) {
    this.mesh.addPeer({ id: s.id, name: s.displayName(), os: s.peerOs, send: (m) => s.send(m), mesh: s.meshCapable });
    this._rosterAll();
    this._peerEvent('welcome', s.id, this._welcomeInfo(s));
    if (this.selectedId === s.id) this._facadeEmit('welcome', this._welcomeInfo(s)); // the selected device came back (replaced)
    else if (this.selectedId === null) this._select(s.id);
    this.emit('peerAdded', s.id);
    this._change();
  }

  // replaced: the device got a new socket, so it is down and up again at once. Its selection stays.
  _down(s, replaced = false) {
    this.mesh.removePeer(s.id);
    this._rosterAll();
    this._peerEvent('closed', s.id, {});
    if (this.selectedId === s.id) {
      if (replaced) this._facadeEmit('closed', {});
      else this._select(this._pickConnected());
    }
    this.emit('peerRemoved', s.id);
    this._change();
  }

  _stateOf(s) {
    const tr = s.transport; // onto Bluetooth or back: the device's features hear 'transport'
    if (tr !== s.lastTransport) {
      s.lastTransport = tr;
      this._peerEvent('transport', s.id, {});
      if (s.id === this.selectedId) this._facadeEmit('transport', {});
    }
    const e = this.mesh.get(s.id);
    if (e) {
      e.mesh = s.meshCapable;
      e.name = s.displayName();
    }
    if (s.id === this.selectedId) this._facadeState();
    this._change();
  }

  // Our direct links to every mesh-capable device, after any change of them.
  _rosterAll() {
    const msg = this.mesh.rosterMessage();
    for (const s of this.sessions.list()) if (s.connected && s.meshCapable) s.send(msg);
  }

  _pickConnected() {
    const s = this.sessions.list().find((x) => x.connected);
    return s ? s.id : null;
  }

  _connectedIds() {
    return this.sessions.list().filter((s) => s.connected).map((s) => s.id);
  }

  _welcomeInfo(s) {
    if (s.hosting) return { macId: s.ctx.deviceId, macName: s.ctx.name, os: s.ctx.os || P.OS.WIN };
    const p = s.link && s.link.pairing;
    return { macId: s.id, macName: p ? p.macName : s.name, os: s.peerOs };
  }

  // ---- internals: selection and the facade ----

  _select(id) {
    const next = id || null;
    if (next === this.selectedId) return;
    if (this.selectedId !== null) this._facadeEmit('closed', {});
    this.selectedId = next;
    if (this.server) this.server.setPrimary(next);
    if (next) {
      const s = this.sessions.get(next);
      if (s) this._facadeEmit('welcome', this._welcomeInfo(s));
    }
    this._facadeState();
    this.emit('selected', next);
    this._change();
  }

  _facadeEmit(type, arg) {
    const fns = this._facadeHandlers.get(type);
    if (fns) for (const fn of fns) fn(arg);
  }

  _facadeState() {
    for (const fn of this._facadeStateFns) fn();
  }

  _peerEvent(type, id, info) {
    const fns = this._peerHandlers.get(type);
    if (fns) for (const fn of fns) fn(id, info);
  }

  _nothingState() {
    return (this.pairing && this.pairing.list().length) || this.links.list().length ? 'connecting' : 'not_paired';
  }

  _nothingLink() {
    return { state: this._nothingState(), rtt: null, message: '', macName: '', address: '' };
  }

  _change() {
    this.emit('change');
  }

  _makeBus() {
    return {
      on: (type, fn) => addTo(this._busHandlers, type, fn),
      onPeer: (event, fn) => addTo(this._peerHandlers, event, fn),
      send: (peerId, msg) => {
        const s = this.sessions.get(peerId);
        return !!s && s.connected && s.send(msg) === true;
      },
      selectedId: () => this.selectedId,
      connectedIds: () => this._connectedIds(),
    };
  }

  // The facade API for ONE device, whether or not it is selected: handlers hear only that device
  // ('welcome' / 'closed' for it coming and going), send() goes to its session. Per-device stacks
  // (pcscreenset.js) are made on it; bind(id) attaches one made before the device was there.
  scoped(id = null) {
    const hub = this;
    const sess = () => (link.id ? hub.sessions.get(link.id) : null);
    const link = {
      id,
      bind(next) { link.id = next; },
      on(type, fn) {
        if (type === 'welcome' || type === 'closed') addTo(hub._peerHandlers, type, (pid, info) => pid === link.id && fn(info));
        else hub.bus.on(type, (m, from) => from === link.id && fn(m));
      },
      onState(fn) { hub._facadeStateFns.push(fn); },
      send(obj) {
        const s = sess();
        return !!s && s.connected && s.send(obj) === true;
      },
      inject(msg) {
        const s = sess();
        if (s && s.connected) s.inject(msg);
      },
      get status() {
        const s = sess();
        return s ? s.status : { state: hub._nothingState(), rtt: null, message: '' };
      },
      get lastRx() { const s = sess(); return s ? s.lastRx : 0; },
      get bufferedAmount() { const s = sess(); return s ? s.bufferedAmount : 0; },
      get hosting() { const s = sess(); return !!s && s.hosting; },
      get peerOs() { const s = sess(); return s ? s.peerOs : P.OS.MAC; },
      get server() { return hub.server; },
      get pairing() { return hub.pairing; },
    };
    return link;
  }

  _makeFacade() {
    const hub = this;
    return {
      on: (type, fn) => addTo(hub._facadeHandlers, type, fn),
      onState: (fn) => hub._facadeStateFns.push(fn),
      // A message to the selected device; while it is on Bluetooth, files may wait for Wi-Fi (netHold).
      send: (obj) => {
        if (hub.netHold && hub.netHold(obj)) return true;
        const s = hub.selected;
        return !!s && s.send(obj) === true;
      },
      sendNow: (obj) => {
        const s = hub.selected;
        return !!s && s.send(obj) === true;
      },
      // What the one-to-one features see of the selected device's link (netlink.js, the Overview).
      get current() {
        const s = hub.selected;
        if (!s || !s.connected) return null;
        const hosting = s.hosting;
        return {
          deviceId: s.id, name: s.displayName(), os: s.peerOs, role: s.role, transport: s.transport,
          address: hosting ? s.ctx.address : (s.link && s.link.pairing ? s.link.pairing.address : ''),
          rttMs: s.status.rtt, lastRx: s.lastRx, ws: hosting ? s.ctx.ws : (s.link ? s.link.ws : null),
        };
      },
      // A message as if the selected device had sent it (the phone bridge answers for the phone).
      inject: (msg) => {
        const s = hub.selected;
        if (s && s.connected) hub._facadeEmit(msg.t, msg);
      },
      get status() {
        const s = hub.selected;
        return s ? s.status : { state: hub._nothingState(), rtt: null, message: '' };
      },
      get lastRx() {
        const s = hub.selected;
        return s ? s.lastRx : 0;
      },
      get bufferedAmount() {
        const s = hub.selected;
        return s ? s.bufferedAmount : 0;
      },
      get hosting() {
        const s = hub.selected;
        return !!s && s.hosting;
      },
      get peerOs() {
        const s = hub.selected;
        return s ? s.peerOs : P.OS.MAC;
      },
      get server() {
        return hub.server;
      },
      get pairing() {
        return hub.pairing;
      },
      snapshot: () => hub.snapshot(),
      start: () => hub.start(),
      startPairing: (target) => hub.startPairing(target),
      confirmCode: () => hub.confirmCode(),
      cancelPair: () => hub.cancelPair(),
      forget: () => {
        if (hub.selectedId) hub.forgetPeer(hub.selectedId);
      },
      respondPair: (allow) => hub.respondPair(allow),
      forgetGuest: (id) => hub.forgetGuest(id),
    };
  }
}

module.exports = { Hub };

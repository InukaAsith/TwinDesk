// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The hub joins the link layer (server.js, pairing.js, links.js, session.js) to the mesh
// (shared/mesh.js), as docs/mesh.md describes. Port of windows/hub.js; plain Node: no Electron.
//
// Three views of the same connections:
//   mesh    every connected device (the Mesh registry) and the roster of direct links
//   bus     pooled features (clipboard, notifications): messages of ANY connected device, sends to any
//   facade  targeted features (files, screen, terminal, ...): the SELECTED device only. A route:
//           see Route below. The phone's own route (hub.route(...)) follows the phone instead.
//
// Selection: `selectedId` is a string (or null), `selected` is its Session (or null). Never mix them.
// The first device that connects while nothing is selected is selected; when the selected device
// drops, another connected one is picked. Every change of the selection tells the facade's
// listeners 'closed' and then, for the new device, 'client' with the device's view.
//
// The server and the host pairing may arrive later: attachHost(server, pairing).
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

// What a feature sees of its device: the one-to-one "client" object (role 'guest' = it connected to
// this Mac, 'host' = this Mac is its guest), as peer.js always gave it.
function viewOf(s) {
  if (!s) return null;
  const c = s.hostUp ? s.ctx : null;
  return {
    deviceId: s.id,
    name: s.displayName(),
    os: s.peerOs,
    role: s.role,
    transport: s.transport, // 'ble' (Bluetooth, blepipe.js) or 'ip'
    address: c ? c.address : (s.link && s.link.pairing ? s.link.pairing.address : ''),
    rttMs: s.status.rtt != null ? s.status.rtt : (c ? c.rttMs : null),
    lastRx: s.lastRx,
    authed: true,
    ws: c ? c.ws : (s.link ? s.link.ws : null),
    ice: c ? c.ice : null, // a phone through adb reverse: the relay's RTCConfiguration (wired.js)
  };
}

// A view of one device for the features: events 'client' (view), 'closed' (view), 'rtt' (view),
// 't:<type>' (msg, view) and 'message' (msg, view). The target is picked by pick(hub) -> device id;
// it is only a target while connected. When it changes the listeners get 'closed' (old), then
// 'client' (new): a feature starts clean.
class Route extends EventEmitter {
  constructor(hub, pick) {
    super();
    this.hub = hub;
    this.pick = pick;
    this.targetId = null;
    this.lastView = null;
    this.stateFns = [];
  }

  get session() {
    return this.targetId ? this.hub.sessions.get(this.targetId) : null;
  }

  // The client object of the target (null when nobody).
  get current() {
    return viewOf(this.session);
  }

  // Re-pick the target; emits 'closed' and 'client' when it changed.
  refresh() {
    const want = this.pick(this.hub);
    const s = want ? this.hub.sessions.get(want) : null;
    const next = s && s.connected ? want : null;
    if (next === this.targetId) {
      this._stateChanged();
      return;
    }
    this.drop();
    if (next) {
      this.targetId = next;
      this.lastView = viewOf(this.hub.sessions.get(next));
      this.emit('client', this.lastView);
    }
    this._stateChanged();
  }

  // The target device went away (or was replaced): 'closed' now, no new target until refresh().
  drop(id) {
    if (!this.targetId || (id && id !== this.targetId)) return;
    const v = this.lastView || {};
    this.targetId = null;
    this.lastView = null;
    this.emit('closed', v);
  }

  deliver(msg) {
    const s = this.session;
    if (!s) return false;
    if (this.tap) this.tap(msg); // netlink.js: every message of the target
    const v = viewOf(s);
    this.emit(`t:${msg.t}`, msg, v);
    this.emit('message', msg, v);
    return true;
  }

  rtt(id) {
    if (id !== this.targetId) return;
    this.emit('rtt', viewOf(this.session));
  }

  // Send to the target (the ctx argument of peer.js is ignored: a route has one device). A message
  // the hold hook takes (files waiting for Wi-Fi, netlink.js) is sent later through sendNow.
  send(obj) {
    if (this.hold && this.hold(obj)) return true;
    return this.sendNow(obj);
  }

  sendNow(obj) {
    const s = this.session;
    return !!s && s.send(obj) === true;
  }

  // A message as if the target had sent it.
  inject(msg) {
    const s = this.session;
    if (s && s.connected) this.deliver(msg);
  }

  onState(fn) {
    this.stateFns.push(fn);
  }

  _stateChanged() {
    for (const fn of this.stateFns) fn();
  }
}

class Hub extends EventEmitter {
  // device {id, name}; links: LinkManager (links.js); mesh: Mesh (shared/mesh.js), whose selfId is
  // device.id; server, pairing: optional here (attachHost() gives them later).
  constructor({ device, links, mesh, server = null, pairing = null }) {
    super();
    this.device = device;
    this.links = links;
    this.mesh = mesh;
    this.server = null;
    this.pairing = null;
    this.selectedId = null;
    this.sessions = new Sessions({ links });
    this.bus = this._makeBus();
    this._busHandlers = new Map(); // type -> [fn(msg, fromId)]
    this._peerHandlers = new Map(); // 'welcome' | 'closed' -> [fn(peerId, info)]
    this.forgotten = new Set(); // forgetPeer(): not listed as "via" until it connects again
    this.routes = [];
    this.facade = this.route(() => this.selectedId);
    this._addFacadeApi(this.facade);
    this._host = { on: false, error: '' };

    links.on('add', () => this._change());
    links.on('remove', () => this._change());
    links.on('change', () => this._change());

    this.sessions.on('session', (s) => this._attach(s));
    for (const s of this.sessions.list()) this._attach(s);
    if (server) this.attachHost(server, pairing);
  }

  // A route for a feature: pick(hub) -> the device id it follows.
  route(pick) {
    const r = new Route(this, pick);
    this.routes.push(r);
    r.refresh();
    return r;
  }

  // The phone's route: the connected phone, whichever computer is selected.
  phoneRoute() {
    return this.route((hub) => hub._connectedIdWhere((s) => s.peerOs === P.OS.ANDROID));
  }

  // The server (server.js) and the host pairing (pairing.js) of this Mac. They may arrive after the
  // hub was made: the connected devices are bound to them at once.
  attachHost(server, pairing) {
    if (this.server || !server) return;
    this.server = server;
    this.pairing = pairing || null;
    this._host = { on: !!server.port, error: '' };
    server.on('listening', () => { this._host = { on: true, error: '' }; this._change(); });
    server.on('listenError', (err) => {
      this._host = {
        on: false,
        error: err.code === 'EADDRINUSE' ? 'Port ' + P.PORT + ' is in use (another copy of TwinDesk?)' : err.code || err.message,
      };
      this._change();
    });
    server.on('rtt', (ctx) => {
      for (const r of this.routes) r.rtt(ctx.deviceId);
      this._change();
    });
    if (this.pairing) {
      this.pairing.on('change', () => this._change());
      this.pairing.on('request', () => this._change());
    }
    this.sessions.attachServer(server); // new sessions are attached by the 'session' event
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
    this.forgotten.add(id);
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
    const indirect = new Map();
    if (this.mesh) for (const k of this.mesh.known()) if (!k.direct && !this.forgotten.has(k.id)) indirect.set(k.id, k);
    const viaNames = (k) => k.via.map((v) => (this.mesh.get(v) && this.mesh.get(v).name) || v);
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
        address: up && s.hostUp ? s.ctx.address : gp ? gp.address : '',
        role: up ? s.role : gp ? 'host' : 'guest',
        selected: id === this.selectedId,
        connected: up,
        direct: up && this.mesh ? this.mesh.roster.direct(id) : null,
        ...(!up && !link && indirect.has(id) ? { state: 'via', via: viaNames(indirect.get(id)) } : {}),
      });
    }
    // Everyone else of the mesh: devices only a connected device reaches (their roster `members`).
    if (this.mesh) {
      const shown = new Set(out.map((x) => x.id));
      for (const k of this.mesh.known()) {
        if (k.direct || k.id === this.device.id || shown.has(k.id) || this.forgotten.has(k.id)) continue;
        const via = viaNames(k);
        out.push({
          id: k.id, name: k.name, os: k.os || P.OS.WIN, state: 'via', rtt: null, address: '', role: 'guest',
          selected: false, connected: false, direct: null, via,
        });
      }
    }
    return out;
  }

  // The old one-to-one state for the UI, for the selected device, plus `peers`. Never throws.
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
    const g = s && s.link ? s.link.snapshot() : null;
    let link;
    if (s && s.linkUp) link = g ? g.link : this._nothingLink();
    else if (s && s.hostUp) link = { state: 'connected', rtt: s.ctx.rttMs, message: '', macName: s.ctx.name, address: s.ctx.address };
    else link = this._nothingLink();
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
  // and to the route that follows this device. True keeps it away from the session's own handlers.
  _fromDevice(s, msg) {
    if (msg.t === ROSTER) {
      if (this.mesh && this.mesh.handle(s.id, msg)) this._change();
      return true;
    }
    let consumed = false;
    const fns = this._busHandlers.get(msg.t);
    if (fns) {
      consumed = true;
      for (const fn of fns) fn(msg, s.id);
    }
    for (const r of this.routes) {
      // A route takes the message only when someone listens for it (as the Windows facade does).
      if (r.targetId !== s.id) continue;
      if (r.listenerCount(`t:${msg.t}`) > 0 || r.listenerCount('message') > 0) {
        r.deliver(msg);
        consumed = true;
      }
    }
    return consumed;
  }

  _up(s) {
    this.forgotten.delete(s.id);
    if (this.mesh) this.mesh.addPeer({ id: s.id, name: s.displayName(), os: s.peerOs, send: (m) => s.send(m), mesh: s.meshCapable });
    this._rosterAll();
    this._peerEvent('welcome', s.id, this._welcomeInfo(s));
    if (this.selectedId === null) this._select(s.id);
    this._refreshRoutes();
    this.emit('peerAdded', s.id);
    this._change();
  }

  // replaced: the device got a new socket, so it is down and up again at once. Its selection stays.
  _down(s, replaced = false) {
    if (this.mesh) this.mesh.removePeer(s.id);
    this._rosterAll();
    this._peerEvent('closed', s.id, {});
    if (replaced) {
      // The new socket comes up right after (_up): the features see closed, then client, at once.
      for (const r of this.routes) r.drop(s.id);
    } else {
      if (this.selectedId === s.id) this._select(this._pickConnected());
      this._refreshRoutes();
    }
    this.emit('peerRemoved', s.id);
    this._change();
  }

  _stateOf(s) {
    const e = this.mesh && this.mesh.get(s.id);
    if (e) {
      e.mesh = s.meshCapable;
      e.name = s.displayName();
    }
    const tr = s.transport; // onto Bluetooth or back: the device's features hear 'transport'
    if (tr !== s.lastTransport) {
      s.lastTransport = tr;
      this._peerEvent('transport', s.id, {});
      for (const r of this.routes) if (r.targetId === s.id) r.emit('transport', {});
    }
    this._refreshRoutes();
    this._change();
  }

  _refreshRoutes() {
    for (const r of this.routes) r.refresh();
  }

  // Our direct links to every mesh-capable device, after any change of them.
  _rosterAll() {
    if (!this.mesh) return;
    const msg = this.mesh.rosterMessage();
    for (const s of this.sessions.list()) if (s.connected && s.meshCapable) s.send(msg);
  }

  _pickConnected() {
    const s = this.sessions.list().find((x) => x.connected);
    return s ? s.id : null;
  }

  _connectedIdWhere(pred) {
    const s = this.sessions.list().find((x) => x.connected && pred(x));
    return s ? s.id : null;
  }

  _connectedIds() {
    return this.sessions.list().filter((s) => s.connected).map((s) => s.id);
  }

  _welcomeInfo(s) {
    if (s.linkUp) return { macId: s.id, macName: s.link.pairing ? s.link.pairing.macName : s.name, os: s.peerOs };
    return { macId: s.ctx.deviceId, macName: s.ctx.name, os: s.ctx.os || P.OS.MAC };
  }

  // ---- internals: selection ----

  _select(id) {
    const next = id || null;
    if (next === this.selectedId) return;
    this.selectedId = next;
    if (this.server) this.server.setPrimary(next);
    this._refreshRoutes();
    this.emit('selected', next);
    this._change();
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

  // The facade's extra API, the one the Mac's control code has always used on `link`.
  _addFacadeApi(f) {
    const hub = this;
    Object.assign(f, {
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
    });
    Object.defineProperties(f, {
      status: {
        get() {
          const s = hub.selected;
          return s ? s.status : { state: hub._nothingState(), rtt: null, message: '' };
        },
      },
      lastRx: { get() { const s = hub.selected; return s ? s.lastRx : 0; } },
      bufferedAmount: { get() { const s = hub.selected; return s ? s.bufferedAmount : 0; } },
      hosting: { get() { const s = hub.selected; return !!s && s.hostUp && !s.linkUp; } },
      peerOs: { get() { const s = hub.selected; return s ? s.peerOs : P.OS.MAC; } },
      server: { get() { return hub.server; } },
    });
  }
}

module.exports = { Hub, Route, viewOf };

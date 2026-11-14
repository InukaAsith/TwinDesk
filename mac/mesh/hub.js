// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
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
const P = require('../../shared/protocol.js');
const { Route, viewOf } = require('../../shared/hub-route.js');
const { Sessions } = require('./session.js');

const ROSTER = 'mesh.roster';

function addTo(map, key, fn) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(fn);
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
    this._audioSticky = {};
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
    return this.route((hub) => hub._connectedIdWhere((s) => P.isPhoneOs(s.peerOs)));
  }

  // Sound and microphone: stay on the device of an active session until it ends (mesh #194).
  audioRoute() {
    if (!this._audioRoute) this._audioRoute = this.route((hub) => hub._pickAudioRoute());
    return this._audioRoute;
  }

  // which: 'sound' | 'mic' — id while that feature's session is live, or null when it is not.
  setAudioSticky(which, id) {
    const next = id || null;
    if (next) this._audioSticky[which] = next;
    else delete this._audioSticky[which];
    if (this._audioRoute) this._audioRoute.refresh();
  }

  _pickAudioRoute() {
    for (const id of Object.values(this._audioSticky)) {
      const s = id ? this.sessions.get(id) : null;
      if (s && s.connected) return id;
    }
    return this.selectedId;
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

  // Mark a link busy (driving, driven, or selected) on whichever end holds it: a host we dial is in
  // `links`, one that dials us is in `server`. A busy link pings every PING_MS; the others every
  // IDLE_PING_MS (docs/mesh.md "Keep-alive"). The Kvm calls this on every mode change.
  setBusy(id, flag) {
    if (!id) return;
    const f = flag == null ? null : !!flag; // null clears the flag
    this.links.setBusy(id, f);
    if (this.server) this.server.setBusy(id, f);
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

module.exports = { Hub, Route, viewOf }; // Route, viewOf: shared/hub-route.js

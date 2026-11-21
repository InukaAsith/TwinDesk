// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// The hub joins the link layer (server.js, hostpair.js, links.js, session.js) to the mesh
// (shared/mesh.js), as docs/mesh.md describes. Plain Node: no Electron.
//
// Three views of the same connections:
//   mesh    every connected device (the Mesh registry) and the roster of direct links
//   bus     messages of ANY connected device, sends to any; scoped(id) / sticky(): a feature's own
//           link to one device (every feature is one per device, or binds itself: step 5 of
//           docs/mesh-graph.md)
//   facade  the SELECTED device's status, snapshot and sends, for the pages; no events, no replay
//
// Selection: `selectedId` is a string (or null), `selected` is its Session (or null). Never mix them.
// It is the device the pages show and a crossing picks; nothing routes through it. The first device
// that connects while nothing is selected is selected; when the selected device drops, another
// connected one is picked; 'selected' says so. netTarget: the device the net hook serves (netId, set by
// main.js; else the selected one): its messages go to netTap, files to it wait in netHold.
//
// Events: 'change' (anything the UI shows), 'selected' (id or null), 'peerAdded' (id),
// 'peerRemoved' (id).
'use strict';

const { EventEmitter } = require('events');
const P = require('../../shared/protocol.js');
const { Route } = require('../../shared/hub-route.js');
const { LinkMemory, Goodbyes } = require('../../shared/link-memory.js');
const { Sessions } = require('./session.js');

const ROSTER = 'mesh.roster';

function addTo(map, key, fn) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(fn);
}

// Debug › Verbose log › bus (shared/applog.js v()): a message's type, sender and size, once per type and
// sender every 10 s (not every move: the log would be the moves).
const busSaid = new Map();
function busVerbose(s, msg) {
  const applog = require('../../shared/applog.js');
  if (!applog.verboseOn || (!applog.verboseOn('bus'))) return;
  const key = s.id + msg.t;
  const now = Date.now();
  if (now - (busSaid.get(key) || 0) < 10000) return;
  busSaid.set(key, now);
  let size = 0;
  try { size = JSON.stringify(msg).length; } catch (_) { /* not plain */ }
  applog.v('bus', `${s.displayName ? s.displayName() : s.id}: ${msg.t} (${size} bytes)`);
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
    this._facadeStateFns = [];
    this._audioSticky = {};
    this._audioRoute = null;
    this._inputPeer = null; // the device using this computer (setInputPeer), for the microphone
    this._audioLink = null;
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

  // Sound and microphone (mesh #194): same target rules as mac/mesh/hub.js audioRoute().
  audioRoute() {
    if (!this._audioRoute) {
      this._audioRoute = new Route(this, (hub) => hub._pickAudioRoute(), { remember: ['audio.policy', 'mic.policy'] }); // whether that device takes our microphone
      this._audioRoute.on('client', (v) => console.log('[audio-route] the microphone goes to', this._nameOf(v.deviceId), '(input peer', this._nameOf(this._inputPeer) + ', selected', this._nameOf(this.selectedId) + ', staying', JSON.stringify(this._audioSticky) + ')'));
      this._audioRoute.on('closed', (v) => console.log('[audio-route] left', (v && v.name) || '-'));
      this._audioRoute.refresh();
    }
    return this._audioRoute;
  }

  setAudioSticky(which, id) {
    if ((this._audioSticky[which] || null) !== (id || null)) console.log('[audio-route]', which, id ? 'stays with ' + this._nameOf(id) : 'no longer stays');
    if (id) this._audioSticky[which] = id;
    else delete this._audioSticky[which];
    if (this._audioRoute) this._audioRoute.refresh();
  }

  // The microphone's graph (docs/mesh-graph.md, step 3): one device, the one using this computer (the input
  // peer, from MeshShadow) before the selection; a live microphone stays where it is.
  setInputPeer(id) {
    if ((this._inputPeer || null) === (id || null)) return;
    this._inputPeer = id || null;
    if (this._audioRoute) this._audioRoute.refresh();
  }

  _pickAudioRoute() {
    for (const id of Object.values(this._audioSticky)) {
      const s = id ? this.sessions.get(id) : null;
      if (s && s.connected) return id;
    }
    const p = this._inputPeer ? this.sessions.get(this._inputPeer) : null;
    if (p && p.connected && !P.isPhoneOs(p.peerOs)) return p.id; // a phone's microphone has its own stack
    return this.selectedId;
  }

  // One-to-one link shape (welcome/closed) over audioRoute().
  audioLink() {
    if (this._audioLink) return this._audioLink;
    const hub = this;
    const route = this.audioRoute();
    this._audioLink = {
      on(type, fn) {
        if (type === 'welcome') route.on('client', (v) => fn(hub._welcomeInfo(hub.sessions.get(v.deviceId))));
        else if (type === 'closed') route.on('closed', (v) => fn(v));
        else route.on(`t:${type}`, (m) => fn(m));
      },
      send: (obj) => route.send(obj),
      get status() {
        const s = route.session;
        return s ? s.status : { state: hub._nothingState(), rtt: null, message: '' };
      },
      get lastRx() {
        const s = route.session;
        return s ? s.lastRx : 0;
      },
      get bufferedAmount() {
        const s = route.session;
        return s ? s.bufferedAmount : 0;
      },
      get hosting() {
        const s = route.session;
        return !!s && s.hosting;
      },
      get peerOs() {
        const s = route.session;
        return s ? s.peerOs : P.OS.MAC;
      },
      get server() {
        return hub.server;
      },
      get pairing() {
        return hub.pairing;
      },
      get current() {
        return route.current;
      },
    };
    return this._audioLink;
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

  // The device the net hook serves (netlink.js: Bluetooth to Wi-Fi): the one main binds it to (netId),
  // else the selected one.
  get netTarget() {
    return this.netId !== undefined ? this.netId : this.selectedId;
  }

  // ---- what the UI shows ----

  // Every paired device, connected or not. state: 'connected' | the guest link's state (connecting,
  // reconnecting, ...) | 'waiting' (a device that dials us and is not connected now).
  // direct: its direct links from its roster (null when connected but not known, or not connected).
  // indirect: also the devices only a peer is linked to (state 'via'), for what the UI lists.
  peers({ indirect = false } = {}) {
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
    // Devices only a peer is linked to (Mesh.known(), from the peers' rosters): listed too, not connected here.
    if (indirect) for (const k of this.mesh.known()) {
      if (k.direct || k.id === this.device.id || ids.includes(k.id)) continue;
      const via = k.via.map((v) => (this.mesh.get(v) || {}).name || v);
      out.push({
        id: k.id, name: k.name, os: k.os || P.OS.WIN, state: 'via', rtt: null, address: '', role: '',
        selected: false, connected: false, direct: null, via,
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
      peers: this.peers({ indirect: true }),
    };
  }

  // ---- internals: devices ----

  _attach(s) {
    s.tap((msg, ws) => this._fromDevice(s, msg, ws));
    s.onLife((up, replaced) => (up ? this._up(s) : this._down(s, replaced)));
    s.onState(() => this._stateOf(s));
    s.refresh(); // a device that is already connected comes up now
  }

  // A message of one device: roster messages are the mesh's, the rest goes to the bus (any device)
  // and to the facade (the selected device). True keeps it away from the session's own handlers.
  _fromDevice(s, msg, ws = null) {
    if (msg.t === ROSTER) {
      if (this.mesh.handle(s.id, msg)) this._change();
      return true;
    }
    busVerbose(s, msg); // Debug › Verbose log › bus
    // The net hook's device's messages reach it first (netlink.js: its net.* and file chunks).
    if (this.netTap && s.id === this.netTarget) this.netTap(msg);
    let consumed = false;
    const fns = this._busHandlers.get(msg.t);
    if (fns) {
      consumed = true;
      for (const fn of fns) fn(msg, s.id, ws);
    }
    if (this._audioRoute && this._audioRoute.targetId === s.id
      && (this._audioRoute.listenerCount(`t:${msg.t}`) > 0 || this._audioRoute.listenerCount('message') > 0)) {
      consumed = true;
      this._audioRoute.deliver(msg);
    } else if (!consumed && (msg.t === 'audio.policy' || msg.t === 'audio.offer' || msg.t === 'mic.policy')) {
      const to = this._audioRoute && this._audioRoute.targetId;
      console.log('[audio-route]', msg.t, 'from', this._nameOf(s.id), 'kept for later: sound is with', to ? this._nameOf(to) : 'nobody', msg.t.endsWith('policy') ? 'accept ' + msg.accept : '');
    }
    return consumed;
  }

  _nameOf(id) {
    const s = id ? this.sessions.get(id) : null;
    return id ? `${s ? s.displayName() : '?'} (${String(id).slice(0, 8)})` : 'nobody';
  }

  _up(s) {
    this.mesh.addPeer({ id: s.id, name: s.displayName(), os: s.peerOs, send: (m) => s.send(m), mesh: s.meshCapable });
    this._rosterAll();
    this._peerEvent('welcome', s.id, this._welcomeInfo(s));
    if (this.selectedId === null) this._select(s.id);
    if (this._audioRoute) this._audioRoute.refresh();
    this.emit('peerAdded', s.id);
    this._change();
  }

  // replaced: the device got a new socket, so it is down and up again at once. Its selection stays.
  _down(s, replaced = false) {
    this.mesh.removePeer(s.id);
    this._rosterAll();
    this._peerEvent('closed', s.id, {});
    if (this._audioRoute) this._audioRoute.drop(s.id);
    if (this.selectedId === s.id && !replaced) this._select(this._pickConnected());
    else if (this._audioRoute) this._audioRoute.refresh();
    this.emit('peerRemoved', s.id);
    this._change();
  }

  _stateOf(s) {
    const tr = s.transport; // onto Bluetooth or back: the device's features hear 'transport'
    if (tr !== s.lastTransport) {
      s.lastTransport = tr;
      this._peerEvent('transport', s.id, {});
    }
    const e = this.mesh.get(s.id);
    if (e) {
      e.mesh = s.meshCapable;
      e.name = s.displayName();
    }
    if (s.id === this.selectedId) this._facadeState();
    if (this._audioRoute) this._audioRoute.refresh();
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

  // The selection is the device the pages show (and a crossing picks). Nothing routes through it any more
  // (step 5 of docs/mesh-graph.md): the facade has no events, no replay and no goodbyes; every feature is
  // on its own link per device, and the ones that follow the selection bind to it themselves ('selected').
  _select(id) {
    const next = id || null;
    if (next === this.selectedId) return;
    this.selectedId = next;
    if (this.server) this.server.setPrimary(next);
    this._facadeState();
    if (this._audioRoute) this._audioRoute.refresh();
    this.emit('selected', next);
    this._change();
  }

  _facadeSend(obj) {
    const s = this.selected;
    return !!s && s.send(obj) === true;
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
  // (shared/pcscreen-set.js) are made on it; bind(id) attaches one made before the device was there.
  scoped(id = null) {
    const hub = this;
    const sess = () => (link.id ? hub.sessions.get(link.id) : null);
    const link = {
      id,
      bind(next) { link.id = next; },
      on(type, fn) {
        if (type === 'welcome' || type === 'closed') addTo(hub._peerHandlers, type, (pid, info) => pid === link.id && fn(info));
        else hub.bus.on(type, (m, from, ws) => from === link.id && fn(m, ws));
      },
      onState(fn) { hub._facadeStateFns.push(fn); },
      send(obj) {
        const s = sess();
        if (!s || !s.connected) return false;
        // The net hook's device on Bluetooth: files wait for Wi-Fi (netHold), whichever link sends them.
        if (hub.netHold && link.id === hub.netTarget && hub.netHold(obj)) return true;
        return s.send(obj) === true;
      },
      // The authenticated physical socket this device's session runs on now (#286: a screen's detail
      // request counts only from the socket the screen session was offered on).
      screenSocket() {
        const s = sess();
        if (!s || !s.connected) return null;
        const ctx = s.hosting ? s.ctx : null;
        const ws = s.linkUp ? s.link.ws : ctx && ctx.authed === true && !ctx.released ? ctx.ws : null;
        return ws && ws.readyState === 1 && !ws.released ? ws : null;
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
    // Fast files of this device (shared/meshfx.js): its receivers' hooks join every session's.
    link.fx = require('../../shared/meshfx.js').facadeFx(sess, () => hub.sessions.list(), hub.sessions.fxShared);
    return link;
  }

  // A link that follows the selection, except while hold() says it's in use: it stays with its device then
  // (Apps › Move windows, #313: a pointer visit to a third device took the moved windows home, their copies
  // there kept a frozen picture, and closing one couldn't bring its window back). Moving to another device
  // is a 'closed' for the one it leaves (the policies it turned on there go off) and a 'welcome' for the
  // next, with the last of `remember` that one said meanwhile (shared/link-memory.js); its device going is
  // the scoped link's own 'closed'. follow(): look again (hold() just ended). current: that device.
  sticky(hold = () => false, { remember = [] } = {}) {
    const hub = this;
    const link = this.scoped(this.selectedId);
    const fns = new Map(); // type -> [fn]: told again on a move
    const said = new Goodbyes(); // the policies it turned on at its device: switched off there when it leaves
    const memory = new LinkMemory(this.bus, remember);
    let moves = 0;
    const on = link.on;
    link.on = (type, fn) => { addTo(fns, type, fn); on(type, fn); };
    const send = link.send;
    link.send = (obj) => {
      const ok = send(obj);
      if (ok) said.note(link.id, obj);
      return ok;
    };
    on('closed', () => said.forget(link.id)); // its device went: nothing to switch off there
    const tell = (id) => {
      const s = id ? hub.sessions.get(id) : null;
      if (!s || !s.connected) return;
      for (const fn of fns.get('welcome') || []) fn(hub._welcomeInfo(s));
      for (const m of memory.replay(id)) for (const fn of fns.get(m.t) || []) fn(m);
    };
    // To another device: 'closed' here, what it told the old one switched off there, 'welcome' for the new.
    link.moveTo = (next) => {
      next = next || null;
      if (next === link.id) return;
      const was = link.id;
      if (was) {
        for (const fn of fns.get('closed') || []) fn({});
        const old = hub.sessions.get(was);
        const bye = said.take(was);
        if (old && old.connected) for (const m of bye) old.send(m);
      }
      link.bind(next);
      moves++;
      tell(next);
    };
    link.follow = () => { if (!hold()) link.moveTo(hub.selectedId); };
    const view = () => {
      const s = link.id ? hub.sessions.get(link.id) : null;
      return s && s.connected ? s : null;
    };
    Object.defineProperty(link, 'current', {
      get() {
        const s = view();
        if (!s) return null;
        const hosting = s.hosting;
        return {
          deviceId: s.id, name: s.displayName(), os: s.peerOs, role: s.role, transport: s.transport,
          address: hosting ? s.ctx.address : (s.link && s.link.pairing ? s.link.pairing.address : ''),
          rttMs: s.status.rtt, lastRx: s.lastRx, ws: hosting ? s.ctx.ws : (s.link ? s.link.ws : null),
        };
      },
    });
    // The facade's snapshot() shape, of its device (Monitor 2's title reads link.macName).
    link.snapshot = () => {
      const s = view();
      if (!s) return { link: hub._nothingLink(), session: null };
      const c = link.current;
      return { link: { state: 'connected', rtt: c.rttMs, message: '', macName: c.name, address: c.address }, session: { id: s.id, name: c.name, os: c.os } };
    };
    this.on('selected', () => link.follow());
    // Made while its device is already up: its users (made right after) hear that device's 'welcome' and
    // what it said, as if it had just come.
    setImmediate(() => { if (!moves) tell(link.id); }); // moved meanwhile: that move told them
    return link;
  }


  _makeFacade() {
    const hub = this;
    const chunk = (obj) => { if (obj && obj.t === P.T.FILE_CHUNK) fx.sentChunk(); }; // Engines in use: the old way
    // Fast files (shared/meshfx.js) of the selected device, as the one-to-one link.fx.
    const fx = require('../../shared/meshfx.js').facadeFx(() => hub.selected, () => hub.sessions.list(), hub.sessions.fxShared);
    return {
      fx,
      // No events (step 5): a feature listens on its own link (hub.scoped, hub.sticky) or the bus.
      on: (type) => { throw new Error(`hub.facade.on('${type}'): the facade has no events; use hub.scoped(id), hub.sticky() or hub.bus`); },
      onState: (fn) => hub._facadeStateFns.push(fn),
      // A message to the selected device; while it is on Bluetooth, files may wait for Wi-Fi (netHold).
      send: (obj) => {
        chunk(obj);
        if (hub.netHold && hub.selectedId === hub.netTarget && hub.netHold(obj)) return true;
        return hub._facadeSend(obj);
      },
      sendNow: (obj) => {
        chunk(obj);
        return hub._facadeSend(obj);
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
      // Disconnect (the device that connected to us is let go; our guest link stays until Connect) and
      // Connect again / Take over (the guest link of the selected device dials it again).
      disconnect: () => {
        const s = hub.selected;
        if (!s) return;
        if (s.hostUp && hub.server) return hub.server.release(s.ctx);
        const l = hub.links.get(s.id);
        if (l) l.disconnect();
      },
      connect: (takeover = false) => {
        const l = hub.selectedId ? hub.links.get(hub.selectedId) : null;
        if (l) l.connect(!!takeover);
      },
    };
  }
}

module.exports = { Hub };

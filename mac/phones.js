// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Every phone this Mac drives (port of windows/phones.js; here a phone's link is a Peer over a hub route
// bound to that phone's device id, and PhoneDir watches the hub for phones coming and going), each with a stack of its own: a Phone (what it says about itself),
// a PhoneBridge (its adb connection, USB cable first, and its pointer while a computer's input drives
// it) and the PhoneViews (its screen and app windows). The stacks are made by `make(link)` from a link
// scoped to one phone (phone-link.js), so nothing in a stack knows about other phones.
//
// This object is also the single-phone API the rest of the app grew up with (`phone`): the Phone page
// and the sidebar act on the ACTIVE phone (the selected device when it is a phone, else the one that
// connected last), so with one phone everything behaves as before. Kvm uses it as `kvm.local`, routed by
// the partner it drives: drives(id), drivable(id), handle(msg, id).
//
// Events: 'change' (any phone's view changed).
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { Peer } = require('./peer.js');
const { viewOf } = require('./hub.js');

const CONNECT_WAIT_MS = 8000; // an invited phone that doesn't say hello by then isn't coming
const isPhone = (ctx) => !!ctx && ctx.os === P.OS.ANDROID;

// The phones connected to this Mac, as events and lookups: 'client' (ctx) when one says hello, 'closed' when
// it goes, 't:<type>' (msg, ctx) for what a phone sends, ctxOf(id), all(), and scoped(id) for a link to one.
class PhoneDir extends EventEmitter {
  constructor(hub, server) {
    super();
    this.hub = hub;
    this.server = server;
    this.wired = new Set();
    hub.bus.onPeer('welcome', (id) => { const c = this.ctxOf(id); if (c) this.emit('client', c); });
    hub.bus.onPeer('closed', (id) => { const s = hub.sessions.get(id); if (s && s.peerOs === P.OS.ANDROID) this.emit('closed', { deviceId: id }); });
    this.on('newListener', (ev) => {
      if (typeof ev !== 'string' || !ev.startsWith('t:') || this.wired.has(ev)) return;
      this.wired.add(ev);
      hub.bus.on(ev.slice(2), (m, fromId) => {
        const c = this.ctxOf(fromId);
        if (c) this.emit(ev, m, c);
      });
    });
  }

  ctxOf(id) {
    const s = id ? this.hub.sessions.get(id) : null;
    if (!s || !s.connected || s.peerOs !== P.OS.ANDROID) return null;
    return viewOf(s);
  }

  all() {
    return this.hub.sessions.list().filter((s) => s.connected && s.peerOs === P.OS.ANDROID).map((s) => this.ctxOf(s.id)).filter(Boolean);
  }

  scoped(id = null) {
    return new ScopedPhonePeer(this.hub, this.server, id);
  }
}

// A Peer (peer.js) over a route that follows one phone: bind(id) points it at the phone.
class ScopedPhonePeer extends Peer {
  constructor(hub, server, id) {
    const box = { id };
    super(hub.route((h) => {
      const s = box.id ? h.sessions.get(box.id) : null;
      return s && s.connected ? box.id : null;
    }), server);
    this.box = box;
  }

  get id() {
    return this.box.id;
  }

  bind(id) {
    this.box.id = id;
    this.route.refresh();
  }
}

class PhoneSet extends EventEmitter {
  // hub: hub.js; link: phone-link.js; make(scopedLink) -> { phone, bridge, views }; onUnit(unit) once per stack.
  constructor({ hub, link, raw, discovery, pairing, make, onUnit = () => {}, wired = null }) {
    super();
    Object.assign(this, { hub, link, raw, discovery, pairing, make, onUnit, wired });
    this.byId = new Map(); // phone device id -> stack
    this.seq = 0;
    this.reply = null; // kvm.attachLocal: a phone's answers (accept, refuse, home) go to Kvm as the partner's messages
    this.all = []; // every stack, the first one made before any phone is there
    this.connecting = null; // {id, name, timer}
    this.message = '';
    // Before the stacks are made: the stack of a phone must be bound before its own listeners hear 'client'.
    link.on('client', (ctx) => this._client(ctx));
    this.first = this._create();
  }

  _create() {
    const scoped = this.link.scoped(null);
    const unit = this.make(scoped);
    unit.link = scoped;
    unit.seq = 0;
    unit.bridge.reply = (msg) => this.reply && this.reply(msg, unit.link.id);
    this.all.push(unit);
    unit.phone.on('change', () => this.emit('change'));
    this.onUnit(unit);
    return unit;
  }

  // A phone said hello: it gets its stack (the first phone takes the one that was waiting).
  _client(ctx) {
    if (!isPhone(ctx) || this.byId.has(ctx.deviceId)) return this._doneConnecting('');
    const unit = this.first.link.id === null ? this.first : this._create();
    unit.link.bind(ctx.deviceId);
    unit.id = ctx.deviceId;
    unit.seq = ++this.seq;
    this.byId.set(ctx.deviceId, unit);
    this._doneConnecting('');
  }

  unit(id) {
    return id ? this.byId.get(id) || null : this.active;
  }

  // The phone the Phone page shows: the selected device when it is a phone, else the one that connected last.
  get active() {
    const sel = this.hub.selectedId ? this.byId.get(this.hub.selectedId) : null;
    if (sel) return sel;
    let best = null;
    for (const u of this.all) if (u.link.current && (!best || u.seq > best.seq)) best = u;
    return best || this.first;
  }

  get bridge() { return this.active.bridge; }
  get views() { return this.active.views; }
  get info() { return this.active.phone.info; }
  get adb() { return this.active.phone.adb; }
  get apps() { return this.active.phone.apps; }
  get assets() { return this.active.phone.assets; }
  assetsView() { return this.active.phone.assetsView(); }
  get connected() { return !!this.active.link.current; }
  // The active phone's bridge and windows as stable objects (the rest of the app keeps one reference).
  get bridgeProxy() { return this._proxy('bridge'); }
  get viewsProxy() { return this._proxy('views'); }
  _proxy(key) {
    return new Proxy({}, {
      get: (_t, name) => {
        const target = this.active[key];
        const v = target[name];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }
  get focused() { return this.all.some((u) => u.views && u.views.focused); }

  // ---- Kvm's `local`: the phone behind the partner it drives ----

  // Is device `id` a phone with a stack here that is connected? (No id: any connected phone.)
  drives(id) {
    if (id === undefined || id === null) return this.all.some((u) => !!u.link.current);
    const u = this.byId.get(id);
    return !!u && !!u.link.current;
  }

  drivable(id) {
    const u = this.unit(id);
    return !!u && (!u.bridge.drivable || u.bridge.drivable());
  }

  handle(m, id) {
    const u = this.unit(id);
    if (u) u.bridge.handle(m);
  }

  // ---- the sidebar and the Phone page ----

  // Connected phones, those on a cable, and paired ones discovery sees right now.
  nearby() {
    const paired = new Map(this.pairing.list().filter((p) => p.os === P.OS.ANDROID).map((p) => [p.id, p]));
    const out = [];
    for (const u of this.all) {
      const c = u.link.current;
      if (c) out.push({ id: c.deviceId, name: c.name, connected: true, usb: !!c.ice });
    }
    for (const id of this.wired ? this.wired.byDevice.keys() : []) {
      if (paired.has(id) && !out.some((x) => x.id === id)) out.push({ id, name: paired.get(id).name, connected: false, usb: true });
    }
    for (const d of this.discovery.list()) {
      if (d.os !== P.OS.ANDROID || !paired.has(d.id) || out.some((x) => x.id === d.id)) continue;
      out.push({ id: d.id, name: d.name || paired.get(d.id).name, address: d.address, connected: false });
    }
    return out;
  }

  // The tile was clicked: ask that phone to connect. Its hello takes the session from the computer.
  connect(id) {
    id = String(id);
    const here = this.byId.get(id);
    if (here && here.link.current) return;
    if (this.wired && this.wired.connect(id)) {
      const p = this.pairing.list().find((x) => x.id === id);
      clearTimeout(this.connecting && this.connecting.timer);
      this.connecting = { id, name: p ? p.name : 'The phone', timer: setTimeout(() => this._doneConnecting(`${p ? p.name : 'The phone'} didn’t answer. Open TwinDesk on it.`), CONNECT_WAIT_MS) };
      this.message = '';
      return this.emit('change');
    }
    const d = this.discovery.get(id);
    if (!d || d.os !== P.OS.ANDROID) return this._fail('That phone isn’t nearby any more.');
    clearTimeout(this.connecting && this.connecting.timer);
    this.connecting = { id: d.id, name: d.name, timer: setTimeout(() => this._doneConnecting(`${d.name} didn’t answer. Open TwinDesk on it.`), CONNECT_WAIT_MS) };
    this.message = '';
    this.discovery.invite(d.address);
    setTimeout(() => this.connecting && this.connecting.id === d.id && this.discovery.invite(d.address), 700); // UDP may drop one
    this.emit('change');
  }

  // Let the active phone go: it won't resume, and the computer reconnects by itself.
  disconnect() {
    const c = this.active.link.current;
    if (c) this.raw.releasePhone(c);
  }

  _fail(message) {
    this.message = message;
    this.emit('change');
  }

  _doneConnecting(message) {
    if (!this.connecting && !message) return;
    clearTimeout(this.connecting && this.connecting.timer);
    this.connecting = null;
    this.message = message;
    this.emit('change');
  }

  shutdown() {
    for (const u of this.all) if (u.views) u.views.shutdown();
  }

  get view() {
    const a = this.active;
    const c = a.link.current;
    const v = a.phone.view; // info, adb, apps, assets, bridge: of the active phone
    return {
      ...v,
      nearby: this.nearby(),
      connected: c ? { id: c.deviceId, name: c.name, rttMs: c.rttMs, usb: !!c.ice } : null,
      connecting: this.connecting ? { id: this.connecting.id, name: this.connecting.name } : null,
      message: this.message || v.message,
      activeId: c ? c.deviceId : null,
      // Every phone connected now, each with how its adb connection is doing.
      phones: this.all.filter((u) => u.link.current).map((u) => ({
        id: u.link.current.deviceId, name: u.link.current.name, usb: !!u.link.current.ice, state: u.bridge.state, via: u.bridge.via,
      })),
    };
  }
}

module.exports = { PhoneSet, PhoneDir, ScopedPhonePeer };

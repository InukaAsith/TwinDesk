// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Joining everyone (docs/mesh.md "Joining everyone", protocol in shared/intro.js): this PC introduces
// two devices it is connected to when they are not linked to each other (introducer), makes a pairing
// for a device its trusted peer vouches for (host), and stores a grant it receives (guest).
// Plain Node: no Electron. Everything is off when enabled() is false.
'use strict';

const I = require('../shared/intro.js');
const P = require('../shared/protocol.js');

const GRANT_GAP_MS = 10000; // one grant per guest id in this time (host side)
const DELAY_MS = 150; // changes of the links settle before we plan

class AutoJoin {
  // hub: Hub (hub.js); enabled(): the setting mesh.autoJoin; addrs(): this PC's IPv4 addresses, LAN
  // first. The host's fp, port and pairing are read from the hub when needed (they exist later).
  constructor({ hub, enabled = () => true, addrs = () => [], log = (...a) => console.log('[autojoin]', ...a), now = () => Date.now() }) {
    this.hub = hub;
    this.enabled = enabled;
    this.addrs = addrs;
    this.log = log;
    this.now = now;
    this.state = new Map(); // "host>guest" -> last time asked (I.plan)
    this.pending = new I.Pending();
    this.lastGrant = new Map(); // guest id -> time of the last grant we made
    this.timer = null;
    const again = () => this.schedule();
    hub.mesh.on('roster', again);
    hub.on('peerAdded', again);
    hub.on('peerRemoved', again);
    hub.bus.on(I.ASK, (m, from) => this.onAsk(m, from));
    hub.bus.on(I.REPLY, (m, from) => this.onReply(m, from));
    hub.bus.on(I.GRANT, (m, from) => this.onGrant(m, from));
  }

  close() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try { this.run(); } catch (e) { this.log('plan failed:', e.message); }
    }, DELAY_MS);
    if (this.timer.unref) this.timer.unref();
  }

  // Our direct, connected, mesh-speaking sessions.
  _peers() {
    return this.hub.sessions.list().filter((s) => s.connected && s.meshCapable).map((s) => ({ id: s.id, os: s.peerOs }));
  }

  // "guest>host" links we can see: our own guest links and the devices that dial us.
  _dials() {
    const d = new Set();
    const self = this.hub.device.id;
    for (const l of this.hub.links.list()) if (l.pairing) d.add(`${self}>${l.pairing.macId}`);
    if (this.hub.pairing) for (const g of this.hub.pairing.list()) d.add(`${g.id}>${self}`);
    return d;
  }

  // The introducer: ask the host of each unlinked pair to make a pairing for its guest.
  run() {
    if (!this.enabled()) return;
    this.pending.sweep(this.now());
    const peers = this._peers();
    if (peers.length < 2) return;
    const todo = I.plan({ selfId: this.hub.device.id, peers, roster: this.hub.mesh.roster, state: this.state, now: this.now(), dials: this._dials() });
    for (const t of todo) {
      const guest = this.hub.sessions.get(t.guest);
      const host = this.hub.sessions.get(t.host);
      if (!guest || !host || !host.connected) continue;
      const req = I.newReq();
      this.pending.add(req, t.host, t.guest, this.now());
      this.log(`introducing ${guest.displayName()} to ${host.displayName()}`);
      host.send({ t: I.ASK, req, for: t.guest, name: guest.displayName(), os: t.guestOs });
    }
  }

  _fromPeer(from) {
    const s = this.hub.sessions.get(from);
    return s && s.connected && s.meshCapable ? s : null;
  }

  // Host side: a trusted device asks for a pairing for another device.
  onAsk(m, from) {
    if (!this.enabled() || !I.validAsk(m) || !this._fromPeer(from)) return;
    const reply = (extra) => {
      const s = this._fromPeer(from);
      if (s) s.send({ t: I.REPLY, req: m.req, for: m.for, ...extra });
    };
    const { pairing, server } = this.hub;
    const self = this.hub.device.id;
    if (!pairing || !server || !server.port) return reply({ ok: false, error: 'not listening' });
    if (m.for === from || m.for === self) return reply({ ok: false, error: 'bad device' });
    if (server.clients && server.clients.has(m.for)) return reply({ ok: false, error: 'already connected' });
    const t = this.now();
    if (t - (this.lastGrant.get(m.for) || -Infinity) < GRANT_GAP_MS) return reply({ ok: false, error: 'too soon' });
    const addrs = this.addrs().slice(0, 8);
    if (!addrs.length) return reply({ ok: false, error: 'no address' });
    this.lastGrant.set(m.for, t);
    const g = pairing.grantFor({ id: m.for, name: m.name, os: m.os });
    if (!g) return reply({ ok: false, error: 'refused' });
    reply({
      ok: true, macId: self, macName: this.hub.device.name, os: P.OS.WIN,
      fp: pairing.id.fp, port: server.port, addrs, token: g.token,
    });
  }

  // Introducer: the host answered; forward the credential to the guest.
  onReply(m, from) {
    if (!I.validGrant(m) || m.t !== I.REPLY) return;
    const e = this.pending.take(m.req, from, this.now());
    if (!e) return;
    if (m.ok === false) return this.log(`${from} would not join: ${m.error || 'refused'}`);
    if (!this.enabled() || m.macId !== e.host) return;
    const g = this.hub.sessions.get(e.guest);
    if (!g || !g.connected) return;
    g.send({ t: I.GRANT, req: m.req, macId: m.macId, macName: m.macName, os: m.os, fp: m.fp, port: m.port, addrs: m.addrs, token: m.token });
  }

  // Guest side: a trusted device sends the credential of a host.
  onGrant(m, from) {
    if (!this.enabled() || !I.validGrant(m) || m.t !== I.GRANT || !this._fromPeer(from)) return;
    if (m.macId === this.hub.device.id || m.macId === from) return; // never a link to ourselves or to the introducer
    const r = this.hub.links.addGrant(m);
    if (r) this.log(`${r} ${m.macName || m.macId} (introduced by ${from})`);
  }
}

module.exports = { AutoJoin, GRANT_GAP_MS };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Joining everyone on the Mac (shared/intro.js is the protocol, docs/mesh.md "Joining everyone"):
// this Mac is a host (ask -> pairing.grantFor -> reply), a guest (grant -> links.addGrant) and an
// introducer (plan() over its direct mesh sessions: ask the host, forward its reply as a grant).
// Messages come from the hub's bus, so only authenticated, mesh-speaking devices take part.
'use strict';

const os = require('os');
const I = require('../shared/intro.js');
const P = require('../shared/protocol.js');

const GRANT_GAP_MS = 10000; // one grant per guest per this long
const PLAN_DELAY_MS = 400; // roster messages come in bursts

const isPrivate = (a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);

// This Mac's non-internal IPv4 addresses, LAN ones first.
function localAddrs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out.sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a))).slice(0, 8);
}

class AutoJoin {
  // opts: hub, mesh, pairing, links (LinkManager), identity {macId, macName}, server (for the port),
  //   enabled() -> bool (settings.mesh.autoJoin !== false), addrs() -> [ip], introduce (default true),
  //   now() (tests), onJoin(id) called when a grant was stored.
  constructor({ hub, mesh, pairing, links, identity, server, enabled = () => true, addrs = localAddrs, introduce = true, now = Date.now, onJoin = null }) {
    Object.assign(this, { hub, mesh, pairing, links, identity, server, enabled, addrs, introduce, now, onJoin });
    this.pending = new I.Pending();
    this.state = new Map(); // plan(): "host>guest" -> last asked
    this.lastGrant = new Map(); // guest id -> last grant we made
    this.timer = null;
    hub.bus.on(I.ASK, (m, from) => this._onAsk(m, from));
    hub.bus.on(I.REPLY, (m, from) => this._onReply(m, from));
    hub.bus.on(I.GRANT, (m, from) => this._onGrant(m, from));
    mesh.on('roster', () => this.schedule());
    links.on('add', () => this.schedule());
    links.on('remove', () => this.schedule());
  }

  on() {
    return this.enabled() !== false;
  }

  _peer(id) {
    const e = this.mesh.get(id);
    return e && e.mesh ? e : null; // a connected device that speaks the mesh
  }

  schedule() {
    if (this.timer || !this.introduce) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, PLAN_DELAY_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  // The introducer: every pair of our direct mesh devices that are not linked is introduced.
  run() {
    if (!this.introduce || !this.on()) return [];
    const peers = this.mesh.peers().filter((e) => e.mesh).map((e) => ({ id: e.id, os: e.os }));
    const dials = new Set();
    for (const l of this.links.list()) if (l.authed && l.pairing) dials.add(`${this.mesh.selfId}>${l.pairing.macId}`);
    this.pending.sweep(this.now());
    const pairs = I.plan({ selfId: this.mesh.selfId, peers, roster: this.mesh.roster, state: this.state, now: this.now(), dials });
    for (const pr of pairs) {
      const guest = this.mesh.get(pr.guest);
      const host = this._peer(pr.host);
      if (!guest || !host) continue;
      const req = I.newReq();
      this.pending.add(req, pr.host, pr.guest, this.now());
      host.send({ t: I.ASK, req, for: pr.guest, name: guest.name || '', os: guest.os || '' });
    }
    return pairs;
  }

  // Host: make a pairing for the guest and hand the credential back to the introducer.
  _onAsk(m, from) {
    if (!this._peer(from) || !I.validAsk(m)) return;
    const reply = (extra) => this.mesh.get(from) && this.mesh.get(from).send({ t: I.REPLY, req: m.req, for: m.for, ...extra });
    if (!this.on()) return void reply({ ok: false, error: 'off' });
    if (m.for === from || m.for === this.mesh.selfId || m.for === this.identity.macId) return;
    const t = this.now();
    if (this.lastGrant.has(m.for) && t - this.lastGrant.get(m.for) < GRANT_GAP_MS) return void reply({ ok: false, error: 'rate' });
    const guest = this.mesh.get(m.for);
    const g = this.pairing.grantFor({ id: m.for, name: m.name || (guest && guest.name), os: m.os || (guest && guest.os) });
    if (!g) return void reply({ ok: false, error: 'refused' });
    this.lastGrant.set(m.for, t);
    const addrs = this.addrs();
    if (!addrs.length) return void reply({ ok: false, error: 'no address' });
    reply({ ok: true, macId: g.macId, macName: g.macName, os: g.os, fp: g.fp, port: this.server.port, addrs, token: g.token });
  }

  // Introducer: the reply of the host we asked, forwarded once to the guest.
  _onReply(m, from) {
    if (!this._peer(from) || m.t !== I.REPLY || !I.validGrant(m)) return;
    const e = this.pending.take(m.req, from, this.now());
    if (!e || m.ok === false) return;
    const guest = this._peer(e.guest);
    if (!guest) return;
    guest.send({ t: I.GRANT, req: m.req, macId: m.macId, macName: m.macName, os: m.os, fp: m.fp, port: m.port, addrs: m.addrs, token: m.token });
  }

  // Guest: store the credential like a finished pairing; the link dials the host.
  _onGrant(m, from) {
    if (!this._peer(from) || m.t !== I.GRANT || !I.validGrant(m) || !this.on()) return;
    if (m.macId === this.mesh.selfId || m.macId === this.identity.macId || m.ok === false) return;
    const address = this._pick(m.addrs);
    const ok = this.links.addGrant({ macId: m.macId, macName: String(m.macName || '').slice(0, 64), os: Object.values(P.OS).includes(m.os) ? m.os : undefined, address, port: m.port, fp: m.fp, token: m.token });
    if (ok && this.onJoin) this.onJoin(m.macId);
  }

  // The address on one of our own networks first, else the first.
  _pick(addrs) {
    const mine = this.addrs().map((a) => a.split('.').slice(0, 3).join('.'));
    return addrs.find((a) => mine.includes(a.split('.').slice(0, 3).join('.'))) || addrs[0];
  }
}

module.exports = { AutoJoin, localAddrs };

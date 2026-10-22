// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The guest side of the mesh: one Link (link.js) per paired host, kept in pairings.json (a list).
//
// A host is a computer we dial (we were paired from it). Pairing runs one at a time: startPairing()
// dials the other PC, confirmCode() after both sides show the same 6-digit code, and on success the
// new Link joins the list ('add').
//
// Tie-break: when two computers hold each other (each dials the other, and each accepts the other's
// inbound link), the smaller device id dials at once and the larger one waits INBOUND_WAIT_MS for
// the inbound link before dialling itself. A link that has an inbound link never dials a second one.
// A one-way pairing never waits.
//
// Events: 'add' (link), 'remove' (id), 'change' (link), 'welcome' (link, msg), 'closed' (link, msg).
'use strict';

const { EventEmitter } = require('events');
const Link = require('./link');
const P = require('../shared/protocol.js');

const FILE = 'pairings.json';
const OLD_FILE = 'pairing.json'; // one object: the single-host storage of earlier versions

const valid = (p) => !!p && typeof p.macId === 'string' && !!p.macId && typeof p.token === 'string'
  && typeof p.fp === 'string' && !!p.fp && typeof p.address === 'string' && !!p.address && Number.isInteger(p.port);

class LinkManager extends EventEmitter {
  // opts: device {id, name}; storage {read, write, remove?} (default: store.js); hostPairing: the
  //   Pairing (hostpair.js) of this PC, to know which devices hold us as their host (mutual pairs);
  //   resolveAddress(macId) -> {address, port}|null; inboundWaitMs (default P.INBOUND_WAIT_MS).
  constructor({ device, storage, hostPairing = null, resolveAddress = null, inboundWaitMs = P.INBOUND_WAIT_MS } = {}) {
    super();
    this.device = device;
    this.storage = storage || require('./store');
    this.hostPairing = hostPairing;
    this.resolveAddress = resolveAddress;
    this.inboundWaitMs = inboundWaitMs;
    this.ble = null; // BleGuest (blepipe.js), set by setBle(): a host not on this network, near over Bluetooth
    this.links = new Map(); // macId -> Link
    this.pairLink = null; // the Link of the pairing in progress (not yet a host)
    this.inbound = new Set(); // ids with an authenticated inbound link (they dialled us)
    this.waitSince = new Map(); // id -> when the wait for an inbound link began
    this.busyFlags = new Map(); // id -> boolean from setBusy()
    this.started = false;
    this.closed = false;
    this.server = null;
    this.alts = new Map(); // id -> {addrs, port, i}: the other addresses of an introduced host, tried until it answers
    this.entries = this._load();
    for (const entry of this.entries) this.links.set(entry.macId, this._newLink(entry));
  }

  // ---- public API ----

  list() {
    return [...this.links.values()];
  }

  get(id) {
    return this.links.get(id) || null;
  }

  // The pairing in progress: its state for the UI ({phase, code, error, ...}) or null.
  pairState() {
    return this.pairLink ? this.pairLink.pairState : null;
  }

  // Dial the computer at target {address, port, macName} to pair with it. One pairing at a time.
  startPairing({ address, port, macName } = {}) {
    if (this.closed) return false;
    if (this.pairLink) {
      if (this.pairLink.pairState && this.pairLink.pairState.phase !== 'failed') return false;
      this.cancelPair();
    }
    if (this.links.size >= P.MAX_DEVICES) return false;
    const link = this._newLink(null);
    this.pairLink = link;
    link.startPairing({ address, port, macName });
    return true;
  }

  confirmCode() {
    if (this.pairLink) this.pairLink.confirmCode();
  }

  cancelPair() {
    const link = this.pairLink;
    if (!link) return;
    this.pairLink = null;
    link.cancelPair();
    link.destroy();
  }

  // Forget a host: its link stops and its pairing is removed.
  forget(id) {
    const link = this.links.get(id);
    if (!link) return;
    link.forget(); // store.clear() → _drop(): removes the entry, the link, emits 'remove'
    link.destroy();
  }

  // A host an already trusted device introduced us to (autojoin.js, mesh.intro.grant): the same entry
  // a pairing writes. grant {macId, macName, os, fp, port, addrs, token}. Returns 'added', 'updated'
  // (the host was a link that is not up: new credential) or '' (ignored).
  addGrant(grant) {
    if (this.closed || !grant || typeof grant.macId !== 'string' || grant.macId === this.device.id) return '';
    const addrs = Array.isArray(grant.addrs) ? grant.addrs.filter((a) => typeof a === 'string' && a) : [];
    if (!addrs.length) return '';
    const p = {
      macId: grant.macId, macName: String(grant.macName || 'Device').slice(0, 64), address: addrs[0], port: grant.port,
      fp: P.normFingerprint(grant.fp), token: grant.token, os: Object.values(P.OS).includes(grant.os) ? grant.os : P.OS.WIN,
    };
    if (!valid(p)) return '';
    const old = this.links.get(p.macId);
    if (old) {
      if (old.authed || this.inbound.has(p.macId)) return ''; // already linked: nothing to do
      Object.assign(old.pairing, p);
      old.store.save(old.pairing);
      this.alts.set(p.macId, { addrs, port: p.port, i: 0 });
      if (this.started) old.poke();
      return 'updated';
    }
    if (this.links.size >= P.MAX_DEVICES) return '';
    const entry = { ...p };
    this.entries = this.entries.filter((e) => e.macId !== p.macId);
    this.entries.push(entry);
    this._write();
    const link = this._newLink(entry);
    this.links.set(p.macId, link);
    if (addrs.length > 1) this.alts.set(p.macId, { addrs, port: p.port, i: 0 });
    link.on('welcome', () => this.alts.delete(p.macId));
    this.emit('add', link);
    if (this.started) link.start();
    return 'added';
  }

  // Discovery first; else the other addresses of an introduced host, one per attempt.
  _resolve(id) {
    const seen = this.resolveAddress ? this.resolveAddress(id) : null;
    if (seen) return seen;
    const a = this.alts.get(id);
    if (!a) return null;
    a.i = (a.i + 1) % a.addrs.length;
    return { address: a.addrs[a.i], port: a.port };
  }

  // Dial every host. Links that must wait (tie-break, inbound link present) wait by themselves.
  start() {
    this.started = true;
    for (const link of this.links.values()) link.start();
  }

  // Stop everything for good (no reconnects). The storage is kept.
  close() {
    this.closed = true;
    for (const link of this.links.values()) link.destroy();
    if (this.pairLink) this.pairLink.destroy();
  }

  // Liveness: a busy link (driving, driven, or selected) pings every PING_MS. Default: a manager
  // with exactly one link treats it as busy (the one-device behaviour); with more, idle.
  setBusy(id, flag) {
    this.busyFlags.set(id, !!flag);
  }

  // Connect the server (server.js) so that its authenticated clients count as inbound links.
  bindServer(server) {
    this.server = server;
    server.on('client', (ctx) => this.inboundConnected(ctx.deviceId));
    server.on('closed', (ctx) => {
      if (ctx.authed && ctx.deviceId && !server.clients.has(ctx.deviceId)) this.inboundDisconnected(ctx.deviceId);
    });
  }

  // The host-side link of device id came up (it dialled us): we drop our own socket to it, so
  // there is one link, and our link waits until the inbound one ends.
  inboundConnected(id) {
    if (!id) return;
    this.inbound.add(id);
    this.waitSince.delete(id);
    const link = this.links.get(id);
    if (link && link.authed) link.yieldSession();
  }

  // The inbound link of device id ended: we wait for it to come back, then dial ourselves.
  inboundDisconnected(id) {
    if (!id) return;
    this.inbound.delete(id);
    this.waitSince.delete(id);
    const link = this.links.get(id);
    if (link && !link.authed && !this.closed) link.poke();
  }

  // ---- internals ----

  // Bluetooth for the links (main.js, once its BleGuest exists): every link, now and later.
  setBle(ble) {
    this.ble = ble;
    for (const link of this.links.values()) link.ble = ble;
  }

  _newLink(entry) {
    let link = null;
    link = new Link({
      device: this.device,
      ble: this.ble,
      blocked: () => this._blocked(link),
      busy: () => this._busy(link),
      resolveAddress: (id) => this._resolve(id),
      store: {
        load: () => entry,
        save: (p) => this._save(link, p),
        clear: () => this._drop(link),
      },
    });
    link.on('welcome', (msg) => this.emit('welcome', link, msg));
    link.on('closed', (msg) => this.emit('closed', link, msg));
    link.onState(() => this.emit('change', link));
    return link;
  }

  _idOf(link) {
    return link.pairing ? link.pairing.macId : null;
  }

  _blocked(link) {
    if (this.closed) return true;
    const id = this._idOf(link);
    if (!id) return false; // a pairing in progress dials at once
    if (this.inbound.has(id) || (this.server && this.server.clients.has(id))) return true;
    if (!this._mutual(id)) return false;
    if (this.device.id < id) return false; // the smaller id dials at once
    if (!this.waitSince.has(id)) this.waitSince.set(id, Date.now());
    return Date.now() - this.waitSince.get(id) < this.inboundWaitMs;
  }

  // Both computers hold each other: we dial them, and they are one of our hosts' guests.
  _mutual(id) {
    if (!this.hostPairing || !this.links.has(id)) return false;
    return this.hostPairing.list().some((x) => x.id === id);
  }

  _busy(link) {
    const id = this._idOf(link);
    if (!id) return true;
    if (this.busyFlags.has(id)) return this.busyFlags.get(id);
    return this.links.size <= 1;
  }

  // A pairing succeeded (or a stored link's address changed): remember the entry.
  _save(link, p) {
    const entry = { macId: p.macId, macName: p.macName, address: p.address, port: p.port, fp: p.fp, token: p.token, os: p.os };
    this.entries = this.entries.filter((e) => e.macId !== p.macId);
    this.entries.push(entry);
    this._write();
    if (this.pairLink === link) {
      this.pairLink = null;
      const old = this.links.get(p.macId);
      if (old && old !== link) {
        this.links.delete(p.macId);
        old.destroy();
        this.emit('remove', p.macId);
      }
      this.links.set(p.macId, link);
      this.emit('add', link);
    }
  }

  _drop(link) {
    let id = null;
    for (const [k, v] of this.links) if (v === link) id = k;
    if (id === null) return;
    this.links.delete(id);
    this.entries = this.entries.filter((e) => e.macId !== id);
    this._write();
    this.emit('remove', id);
  }

  _write() {
    this.storage.write(FILE, this.entries);
  }

  // pairings.json: a list. An older single pairing.json is migrated on the first load.
  _load() {
    let list = this.storage.read(FILE, null);
    if (!Array.isArray(list)) {
      const old = this.storage.read(OLD_FILE, null);
      list = valid(old) ? [old] : [];
      if (valid(old)) {
        this.storage.write(FILE, list);
        if (this.storage.remove) this.storage.remove(OLD_FILE);
      }
    }
    return list.filter(valid).slice(0, P.MAX_DEVICES);
  }
}

module.exports = { LinkManager };

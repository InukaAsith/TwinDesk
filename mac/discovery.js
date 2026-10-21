// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Discovery v2: one UDP socket on DISCOVERY_PORT that sends our
// beacon to every broadcast address, answers probes, sends probes and invites, and keeps the list
// of other TwinDesk computers nearby (Macs and PCs).
//
// Events: 'change' — found list or status changed; 'invite' (device) — a Mac asked us to connect.
'use strict';

const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

const RETRY_BIND_MS = 5000;
// Errors that mean macOS's Local Network permission is missing.
const LOCAL_NETWORK_ERRORS = new Set(['EHOSTUNREACH', 'EPERM', 'EACCES', 'ENETUNREACH']);

function ipToInt(ip) {
  return ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
}

function intToIp(n) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}

// Non-internal IPv4 interfaces: [{address, broadcast}]
function interfaces() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const bc = (ipToInt(i.address) | ~ipToInt(i.netmask)) >>> 0;
      out.push({ name, address: i.address, broadcast: intToIp(bc) });
    }
  }
  return out;
}

const isIPv4 = (s) => /^(\d{1,3})(\.\d{1,3}){3}$/.test(s) && s.split('.').every((o) => Number(o) < 256);

class Discovery extends EventEmitter {
  constructor({ macId, macName, fp }, port = P.PORT) {
    super();
    this.self = { id: macId, name: macName, fp, os: P.OS.MAC, port };
    this.found = new Map(); // id -> {id, name, os, address, port, fp, lastSeen, invited}
    this.status = { on: false, error: '', localNetwork: true };
    this.waiters = new Map(); // address -> resolve(device) for unicast probes
    this.sock = null;
    this.timers = [];
    this.sendErrors = new Set();
    this.extra = null; // Bluetooth (blepipe.js BleHost): devices near but not on this network, {list(), invite(id)}
  }

  start() {
    this._bind();
    this.timers.push(setInterval(() => this._beacon(), P.BEACON_MS));
    this.timers.push(setInterval(() => this._prune(), 1000));
    this.timers.push(setInterval(() => this.wantProbes && this.probe(), P.PROBE_MS));
    this.wantProbes = true;
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.bindTimer);
    if (this.sock) try { this.sock.close(); } catch {}
    this.sock = null;
  }

  // On the network first; Bluetooth adds the ones it alone sees (ble: true, address 'ble:…').
  list() {
    const out = [...this.found.values()]
      .map(({ id, name, os: o, address, port, fp, invited }) => ({ id, name, os: o, address, port, fp, invited: !!invited }));
    if (this.extra) for (const d of this.extra.list()) if (!this.found.has(d.id)) out.push({ ...d, invited: false });
    return out.sort((a, b) => (b.invited - a.invited) || a.name.localeCompare(b.name));
  }

  get(id) {
    return this.found.get(id) || (this.extra && this.extra.list().find((d) => d.id === id)) || null;
  }

  // Broadcast a probe (everyone answers with a beacon), or unicast it to one address.
  probe(address) {
    const msg = { t: P.T.PROBE, v: P.PROTOCOL_VERSION, id: this.self.id };
    if (address) this._send(msg, address);
    else for (const target of this._targets()) this._send(msg, target);
  }

  // Refresh: what was found is forgotten (an invite stays), and whoever is there answers again.
  refresh() {
    let changed = false;
    for (const [id, d] of this.found) if (!d.invited) changed = this.found.delete(id);
    if (changed) this.emit('change');
    this._beacon();
    this.probe();
    setTimeout(() => this.probe(), 500); // UDP may drop one
  }

  // Ask one address who is there; resolves to the device or null after PROBE_REPLY_MS.
  ask(address) {
    if (!isIPv4(address)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = (d) => {
        clearTimeout(timer);
        this.waiters.delete(address);
        resolve(d);
      };
      const timer = setTimeout(() => done(null), P.PROBE_REPLY_MS);
      this.waiters.set(address, done);
      this.probe(address);
      setTimeout(() => this.waiters.has(address) && this.probe(address), 500); // UDP may drop one
    });
  }

  // A Mac asks a PC to pair/connect to it (the Mac stays the host).
  invite(address) {
    if (String(address).startsWith('ble:')) {
      const d = this.extra && this.extra.list().find((x) => x.address === address);
      if (d) this.extra.invite(d.id);
      return;
    }
    const { id, name, os: o, port, fp } = this.self;
    this._send({ t: P.T.INVITE, v: P.PROTOCOL_VERSION, id, name, os: o, port, fp }, address);
  }

  _bind() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));
    sock.on('error', (err) => {
      console.error(`[discovery] ${err.code || err.message}`);
      if (sock !== this.sock) return;
      this.sock = null;
      try { sock.close(); } catch {}
      this._setStatus(false, `Can’t listen (${err.code || err.message})`);
      this.bindTimer = setTimeout(() => this._bind(), RETRY_BIND_MS);
    });
    this.sock = sock;
    sock.bind(P.DISCOVERY_PORT, () => {
      sock.setBroadcast(true);
      this._setStatus(true, '');
      this._beacon();
      this.probe();
    });
  }

  _setStatus(on, error) {
    if (this.status.on === on && this.status.error === error) return;
    Object.assign(this.status, { on, error });
    this.emit('change');
  }

  _targets() {
    const t = new Set(interfaces().map((i) => i.broadcast));
    t.add('255.255.255.255');
    return t;
  }

  _beaconMsg() {
    const { id, name, os: o, port, fp } = this.self;
    return { t: P.T.BEACON, v: P.PROTOCOL_VERSION, id, name, port, fp, os: o, role: 'host' };
  }

  _beacon() {
    const msg = this._beaconMsg();
    for (const target of this._targets()) this._send(msg, target);
  }

  _send(msg, address, port = P.DISCOVERY_PORT) {
    if (!this.sock) return;
    this.sock.send(Buffer.from(JSON.stringify(msg)), port, address, (err) => {
      if (!err) {
        if (!this.status.localNetwork && address !== '255.255.255.255') {
          this.status.localNetwork = true;
          this.emit('change');
        }
        return;
      }
      const key = `${address}:${err.code}`;
      if (!this.sendErrors.has(key)) {
        this.sendErrors.add(key);
        console.error(`[discovery] send to ${address} failed: ${err.code || err.message}`);
      }
      // Only a broadcast tells: a probe to one address (a phone asleep or off Wi-Fi, a computer
      // that left) fails with EHOSTUNREACH too, and that isn't the permission.
      if (LOCAL_NETWORK_ERRORS.has(err.code) && this.status.localNetwork && this._targets().has(address)) {
        this.status.localNetwork = false;
        this.emit('change');
      }
    });
  }

  _onMessage(buf, rinfo) {
    let m;
    try {
      m = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!m || m.v !== P.PROTOCOL_VERSION || typeof m.id !== 'string' || m.id === this.self.id) return;
    if (m.t === P.T.PROBE) return this._send(this._beaconMsg(), rinfo.address, rinfo.port);
    if (m.t !== P.T.BEACON && m.t !== P.T.INVITE) return;
    const port = Number.isInteger(m.port) && m.port > 0 && m.port < 65536 ? m.port : P.PORT;
    // Older beacons came only from Macs.
    const o = Object.values(P.OS).includes(m.os) ? m.os : P.OS.MAC;
    const old = this.found.get(m.id);
    const d = {
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name.slice(0, 100) : o === P.OS.MAC ? 'Mac' : 'PC',
      os: o,
      address: rinfo.address,
      port,
      fp: P.normFingerprint(m.fp),
      lastSeen: Date.now(),
      invited: (old && old.invited) || m.t === P.T.INVITE,
    };
    this.found.set(m.id, d);
    const w = this.waiters.get(rinfo.address);
    if (w) w(d);
    if (m.t === P.T.INVITE) this.emit('invite', d);
    if (!old || old.name !== d.name || old.address !== d.address || old.os !== d.os || old.invited !== d.invited) this.emit('change');
  }

  _prune() {
    const now = Date.now();
    let changed = false;
    for (const [id, d] of this.found) {
      if (now - d.lastSeen > P.DEVICE_STALE_MS) {
        this.found.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }
}

module.exports = { Discovery, interfaces, isIPv4 };

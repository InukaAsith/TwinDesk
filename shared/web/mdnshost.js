// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// One name on the local network for this computer, the same whatever address the router gives it
// (TwinDesk Web): `twindesk-xxxxxx.local`, answered over multicast DNS (RFC 6762) with this
// computer's IPv4 addresses. A phone that saved the page (an installed web app) keeps its origin,
// its pairing and its storage when the computer's address changes.
//
// A plain responder: it answers A (and ANY) questions for its one name, announces itself when it
// starts and when the addresses change, and says goodbye when it stops. It shares port 5353 with the
// system's own responder (mDNSResponder, Bonjour for Windows, Avahi) through SO_REUSEADDR/PORT.
//
// new MdnsHost(name).start(); .stop(); .addresses()
'use strict';

const dgram = require('dgram');
const os = require('os');

const GROUP = '224.0.0.251';
const PORT = 5353;
const TTL = 120;

function ipv4s() {
  const out = [];
  for (const [ifname, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (/^(utun|awdl|llw|bridge|vmnet|vboxnet|docker|veth|tailscale|zt)/i.test(ifname) && !i.address.startsWith('192.168.')) continue;
      out.push({ ifname, address: i.address, netmask: i.netmask });
    }
  }
  return out;
}

const ipInt = (ip) => ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
const sameNet = (a, b, mask) => ((ipInt(a) & ipInt(mask)) >>> 0) === ((ipInt(b) & ipInt(mask)) >>> 0);

function encodeName(name) {
  const parts = name.replace(/\.$/, '').split('.');
  return Buffer.concat([...parts.map((p) => Buffer.concat([Buffer.from([Buffer.byteLength(p)]), Buffer.from(p)])), Buffer.from([0])]);
}

// Questions of a query: [{name, type, qu}] (compressed names followed).
function parseQuestions(buf) {
  if (buf.length < 12) return [];
  const flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return []; // a response, not a query
  const qd = buf.readUInt16BE(4);
  const out = [];
  let i = 12;
  const readName = (at) => {
    const labels = [];
    let jumped = false;
    let next = at;
    for (let guard = 0; guard < 64; guard++) {
      const l = buf[at];
      if (l === undefined) return null;
      if (l === 0) { if (!jumped) next = at + 1; break; }
      if ((l & 0xc0) === 0xc0) {
        if (!jumped) next = at + 2;
        at = ((l & 0x3f) << 8) | buf[at + 1];
        jumped = true;
        continue;
      }
      labels.push(buf.toString('utf8', at + 1, at + 1 + l));
      at += 1 + l;
    }
    return { name: labels.join('.'), next };
  };
  for (let q = 0; q < qd && i < buf.length; q++) {
    const n = readName(i);
    if (!n || n.next + 4 > buf.length) break;
    const type = buf.readUInt16BE(n.next);
    const klass = buf.readUInt16BE(n.next + 2);
    out.push({ name: n.name.toLowerCase(), type, qu: !!(klass & 0x8000) });
    i = n.next + 4;
  }
  return out;
}

function answer(name, ips, ttl = TTL) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0x8400, 2); // response, authoritative
  head.writeUInt16BE(ips.length, 6);
  const nm = encodeName(name);
  const rrs = ips.map((ip) => {
    const rr = Buffer.alloc(10);
    rr.writeUInt16BE(1, 0); // A
    rr.writeUInt16BE(0x8001, 2); // IN, cache-flush
    rr.writeUInt32BE(ttl, 4);
    rr.writeUInt16BE(4, 8);
    return Buffer.concat([nm, rr, Buffer.from(ip.split('.').map(Number))]);
  });
  return Buffer.concat([head, ...rrs]);
}

class MdnsHost {
  constructor(name) {
    this.name = String(name).toLowerCase().replace(/\.$/, '');
    if (!this.name.endsWith('.local')) this.name += '.local';
    this.sock = null;
    this.joined = new Set();
    this.lastIps = '';
    this.error = '';
  }

  addresses() {
    return ipv4s().map((i) => i.address);
  }

  start() {
    if (this.sock) return;
    // SO_REUSEADDR: on macOS and Linux it also shares a multicast port (BSD semantics); reusePort fails
    // to bind on macOS (ENOTSUP), so it isn't asked for.
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('error', (e) => {
      this.error = e.message;
      console.warn('[mdnshost]', e.message);
      this.stop(false);
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.start(), 10000);
    });
    sock.on('message', (buf, rinfo) => this._query(buf, rinfo));
    sock.bind(PORT, () => {
      this.error = '';
      try { sock.setMulticastTTL(255); sock.setMulticastLoopback(true); } catch (_) {}
      this._join();
      this._announce();
    });
    // New addresses (another network, the cable): join there and tell the network.
    this.poll = setInterval(() => {
      const now = this.addresses().join(',');
      if (now !== this.lastIps) { this._join(); this._announce(); }
    }, 5000);
  }

  stop(goodbye = true) {
    clearInterval(this.poll);
    clearTimeout(this.retry);
    const s = this.sock;
    this.sock = null;
    this.joined.clear();
    if (!s) return;
    try {
      if (goodbye && this.lastIps) s.send(answer(this.name, this.lastIps.split(','), 0), PORT, GROUP, () => { try { s.close(); } catch (_) {} });
      else s.close();
    } catch (_) {}
  }

  _join() {
    for (const i of ipv4s()) {
      if (this.joined.has(i.address)) continue;
      try { this.sock.addMembership(GROUP, i.address); this.joined.add(i.address); } catch (_) { /* already, or gone */ }
    }
  }

  _send(buf, ifaceIp, to = { address: GROUP, port: PORT }) {
    const s = this.sock;
    if (!s) return;
    try {
      if (ifaceIp && to.address === GROUP) s.setMulticastInterface(ifaceIp);
      s.send(buf, to.port, to.address);
    } catch (_) {}
  }

  _announce() {
    const ifs = ipv4s();
    this.lastIps = ifs.map((i) => i.address).join(',');
    if (!ifs.length) return;
    // Twice, a second apart (RFC 6762 8.3), each interface with its own address.
    const once = () => { for (const i of ipv4s()) this._send(answer(this.name, [i.address]), i.address); };
    once();
    setTimeout(once, 1000);
  }

  _query(buf, rinfo) {
    let qs;
    try { qs = parseQuestions(buf); } catch (_) { return; }
    const mine = qs.find((q) => q.name === this.name && (q.type === 1 || q.type === 255));
    if (!mine) return;
    // The address on the asker's network, else all of them.
    const ifs = ipv4s();
    const near = ifs.filter((i) => sameNet(i.address, rinfo.address, i.netmask));
    const ips = (near.length ? near : ifs).map((i) => i.address);
    if (!ips.length) return;
    const msg = answer(this.name, ips);
    const via = near[0] ? near[0].address : null;
    // A legacy (one-shot) resolver asks from another port and wants the answer back there, with its id.
    if (rinfo.port !== PORT) {
      const legacy = Buffer.from(msg);
      buf.copy(legacy, 0, 0, 2);
      return this._send(legacy, null, { address: rinfo.address, port: rinfo.port });
    }
    if (mine.qu) this._send(msg, null, { address: rinfo.address, port: PORT });
    this._send(msg, via);
  }
}

module.exports = { MdnsHost, ipv4s };

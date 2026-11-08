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
// An alias (twindesk.local: the short name to type) is answered only while no other computer does:
// asked for first (probing, RFC 6762 8.1), and given up when another answers for it; tried again
// a while later.
//
// new MdnsHost(name, alias?).start(); .stop(); .addresses(); .aliasHeld
'use strict';

const dgram = require('dgram');
const os = require('os');

const GROUP = '224.0.0.251';
const PORT = 5353;
const TTL = 120;
// Every TwinDesk Web computer on the network answers for this (a PTR to its own name): each one
// lists the others, so a page (twindesk.local's, or any of them) can offer a choice.
const SERVICE = '_twindesk-web._tcp.local';
const BROWSE_MS = 30000;

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
function nameReader(buf) {
  return (at) => {
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
}

function parseQuestions(buf) {
  if (buf.length < 12) return [];
  const flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return []; // a response, not a query
  const qd = buf.readUInt16BE(4);
  const out = [];
  let i = 12;
  const readName = nameReader(buf);
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

// The A records of a response: [{name, ip}] (questions skipped).
function parseAnswers(buf) {
  if (buf.length < 12 || !(buf.readUInt16BE(2) & 0x8000)) return [];
  const readName = nameReader(buf);
  const qd = buf.readUInt16BE(4);
  const rr = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let i = 12;
  for (let q = 0; q < qd; q++) {
    const n = readName(i);
    if (!n) return [];
    i = n.next + 4;
  }
  const out = [];
  for (let r = 0; r < rr && i < buf.length; r++) {
    const n = readName(i);
    if (!n || n.next + 10 > buf.length) break;
    const type = buf.readUInt16BE(n.next);
    const len = buf.readUInt16BE(n.next + 8);
    const data = n.next + 10;
    const ttl = buf.readUInt32BE(n.next + 4);
    if (type === 1 && len === 4 && data + 4 <= buf.length) out.push({ type: 1, ttl, name: n.name.toLowerCase(), ip: [...buf.subarray(data, data + 4)].join('.') });
    else if (type === 12 && data + len <= buf.length) { const t = readName(data); if (t) out.push({ type: 12, ttl, name: n.name.toLowerCase(), target: t.name.toLowerCase() }); }
    else if (type === 16 && data + len <= buf.length) {
      const txt = {};
      for (let j = data; j < data + len;) {
        const l = buf[j];
        const kv = buf.toString('utf8', j + 1, j + 1 + l);
        const eq = kv.indexOf('=');
        if (eq > 0) txt[kv.slice(0, eq)] = kv.slice(eq + 1);
        j += 1 + l;
      }
      out.push({ type: 16, ttl, name: n.name.toLowerCase(), txt });
    }
    i = data + len;
  }
  return out;
}

function question(name, type = 1) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(1, 4);
  const q = Buffer.alloc(4);
  q.writeUInt16BE(type, 0); // A (or PTR, for the service)
  q.writeUInt16BE(1, 2); // IN (multicast answer: everyone hears who has it)
  return Buffer.concat([head, encodeName(name), q]);
}

// The service record: SERVICE PTR -> this computer's name, with a TXT on the name (what the
// other computers show in their list: id, name, os, port).
function serviceRecords(name, txt, ttl) {
  const nm = encodeName(name);
  const ptrHead = Buffer.alloc(10);
  ptrHead.writeUInt16BE(12, 0);
  ptrHead.writeUInt16BE(1, 2); // IN (shared: not cache-flush, every computer has one)
  ptrHead.writeUInt32BE(ttl, 4);
  ptrHead.writeUInt16BE(nm.length, 8);
  const strs = Object.entries(txt || {}).map(([k, v]) => {
    const b = Buffer.from(`${k}=${v}`).subarray(0, 255);
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  const body = strs.length ? Buffer.concat(strs) : Buffer.from([0]);
  const txtHead = Buffer.alloc(10);
  txtHead.writeUInt16BE(16, 0);
  txtHead.writeUInt16BE(0x8001, 2);
  txtHead.writeUInt32BE(ttl, 4);
  txtHead.writeUInt16BE(body.length, 8);
  return [Buffer.concat([encodeName(SERVICE), ptrHead, nm]), Buffer.concat([nm, txtHead, body])];
}

function answer(name, ips, ttl = TTL, extra = []) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0x8400, 2); // response, authoritative
  head.writeUInt16BE(ips.length + extra.length, 6);
  const nm = encodeName(name);
  const rrs = ips.map((ip) => {
    const rr = Buffer.alloc(10);
    rr.writeUInt16BE(1, 0); // A
    rr.writeUInt16BE(0x8001, 2); // IN, cache-flush
    rr.writeUInt32BE(ttl, 4);
    rr.writeUInt16BE(4, 8);
    return Buffer.concat([nm, rr, Buffer.from(ip.split('.').map(Number))]);
  });
  return Buffer.concat([head, ...extra, ...rrs]);
}

class MdnsHost {
  constructor(name, alias = '') {
    this.name = String(name).toLowerCase().replace(/\.$/, '');
    if (!this.name.endsWith('.local')) this.name += '.local';
    this.alias = alias ? String(alias).toLowerCase() : '';
    this.aliasHeld = false;
    this.probing = false;
    this.sock = null;
    this.joined = new Set();
    this.lastIps = '';
    this.error = '';
    this.txt = null; // () => {id, name, os, port}: answered for the service when set
    this.peers = new Map(); // name -> {name, ips, txt, seen, ttl}
  }

  // The other TwinDesk Web computers heard from: [{host, ips, id, name, os, port}].
  others() {
    const now = Date.now();
    const out = [];
    for (const [k, p] of this.peers) {
      if (now - p.seen > Math.max(p.ttl, 60) * 1000 + BROWSE_MS * 2) { this.peers.delete(k); continue; }
      if (!p.ips.length || !p.txt) continue;
      out.push({ host: p.name, ips: p.ips, ...p.txt, port: Number(p.txt.port) || 0 });
    }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  browse() {
    if (!this.sock || !this.txt) return;
    for (const i of ipv4s()) this._send(question(SERVICE, 12), i.address);
  }

  _svc(ttl = TTL) {
    if (!this.txt) return [];
    let t;
    try { t = this.txt(); } catch (_) { return []; }
    return serviceRecords(this.name, t, ttl);
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
      this._probe();
      this.browse();
    });
    this.browser = setInterval(() => this.browse(), BROWSE_MS);
    // New addresses (another network, the cable): join there and tell the network.
    this.poll = setInterval(() => {
      const now = this.addresses().join(',');
      if (now !== this.lastIps) { this._join(); this._announce(); }
    }, 5000);
  }

  stop(goodbye = true) {
    clearInterval(this.poll);
    clearInterval(this.browser);
    this.peers.clear();
    clearTimeout(this.retry);
    clearTimeout(this.probeTimer);
    if (goodbye && this.aliasHeld && this.sock && this.lastIps) this._send(answer(this.alias, this.lastIps.split(','), 0));
    this.aliasHeld = false;
    this.probing = false;
    const s = this.sock;
    this.sock = null;
    this.joined.clear();
    if (!s) return;
    try {
      if (goodbye && this.lastIps) s.send(answer(this.name, this.lastIps.split(','), 0, this._svc(0)), PORT, GROUP, () => { try { s.close(); } catch (_) {} });
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

  // Ask three times whether anyone has the alias; nobody answered: it's ours.
  _probe() {
    if (!this.alias || !this.sock || this.aliasHeld || this.probing) return;
    this.probing = true;
    this.taken = false;
    let n = 0;
    const step = () => {
      if (!this.sock || !this.probing) return;
      if (this.taken) { this.probing = false; return this._later(); }
      if (n++ < 3) {
        for (const i of ipv4s()) this._send(question(this.alias), i.address);
        this.probeTimer = setTimeout(step, 250);
        return;
      }
      this.probing = false;
      this.aliasHeld = true;
      this._announce();
      if (this.onAlias) this.onAlias(true);
    };
    this.probeTimer = setTimeout(step, Math.floor(Math.random() * 250));
  }

  // Someone else has it: try again in a minute or two (it may have gone by then).
  _later() {
    clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => this._probe(), 60000 + Math.floor(Math.random() * 60000));
  }

  _learn(rrs) {
    const now = Date.now();
    const names = new Set(rrs.filter((r) => r.type === 12 && r.name === SERVICE).map((r) => r.target));
    for (const r of rrs) if (r.type === 12 && r.name === SERVICE && r.ttl === 0) { this.peers.delete(r.target); names.delete(r.target); }
    for (const n of names) {
      if (n === this.name) continue;
      const p = this.peers.get(n) || { name: n, ips: [], txt: null, seen: now, ttl: TTL };
      const ips = rrs.filter((r) => r.type === 1 && r.name === n && r.ttl > 0).map((r) => r.ip);
      if (ips.length) p.ips = [...new Set(ips)];
      const txt = rrs.find((r) => r.type === 16 && r.name === n);
      if (txt) p.txt = txt.txt;
      p.seen = now;
      p.ttl = (rrs.find((r) => r.type === 12 && r.target === n) || {}).ttl || TTL;
      this.peers.set(n, p);
    }
    // A known computer's own announcement (its A records alone): still there, maybe new addresses.
    for (const r of rrs) {
      const p = r.type === 1 && this.peers.get(r.name);
      if (!p) continue;
      if (r.ttl === 0) { this.peers.delete(r.name); continue; }
      p.seen = now;
    }
  }

  _response(buf) {
    let rrs;
    try { rrs = parseAnswers(buf); } catch (_) { return; }
    this._learn(rrs);
    if (!this.alias) return;
    const mine = new Set(this.addresses());
    const others = rrs.filter((r) => r.type === 1 && r.ttl > 0 && r.name === this.alias && !mine.has(r.ip));
    if (!others.length) return;
    if (this.probing) this.taken = true;
    // Both took it at once (probed together): the lower address keeps it, the other leaves.
    const low = (ips) => Math.min(...ips.map(ipInt));
    const keep = this.aliasHeld && low([...mine]) < low(others.map((r) => r.ip));
    if (keep) return this._announce();
    if (this.aliasHeld) {
      this.aliasHeld = false;
      console.log('[mdnshost] another computer answers for', this.alias, '- leaving it');
      if (this.onAlias) this.onAlias(false);
      this._later();
    }
  }

  _announce() {
    const ifs = ipv4s();
    this.lastIps = ifs.map((i) => i.address).join(',');
    if (!ifs.length) return;
    // Twice, a second apart (RFC 6762 8.3), each interface with its own address.
    const once = () => {
      for (const i of ipv4s()) {
        this._send(answer(this.name, [i.address], TTL, this._svc()), i.address);
        if (this.aliasHeld) this._send(answer(this.alias, [i.address]), i.address);
      }
    };
    once();
    setTimeout(once, 1000);
  }

  _query(buf, rinfo) {
    if (buf.length >= 12 && buf.readUInt16BE(2) & 0x8000) return this._response(buf);
    let qs;
    try { qs = parseQuestions(buf); } catch (_) { return; }
    const want = (n) => qs.find((q) => q.name === n && (q.type === 1 || q.type === 255));
    const svc = this.txt && qs.find((q) => q.name === SERVICE && (q.type === 12 || q.type === 255));
    const asked = want(this.name) ? this.name : this.aliasHeld && want(this.alias) ? this.alias : svc ? this.name : '';
    if (!asked) return;
    const mine = want(asked) || svc;
    // The address on the asker's network, else all of them.
    const ifs = ipv4s();
    const near = ifs.filter((i) => sameNet(i.address, rinfo.address, i.netmask));
    const ips = (near.length ? near : ifs).map((i) => i.address);
    if (!ips.length) return;
    // Asked for the service: answered after a moment (RFC 6762 6: shared records), so many don't collide.
    if (svc && asked === this.name && !want(this.name)) {
      const msg = answer(this.name, ips, TTL, this._svc());
      const via = near[0] ? near[0].address : null;
      if (rinfo.port !== PORT) { const legacy = Buffer.from(msg); buf.copy(legacy, 0, 0, 2); return this._send(legacy, null, { address: rinfo.address, port: rinfo.port }); }
      return void setTimeout(() => this._send(msg, via), 20 + Math.floor(Math.random() * 100));
    }
    const msg = answer(asked, ips, TTL, asked === this.name ? this._svc() : []);
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

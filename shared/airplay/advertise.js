// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The records as UxPlay (https://github.com/FDH2/UxPlay, GPL-3.0) publishes them, lib/dnssd.c.
// The AirPlay receiver on the local network: _airplay._tcp and _raop._tcp over multicast DNS
// (RFC 6762/6763), so an iPhone or iPad lists this computer under Screen Mirroring. A plain responder
// beside the system's own (shares port 5353, as shared/web/mdnshost.js does): it answers PTR, SRV,
// TXT and A questions for its records, announces them at start and when the addresses change, and
// says goodbye at stop.
//
// new Advertiser({name, host, port, airplayTxt, raopTxt, raopName}).start(); .stop()
'use strict';

const dgram = require('dgram');
const { ipv4s } = require('../web/mdnshost.js');

const GROUP = '224.0.0.251';
const PORT = 5353;
const T = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 };

function encodeName(name) {
  // Instance names may hold dots and spaces: split only the service and domain part.
  const parts = Array.isArray(name) ? name : name.split('.');
  return Buffer.concat([...parts.filter(Boolean).map((p) => { const b = Buffer.from(p, 'utf8').subarray(0, 63); return Buffer.concat([Buffer.from([b.length]), b]); }), Buffer.from([0])]);
}
const txtData = (obj) => Buffer.concat(Object.entries(obj).map(([k, v]) => { const b = Buffer.from(`${k}=${v}`, 'utf8').subarray(0, 255); return Buffer.concat([Buffer.from([b.length]), b]); }));

function rr(labels, type, ttl, data, flush) {
  const h = Buffer.alloc(10);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(flush ? 0x8001 : 0x0001, 2);
  h.writeUInt32BE(ttl, 4);
  h.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeName(labels), h, data]);
}

function readQuestions(buf) {
  if (buf.length < 12 || buf.readUInt16BE(2) & 0x8000) return [];
  const qd = buf.readUInt16BE(4);
  const out = [];
  let i = 12;
  const readName = (at) => {
    const labels = [];
    let next = -1;
    for (let guard = 0; guard < 64; guard++) {
      const l = buf[at];
      if (l === undefined) return null;
      if (l === 0) { if (next < 0) next = at + 1; break; }
      if ((l & 0xc0) === 0xc0) { if (next < 0) next = at + 2; at = ((l & 0x3f) << 8) | buf[at + 1]; continue; }
      labels.push(buf.toString('utf8', at + 1, at + 1 + l));
      at += 1 + l;
    }
    return { name: labels.join('.').toLowerCase(), next };
  };
  for (let q = 0; q < qd && i < buf.length; q++) {
    const n = readName(i);
    if (!n || n.next + 4 > buf.length) break;
    out.push({ name: n.name, type: buf.readUInt16BE(n.next), qu: !!(buf.readUInt16BE(n.next + 2) & 0x8000) });
    i = n.next + 4;
  }
  return out;
}

class Advertiser {
  constructor(o) {
    this.o = o;
    this.sock = null;
    this.joined = new Set();
    this.lastIps = '';
  }

  // The services, each [instance labels, type labels, txt]; the host's labels.
  _services() {
    const o = this.o;
    return [
      { inst: [o.name, '_airplay', '_tcp', 'local'], type: ['_airplay', '_tcp', 'local'], txt: o.airplayTxt },
      { inst: [o.raopName, '_raop', '_tcp', 'local'], type: ['_raop', '_tcp', 'local'], txt: o.raopTxt },
    ];
  }

  _records(ip, ttl = 4500) {
    const host = [this.o.host, 'local'];
    const srv = (port) => { const b = Buffer.alloc(6); b.writeUInt16BE(port, 4); return Buffer.concat([b, encodeName(host)]); };
    const svcs = this._services().map((s) => ({
      key: s.type.join('.').toLowerCase(),
      inst: s.inst.join('.').toLowerCase(),
      ptr: rr(s.type, T.PTR, ttl, encodeName(s.inst), false),
      srv: rr(s.inst, T.SRV, ttl > 0 ? 120 : 0, srv(this.o.port), true),
      txt: rr(s.inst, T.TXT, ttl, txtData(s.txt), true),
      meta: rr(['_services', '_dns-sd', '_udp', 'local'], T.PTR, ttl, encodeName(s.type), false),
    }));
    const a = rr(host, T.A, ttl > 0 ? 120 : 0, Buffer.from(ip.split('.').map(Number)), true);
    return { svcs, a, host: host.join('.').toLowerCase() };
  }

  _packet(answers, extra = [], id = 0) {
    const h = Buffer.alloc(12);
    h.writeUInt16BE(id, 0);
    h.writeUInt16BE(0x8400, 2);
    h.writeUInt16BE(answers.length, 6);
    h.writeUInt16BE(extra.length, 10);
    return Buffer.concat([h, ...answers, ...extra]);
  }

  start() {
    if (this.sock) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('error', (e) => {
      console.warn('[airplay mdns]', e.message);
      this.stop(false);
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.start(), 10000);
    });
    sock.on('message', (buf, rinfo) => this._query(buf, rinfo));
    sock.bind(PORT, () => {
      try { sock.setMulticastTTL(255); sock.setMulticastLoopback(true); } catch (_) {}
      this._join();
      this._announce();
    });
    this.poll = setInterval(() => {
      const now = ipv4s().map((i) => i.address).join(',');
      if (now !== this.lastIps) { this._join(); this._announce(); }
    }, 5000);
  }

  stop(goodbye = true) {
    clearInterval(this.poll);
    clearTimeout(this.retry);
    clearTimeout(this.again);
    const s = this.sock;
    this.sock = null;
    this.joined.clear();
    if (!s) return;
    const ifs = goodbye ? ipv4s() : [];
    let left = ifs.length;
    if (!left) { try { s.close(); } catch (_) {} return; }
    for (const i of ifs) {
      const r = this._records(i.address, 0);
      const msg = this._packet(r.svcs.flatMap((x) => [x.ptr, x.srv, x.txt]));
      try { s.setMulticastInterface(i.address); } catch (_) {}
      s.send(msg, PORT, GROUP, () => { if (--left === 0) { try { s.close(); } catch (_) {} } });
    }
  }

  _join() {
    for (const i of ipv4s()) {
      if (this.joined.has(i.address)) continue;
      try { this.sock.addMembership(GROUP, i.address); this.joined.add(i.address); } catch (_) {}
    }
  }

  _send(buf, ifaceIp, to) {
    const s = this.sock;
    if (!s) return;
    try {
      if (ifaceIp && (!to || to.address === GROUP)) s.setMulticastInterface(ifaceIp);
      s.send(buf, to ? to.port : PORT, to ? to.address : GROUP);
    } catch (_) {}
  }

  _announce() {
    const ifs = ipv4s();
    this.lastIps = ifs.map((i) => i.address).join(',');
    const once = () => {
      for (const i of ipv4s()) {
        const r = this._records(i.address);
        this._send(this._packet([...r.svcs.flatMap((x) => [x.ptr, x.srv, x.txt]), r.a]), i.address);
      }
    };
    once();
    clearTimeout(this.again);
    this.again = setTimeout(once, 1000);
  }

  _query(buf, rinfo) {
    let qs;
    try { qs = readQuestions(buf); } catch (_) { return; }
    if (!qs.length) return;
    const ifs = ipv4s();
    const ipInt = (ip) => ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
    const near = ifs.find((i) => ((ipInt(i.address) & ipInt(i.netmask)) >>> 0) === ((ipInt(rinfo.address) & ipInt(i.netmask)) >>> 0)) || ifs[0];
    if (!near) return;
    const r = this._records(near.address);
    const answers = [];
    const extra = new Set();
    let qu = false;
    for (const q of qs) {
      const any = q.type === T.ANY;
      let hit = false;
      for (const s of r.svcs) {
        if (q.name === s.key && (q.type === T.PTR || any)) { answers.push(s.ptr); extra.add(s.srv); extra.add(s.txt); extra.add(r.a); hit = true; }
        if (q.name === s.inst) {
          if (q.type === T.SRV || any) { answers.push(s.srv); extra.add(r.a); hit = true; }
          if (q.type === T.TXT || any) { answers.push(s.txt); hit = true; }
        }
        if (q.name === '_services._dns-sd._udp.local' && (q.type === T.PTR || any)) { answers.push(s.meta); hit = true; }
      }
      if (q.name === r.host && (q.type === T.A || any)) { answers.push(r.a); hit = true; }
      if (hit && q.qu) qu = true;
    }
    if (!answers.length) return;
    const more = [...extra].filter((x) => !answers.includes(x));
    if (rinfo.port !== PORT) {
      // A one-shot resolver: the answer back to it, with its id.
      return this._send(this._packet(answers, more, buf.readUInt16BE(0)), null, { address: rinfo.address, port: rinfo.port });
    }
    const msg = this._packet(answers, more);
    if (qu) this._send(msg, null, { address: rinfo.address, port: PORT });
    this._send(msg, near.address);
  }
}

module.exports = { Advertiser, txtData };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The computer's side of Internet over USB (#277, shared/tether.js; Tether.kt on the phone): the
// phone's VPN hands every IPv4 packet its apps send to one stream (adb reverse through the cable),
// and this answers them as if it were the internet. As gnirehtet's relay does it: no raw sockets and
// no administrator rights. Each TCP connection a phone app opens becomes a socket from this computer
// (its own address, its own routes and VPN), each UDP flow a datagram socket. ICMP and IPv6 aren't
// carried (the phone's VPN doesn't route IPv6, so those apps use the phone's own networks).
//
// TCP here is the small part TCP needs over a stream that loses nothing: no retransmission, no
// congestion control. What the phone sends is acknowledged once it's written to the socket (the
// window shrinks while the socket's buffer is full); what comes from the socket is sent in
// segments no bigger than the phone's MSS while its window has room, the socket paused until the
// phone acknowledges. Window scaling isn't offered, so windows are plain 16-bit numbers.
//
// DNS: the phone's VPN names DNS_IP as its DNS server; those queries go to this computer's own DNS
// server (dns.getServers(), else 1.1.1.1), so names resolve as they do here (a company's own names).
//
// Relay(write(buf)): one per phone stream. feed(packet) for each IPv4 packet from the phone;
// close() ends every connection. Packets for the phone go to write().
'use strict';

const net = require('net');
const dgram = require('dgram');
const dns = require('dns');

const DNS_IP = '10.215.173.2'; // the VPN's DNS server, as the phone sees it (Tether.kt)
const MTU = 16384; // the VPN's MTU (Tether.kt): big segments, fewer packets through adb
const MAX_SEG = MTU - 40;
const WINDOW = 65535;
const SOCK_HIGH = 512 * 1024; // the phone's data waiting for a slow socket: the window closes past this
const UDP_IDLE_MS = 60_000;
const TCP_IDLE_MS = 30 * 60_000; // a connection nothing went through for this long
const CONNECT_MS = 20_000;
const MAX_FLOWS = 2048; // per phone: the oldest UDP flow goes first, then new TCP connections are refused

// ---- IPv4, TCP and UDP ----

const FIN = 0x01, SYN = 0x02, RST = 0x04, PSH = 0x08, ACK = 0x10;

function sum16(buf, start, end, acc = 0) {
  let s = acc;
  let i = start;
  for (; i + 1 < end; i += 2) s += (buf[i] << 8) | buf[i + 1];
  if (i < end) s += buf[i] << 8;
  return s;
}
function fold(s) {
  while (s > 0xffff) s = (s & 0xffff) + (s >>> 16);
  return (~s) & 0xffff;
}
const ipBytes = (a) => a.split('.').map(Number);
const ipStr = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;

// An IPv4 packet (no options) around a TCP or UDP payload `l4` whose checksum field is zero; fills
// in both checksums.
function ipPacket(proto, src, dst, l4, csumAt) {
  const p = Buffer.alloc(20 + l4.length);
  p[0] = 0x45;
  p.writeUInt16BE(p.length, 2);
  p.writeUInt16BE(0x4000, 6); // don't fragment
  p[8] = 64;
  p[9] = proto;
  const s = ipBytes(src), d = ipBytes(dst);
  for (let i = 0; i < 4; i++) { p[12 + i] = s[i]; p[16 + i] = d[i]; }
  p.writeUInt16BE(fold(sum16(p, 0, 20)), 10);
  l4.copy(p, 20);
  // The pseudo-header: addresses, protocol, length.
  let acc = sum16(p, 12, 20) + proto + l4.length;
  acc = sum16(p, 20, p.length, acc);
  let c = fold(acc);
  if (proto === 17 && c === 0) c = 0xffff;
  p.writeUInt16BE(c, 20 + csumAt);
  return p;
}

function tcpPacket(f, flags, seq, ack, window, payload, opts) {
  const o = opts || Buffer.alloc(0);
  const pl = payload || Buffer.alloc(0);
  const h = Buffer.alloc(20 + o.length + pl.length);
  h.writeUInt16BE(f.dport, 0); // from the far end ...
  h.writeUInt16BE(f.sport, 2); // ... to the phone's app
  h.writeUInt32BE(seq >>> 0, 4);
  h.writeUInt32BE(ack >>> 0, 8);
  h[12] = ((20 + o.length) / 4) << 4;
  h[13] = flags;
  h.writeUInt16BE(Math.max(0, Math.min(WINDOW, window)), 14);
  o.copy(h, 20);
  pl.copy(h, 20 + o.length);
  return ipPacket(6, f.dst, f.src, h, 16);
}

function udpPacket(src, sport, dst, dport, payload) {
  const h = Buffer.alloc(8 + payload.length);
  h.writeUInt16BE(sport, 0);
  h.writeUInt16BE(dport, 2);
  h.writeUInt16BE(h.length, 4);
  payload.copy(h, 8);
  return ipPacket(17, src, dst, h, 6);
}

// The MSS option of a SYN (536 when it has none).
function synMss(p, off, end) {
  let i = off + 20;
  while (i < end) {
    const k = p[i];
    if (k === 0) break;
    if (k === 1) { i++; continue; }
    const n = p[i + 1];
    if (!n || n < 2) break;
    if (k === 2 && n === 4 && i + 4 <= end) return p.readUInt16BE(i + 2);
    i += n;
  }
  return 536;
}

const seqLt = (a, b) => ((a - b) | 0) < 0;

class Relay {
  constructor(write, { log = () => {}, dnsServer, dnsPort } = {}) {
    this.write = write;
    this.log = log;
    this.dnsServer = dnsServer || null; // tests: another server and port
    this.dnsPort = dnsPort || 53;
    this.tcp = new Map(); // 'src:sport>dst:dport' -> connection
    this.udp = new Map(); // 'src:sport>dst:dport' -> {sock, last}
    this.closed = false;
    this.stats = { up: 0, down: 0 };
    this.sweep = setInterval(() => this._sweep(), 10_000);
    this.sweep.unref && this.sweep.unref();
  }

  // One IPv4 packet from the phone. Anything else is dropped.
  feed(p) {
    if (this.closed || p.length < 20 || p[0] >> 4 !== 4) return;
    const ihl = (p[0] & 0x0f) * 4;
    const total = Math.min(p.readUInt16BE(2), p.length);
    if (ihl < 20 || total < ihl) return;
    if (p.readUInt16BE(6) & 0x3fff) return; // a fragment: the phone's MTU is ours, so none come
    this.stats.up += total;
    const src = ipStr(p, 12), dst = ipStr(p, 16);
    if (p[9] === 6) this._tcp(p, ihl, total, src, dst);
    else if (p[9] === 17) this._udp(p, ihl, total, src, dst);
  }

  _out(pkt) {
    if (this.closed) return;
    this.stats.down += pkt.length;
    this.write(pkt);
  }

  // ---- UDP ----

  _udp(p, off, end, src, dst) {
    if (end - off < 8) return;
    const sport = p.readUInt16BE(off), dport = p.readUInt16BE(off + 2);
    const payload = Buffer.from(p.subarray(off + 8, Math.min(end, off + p.readUInt16BE(off + 4))));
    const key = `${src}:${sport}>${dst}:${dport}`;
    let f = this.udp.get(key);
    if (!f) {
      if (this.udp.size + this.tcp.size >= MAX_FLOWS) this._dropOldestUdp();
      const sock = dgram.createSocket('udp4');
      f = { sock, last: Date.now() };
      this.udp.set(key, f);
      sock.on('message', (data) => {
        f.last = Date.now();
        this._out(udpPacket(dst, dport, src, sport, data));
      });
      sock.on('error', () => this._udpEnd(key));
    }
    f.last = Date.now();
    let to = dst, port = dport;
    if (dst === DNS_IP && dport === 53) { to = this._dns(); port = this.dnsPort; }
    f.sock.send(payload, port, to, () => {});
  }

  _dns() {
    if (this.dnsServer) return this.dnsServer;
    const v4 = dns.getServers().map((s) => s.replace(/^\[|\](:\d+)?$/g, '').replace(/:\d+$/, '')).find((s) => net.isIPv4(s) && !s.startsWith('127.'));
    return v4 || '1.1.1.1';
  }

  _udpEnd(key) {
    const f = this.udp.get(key);
    if (!f) return;
    this.udp.delete(key);
    try { f.sock.close(); } catch (_) {}
  }

  _dropOldestUdp() {
    let oldest = null;
    for (const [k, f] of this.udp) if (!oldest || f.last < oldest[1].last) oldest = [k, f];
    if (oldest) this._udpEnd(oldest[0]);
  }

  // ---- TCP ----

  _tcp(p, off, end, src, dst) {
    if (end - off < 20) return;
    const sport = p.readUInt16BE(off), dport = p.readUInt16BE(off + 2);
    const seq = p.readUInt32BE(off + 4), ack = p.readUInt32BE(off + 8);
    const doff = (p[off + 12] >> 4) * 4;
    const flags = p[off + 13];
    const win = p.readUInt16BE(off + 14);
    if (doff < 20 || off + doff > end) return;
    const data = p.subarray(off + doff, end);
    const key = `${src}:${sport}>${dst}:${dport}`;
    let c = this.tcp.get(key);
    const f = { src, sport, dst, dport };

    if (!c) {
      if (flags & RST) return;
      if (!(flags & SYN) || (flags & ACK)) { // nothing open for it: reset
        if (flags & ACK) this._out(tcpPacket(f, RST, ack, 0, 0));
        else this._out(tcpPacket(f, RST | ACK, 0, (seq + data.length + ((flags & FIN) ? 1 : 0)) >>> 0, 0));
        return;
      }
      if (this.udp.size + this.tcp.size >= MAX_FLOWS) this._dropOldestUdp();
      if (this.udp.size + this.tcp.size >= MAX_FLOWS) { this._out(tcpPacket(f, RST | ACK, 0, (seq + 1) >>> 0, 0)); return; }
      this._open(key, f, seq, win, synMss(p, off, off + doff));
      return;
    }
    c.last = Date.now();
    if (flags & RST) { this._tcpEnd(c, false); return; }
    if (flags & SYN) { // the SYN again (it was sent before the SYN-ACK came): answered once connected
      if (c.state === 'synAcked') this._send(c, SYN | ACK, c.iss, c.rcvNxt, this._mssOpt());
      return;
    }
    if (!(flags & ACK)) return;

    // What the phone acknowledged of ours.
    if (c.state === 'synAcked' && ack === ((c.iss + 1) >>> 0)) c.state = 'open';
    if (!seqLt(c.sndNxt, ack) && seqLt(c.sndUna, ack)) c.sndUna = ack;
    c.sndWnd = win;
    if (c.finSent && ack === c.sndNxt) c.finAcked = true;

    // The phone's data, only in order (nothing gets lost on the way, so anything else is a repeat).
    if (data.length || (flags & FIN)) {
      if (seq !== c.rcvNxt) {
        this._ack(c);
      } else {
        if (data.length && !c.finRcvd) {
          c.rcvNxt = (c.rcvNxt + data.length) >>> 0;
          if (c.sock && !c.sockEnded) c.sock.write(Buffer.from(data));
        }
        if (flags & FIN && !c.finRcvd) {
          c.finRcvd = true;
          c.rcvNxt = (c.rcvNxt + 1) >>> 0;
          if (c.sock && !c.sockEnded) { c.sockEnded = true; c.sock.end(); }
        }
        this._ack(c);
      }
    }
    this._pump(c);
    if (c.finRcvd && c.finAcked) this._tcpEnd(c, false);
  }

  _mssOpt() {
    const o = Buffer.alloc(4);
    o[0] = 2; o[1] = 4;
    o.writeUInt16BE(MAX_SEG, 2);
    return o;
  }

  _open(key, f, seq, win, mss) {
    const iss = (Math.random() * 0x100000000) >>> 0;
    const c = {
      key, f, state: 'connecting', iss, sndUna: iss, sndNxt: (iss + 1) >>> 0, sndWnd: win, mss: Math.max(64, Math.min(mss, MAX_SEG)),
      rcvNxt: (seq + 1) >>> 0, pending: [], pendingLen: 0, sock: null, sockEnded: false, remoteEnded: false,
      finSent: false, finAcked: false, finRcvd: false, last: Date.now(), lastWin: WINDOW,
    };
    this.tcp.set(key, c);
    const sock = net.connect({ host: f.dst, port: f.dport });
    c.sock = sock;
    sock.setNoDelay(true);
    const t = setTimeout(() => sock.destroy(new Error('timeout')), CONNECT_MS);
    sock.once('connect', () => {
      clearTimeout(t);
      if (!this.tcp.has(key)) return sock.destroy();
      c.state = 'synAcked';
      this._send(c, SYN | ACK, c.iss, c.rcvNxt, this._mssOpt());
    });
    sock.on('data', (d) => {
      c.pending.push(d);
      c.pendingLen += d.length;
      c.last = Date.now();
      this._pump(c);
    });
    sock.on('drain', () => this._ack(c, true)); // the window opens again
    sock.on('end', () => { c.remoteEnded = true; this._pump(c); });
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(t);
      if (!this.tcp.has(key)) return;
      if (c.state === 'connecting') { // refused, unreachable: the phone's app hears it at once
        this._out(tcpPacket(f, RST | ACK, 0, c.rcvNxt, 0));
        this.tcp.delete(key);
        return;
      }
      if (!c.remoteEnded) { this._send(c, RST | ACK, c.sndNxt, c.rcvNxt); this.tcp.delete(key); return; } // a reset
      c.remoteEnded = true;
      this._pump(c);
    });
  }

  _window(c) {
    const queued = c.sock ? c.sock.writableLength : 0;
    return Math.max(0, WINDOW - Math.max(0, queued - (SOCK_HIGH - WINDOW)));
  }

  _send(c, flags, seq, ack, opts, payload) {
    c.lastWin = this._window(c);
    this._out(tcpPacket(c.f, flags, seq, ack, c.lastWin, payload, opts));
  }

  _ack(c, onlyIfOpened) {
    if (!this.tcp.has(c.key) || c.state === 'connecting') return;
    if (onlyIfOpened && this._window(c) <= c.lastWin) return;
    this._send(c, ACK, c.sndNxt, c.rcvNxt);
  }

  // The socket's data to the phone while its window has room; then FIN once everything is out.
  _pump(c) {
    if (!this.tcp.has(c.key) || (c.state !== 'open' && c.state !== 'synAcked')) return;
    if (c.state === 'synAcked') return; // the phone's ACK of our SYN first
    while (c.pendingLen > 0) {
      const inflight = (c.sndNxt - c.sndUna) >>> 0;
      const room = c.sndWnd - inflight;
      if (room <= 0) break;
      const n = Math.min(room, c.mss, c.pendingLen);
      const chunk = this._take(c, n);
      this._send(c, ACK | PSH, c.sndNxt, c.rcvNxt, null, chunk);
      c.sndNxt = (c.sndNxt + chunk.length) >>> 0;
    }
    if (c.sock) {
      if (c.pendingLen > WINDOW) c.sock.pause();
      else if (c.sock.isPaused()) c.sock.resume();
    }
    if (c.remoteEnded && c.pendingLen === 0 && !c.finSent) {
      c.finSent = true;
      this._send(c, FIN | ACK, c.sndNxt, c.rcvNxt);
      c.sndNxt = (c.sndNxt + 1) >>> 0;
    }
  }

  _take(c, n) {
    const parts = [];
    let got = 0;
    while (got < n) {
      const b = c.pending[0];
      const k = Math.min(b.length, n - got);
      parts.push(b.subarray(0, k));
      got += k;
      if (k === b.length) c.pending.shift();
      else c.pending[0] = b.subarray(k);
    }
    c.pendingLen -= got;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts, got);
  }

  _tcpEnd(c, reset) {
    if (!this.tcp.has(c.key)) return;
    this.tcp.delete(c.key);
    if (reset) this._send(c, RST | ACK, c.sndNxt, c.rcvNxt);
    if (c.sock) c.sock.destroy();
  }

  _sweep() {
    const now = Date.now();
    for (const [k, f] of this.udp) if (now - f.last > UDP_IDLE_MS) this._udpEnd(k);
    for (const c of [...this.tcp.values()]) {
      if (now - c.last > TCP_IDLE_MS) this._tcpEnd(c, true);
      else if (c.finSent && c.finRcvd && now - c.last > 60_000) this._tcpEnd(c, false);
    }
  }

  get flows() {
    return this.tcp.size + this.udp.size;
  }

  close() {
    if (this.closed) return;
    clearInterval(this.sweep);
    for (const c of [...this.tcp.values()]) this._tcpEnd(c, false);
    for (const k of [...this.udp.keys()]) this._udpEnd(k);
    this.closed = true;
  }
}

// IPv4 packets out of a byte stream (each by its total length).
class Packets {
  constructor(onPacket) {
    this.on = onPacket;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 20) {
      if (this.buf[0] >> 4 !== 4) return false; // not IPv4: the stream is broken
      const n = this.buf.readUInt16BE(2);
      if (n < 20 || n > MTU) return false;
      if (this.buf.length < n) break;
      this.on(this.buf.subarray(0, n));
      this.buf = this.buf.subarray(n);
    }
    return true;
  }
}

module.exports = { Relay, Packets, DNS_IP, MTU, tcpPacket, udpPacket, ipPacket, sum16, fold, FIN, SYN, RST, PSH, ACK };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The input lane (docs/perf-plan.md P2, capability `il`): pointer moves and input events over an
// encrypted UDP socket next to the session's WSS, so a lost packet on Wi-Fi never holds the cursor
// back the way TCP's head-of-line blocking does.
//
// Moves carry cumulative totals since the crossing (route), so the next packet heals a lost one and
// there is no reliability layer. Discrete events (clicks, keys, wheel, gestures) carry an event
// number (es) and go over the lane AND the WSS; the receiver applies whichever copy comes first, in
// es order, once. A move names the last event sent before it, and waits for that one, so a click
// never lands after moves that followed it.
//
// Wire (little-endian), the reference for the native lane (P3):
//   0..2 'T''L' | 2 ver=1 | 3 type | 4..12 seq u64 | AES-256-GCM(body) | 16-byte tag
//   AAD = bytes 0..12, nonce = 00000000 ‖ seq (8 bytes LE).
//   keys = HKDF-SHA256(key, empty salt, "twindesk-il-v1 host" | "twindesk-il-v1 guest", 32);
//   each side seals with its own role's key and opens with the peer's.
//   1 PING   u64 t_us
//   2 PONG   u64 t_us (echoed)
//   3 MOVE   u32 route, u32 mn, u32 es, f64 cx, f64 cy      (56 bytes on the wire)
//   4 EVENTS u8 n, then n × {u32 es, u16 len, JSON}          (the last ≤4 events: redundancy)
//
// Exports: InputLane (an EventEmitter: 'up', 'down', 'start', 'move' {route, mn, es, cx, cy},
// 'event' msg), MoveTotals, MoveApply, EventOrder, LaneDrive, LaneDriven, seal, open, deriveKeys,
// laneOff (the TWINDESK_NO_IL kill switch).
'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');
const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');

const MAGIC0 = 0x54; // 'T'
const MAGIC1 = 0x4c; // 'L'
const VER = 1;
const HDR = 12;
const TAG = 16;
const MAX_PACKET = 1200;
const TYPE = { PING: 1, PONG: 2, MOVE: 3, EVENTS: 4 };
const MOVE_BODY = 28;
const MOVE_GAP_MS = 2; // at most one MOVE this often (the first at once)
const TAIL_MS = [8, 24]; // after the last move or event: send it again, in case it was lost
const PING_UP_MS = 100; // until the lane is up
const PING_ACTIVE_MS = 250; // driving or driven
const PING_IDLE_MS = 1000;
const DOWN_AFTER = 3; // ping intervals without a PONG
const EVENTS_KEEP = 4;
const WINDOW = 64; // replay window, as WireGuard's
const RESEND_FOR_MS = 3000; // … and with each ping this long after the last move
const HOLD_MAX = 512; // events held for a gap, at most (the WSS copy always fills it)

const laneOff = () => !!process.env.TWINDESK_NO_IL;

function deriveKeys(keyHex, role) {
  const key = Buffer.from(keyHex, 'hex');
  const k = (r) => Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), `twindesk-il-v1 ${r}`, 32));
  const other = role === 'host' ? 'guest' : 'host';
  return { tx: k(role), rx: k(other) };
}

function writeU64(buf, off, n) {
  buf.writeUInt32LE(n >>> 0, off);
  buf.writeUInt32LE(Math.floor(n / 0x100000000) >>> 0, off + 4);
}

function readU64(buf, off) {
  return buf.readUInt32LE(off) + buf.readUInt32LE(off + 4) * 0x100000000;
}

// One packet: header + sealed body + tag.
function seal(key, type, seq, body) {
  const out = Buffer.allocUnsafe(HDR + body.length + TAG);
  out[0] = MAGIC0;
  out[1] = MAGIC1;
  out[2] = VER;
  out[3] = type;
  writeU64(out, 4, seq);
  const nonce = Buffer.alloc(12);
  out.copy(nonce, 4, 4, 12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(out.subarray(0, HDR));
  const n = c.update(body).copy(out, HDR);
  c.final();
  c.getAuthTag().copy(out, HDR + n);
  return out;
}

// {type, seq, body} or null (not ours, or not authentic).
function open(key, pkt) {
  if (!Buffer.isBuffer(pkt) || pkt.length < HDR + TAG || pkt.length > MAX_PACKET) return null;
  if (pkt[0] !== MAGIC0 || pkt[1] !== MAGIC1 || pkt[2] !== VER) return null;
  const nonce = Buffer.alloc(12);
  pkt.copy(nonce, 4, 4, 12);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(pkt.subarray(0, HDR));
    d.setAuthTag(pkt.subarray(pkt.length - TAG));
    const body = Buffer.concat([d.update(pkt.subarray(HDR, pkt.length - TAG)), d.final()]);
    return { type: pkt[3], seq: readU64(pkt, 4), body };
  } catch (_) {
    return null;
  }
}

// 64-wide sliding replay window: each slot holds the last seq seen there.
class ReplayWindow {
  constructor() {
    this.slots = new Float64Array(WINDOW);
    this.max = 0;
  }

  ok(seq) {
    if (!(seq >= 1)) return false;
    if (seq > this.max) return true;
    if (this.max - seq >= WINDOW) return false;
    return this.slots[seq % WINDOW] !== seq;
  }

  mark(seq) {
    this.slots[seq % WINDOW] = seq;
    if (seq > this.max) this.max = seq;
  }
}

function encodeMove(s) {
  const b = Buffer.allocUnsafe(MOVE_BODY);
  b.writeUInt32LE(s.route >>> 0, 0);
  b.writeUInt32LE(s.mn >>> 0, 4);
  b.writeUInt32LE((s.es || 0) >>> 0, 8);
  b.writeDoubleLE(s.cx, 12);
  b.writeDoubleLE(s.cy, 20);
  return b;
}

function decodeMove(b) {
  if (b.length !== MOVE_BODY) return null;
  const s = { route: b.readUInt32LE(0), mn: b.readUInt32LE(4), es: b.readUInt32LE(8), cx: b.readDoubleLE(12), cy: b.readDoubleLE(20) };
  return Number.isFinite(s.cx) && Number.isFinite(s.cy) ? s : null;
}

// events: [{es, json: Buffer}], newest last. As many of the newest as fit.
function encodeEvents(events) {
  const room = MAX_PACKET - HDR - TAG - 1;
  const parts = [];
  let used = 0;
  for (let i = events.length - 1; i >= 0 && parts.length < EVENTS_KEEP * 2; i--) {
    const e = events[i];
    const len = 6 + e.json.length;
    if (used + len > room) break;
    const h = Buffer.allocUnsafe(6);
    h.writeUInt32LE(e.es >>> 0, 0);
    h.writeUInt16LE(e.json.length, 4);
    parts.unshift(h, e.json);
    used += len;
  }
  if (!parts.length) return null;
  return Buffer.concat([Buffer.from([parts.length / 2]), ...parts]);
}

function decodeEvents(b) {
  if (b.length < 1) return [];
  const n = b[0];
  const out = [];
  let off = 1;
  for (let i = 0; i < n; i++) {
    if (off + 6 > b.length) return out;
    const es = b.readUInt32LE(off);
    const len = b.readUInt16LE(off + 4);
    off += 6;
    if (off + len > b.length) return out;
    let msg = null;
    try { msg = JSON.parse(b.toString('utf8', off, off + len)); } catch (_) { msg = null; }
    off += len;
    if (msg && typeof msg === 'object' && typeof msg.t === 'string') out.push({ ...msg, es });
  }
  return out;
}

const nowUs = () => Math.round(performance.now() * 1000);

// One per app, its socket bound once (the port goes into hello/welcome at once). offer() (as the
// host) or accept() (as the guest) for each session, stop() when it ends.
class InputLane extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.role = opts.role || 'guest'; // which key we seal with: the host's or the guest's
    this.loss = Number(process.env.TWINDESK_LANE_LOSS) || 0; // dev: drop this share of sent packets
    this.sock = null;
    this.family = 'udp6';
    this.port = 0;
    this.keys = null;
    this.peer = null; // {address, port}: where packets go (the last authentic packet's source)
    this.up = false;
    this.rttMs = null;
    this.seq = 0;
    this.es = 0;
    this.win = new ReplayWindow();
    this.isActive = false;
    this.pingTimer = null;
    this.lastPong = 0;
    this.pingEvery = PING_UP_MS;
    this.move = null; // the latest move to send: {s, sentAt}
    this.moveAt = 0;
    this.moveTimer = null;
    this.events = []; // the last few sent: [{es, json}]
    this.tails = { move: [], events: [] };
    this.sent = 0;
    this.received = 0;
  }

  // ---- P3: the helper's native lane (native/tdfast) behind this same object ----
  // helper: {request(cmd, args), send(cmd, args), on('event'|'exit')} with caps.lane. From the next
  // session on (the port in hello/welcome is the helper's), moves never pass through Node: the
  // helper's event tap sends them, and injects the ones that come. Events still pass through Node.
  // Resolves when it's settled (true: native now), so an app can hold its first session till then.
  useNative(helper) {
    if (this.native) return Promise.resolve(true);
    if (laneOff() || process.env.TWINDESK_NO_TDFAST) return Promise.resolve(false);
    if (this.keys) {
      this._wantNative = helper; // after this session
      return Promise.resolve(false);
    }
    this._wantNative = null;
    if (!helper || typeof helper.request !== 'function') return Promise.resolve(false);
    let asked;
    try { asked = Promise.resolve(helper.request('lane', { op: 'bind' })); } catch (_) { return Promise.resolve(false); }
    return asked.then((r) => {
      const port = r && Number(r.port);
      if (this.native) return true;
      if (!port || this.keys) return false;
      this.nat = helper;
      this.native = true;
      if (this.sock) try { this.sock.close(); } catch (_) { /* gone */ }
      this.sock = null;
      this.port = port;
      this._binding = Promise.resolve(port);
      if (!this._natHooked) {
        this._natHooked = true;
        helper.on('event', (name, ev) => this._onNative(name, ev));
        helper.on('exit', () => this._nativeLost());
      }
      console.log(`[lane] native (the helper's), port ${port}`);
      return true;
    }, () => false);
  }

  _onNative(name, ev) {
    if (!this.native || !this.keys) return;
    if (name === 'lane') {
      if (typeof ev.rtt === 'number' && ev.rtt >= 0) this.rttMs = ev.rtt;
      if (!!ev.up === this.up) return;
      this.up = !!ev.up;
      console.log(`[lane] ${this.up ? 'up' : 'down'} (native)${this.up && this.rttMs !== null ? ` (rtt ${this.rttMs.toFixed(1)} ms)` : ''}`);
      this.emit(this.up ? 'up' : 'down');
    } else if (name === 'laneEv' && ev.msg && typeof ev.msg === 'object' && typeof ev.msg.t === 'string' && Number.isInteger(ev.msg.es)) {
      this.emit('event', ev.msg);
    }
  }

  // The helper stopped: its lane is gone with it. This session goes on the WSS; the next one binds again.
  _nativeLost() {
    if (!this.native) return;
    const helper = this.nat;
    this.native = false;
    this.nat = null;
    this.port = 0;
    this._binding = null;
    const was = this.up;
    this.keys = null;
    this.up = false;
    if (was) this.emit('down');
    this.bind(); // the JS lane until the helper is back (kvm.js asks again on its 'ready')
  }

  // Native: what the helper does for the side that drives / is driven (shared/inputlane.js's glue).
  nativeSend(op, args = {}) {
    if (this.native && this.nat) this.nat.send('lane', { op, ...args });
  }

  // The socket, dual-stack where it can be. Resolves the port (0: no lane on this computer).
  bind() {
    if (this.port) return Promise.resolve(this.port);
    if (this._binding) return this._binding;
    const tryBind = (type) => new Promise((resolve) => {
      const s = dgram.createSocket(type === 'udp6' ? { type, ipv6Only: false } : { type });
      const fail = () => { try { s.close(); } catch (_) { /* gone */ } resolve(null); };
      s.once('error', fail);
      s.bind(0, () => {
        s.removeListener('error', fail);
        resolve(s);
      });
    });
    this._binding = (async () => {
      let s = await tryBind('udp6');
      this.family = 'udp6';
      if (!s) {
        s = await tryBind('udp4');
        this.family = 'udp4';
      }
      if (!s) return 0;
      this.sock = s;
      s.on('error', (e) => console.warn(`[lane] ${e.code || e.message}`));
      s.on('message', (pkt, rinfo) => this._onPacket(pkt, rinfo));
      if (s.unref) s.unref();
      try { s.setSendBufferSize(256 * 1024); } catch (_) { /* best effort */ }
      this.port = s.address().port;
      return this.port;
    })();
    return this._binding;
  }

  // The address as this socket sends to it ('::ffff:1.2.3.4' on a dual-stack socket), or '' (can't).
  _target(ip) {
    ip = String(ip || '').replace(/^::ffff:/, '');
    if (net.isIPv4(ip)) return this.family === 'udp6' ? `::ffff:${ip}` : ip;
    if (net.isIPv6(ip.replace(/%.*$/, ''))) return this.family === 'udp6' ? ip : '';
    return '';
  }

  // hello's field (the guest), or null: no lane.
  helloField() {
    if (laneOff() || !this.port) return null;
    return { v: 1, port: this.port };
  }

  // The host, on a hello that asked (`il` as sent) from `ip`: starts the session's lane and returns
  // welcome's field, or null.
  offer(il, ip) {
    this.stop();
    if (laneOff() || !this.port || !il || il.v !== 1) return null;
    const port = Number(il.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !this._target(ip)) return null;
    const key = crypto.randomBytes(32).toString('hex');
    this.role = 'host';
    this.start(key, ip, port);
    return { v: 1, port: this.port, key };
  }

  // The guest, on welcome (its `il`, from the host at `ip`): true when the lane starts.
  accept(il, ip) {
    this.stop();
    if (laneOff() || !this.port || !il || il.v !== 1) return false;
    const port = Number(il.port);
    if (typeof il.key !== 'string' || !/^[0-9a-f]{64}$/.test(il.key)) return false;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !this._target(ip)) return false;
    this.role = 'guest';
    this.start(il.key, ip, port);
    return true;
  }

  start(keyHex, ip, port) {
    this.stop();
    if (this.native) {
      this.keys = { native: true };
      this.peer = { address: ip, port };
      this.es = 0;
      this.rttMs = null;
      this.nat.send('lane', { op: 'start', role: this.role, key: keyHex, ip: String(ip).replace(/^::ffff:/, ''), port });
      this.emit('start');
      return;
    }
    const address = this._target(ip);
    if (!this.sock || !address) return;
    this.keys = deriveKeys(keyHex, this.role);
    this.peer = { address, port };
    this.seq = 0;
    this.es = 0;
    this.win = new ReplayWindow();
    this.lastPong = 0;
    this.rttMs = null;
    this.move = null;
    this.events = [];
    this.emit('start');
    this._pingLoop(PING_UP_MS);
  }

  get started() {
    return !!this.keys;
  }

  // Driving or driven: pinged more often, so a lane that went down is noticed sooner.
  active(on) {
    on = !!on;
    if (on === this.isActive) return;
    this.isActive = on;
    if (this.native) return this.nativeSend('active', { on });
    if (this.keys && this.up) this._pingLoop(on ? PING_ACTIVE_MS : PING_IDLE_MS);
  }

  nextEs() {
    return ++this.es;
  }

  // The latest totals ({route, mn, es, cx, cy}): at once, or within MOVE_GAP_MS (always the newest).
  sendMove(s) {
    if (!this.keys || this.native) return; // native: the helper sends its moves itself
    this.move = s;
    if (this.moveTimer) return;
    const wait = MOVE_GAP_MS - (performance.now() - this.moveAt);
    if (wait <= 0) return this._flushMove();
    this.moveTimer = setTimeout(() => {
      this.moveTimer = null;
      this._flushMove();
    }, Math.ceil(wait));
  }

  _flushMove() {
    if (!this.move || !this.keys) return;
    this.moveAt = performance.now();
    const body = encodeMove(this.move);
    this._send(TYPE.MOVE, body);
    this._tail('move', () => this.move && this._send(TYPE.MOVE, encodeMove(this.move)));
  }

  // An event message that already has its es: with the few before it, for redundancy.
  sendEvent(msg) {
    if (!this.keys || typeof msg.es !== 'number') return;
    const { es, ...rest } = msg;
    if (this.native) return this.nativeSend('event', { es, msg: rest, json: JSON.stringify(rest) }); // json: the C helpers send it as it is
    const json = Buffer.from(JSON.stringify(rest));
    if (json.length > MAX_PACKET - HDR - TAG - 7) return; // too big: its WSS copy is enough
    this.events.push({ es, json });
    if (this.events.length > EVENTS_KEEP) this.events.shift();
    const body = encodeEvents(this.events);
    if (!body) return;
    this._send(TYPE.EVENTS, body);
    this._tail('events', () => {
      const b = encodeEvents(this.events);
      if (b) this._send(TYPE.EVENTS, b);
    });
  }

  // Send `fn` again after each of TAIL_MS (from now; a newer send starts it again).
  _tail(kind, fn) {
    for (const t of this.tails[kind]) clearTimeout(t);
    this.tails[kind] = TAIL_MS.map((ms) => setTimeout(fn, ms));
  }

  _send(type, body) {
    if (!this.keys || !this.peer || !this.sock) return;
    const pkt = seal(this.keys.tx, type, ++this.seq, body);
    if (this.loss && Math.random() < this.loss) return;
    this.sent++;
    try {
      this.sock.send(pkt, this.peer.port, this.peer.address);
    } catch (_) { /* closed */ }
  }

  _pingLoop(ms) {
    clearInterval(this.pingTimer);
    this.pingEvery = ms;
    const ping = () => {
      if (!this.keys) return;
      if (this.up && performance.now() - this.lastPong > DOWN_AFTER * this.pingEvery + 50) this._setUp(false);
      const b = Buffer.allocUnsafe(8);
      writeU64(b, 0, nowUs());
      this._send(TYPE.PING, b);
      // Driving: the latest totals again with each ping, so the pointer ends in the right place
      // even when a move and both its resends were lost.
      if (this.up && this.isActive && this.move && performance.now() - this.moveAt < RESEND_FOR_MS) this._send(TYPE.MOVE, encodeMove(this.move));
    };
    this.pingTimer = setInterval(ping, ms);
    if (this.pingTimer.unref) this.pingTimer.unref();
    ping();
  }

  _setUp(up) {
    if (up === this.up) return;
    this.up = up;
    if (up) this._pingLoop(this.isActive ? PING_ACTIVE_MS : PING_IDLE_MS);
    else this._pingLoop(PING_UP_MS);
    console.log(`[lane] ${up ? 'up' : 'down'}${up && this.rttMs !== null ? ` (rtt ${this.rttMs.toFixed(1)} ms)` : ''}`);
    this.emit(up ? 'up' : 'down');
  }

  _onPacket(pkt, rinfo) {
    if (!this.keys) return;
    const p = open(this.keys.rx, pkt);
    if (!p || !this.win.ok(p.seq)) return;
    this.win.mark(p.seq);
    this.received++;
    if (this.peer.address !== rinfo.address || this.peer.port !== rinfo.port) this.peer = { address: rinfo.address, port: rinfo.port };
    switch (p.type) {
      case TYPE.PING:
        if (p.body.length === 8) this._send(TYPE.PONG, p.body);
        break;
      case TYPE.PONG: {
        if (p.body.length !== 8) break;
        const rtt = (nowUs() - readU64(p.body, 0)) / 1000;
        if (rtt >= 0 && rtt < 10000) this.rttMs = rtt;
        this.lastPong = performance.now();
        this._setUp(true);
        this.emit('rtt', this.rttMs);
        break;
      }
      case TYPE.MOVE: {
        const s = decodeMove(p.body);
        if (s) this.emit('move', s);
        break;
      }
      case TYPE.EVENTS:
        for (const m of decodeEvents(p.body)) this.emit('event', m);
        break;
    }
  }

  // The session ended: no keys, no pings; the socket stays for the next one.
  stop() {
    if (this.native && this.keys) this.nativeSend('stop');
    clearInterval(this.pingTimer);
    clearTimeout(this.moveTimer);
    for (const k of Object.keys(this.tails)) for (const t of this.tails[k]) clearTimeout(t);
    this.tails = { move: [], events: [] };
    this.pingTimer = null;
    this.moveTimer = null;
    const was = this.up;
    this.keys = null;
    this.peer = null;
    this.up = false;
    this.move = null;
    this.events = [];
    if (was) this.emit('down');
    if (this._wantNative) this.useNative(this._wantNative);
  }

  close() {
    this.stop();
    if (this.sock) try { this.sock.close(); } catch (_) { /* gone */ }
    this.sock = null;
    this.port = 0;
    this._binding = null;
  }
}

// The driving side's totals since the crossing (route).
class MoveTotals {
  constructor() {
    this.route = 0;
    this.mn = 0;
    this.cx = 0;
    this.cy = 0;
    this.es = 0; // the last event sent (all routes)
  }

  reset(route) {
    this.route = route >>> 0;
    this.mn = 0;
    this.cx = 0;
    this.cy = 0;
  }

  add(dx, dy) {
    this.mn++;
    this.cx += Number(dx) || 0;
    this.cy += Number(dy) || 0;
    return this.current();
  }

  current() {
    return { route: this.route, mn: this.mn, es: this.es, cx: this.cx, cy: this.cy };
  }
}

// The driven side: what's new in a total, once (only a newer mn counts).
class MoveApply {
  constructor() {
    this.reset(0);
  }

  reset(route) {
    this.route = route >>> 0;
    this.mn = 0;
    this.cx = 0;
    this.cy = 0;
  }

  take(s) {
    if (!s || (s.route >>> 0) !== this.route || !(s.mn > this.mn)) return null;
    const d = { dx: s.cx - this.cx, dy: s.cy - this.cy };
    this.mn = s.mn;
    this.cx = s.cx;
    this.cy = s.cy;
    return d;
  }
}

// Events in es order, each once: a duplicate goes, a gap holds the later ones until it's filled.
class EventOrder {
  constructor() {
    this.reset();
  }

  reset() {
    this.done = 0; // every es up to this one is through
    this.held = new Map();
  }

  // The messages that can go now, in order. lane: from the lane (dropped rather than held far ahead).
  push(msg, lane = false) {
    const es = msg && msg.es;
    if (!Number.isInteger(es) || es <= this.done || this.held.has(es)) return [];
    if (lane && es - this.done > HOLD_MAX) return [];
    this.held.set(es, msg);
    const out = [];
    while (this.held.has(this.done + 1)) {
      out.push(this.held.get(this.done + 1));
      this.held.delete(++this.done);
    }
    return out;
  }
}

// kvm.js glue, driving: getLane() -> the lane or null (none, Bluetooth, an older app).
class LaneDrive {
  constructor(getLane) {
    this.getLane = getLane;
    this.t = new MoveTotals();
  }

  reset(route) {
    this.t.reset(route);
    this.natTotals = null;
    const lane = this.getLane();
    if (lane && lane.native) lane.nativeSend('route', { route }); // the helper's tap sends the moves now
  }

  // Not driving any more: the helper's tap stops sending moves on the lane.
  idle() {
    const lane = this.getLane();
    if (lane && lane.native) lane.nativeSend('route', { route: 0 });
    this.natTotals = null;
  }

  // Native: the helper's k.mm with its totals (the lane is down): the latest, for the summed move.
  nativeTotals(e) {
    if (Number.isInteger(e.mn) && Array.isArray(e.mc)) this.natTotals = { route: e.route >>> 0, mn: e.mn, mc: e.mc };
  }

  // A summed move: on the lane, or as a k.mm with the totals on WSS while the lane is down. false:
  // no lane, send it as today.
  move(dx, dy, sendWss) {
    const lane = this.getLane();
    if (!lane) return false;
    if (lane.native) { // only what the helper didn't send itself comes here
      const n = this.natTotals;
      this.natTotals = null;
      if (!n) return false;
      sendWss({ t: 'k.mm', dx, dy, route: n.route, mn: n.mn, mc: n.mc });
      return true;
    }
    this.t.es = lane.es; // the last event numbered on this lane (a new session starts again at 0)
    const s = this.t.add(dx, dy);
    if (lane.up) lane.sendMove(s);
    else sendWss({ t: 'k.mm', dx, dy, route: s.route, mn: s.mn, mc: [s.cx, s.cy] });
    return true;
  }

  // A click, key, wheel or gesture: numbered and fenced (where the moves had taken the pointer),
  // on WSS always and on the lane too while it's up. No lane: as it is, on WSS.
  event(msg, sendWss) {
    const lane = this.getLane();
    if (!lane) return sendWss(msg);
    if (lane.native) { // numbered and fenced by the helper's tap (none: it wasn't driving on the lane)
      if (!Number.isInteger(msg.es)) return sendWss(msg);
      sendWss(msg);
      if (lane.up) lane.sendEvent(msg);
      return;
    }
    const c = this.t.current();
    const es = lane.nextEs();
    this.t.es = es;
    const m = { ...msg, es, route: c.route, mn: c.mn, mc: [c.cx, c.cy] };
    sendWss(m);
    if (lane.up) lane.sendEvent(m);
  }

  // Moves never wait for the WSS backlog while they go on the lane.
  get quiet() {
    const lane = this.getLane();
    return !!(lane && lane.up);
  }
}

const fenceOf = (m) => (Number.isInteger(m.mn) && Array.isArray(m.mc) && Number.isFinite(m.mc[0]) && Number.isFinite(m.mc[1])
  ? { route: m.route >>> 0, mn: m.mn, es: 0, cx: m.mc[0], cy: m.mc[1] } : null);

// kvm.js glue, driven. o: route() -> the crossing we're driven by; move(dx, dy) -> as a k.mm;
// deliver(msg) -> a click, key, wheel or gesture, as today; native() -> the lane when it is the
// helper's (its moves are injected there; fences and done go to it), else null; speed() -> kvm.speed.
class LaneDriven {
  constructor(o) {
    this.o = o;
    this.ma = new MoveApply();
    this.eo = new EventOrder();
    this.held = null; // a move waiting for the event before it
    this.early = null; // a move for a crossing whose kvm.take hasn't come yet
  }

  // A new session (the lane started again).
  reset() {
    this.ma.reset(0);
    this.eo.reset();
    this.held = null;
    this.early = null;
  }

  // kvm.take: totals start again; a move that came ahead of it goes now.
  take(route) {
    const nat = this.o.native && this.o.native();
    if (nat) nat.nativeSend('driven', { route: route >>> 0, speed: this.o.speed ? this.o.speed() : 1 });
    this.ma.reset(route);
    const e = this.early;
    this.early = null;
    this.held = null;
    if (e && e.route === (route >>> 0)) this.move(e);
  }

  // Totals from the lane, or from a WSS k.mm that has them.
  move(s) {
    const route = this.o.route() >>> 0;
    if (s.route !== route) {
      if (s.route > route && (!this.early || this.early.route !== s.route || s.mn > this.early.mn)) this.early = s;
      return;
    }
    if (s.es > this.eo.done) {
      if (!this.held || s.mn > this.held.mn) this.held = s;
      return;
    }
    this._apply(s);
  }

  // A WSS k.mm with totals.
  wssMove(m) {
    const f = fenceOf(m);
    if (f) this.move(f);
  }

  // A message with es: from the WSS (always kept in order) or from the lane (only for this crossing:
  // a lane copy that came before its kvm.take waits for the WSS copy).
  event(m, lane = false) {
    if (lane && (m.route >>> 0) !== (this.o.route() >>> 0)) return;
    for (const x of this.eo.push(m, lane)) {
      const f = fenceOf(x);
      if (f && f.route === (this.o.route() >>> 0)) this._apply(f);
      const { es, route, mn, mc, ...msg } = x; // eslint-disable-line no-unused-vars
      this.o.deliver(msg);
      const nat = this.o.native && this.o.native();
      if (nat) nat.nativeSend('done', { es }); // a move on the lane that waited for it goes now
    }
    const h = this.held;
    if (h && h.es <= this.eo.done) {
      this.held = null;
      this.move(h);
    }
  }

  // Not driven any more (native: the helper injects nothing more from the lane).
  home() {
    const nat = this.o.native && this.o.native();
    if (nat) nat.nativeSend('driven', { route: 0, speed: 1 });
  }

  // Drag-in arming (native): the helper holds the lane's moves meanwhile.
  hold(on) {
    const nat = this.o.native && this.o.native();
    if (nat) nat.nativeSend('hold', { on: !!on });
  }

  _apply(s) {
    const nat = this.o.native && this.o.native();
    if (nat) return nat.nativeSend('fence', { route: s.route, mn: s.mn, cx: s.cx, cy: s.cy }); // the helper's totals
    const d = this.ma.take(s);
    if (d && (d.dx || d.dy)) this.o.move(d.dx, d.dy);
  }
}

// The address a WSS socket's peer has (the lane's target): the TCP socket's, else what the app keeps.
function peerIp(ws, fallback) {
  return (ws && ws._socket && ws._socket.remoteAddress) || (ws && ws.address) || fallback || '';
}

// ---- the multi-device apps (*/mesh/): a lane of its own for each device's session ----

// The guest side: one lane per Link (link.js), bound when the link is made; null with the kill switch.
function linkLane() {
  if (laneOff()) return null;
  const l = new InputLane();
  l.bind();
  return l;
}

// The host side (server.js): a bound lane is always ready, so welcome can carry its port at once.
// offer() hands it to the ctx (ctx.ilLane) and binds the next; drop() closes the ctx's.
class LanePool {
  constructor() {
    this.spare = null;
    this._refill();
  }

  _refill() {
    if (laneOff() || this.spare) return;
    this.spare = new InputLane();
    this.spare.bind();
  }

  // welcome's `il` for ctx (its hello's `il` as sent, the address it came from), or null.
  offer(ctx, il, ip) {
    this.drop(ctx);
    const l = this.spare;
    if (!l || !l.port) return this._refill(), null;
    const f = l.offer(il, ip);
    if (!f) return null;
    this.spare = null;
    this._refill();
    ctx.ilLane = l;
    return f;
  }

  drop(ctx) {
    if (!ctx || !ctx.ilLane) return;
    ctx.ilLane.close();
    ctx.ilLane = null;
  }

  close() {
    if (this.spare) this.spare.close();
    this.spare = null;
  }
}

// Message types that go numbered (es) and fenced when there's a lane.
const LANE_TYPES = new Set(['k.md', 'k.mu', 'k.wh', 'k.kd', 'k.ku', 'k.ge']);

// The multi-device kvm.js glue: the lane of whichever device is the partner. o:
//   lane(id) -> that device's lane while it can carry input (null: none, Bluetooth, the phone bridge);
//   il(id) -> that device's lane object, started or not (null: none);
//   partner() -> the device we drive or are driven by; route() -> the crossing we're driven by;
//   move(dx, dy, id), deliver(msg, id) -> as WSS input from that device.
class LaneMesh {
  constructor(o) {
    this.o = o;
    this.drive = new LaneDrive(() => this.o.lane(this.o.partner()));
    this.lanes = new Map(); // id -> {lane, driven}
  }

  // A device came up: its lane's input goes to us, with an order of its own (each lane numbers its
  // events from 1).
  attach(id) {
    const l = id ? this.o.il(id) : null;
    const had = this.lanes.get(id);
    if (!l || (had && had.lane === l)) return;
    const d = new LaneDriven({
      route: () => (this.o.partner() === id ? this.o.route() : 0),
      move: (dx, dy) => this.o.move(dx, dy, id),
      deliver: (m) => this.o.deliver(m, id),
    });
    const entry = { lane: l, driven: d };
    this.lanes.set(id, entry);
    const mine = () => this.lanes.get(id) === entry;
    l.on('start', () => mine() && d.reset());
    l.on('move', (s) => mine() && d.move(s));
    l.on('event', (m) => mine() && LANE_TYPES.has(m.t) && d.event(m, true));
  }

  // The LaneDriven of a device whose lane has started (WSS input with es or totals goes through it), or null.
  _driven(id) {
    const e = this.lanes.get(id);
    const l = this.o.il(id);
    if (!l || !l.started) return null;
    if (!e || e.lane !== l) this.attach(id);
    return this.lanes.get(id).driven;
  }

  // WSS input from `id`: true when the lane's order took it (else it goes as always).
  wire(m, id) {
    const d = this._driven(id);
    if (!d) return false;
    if (m.t === 'k.mm' && Number.isInteger(m.mn)) return d.wssMove(m), true;
    if (Number.isInteger(m.es)) return d.event(m), true;
    return false;
  }

  // kvm.take from `id` accepted.
  take(id, route) {
    const d = this._driven(id);
    if (d) d.take(route);
  }

  // Pinged more often while driving or driven, on the partner's lane only.
  active(on) {
    const p = this.o.partner();
    for (const [id, e] of this.lanes) e.lane.active(on && id === p);
  }

  // The partner's lane RTT while it is up (the log's [link] line), or null.
  rtt() {
    const l = this.o.lane(this.o.partner());
    return l && l.up ? l.rttMs : null;
  }
}

module.exports = {
  InputLane, MoveTotals, MoveApply, EventOrder, LaneDrive, LaneDriven, ReplayWindow,
  LanePool, LaneMesh, linkLane, peerIp, LANE_TYPES,
  seal, open, deriveKeys, encodeMove, decodeMove, encodeEvents, decodeEvents, laneOff, TYPE,
};

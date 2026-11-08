// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// An iPhone's or iPad's screen over its USB cable: QuickTime's screen capture, the protocol a Mac
// uses to record a phone. Worked out by Daniel Paulus in quicktime_video_hack
// (https://github.com/danielpaulus/quicktime_video_hack, MIT) and followed here, rewritten in
// JavaScript: its packet/ (ping, sync, asyn) and coremedia/ (dict, CMSampleBuffer, format
// descriptions) parts. See THIRD_PARTY_NOTICES.
//
// The phone, once its screen-capture configuration is on (twindesk-iosusb.exe, linux later), sends
// length-prefixed packets: a ping, then sync requests that want a reply (clocks, the audio format,
// the time, the skew) and asyn ones that don't (FEED: H.264, EAT!: sound). The host answers the
// clocks, says what it is (HPD1: a display; HPA1: 48 kHz 16-bit stereo PCM) and asks for each next
// frame (NEED). All numbers are little-endian; a tag like 'sync' is a u32 of its four letters.
//
// new QtSession(write(buf)) — feed(bytes) with what the phone sends; .close() asks it to stop.
// Events: 'config' ({codec, avcC, width, height}) | 'frame' ({data (AVCC), key})
//   | 'audio' ({data (Int16 interleaved), rate, channels}) | 'closed' | 'warn' (text)
'use strict';

const { EventEmitter } = require('events');

const tag = (s) => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
const T = {};
for (const s of ['ping', 'sync', 'asyn', 'rply', 'cwpa', 'cvrp', 'clok', 'time', 'afmt', 'skew', 'stop', 'go! ',
  'feed', 'eat!', 'need', 'hpd1', 'hpa1', 'hpd0', 'hpa0', 'rels', 'sprp', 'tjmp', 'srat', 'tbas',
  'dict', 'keyv', 'strk', 'idxk', 'strv', 'datv', 'bulv', 'nmbv', 'fdsc', 'sbuf', 'sdat', 'mdia', 'vdim', 'codc', 'extn', 'asbd',
  'vide', 'soun', 'avc1', 'lpcm', 'opts']) T[s.trim() || s] = tag(s);
T.og = tag('go! ');
const EMPTY_CF = 1n; // quicktime_video_hack's EmptyCFType: "no clock"

// ---- writing -------------------------------------------------------------------------------
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(n))); return b; };
const f64 = (n) => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; };
const el = (t, body) => Buffer.concat([u32(8 + body.length), u32(t), body]);
// Values: true/false, a string, a Buffer, {f64}, {u32}, or a plain object (a dict).
function value(v) {
  if (typeof v === 'boolean') return el(T.bulv, Buffer.from([v ? 1 : 0]));
  if (typeof v === 'string') return el(T.strv, Buffer.from(v, 'utf8'));
  if (Buffer.isBuffer(v)) return el(T.datv, v);
  if (v && 'f64' in v) return el(T.nmbv, Buffer.concat([Buffer.from([6]), f64(v.f64)]));
  if (v && 'u32' in v) return el(T.nmbv, Buffer.concat([Buffer.from([3]), u32(v.u32)]));
  return dict(v);
}
const dict = (o) => el(T.dict, Buffer.concat(Object.entries(o).map(([k, v]) => el(T.keyv, Buffer.concat([el(T.strk, Buffer.from(k, 'utf8')), value(v)])))));

// The audio this host takes: 48 kHz, 16-bit signed, packed, 2 channels (AudioStreamBasicDescription,
// flags 12), in the 56 bytes quicktime_video_hack sends: the 40 of it, then the rate twice more.
const RATE = 48000;
function asbd() {
  return Buffer.concat([f64(RATE), u32(T.lpcm), u32(12), u32(4), u32(1), u32(4), u32(2), u32(16), u32(0), f64(RATE), f64(RATE)]);
}
const HPD1 = () => dict({ Valeria: true, HEVCDecoderSupports444: true, DisplaySize: { Width: { f64: 1920 }, Height: { f64: 1200 } } });
const HPA1 = () => dict({ BufferAheadInterval: { f64: 0.07300000000000001 }, deviceUID: 'Valeria', ScreenLatency: { f64: 0.04 }, formats: asbd(), EDIDAC3Support: { u32: 0 }, deviceName: 'Valeria' });

const ping = () => Buffer.concat([u32(16), u32(T.ping), u32(0), u32(1)]);
const asynPacket = (clock, type, body = Buffer.alloc(0)) => Buffer.concat([u32(20 + body.length), u32(T.asyn), u64(clock), u32(type), body]);
// A reply to a sync request: its correlation id, then what it asks for.
const reply = (corr, body = Buffer.alloc(0)) => Buffer.concat([u32(20 + body.length), u32(T.rply), u64(corr), u32(0), body]);

// ---- reading -------------------------------------------------------------------------------
// Each element: [u32 length (with these 8 bytes)][u32 tag][body]. Walks a run of them.
function* elements(buf, at = 0, end = buf.length) {
  while (at + 8 <= end) {
    const len = buf.readUInt32LE(at);
    if (len < 8 || at + len > end) return;
    yield { t: buf.readUInt32LE(at + 4), body: buf.subarray(at + 8, at + len) };
    at += len;
  }
}
const CONTAINERS = new Set([T.dict, T.keyv, T.sbuf, T.fdsc, T.extn]);

// What a format description says: its media and codec, the picture's size, the avcC record
// (extension 49 › 105, the sample description's atoms), and the sound's format.
function formatOf(fdsc) {
  const f = { media: 0, codec: 0, width: 0, height: 0, avcC: null, asbd: null };
  const walk = (buf, depth) => {
    for (const e of elements(buf)) {
      if (e.t === T.mdia && e.body.length >= 4) f.media = e.body.readUInt32LE(0);
      else if (e.t === T.codc && e.body.length >= 4) f.codec = e.body.readUInt32LE(0);
      else if (e.t === T.vdim && e.body.length >= 8) { f.width = e.body.readUInt32LE(0); f.height = e.body.readUInt32LE(4); }
      else if (e.t === T.asbd && e.body.length >= 40) f.asbd = readAsbd(e.body);
      else if (e.t === T.keyv && depth < 8) {
        const kv = [...elements(e.body)];
        if (kv.length >= 2 && kv[0].t === T.idxk && kv[0].body.length >= 2 && kv[0].body.readUInt16LE(0) === 105 && kv[1].t === T.datv && kv[1].body[0] === 1) f.avcC = Buffer.from(kv[1].body);
        else walk(e.body, depth + 1);
      } else if (CONTAINERS.has(e.t) && depth < 8) walk(e.body, depth + 1);
    }
  };
  walk(fdsc, 0);
  return f;
}
const readAsbd = (b) => ({ rate: b.readDoubleLE(0), format: b.readUInt32LE(8), flags: b.readUInt32LE(12), channels: b.readUInt32LE(28), bits: b.readUInt32LE(32) });

// The first format description anywhere under buf.
function findFdsc(buf, depth = 0) {
  for (const e of elements(buf)) {
    if (e.t === T.fdsc) return e.body;
    if (CONTAINERS.has(e.t) && depth < 8) { const r = findFdsc(e.body, depth + 1); if (r) return r; }
  }
  return null;
}

// A CMSampleBuffer: its sample data and, sometimes, a format description.
function sampleBuffer(buf) {
  const out = { data: null, fdsc: null, pts: null };
  for (const e of elements(buf)) {
    if (e.t !== T.sbuf) continue;
    for (const c of elements(e.body)) {
      if (c.t === T.opts && c.body.length >= 12) out.pts = { value: c.body.readBigUInt64LE(0), scale: c.body.readUInt32LE(8) };
      else if (c.t === T.sdat) out.data = c.body;
      else if (c.t === T.fdsc) out.fdsc = c.body;
    }
  }
  return out;
}

// An H.264 access unit in AVCC (4-byte lengths): an IDR slice in it makes it a key frame.
function hasIdr(b) {
  for (let i = 0; i + 5 <= b.length;) {
    const n = b.readUInt32BE(i);
    if ((b[i + 4] & 0x1f) === 5) return true;
    if (n <= 0) return false;
    i += 4 + n;
  }
  return false;
}
const hex = (n) => n.toString(16).padStart(2, '0');

// A CMClock: nanoseconds since it was made.
class Clock {
  constructor(id) { this.id = BigInt(id); this.t0 = process.hrtime.bigint(); }
  // CMTime: value (i64), timescale (u32), flags (u32: 1, has been rounded), epoch (i64)
  ns() { return process.hrtime.bigint() - this.t0; }
  time() { return Buffer.concat([u64(this.ns()), u32(1e9), u32(1), u64(0)]); }
}

class QtSession extends EventEmitter {
  constructor(write) {
    super();
    this.write = write;
    this.buf = Buffer.alloc(0);
    this.clock = null; // CLOK's, for TIME
    this.audioClock = null; // CWPA's
    this.deviceAudioClock = 0n;
    this.need = null; // NEED, sent after every frame
    this.format = null;
    this.closing = false;
    this.released = 0;
  }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len < 8 || len > 64 << 20) { this.emit('warn', `bad length ${len}`); this.buf = Buffer.alloc(0); return; }
      if (this.buf.length < len) return;
      const p = this.buf.subarray(4, len);
      this.buf = this.buf.subarray(len);
      try { this._packet(p); } catch (e) { this.emit('warn', `packet: ${e.message}`); }
    }
  }

  _packet(p) {
    const magic = p.readUInt32LE(0);
    if (magic === T.ping) return this.write(ping());
    if (magic === T.sync) return this._sync(p);
    if (magic === T.asyn) return this._asyn(p);
    this.emit('warn', `unknown packet ${magic.toString(16)}`);
  }

  // sync: [tag][clock u64][type][correlation u64][payload]; each wants a reply.
  _sync(p) {
    const type = p.readUInt32LE(12);
    const corr = p.readBigUInt64LE(16);
    const rest = p.subarray(24);
    const w = (b) => this.write(b);
    switch (type) {
      case T.cwpa: { // the phone's audio clock: ours in return, and what this host is
        this.deviceAudioClock = rest.readBigUInt64LE(0);
        const mine = this.deviceAudioClock + 1000n;
        this.audioClock = new Clock(mine);
        // HPD1 twice, as quicktime_video_hack does (messageprocessor.go).
        w(asynPacket(EMPTY_CF, T.hpd1, HPD1()));
        w(asynPacket(EMPTY_CF, T.hpd1, HPD1()));
        w(reply(corr, u64(mine)));
        w(asynPacket(this.deviceAudioClock, T.hpa1, HPA1()));
        return;
      }
      case T.cvrp: { // the video stream starts: its clock (for NEED) and first format
        const devClock = rest.readBigUInt64LE(0);
        this.need = asynPacket(devClock, T.need);
        const f = findFdsc(rest.subarray(8));
        if (f) this._format(formatOf(f));
        w(this.need);
        w(reply(corr, u64(devClock + 0x1000afn)));
        return;
      }
      case T.clok: {
        const ref = p.readBigUInt64LE(4) + 0x10000n;
        this.clock = new Clock(ref);
        w(reply(corr, u64(ref)));
        return;
      }
      case T.time: return w(reply(corr, (this.clock || this.audioClock || new Clock(0)).time()));
      case T.afmt: return w(reply(corr, dict({ Error: { u32: 0 } })));
      case T.skew: return w(reply(corr, f64(this._skew())));
      case T.og: return w(Buffer.concat([u32(24), u32(T.rply), u64(corr), u64(0)]));
      case T.stop: return w(Buffer.concat([u32(24), u32(T.rply), u64(corr), u64(0)]));
      default: this.emit('warn', `sync ${type.toString(16)} not handled`); return w(reply(corr));
    }
  }

  // asyn: [tag][clock u64][type][payload]
  _asyn(p) {
    const type = p.readUInt32LE(12);
    const rest = p.subarray(16);
    if (type === T.feed) {
      const s = sampleBuffer(rest);
      if (s.fdsc) this._format(formatOf(s.fdsc));
      if (s.data && s.data.length) this.emit('frame', { data: Buffer.from(s.data), key: hasIdr(s.data) });
      if (this.need && !this.closing) this.write(this.need);
      return;
    }
    if (type === T['eat!']) {
      const s = sampleBuffer(rest);
      if (s.fdsc) { const f = formatOf(s.fdsc); if (f.asbd) this.sound = f.asbd; }
      // The skew's two clocks: the phone's timestamps against our audio clock, first and last.
      if (s.pts && s.pts.scale) {
        const local = this.audioClock ? this.audioClock.ns() : 0n;
        if (!this.skewStart) this.skewStart = { dev: s.pts.value, local };
        this.skewLast = { dev: s.pts.value, local, scale: s.pts.scale };
      }
      const a = this.sound || { rate: RATE, channels: 2, bits: 16, flags: 12 };
      if (s.data && s.data.length && a.bits === 16 && !(a.flags & 1)) {
        const d = Buffer.from(s.data);
        this.emit('audio', { data: new Int16Array(d.buffer, d.byteOffset, d.length >> 1), rate: a.rate || RATE, channels: a.channels || 2 });
      }
      return;
    }
    if (type === T.rels) {
      if (this.closing && ++this.released === 2) this._closed();
      return;
    }
    // sprp (a property), tjmp, srat (rate), tbas: nothing to do here.
  }

  // CalculateSkew (cmclock.go): the phone's sample rate as our clock sees it; 48000 until sound comes.
  _skew() {
    const a = this.skewStart, b = this.skewLast;
    if (!a || !b) return RATE;
    const dev = Number(b.dev - a.dev);
    const local = Number(b.local - a.local) * (b.scale / 1e9);
    const v = dev > 0 ? (b.scale * local) / dev : NaN;
    return Number.isFinite(v) && v > 0 ? v : RATE;
  }

  _closed() {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.closeTimer);
    this.write(asynPacket(EMPTY_CF, T.hpd0)); // once more after both releases, as quicktime_video_hack does
    this.emit('closed');
  }

  _format(f) {
    if (f.media && f.media !== T.vide) return;
    if (!f.avcC) return;
    const key = f.avcC.toString('hex');
    if (this.format === key) return;
    this.format = key;
    const codec = `avc1.${hex(f.avcC[1])}${hex(f.avcC[2])}${hex(f.avcC[3])}`;
    this.emit('config', { codec, avcC: f.avcC, width: f.width, height: f.height });
  }

  // Stop: the audio and the display go away (HPA0, HPD0); the phone releases both (RELS) and stops.
  close() {
    if (this.closing) return;
    this.closing = true;
    this.write(asynPacket(this.deviceAudioClock, T.hpa0));
    this.write(asynPacket(EMPTY_CF, T.hpd0));
    // No releases in 3 s: give up waiting (closed all the same).
    this.closeTimer = setTimeout(() => { if (!this.done) { this.done = true; this.emit('closed'); } }, 3000);
  }
}

module.exports = { QtSession, T, tag, dict, elements, formatOf, hasIdr, asynPacket, el, u32, u64 };

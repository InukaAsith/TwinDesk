// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Adapted from UxPlay (https://github.com/FDH2/UxPlay, GPL-3.0; lib/raop.c, raop_handlers.h,
// raop_rtp_mirror.c, raop_rtp.c, raop_ntp.c, mirror_buffer.c) and RPiPlay before it: all credit for
// the protocol is theirs. See README.md and THIRD_PARTY_NOTICES.
// An AirPlay screen-mirroring receiver (the legacy protocol UxPlay and RPiPlay speak, as an Apple TV
// 3,2): an iPhone, iPad or Mac lists this computer under Screen Mirroring and sends its screen here.
//
//   advertise.js   _airplay._tcp and _raop._tcp on the network
//   pairing.js     /pair-setup and /pair-verify (Ed25519 + X25519)
//   fairplay.js    /fp-setup, and the SETUP's key unwrapped (playfair.wasm)
//   bplist.js      the request and answer bodies
//
// The control channel is RTSP on one TCP port. A mirroring session SETUPs twice: first the keys and
// the timing port, then its streams: 110, the screen (H.264 over its own TCP port, AES-CTR), and 96,
// its sound (AAC-ELD over RTP/UDP, AES-CBC per packet). We ask the sender's clock every few seconds
// (NTP-like timing port); frames are shown as they come, so the times only matter to the sender.
//
// new AirPlayReceiver({name, dir, display: {width, height, fps}}); .start() → Promise; .stop();
//   .view() → {on, error, port, session: {id, name, model, ip, since} | null}; .end() (stop mirroring)
// Events: 'session' (info) | 'config' ({avcC, codec, width, height}) | 'frame' ({data, key, ts})
//   | 'audio' ({ct (8: AAC-ELD, mirroring's), spf, data (one access unit), seq, ts}) | 'volume' (dB, -144 muted)
//   | 'end' | 'change'
'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const bplist = require('./bplist.js');
const { FairPlay } = require('./fairplay.js');
const { Pairing, loadIdentity, sha512 } = require('./pairing.js');
const { Advertiser } = require('./advertise.js');

const SOURCE_VERSION = '220.68';
const MODEL = 'AppleTV3,2';
// UxPlay's feature bits (screen mirroring, FairPlay, legacy pairing, RAOP audio; no AirPlay video URLs).
const FEATURES_LO = 0x5a7ffee6;
const FEATURES_HI = 0x0;
const FEATURES = `0x${FEATURES_LO.toString(16).toUpperCase()},0x${FEATURES_HI.toString(16).toUpperCase()}`;
const MAX_BODY = 1 << 20;
const DISPLAY_UUID = 'e0ff8a27-6738-3d56-8a16-cc53aacee925';

const u64 = (v) => (typeof v === 'bigint' ? BigInt.asUintN(64, v) : BigInt(Math.trunc(Number(v) || 0))).toString();
const ntpNow = () => {
  const ms = Date.now();
  const b = Buffer.alloc(8);
  b.writeUInt32BE(Math.floor(ms / 1000) + 2208988800, 0);
  b.writeUInt32BE(Math.floor(((ms % 1000) / 1000) * 2 ** 32) >>> 0, 4);
  return b;
};

// The NAL units of an AVCC frame (4-byte lengths): is one an IDR?
function hasIdr(buf) {
  for (let i = 0; i + 4 < buf.length;) {
    const n = buf.readUInt32BE(i);
    if (!n || i + 4 + n > buf.length) break;
    if ((buf[i + 4] & 0x1f) === 5) return true;
    i += 4 + n;
  }
  return false;
}

class Session extends EventEmitter {
  constructor(rx, sock) {
    super();
    this.rx = rx;
    this.sock = sock;
    this.ip = (sock.remoteAddress || '').replace(/^::ffff:/, '');
    this.id = crypto.randomBytes(6).toString('hex');
    this.pairing = new Pairing(rx.identity);
    this.fp = new FairPlay();
    this.key = null; // the session's AES key (FairPlay's, hashed with the pairing secret)
    this.iv = null;
    this.info = null;
    this.mirror = null; // {server, sock}
    this.audio = null; // {data, control}
    this.timing = null;
    this.buf = Buffer.alloc(0);
    sock.on('data', (d) => this._data(d));
    sock.on('error', () => {});
    sock.on('close', () => this.close());
  }

  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) { if (this.buf.length > 16384) this.sock.destroy(); return; }
      const lines = this.buf.toString('latin1', 0, end).split('\r\n');
      const [method, uri, proto] = lines[0].split(' ');
      const headers = {};
      for (const l of lines.slice(1)) { const c = l.indexOf(':'); if (c > 0) headers[l.slice(0, c).trim().toLowerCase()] = l.slice(c + 1).trim(); }
      const len = Number(headers['content-length'] || 0);
      if (!(len >= 0 && len <= MAX_BODY)) return this.sock.destroy();
      if (this.buf.length < end + 4 + len) return;
      const body = this.buf.subarray(end + 4, end + 4 + len);
      this.buf = this.buf.subarray(end + 4 + len);
      try {
        this._request({ method, uri, proto: proto || 'RTSP/1.0', headers, body: Buffer.from(body) });
      } catch (e) {
        console.warn('[airplay]', method, uri, e.message);
        this._reply({ proto, headers }, 500);
      }
    }
  }

  _reply(req, status = 200, body = null, type = '', extra = {}) {
    if (this.sock.destroyed) return;
    const text = { 200: 'OK', 400: 'Bad Request', 404: 'Not Found', 453: 'Not Enough Bandwidth', 470: 'Connection Authorization Required', 500: 'Internal Server Error' }[status] || 'Error';
    const h = [`${req.proto && req.proto.startsWith('HTTP') ? req.proto : 'RTSP/1.0'} ${status} ${text}`, `Server: AirTunes/${SOURCE_VERSION}`];
    if (req.headers && req.headers.cseq) h.push(`CSeq: ${req.headers.cseq}`);
    for (const [k, v] of Object.entries(extra)) h.push(`${k}: ${v}`);
    const b = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : Buffer.alloc(0);
    if (type) h.push(`Content-Type: ${type}`);
    h.push(`Content-Length: ${b.length}`);
    this.sock.write(Buffer.concat([Buffer.from(`${h.join('\r\n')}\r\n\r\n`, 'latin1'), b]));
  }

  _plist(req, obj) { this._reply(req, 200, bplist.build(obj), 'application/x-apple-binary-plist'); }

  _request(req) {
    const { method, uri, body } = req;
    const p = (uri || '').replace(/^rtsp:\/\/[^/]*/, '').split('?')[0];
    if (method === 'GET' && p === '/info') return this._info(req);
    if (method === 'POST' && p === '/pair-setup') return this._reply(req, 200, this.pairing.setup(body), 'application/octet-stream');
    if (method === 'POST' && p === '/pair-verify') {
      const r = this.pairing.verify(body);
      return r ? this._reply(req, 200, r, 'application/octet-stream') : this._reply(req, 470);
    }
    if (method === 'POST' && p === '/fp-setup') {
      const r = this.fp.setup(body);
      return r ? this._reply(req, 200, r, 'application/octet-stream') : this._reply(req, 400);
    }
    if (method === 'OPTIONS') return this._reply(req, 200, null, '', { Public: 'SETUP, RECORD, PAUSE, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER, ANNOUNCE' });
    if (method === 'SETUP') {
      return this._setup(req).catch((e) => { console.warn('[airplay] SETUP', e.message); this._reply(req, 500); });
    }
    if (method === 'RECORD') return this._reply(req, 200, null, '', { 'Audio-Latency': '11025', 'Audio-Jack-Status': 'connected; type=analog' });
    if (method === 'GET_PARAMETER') {
      const want = body.toString('utf8');
      return this._reply(req, 200, /volume/.test(want) ? 'volume: 0.000000\r\n' : '', 'text/parameters');
    }
    if (method === 'SET_PARAMETER') {
      const v = /volume:\s*(-?[\d.]+)/.exec(body.toString('utf8'));
      if (v) this.rx.emit('volume', Number(v[1]));
      return this._reply(req, 200);
    }
    if (method === 'FLUSH' || method === 'ANNOUNCE') return this._reply(req, 200);
    if (method === 'TEARDOWN') return this._teardown(req);
    if (method === 'POST' && (p === '/feedback' || p === '/command' || p === '/audioMode')) return this._reply(req, 200);
    return this._reply(req, 404);
  }

  _info(req) {
    const rx = this.rx;
    let q = null;
    try { q = req.body.length ? bplist.parse(req.body) : null; } catch (_) {}
    if (q && Array.isArray(q.qualifier) && q.qualifier.includes('txtAirPlay')) {
      return this._plist(req, { txtAirPlay: require('./advertise.js').txtData(rx.airplayTxt()) });
    }
    const d = rx.display;
    const fmt = (type) => ({ type, audioInputFormats: 0x3fffffc, audioOutputFormats: 0x3fffffc });
    const lat = (type) => ({ type, audioType: 'default', inputLatencyMicros: 0, outputLatencyMicros: 0 });
    this._plist(req, {
      deviceID: rx.identity.id,
      macAddress: rx.identity.id,
      features: FEATURES_HI * 2 ** 32 + FEATURES_LO,
      name: rx.name,
      model: MODEL,
      pi: rx.identity.pi,
      pk: rx.identity.pk,
      sourceVersion: SOURCE_VERSION,
      statusFlags: 68,
      vv: 2,
      keepAliveLowPower: true,
      keepAliveSendStatsAsBody: true,
      audioFormats: [fmt(100), fmt(101)],
      audioLatencies: [lat(100), lat(101)],
      displays: [{
        uuid: DISPLAY_UUID, widthPhysical: 0, heightPhysical: 0,
        width: d.width, height: d.height, widthPixels: d.width, heightPixels: d.height,
        rotation: false, refreshRate: { real: d.fps }, maxFPS: d.fps, overscanned: false, features: 14,
      }],
    });
  }

  async _setup(req) {
    const s = bplist.parse(req.body);
    const out = {};
    if (Buffer.isBuffer(s.ekey) && Buffer.isBuffer(s.eiv)) {
      let key = this.fp.decrypt(s.ekey);
      if (this.pairing.secret) key = sha512(key, this.pairing.secret).subarray(0, 16);
      this.key = key;
      this.iv = Buffer.from(s.eiv.subarray(0, 16));
      this.info = { id: this.id, name: String(s.name || 'iPhone').slice(0, 80), model: String(s.model || '').slice(0, 40), ip: this.ip, since: Date.now() };
      this.rx._claim(this);
      out.eventPort = 0;
      out.timingPort = await this._timing(Number(s.timingPort) || 0);
    }
    if (Array.isArray(s.streams)) {
      if (!this.key) return this._reply(req, 400);
      out.streams = [];
      for (const st of s.streams) {
        if (st.type === 110) out.streams.push({ type: 110, dataPort: await this._mirror(u64(st.streamConnectionID)) });
        else if (st.type === 96) out.streams.push({ type: 96, ...(await this._audio(Number(st.ct) || 0, Number(st.spf) || 0)) });
      }
    }
    this._plist(req, out);
  }

  // Our side of the sender's clock: a request every 3 seconds; its answers aren't needed to show frames.
  _timing(theirPort) {
    return new Promise((resolve) => {
      const s = dgram.createSocket('udp4');
      s.on('error', () => {});
      s.on('message', () => {});
      s.bind(0, () => {
        const ask = () => {
          if (!theirPort) return;
          const r = Buffer.alloc(32);
          r[0] = 0x80; r[1] = 0xd2; r[2] = 0x00; r[3] = 0x07;
          ntpNow().copy(r, 24);
          try { s.send(r, theirPort, this.ip); } catch (_) {}
        };
        ask();
        this.timing = { sock: s, timer: setInterval(ask, 3000) };
        resolve(s.address().port);
      });
    });
  }

  _mirror(streamId) {
    this._stopMirror();
    const key = sha512(Buffer.from(`AirPlayStreamKey${streamId}`), this.key).subarray(0, 16);
    const iv = sha512(Buffer.from(`AirPlayStreamIV${streamId}`), this.key).subarray(0, 16);
    const ctr = crypto.createDecipheriv('aes-128-ctr', key, iv);
    return new Promise((resolve) => {
      const server = net.createServer((c) => {
        if ((c.remoteAddress || '').replace(/^::ffff:/, '') !== this.ip) return c.destroy();
        if (this.mirror.sock) this.mirror.sock.destroy();
        this.mirror.sock = c;
        c.setNoDelay(true);
        let buf = Buffer.alloc(0);
        c.on('error', () => {});
        c.on('data', (d) => {
          buf = buf.length ? Buffer.concat([buf, d]) : d;
          while (buf.length >= 128) {
            const size = buf.readUInt32LE(0);
            if (size > 32 << 20) return c.destroy();
            if (buf.length < 128 + size) break;
            const head = buf.subarray(0, 128);
            const payload = buf.subarray(128, 128 + size);
            buf = buf.subarray(128 + size);
            this._packet(head, payload, ctr);
          }
        });
      });
      this.mirror = { server, sock: null };
      server.on('error', () => resolve(0));
      server.listen(0, () => resolve(server.address().port));
    });
  }

  _packet(head, payload, ctr) {
    const type = head[4];
    const ts = head.readBigUInt64LE(8);
    if (type === 0) {
      const data = ctr.update(payload);
      this.rx.emit('frame', { data, key: hasIdr(data), ts });
    } else if (type === 1) {
      // avcC: version, profile, compatibility, level, …, SPS, PPS. Sizes: header floats.
      if (payload.length < 8 || payload[0] !== 1) return;
      const hex = (b) => b.toString(16).padStart(2, '0');
      const codec = `avc1.${hex(payload[1])}${hex(payload[2])}${hex(payload[3])}`;
      const width = Math.round(head.readFloatLE(56)) || Math.round(head.readFloatLE(40));
      const height = Math.round(head.readFloatLE(60)) || Math.round(head.readFloatLE(44));
      this.rx.emit('config', { avcC: Buffer.from(payload), codec, width, height });
    }
    // 2: heartbeat; 5: the sender's stream report (a plist) — nothing to do.
  }

  // The sound: RTP on a UDP data port (and a control port for sync and resends, unused here).
  _audio(ct, spf) {
    this._stopAudio();
    const open = () => new Promise((resolve) => {
      const s = dgram.createSocket('udp4');
      s.on('error', () => {});
      s.bind(0, () => resolve(s));
    });
    return Promise.all([open(), open()]).then(([data, control]) => {
      this.audio = { data, control };
      data.on('message', (m, rinfo) => {
        if (rinfo.address.replace(/^::ffff:/, '') !== this.ip || m.length <= 12 || (m[1] & 0x7f) !== 0x60) return;
        const enc = m.subarray(12);
        const whole = enc.length & ~15;
        const d = crypto.createDecipheriv('aes-128-cbc', this.key, this.iv);
        d.setAutoPadding(false);
        const plain = Buffer.concat([whole ? d.update(enc.subarray(0, whole)) : Buffer.alloc(0), enc.subarray(whole)]);
        this.rx.emit('audio', { ct, spf, data: plain, seq: m.readUInt16BE(2), ts: m.readUInt32BE(4) });
      });
      control.on('message', () => {});
      return { dataPort: data.address().port, controlPort: control.address().port };
    });
  }

  _teardown(req) {
    let streams = null;
    try { streams = req.body.length ? bplist.parse(req.body).streams : null; } catch (_) {}
    this._reply(req, 200);
    if (Array.isArray(streams) && streams.length) {
      for (const st of streams) {
        if (st.type === 110) this._stopMirror();
        if (st.type === 96) this._stopAudio();
      }
      if (!this.mirror && !this.audio) this.rx._release(this);
      return;
    }
    this.close();
  }

  _stopMirror() {
    const m = this.mirror;
    this.mirror = null;
    if (!m) return;
    try { m.server.close(); } catch (_) {}
    if (m.sock) m.sock.destroy();
  }

  _stopAudio() {
    const a = this.audio;
    this.audio = null;
    if (!a) return;
    try { a.data.close(); } catch (_) {}
    try { a.control.close(); } catch (_) {}
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._stopMirror();
    this._stopAudio();
    if (this.timing) { clearInterval(this.timing.timer); try { this.timing.sock.close(); } catch (_) {} this.timing = null; }
    // end(): a reply just written (TEARDOWN's) still reaches the sender.
    if (!this.sock.destroyed) { this.sock.end(); setTimeout(() => this.sock.destroy(), 1000).unref(); }
    this.rx._release(this);
    this.rx.conns.delete(this);
  }
}

class AirPlayReceiver extends EventEmitter {
  constructor(o) {
    super();
    this.name = String(o.name || os.hostname()).replace(/\.local$/i, '').slice(0, 60) || 'TwinDesk';
    this.dir = o.dir;
    this.display = { width: 1920, height: 1080, fps: 60, ...(o.display || {}) };
    this.wantPort = o.port || 7000;
    this.identity = null;
    this.server = null;
    this.adv = null;
    this.port = 0;
    this.error = '';
    this.conns = new Set();
    this.active = null; // the Session that mirrors now
  }

  airplayTxt() {
    return {
      deviceid: this.identity.id, features: FEATURES, flags: '0x4', model: MODEL,
      pk: this.identity.pk.toString('hex'), pi: this.identity.pi, srcvers: SOURCE_VERSION, vv: '2',
    };
  }

  raopTxt() {
    return {
      ch: '2', cn: '0,1,2,3', da: 'true', et: '0,3,5', vv: '2', ft: FEATURES, am: MODEL, md: '0,1,2',
      rhd: '5.6.0.0', pw: 'false', sr: '44100', ss: '16', sv: 'false', tp: 'UDP', txtvers: '1',
      sf: '0x4', vs: SOURCE_VERSION, vn: '65537', pk: this.identity.pk.toString('hex'),
    };
  }

  start() {
    if (this.server) return Promise.resolve();
    this.identity = loadIdentity(path.join(this.dir, 'airplay-identity.json'));
    const server = net.createServer((sock) => {
      sock.setNoDelay(true);
      this.conns.add(new Session(this, sock));
    });
    this.server = server;
    return new Promise((resolve) => {
      const listen = (port) => {
        server.once('error', (e) => {
          if (port && e.code === 'EADDRINUSE') return listen(0); // 7000 taken: any port (the records say which)
          this.error = e.message;
          this.server = null;
          this.emit('change');
          resolve();
        });
        server.listen(port, () => {
          this.port = server.address().port;
          this.error = '';
          const host = `twindesk-ap-${this.identity.id.replace(/:/g, '').slice(-6).toLowerCase()}`;
          this.adv = new Advertiser({
            name: this.name, host, port: this.port,
            airplayTxt: this.airplayTxt(), raopTxt: this.raopTxt(),
            raopName: `${this.identity.id.replace(/:/g, '')}@${this.name}`,
          });
          this.adv.start();
          this.emit('change');
          resolve();
        });
      };
      listen(this.wantPort);
    });
  }

  stop() {
    if (this.adv) { this.adv.stop(); this.adv = null; }
    for (const c of [...this.conns]) c.close();
    if (this.server) { try { this.server.close(); } catch (_) {} this.server = null; }
    this.port = 0;
    this.emit('change');
  }

  // Stop the one mirroring now (the window's Stop).
  end() { if (this.active) this.active.close(); }

  _claim(s) {
    if (this.active === s) return;
    // A new sender takes the screen over.
    if (this.active) this.active.close();
    this.active = s;
    this.emit('session', s.info);
    this.emit('change');
  }

  _release(s) {
    if (this.active !== s) return;
    this.active = null;
    this.emit('end');
    this.emit('change');
  }

  view() {
    return { on: !!this.server, error: this.error, port: this.port, name: this.name, session: this.active ? this.active.info : null };
  }
}

module.exports = { AirPlayReceiver };

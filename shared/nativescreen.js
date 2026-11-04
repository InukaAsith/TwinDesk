// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone's screen without wireless debugging (Mirroring › Native, shared/phonemodes.js): the
// phone captures it itself (Mirror.kt: Android's screen capture, Start tapped there once for the
// screen and its sound) and sends H.264 to this computer. A NativeScreen does what a scrcpy Session
// does for a phone window (phoneview.js): the same events ('size', 'video', 'closed') and the same
// input calls, which go to the phone as phone.in (TwinDesk's Accessibility service there applies
// them, as for the mouse and keyboard without wireless debugging: shared/phoneinput.js).
//
//   phone.mirror.want {on, key, maxSize, bitrate, fps}  computer -> phone: share it (key: a secret
//                                                       of this window, for the stream)
//   phone.mirror.want {on: true, sync: true}            a keyframe now (the window skipped frames)
//   phone.mirror.state {on, waiting, error, w, h, sw, sh}  phone -> computer: sharing, waiting for
//                                                       Start there, or why not; the picture's
//                                                       size, and the screen's (phone.in's pixels)
//   POST /twindesk/mirror (x-twindesk-mirror: key)      phone -> computer, on the session's HTTPS
//                                                       port: the picture, in scrcpy's packets
//                                                       (12-byte headers: a session packet, top
//                                                       bit set, with w and h; or pts+flags u64 and
//                                                       size u32, then the frame, Annex B)
// Never through Bluetooth: too much for it (the window says so).
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('./protocol.js');
const { PhoneInput } = require('./phoneinput.js');

const T = P.T;
const PATH = '/twindesk/mirror';
const HEADER = 'x-twindesk-mirror';
const START_MS = 120000; // how long Start on the phone may take
const MAX_FRAME = 8 * 1024 * 1024;
const ACTION = { DOWN: 0, UP: 1, MOVE: 2, HOVER_MOVE: 7, HOVER_EXIT: 10 };
const TYPE = { EXPAND_NOTIFICATIONS: 5, RESET_VIDEO: 17 }; // scrcpy's, as phoneview.js sends them
const KEYCODE_NOTIFICATION = 83;

const live = new Map(); // key -> NativeScreen, while it waits for or takes its stream

class NativeScreen extends EventEmitter {
  // server: the session's (sendToClient, current); opts: {maxSize, videoBitRate, maxFps, audio}
  constructor(server, opts = {}) {
    super();
    this.server = server;
    this.opts = opts;
    this.closed = false;
    this.key = crypto.randomBytes(16).toString('hex');
    this.size = null; // the picture's
    this.screen = null; // the phone's screen, for phone.in: {w, h}
    this.on_ = false;
    this.input = new PhoneInput((m) => this.server.sendToClient(m));
    this.req = null;
  }

  // Resolves once the phone shares its screen (after Start there), rejects if it can't.
  start() {
    const c = this.server.current;
    if (!c || c.os !== P.OS.ANDROID) return Promise.reject(err('the connection closed'));
    if (c.transport === 'ble') return Promise.reject(err('Screens need Wi-Fi: the phone is connected through Bluetooth'));
    live.set(this.key, this);
    this.server.sendToClient({
      t: T.PHONE_MIRROR_WANT, on: true, key: this.key,
      maxSize: this.opts.maxSize || 0, bitrate: this.opts.videoBitRate || 8000000, fps: this.opts.maxFps || 60,
    });
    return new Promise((resolve, reject) => {
      this._started = { resolve, reject };
      this._timer = setTimeout(() => this._fail(err('Start wasn’t tapped on the phone')), START_MS);
    });
  }

  _fail(e) {
    const s = this._started;
    this._started = null;
    clearTimeout(this._timer);
    if (s) s.reject(e);
    this._close(e.message, { messageKey: e.messageKey, messageVars: e.messageVars });
  }

  // phone.mirror.state, for this window (phone-bridge.js hands it to the open native screen).
  state(m) {
    if (this.closed) return;
    if (num(m.sw) && num(m.sh)) this.screen = { w: num(m.sw), h: num(m.sh) };
    if (m.waiting) this.emit('waiting');
    if (typeof m.error === 'string' && m.error && !m.on) return this._fail(err(m.error.slice(0, 200)));
    if (m.on) {
      this.on_ = true;
      if (this._started) {
        const s = this._started;
        this._started = null;
        clearTimeout(this._timer);
        s.resolve();
      }
    } else if (this.on_) this._close('stopped');
  }

  // The stream arrived (request()).
  _stream(req, res) {
    if (this.req) this.req.destroy(); // a newer one replaces it
    this.req = req;
    let buf = Buffer.alloc(0);
    let need = 12;
    let head = null;
    req.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= need) {
        if (!head) {
          const h = buf.subarray(0, 12);
          buf = buf.subarray(12);
          if (h[0] & 0x80) {
            const w = h.readUInt32BE(4);
            const ht = h.readUInt32BE(8);
            if (w > 0 && ht > 0 && w < 16384 && ht < 16384) {
              this.size = { width: w, height: ht };
              this.emit('size', this.size);
            }
            continue;
          }
          const size = h.readUInt32BE(8);
          if (size > MAX_FRAME) return req.destroy();
          head = { ptsFlags: h.readBigUInt64BE(0), size };
          need = size;
          continue;
        }
        const data = Buffer.from(buf.subarray(0, head.size)); // own copy: it goes to the window
        buf = buf.subarray(head.size);
        const f = head.ptsFlags;
        head = null;
        need = 12;
        this.emit('video', { config: !!(f & (1n << 62n)), key: !!(f & (1n << 61n)), pts: Number(f & ((1n << 61n) - 1n)), data });
      }
    });
    const ended = () => {
      if (this.req !== req) return;
      this.req = null;
      res.end();
    };
    req.on('end', ended);
    req.on('close', ended);
    req.on('error', () => {});
  }

  _close(why, metadata) {
    if (this.closed) return;
    this.closed = true;
    live.delete(this.key);
    clearTimeout(this._timer);
    if (this.req) this.req.destroy();
    this.req = null;
    this.emit('closed', why, metadata);
  }

  stop() {
    if (!this.closed && this.server.current && this.server.current.os === P.OS.ANDROID) this.server.sendToClient({ t: T.PHONE_MIRROR_WANT, on: false, key: this.key });
    this._close('stopped');
  }

  // ---- input (phone.in, in the phone's screen pixels) ----

  _at(x, y, w, h) {
    const s = this.screen || this.size || { w, h };
    const sw = s.w || s.width || w;
    const sh = s.h || s.height || h;
    return [x * sw / Math.max(1, w), y * sh / Math.max(1, h), sw, sh];
  }

  touch(action, pointerId, x, y, w, h) {
    if (pointerId >= 0 && pointerId !== 0) return; // a second finger (pinch): Accessibility plays one
    this.mouse(action, x, y, w, h, 1, action === ACTION.UP ? 0 : 1);
  }

  mouse(action, x, y, w, h, actionButton, buttons) {
    if (action === ACTION.HOVER_MOVE || action === ACTION.HOVER_EXIT) return;
    const [px, py, sw, sh] = this._at(x, y, w, h);
    this.input.mouse(action, px, py, sw, sh, action === ACTION.MOVE ? 0 : 1, buttons);
  }

  scroll(x, y, w, h, hs, vs) {
    const [px, py, sw, sh] = this._at(x, y, w, h);
    this.input.scroll(px, py, sw, sh, hs, vs);
  }

  key(action, keycode, meta = 0) { this.input.key(action, keycode, meta); }
  tap(keycode, meta = 0) { this.input.tap(keycode, meta); }
  backOrScreenOn(action) { this.input.backOrScreenOn(action); }
  text() {} // typing goes key by key

  simple(type) {
    if (type === TYPE.RESET_VIDEO) this.server.sendToClient({ t: T.PHONE_MIRROR_WANT, on: true, key: this.key, sync: true });
    else if (type === TYPE.EXPAND_NOTIFICATIONS) this.tap(KEYCODE_NOTIFICATION);
  }

  // What only scrcpy does: nothing here.
  setDisplayPower() {}
  resizeDisplay() {}
  startApp() {}
  setClipboard() {}

  // The stream's HTTPS request on the session's server (peer.js): true when it was one.
  static request(req, res) {
    if (!String(req.url || '').startsWith(PATH)) return false;
    const s = live.get(String(req.headers[HEADER] || ''));
    if (req.method !== 'POST' || !s || s.closed) {
      res.writeHead(403);
      res.end();
      return true;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    if (res.flushHeaders) res.flushHeaders();
    s._stream(req, res);
    return true;
  }

  // phone.mirror.state from the phone: to the window it's for (the newest asked).
  static state(m) {
    const all = [...live.values()];
    const s = all.find((x) => x.key === m.key) || all[all.length - 1];
    if (s) s.state(m);
  }

  // The session ended: every native screen with it.
  static closeAll(why = 'the connection closed') {
    for (const s of [...live.values()]) s._close(why);
  }
}

function num(v) {
  return Number.isFinite(v) && v > 0 && v < 100000 ? Math.round(v) : 0;
}

function err(messageKey, messageVars) {
  return Object.assign(new Error(messageKey), { messageKey, messageVars });
}

module.exports = { NativeScreen, PATH, HEADER };

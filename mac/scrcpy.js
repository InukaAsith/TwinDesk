// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A scrcpy-server session on the phone (scrcpy 5.0.1, Apache-2.0, vendor/scrcpy-server), spoken
// directly: push the server, forward its abstract socket, start it, then up to three sockets in
// order — video, audio, control. Several sessions may run at once (each its own scid): one
// control-only session for the mouse, keyboard and clipboard, the mirror, and one per app window
// (each on its own virtual display).
//
// Video: 64-byte device name, the codec id (u32), then 12-byte headers: a session packet
// (top bit set: flags u32, width u32, height u32) or a frame (pts+flags u64, size u32) + data.
// Audio: codec id (0 = disabled), then frames. Control: binary messages (ControlMessageReader.java);
// the phone answers with device messages (clipboard, acks).
//
// Events: 'name' (device name), 'size' ({width, height}), 'video' ({config, key, pts, data}),
//         'audioCodec' (id), 'audio' ({config, pts, data}), 'clipboard' (text), 'ready', 'closed' (why).
'use strict';

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const VERSION = '5.0.1';
const DEVICE_JAR = '/data/local/tmp/twindesk-scrcpy-server.jar';
const CODEC = { h264: 0x68323634, h265: 0x68323635, av1: 0x00617631, opus: 0x6f707573, aac: 0x00616163, flac: 0x666c6163, raw: 0x00726177 };
const TYPE = {
  INJECT_KEYCODE: 0, INJECT_TEXT: 1, INJECT_TOUCH: 2, INJECT_SCROLL: 3, BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATIONS: 5, EXPAND_SETTINGS: 6, COLLAPSE_PANELS: 7, GET_CLIPBOARD: 8, SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10, ROTATE: 11, START_APP: 16, RESET_VIDEO: 17, RESIZE_DISPLAY: 21, SCAN_FILE: 22,
};
// MotionEvent / KeyEvent actions
const ACTION = { DOWN: 0, UP: 1, MOVE: 2, HOVER_MOVE: 7 };
const POINTER_MOUSE = -1n;
const pushed = new Map(); // serial -> the push of the jar (one per run, shared by every session)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session extends EventEmitter {
  // opts: {video, audio, control, maxSize, maxFps, videoBitRate, newDisplay ('WxH/dpi'), flex, displayId,
  //        clipboardAutosync, audioSource ('output'|'playback'), powerOn, stayAwake, keepActive}
  constructor(adb, serial, opts = {}) {
    super();
    this.adb = adb;
    this.serial = serial;
    this.opts = { video: true, audio: false, control: true, ...opts };
    this.scid = (crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, '0');
    this.sockets = [];
    this.closed = false;
    this.width = 0;
    this.height = 0;
    this.seq = 1n;
    this.log = [];
  }

  async start() {
    const { adb, serial, opts } = this;
    // Two sessions starting together must not push over a jar the other is already running.
    if (!pushed.has(serial)) pushed.set(serial, adb.push(serial, adb.server, DEVICE_JAR));
    const r = await pushed.get(serial);
    if (r.code !== 0) {
      pushed.delete(serial);
      throw new Error(`Couldn’t copy the screen helper to the phone (${r.err.trim() || r.out.trim()})`);
    }
    // Each session runs its own copy: a second app_process on a jar another one is running aborts.
    this.jar = `/data/local/tmp/twindesk-scrcpy-${this.scid}.jar`;
    const cp = await adb.shell(serial, `cp ${DEVICE_JAR} ${this.jar}`, { timeout: 8000 });
    if (cp.code !== 0) throw new Error(`Couldn’t prepare the screen helper (${cp.err.trim() || cp.out.trim()})`);
    this.port = await adb.forward(serial, `scrcpy_${this.scid}`);
    // Only what differs from the server's defaults (video, audio, control, cleanup, power_on,
    // send_dummy_byte, clipboard_autosync and vd_destroy_content on; h264; audio from the output):
    // some Samsung phones (Galaxy A05, Android 15) abort in the video encoder's setup when the
    // process's command line passes 256 bytes ("stack corruption detected" in
    // CCodec::customConfigVideoEncoder), so it has to stay short.
    const args = [`scid=${this.scid}`, 'tunnel_forward=true'];
    if (!opts.video) args.push('video=false');
    if (!opts.audio) args.push('audio=false');
    else args.push('audio_codec=raw');
    if (!opts.control) args.push('control=false');
    else if (!opts.clipboardAutosync) args.push('clipboard_autosync=false');
    if (opts.video && opts.maxSize) args.push(`max_size=${opts.maxSize | 0}`);
    if (opts.video && opts.maxFps) args.push(`max_fps=${opts.maxFps}`);
    if (opts.video && opts.videoBitRate) args.push(`video_bit_rate=${opts.videoBitRate | 0}`);
    if (opts.audio && opts.audioSource && opts.audioSource !== 'output') args.push(`audio_source=${opts.audioSource}`);
    if (opts.newDisplay != null) args.push(`new_display=${opts.newDisplay}`);
    if (opts.flex) args.push('flex_display=true');
    if (opts.displayId != null) args.push(`display_id=${opts.displayId | 0}`);
    if (opts.powerOn === false) args.push('power_on=false');
    if (opts.stayAwake) args.push('stay_awake=true');
    if (opts.keepActive) args.push('keep_active=true');
    const cmd = `CLASSPATH=${this.jar} app_process / com.genymobile.scrcpy.Server ${VERSION} ${args.join(' ')}`;
    this.proc = adb.spawnShell(serial, cmd);
    const keep = (d) => {
      for (const l of String(d).split('\n')) if (l.trim()) {
        this.log.push(l.trim());
        if (this.log.length > 50) this.log.shift();
        if (/ERROR|Exception/.test(l)) console.log(`[scrcpy ${this.scid}] ${l.trim()}`);
      }
    };
    this.proc.stdout.on('data', keep);
    this.proc.stderr.on('data', keep);
    this.proc.on('exit', () => this._close('the screen helper stopped'));

    const kinds = [opts.video && 'video', opts.audio && 'audio', opts.control && 'control'].filter(Boolean);
    let first = true;
    for (const kind of kinds) {
      const sock = first ? await this._connectFirst() : await this._connect();
      first = false;
      this.sockets.push(sock);
      this[kind] = sock;
    }
    if (this.closed) throw new Error(this.why || 'closed');
    for (const s of this.sockets) s.on('close', () => this._close('the connection closed'));
    this._readStreams(kinds[0]);
    this.emit('ready');
  }

  // adb accepts the forward before the server listens: retry until the dummy byte arrives.
  async _connectFirst() {
    for (let i = 0; i < 100 && !this.closed; i++) {
      const s = await this._connect().catch(() => null);
      if (s) {
        const ok = await new Promise((resolve) => {
          // Paused, so nothing that follows the dummy byte is lost before _reader takes over.
          const done = (v) => { s.pause(); s.removeAllListeners('data'); s.removeAllListeners('close'); resolve(v); };
          s.once('data', (d) => {
            if (d.length > 1) s.unshift(d.subarray(1));
            done(true);
          });
          s.once('close', () => done(false));
        });
        if (ok) return s;
        s.destroy();
      }
      await sleep(100);
    }
    throw new Error(this.why || `The phone’s screen helper didn’t start${this.log.length ? ` (${this.log[this.log.length - 1]})` : ''}`);
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port: this.port });
      s.setNoDelay(true);
      s.once('connect', () => { s.removeListener('error', reject); s.on('error', () => {}); resolve(s); });
      s.once('error', reject);
    });
  }

  // Byte readers: each socket feeds a small buffer, and an async loop takes exact lengths.
  _reader(sock) {
    let buf = Buffer.alloc(0);
    let want = null;
    sock.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      if (want && buf.length >= want.n) {
        const w = want;
        want = null;
        const out = buf.subarray(0, w.n);
        buf = buf.subarray(w.n);
        w.resolve(out);
      }
    });
    sock.on('close', () => want && want.reject(new Error('closed')));
    sock.resume();
    return (n) => new Promise((resolve, reject) => {
      if (buf.length >= n) {
        const out = buf.subarray(0, n);
        buf = buf.subarray(n);
        return resolve(out);
      }
      want = { n, resolve, reject };
    });
  }

  async _readStreams(firstKind) {
    const loops = [];
    if (this.video) {
      const read = this._reader(this.video);
      loops.push((async () => {
        if (firstKind === 'video') this.emit('name', (await read(64)).toString('utf8').replace(/\0.*$/s, ''));
        const codec = (await read(4)).readUInt32BE(0);
        if (codec !== CODEC.h264) throw new Error(codec <= 1 ? 'The phone can’t share its screen' : `Unexpected video codec ${codec.toString(16)}`);
        for (;;) {
          const h = await read(12);
          if (h[0] & 0x80) {
            this.width = h.readUInt32BE(4);
            this.height = h.readUInt32BE(8);
            this.emit('size', { width: this.width, height: this.height });
            continue;
          }
          const ptsFlags = h.readBigUInt64BE(0);
          const size = h.readUInt32BE(8);
          const data = Buffer.from(await read(size)); // own copy: it goes to the window
          this.emit('video', {
            config: !!(ptsFlags & (1n << 62n)), key: !!(ptsFlags & (1n << 61n)),
            pts: Number(ptsFlags & ((1n << 61n) - 1n)), data,
          });
        }
      })());
    }
    if (this.audio) {
      const read = this._reader(this.audio);
      loops.push((async () => {
        if (firstKind === 'audio') this.emit('name', (await read(64)).toString('utf8').replace(/\0.*$/s, ''));
        const codec = (await read(4)).readUInt32BE(0);
        this.emit('audioCodec', codec);
        if (codec <= 1) return; // the phone can't capture its sound (Android 11+ only)
        for (;;) {
          const h = await read(12);
          const ptsFlags = h.readBigUInt64BE(0);
          const size = h.readUInt32BE(8);
          const data = Buffer.from(await read(size));
          this.emit('audio', { config: !!(ptsFlags & (1n << 62n)), pts: Number(ptsFlags & ((1n << 61n) - 1n)), data });
        }
      })());
    }
    if (this.control) {
      const read = this._reader(this.control);
      loops.push((async () => {
        if (firstKind === 'control') this.emit('name', (await read(64)).toString('utf8').replace(/\0.*$/s, ''));
        for (;;) {
          const type = (await read(1))[0];
          if (type === 0) {
            const len = (await read(4)).readUInt32BE(0);
            this.emit('clipboard', (await read(len)).toString('utf8'));
          } else if (type === 1) {
            await read(8); // ack of a SET_CLIPBOARD sequence
          } else if (type === 2) {
            await read(2);
            const len = (await read(2)).readUInt16BE(0);
            await read(len);
          } else throw new Error(`Unknown device message ${type}`);
        }
      })());
    }
    for (const l of loops) l.catch((e) => this._close(e.message));
  }

  _close(why) {
    if (this.closed) return;
    this.closed = true;
    this.why = why;
    for (const s of this.sockets) s.destroy();
    if (this.proc) try { this.proc.kill(); } catch {}
    if (this.port) this.adb.unforward(this.serial, this.port);
    if (this.jar) this.adb.shell(this.serial, `rm -f ${this.jar}`, { timeout: 5000 });
    this.emit('closed', why);
  }

  stop() {
    this._close('stopped');
  }

  // ---- control messages ----

  _send(buf) {
    if (this.control && !this.closed) this.control.write(buf);
  }

  // A touch or mouse event at (x, y) on a w×h frame (the video size, or the display when there is
  // no video). pointerId: -1 = the mouse, ≥ 0 = fingers. buttons: MotionEvent.BUTTON_* bits.
  touch(action, pointerId, x, y, w, h, pressure = 1, actionButton = 0, buttons = 0) {
    const b = Buffer.alloc(32);
    b[0] = TYPE.INJECT_TOUCH;
    b[1] = action;
    b.writeBigInt64BE(BigInt(pointerId), 2);
    b.writeInt32BE(Math.round(x), 10);
    b.writeInt32BE(Math.round(y), 14);
    b.writeUInt16BE(w & 0xffff, 18);
    b.writeUInt16BE(h & 0xffff, 20);
    b.writeUInt16BE(pressure >= 1 ? 0xffff : Math.max(0, Math.round(pressure * 0x10000)), 22);
    b.writeInt32BE(actionButton, 24);
    b.writeInt32BE(buttons, 28);
    this._send(b);
  }

  mouse(action, x, y, w, h, actionButton, buttons) {
    this.touch(action, Number(POINTER_MOUSE), x, y, w, h, buttons ? 1 : 0, actionButton, buttons);
  }

  // hs, vs: notches, -16…16 (+vs = up, +hs = right).
  scroll(x, y, w, h, hs, vs, buttons = 0) {
    const fx = (v) => Math.max(-0x8000, Math.min(0x7fff, Math.round(Math.max(-1, Math.min(1, v / 16)) * 0x8000)));
    const b = Buffer.alloc(21);
    b[0] = TYPE.INJECT_SCROLL;
    b.writeInt32BE(Math.round(x), 1);
    b.writeInt32BE(Math.round(y), 5);
    b.writeUInt16BE(w & 0xffff, 9);
    b.writeUInt16BE(h & 0xffff, 11);
    b.writeInt16BE(fx(hs), 13);
    b.writeInt16BE(fx(vs), 15);
    b.writeInt32BE(buttons, 17);
    this._send(b);
  }

  key(action, keycode, metaState = 0, repeat = 0) {
    const b = Buffer.alloc(14);
    b[0] = TYPE.INJECT_KEYCODE;
    b[1] = action;
    b.writeInt32BE(keycode, 2);
    b.writeInt32BE(repeat, 6);
    b.writeInt32BE(metaState, 10);
    this._send(b);
  }

  tap(keycode, metaState = 0) {
    this.key(ACTION.DOWN, keycode, metaState);
    this.key(ACTION.UP, keycode, metaState);
  }

  text(str) {
    const t = Buffer.from(String(str).slice(0, 300), 'utf8');
    const b = Buffer.alloc(5 + t.length);
    b[0] = TYPE.INJECT_TEXT;
    b.writeUInt32BE(t.length, 1);
    t.copy(b, 5);
    this._send(b);
  }

  backOrScreenOn(action) {
    this._send(Buffer.from([TYPE.BACK_OR_SCREEN_ON, action]));
  }

  setClipboard(text, paste = false) {
    const t = Buffer.from(String(text), 'utf8');
    if (t.length > (1 << 18) - 14) return;
    const b = Buffer.alloc(14 + t.length);
    b[0] = TYPE.SET_CLIPBOARD;
    b.writeBigInt64BE(this.seq++, 1);
    b[9] = paste ? 1 : 0;
    b.writeUInt32BE(t.length, 10);
    t.copy(b, 14);
    this._send(b);
  }

  getClipboard() {
    this._send(Buffer.from([TYPE.GET_CLIPBOARD, 0]));
  }

  startApp(name) {
    const t = Buffer.from(String(name), 'utf8').subarray(0, 255);
    this._send(Buffer.concat([Buffer.from([TYPE.START_APP, t.length]), t]));
  }

  resizeDisplay(w, h) {
    const b = Buffer.alloc(5);
    b[0] = TYPE.RESIZE_DISPLAY;
    b.writeUInt16BE(Math.max(1, Math.min(0xffff, w | 0)), 1);
    b.writeUInt16BE(Math.max(1, Math.min(0xffff, h | 0)), 3);
    this._send(b);
  }

  simple(type) {
    this._send(Buffer.from([type]));
  }

  setDisplayPower(on) {
    this._send(Buffer.from([TYPE.SET_DISPLAY_POWER, on ? 1 : 0]));
  }

  scanFile(path) {
    const t = Buffer.from(String(path), 'utf8');
    const b = Buffer.alloc(5 + t.length);
    b[0] = TYPE.SCAN_FILE;
    b.writeUInt32BE(t.length, 1);
    t.copy(b, 5);
    this._send(b);
  }
}

module.exports = { Session, TYPE, ACTION, CODEC };

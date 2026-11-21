// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A scrcpy-server session on the phone (scrcpy 5.0.1, Apache-2.0, vendor/scrcpy-server), spoken
// directly: push the server, forward its abstract socket, start it, then up to three sockets in
// order — video, audio, control. Several sessions may run at once (each its own scid): one
// control-only session for the mouse, keyboard and clipboard, the mirror, and one per app window
// (each on its own virtual display). Copy of mac/scrcpy.js.
//
// Video: 64-byte device name, the codec id (u32), then 12-byte headers: a session packet
// (top bit set: flags u32, width u32, height u32) or a frame (pts+flags u64, size u32) + data.
// Audio: codec id (0 = disabled), then frames. Control: binary messages (ControlMessageReader.java);
// the phone answers with device messages (clipboard, acks).
//
// Events: 'name' (device name), 'size' ({width, height}), 'video' ({config, key, pts, data}),
//         'audioCodec' (id), 'audio' ({config, pts, data}), 'clipboard' (text), 'ready', 'closed' (why).
//
// Skip adbd (opts.direct, Mirroring's setting, off by default): over wireless debugging the sockets
// don't go through adb's forward but through a small relay on the phone (native/adb-relay, started
// by adb as the shell user beside the server) straight over the Wi-Fi, AES-GCM with a key given to
// it over adb. If the relay can't start or can't be reached (a VPN, client isolation), the session
// falls back to adb's forward on its own. Over USB it always uses the forward.
// Low latency (opts.lowLatency): the encoder holds at most one frame and runs at realtime priority.
'use strict';

const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Duplex } = require('stream');
const { EventEmitter } = require('events');

const VERSION = '5.0.1';
const DEVICE_JAR = '/data/local/tmp/twindesk-scrcpy-server.jar';
const RELAY_JAR = '/data/local/tmp/twindesk-relay.jar';
const CODEC = { h264: 0x68323634, h265: 0x68323635, av1: 0x00617631, opus: 0x6f707573, aac: 0x00616163, flac: 0x666c6163, raw: 0x00726177 };
const TYPE = {
  INJECT_KEYCODE: 0, INJECT_TEXT: 1, INJECT_TOUCH: 2, INJECT_SCROLL: 3, BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATIONS: 5, EXPAND_SETTINGS: 6, COLLAPSE_PANELS: 7, GET_CLIPBOARD: 8, SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10, ROTATE: 11, UHID_CREATE: 12, UHID_INPUT: 13, UHID_DESTROY: 14, START_APP: 16, RESET_VIDEO: 17, RESIZE_DISPLAY: 21, SCAN_FILE: 22,
  CAMERA_SET_TORCH: 18, CAMERA_ZOOM_IN: 19, CAMERA_ZOOM_OUT: 20, // scrcpy 5.0.1's ControlMessage
};
// MotionEvent / KeyEvent actions
const ACTION = { DOWN: 0, UP: 1, MOVE: 2, HOVER_MOVE: 7, HOVER_EXIT: 10 };
const POINTER_MOUSE = -1n;
const pushed = new Map(); // serial -> the push of the jar (one per run, shared by every session)
const relayPushed = new Map(); // serial -> the push of the relay
// Only a phone on wireless debugging (adb connect's "1.2.3.4:5555") has an address to reach directly.
const directHost = (serial) => { const m = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(String(serial)); return m ? m[1] : null; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const localError = (messageKey, messageVars = {}) => Object.assign(
  new Error(messageKey.replace(/\{(\w+)\}/g, (match, key) => Object.prototype.hasOwnProperty.call(messageVars, key) ? String(messageVars[key]) : match)),
  { messageKey, messageVars });

class Session extends EventEmitter {
  // opts: {video, audio, control, maxSize, maxFps, videoBitRate, newDisplay ('WxH/dpi'), flex, displayId,
  //        clipboardAutosync, audioSource ('output'|'playback'), powerOn, stayAwake, keepActive,
  //        direct (skip adbd), lowLatency}
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
    this.videoStarted = false;
    this.pendingResize = null;
  }

  async start() {
    const { adb, serial, opts } = this;
    const checkOpen = () => {
      if (!this.closed) return;
      this._stopRelay();
      if (this.port) adb.unforward(serial, this.port);
      if (this.jar) adb.shell(serial, `rm -f ${this.jar}`, { timeout: 5000 });
      throw localError('closed');
    };
    checkOpen();
    // Two sessions starting together must not push over a jar the other is already running.
    if (!pushed.has(serial)) pushed.set(serial, adb.push(serial, adb.server, DEVICE_JAR));
    const r = await pushed.get(serial);
    checkOpen();
    if (r.code !== 0) {
      pushed.delete(serial);
      throw localError('Couldn’t copy the screen helper to the phone ({error})', { error: r.err.trim() || r.out.trim() });
    }
    // Each session runs its own copy: a second app_process on a jar another one is running aborts.
    this.jar = `/data/local/tmp/twindesk-scrcpy-${this.scid}.jar`;
    const cp = await adb.shell(serial, `cp ${DEVICE_JAR} ${this.jar}`, { timeout: 8000 });
    checkOpen();
    if (cp.code !== 0) throw localError('Couldn’t prepare the screen helper ({error})', { error: cp.err.trim() || cp.out.trim() });
    const kinds = [opts.video && 'video', opts.audio && 'audio', opts.control && 'control'].filter(Boolean);
    const host = opts.direct && directHost(serial);
    if (host) {
      this.direct = await this._startRelay(host, kinds.length).catch((e) => {
        console.log(`[scrcpy ${this.scid}] relay: ${e.message}; through adb's forward`);
        this._stopRelay();
        return null;
      });
    }
    checkOpen();
    if (!this.direct) this.port = await adb.forward(serial, `scrcpy_${this.scid}`);
    checkOpen();
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
    // KEY_LATENCY 1: the encoder hands each frame out before taking the next; KEY_PRIORITY 0: realtime.
    if (opts.video && opts.lowLatency) args.push('video_codec_options=latency=1,priority=0');
    if (opts.audio && opts.audioSource && opts.audioSource !== 'output') args.push(`audio_source=${opts.audioSource}`);
    // An app's own display: no Android taskbar or status bar on it, only the app (the window has Back).
    if (opts.newDisplay != null) args.push(`new_display=${opts.newDisplay}`, 'vd_system_decorations=false');
    if (opts.flex) args.push('flex_display=true');
    if (opts.displayId != null) args.push(`display_id=${opts.displayId | 0}`);
    if (opts.powerOn === false) args.push('power_on=false');
    if (opts.stayAwake) args.push('stay_awake=true');
    if (opts.keepActive) args.push('keep_active=true');
    if (opts.videoSource && opts.videoSource !== 'display') args.push(`video_source=${opts.videoSource}`);
    if (opts.cameraFacing) args.push(`camera_facing=${opts.cameraFacing}`);
    if (opts.cameraId != null) args.push(`camera_id=${opts.cameraId}`);
    if (opts.cameraSize) args.push(`camera_size=${opts.cameraSize}`);
    if (opts.cameraFps) args.push(`camera_fps=${opts.cameraFps | 0}`);
    if (opts.cameraHighSpeed) args.push('camera_high_speed=true');
    if (opts.cameraAspectRatio) args.push(`camera_ar=${opts.cameraAspectRatio}`);
    if (opts.cameraTorch) args.push('camera_torch=true');
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
    this.proc.on('exit', () => this._close('the screen helper stopped', { messageKey: 'the screen helper stopped', messageVars: {} }));

    let first = true;
    for (const kind of kinds) {
      const sock = first ? await this._connectFirst() : await this._connect();
      if (this.closed) sock.destroy();
      checkOpen();
      first = false;
      this.sockets.push(sock);
      this[kind] = sock;
    }
    if (this.closed) throw this.why ? Object.assign(new Error(this.why), this.closeMeta) : localError('closed');
    for (const s of this.sockets) s.on('close', () => this._close('the connection closed', { messageKey: 'the connection closed', messageVars: {} }));
    this._readStreams(kinds[0]);
    this.emit('ready');
  }

  // The relay on the phone (Skip adbd): pushed once per run, then started with the session's key on
  // its stdin; resolves to {host, port, key} once it listens.
  async _startRelay(host, count) {
    const { adb, serial } = this;
    const fs = require('fs');
    const local = [adb.server && path.join(path.dirname(adb.server), 'twindesk-relay.jar'), path.join(__dirname, 'vendor', 'twindesk-relay.jar'),
      path.join(__dirname, '..', 'mac', 'vendor', 'twindesk-relay.jar')].find((p) => p && fs.existsSync(p));
    if (!local) throw new Error('no relay in this build');
    if (!relayPushed.has(serial)) relayPushed.set(serial, adb.push(serial, local, RELAY_JAR));
    const r = await relayPushed.get(serial);
    if (r.code !== 0) { relayPushed.delete(serial); throw new Error(`push: ${(r.err || r.out).trim()}`); }
    const key = crypto.randomBytes(16);
    const p = this.relay = spawn(adb.bin, ['-s', serial, 'shell', `CLASSPATH=${RELAY_JAR} app_process / com.twindesk.relay.Relay scrcpy_${this.scid} ${count}`],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    p.on('error', () => {});
    p.stdin.on('error', () => {});
    p.stdin.write(key.toString('hex') + '\n'); // stdin stays open: when it closes the relay ends
    return new Promise((resolve, reject) => {
      let out = '';
      const t = setTimeout(() => reject(new Error('it didn’t start')), 6000);
      p.stdout.on('data', (d) => {
        out += d;
        const m = /TDRELAY (\d+)/.exec(out);
        if (m) { clearTimeout(t); resolve({ host, port: Number(m[1]), key }); }
      });
      p.stderr.on('data', (d) => { if (/ERROR|Exception/.test(String(d))) console.log(`[scrcpy ${this.scid}] relay: ${String(d).trim()}`); });
      p.on('exit', () => { clearTimeout(t); reject(new Error('it stopped')); });
    });
  }

  _stopRelay() {
    if (!this.relay) return;
    try { this.relay.stdin.end(); } catch {}
    try { this.relay.kill(); } catch {}
    this.relay = null;
  }

  // adb accepts the forward before the server listens: retry until the dummy byte arrives.
  async _connectFirst() {
    let unreachable = 0;
    for (let i = 0; i < 100 && !this.closed; i++) {
      const s = await this._connect().catch(async (e) => {
        // The relay can't be reached at all (not just the server not listening yet): adb's forward.
        if (this.direct && e.unreachable && ++unreachable >= 2) {
          console.log(`[scrcpy ${this.scid}] relay unreachable (${e.message}); through adb's forward`);
          this.direct = null;
          this._stopRelay();
          this.port = await this.adb.forward(this.serial, `scrcpy_${this.scid}`).catch(() => null);
        }
        return null;
      });
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
    if (this.why) throw Object.assign(new Error(this.why), this.closeMeta);
    throw this.log.length ? localError('The phone’s screen helper didn’t start ({error})', { error: this.log[this.log.length - 1] }) : localError('The phone’s screen helper didn’t start');
  }

  _connect() {
    if (this.direct) return connectSealed(this.direct);
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
    sock.on('close', () => want && want.reject(localError('closed')));
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
        if (codec !== CODEC.h264) throw codec <= 1 ? localError('The phone can’t share its screen') : localError('Unexpected video codec {codec}', { codec: codec.toString(16) });
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
          const config = !!(ptsFlags & (1n << 62n));
          if (!config && !this.videoStarted) {
            this.videoStarted = true;
            const pending = this.pendingResize;
            this.pendingResize = null;
            if (pending) this.resizeDisplay(...pending);
          }
          this.emit('video', {
            config, key: !!(ptsFlags & (1n << 61n)),
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
          } else throw localError('Unknown device message {type}', { type });
        }
      })());
    }
    for (const l of loops) l.catch((e) => this._close(e.message, e.messageKey ? { messageKey: e.messageKey, messageVars: e.messageVars } : undefined));
  }

  _close(why, metadata) {
    if (this.closed) return;
    this.closed = true;
    this.pendingResize = null;
    this.why = why;
    this.closeMeta = metadata;
    for (const s of this.sockets) s.destroy();
    if (this.proc) try { this.proc.kill(); } catch {}
    this._stopRelay();
    if (this.port) this.adb.unforward(this.serial, this.port);
    if (this.jar) this.adb.shell(this.serial, `rm -f ${this.jar}`, { timeout: 5000 });
    this.emit('closed', why, metadata);
  }

  stop() {
    this._close('stopped', { messageKey: 'stopped', messageVars: {} });
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

  // A HID device on the phone (/dev/uhid; shared/uhidkbd.js): made once, then its input reports.
  uhidCreate(id, vendorId, productId, name, descriptor) {
    const n = Buffer.from(String(name), 'utf8').subarray(0, 127);
    const b = Buffer.alloc(1 + 2 + 2 + 2 + 1 + n.length + 2 + descriptor.length);
    let o = 0;
    b[o++] = TYPE.UHID_CREATE;
    b.writeUInt16BE(id, o); o += 2;
    b.writeUInt16BE(vendorId, o); o += 2;
    b.writeUInt16BE(productId, o); o += 2;
    b[o++] = n.length; n.copy(b, o); o += n.length;
    b.writeUInt16BE(descriptor.length, o); o += 2;
    descriptor.copy(b, o);
    this._send(b);
  }

  uhidInput(id, data) {
    const b = Buffer.alloc(5 + data.length);
    b[0] = TYPE.UHID_INPUT;
    b.writeUInt16BE(id, 1);
    b.writeUInt16BE(data.length, 3);
    data.copy(b, 5);
    this._send(b);
  }

  uhidDestroy(id) {
    const b = Buffer.alloc(3);
    b[0] = TYPE.UHID_DESTROY;
    b.writeUInt16BE(id, 1);
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
    if (this.closed) return;
    // Flex resize can arrive from the Mac's ResizeObserver before scrcpy initializes its encoder.
    if (this.opts.newDisplay && !this.videoStarted) {
      this.pendingResize = [w, h];
      return;
    }
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

  setTorch(on) {
    this._send(Buffer.from([TYPE.CAMERA_SET_TORCH, on ? 1 : 0]));
  }

  zoomIn() {
    this.simple(TYPE.CAMERA_ZOOM_IN);
  }

  zoomOut() {
    this.simple(TYPE.CAMERA_ZOOM_OUT);
  }

  // Discovers all available cameras and supported sizes on the phone.
  static async listCameras(adb, serial) {
    if (!pushed.has(serial)) pushed.set(serial, adb.push(serial, adb.server, DEVICE_JAR));
    await pushed.get(serial);
    const r = await adb.shell(serial, `CLASSPATH=${DEVICE_JAR} app_process / com.genymobile.scrcpy.Server ${VERSION} list_cameras=true`, { timeout: 10000 });
    const text = (r.out || '') + '\n' + (r.err || '');
    return Session.parseCameras(text);
  }

  // scrcpy's list_cameras: a line per camera, "--camera-id=0    (back, 4000x3000, fps=[15, 30])".
  static parseCameras(text) {
    const list = [];
    for (const l of String(text || '').split('\n')) {
      const id = /--camera-id=(\S+)/.exec(l);
      if (!id) continue;
      const facing = /\((back|front|external)\b/i.exec(l);
      list.push({ id: id[1], facing: facing ? facing[1].toLowerCase() : 'back', sizes: l.match(/\b\d{2,5}x\d{2,5}\b/g) || [] });
    }
    return list;
  }
}

// A socket to the phone's relay (Skip adbd), as a Duplex of the plain bytes: the relay's salt first,
// then sealed frames each way (native/adb-relay/Relay.java). Rejects with e.unreachable when the
// relay can't be reached; a connection the relay closes later (the server not listening yet) just
// ends, as a forward's does.
class Sealed extends Duplex {
  constructor(tcp, key) {
    super();
    this.tcp = tcp;
    this.key = key;
    this.tx = 0n;
    this.rx = 0n;
  }

  static nonce(dir, n) {
    const b = Buffer.alloc(12);
    b[0] = dir;
    b.writeBigUInt64BE(n, 4);
    return b;
  }

  seal(p) {
    const c = crypto.createCipheriv('aes-128-gcm', this.key, Sealed.nonce(0, this.tx++));
    const ct = Buffer.concat([c.update(p), c.final(), c.getAuthTag()]);
    const h = Buffer.alloc(4);
    h.writeUInt32BE(ct.length, 0);
    return Buffer.concat([h, ct]);
  }

  open(ct) {
    const d = crypto.createDecipheriv('aes-128-gcm', this.key, Sealed.nonce(1, this.rx++));
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  }

  setNoDelay() {}

  _write(chunk, enc, cb) {
    for (let o = 0; o < chunk.length; o += 256 * 1024) this.tcp.write(this.seal(chunk.subarray(o, o + 256 * 1024)));
    cb();
  }

  _read() {}

  _destroy(err, cb) {
    this.tcp.destroy();
    cb(err);
  }
}

function connectSealed({ host, port, key }) {
  return new Promise((resolve, reject) => {
    const tcp = net.connect({ host, port });
    tcp.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let s = null;
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tcp.destroy();
      reject(Object.assign(e, { unreachable: true }));
    };
    const timer = setTimeout(() => fail(new Error('timed out')), 3000);
    tcp.on('error', (e) => (settled ? s && s.destroy() : fail(e)));
    tcp.on('close', () => {
      if (!settled) return fail(new Error('closed'));
      if (s && !s.destroyed) { s.push(null); s.destroy(); }
    });
    tcp.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      if (!s) {
        if (buf.length < 16) return;
        const k = crypto.createHmac('sha256', key).update(buf.subarray(0, 16)).digest().subarray(0, 16);
        buf = buf.subarray(16);
        s = new Sealed(tcp, k);
        settled = true;
        clearTimeout(timer);
        tcp.write(s.seal(Buffer.from('TDR1')));
        resolve(s);
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const ct = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        let p;
        try { p = s.open(ct); } catch { return void s.destroy(); }
        s.push(p);
      }
    });
  });
}

module.exports = { Session, TYPE, ACTION, CODEC, connectSealed };

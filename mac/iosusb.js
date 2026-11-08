// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// An iPhone's or iPad's screen over its USB cable (mac-helper's macshare-iosusb: macOS offers a
// cabled, trusted iOS device as a capture device, as QuickTime uses it). No app needed on it, no
// Start to tap, and the full picture at 60 fps. An IosUsbScreen does for a phone window
// (phoneview.js) what a scrcpy Session or a NativeScreen does: 'size', 'video', 'closed', start(),
// stop(); input calls do nothing (iOS takes none from a computer).
'use strict';

const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const BIN = path.join(__dirname, '..', 'mac-helper', '.build', 'release', 'macshare-iosusb');
const MAX_FRAME = 8 * 1024 * 1024;

// The iOS devices on a cable now: [{id, name, model}] (about 2 s: they show up a moment after asking).
function list() {
  return new Promise((resolve) => {
    execFile(BIN, ['list'], { timeout: 8000 }, (err, out) => {
      if (err) return resolve([]);
      try {
        const a = JSON.parse(String(out).trim() || '[]');
        resolve(Array.isArray(a) ? a.filter((d) => d && typeof d.id === 'string').map((d) => ({ id: d.id, name: String(d.name || 'iPhone').slice(0, 80), model: String(d.model || '').slice(0, 40) })) : []);
      } catch {
        resolve([]);
      }
    });
  });
}

class IosUsbScreen extends EventEmitter {
  // opts: {id (a device's, or '' for the first), maxSize, videoBitRate}
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.closed = false;
    this.size = null;
    this.proc = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const p = spawn(BIN, ['capture', this.opts.id || '', String(this.opts.maxSize || 0), String(this.opts.videoBitRate || 12000000)], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = p;
      let started = false;
      let errLine = '';
      let ebuf = '';
      p.stderr.on('data', (c) => {
        ebuf += c;
        let i;
        while ((i = ebuf.indexOf('\n')) >= 0) {
          const line = ebuf.slice(0, i);
          ebuf = ebuf.slice(i + 1);
          let m = null;
          try { m = JSON.parse(line); } catch { console.log(`[iosusb] ${line}`); continue; }
          if (m.event === 'started') { started = true; resolve(); }
          else if (m.event === 'error') errLine = String(m.message || '').slice(0, 200);
          else if (m.event === 'ended') this._close(m.why === 'unplugged' ? 'The cable came out' : 'stopped');
        }
      });
      this._read(p.stdout);
      p.on('error', (e) => { if (!started) reject(new Error(e.message)); this._close(e.message); });
      p.on('exit', (code) => {
        if (!started) reject(Object.assign(new Error(errLine || `the screen capture stopped (${code})`), { messageKey: errLine || undefined }));
        this._close(errLine || 'stopped');
      });
    });
  }

  // scrcpy's packets, as shared/nativescreen.js reads them.
  _read(stream) {
    let buf = Buffer.alloc(0);
    let need = 12;
    let head = null;
    stream.on('data', (chunk) => {
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
          if (size > MAX_FRAME) return this.stop();
          head = { ptsFlags: h.readBigUInt64BE(0), size };
          need = size;
          continue;
        }
        const data = Buffer.from(buf.subarray(0, head.size));
        buf = buf.subarray(head.size);
        const f = head.ptsFlags;
        head = null;
        need = 12;
        this.emit('video', { config: !!(f & (1n << 62n)), key: !!(f & (1n << 61n)), pts: Number(f & ((1n << 61n) - 1n)), data });
      }
    });
  }

  _close(why) {
    if (this.closed) return;
    this.closed = true;
    try { this.proc && this.proc.stdin.end(); } catch {}
    const p = this.proc;
    setTimeout(() => { try { p && p.kill(); } catch {} }, 1000);
    this.emit('closed', why);
  }

  stop() { this._close('stopped'); }

  // A phone window's input and scrcpy's extras: nothing for iOS.
  touch() {}
  mouse() {}
  scroll() {}
  key() {}
  tap() {}
  backOrScreenOn() {}
  text() {}
  simple() {}
  setDisplayPower() {}
  resizeDisplay() {}
  startApp() {}
  setClipboard() {}
}

module.exports = { IosUsbScreen, list, BIN };

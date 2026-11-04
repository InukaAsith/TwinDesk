// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Spawns windows-helper and talks JSON lines with it (same shape as mac/helper.js).
//   request(cmd, args, ms) -> Promise<reply>   (has an id, waits ms (3 s) for {"id","ok"})
//   send(cmd, args)                        (fire-and-forget)
// Events: 'event' (name, msg) for {"event":...} lines; 'ready' after each start; 'exit' (code).
// The helper is restarted after it exits, unless stop() was called.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const EXE = path.join(__dirname, '..', 'windows-helper', 'bin', 'macshare-winhelper.exe');
const RESTART_MS = 1000;
const REQUEST_MS = 3000;

class Helper extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.stopped = false;
    this.error = '';
    this.lowLat = new Set(); // why Wi-Fi low-latency mode is on (Wlan.cs): 'kvm', 'screen'
    this.on('ready', () => { if (this.lowLat.size) this.send('wifiLowLatency', { on: true }); }); // a restarted helper forgot it
  }

  // Wi-Fi low-latency mode (Wlan.cs: media streaming on, background scans off) while any reason
  // wants it: the cursor shared, a screen shown.
  lowLatency(reason, on) {
    const was = this.lowLat.size > 0;
    if (on) this.lowLat.add(reason);
    else this.lowLat.delete(reason);
    const now = this.lowLat.size > 0;
    if (now !== was) this.send('wifiLowLatency', { on: now });
  }

  start() {
    this.stopped = false;
    if (this.proc) return;
    if (!fs.existsSync(EXE)) {
      this.error = 'Helper not built (run npm run build:helper)';
      this.emit('exit', -1);
      return;
    }
    // Windows can refuse to start it at all (Smart App Control blocks an unsigned helper: spawn
    // throws UNKNOWN). The rest of the app goes on without it; asking again only brings the block back.
    let proc;
    try {
      proc = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      this._blocked(e);
      return;
    }
    if (!proc.pid) { // failed: 'error' follows, and no 'exit'
      proc.on('error', (e) => this._blocked(e));
      return;
    }
    this.proc = proc;
    this.buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => this._data(d));
    proc.stderr.on('data', (d) => console.warn('[helper]', String(d).trim()));
    proc.stdin.on('error', () => {}); // EPIPE while it exits
    proc.on('error', (e) => { this.error = e.message; });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const p of this.pending.values()) p.reject(new Error('helper exited'));
      this.pending.clear();
      this.emit('exit', code);
      if (!this.stopped) setTimeout(() => !this.stopped && this.start(), RESTART_MS);
    });
  }

  _blocked(e) {
    this.error = 'Windows blocked the helper (' + (e.code || e.message) + '). Smart App Control blocks unsigned builds.';
    console.warn('[helper] not started:', e.message);
    this.emit('exit', -1);
  }

  stop() {
    this.stopped = true;
    if (this.proc) this.proc.stdin.end(); // EOF: the helper releases everything and exits
  }

  get running() {
    return !!this.proc;
  }

  _data(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.event === 'ready') {
        this.error = '';
        this.emit('ready');
      } else if (msg.event) {
        this.emit('event', msg.event, msg);
      } else if (this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg); else p.reject(new Error(msg.error || 'failed'));
      }
    }
  }

  _write(obj) {
    if (!this.proc) return false;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  // send('inject', {ev: {t: 'k.mm', dx, dy}}) as one string: no objects to build and walk for each
  // summed move. The same line JSON.stringify makes (shared/test/helper-move.js).
  sendMove(dx, dy) {
    if (!this.proc) return false;
    this.proc.stdin.write('{"ev":{"t":"k.mm","dx":' + (Number.isFinite(dx) ? dx : 0) + ',"dy":' + (Number.isFinite(dy) ? dy : 0) + '},"cmd":"inject"}\n');
    return true;
  }

  send(cmd, args = {}) {
    return this._write({ ...args, cmd });
  }

  request(cmd, args = {}, ms = REQUEST_MS) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      if (!this._write({ ...args, cmd, id })) return reject(new Error('helper not running'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('helper: ' + cmd + ' timed out'));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
    });
  }
}

Helper.EXE = EXE;
module.exports = Helper;

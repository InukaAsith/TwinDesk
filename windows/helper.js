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

const EXE = path.join(__dirname, '..', 'windows-helper', 'bin', 'twindesk-mesh-winhelper.exe');
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
  }

  start() {
    this.stopped = false;
    if (this.proc) return;
    if (!fs.existsSync(EXE)) {
      this.error = 'Helper not built (run npm run build:helper)';
      this.emit('exit', -1);
      return;
    }
    const proc = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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

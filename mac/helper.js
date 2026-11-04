// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Spawns mac-helper and talks JSON lines with it.
//   request(cmd, args) -> Promise<reply>   (has an id, waits for {"id","ok"})
//   send(cmd, args)                        (fire-and-forget, no id)
// Events: 'event' (name, obj) for {"event":...} lines; 'exit' (code); 'ready' after each spawn;
//         'pcm' (Buffer) — raw system audio from fd 3 (48 kHz stereo float32, see Audio.swift).
'use strict';

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const BIN = path.join(__dirname, '..', 'mac-helper', '.build', 'release', 'macshare-helper');
const REQUEST_TIMEOUT_MS = 10000;

class Helper extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.stopping = false;
  }

  get running() {
    return !!this.proc;
  }

  start() {
    if (this.proc) return true;
    if (!fs.existsSync(BIN)) {
      console.error(`[helper] ${BIN} not found — run "npm run build:helper"`);
      return false;
    }
    const proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    proc.stdio[3].on('data', (buf) => this.emit('pcm', buf));
    proc.stdio[3].on('error', () => {});
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this._onLine(line));
    readline.createInterface({ input: proc.stderr }).on('line', (line) => console.log(line));
    proc.stdin.on('error', () => {}); // EPIPE when the helper died; 'exit' handles it
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('helper exited'));
      }
      this.pending.clear();
      if (!this.stopping) console.error(`[helper] exited (${signal || code})`);
      this.emit('exit', code);
    });
    proc.on('error', (err) => console.error(`[helper] spawn failed: ${err.message}`));
    this.emit('ready');
    return true;
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`[helper] bad line: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.event) return this.emit('event', msg.event, msg);
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error || 'helper error'));
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

  request(cmd, args = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      if (!this._write({ ...args, id, cmd })) return reject(new Error('helper not running'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`helper: ${cmd} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  send(cmd, args = {}) {
    this._write({ ...args, cmd });
  }

  // Closing stdin makes the helper exit (and remove the virtual display).
  stop() {
    this.stopping = true;
    if (!this.proc) return;
    const proc = this.proc;
    proc.stdin.end();
    setTimeout(() => proc.exitCode === null && proc.kill(), 1000).unref();
  }
}

module.exports = { Helper };

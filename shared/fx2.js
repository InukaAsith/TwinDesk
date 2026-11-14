// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Fast files v2 (docs/protocol.md), the app's side: starts the engine (shared/fx2-engine.js) in
// an Electron utility process, or in this process where there is none (plain node, the tests), and
// gives shared/fastfile.js promises for it. Kill switch: env TWINDESK_NO_FX2=1.
//
// On demand: the engine starts when something may need it (need(key, true): a session, another
// TwinDesk nearby; warm(): a socket coming in, a hello going out; any job) and stops IDLE_STOP_MS
// after nothing does, never during a session or a job (the welcome promised its port). A new start
// gets what the last one had: listen(tls), setPlain, setTokens. TWINDESK_FX2_ALWAYS=1: never stops.
'use strict';

const path = require('path');
const { EventEmitter } = require('events');

const fx2Off = () => !!process.env.TWINDESK_NO_FX2;
const IDLE_STOP_MS = 30000;

function utility() {
  if (!process.versions.electron || process.type !== 'browser' || process.env.TWINDESK_FX2_INPROC) return null;
  try {
    const { utilityProcess } = require('electron');
    return utilityProcess || null;
  } catch (_) {
    return null;
  }
}

class Fx2 extends EventEmitter {
  // tls: the session server's https options ({key, cert} or {pfx, passphrase}); without, a client
  // only until listen(tls).
  // engine: the engine's file here (Multi-device runs its own, shared/meshfx2-engine.js).
  constructor({ tls = null, idleMs = IDLE_STOP_MS, engine = 'fx2-engine.js' } = {}) {
    super();
    this.engineFile = engine;
    this.tls = tls;
    this.idleMs = idleMs;
    this.port = 0;
    this.plainPort = 0; // our plain HTTP server's (fxPlain), while it's on
    this.plainOn = false;
    this.jobs = new Map(); // `${dir}:${id}` -> {resolve, reject, onBytes}
    this.want = null; // (id, size) -> Promise<path|null>: where an incoming file goes (fastfile.js)
    this.failedRecv = null; // (id, early, message) for a file we receive that we didn't ask the engine for
    this.doneRecv = null; // (id, hashes)
    this.bytesRecv = null; // (id, n)
    this.tokens = { list: [], plain: [] };
    this.needs = new Set();
    this.running = false; // the engine started (or starting)
    this.stopTimer = null;
    this.waiters = []; // whenReady()
    this.post = this._lazy(); // the first message starts it
  }

  // Something may need the engine (key on) or no longer does (off).
  need(key, on) {
    if (on) {
      this.needs.add(key);
      this.warm();
    } else if (this.needs.delete(key)) this._idle();
  }

  // Start it now (if it isn't), for something about to come; it stops again when nothing needs it.
  warm() {
    if (!this.running && !this.dead) this._start();
    this._idle();
  }

  get state() {
    if (this.dead) return 'failed';
    if (!this.running) return 'stopped';
    return this.child ? 'running' : this.engine ? 'in-process' : 'starting';
  }

  _idle() {
    clearTimeout(this.stopTimer);
    this.stopTimer = null;
    if (!this.running || this.needs.size || this.jobs.size || process.env.TWINDESK_FX2_ALWAYS) return;
    this.stopTimer = setTimeout(() => this._stop(), this.idleMs);
    if (this.stopTimer.unref) this.stopTimer.unref();
  }

  _stop() {
    this.stopTimer = null;
    if (!this.running || this.needs.size || this.jobs.size || this.closing) return;
    this.running = false;
    this.port = 0;
    this.plainPort = 0;
    this._settleWaiters();
    const child = this.child;
    this.child = null;
    if (child) {
      child.stopped = true;
      try { child.kill(); } catch (_) { /* gone */ }
    }
    if (this.engine) {
      const e = this.engine;
      this.engine = null;
      if (e.server) e.server.close();
      if (e.plainServer) e.plainServer.close();
      e.agent.destroy();
      e.plainAgent.destroy();
    }
    this.post = this._lazy();
    console.log('[fx2] the files engine stopped: nothing needs it');
  }

  // Resolves true once the engine listens (and its plain server too, while that's on), false after
  // ms or when it can't. null when it already does (no wait at all).
  whenReady(ms = 1500) {
    if (this._readyNow()) return null;
    if (this.dead) return Promise.resolve(false);
    this.warm();
    if (!this.tls) return Promise.resolve(false);
    return new Promise((resolve) => {
      const w = { resolve, timer: setTimeout(() => this._settleWaiters(w), ms) };
      this.waiters.push(w);
    });
  }

  _readyNow() {
    return this.port > 0 && (!this.plainOn || this.plainPort > 0);
  }

  _settleWaiters(only) {
    for (const w of this.waiters.slice()) {
      if (only && w !== only) continue;
      this.waiters.splice(this.waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve(this._readyNow());
    }
  }

  _lazy() {
    const lazy = (m) => {
      this._start();
      if (this.post !== lazy) this.post(m);
    };
    return lazy;
  }

  _start() {
    if (this.running || this.dead) return;
    this.running = true;
    // What the engine had before it stopped (or was told before it ran).
    const replay = () => {
      if (this.tls) this.post({ op: 'listen', tls: this.tls });
      if (this.plainOn) this.post({ op: 'plain', on: true });
      if (this.tokens.list.length || this.tokens.plain.length) this.post({ op: 'tokens', ...this.tokens });
    };
    const up = utility();
    if (up) {
      const { app } = require('electron');
      if (!app.isReady()) { // a utility process only once the app is ready: messages wait till then
        const queue = [];
        this.post = (m) => queue.push(m);
        app.whenReady().then(() => {
          if (!this.running) return;
          this._fork(up);
          replay();
          for (const m of queue.splice(0)) this.post(m);
        });
        return;
      }
    }
    if (up) this._fork(up);
    else this._inProcess();
    replay();
  }

  _fork(up) {
    try {
      const child = up.fork(path.join(__dirname, this.engineFile), [], { serviceName: 'TwinDesk Files', stdio: 'inherit' });
      this.child = child;
      this.post = (m) => { try { child.postMessage(m); } catch (_) { /* gone */ } };
      child.on('message', (m) => this._on(m));
      child.on('exit', (code) => {
        if (child.stopped) return; // stopped on purpose (_stop): the next need starts another
        if (this.child !== child) return;
        const was = { port: this.port, plain: this.plainPort }; // taken again in this process: the other side has them
        this.port = 0;
        this.plainPort = 0;
        this.child = null;
        for (const [k, j] of this.jobs) {
          this.jobs.delete(k);
          const e = new Error('the files process stopped');
          if (!j.moved) e.early = true; // nothing went yet: the fx way for this file
          j.reject(e);
        }
        if (this.closing) {
          this.dead = true;
          this.running = false;
          this.post = () => {};
          this._settleWaiters();
          this.emit('exit');
          return;
        }
        // It crashed (#143: an ARM64 laptop fell back to the old way for good): the engine goes on in
        // this process instead, as fast, only on the main thread. The next files use it again.
        console.warn(`[fx2] the files process stopped (${code}): the engine goes on in this process`);
        this.crashed = `the files process stopped (${code})`;
        this._inProcess();
        if (this.tls) this.post({ op: 'listen', tls: this.tls, port: was.port });
        if (this.plainOn) this.post({ op: 'plain', on: true, port: was.plain });
        if (this.tokens.list.length || this.tokens.plain.length) this.post({ op: 'tokens', ...this.tokens });
        this.emit('exit');
      });
    } catch (e) {
      console.warn(`[fx2] no utility process (${e.message}): in this process`);
      this._inProcess();
    }
  }

  // Our own server for the guest's requests (as the host), with the session's identity.
  listen(tls) {
    this.tls = tls;
    if (this.running) this.post({ op: 'listen', tls });
  }

  // Can say fx2 in hello (as the guest): the engine is there, or starts when asked.
  get client() {
    return !this.dead;
  }

  _inProcess() {
    const { Engine } = require(path.join(__dirname, this.engineFile));
    const engine = new Engine((m) => setImmediate(() => this.engine === engine && this._on(m)));
    this.engine = engine;
    this.post = (m) => engine.handle(m);
  }

  get ready() {
    return this.port > 0;
  }

  setTokens(list, plain = []) {
    this.tokens = { list: list.filter(Boolean), plain: plain.filter(Boolean) };
    if (this.running) this.post({ op: 'tokens', ...this.tokens });
  }

  // Unencrypted file transfers (shared/fastfile.js setPlain): our plain server on or off.
  setPlain(on) {
    this.plainOn = !!on;
    if (!on) this.plainPort = 0;
    if (this.running) this.post({ op: 'plain', on: !!on });
  }

  _job(dir, id, onBytes) {
    const p = new Promise((resolve, reject) => {
      const k = `${dir}:${id}`;
      const old = this.jobs.get(k);
      if (old) old.reject(new Error('replaced'));
      const j = { resolve, reject, moved: 0 };
      j.onBytes = (n) => { j.moved += n; if (onBytes) onBytes(n); };
      this.jobs.set(k, j);
    });
    this.warm();
    const after = () => this._idle();
    p.then(after, after);
    return p;
  }

  // Host: the guest GETs it. Guest: PUT it to `to` {host, port, fp, token}. Resolves with the hashes.
  serve(id, file, size, onBytes) {
    const p = this._job('send', id, onBytes);
    this.post({ op: 'serve', id, path: file, size });
    return p;
  }

  put(id, file, size, to, onBytes) {
    const p = this._job('send', id, onBytes);
    this.post({ op: 'put', id, path: file, size, to });
    return p;
  }

  // Guest: GET it from `to` into `file`. Resolves with the hashes.
  pull(id, file, size, to, onBytes) {
    const p = this._job('recv', id, onBytes);
    this.post({ op: 'pull', id, path: file, size, to });
    return p;
  }

  cancel(id) {
    for (const dir of ['send', 'recv']) {
      const j = this.jobs.get(`${dir}:${id}`);
      if (j) {
        this.jobs.delete(`${dir}:${id}`);
        j.reject(new Error('Cancelled'));
      }
    }
    if (this.running) this.post({ op: 'cancel', id });
  }

  reset() {
    for (const [k, j] of this.jobs) {
      this.jobs.delete(k);
      j.reject(new Error('the other computer disconnected'));
    }
    if (this.running) this.post({ op: 'reset' });
  }

  close() {
    this.closing = true;
    clearTimeout(this.stopTimer);
    this.reset();
    if (this.child) try { this.child.kill(); } catch (_) { /* gone */ }
    if (this.engine && this.engine.server) this.engine.server.close();
    if (this.engine && this.engine.plainServer) this.engine.plainServer.close();
    if (this.engine) { this.engine.agent.destroy(); this.engine.plainAgent.destroy(); }
  }

  _on(m) {
    if (!m || typeof m.ev !== 'string') return;
    const k = `${m.dir}:${m.id}`;
    const j = this.jobs.get(k);
    switch (m.ev) {
      case 'port':
        this.port = Number(m.port) || 0;
        if (this.port) console.log(`[fx2] files on port ${this.port}${this.child ? ' (utility process)' : ''}`);
        if (!this.port || !this.plainOn || this.plainPort) this._settleWaiters();
        return this.emit('port', this.port);
      case 'plainPort':
        this.plainPort = this.plainOn ? Number(m.port) || 0 : 0;
        if (this.port || !this.tls) this._settleWaiters();
        return;
      case 'want':
        Promise.resolve(this.want ? this.want(m.id, m.size) : null).catch(() => null)
          .then((file) => this.post({ op: 'target', id: m.id, path: file || null }));
        return;
      case 'bytes':
        if (j && j.onBytes) j.onBytes(m.n);
        else if (m.dir === 'recv' && this.bytesRecv) this.bytesRecv(m.id, m.n);
        return;
      case 'done':
        if (j) {
          this.jobs.delete(k);
          return j.resolve(m.hashes);
        }
        if (m.dir === 'recv' && this.doneRecv) this.doneRecv(m.id, m.hashes);
        return;
      case 'failed': {
        const e = new Error(m.message || 'failed');
        if (m.early) e.early = true;
        if (j) {
          this.jobs.delete(k);
          return j.reject(e);
        }
        if (m.dir === 'recv' && this.failedRecv) this.failedRecv(m.id, !!m.early, e.message);
      }
    }
  }
}

module.exports = { Fx2, fx2Off, IDLE_STOP_MS };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Fast files v2 (docs/protocol.md), the app's side: starts the engine (shared/fx2-engine.js) in
// an Electron utility process, or in this process where there is none (plain node, the tests), and
// gives shared/fastfile.js promises for it. Kill switch: env TWINDESK_NO_FX2=1.
'use strict';

const path = require('path');
const { EventEmitter } = require('events');

const fx2Off = () => !!process.env.TWINDESK_NO_FX2;

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
  constructor({ tls = null } = {}) {
    super();
    this.tls = tls;
    this.port = 0;
    this.jobs = new Map(); // `${dir}:${id}` -> {resolve, reject, onBytes}
    this.want = null; // (id, size) -> Promise<path|null>: where an incoming file goes (fastfile.js)
    this.failedRecv = null; // (id, early, message) for a file we receive that we didn't ask the engine for
    this.doneRecv = null; // (id, hashes)
    this.bytesRecv = null; // (id, n)
    this._start();
    if (this.tls) this.listen(this.tls);
  }

  _start() {
    const up = utility();
    if (up) {
      const { app } = require('electron');
      if (!app.isReady()) { // a utility process only once the app is ready: messages wait till then
        const queue = [];
        this.post = (m) => queue.push(m);
        app.whenReady().then(() => {
          this._fork(up);
          for (const m of queue.splice(0)) this.post(m);
        });
        return;
      }
    }
    if (up) this._fork(up);
    else this._inProcess();
  }

  _fork(up) {
    try {
      const child = up.fork(path.join(__dirname, 'fx2-engine.js'), [], { serviceName: 'TwinDesk Files', stdio: 'inherit' });
      this.child = child;
      this.post = (m) => { try { child.postMessage(m); } catch (_) { /* gone */ } };
      child.on('message', (m) => this._on(m));
      child.on('exit', (code) => {
        if (!this.closing) console.warn(`[fx2] the files process stopped (${code}): files go the fx way`);
        this.port = 0;
        this.dead = true;
        this.child = null;
        this.post = () => {};
        for (const [k, j] of this.jobs) {
          this.jobs.delete(k);
          const e = new Error('the files process stopped');
          if (!j.moved) e.early = true; // nothing went yet: the fx way
          j.reject(e);
        }
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
    this.post({ op: 'listen', tls });
  }

  // Can say fx2 in hello (as the guest): the engine is there.
  get client() {
    return !!this.post && !this.dead;
  }

  _inProcess() {
    const { Engine } = require('./fx2-engine.js');
    const engine = new Engine((m) => setImmediate(() => this._on(m)));
    this.engine = engine;
    this.post = (m) => engine.handle(m);
  }

  get ready() {
    return this.port > 0;
  }

  setTokens(list) {
    this.post({ op: 'tokens', list: list.filter(Boolean) });
  }

  _job(dir, id, onBytes) {
    return new Promise((resolve, reject) => {
      const k = `${dir}:${id}`;
      const old = this.jobs.get(k);
      if (old) old.reject(new Error('replaced'));
      const j = { resolve, reject, moved: 0 };
      j.onBytes = (n) => { j.moved += n; if (onBytes) onBytes(n); };
      this.jobs.set(k, j);
    });
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
    this.post({ op: 'cancel', id });
  }

  reset() {
    for (const [k, j] of this.jobs) {
      this.jobs.delete(k);
      j.reject(new Error('the other computer disconnected'));
    }
    this.post({ op: 'reset' });
  }

  close() {
    this.closing = true;
    this.reset();
    if (this.child) try { this.child.kill(); } catch (_) { /* gone */ }
    if (this.engine && this.engine.server) this.engine.server.close();
    if (this.engine) this.engine.agent.destroy();
  }

  _on(m) {
    if (!m || typeof m.ev !== 'string') return;
    const k = `${m.dir}:${m.id}`;
    const j = this.jobs.get(k);
    switch (m.ev) {
      case 'port':
        this.port = Number(m.port) || 0;
        if (this.port) console.log(`[fx2] files on port ${this.port}${this.child ? ' (utility process)' : ''}`);
        return this.emit('port', this.port);
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

module.exports = { Fx2, fx2Off };

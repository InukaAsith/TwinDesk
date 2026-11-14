// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Full KVM (docs/full-kvm.md): the app's end of the service's kvm pipe. The service (Linux
// linux/fullkvm/service.js, Windows TwinDeskService) runs the helper with the rights the lock screen,
// UAC and the login screen need; this speaks the helper's JSON lines to it, like ../../linux/helper.js
// to a helper of its own: send(), request(), sendMove(), events 'ready', 'event' (name, msg), 'exit'.
// Only the mouse-and-keyboard commands go through (KVM); the service refuses the rest.
// It keeps trying to connect while there is a service (a socket file, a pipe): one that isn't
// installed, or isn't this user's (another person is at the computer), costs a failed connect now and then.
//   const s = new SvcLink(path); s.start(); s.on('ready', …); s.connected
'use strict';

const net = require('net');
const fs = require('fs');
const { EventEmitter } = require('events');

const KVM = new Set(['ping', 'keepalive', 'kvmConfig', 'screens', 'capture', 'place', 'armReturn', 'inject', 'pen', 'touch', 'releaseAll', 'watchRelease', 'moveTo', 'info']);
const RETRY_MS = 2000;
const REQUEST_MS = 3000;

class SvcLink extends EventEmitter {
  constructor(where, { exists = (p) => p.startsWith('\\\\.\\pipe\\') || fs.existsSync(p) } = {}) {
    super();
    this.where = where;
    this.exists = exists;
    this.sock = null;
    this.ready = false; // connected, and its helper said ready
    this.backend = '';
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.timer = null;
    this.stopped = true;
    this.error = '';
  }

  get connected() {
    return this.ready;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.sock) this.sock.destroy();
  }

  _later() {
    clearTimeout(this.timer);
    if (!this.stopped) this.timer = setTimeout(() => this._connect(), RETRY_MS);
  }

  _connect() {
    if (this.stopped || this.sock) return;
    if (!this.exists(this.where)) return this._later();
    const sock = net.connect(this.where);
    this.sock = sock;
    this.buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => this._data(d));
    sock.on('error', (e) => { this.error = e.code || e.message; });
    sock.on('close', () => {
      if (this.sock !== sock) return;
      this.sock = null;
      const was = this.ready;
      this.ready = false;
      this.backend = '';
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Full KVM service gone')); }
      this.pending.clear();
      if (was) this.emit('exit', 1);
      this._later();
    });
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
        this.ready = true;
        this.backend = msg.backend || '';
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
    if (!this.sock || !this.ready || !KVM.has(obj.cmd)) return false;
    this.sock.write(JSON.stringify(obj) + '\n');
    return true;
  }

  send(cmd, args = {}) {
    return this._write({ ...args, cmd });
  }

  sendMove(dx, dy) {
    return this._write({ cmd: 'inject', ev: { t: 'k.mm', dx: Number.isFinite(dx) ? dx : 0, dy: Number.isFinite(dy) ? dy : 0 } });
  }

  request(cmd, args = {}, ms = REQUEST_MS) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      if (!this._write({ ...args, cmd, id })) return reject(new Error('Full KVM service not connected'));
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Full KVM: ' + cmd + ' timed out')); }, ms);
      this.pending.set(id, { resolve, reject, timer });
    });
  }
}

module.exports = { SvcLink, KVM };

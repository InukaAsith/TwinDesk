// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The calls' sound on this Mac over Bluetooth (shared/phonehub.js makes this only while Calls and
// its Bluetooth option are on with a phone connected): mac-helper's macshare-calls connects to the
// phone as its hands-free, like a headset, and macOS plays the call through the Mac's speakers and
// microphone. The phone has to be paired with this Mac over Bluetooth once, in System Settings (the
// Calls page's setup).
// stop() ends it all: the process exits and the phone gets its calls back.
//
// view: {state: 'starting'|'unavailable'|'needs-pair'|'choose'|'connecting'|'ready'|'failed'|'off',
//        message, device, devices, here, address}. Events: 'change', 'address' (this Mac's).
'use strict';

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const BIN = path.join(__dirname, '..', 'mac-helper', '.build', 'release', 'macshare-calls');
const RETRY_MS = [5000, 15000, 30000, 60000, 120000];

class CallAudio extends EventEmitter {
  constructor({ device, save }) {
    super();
    this.saved = device; // () => the paired phone chosen before (its Bluetooth address)
    this.save = save;
    this.proc = null;
    this.phoneName = '';
    this.devices = [];
    this.address = '';
    this.power = true;
    this.id = '';
    this.state = 'starting';
    this.error = '';
    this.here = false;
    this.muted = false;
    this.tries = 0;
    this.timer = null;
    this.stopped = false;
  }

  start(phoneName) {
    this.stopped = false;
    if (phoneName) this.phoneName = phoneName;
    if (!this.proc && !this._spawn()) return;
    this.tries = 0;
    this._send({ cmd: 'info' });
  }

  // The phone's Bluetooth name (hub.state, also sent once it pairs): which paired device it is.
  phone(name) {
    if (name) this.phoneName = name;
    if (this.proc && ['needs-pair', 'choose'].includes(this.state)) this._send({ cmd: 'info' });
  }

  transfer(here) {
    this._send({ cmd: here ? 'here' : 'phone' });
  }

  mute(on) {
    this.muted = !!on;
    this._send({ cmd: 'mute', on: !!on });
  }

  // The call ended: the next one starts with the microphone on.
  idle() {
    if (this.muted) this.mute(false);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    const p = this.proc;
    this.proc = null;
    if (p) {
      try { p.stdin.end(); } catch {} // it lets the phone go, then exits
      setTimeout(() => { try { p.kill(); } catch {} }, 1500).unref();
    }
    this._set('off');
  }

  _spawn() {
    if (!fs.existsSync(BIN)) {
      this.error = 'macshare-calls is missing (npm run build:helper)';
      this._set('unavailable');
      return false;
    }
    const p = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    p.stdin.on('error', () => {});
    readline.createInterface({ input: p.stdout }).on('line', (l) => this._line(l));
    readline.createInterface({ input: p.stderr }).on('line', (l) => console.log(`[calls] ${l}`));
    p.on('exit', () => {
      if (this.proc !== p) return;
      this.proc = null;
      if (!this.stopped) { this.error = 'stopped'; this._set('failed'); }
    });
    p.on('error', (e) => console.log(`[calls] ${e.message}`));
    return true;
  }

  _send(o) {
    if (this.proc) this.proc.stdin.write(`${JSON.stringify(o)}\n`);
  }

  _line(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.ev === 'info') {
      this.power = m.power !== false;
      this.devices = Array.isArray(m.devices) ? m.devices.filter((d) => d && typeof d.id === 'string' && d.id).slice(0, 20) : [];
      if (m.address && m.address !== this.address) {
        this.address = String(m.address);
        this.emit('address', this.address);
      }
      return this._pick();
    }
    if (m.ev === 'state') {
      if (m.state === 'connected') { this.tries = 0; this.error = ''; return this._set('ready'); }
      if (m.state === 'connecting') return this._set('connecting');
      this.here = false;
      this.error = m.error || '';
      return this._retry();
    }
    if (m.ev === 'sco') { this.here = !!m.open; this.emit('change'); }
  }

  // Which paired device is the phone: the one picked for it before (each phone its own), else the
  // one with its Bluetooth name. Not found: the user picks it ('choose'), never just the first one.
  _pick() {
    if (!this.power) { this.error = ''; return this._set('unavailable'); }
    const saved = this.saved();
    const name = this.phoneName.trim().toLowerCase();
    const d = this.devices.find((x) => x.id === saved)
      || (name && this.devices.find((x) => x.name.trim().toLowerCase() === name));
    if (!d) { this.id = ''; return this._set(this.devices.length ? 'choose' : 'needs-pair'); }
    this.id = d.id;
    if (d.id !== saved) this.save(d.id);
    this._send({ cmd: 'connect', id: d.id });
  }

  // Dropped or refused (the phone busy with a car, or out of range): again a little later, a few times.
  _retry() {
    if (this.stopped) return;
    const wait = RETRY_MS[this.tries++];
    this._set('failed');
    clearTimeout(this.timer);
    if (wait) this.timer = setTimeout(() => !this.stopped && this._send({ cmd: 'info' }), wait);
  }

  _set(state) {
    this.state = state;
    this.emit('change');
  }

  get view() {
    const dev = this.devices.find((d) => d.id === this.id);
    const name = (dev && dev.name) || this.phoneName || 'the phone';
    const MESSAGES = {
      starting: 'Starting…',
      unavailable: this.error ? `Not available: ${this.error}` : 'Bluetooth is off on this Mac',
      'needs-pair': `Not paired with ${this.phoneName || 'the phone'} over classic Bluetooth: pair them in Bluetooth settings, as below`,
      choose: 'Choose the phone below',
      connecting: `Connecting to ${name}…`,
      ready: `Connected to ${name} over Bluetooth: calls play on this Mac`,
      failed: `Couldn’t reach ${name} over Bluetooth${this.error && this.error !== 'stopped' ? ` (${this.error})` : ''}. ${this.tries > RETRY_MS.length ? 'Click Connect to try again' : 'Trying again soon'}`,
      off: 'Off',
    };
    return {
      state: this.state, message: MESSAGES[this.state] || '', device: this.id,
      devices: this.devices, here: this.here, address: this.address,
    };
  }
}

module.exports = { create: (opts) => new CallAudio(opts) };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Internet over USB (#277): the phone on the cable uses this computer's internet, as gnirehtet
// does, with nothing else to install. Tether.kt on the phone starts a VPN whose packets go
// through `adb reverse` to a relay here (shared/tetherrelay.js), which makes the connections from
// this computer. Made by phonehub.js; for the Mac, PC and Linux apps and Multi-device alike.
//
//   - Only a phone that says it can (tether.state {can: true} as its session starts: an older
//     phone never does, so nothing shows) and only through USB debugging on the cable. The
//     session itself may run over Wi-Fi or the cable.
//   - Phone > Internet over USB (settings.hub.tether, off until switched on). While it's on, the
//     phone uses it whenever it's connected and on the cable: plugged in again, it comes back.
//     The phone asks once for Android's VPN permission; Stop in its notification switches it off
//     here too (tether.set).
//   - The phone's 127.0.0.1:<port> is a server on this computer's 127.0.0.1 only. Both ends prove
//     they know a secret given through the session before a packet goes (another app on the phone
//     holding that port gets nothing and is refused): the phone sends TDT1 <nonce>, this answers
//     HMAC(token, 'r' + nonce) and its own nonce, the phone answers HMAC(token, 'p' + that).
//
// computer -> phone: tether {on: true, port, token} | {on: false}
// phone -> computer: tether.state {can, state: 'off'|'ask'|'starting'|'on'|'error', why?}
//                    tether.set {on}: switched on the phone (its notification's Stop)
//
// Events: 'change' (view).
'use strict';

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Relay, Packets } = require('./tetherrelay.js');

const P = require('./protocol.js');

const T = { TETHER: P.T.TETHER, STATE: P.T.TETHER_STATE, SET: P.T.TETHER_SET };
const PHONE_PORTS = [31417, 31427, 31437]; // the phone's side of adb reverse, the next one when one is taken there
const WATCH_MS = 3000;
const RETRY_MS = 10_000;
const HELLO_MS = 5000;
const STATES = ['off', 'ask', 'starting', 'on', 'error'];
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const mac = (key, s) => crypto.createHmac('sha256', key).update(s).digest('hex');

class Tether extends EventEmitter {
  // hub: phonehub.js (settings, save, phone, server). adb: the phone bridge's (run).
  // cableSerial(deviceId): the phone's USB serial while it's on a cable here, else null.
  constructor(hub, { adb, cableSerial, log = (s) => console.log(`[tether] ${s}`) }) {
    super();
    Object.assign(this, { hub, adb, cableSerial, log });
    this.can = false; // the phone in the session said it can
    this.phoneState = 'off';
    this.why = '';
    this.error = ''; // this side's: no cable, adb reverse refused
    this.server = null; // 127.0.0.1:<port> here, while it runs
    this.port = 0;
    this.token = '';
    this.serial = '';
    this.phonePort = 0;
    this.sent = false; // tether {on} went to this session's phone
    this.stream = null; // {sock, relay}
    this.tried = 0;
    this.timer = null;
    const on = (t, fn) => hub.server.on(`t:${t}`, (m, ctx) => ctx === hub.phone && fn(m));
    on(T.STATE, (m) => this._state(m));
    on(T.SET, (m) => this.act('set', { on: !!m.on }));
  }

  get enabled() {
    return this.hub.settings.tether === true;
  }

  // ---- the session ----

  started() {
    this.can = false;
    this.phoneState = 'off';
    this.sent = false;
    this.error = '';
    this.emit('change');
  }

  stopped() {
    this.can = false;
    this.sent = false;
    this._stop('session ended');
    this.emit('change');
  }

  _state(m) {
    const was = this.can;
    this.can = m.can === true;
    this.phoneState = STATES.includes(m.state) ? m.state : 'off';
    this.why = str(m.why, 200);
    if (this.can && !was) this.log('the phone can take Internet over USB');
    if (this.phoneState === 'off' && this.sent && this.enabled) this.tried = 0; // its stream ended (unplugged): again once it's back
    this.sync();
    this.emit('change');
  }

  // ---- on or off ----

  // From the window: {a: 'set', on}.
  act(a, r = {}) {
    if (a !== 'set') return;
    this.hub.settings.tether = !!r.on;
    this.hub.save();
    this.tried = 0;
    this.error = '';
    this.sync();
    this.emit('change');
  }

  // Running when switched on, the phone can and it's on the cable; else not.
  sync() {
    const ctx = this.hub.phone;
    const want = !!(this.enabled && ctx && this.can);
    if (want && !this.timer) {
      this.timer = setInterval(() => this.sync(), WATCH_MS);
      this.timer.unref && this.timer.unref();
    }
    if (!want) {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (this.sent || this.server) this._stop('switched off');
      return;
    }
    const serial = this.cableSerial ? this.cableSerial(ctx.deviceId) : null;
    if (!serial) {
      if (this.serial) this._stop('unplugged');
      this._err('Plug the phone into this computer with USB debugging on');
      return;
    }
    if (this.busy) return;
    const live = this.stream || ['ask', 'starting', 'on'].includes(this.phoneState);
    if (this.sent && this.serial === serial && live) return;
    if (Date.now() - this.tried < RETRY_MS) return;
    this.tried = Date.now();
    this.busy = true;
    this._start(serial).catch((e) => this._err(e.message)).then(() => { this.busy = false; });
  }

  _err(e) {
    if (this.error === e) return;
    this.error = e;
    if (e) this.log(e);
    this.emit('change');
  }

  async _start(serial) {
    await this._listen();
    let port = 0;
    let last = '';
    for (const p of PHONE_PORTS) {
      const r = await this.adb.run(['-s', serial, 'reverse', `tcp:${p}`, `tcp:${this.port}`], { timeout: 5000 });
      if (r && r.code === 0) { port = p; break; }
      last = String((r && r.err) || '').split('\n')[0];
    }
    if (!port) throw new Error(`adb reverse didn’t work through the cable${last ? ` (${last})` : ''}`);
    const ctx = this.hub.phone;
    if (!ctx || !this.enabled) return this._unreverse(serial, port);
    this.serial = serial;
    this.phonePort = port;
    this.token = crypto.randomBytes(32).toString('hex');
    this.sent = true;
    this.error = '';
    this.hub.server.sendToClient({ t: T.TETHER, on: true, port, token: this.token });
    this.log(`offered to ${ctx.name} on its 127.0.0.1:${port} (${serial})`);
    this.emit('change');
  }

  _listen() {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const srv = net.createServer((sock) => this._accept(sock));
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        this.server = srv;
        this.port = srv.address().port;
        resolve();
      });
    });
  }

  // A stream from the phone: the handshake, then packets both ways.
  _accept(sock) {
    sock.setNoDelay(true);
    let buf = '';
    let step = 0;
    let ours = '';
    const fail = (why) => { this.log(`a stream was refused: ${why}`); sock.destroy(); };
    const t = setTimeout(() => fail('no hello'), HELLO_MS);
    sock.on('error', () => {});
    const onData = (d) => {
      buf += d.toString('latin1');
      if (buf.length > 512) return fail('hello too long');
      let i;
      while (step < 2 && (i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!this.token) return fail('not offered');
        if (step === 0) {
          const m = /^TDT1 ([0-9a-f]{32,64})$/.exec(line);
          if (!m) return fail('bad hello');
          ours = crypto.randomBytes(16).toString('hex');
          sock.write(`${mac(this.token, `r${m[1]}`)} ${ours}\n`);
          step = 1;
        } else {
          const want = Buffer.from(mac(this.token, `p${ours}`));
          const got = Buffer.from(line);
          if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return fail('wrong proof');
          step = 2;
          clearTimeout(t);
          sock.removeListener('data', onData);
          const rest = Buffer.from(buf, 'latin1');
          this._run(sock, rest);
        }
      }
    };
    sock.on('data', onData);
    sock.on('close', () => clearTimeout(t));
  }

  _run(sock, rest) {
    if (this.stream) this.stream.sock.destroy(); // the phone started again: this one replaces it
    const relay = new Relay((p) => { if (!sock.destroyed) sock.write(p); });
    const packets = new Packets((p) => relay.feed(p));
    const s = { sock, relay };
    this.stream = s;
    this.log('the phone is on this computer’s internet');
    this.emit('change');
    const feed = (d) => { if (!packets.push(d)) { this.log('the stream broke'); sock.destroy(); } };
    if (rest.length) feed(rest);
    sock.on('data', feed);
    sock.on('close', () => {
      relay.close();
      if (this.stream !== s) return;
      this.stream = null;
      this.log(`the phone's stream ended (${Math.round(relay.stats.down / 1e6)} MB down, ${Math.round(relay.stats.up / 1e6)} MB up)`);
      this.tried = 0; // plugged in again: offered again
      this.emit('change');
    });
  }

  _stop(why) {
    if (this.sent && this.hub.phone) this.hub.server.sendToClient({ t: T.TETHER, on: false });
    if (this.sent || this.stream) this.log(`stopped: ${why}`);
    this.sent = false;
    this.token = '';
    if (this.stream) { this.stream.sock.destroy(); this.stream = null; }
    if (this.serial && this.phonePort) this._unreverse(this.serial, this.phonePort);
    this.serial = '';
    this.phonePort = 0;
    if (this.server) { this.server.close(); this.server = null; this.port = 0; }
  }

  _unreverse(serial, port) {
    if (this.adb) this.adb.run(['-s', serial, 'reverse', '--remove', `tcp:${port}`], { timeout: 5000 }).catch(() => {});
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._stop('closing');
  }

  get view() {
    const s = this.stream;
    return {
      can: this.can, on: this.enabled,
      // 'off' | 'cable' (waiting for the cable) | 'ask' (the phone's VPN permission) | 'starting' | 'on' | 'error'
      state: !this.enabled || !this.can ? 'off' : s ? 'on' : this.error && !this.sent ? 'cable' : this.phoneState === 'error' ? 'error' : this.phoneState === 'ask' ? 'ask' : this.sent ? 'starting' : 'cable',
      why: this.phoneState === 'error' ? this.why : this.error,
      down: s ? s.relay.stats.down : 0, up: s ? s.relay.stats.up : 0, flows: s ? s.relay.flows : 0,
    };
  }
}

module.exports = { Tether, T, mac };

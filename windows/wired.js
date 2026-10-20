// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A paired phone on a USB cable: the whole session goes through it, no Wi-Fi needed.
// Copy of mac/wired.js.
//   - adb sees a phone over USB (USB debugging allowed for this computer) with TwinDesk on it:
//     `adb reverse` makes the phone's 127.0.0.1:<port> this server, and 127.0.0.1:<TURN_PORT> the
//     relay (shared/turn.js), or other ports where the phone's own connections hold those; a
//     broadcast only adb's shell may send (WiredReceiver) tells the app to connect there. Its pinned certificate and token work as over Wi-Fi.
//   - A session from 127.0.0.1 is a wired phone: offers to it carry the relay (server.js), and
//     this Mac's own WebRTC uses it too (stream.js, audio.js), so the screen and sound go through
//     adb as TCP. The phone tells which USB device it is (phone.wired with the broadcast's nonce),
//     and the bridge drives that one (phone-bridge.js wiredSerial).
//   - Unplugged: the phone's session drops and it resumes over Wi-Fi by itself.
// Plugging in connects once; Disconnect is respected until the cable is plugged in again.
//
// Events: 'change'.
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { TurnThread } = require('../shared/turn.js');
const P = require('../shared/protocol.js');
const usbadb = require('../shared/usbadb.js');

const APP_ID = 'com.twindesk.android';
const TURN_PORT = 47802;
const POLL_MS = 2000;
const RETRY_MS = 15000; // a phone without TwinDesk (or not answering yet) is looked at again after this

const isUsb = (serial) => !/[:]/.test(serial) && !serial.startsWith('emulator-') && !serial.includes('._adb-tls');
const isLoopback = (a) => a === '127.0.0.1' || a === '::1';

class Wired extends EventEmitter {
  // hasPhone: whether any phone is paired with this computer (no phone, no adb at all).
  constructor({ adb, raw, peer, getId, hasPhone = () => true }) {
    super();
    Object.assign(this, { adb, raw, peer, getId, hasPhone });
    this.plugged = new Map(); // USB serial -> {nonce, at, linked}
    this.byDevice = new Map(); // phone deviceId -> USB serial (from phone.wired)
    this.turn = new TurnThread({ port: TURN_PORT });
    this.turnOk = false;
    this.phoneTurn = TURN_PORT; // the relay's port on the phone's side of adb reverse
    // Every session from 127.0.0.1 is a phone through adb reverse: its WebRTC uses the relay.
    raw.iceFor = (ctx) => (ctx.os === P.OS.ANDROID && isLoopback(ctx.address) && this.turnOk ? this._ice() : null);
    peer.on('t:phone.wired', (m, ctx) => {
      const hit = [...this.plugged].find(([, p]) => p.nonce && p.nonce === m.nonce);
      if (!hit || !ctx.deviceId) return;
      this.byDevice.set(ctx.deviceId, hit[0]);
      console.log(`[wired] ${ctx.name} is on the cable (${hit[0]})`);
      this.emit('change');
    });
    this.timer = setInterval(() => this._poll().catch((e) => console.log(`[wired] ${e.message}`)), POLL_MS);
  }

  // The USB serial of a phone connected through the cable, or null.
  serialOf(deviceId) {
    const c = this.peer.ctxOf(deviceId); // that phone's session (phone-link.js)
    if (!c || !c.ice) return null;
    const s = this.byDevice.get(deviceId);
    return s && this.plugged.has(s) ? s : null;
  }

  get wired() {
    return this.peer.all().some((c) => c.ice);
  }

  // The tile was clicked with the phone on the cable: ask it through the cable again.
  connect(deviceId) {
    const s = this.byDevice.get(deviceId);
    if (!s || !this.plugged.has(s)) return false;
    this._invite(s).catch(() => {});
    return true;
  }

  async _poll() {
    if (this.polling || !this.adb.available) return;
    this.polling = true;
    try {
      // adb only for a phone that's here: linked now, or a paired one on the cable (asked of the
      // system, not adb). Until then no adb server runs.
      const linked = this.peer.all().length > 0;
      const here = linked || (this.hasPhone() && await usbadb.present());
      const usb = !here ? [] : (await this.adb.devices()).filter((d) => d.state === 'device' && isUsb(d.serial)).map((d) => d.serial);
      for (const s of [...this.plugged.keys()]) {
        if (usb.includes(s)) continue;
        this.plugged.delete(s);
        for (const [id, x] of this.byDevice) if (x === s) this.byDevice.delete(id);
        console.log(`[wired] ${s} unplugged`);
        this.emit('change');
      }
      if (usb.length) await this._relay(); // started for the first phone on the cable, kept from then on
      for (const s of usb) {
        const p = this.plugged.get(s);
        if (p && (p.linked || Date.now() - p.at < RETRY_MS)) continue;
        this.plugged.set(s, { nonce: '', at: Date.now(), linked: false });
        await this._invite(s);
      }
    } finally {
      this.polling = false;
    }
  }

  _relay() {
    if (!this.relayStart) {
      this.relayStart = this.turn.start().then(() => { this.turnOk = true; }, (e) => {
        console.error(`[wired] relay on ${TURN_PORT}: ${e.message}`);
        this.relayStart = null; // tried again with the next poll
      });
    }
    return this.relayStart;
  }

  // The relay as both sides reach it: here on TURN_PORT, on the phone on phoneTurn (each side's
  // other address refuses at once).
  _ice() {
    const ice = this.turn.ice();
    const [s] = ice.iceServers;
    if (this.phoneTurn !== TURN_PORT) ice.iceServers.push({ ...s, urls: s.urls.replace(`:${TURN_PORT}?`, `:${this.phoneTurn}?`) });
    return ice;
  }

  // The phone's port for `adb reverse` to ours: the same number when it's free there, else one
  // adb picks. Android's own outgoing connections use ports in this range (32768–60999).
  async _reverse(serial, port) {
    const list = await this.adb.run(['-s', serial, 'reverse', '--list'], { timeout: 5000 });
    const m = new RegExp(`tcp:(\\d+) tcp:${port}\\s*$`, 'm').exec(list.out);
    if (m) return Number(m[1]);
    let r;
    for (const p of [port, 0]) {
      r = await this.adb.run(['-s', serial, 'reverse', `tcp:${p}`, `tcp:${port}`], { timeout: 5000 });
      if (!r.code) return p || Number(r.out.trim());
    }
    throw new Error(`adb reverse ${port}: ${(r.err || r.out).trim()}`);
  }

  async _invite(serial) {
    const has = await this.adb.shell(serial, `pm path ${APP_ID}`, { timeout: 5000 });
    if (!/package:/.test(has.out)) return;
    const port = await this._reverse(serial, this.raw.port);
    this.phoneTurn = await this._reverse(serial, TURN_PORT);
    const nonce = crypto.randomBytes(8).toString('hex');
    const r = await this.adb.shell(serial, `am broadcast -f 32 -n ${APP_ID}/.WiredReceiver --es host ${this.getId()} --ei port ${port} --es nonce ${nonce}`, { timeout: 8000 });
    if (!/Broadcast completed/.test(r.out)) throw new Error(`broadcast: ${(r.out || r.err || '').trim()}`);
    this.plugged.set(serial, { nonce, at: Date.now(), linked: true });
    console.log(`[wired] asked ${serial} to connect through the cable`);
  }

  stop() {
    clearInterval(this.timer);
    this.turn.stop();
  }
}

module.exports = { Wired };

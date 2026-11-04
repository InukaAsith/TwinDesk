// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The other device's controls on Overview, and this computer's for it (Mac, PC and Linux; a phone
// or a computer, whichever the session is with):
//   dev.do    {do, on?, level?, mode?, id?, stream?}  ask the other side (ring, ringStop, lock, sleep,
//             bluetooth, dnd, volume; a phone also qs {id, on} and ringer {mode})
//   dev.state {can: {ring, lock, …}, ringing, bluetooth?, dnd?, volume?, qs?: {wifi, bluetooth, …,
//             detail: {id: text}, panel: {id: true}, volume, ringer}, top?: [package]}
// Sent at the start of every session and whenever something changed. A side that doesn't know them
// (an older TwinDesk) never answers: Overview then leaves the controls out.
// link: on(type | 'welcome' | 'closed', fn), send(msg), current? (the session's ctx: os)
// local: DevLocal (shared/devlocal.js); adb() → {adb, serial} while a phone's wireless debugging is
// ready (what an app can't switch on the phone goes that way: shared/devadb.js), else null.
// Events: 'change'.
'use strict';

const { EventEmitter } = require('events');
const { viaAdb } = require('./devadb.js');
const AppInfo = require('./appinfo.js');

const T = { DO: 'dev.do', STATE: 'dev.state' };
const DOS = ['ring', 'ringStop', 'lock', 'sleep', 'bluetooth', 'dnd', 'volume', 'qs', 'ringer', 'mediaHere'];
const QS = ['wifi', 'bluetooth', 'data', 'hotspot', 'torch', 'dnd', 'rotate', 'saver'];
const POLL_MS = 60000;
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const level = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : undefined);

// What the other side said, kept to known fields and sizes.
function clean(m) {
  const can = {};
  for (const k of DOS) if (m.can && m.can[k] === true) can[k] = true;
  const out = { can, ringing: m.ringing === true, bluetooth: bool(m.bluetooth), dnd: bool(m.dnd), volume: level(m.volume) };
  if (m.qs && typeof m.qs === 'object') {
    const q = { detail: {}, panel: {} };
    for (const k of QS) {
      if (typeof m.qs[k] !== 'boolean') continue;
      q[k] = m.qs[k];
      if (m.qs.detail && typeof m.qs.detail[k] === 'string') q.detail[k] = str(m.qs.detail[k], 40);
      if (m.qs.panel && m.qs.panel[k] === true) q.panel[k] = true;
    }
    q.volume = level(m.qs.volume);
    q.ringer = ['ring', 'vibrate', 'silent'].includes(m.qs.ringer) ? m.qs.ringer : undefined;
    out.qs = q;
  }
  if (m.info && typeof m.info === 'object') { // a phone's storage, network and signal (Overview's card)
    const i = m.info;
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : undefined);
    out.info = { storageUsed: n(i.storageUsed), storageTotal: n(i.storageTotal), wifi: str(i.wifi, 64), cell: str(i.cell, 64), signal: str(i.signal, 20) };
  }
  out.app = AppInfo.clean(m.app); // which TwinDesk it runs (null: older than 2.5)
  if (Array.isArray(m.top)) out.top = m.top.filter((x) => typeof x === 'string').slice(0, 12).map((x) => x.slice(0, 200));
  return out;
}

class DevCtl extends EventEmitter {
  // version: this app's (sent as dev.state's app, checked against the other side's: 'outdated').
  // peerName(): the other side's name for that message (else link.current.name).
  constructor({ link, local, adb, version = '', peerName = null }) {
    super();
    Object.assign(this, { link, local, adb: adb || (() => null), version, peerName });
    this.told = new Set(); // device|version already told about this run
    this.remote = null; // the other side's dev.state (null: nothing said yet)
    this.mine = null; // this computer's last state, sent with it
    this.sessionUp = false;
    link.on('welcome', () => {
      this.sessionUp = true;
      this.remote = null;
      this._sendState(true);
      this.emit('change');
    });
    link.on('closed', () => {
      this.sessionUp = false;
      this.remote = null;
      this.local.stop();
      this.emit('change');
    });
    link.on(T.STATE, (m) => {
      const first = !this.remote;
      this.remote = clean(m || {});
      this.emit('change');
      // The other side's first word in a session: ours again, so the two always have each other's
      // (one sent before the other side listened is otherwise never sent again: only changes are).
      if (first || (m && m.ask === true)) this._sendState(true); // asked: it hasn't got ours
      if (first) this._checkApp();
    });
    link.on(T.DO, (m) => this._asked(m || {}));
    if (local) local.onStop = () => this._sendState(true); // ringing stopped by itself
    this.timer = setInterval(() => this.sessionUp && this._sendState(false), POLL_MS);
  }

  // Overview's buttons: to the other side. A guess is shown at once; its dev.state corrects it.
  async do(cmd) {
    const c = cmd || {};
    if (!DOS.includes(c.do) || !this.sessionUp) return;
    const msg = { t: T.DO, do: c.do };
    if (typeof c.on === 'boolean') msg.on = c.on;
    if (c.level != null) msg.level = level(c.level);
    if (typeof c.id === 'string') msg.id = str(c.id, 20);
    if (typeof c.mode === 'string') msg.mode = str(c.mode, 10);
    if (typeof c.stream === 'string') msg.stream = str(c.stream, 10);
    // A phone: what only opens a panel there (or Lock without its Accessibility) over ADB, when ready.
    const r0 = this.remote;
    const a = this.adb();
    const adbFirst = a && ((msg.do === 'qs' && r0 && r0.qs && r0.qs.panel[msg.id]) || (msg.do === 'lock' && !(r0 && r0.can.lock)));
    if (!(adbFirst && await viaAdb(a.adb, a.serial, msg))) this.link.send(msg);
    else if (msg.do === 'qs' && r0 && r0.qs) r0.qs.panel[msg.id] = false; // it switched: show it at once
    const r = this.remote;
    if (!r) return;
    if (c.do === 'ring') r.ringing = true;
    else if (c.do === 'ringStop') r.ringing = false;
    else if (c.do === 'qs' && r.qs && msg.id in r.qs && !r.qs.panel[msg.id]) r.qs[msg.id] = !!msg.on;
    else if (c.do === 'ringer' && r.qs) r.qs.ringer = msg.mode;
    else if (c.do === 'volume') { if (r.qs && msg.stream === 'media') r.qs.volume = msg.level; else r.volume = msg.level; }
    else if (c.do === 'bluetooth' || c.do === 'dnd') r[c.do] = msg.on;
    this.emit('change');
  }

  _name(m) {
    try {
      const n = this.peerName && this.peerName(m);
      if (n) return String(n);
    } catch (_) { /* fall back */ }
    const cur = this.link.current;
    return (cur && cur.name) || '';
  }

  async _asked(m) {
    if (!this.local || !DOS.includes(m.do)) return;
    if (m.do === 'ring') this.local.ringFrom = this._name(m);
    try {
      await this.local.do(m);
    } catch (e) {
      console.log('[devctl] ' + m.do + ': ' + e.message);
    }
    setTimeout(() => this._sendState(true), m.do === 'bluetooth' ? 1500 : 300); // the radio takes a moment
  }

  async _sendState(force) {
    if (!this.local || !this.sessionUp) return;
    const st = await this.local.state();
    const msg = { t: T.STATE, can: this.local.can(), ...st, ...(this.version ? { app: { v: this.version, f: AppInfo.mine() } } : {}) };
    const k = JSON.stringify(msg);
    if (!force && k === this.mine) return;
    this.mine = k;
    if (this.sessionUp) this.link.send(msg);
  }

  // The other side's TwinDesk against this one ({version, older, newer, missing}), null until it says.
  get app() {
    if (!this.remote || !this.version) return null;
    const cur = this.link.current;
    return AppInfo.check(this.version, this.remote.app, { phone: !!(cur && cur.os === 'android') });
  }

  // Once a session (and once per device and version while the app runs): 'outdated' {name, version,
  // missing, phone} when the other side is older than this one.
  _checkApp() {
    const a = this.app;
    if (!a || !a.older) return;
    const cur = this.link.current || {};
    const k = (cur.deviceId || cur.name || '') + '|' + a.version;
    if (this.told.has(k)) return;
    this.told.add(k);
    this.emit('outdated', { name: (this.peerName && this.peerName()) || cur.name || '', version: a.version, missing: a.missing, phone: cur.os === 'android' });
  }

  // For the state: the other side's (null until it says), with app: the version check.
  get view() {
    return this.remote ? { ...this.remote, appCheck: this.app } : null;
  }

  stop() {
    clearInterval(this.timer);
    if (this.local) this.local.stop();
  }
}

module.exports = { DevCtl, T };

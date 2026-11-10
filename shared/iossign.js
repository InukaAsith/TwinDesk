// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Signing TwinDesk for iPhone and iPad with the person's own Apple ID, and installing it (opt in;
// Mac, PC and Linux). The work is the signing helper's (ios-signer/: Apple's sign-in, the
// certificate, the signature, the install through the device's cable or Wi-Fi sync); this runs it
// and carries its conversation to whoever answers:
//
//   the iPhone  (the usual way). Its app keeps the signing state in its Keychain: Apple's
//               developer session (good for about a year, in place of the password), the
//               certificate's key and the anisette identity. For a refresh it seals them for the
//               helper (ios/TwinDesk/Core/Signer.swift), so this app, whose console goes to a log
//               file, only passes boxes along and never sees them. Any paired computer can do the
//               refresh, and none keeps a thing.
//   this window (the first install, or an app that expired and can't answer). The Apple ID and its
//               password are typed here, go to the helper's stdin and are gone when it ends; the
//               state it made is handed to the iPhone the next time its app is connected.
//   a kept copy (cfg.keep, off unless switched on behind a warning). This computer keeps the state
//               too, sealed by the system (vault), and refreshes without the iPhone's app: closed,
//               locked or expired. Never the password.
//
// Messages (shared/protocol.js): sign.state (what the iPhone holds), sign.info (what this side
// shows it), sign.start → sign.key → sign.box (a sealed run), sign.ev (the helper's events),
// sign.want (time to refresh), sign.keep (the state, to keep), sign.stop.
//
// link: on(type | 'welcome' | 'closed', fn), send(msg), current (the session's ctx: os, id, name).
// bins: where the helper may be (the first that exists). usbSerials(): UDIDs on a cable whose app
// is on this session (shared/iosnet.js). cfg()/setCfg(patch): {auto, days, keep, device: {phoneId: udid}}.
// vault: {load() → string, save(string)} sealed by the system, or null where it can't.
// Events: 'change' (this.view).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const T = {
  STATE: 'sign.state', INFO: 'sign.info', START: 'sign.start', KEY: 'sign.key', BOX: 'sign.box',
  EV: 'sign.ev', WANT: 'sign.want', KEEP: 'sign.keep', STOP: 'sign.stop',
};
const TWINDESK = /^com\.twindesk\.ios\.[A-Z0-9]{6,20}$/; // as signed: its bundle id and the team's
const LOOK_MS = 30 * 60 * 1000; // how often the devices and their apps are looked at
const AGAIN_MS = 6 * 3600 * 1000; // an automatic refresh that failed isn't tried again sooner
const MAX_LINE = 256 * 1024;
const MAX_STATE = 64 * 1024;
const MAX_IPA = 4 * 1024 * 1024 * 1024;
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const b64 = (v, n) => (typeof v === 'string' && v.length <= n && /^[A-Za-z0-9+/]+=*$/.test(v) ? v : '');

// A state as the helper gives it: short strings by name, nothing else.
function cleanState(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const out = {};
  let size = 0;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== 'string' || k.length > 200) return null;
    size += k.length + v.length;
    out[k] = v;
  }
  return size && size <= MAX_STATE ? out : null;
}

// What a state says without giving anything away: whose it is and how long its session lasts.
function stateFacts(state) {
  const until = Number(state && state.xcode_token_expiry) || 0;
  return { email: str(state && state.email, 200), until, signedIn: !!(state && state.xcode_token && until > Date.now()) };
}

class IosSign extends EventEmitter {
  // seed: a state made outside the app (ios-signer/try.sh), handed to the iPhone's app like one made here.
  // cacheDir: where the IPAs installed from here are kept (cfg.cache, on), so each can be signed again.
  constructor({ link, bins, usbSerials, cfg, setCfg, vault, seed, cacheDir }) {
    super();
    Object.assign(this, { link, usbSerials: usbSerials || (() => []), cfg, setCfg, vault: vault || null, cacheDir: cacheDir || '' });
    this.bin = (bins || []).find((b) => { try { return fs.statSync(b).isFile(); } catch { return false; } }) || '';
    this.info = null; // the helper's {anyIpa, anisette, version}
    this.devices = []; // [{udid, name, usb}]
    this.apps = {}; // udid -> [{bundleId, name, version, team, teamName, expires}]
    this.phone = null; // sign.state: {signedIn, email, until, auto}
    this.run = null; // {from: 'phone'|'here'|'kept', udid, step, percent, need, error, done, proc}
    this.last = null; // how the last run ended: {error} | {done}
    this.pending = null; // {udid, state}: made here, for the iPhone's app when it's connected
    this.tried = new Map(); // udid -> when an automatic refresh last started
    this.kept = this._loadKept(); // udid -> state
    this.ipa = ''; // an IPA chosen in this window for the next run (builds that install other apps)
    this.seed = cleanState(seed);
    this.stopped = false;

    link.on('welcome', () => { this.phone = null; this._look(); });
    link.on('closed', () => {
      this.phone = null;
      if (this.run && this.run.from === 'phone') this._end({ kind: 'gone', message: 'The iPhone disconnected' });
      this.emit('change');
    });
    const on = (t, fn) => link.on(t, (m) => this._ios() && m && typeof m === 'object' && fn(m));
    on(T.STATE, (m) => {
      this.phone = { signedIn: m.signedIn === true, email: str(m.email), until: Number(m.until) || 0, auto: m.auto !== false };
      this._handOver();
      this._tellPhone();
      this._auto();
      this.emit('change');
    });
    on(T.START, (m) => this._phoneStart(m));
    on(T.BOX, (m) => {
      const r = this.run;
      if (!r || r.from !== 'phone' || !r.proc) return;
      const box = b64(m.box, MAX_LINE);
      if (!box) return;
      const pub = b64(m.pub, 64);
      this._write(pub ? { pub, box } : { box });
    });
    on(T.KEEP, (m) => {
      // The iPhone's copy of the state, for this computer to keep: only when that was switched on here.
      const state = cleanState(m.state);
      const udid = this._udid();
      if (!state || !udid || !this.cfg().keep) return;
      this.kept[udid] = state;
      this._saveKept();
      this.emit('change');
    });
    on(T.STOP, () => { if (this.run && this.run.from === 'phone') this.stop(); });

    if (this.bin) {
      this._once({ op: 'info' }).then((v) => {
        if (v && v.ev === 'info') this.info = { anyIpa: v.anyIpa === true, anisette: str(v.anisette), version: str(v.version, 20) };
        this._look();
      });
      this.timer = setInterval(() => this._look(), LOOK_MS);
      if (this.timer.unref) this.timer.unref();
    }
  }

  _ios() { return !!(this.link.current && this.link.current.os === 'ios'); }

  // ---- what the pages show ----

  get view() {
    const c = this.cfg();
    const udid = this._udid();
    const r = this.run;
    return {
      available: !!this.info, anyIpa: !!(this.info && this.info.anyIpa), anisette: this.info ? this.info.anisette : '',
      auto: c.auto !== false, days: c.days || 3, keep: !!c.keep, canKeep: !!this.vault, cache: c.cache !== false,
      devices: this.devices, udid,
      apps: ((udid && this.apps[udid]) || []).map((a) => ({ ...a, cached: !!this._cached(a.bundleId) })),
      phone: this.phone,
      kept: udid && this.kept[udid] ? stateFacts(this.kept[udid]) : null,
      pending: !!(this.pending && this.pending.udid === udid),
      ipa: this.ipa ? path.basename(this.ipa) : '',
      run: r ? { from: r.from, step: r.step, percent: r.percent, need: r.need } : null,
      last: this.last,
    };
  }

  // The iPhone or iPad this session is with, among the ones the system sees: the one on the cable
  // the session runs through, the one picked for this phone before, or the only one there is.
  _udid() {
    const have = new Set(this.devices.map((d) => d.udid));
    const wired = this.usbSerials().find((u) => have.has(u));
    if (wired) return wired;
    const cur = this.link.current;
    const picked = cur && this._ios() ? (this.cfg().device || {})[cur.id] : this.cfg().alone;
    if (picked && have.has(picked)) return picked;
    return this.devices.length === 1 ? this.devices[0].udid : '';
  }

  // The IPA kept for an app, by its bundle id as installed ('' none).
  _cached(bundleId) {
    if (!this.cacheDir || !/^[A-Za-z0-9.-]{1,200}$/.test(bundleId || '')) return '';
    const f = path.join(this.cacheDir, `${bundleId}.ipa`);
    try { return fs.statSync(f).isFile() ? f : ''; } catch { return ''; }
  }

  // After an install: the IPA it came from is kept (or, TwinDesk's own release installed, its older copy goes).
  _cache(r, done) {
    if (!this.cacheDir || !/^[A-Za-z0-9.-]{1,200}$/.test(done.bundleId || '')) return;
    const to = path.join(this.cacheDir, `${done.bundleId}.ipa`);
    try {
      if (!r.ipa) return fs.rmSync(to, { force: true });
      if (this.cfg().cache === false || path.resolve(r.ipa) === to) return;
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.copyFileSync(r.ipa, to);
    } catch {}
  }

  _tellPhone() {
    if (!this._ios()) return;
    const v = this.view;
    this.link.send({
      t: T.INFO, available: v.available && !!v.udid, anyIpa: v.anyIpa, anisette: v.anisette, keep: v.keep, days: v.days,
      apps: v.apps, busy: !!v.run,
    });
  }

  _changed() {
    this._tellPhone();
    this.emit('change');
  }

  // ---- the helper ----

  // One question, one answer (info, devices, apps).
  _once(req) {
    return new Promise((resolve) => {
      let out = '';
      let p;
      try { p = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); } catch { return resolve(null); }
      const timer = setTimeout(() => p.kill(), 30000);
      p.stdout.on('data', (d) => { if (out.length < 4 * 1024 * 1024) out += d; });
      p.on('error', () => resolve(null));
      p.on('close', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch { resolve(null); }
      });
      p.stdin.on('error', () => {});
      p.stdin.end(`${JSON.stringify(req)}\n`);
    });
  }

  // The devices the system sees and what's sideloaded on the one this session is with.
  async _look() {
    if (!this.bin || this.stopped || this.looking) return;
    this.looking = true;
    try {
      const d = await this._once({ op: 'devices' });
      this.devices = d && Array.isArray(d.devices) ? d.devices.slice(0, 20).filter((x) => x && typeof x.udid === 'string' && /^[0-9A-Fa-f-]{20,64}$/.test(x.udid))
        .map((x) => ({ udid: x.udid, name: str(x.name, 80), usb: x.usb === true })) : [];
      const udid = this._udid();
      if (udid && this.seed && !this.pending) { this.pending = { udid, state: this.seed }; this.seed = null; this._handOver(); }
      if (udid) {
        const a = await this._once({ op: 'apps', udid });
        if (a && Array.isArray(a.apps)) {
          this.apps[udid] = a.apps.slice(0, 50).filter((x) => x && typeof x.bundleId === 'string').map((x) => ({
            bundleId: str(x.bundleId), name: str(x.name, 100), version: str(x.version, 40), team: str(x.team, 20), teamName: str(x.teamName, 100),
            expires: Number(x.expires) || 0, twindesk: TWINDESK.test(x.bundleId),
          })).sort((p, q) => p.expires - q.expires);
        }
      }
    } finally {
      this.looking = false;
    }
    this._changed();
    this._auto();
  }

  _write(obj) {
    const p = this.run && this.run.proc;
    if (p && p.stdin.writable) p.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  // A signing run: the request's first line in, its events out to onEvent until it ends.
  _start(run, req) {
    this.last = null;
    this.run = { step: 'start', percent: 0, need: null, ipa: req.ipa || '', ...run };
    const r = this.run;
    let buf = '';
    let p;
    try { p = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); } catch { return this._end({ kind: 'other', message: 'The signing helper didn’t start' }); }
    r.proc = p;
    p.stdin.on('error', () => {});
    p.on('error', () => { if (this.run === r) this._end({ kind: 'other', message: 'The signing helper didn’t start' }); });
    p.stdout.on('data', (d) => {
      buf += d;
      if (buf.length > MAX_LINE * 2) return p.kill();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let ev = null;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev && typeof ev.ev === 'string' && this.run === r) this._event(r, ev);
      }
    });
    p.on('close', () => { if (this.run === r) this._end(r.failed || (r.finished ? null : { kind: 'other', message: 'The signing helper stopped' }), r.finished); });
    p.stdin.write(`${JSON.stringify(req)}\n`);
    this._changed();
  }

  _event(r, ev) {
    const toPhone = r.from === 'phone';
    switch (ev.ev) {
      case 'key': if (toPhone) this.link.send({ t: T.KEY, pub: b64(ev.pub, 64) }); return;
      case 'step': r.step = str(ev.step, 20); r.need = null; break;
      case 'progress': r.step = 'install'; r.percent = Math.max(0, Math.min(100, Number(ev.percent) || 0)); break;
      case 'need2fa':
        r.need = { what: 'code', sms: ev.sms === true, error: str(ev.error), numbers: Array.isArray(ev.numbers) ? ev.numbers.slice(0, 10).map((n) => ({ id: Number(n.id) || 0, number: str(n.number, 40) })) : [] };
        break;
      case 'needcert':
        r.need = { what: 'cert', certs: Array.isArray(ev.certs) ? ev.certs.slice(0, 20).map((c) => ({ serial: str(c.serial, 80), name: str(c.name, 100), machine: str(c.machine, 100), expires: Number(c.expires) || 0 })) : [] };
        break;
      case 'state':
        if (toPhone) break; // sealed: the iPhone's to open
        this._gotState(r.udid, cleanState(ev.state));
        return;
      case 'done': r.finished = { expires: Number(ev.expires) || 0, bundleId: str(ev.bundleId), device: str(ev.device, 80) }; break;
      case 'error': r.failed = { kind: str(ev.kind, 20) || 'other', code: Number.isFinite(ev.code) ? ev.code : null, message: str(ev.message, 300), detail: str(ev.detail, 300) }; break;
      default: return;
    }
    // The iPhone gets the events as they are (its sealed state among them), cut to what it shows.
    if (toPhone) {
      const out = { t: T.EV, ev: ev.ev };
      if (ev.ev === 'state') out.box = b64(ev.box, MAX_LINE);
      else if (ev.ev === 'need2fa' || ev.ev === 'needcert') Object.assign(out, r.need);
      else if (ev.ev === 'done') Object.assign(out, r.finished);
      else if (ev.ev === 'error') Object.assign(out, r.failed);
      else Object.assign(out, { step: r.step, percent: r.percent });
      this.link.send(out);
    }
    // The helper's last word (its state came before it): the run is over, whatever it does next.
    if (r.finished || r.failed) return this._end(r.failed, r.finished);
    this._changed();
  }

  // A state made by a run answered here: for the iPhone's app (now, or when it connects) and, when
  // this computer keeps a copy, the vault.
  _gotState(udid, state) {
    if (!state || !udid) return;
    this.pending = { udid, state };
    if (this.cfg().keep && this.vault) {
      this.kept[udid] = state;
      this._saveKept();
    }
    this._handOver();
  }

  _handOver() {
    if (!this.pending || !this._ios() || this._udid() !== this.pending.udid) return;
    this.link.send({ t: T.KEEP, state: this.pending.state });
    this.pending = null;
    this.emit('handed');
  }

  _end(failed, done) {
    const r = this.run;
    if (!r) return;
    this.run = null;
    if (r.proc && r.proc.exitCode === null) r.proc.kill();
    if (!failed && done) this._cache(r, done);
    this.last = failed ? { error: failed, from: r.from } : { done: done || {}, from: r.from, at: Date.now() };
    if (failed && r.from === 'phone' && failed.kind === 'gone') this.last = null;
    this._changed();
    this._look();
  }

  // ---- runs ----

  _ipa(ipa) {
    // An IPA the person picked: a file of theirs ending in .ipa, as it is on disk.
    try {
      let p = String(ipa.path || '');
      if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
      const real = fs.realpathSync(path.resolve(p));
      const st = fs.statSync(real);
      const home = fs.realpathSync(os.homedir());
      if (!/\.ipa$/i.test(real) || !st.isFile() || st.size > MAX_IPA) return '';
      if (ipa.fromPhone && (!real.startsWith(home + path.sep) || (ipa.size && st.size !== ipa.size))) return '';
      return real;
    } catch {
      return '';
    }
  }

  _ready(reply) {
    const no = (message, kind = 'other') => { reply({ kind, message }); return ''; };
    if (!this.info) return no('The signing helper isn’t in this build');
    if (this.run) return no('A refresh is already running', 'busy');
    const udid = this._udid();
    if (!udid) return no(this.devices.length ? 'Choose which iPhone this is on the computer' : 'This computer doesn’t see the iPhone: connect its cable once and tap Trust', 'device');
    return udid;
  }

  // The iPhone asks for a refresh (or an install of a file it sent): sealed from here on.
  _phoneStart(m) {
    const fail = (e) => this.link.send({ t: T.EV, ev: 'error', ...e });
    const udid = this._ready(fail);
    if (!udid) return;
    const req = { op: 'install', sealed: true, udid };
    const again = this._cached(str(m.app)); // an app installed from here before, by its kept IPA
    if (again && this.info.anyIpa) req.ipa = again;
    else if (m.app) return fail({ kind: 'other', message: 'This computer doesn’t have that app’s IPA' });
    else if (m.ipa) {
      if (!this.info.anyIpa) return fail({ kind: 'other', message: 'This computer’s TwinDesk only installs TwinDesk' });
      req.ipa = this._ipa({ path: str(m.ipa.path, 1000), size: Number(m.ipa.size) || 0, fromPhone: true });
      if (!req.ipa) return fail({ kind: 'other', message: 'That file isn’t on the computer yet' });
    }
    this._start({ from: 'phone', udid }, req);
  }

  // Typed in this window: {email, password}. Nothing of it is kept.
  signIn({ email, password }) {
    const udid = this._ready((e) => { this.last = { error: e, from: 'here' }; this.emit('change'); });
    if (!udid) return;
    const req = { op: 'install', udid, email: str(email, 200), password: str(password, 500) };
    const known = (this.pending && this.pending.udid === udid && this.pending.state) || this.kept[udid];
    if (known) req.state = known; // the same certificate and identity as before
    if (this.ipa) req.ipa = this.ipa;
    this.ipa = '';
    this._start({ from: 'here', udid }, req);
  }

  // With this computer's kept copy, no iPhone app needed.
  refreshKept() {
    const udid = this._ready((e) => { this.last = { error: e, from: 'kept' }; this.emit('change'); });
    if (!udid) return;
    if (!this.kept[udid]) return;
    const req = { op: 'install', udid, state: this.kept[udid] };
    if (this.ipa) req.ipa = this.ipa;
    this.ipa = '';
    this._start({ from: 'kept', udid }, req);
  }

  // Refresh now, whichever way there is: the kept copy, or the iPhone's app.
  refresh() {
    const udid = this._udid();
    if (udid && this.kept[udid] && this.cfg().keep) return this.refreshKept();
    if (this._ios() && this.phone && this.phone.signedIn && !this.ipa) this.link.send({ t: T.WANT, now: true });
  }

  // One app again, from its kept IPA: with this computer's copy of the session, or by asking the iPhone.
  refreshApp(bundleId) {
    const file = this._cached(bundleId);
    const udid = this._udid();
    if (!file || !udid || this.run || !this.info || !this.info.anyIpa) return;
    this.tried.set(`${udid} ${bundleId}`, Date.now());
    if (this.cfg().keep && this.kept[udid] && stateFacts(this.kept[udid]).signedIn) { this.ipa = file; return this.refreshKept(); }
    if (this._ios() && this.phone && this.phone.signedIn) this.link.send({ t: T.WANT, now: true, app: bundleId });
  }

  // An IPA chosen in this window ('' none): the next run typed here, or with the kept copy, installs it.
  setIpa(file) {
    this.ipa = file && this.info && this.info.anyIpa ? this._ipa({ path: file }) : '';
    this.emit('change');
  }

  // One action from the window: {a: 'look' | 'set' | 'signin' | 'refresh' | 'answer' | 'stop' | 'ipa', …}.
  act(o) {
    if (!o || typeof o !== 'object') return;
    if (o.a === 'look') this.look();
    else if (o.a === 'set') this.set(o);
    else if (o.a === 'signin') this.signIn(o);
    else if (o.a === 'refresh') this.refresh();
    else if (o.a === 'answer') this.answer(o);
    else if (o.a === 'stop') this.stop();
    else if (o.a === 'ipa') this.setIpa('');
    else if (o.a === 'app') this.refreshApp(str(o.bundleId));
  }

  // An answer typed here to a run answered here: {code} | {sms} | {devices} | {resend} | {revoke: [serial]} | {abort}.
  answer(a) {
    const r = this.run;
    if (!r || r.from === 'phone' || !r.need || !a || typeof a !== 'object') return;
    const out = {};
    if (typeof a.code === 'string') out.code = a.code.replace(/\D/g, '').slice(0, 8);
    else if (Number.isInteger(a.sms)) out.sms = a.sms;
    else if (a.devices === true) out.devices = true;
    else if (a.resend === true) out.resend = true;
    else if (Array.isArray(a.revoke)) out.revoke = a.revoke.filter((s) => r.need.certs && r.need.certs.some((c) => c.serial === s));
    else out.abort = true;
    r.need = null;
    this._write(out);
    this.emit('change');
  }

  stop() {
    if (this.run) this._end({ kind: 'stopped', message: 'Stopped' });
  }

  // Time for it? TwinDesk on the device runs out within cfg.days: this computer's copy does it, or
  // the iPhone's app is asked (it decides: its own switch, and only while it's unlocked).
  _auto() {
    const c = this.cfg();
    const udid = this._udid();
    if (c.auto === false || this.run || !udid || !this.info) return;
    // TwinDesk, and every app whose IPA is kept here: the one that runs out first.
    const due = (this.apps[udid] || []).filter((a) => a.expires && (a.twindesk || this._cached(a.bundleId))
      && a.expires * 1000 - Date.now() <= (c.days || 3) * 86400000
      && Date.now() - (this.tried.get(`${udid} ${a.bundleId}`) || 0) >= AGAIN_MS)[0];
    if (!due) return;
    const viaPhone = this._ios() && this.phone && this.phone.signedIn && this.phone.auto;
    const viaCopy = c.keep && this.kept[udid] && stateFacts(this.kept[udid]).signedIn;
    if (!viaPhone && !viaCopy) return;
    if (this._cached(due.bundleId) && this.info.anyIpa) return this.refreshApp(due.bundleId);
    if (!due.twindesk) return;
    this.tried.set(`${udid} ${due.bundleId}`, Date.now());
    if (viaCopy) return this.refreshKept();
    this.link.send({ t: T.WANT });
  }

  // ---- settings ----

  set(o) {
    if (!o || typeof o !== 'object') return;
    const patch = {};
    if (typeof o.auto === 'boolean') patch.auto = o.auto;
    if (Number.isInteger(o.days) && o.days >= 1 && o.days <= 6) patch.days = o.days;
    if (typeof o.cache === 'boolean') {
      patch.cache = o.cache;
      if (!o.cache && this.cacheDir) { try { fs.rmSync(this.cacheDir, { recursive: true, force: true }); } catch {} } // switched off: the kept IPAs go
    }
    if (typeof o.keep === 'boolean' && (this.vault || !o.keep)) {
      patch.keep = o.keep;
      if (!o.keep) { this.kept = {}; this._saveKept(); } // switched off: this computer's copies go
    }
    if (typeof o.udid === 'string' && this.devices.some((d) => d.udid === o.udid)) {
      const cur = this.link.current;
      if (cur && this._ios()) patch.device = { ...(this.cfg().device || {}), [cur.id]: o.udid };
      else patch.alone = o.udid;
    }
    this.setCfg(patch);
    if (patch.keep && this._ios()) this._tellPhone(); // the iPhone sends its copy
    this._look();
    this._changed();
  }

  look() { this._look(); }

  _loadKept() {
    try {
      const o = JSON.parse((this.vault && this.vault.load()) || '{}');
      const out = {};
      for (const [k, v] of Object.entries(o)) { const s = cleanState(v); if (s) out[k] = s; }
      return out;
    } catch {
      return {};
    }
  }

  _saveKept() {
    if (this.vault) this.vault.save(Object.keys(this.kept).length ? JSON.stringify(this.kept) : '');
  }

  close() {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.run) this._end({ kind: 'stopped', message: 'Stopped' });
  }
}

module.exports = { IosSign, T, cleanState, stateFacts };

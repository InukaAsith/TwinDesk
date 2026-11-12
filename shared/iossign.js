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
//   a kept copy (cfg.keep, on unless switched off; only while the feature is on). This computer keeps the state
//               too, sealed by the system (vault), and refreshes without the iPhone's app: closed,
//               locked or expired. Never the password.
//
// Messages (shared/protocol.js): sign.state (what the iPhone holds), sign.info (what this side
// shows it), sign.start → sign.key → sign.box (a sealed run), sign.ev (the helper's events),
// sign.want (time to refresh), sign.keep (the state, to keep), sign.stop.
//
// Updates: the latest release is looked up (every 6 hours while this is on). When the TwinDesk on the
// device is older, Update TwinDesk (here, or on the iPhone: sign.start {update}) signs and installs
// the release's IPA, downloaded fresh, in place of the refresh's kept copy; the app's data stays.
// cfg.update: do that by itself (the same ways as a refresh: the kept copy, or the iPhone's app).
//
// link: on(type | 'welcome' | 'closed', fn), send(msg), current (the session's ctx: os, id, name).
// near: {list() → [{id, name, os}], invite(id)}: devices linked over Bluetooth (blepipe.js BleHost),
// for an iPhone that isn't in a session: an invite wakes TwinDesk there, which comes back (Ble.swift).
// bins: where the helper may be (the first that exists). usbSerials(): UDIDs on a cable whose app
// is on this session (shared/iosnet.js). cfg()/setCfg(patch): {auto, days, keep, device: {phoneId: udid}}.
// vault: {load() → string, save(string)} sealed by the system, or null where it can't.
// Events: 'change' (this.view).
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const T = {
  STATE: 'sign.state', INFO: 'sign.info', START: 'sign.start', KEY: 'sign.key', BOX: 'sign.box',
  EV: 'sign.ev', WANT: 'sign.want', KEEP: 'sign.keep', STOP: 'sign.stop', SET: 'sign.set',
};
const TWINDESK = /^com\.twindesk\.ios\.[A-Z0-9]{6,20}$/; // as signed: its bundle id and the team's
const TWINDESK_IPA = 'TwinDesk.ipa'; // TwinDesk's own IPA in the kept IPAs (cacheDir)
const LOOK_MS = 30 * 60 * 1000; // how often the devices and their apps are looked at
const RETRY_HOURS = [1, 3, 6, 12, 24]; // an automatic refresh isn't tried again sooner (cfg.retry)
const INVITE_MS = 60 * 1000; // an iPhone near over Bluetooth is invited at most this often for a refresh
const DEVICE_WAIT_MS = 30 * 1000; // a refresh the iPhone asked for waits this long for the system to see it
const MAX_LINE = 256 * 1024;
const MAX_STATE = 64 * 1024;
const MAX_IPA = 4 * 1024 * 1024 * 1024;
const RELEASE_API = 'https://api.github.com/repos/InukaAsith/TwinDesk/releases/latest';
const RELEASE_MS = 6 * 60 * 60 * 1000;
const { compare } = require('./updates.js');
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
  constructor({ link, near, bins, usbSerials, cfg, setCfg, vault, seed, cacheDir }) {
    super();
    Object.assign(this, { link, near: near || null, usbSerials: usbSerials || (() => []), cfg, setCfg, vault: vault || null, cacheDir: cacheDir || '' });
    this.bin = (bins || []).find((b) => { try { return fs.statSync(b).isFile(); } catch { return false; } }) || '';
    this.info = null; // the helper's {anyIpa, anisette, version}
    this.devices = []; // [{udid, name, usb}]
    this.apps = {}; // udid -> [{bundleId, name, version, team, teamName, expires}]
    this.phone = null; // sign.state: {signedIn, email, until, auto}
    this.run = null; // {from: 'phone'|'here'|'kept', udid, step, percent, need, error, done, proc}
    this.last = null; // how the last run ended: {error} | {done}
    this.pending = null; // {udid, state}: made here, for the iPhone's app when it's connected
    this.tried = new Map(); // udid -> when an automatic refresh last started
    this._kept = null; // udid -> state, read from the vault the first time it's needed (kept)
    this.only = ''; // refreshKept: the app it refreshes (its kept IPA in this.ipa, or noIpa)
    this.noIpa = false;
    this.switched = false; // on/off was just changed here: said to the iPhone once (sign.info)
    this.queued = null; // a refresh asked for while the iPhone was only near: {now, app}, sent once it connects
    this.invitedAt = 0;
    this.ipa = ''; // an IPA chosen in this window for the next run (builds that install other apps)
    this.seed = cleanState(seed);
    this.stopped = false;
    this.latest = ''; // TwinDesk's latest release ('' not known yet)
    this.latestAt = 0;

    link.on('welcome', () => { this.phone = null; this._look(); });
    link.on('closed', () => {
      this.phone = null;
      if (this.run && this.run.from === 'phone') this._end({ kind: 'gone', message: 'The iPhone disconnected' });
      this.emit('change');
    });
    const on = (t, fn) => link.on(t, (m) => this._ios() && m && typeof m === 'object' && fn(m));
    on(T.STATE, (m) => {
      this.phone = { signedIn: m.signedIn === true, email: str(m.email), until: Number(m.until) || 0, auto: m.auto !== false, expires: Number(m.expires) || 0 };
      this._handOver();
      if (this.queued && this.phone.signedIn) { this._want(this.queued); this.queued = null; }
      this._tellPhone();
      this._auto();
      this.emit('change');
    });
    on(T.START, (m) => this._phoneStart(m));
    // Switched on or off in the iPhone's app (after its own warning): the same here, so the two agree.
    on(T.SET, (m) => { if (m && typeof m.on === 'boolean') this.set({ on: m.on }, { fromPhone: true }); });
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
      if (!state || !udid || !this._keep()) return;
      this._putKept(udid, state);
      this.emit('change');
    });
    on(T.STOP, () => { if (this.run && this.run.from === 'phone') this.stop(); });

    // Off: the helper isn't run at all (not even to ask what it can do). On: it is, now and then.
    if (this.bin && this.cfg().on === true) this._boot();
  }

  _boot() {
    if (this.booted || !this.bin || this.stopped) return;
    this.booted = true;
    this._once({ op: 'info' }).then((v) => {
      if (v && v.ev === 'info') this.info = { anyIpa: v.anyIpa === true, anisette: str(v.anisette), version: str(v.version, 20) };
      else this.booted = false; // tried again when switched on again
      this._look();
    });
    this._release();
    if (!this.timer) {
      this.timer = setInterval(() => this._look(), LOOK_MS);
      if (this.timer.unref) this.timer.unref();
    }
  }

  // The latest release's version, for Update TwinDesk (looked up at most every 6 hours).
  async _release(force = false) {
    if (this.cfg().on !== true || this.releasing || (!force && Date.now() - this.latestAt < RELEASE_MS)) return;
    this.releasing = true;
    try {
      let f = (url, o) => fetch(url, o);
      try { const { net } = require('electron'); if (net && net.fetch) f = (url, o) => net.fetch(url, o); } catch {}
      const res = await f(`${RELEASE_API}?_=${Date.now()}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'TwinDesk' }, cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const r = await res.json();
        const v = String(r.tag_name || '').replace(/^v/i, '');
        if (/^\d+(\.\d+)*/.test(v)) { this.latest = v.slice(0, 40); this.latestAt = Date.now(); }
      }
    } catch {} finally {
      this.releasing = false;
    }
    this._changed();
    this._auto();
  }

  // TwinDesk on this device, when a newer release is out: {version, latest}; null otherwise.
  _update(udid) {
    const app = (this.apps[udid] || []).find((a) => a.twindesk);
    return app && this.latest && app.version && compare(this.latest, app.version) > 0 ? { bundleId: app.bundleId, version: app.version, latest: this.latest } : null;
  }

  _ios() { return !!(this.link.current && this.link.current.os === 'ios'); }

  // This computer's copies, from the vault (sealed by the system: the Keychain on a Mac). Read only
  // with Keep a copy on, so the system isn't asked for the vault at all otherwise.
  get kept() {
    if (!this._kept) this._kept = this._keep() ? this._loadKept() : {};
    return this._kept;
  }

  set kept(v) { this._kept = v; }

  // What the window and the timers need about a kept copy (the Apple ID, how long the session lasts)
  // is kept in the plain settings, so the vault itself (a Keychain prompt on a Mac) is only opened
  // when a refresh actually uses the copy, or a new one is stored.
  _factsOf(udid) {
    if (!udid || !this._keep()) return null;
    const all = this.cfg().keptFacts;
    if (all && typeof all === 'object') return all[udid] || null;
    if (this._kept) return this._kept[udid] ? stateFacts(this._kept[udid]) : null;
    // Kept before these facts were: there is a copy when the vault file is there.
    return this.vault && this.vault.exists && this.vault.exists() ? { signedIn: true, email: '', until: 0 } : null;
  }

  _hasKept(udid) { return !!this._factsOf(udid); }

  // A state to keep: the vault is written only when it changed (the iPhone sends its copy each time).
  _putKept(udid, state) {
    const h = crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
    if ((this.cfg().keptHash || {})[udid] === h) return;
    this.kept[udid] = state;
    this._saveKept();
  }

  // Keep a copy: on by default, but only ever while TwinDesk iPhone is on and there is a vault.
  _keep() {
    const c = this.cfg();
    return c.on === true && c.keep !== false && this._vaultOk();
  }

  // A vault this computer can use. vault.possible may ask the system (Linux: the login keyring), so
  // it is read only while TwinDesk iPhone is on.
  _vaultOk() { return !!this.vault && this.vault.possible !== false; }

  // iPhones linked over Bluetooth (paired with this computer, not in a session here).
  _near() {
    try {
      const cur = this.link.current;
      return ((this.near && this.near.list()) || []).filter((d) => d && d.os === 'ios' && !(cur && cur.id === d.id)).map((d) => ({ id: str(d.id, 64), name: str(d.name, 80) }));
    } catch {
      return [];
    }
  }

  _invite() {
    if (!this.near || Date.now() - this.invitedAt < INVITE_MS) return false;
    const list = this._near();
    if (!list.length) return false;
    this.invitedAt = Date.now();
    for (const d of list) { try { this.near.invite(d.id); } catch {} }
    return true;
  }

  // The iPhone's app is asked for a refresh: now (Refresh now here), or by itself (cfg.how: 'ask'
  // shows a notification there to tap; 'self' refreshes while it's unlocked, else the notification).
  _want({ now = false, app = '', expires = 0, update = '' } = {}) {
    const c = this.cfg();
    const m = { t: T.WANT, ask: c.how === 'ask', name: '' };
    if (now) m.now = true;
    if (update) { m.update = update; m.name = 'TwinDesk'; } // update: the version it goes to
    if (app) {
      m.app = app;
      const a = Object.values(this.apps).flat().find((x) => x.bundleId === app);
      if (a) m.name = a.name;
    }
    if (expires) m.expires = expires;
    this.link.send(m);
  }

  // ---- what the pages show ----

  get view() {
    const c = this.cfg();
    const udid = this._udid();
    const r = this.run;
    return {
      // available: this build has the helper (known without running it); ready: it answered.
      on: c.on === true, available: !!this.bin, ready: !!this.info, anyIpa: !!(this.info && this.info.anyIpa), anisette: this.info ? this.info.anisette : '',
      auto: c.auto !== false, days: c.days || 3, how: c.how === 'ask' ? 'ask' : 'self', which: c.which === 'twindesk' ? 'twindesk' : 'all',
      retry: RETRY_HOURS.includes(c.retry) ? c.retry : 6, retries: RETRY_HOURS,
      keep: c.keep !== false && (c.on === true ? this._vaultOk() : !!this.vault), canKeep: c.on === true ? this._vaultOk() : !!this.vault, cache: c.cache !== false,
      devices: this.devices, udid, near: c.on === true ? this._near() : [],
      session: this._ios() ? { id: str(this.link.current.id, 64), name: str(this.link.current.name, 80) } : null,
      apps: ((udid && this.apps[udid]) || []).map((a) => ({ ...a, cached: !!this._cached(a.bundleId) })),
      phone: this.phone,
      kept: this._factsOf(udid),
      pending: !!(this.pending && this.pending.udid === udid),
      ids: this.ids || null, twindeskIpa: !!this._twindeskIpa(udid),
      update: this._update(udid), latest: this.latest, autoUpdate: c.update === true,
      ipa: this.ipa ? path.basename(this.ipa) : '',
      run: r ? { from: r.from, step: r.step, percent: r.percent, need: r.need, seen: r.seen.slice(), note: r.note || '', ipa: r.ipa ? path.basename(r.ipa) : '' } : null,
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
    // A TwinDesk build installed from a file becomes the TwinDesk this computer refreshes with.
    const to = path.join(this.cacheDir, TWINDESK.test(done.bundleId) ? TWINDESK_IPA : `${done.bundleId}.ipa`);
    try {
      if (!r.ipa) return; // TwinDesk from the kept copy, or downloaded and kept by the helper
      if (this.cfg().cache === false || path.resolve(r.ipa) === to) return;
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.copyFileSync(r.ipa, to);
    } catch {}
  }

  _tellPhone() {
    if (!this._ios()) return;
    const v = this.view;
    this.link.send({
      // Available once switched on here: the device is looked for when a refresh starts (it may be
      // seen over Wi-Fi only then). seen: the system sees it now (cable or Wi-Fi sync).
      // on: switched on here (the iPhone's app follows it); switched: just now, by the person here
      // (only then does an iPhone that is on follow it off).
      on: v.on, switched: this.switched,
      t: T.INFO, available: v.on && v.ready, seen: !!v.udid, anyIpa: v.anyIpa, anisette: v.anisette, keep: v.on && v.keep, days: v.days,
      apps: v.apps, busy: !!v.run, latest: v.latest, autoUpdate: v.autoUpdate,
    });
  }

  _changed() {
    this._tellPhone();
    this.switched = false;
    this.emit('change');
  }

  // ---- the helper ----

  // One question, one answer (info, devices, apps).
  async _once(req) {
    const all = await this._lines(req);
    return all.length ? all[all.length - 1] : null;
  }

  // Every line a short request answers with (appids: the state, then the list).
  _lines(req) {
    return new Promise((resolve) => {
      let out = '';
      let p;
      try { p = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); } catch { return resolve([]); }
      const timer = setTimeout(() => p.kill(), 30000);
      p.stdout.on('data', (d) => { if (out.length < 4 * 1024 * 1024) out += d; });
      p.on('error', () => resolve([]));
      p.on('close', () => {
        clearTimeout(timer);
        resolve(out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && typeof x === 'object'));
      });
      p.stdin.on('error', () => {});
      p.stdin.end(`${JSON.stringify(req)}\n`);
    });
  }

  // The Apple ID's app IDs, read with this computer's copy of the session (nothing is changed at Apple).
  async listIds() {
    const udid = this._udid();
    const state = this._hasKept(udid) ? this.kept[udid] : null;
    if (!this.info || this.idsBusy) return;
    if (!state) { this.ids = { error: 'View app IDs needs the developer session stored on this computer' }; return this._changed(); }
    this.idsBusy = true;
    this.ids = { loading: true };
    this._changed();
    try {
      const out = await this._lines({ op: 'appids', state });
      const st = out.find((x) => x.ev === 'state');
      if (st && cleanState(st.state) && this._keep()) this._putKept(udid, cleanState(st.state));
      const v = out[out.length - 1] || {};
      this.ids = v.ev === 'appids' ? {
        at: Date.now(), team: str(v.team, 20), teamName: str(v.teamName, 100),
        max: Number.isFinite(v.max) ? v.max : null, available: Number.isFinite(v.available) ? v.available : null,
        list: (Array.isArray(v.ids) ? v.ids : []).slice(0, 200).map((a) => ({ id: str(a.id, 200), name: str(a.name, 100), expires: Number(a.expires) || 0 })),
      } : { error: str(v.message, 300) || 'Apple didn’t answer' };
    } finally {
      this.idsBusy = false;
    }
    this._changed();
  }

  // TwinDesk's own IPA as this computer keeps it (Store IPAs on): the last release downloaded, or a
  // build installed from a file. The helper checks it is TwinDesk before using it.
  _twindeskIpa(udid) {
    if (!this.cacheDir || this.cfg().cache === false) return '';
    const f = path.join(this.cacheDir, TWINDESK_IPA);
    try { if (fs.statSync(f).isFile()) return f; } catch {}
    return this._cached(((this.apps[udid] || []).find((a) => a.twindesk) || {}).bundleId);
  }

  // A refresh of an app that is on the device: the helper installs Apple's new profiles only, and
  // signs and installs the app again only when that can't be done (AltStore refreshes the same way).
  _refreshOnly(req, udid, bundleId) {
    const apps = this.apps[udid] || [];
    const app = bundleId ? apps.find((a) => a.bundleId === bundleId) : apps.find((a) => a.twindesk);
    if (app) req.profile_only = app.bundleId;
    return req;
  }

  // A run that installs TwinDesk itself: from the kept copy, else downloaded and then kept.
  // fresh (an update, or a kept copy older than the TwinDesk on the device would be): the latest
  // release is downloaded, and kept in place of the old copy.
  _twinDesk(req, udid, fresh = false) {
    const kept = fresh || this._update(udid) ? '' : this._twindeskIpa(udid);
    if (kept) req.twindesk_ipa = kept;
    else if (this.cacheDir && this.cfg().cache !== false) req.save_ipa = path.join(this.cacheDir, TWINDESK_IPA);
    return req;
  }

  // The devices the system sees and what's sideloaded on the one this session is with.
  async _look() {
    if (!this.bin || this.stopped || this.looking) return;
    if (this.cfg().on !== true) { this.devices = []; this.apps = {}; return this._changed(); } // off: nothing is looked at
    this.looking = true;
    this._release(); // at most every 6 hours
    try {
      const d = await this._once({ op: 'devices' });
      this.devices = d && Array.isArray(d.devices) ? d.devices.slice(0, 20).filter((x) => x && typeof x.udid === 'string' && /^[0-9A-Fa-f-]{20,64}$/.test(x.udid))
        .map((x) => ({ udid: x.udid, name: str(x.name, 80), usb: x.usb === true, wifi: !!x.ip })) : [];
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
    this.run = { step: 'start', percent: 0, need: null, seen: [], ipa: req.ipa || '', ...run };
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
      case 'step': r.step = str(ev.step, 20); r.percent = 0; r.need = null; if (!r.seen.includes(r.step)) r.seen.push(r.step); break;
      case 'progress': {
        const step = str(ev.step, 20) || 'install';
        if (step !== r.step) { r.step = step; r.need = null; if (!r.seen.includes(step)) r.seen.push(step); }
        r.percent = Math.max(0, Math.min(100, Number(ev.percent) || 0));
        break;
      }
      case 'need2fa':
        r.need = { what: 'code', sms: ev.sms === true, error: str(ev.error), numbers: Array.isArray(ev.numbers) ? ev.numbers.slice(0, 10).map((n) => ({ id: Number(n.id) || 0, number: str(n.number, 40) })) : [] };
        break;
      case 'needcert':
        // Any of them may be revoked, when the person picks it: another tool's only after a warning.
        r.need = { what: 'cert', certs: Array.isArray(ev.certs) ? ev.certs.slice(0, 20).map((c) => ({ serial: str(c.serial, 80), name: str(c.name, 100), machine: str(c.machine, 100), expires: Number(c.expires) || 0, ours: c.ours === true || c.machine === 'TwinDesk' })) : [] };
        break;
      case 'state':
        if (toPhone) break; // sealed: the iPhone's to open
        this._gotState(r.udid, cleanState(ev.state));
        return;
      case 'note': r.note = str(ev.message, 300); this._changed(); return; // said on this page only
      case 'done': r.finished = { expires: Number(ev.expires) || 0, bundleId: str(ev.bundleId), device: str(ev.device, 80), profileOnly: ev.profileOnly === true }; break;
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
    if (this._keep()) this._putKept(udid, state);
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
    if (!failed && done) {
      this._cache(r, done);
      // The device this iPhone's app is on, for the next time it isn't on its cable.
      const cur = this.link.current;
      if (r.from === 'phone' && cur && cur.id && this._ios() && r.udid) this.setCfg({ device: { ...(this.cfg().device || {}), [cur.id]: r.udid } });
    }
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
    if (this.cfg().on !== true) return no('TwinDesk iPhone is off on this computer');
    if (this.run) return no('A refresh is already running', 'busy');
    const udid = this._udid();
    if (!udid) return no(this.devices.length ? 'Choose which iPhone this is on the computer' : 'This computer doesn’t see the iPhone: connect its cable once and tap Trust', 'device');
    return udid;
  }

  // The iPhone asks for a refresh (or an install of a file it sent): sealed from here on.
  // The iPhone just came to the front for it (a notification tapped): the system may see it over
  // Wi-Fi only a moment later, so it's looked for a while first.
  async _phoneStart(m) {
    const fail = (e) => this.link.send({ t: T.EV, ev: 'error', ...e });
    const until = Date.now() + DEVICE_WAIT_MS;
    while (this.info && this.cfg().on === true && !this.run && !this._udid() && this._ios() && Date.now() < until) {
      this.link.send({ t: T.EV, ev: 'step', step: 'find', percent: 0 });
      await this._look();
      if (!this._udid()) await new Promise((res) => setTimeout(res, 4000));
    }
    const udid = this._ready(fail);
    if (!udid) return;
    const req = { op: 'install', sealed: true, udid };
    if (m.fresh === true) req.new_cert = true; // Start over, from the iPhone: TwinDesk's certificate revoked, a new one made
    // An app installed from here before, by its kept IPA; TwinDesk itself too when its IPA is kept
    // (a build installed from a file stays that build), else TwinDesk's latest release.
    const again = m.app ? this._cached(str(m.app)) : '';
    if (m.update === true && !m.app && !m.ipa) this._twinDesk(req, udid, true); // Update TwinDesk: the release, signed and installed
    else if (!m.app && !m.ipa) { this._twinDesk(req, udid); this._refreshOnly(req, udid); }
    else if (again && this.info.anyIpa) { req.ipa = again; this._refreshOnly(req, udid, str(m.app)); }
    else if (m.app && this.info.anyIpa && (this.apps[udid] || []).some((a) => a.bundleId === str(m.app))) { req.no_ipa = true; this._refreshOnly(req, udid, str(m.app)); }
    else if (m.app) return fail({ kind: 'other', message: 'That app isn’t on the device' });
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
    const known = (this.pending && this.pending.udid === udid && this.pending.state) || (this._hasKept(udid) ? this.kept[udid] : null);
    if (known) req.state = known; // the same certificate and identity as before
    if (this.ipa) req.ipa = this.ipa;
    else this._twinDesk(req, udid);
    this.ipa = '';
    this._start({ from: 'here', udid }, req);
  }

  // With this computer's kept copy, no iPhone app needed.
  refreshKept({ update = false } = {}) {
    const udid = this._ready((e) => { this.last = { error: e, from: 'kept' }; this.emit('change'); });
    if (!udid) return;
    if (!this.kept[udid]) return;
    if (!this.cfg().keptFacts) this._saveFacts(); // a copy kept before the facts were
    const req = { op: 'install', udid, state: this.kept[udid] };
    if (update) {
      this._twinDesk(req, udid, true);
      this._start({ from: 'kept', udid, update: true }, req);
      return;
    }
    if (this.ipa) req.ipa = this.ipa;
    else if (this.noIpa) req.no_ipa = true;
    else this._twinDesk(req, udid);
    if (!this.ipa || this.only) this._refreshOnly(req, udid, this.only); // a new IPA chosen: installed as it is
    this.ipa = '';
    this.only = '';
    this.noIpa = false;
    this._start({ from: 'kept', udid }, req);
  }

  // Refresh now, whichever way there is: the kept copy, or the iPhone's app.
  refresh() {
    const udid = this._udid();
    if (this._hasKept(udid)) return this.refreshKept();
    if (this._ios() && this.phone && this.phone.signedIn && !this.ipa) return this._want({ now: true });
    // The iPhone is only near over Bluetooth: it's invited, and asked once it's back.
    if (!this._ios() && this._near().length) {
      this.queued = { now: true };
      this.invitedAt = 0;
      this._invite();
      this.last = { info: 'Waking TwinDesk on the iPhone over Bluetooth…' };
      this.emit('change');
    }
  }

  // Update TwinDesk on the device to the latest release: this computer's copy, or the iPhone's app.
  updateTwinDesk() {
    const udid = this._udid();
    if (this.run || !this.info || !this._update(udid)) return;
    this.tried.set(`${udid} update`, Date.now());
    if ((this._factsOf(udid) || {}).signedIn) return this.refreshKept({ update: true });
    if (this._ios() && this.phone && this.phone.signedIn) this._want({ now: true, update: this.latest });
  }

  // One app again, from its kept IPA: with this computer's copy of the session, or by asking the iPhone.
  // Without its IPA too: a refresh installs Apple's new profiles only, and the IPA is needed only
  // when the app has to be signed again (the helper says so then).
  refreshApp(bundleId) {
    const file = this._cached(bundleId);
    const udid = this._udid();
    if (!udid || this.run || !this.info || !this.info.anyIpa || !(this.apps[udid] || []).some((a) => a.bundleId === bundleId)) return;
    this.tried.set(`${udid} ${bundleId}`, Date.now());
    if ((this._factsOf(udid) || {}).signedIn) { this.ipa = file; this.only = bundleId; this.noIpa = !file; return this.refreshKept(); }
    if (this._ios() && this.phone && this.phone.signedIn) this._want({ now: true, app: bundleId });
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
    else if (o.a === 'update') this.updateTwinDesk();
    else if (o.a === 'release') this._release(true);
    else if (o.a === 'answer') this.answer(o);
    else if (o.a === 'stop') this.stop();
    else if (o.a === 'ipa') this.setIpa('');
    else if (o.a === 'app') this.refreshApp(str(o.bundleId));
    else if (o.a === 'appids') this.listIds();
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
    else if (Array.isArray(a.revoke)) out.revoke = a.revoke.filter((s) => r.need.certs && r.need.certs.some((c) => c.serial === s)); // another tool's only after its warning (the window's dialog)
    else out.abort = true;
    r.need = null;
    this._write(out);
    this.emit('change');
  }

  stop() {
    if (this.run) this._end({ kind: 'stopped', message: 'Stopped' });
  }

  // Time for it? An app runs out within cfg.days (TwinDesk, and with cfg.which 'all' every app whose
  // IPA is kept here): this computer's copy does it, or the iPhone's app is asked (it decides: its
  // own switch, cfg.how, and only while it's unlocked). Not in a session but near over Bluetooth:
  // invited, and asked once it's back.
  _auto() {
    const c = this.cfg();
    if (c.on !== true || c.auto === false || this.run || !this.info) return;
    const udid = this._udid();
    const soon = (expires) => expires && expires * 1000 - Date.now() <= (c.days || 3) * 86400000;
    const again = (RETRY_HOURS.includes(c.retry) ? c.retry : 6) * 3600 * 1000;
    const rested = (key) => Date.now() - (this.tried.get(key) || 0) >= again;
    const apps = udid ? this.apps[udid] || [] : [];
    // Update TwinDesk by itself (cfg.update): before any refresh, as installing the release refreshes it too.
    if (c.update === true && this._update(udid) && rested(`${udid} update`)) {
      const viaCopy = !!(this._factsOf(udid) || {}).signedIn;
      const viaPhone = this._ios() && this.phone && this.phone.signedIn && this.phone.auto;
      if (viaCopy || viaPhone) {
        this.tried.set(`${udid} update`, Date.now());
        if (viaCopy) return this.refreshKept({ update: true });
        return this._want({ update: this.latest });
      }
    }
    const due = apps.filter((a) => soon(a.expires) && (a.twindesk || (c.which !== 'twindesk' && this._cached(a.bundleId))) && rested(`${udid} ${a.bundleId}`))[0];
    // The system doesn't see the device (no cable, no Wi-Fi sync right now), but the iPhone said
    // when its TwinDesk runs out: asked anyway, as it comes to the front for it and is seen then.
    const phoneDue = !udid && this._ios() && this.phone && soon(this.phone.expires) && rested(`phone ${this.link.current.id}`);
    if (!due && !phoneDue) {
      // Not in a session: an iPhone near over Bluetooth is woken when this computer has a copy of
      // its apps' dates and one is due (its session then comes back, and with it this check).
      if (!this._ios() && Object.values(this.apps).flat().some((a) => a.twindesk && soon(a.expires))) this._invite();
      return;
    }
    const viaPhone = this._ios() && this.phone && this.phone.signedIn && this.phone.auto;
    const viaCopy = !!(this._factsOf(udid) || {}).signedIn;
    if (!viaPhone && !viaCopy) return;
    if (phoneDue) {
      this.tried.set(`phone ${this.link.current.id}`, Date.now());
      return this._want({ expires: this.phone.expires });
    }
    if (!due.twindesk && this.info.anyIpa) {
      this.tried.set(`${udid} ${due.bundleId}`, Date.now());
      const file = this._cached(due.bundleId);
      if (viaCopy) { this.ipa = file; this.only = due.bundleId; this.noIpa = !file; return this.refreshKept(); }
      return this._want({ app: due.bundleId, expires: due.expires });
    }
    if (!due.twindesk) return;
    this.tried.set(`${udid} ${due.bundleId}`, Date.now());
    if (viaCopy) return this.refreshKept();
    this._want({ expires: due.expires });
  }

  // ---- settings ----

  set(o, { fromPhone = false } = {}) {
    if (!o || typeof o !== 'object') return;
    const patch = {};
    if (typeof o.on === 'boolean') {
      patch.on = o.on;
      if (!fromPhone && o.on !== (this.cfg().on === true)) this.switched = true;
      if (o.on) setImmediate(() => this._boot());
      else if (this.run) this._end({ kind: 'stopped', message: 'Stopped' });
      if (!o.on) { this._kept = {}; this._saveKept(); this.pending = null; this.queued = null; } // off: nothing of it stays here (the Keep a copy setting does)
    }
    if (typeof o.auto === 'boolean') patch.auto = o.auto;
    if (typeof o.update === 'boolean') patch.update = o.update;
    if (Number.isInteger(o.days) && o.days >= 1 && o.days <= 6) patch.days = o.days;
    if (o.how === 'ask' || o.how === 'self') patch.how = o.how;
    if (o.which === 'all' || o.which === 'twindesk') patch.which = o.which;
    if (RETRY_HOURS.includes(o.retry)) { patch.retry = o.retry; this.tried.clear(); }
    if (typeof o.cache === 'boolean') {
      patch.cache = o.cache;
      if (!o.cache && this.cacheDir) { try { fs.rmSync(this.cacheDir, { recursive: true, force: true }); } catch {} } // switched off: the kept IPAs go
    }
    if (typeof o.keep === 'boolean' && (this._vaultOk() || !o.keep)) {
      patch.keep = o.keep;
      if (!o.keep) { this._kept = {}; this._saveKept(); } // switched off: this computer's copies go
    }
    if (typeof o.udid === 'string' && this.devices.some((d) => d.udid === o.udid)) {
      const cur = this.link.current;
      if (cur && cur.id && this._ios()) patch.device = { ...(this.cfg().device || {}), [cur.id]: o.udid };
      else patch.alone = o.udid;
    }
    this.setCfg(patch);
    if ((patch.keep || patch.on) && this._keep() && this._ios()) this._tellPhone(); // the iPhone sends its copy
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

  _saveFacts() {
    const kept = this._kept || {};
    const facts = {};
    const hash = {};
    for (const [u, st] of Object.entries(kept)) {
      facts[u] = stateFacts(st);
      hash[u] = crypto.createHash('sha256').update(JSON.stringify(st)).digest('hex');
    }
    this.setCfg({ keptFacts: facts, keptHash: hash });
  }

  _saveKept() {
    if (!this.vault) return;
    const kept = this._kept || {};
    this._saveFacts();
    this.vault.save(Object.keys(kept).length ? JSON.stringify(kept) : '');
  }

  close() {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.run) this._end({ kind: 'stopped', message: 'Stopped' });
  }
}

module.exports = { IosSign, T, cleanState, stateFacts };

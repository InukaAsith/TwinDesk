// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume (Mac, PC and Linux, with a computer or a phone): what is in use on one device, to go on
// with on the other. A browser tab (its address), a document (its file, sent when it's taken), a
// phone app (opened here in a phone window, Mirror apps), or, between two computers, the app's own
// window (streamed from there into a window here, as the Apps tab does). Off until turned on; nothing
// is read and no permission is asked before that.
//   Allowlists: the apps whose documents were offered (fileApps) and whose windows were (windowApps)
//   are kept in the settings with a switch each and how often they went; an app found for the first
//   time is let through or not as newFiles / newWindows say. windows (off by default) turns window
//   sharing on both ways; off, nothing is offered or taken and the streams stop. A browser always
//   sends its tab's link (a video's with the time it is at), never its window.
//   Documents: a copy by default, kept in a cache folder here that is emptied when TwinDesk quits;
//   with live on (both sides), the file itself, shared for the time of the session (shared/rzlive.js)
//   and opened there, so what is saved there is saved here. A document whose app's window may go too
//   asks how to open it (pick(): Preview, a copy; Edit, the file itself; Window).
//   Offering: while the other side's rz.policy says on, what is in front here is looked at every
//   POLL_MS (detect(): a platform's activity.js) and offered once it stayed STABLE_MS (rz.offer),
//   kept until something else is in front or TTL_MS went by. push() sends it on purpose (the tray's
//   Send to), and the other side opens it at once.
//   Taking: the other side's offer is kept (view().incoming) for the tray, the taskbar, a
//   notification and the tabs (shared/rezume-shelf.js, ui-rezume.js); take() opens it here: a
//   tab in the default browser (http and https only), a document once its file came (file.offer
//   drop 'rezume', which the receivers take only when they asked: expectFile), a phone app in a
//   window. A phone that can't say what is in front (no Accessibility) is asked through wireless
//   debugging instead (adb().front), and a tab sent to it opens there through it (adb().openUrl).
// opts: link {on(t, fn), send(m), peer() → {os, name} | null, welcome(fn), closed(fn)}, cfg() →
//   settings.rezume, save() (the records changed), detect() → activity | null (kind 'web', 'doc',
//   or 'app': only the app in front), appIcon(app) → data: URL, open {url(u), file(p),
//   phoneApp(pkg, name)}, sendFile(path, batch) → bool, expectFile(batch), adb() → {ready, front(),
//   openUrl(u)} | null, phoneApps() → [{id, name, icon}], window → {canSend(), send(app) → bool
//   (its windows streamed to the other computer), accept(on) (take the other's windows here),
//   stop() (stop sending ours)} | null, cacheDir (where copies go; emptied at shutdown), live →
//   {share(path) → info, mount(info) → local path, stop()} | null (shared/rzlive.js), pick(offer,
//   ['copy'|'live'|'window']) → Promise<how | null> (the chooser). Events: 'change', 'offer' (a
//   new one to show), 'gone' (none to show any more), 'opened' ({title, how}).
'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('./protocol.js');

const T = P.T;
const POLL_MS = 1500;
const STABLE_MS = 2500; // in front this long before it's offered (not every window passed on the way)
const TTL_MS = 10 * 60 * 1000; // an offer this old is gone
const ADB_POLL_MS = 3000;
const DOC_WAIT_MS = 2 * 60 * 1000;
const DOC_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const ICON_MAX = 120000;

// Defaults (each platform's settings normalize with these): off; once on, everything but the popups
// on a computer, which every tab switch on the other one would bring up.
const mediapos = require('./mediapos.js');

const DEFAULTS = { on: false, send: true, receive: true, web: true, docs: true, apps: true, mirror: true, push: true, notify: false, taskbar: true, tray: true, tab: true, video: true, windows: false, newWindows: true, newFiles: true, live: false };
// video: a video goes on at the same second (shared/mediapos.js); live: documents are shared, not copied
// windows: an app's window between two computers; newWindows / newFiles: an app found for the first
// time is on its list switched on (else off until it's let through there)
const LISTS = { windows: 'windowApps', files: 'fileApps' };
const MAX_RECORDS = 100;

const str = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '');
const httpUrl = (u) => {
  if (typeof u !== 'string' || u.length > 8192) return '';
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : '';
  } catch (_) { return ''; }
};
const imgUrl = (v) => (typeof v === 'string' && v.length < ICON_MAX && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(v) ? v : '');
// Phone apps that are never something to go on with: home screens, the system bar, TwinDesk itself, keyboards.
const NOT_AN_APP = /launcher|\.home$|miui\.home|systemui|com\.twindesk|inputmethod|\.keyboard|permissioncontroller|com\.android\.settings\.intelligence/i;

const when = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

// One allowlist: app → {name, on, found, sent, last} (found: first seen, sent: how often it went, last: when).
function records(v) {
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  Object.entries(v)
    .filter(([k, r]) => k && k.length <= 300 && r && typeof r === 'object')
    .map(([k, r]) => [k, { name: str(r.name, 100), on: r.on !== false, found: when(r.found), sent: Number.isInteger(r.sent) && r.sent > 0 ? r.sent : 0, last: when(r.last) }])
    .sort((x, y) => (y[1].last || y[1].found) - (x[1].last || x[1].found))
    .slice(0, MAX_RECORDS)
    .forEach(([k, r]) => { out[k] = r; });
  return out;
}

// The copies of an earlier run or of this one: gone (a file still open may stay until next time).
function clearCache(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); } catch (_) { /* in use: next time */ }
}

function normalize(h) {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (h && typeof h[k] === 'boolean') out[k] = h[k];
  for (const k of Object.values(LISTS)) out[k] = records(h && h[k]);
  return out;
}

class ReZume extends EventEmitter {
  constructor(opts) {
    super();
    Object.assign(this, { adb: () => null, phoneApps: () => [], appIcon: async () => '', expectFile() {}, sendFile: () => false, save() {}, window: null, live: null, cacheDir: '', pick: async (o, ways) => ways[0] }, opts);
    if (this.cacheDir) clearCache(this.cacheDir); // what an earlier run left
    this.peerPolicy = null; // {on, web, docs, apps, push, detect}
    this.out = null; // what we offer: {id, kind, title, url, path, name, size, app, appName, icon, at, key}
    this.sent = new Map(); // id → {path} | {app, appName}: the last few documents and windows offered (taken a bit later still works)
    this.wantWin = null; // {id, title}: a window asked for
    this.winOut = ''; // the app whose window was just sent there: not offered again while it stays in front here
    this.seen = null; // {key, since, a}: in front now, not offered until it stayed STABLE_MS
    this.last = null; // the last activity seen here (push: the tray's click puts the taskbar in front)
    this.incoming = null; // the other side's offer
    this.dismissed = new Set();
    this.waiting = null; // {id, title, until}: a document asked for
    this.message = '';
    this.why = ''; // why nothing is seen here (detect's {why})
    this.timer = null;
    this.adbTimer = null;
    this.icons = new Map();
    this.iconAsks = new Set();
    const { link } = this;
    // The other side's policy may come before our own welcome (it hosts): only a session's end forgets it.
    link.welcome(() => { this._reset(false); this.apply(); });
    link.closed(() => { this._reset(true); this._timers(); this.emit('change'); });
    link.on(T.RZ_POLICY, (m) => this._policy(m || {}));
    link.on(T.RZ_OFFER, (m) => this._offer(m || {}));
    link.on(T.RZ_CLEAR, (m) => m && this.incoming && m.id === this.incoming.id && this._drop());
    link.on(T.RZ_TAKE, (m) => m && this._taken(String(m.id || ''), m.how === 'live' || m.how === 'window' ? m.how : 'copy'));
    link.on(T.RZ_DONE, (m) => {
      if (m && m.ok && m.live && this.waiting && m.id === this.waiting.id) return void this._mountLive(m.live);
      if (!m || m.ok) return;
      if (this.waiting && m.id === this.waiting.id) this._failed(str(m.why, 200) || 'It couldn’t be sent');
      else if (this.wantWin && m.id === this.wantWin.id) {
        this.wantWin = null;
        this.message = str(m.why, 200) || 'It couldn’t be sent';
        this.emit('change');
      }
    });
  }

  get enabled() {
    return !!this.cfg().on;
  }

  _reset(ended) {
    if (ended) {
      this.peerPolicy = null;
      this._live('stop'); // what we shared, and what of theirs is mounted here
    }
    this.out = null;
    this.seen = null;
    this.winOut = '';
    this.waiting = null;
    this.wantWin = null;
    this.message = '';
    if (this.incoming) this._drop(true);
    if (this.window) this._win('accept', false);
  }

  _live(fn, ...args) {
    try { return this.live && this.live[fn] ? this.live[fn](...args) : null; } catch (e) { console.error('[rezume] live ' + fn + ': ' + e.message); return null; }
  }

  // The window bridge, its failures only logged.
  _win(fn, ...args) {
    try { return this.window && this.window[fn] ? this.window[fn](...args) : null; } catch (e) { console.error('[rezume] window ' + fn + ': ' + e.message); return null; }
  }

  // Windows go between two computers, only while the switch is on and this side can stream them.
  _windowsOn() {
    const peer = this.link.peer();
    return !!(this.window && this.cfg().windows && peer && peer.os !== P.OS.ANDROID);
  }

  _canSendWindows() {
    return this._windowsOn() && this._win('canSend') !== false;
  }

  // ---- the allowlists ----

  // The record of an app on a list, made the first time (switched on as newWindows / newFiles say).
  _record(list, a) {
    const c = this.cfg();
    const key = LISTS[list];
    if (!a || !a.app || !key) return null;
    if (!c[key] || typeof c[key] !== 'object') c[key] = {};
    let r = c[key][a.app];
    if (!r) {
      r = c[key][a.app] = { name: str(a.appName, 100) || a.app, on: list === 'windows' ? c.newWindows !== false : c.newFiles !== false, found: Date.now(), sent: 0, last: 0 };
      const all = Object.keys(c[key]);
      if (all.length > MAX_RECORDS) c[key] = records(c[key]);
      console.log(`[rezume] ${list}: found ${path.basename(a.app)} (${r.on ? 'allowed' : 'not allowed yet'})`);
      this._save();
    } else if (a.appName && r.name !== a.appName && r.name === a.app) {
      r.name = str(a.appName, 100);
      this._save();
    }
    return r;
  }

  _allowed(list, a) {
    const r = this._record(list, a);
    return !!(r && r.on);
  }

  // It went (taken there, or sent with Send to): counted on its list.
  _went(list, app) {
    const c = this.cfg();
    const r = c[LISTS[list]] && c[LISTS[list]][app];
    if (!r) return;
    r.sent += 1;
    r.last = Date.now();
    this._save();
  }

  _save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try { this.save(); } catch (e) { console.error('[rezume] save: ' + e.message); }
      this.emit('change');
    }, 300);
  }

  // The tab's switches on a list: one app let through or not, or forgotten (app '' forgets them all).
  allow(list, app, on) {
    const c = this.cfg();
    const r = LISTS[list] && c[LISTS[list]] && c[LISTS[list]][app];
    if (!r) return false;
    r.on = on === true;
    if (!r.on && this.out && this.out.app === app && (list === 'windows' ? this.out.kind === 'window' : this.out.kind === 'doc')) this._clearOut();
    if (!r.on && list === 'windows') this._win('stop', app);
    this._save();
    return true;
  }

  forget(list, app) {
    const c = this.cfg();
    const key = LISTS[list];
    if (!key || !c[key]) return false;
    if (app) delete c[key][app];
    else c[key] = {};
    this._save();
    return true;
  }

  _policyMsg() {
    const c = this.cfg();
    return { t: T.RZ_POLICY, on: !!(c.on && c.receive), web: !!c.web, docs: !!c.docs, apps: !!(c.apps && c.mirror), push: !!c.push, windows: !!(c.on && c.receive && this._windowsOn()), live: !!(c.live && this.live) };
  }

  // The settings changed, or a session began: the other side hears what we take, and we look or stop.
  apply() {
    const c = this.cfg();
    if (this.link.peer()) this.link.send(this._policyMsg());
    if (!c.on || !c.receive) this._drop(true);
    else if (this.incoming && !this._shows(this.incoming)) this._drop(true);
    if (this.out && !(c.on && c.send)) this._clearOut();
    if (this.out && this.out.kind === 'window' && !this._canSendWindows()) this._clearOut();
    // Window sharing off (or ReZume): the streams of ours there stop, theirs aren't taken here.
    if (this.window && !(c.on && c.windows)) {
      this._win('stop');
      this._win('accept', false);
    }
    this._timers();
    this.emit('change');
  }

  _timers() {
    const c = this.cfg();
    const peer = this.link.peer();
    // Looking here: to offer (the other side takes them) or for the tray's Send to (push).
    const look = !!(peer && c.on && c.send && ((this.peerPolicy && this.peerPolicy.on) || c.tray));
    if (look && !this.timer) {
      this.timer = setInterval(() => this._tick().catch((e) => console.error('[rezume]', e.message)), POLL_MS);
      this._tick().catch(() => {});
    } else if (!look && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.seen = null;
    }
    // A phone that doesn't say what's in front: asked through wireless debugging.
    const askPhone = !!(peer && peer.os === P.OS.ANDROID && c.on && c.receive && c.apps && c.mirror && this.peerPolicy && this.peerPolicy.on && !this.peerPolicy.detect);
    if (askPhone && !this.adbTimer) this.adbTimer = setInterval(() => this._askPhone().catch(() => {}), ADB_POLL_MS);
    else if (!askPhone && this.adbTimer) {
      clearInterval(this.adbTimer);
      this.adbTimer = null;
    }
  }

  // ---- offering ----

  async _tick() {
    if (this.busy) return;
    this.busy = true;
    let a = null;
    try { a = await this.detect(); } catch (_) { a = null; } finally { this.busy = false; }
    if (a && a.why) {
      this.why = str(a.why, 300);
      a = null;
    } else if (a) this.why = '';
    a = this._clean(a);
    if (a) this.last = { ...a, seenAt: Date.now() };
    // Another app in front here: the one whose window went may be offered again later.
    if (this.winOut && (!a || a.app !== this.winOut)) this.winOut = '';
    const pp = this.peerPolicy;
    const c = this.cfg();
    if (!pp || !pp.on || !c.send) return;
    if (this.out && Date.now() - this.out.seenAt > TTL_MS) this._clearOut();
    const o = a && this._pick(a);
    if (!o) return void (this.seen = null);
    if (this.out && this.out.key === o.key) return void (this.out.seenAt = Date.now());
    if (!this.seen || this.seen.key !== o.key) return void (this.seen = { key: o.key, since: Date.now() });
    if (Date.now() - this.seen.since < STABLE_MS) return;
    this.seen = null;
    await this._send(o, false);
  }

  // What of an activity goes to the other side, if anything: its tab, its document (an app let
  // through on the files list), else its window (to a computer that takes windows, the app let
  // through on the windows list). Finding an app puts it on the list.
  _pick(a) {
    const c = this.cfg();
    const pp = this.peerPolicy;
    if (!a || !pp || !pp.on) return null;
    if (a.kind === 'web') return c.web && pp.web ? a : null; // a browser: its link, never its window
    if (a.app && a.app === this.winOut) return null; // its window is there already (no offer back and forth)
    if (a.kind === 'doc' && c.docs && pp.docs && this._allowed('files', a)) return a;
    if (a.app && pp.windows && this._canSendWindows() && this._allowed('windows', a)) {
      return { kind: 'window', app: a.app, appName: a.appName, title: a.kind === 'app' ? a.title || a.appName : a.appName || a.title, key: 'win ' + a.app };
    }
    return null;
  }

  // detect()'s answer, checked: {kind: 'web', url, title} or {kind: 'doc', path, title}, with app and appName.
  _clean(a) {
    if (!a || typeof a !== 'object') return null;
    const base = { app: str(a.app, 300), appName: str(a.appName, 100), title: str(a.title, 300) };
    if (a.kind === 'web') {
      const url = httpUrl(a.url);
      return url ? { ...base, kind: 'web', url, title: base.title || url, key: 'web ' + url } : null;
    }
    if (a.kind === 'doc' && typeof a.path === 'string' && path.isAbsolute(a.path)) {
      let st = null;
      try { st = fs.statSync(a.path); } catch (_) { return null; }
      if (!st.isFile() || st.size > DOC_MAX_BYTES) return null;
      return { ...base, kind: 'doc', path: a.path, name: path.basename(a.path), size: st.size, title: base.title || path.basename(a.path), key: 'doc ' + a.path };
    }
    if (a.kind === 'app' && base.app) return { ...base, kind: 'app', title: base.title || base.appName || base.app, key: 'app ' + base.app };
    return null;
  }

  async _icon(app) {
    if (!app) return '';
    if (this.icons.has(app)) return this.icons.get(app);
    let icon = '';
    try { icon = imgUrl(await this.appIcon(app)); } catch (_) { icon = ''; }
    if (this.icons.size > 250) this.icons.clear();
    this.icons.set(app, icon);
    return icon;
  }

  async _send(a, push) {
    const id = crypto.randomBytes(8).toString('hex');
    const icon = await this._icon(a.app);
    this.out = { ...a, id, icon, at: Date.now(), seenAt: Date.now() };
    if (a.kind === 'doc' || a.kind === 'window') {
      this.sent.set(id, a.kind === 'doc' ? { path: a.path, app: a.app, appName: a.appName } : { window: true, app: a.app, appName: a.appName });
      if (this.sent.size > 8) this.sent.delete(this.sent.keys().next().value);
    }
    const m = { t: T.RZ_OFFER, id, kind: a.kind, title: a.title, app: a.app, appName: a.appName, icon, at: this.out.at };
    if (a.kind === 'web') m.url = a.url;
    // Video handoff: a video playing here opens there at the same second.
    if (a.kind === 'web' && (this.cfg ? this.cfg().video !== false : true) && mediapos.isVideo(a.url)) {
      try { m.url = mediapos.atTime(a.url, await mediapos.position(a.app)); } catch (_) { /* without the time */ }
      this.out.url = m.url;
    }
    else if (a.kind === 'doc') {
      Object.assign(m, { name: a.name, size: a.size });
      const c = this.cfg();
      const pp = this.peerPolicy || {};
      if (c.live && this.live && pp.live) m.live = true; // the file itself may be opened there
      if (pp.windows && this._canSendWindows() && this._allowed('windows', a)) m.window = true; // or its app's window
    }
    if (push) m.push = true;
    this.link.send(m);
    console.log(`[rezume] offered ${a.kind} ${path.basename(a.app || '')}${push ? ' (sent)' : ''}`);
    this.emit('change');
    return true;
  }

  _clearOut() {
    if (!this.out) return;
    this.link.send({ t: T.RZ_CLEAR, id: this.out.id });
    this.out = null;
    this.emit('change');
  }

  // The tray's Send to: what was last in front here, opened on the other side now.
  async push() {
    const peer = this.link.peer();
    const a = this.last && Date.now() - this.last.seenAt < TTL_MS ? this.last : null;
    if (!peer || !this.enabled || !a) return false;
    const pp = this.peerPolicy;
    // A phone with wireless debugging opens a tab at once, whatever it can do itself.
    const adb = peer.os === P.OS.ANDROID && a.kind === 'web' ? this.adb() : null;
    if (adb && adb.ready) {
      try {
        await adb.openUrl(a.url);
        this.emit('opened', { title: a.title, how: 'sent' });
        return true;
      } catch (_) { /* through the session below */ }
    }
    const o = pp && pp.on ? this._pick(a) : null;
    if (!o) {
      this.message = !pp ? '{name} has no ReZume yet: update TwinDesk there' : !pp.on ? 'ReZume is off on {name}' : '{name} does not accept this item';
      this.emit('change');
      return false;
    }
    await this._send(o, true);
    this.emit('opened', { title: o.title, how: 'sent' });
    return true;
  }

  // The other side took a document of ours (its copy follows, or the file is shared: how 'live',
  // or its app's window is streamed: how 'window') or a window.
  _taken(id, how = 'copy') {
    const s = this.sent.get(id);
    const no = (why) => this.link.send({ t: T.RZ_DONE, id, ok: false, why });
    if (!s) return void no('It isn’t offered any more');
    const c = this.cfg();
    if (!c.on || !c.send) return void no('ReZume is turned off on the other device');
    if (s.window || how === 'window') return void this._sendWindow(id, s).catch((e) => no(e.message || 'It couldn’t be sent'));
    const p = s.path;
    if (s.app && !this._allowed('files', s)) return void no('The other device does not allow documents from this app');
    if (!fs.existsSync(p)) return void no(path.basename(p) + ' is no longer available');
    if (how === 'live') {
      if (!c.live || !this.live) return void no('Shared editing is turned off on the other device');
      return void Promise.resolve(this._live('share', p)).then((info) => {
        if (!info) return no('The file could not be shared');
        this.link.send({ t: T.RZ_DONE, id, ok: true, live: info });
        this._went('files', s.app);
        console.log(`[rezume] ${path.basename(p)} shared for editing`);
      }).catch((e) => no(e.message || 'The file could not be shared'));
    }
    if (!this.sendFile(p, 'rz-' + id)) return void no('It couldn’t be sent');
    this._went('files', s.app);
  }

  async _sendWindow(id, s) {
    const no = (why) => this.link.send({ t: T.RZ_DONE, id, ok: false, why });
    if (!this._canSendWindows()) return no('Window sharing is turned off on the other device');
    if (!this._allowed('windows', s)) return no('The other device does not allow windows from this app');
    const ok = await this._win('send', s.app, s.appName);
    if (ok === false) return no((s.appName || 'The app') + ' is no longer open on the other device');
    this.link.send({ t: T.RZ_DONE, id, ok: true });
    this.winOut = s.app;
    if (this.out && this.out.app === s.app) this._clearOut();
    this._went('windows', s.app);
    console.log(`[rezume] window of ${path.basename(s.app)} sent`);
  }

  // ---- taking ----

  _policy(m) {
    const was = !!(this.peerPolicy && this.peerPolicy.on);
    const first = !this.peerPolicy;
    if (!this.peerPolicy || this.peerPolicy.on !== (m.on === true)) console.log(`[rezume] ${m.on === true ? 'on' : 'off'} on the other side`);
    this.peerPolicy = { on: m.on === true, web: m.web !== false, docs: m.docs !== false, apps: m.apps === true, push: m.push !== false, detect: m.detect !== false, windows: m.windows === true, live: m.live === true };
    if (!this.peerPolicy.windows && this.out && this.out.kind === 'window') this._clearOut();
    if (!this.peerPolicy.on) this._clearOut();
    else if (!was) this._again();
    // Ours may have come before this side loaded there (a computer loads ReZume when it's turned on).
    if (first) this.link.send(this._policyMsg());
    this._timers();
    this.emit('change');
  }

  // The other side (re)connected or turned it on: what was last in front here goes at once, while it's
  // still fresh, not only once something else comes to the front.
  _again() {
    const a = this.last;
    const c = this.cfg();
    const pp = this.peerPolicy;
    if (!a || this.out || !c.on || !c.send || !pp || Date.now() - a.seenAt > TTL_MS) return;
    const o = this._pick(a);
    if (o) this._send(o, false).catch(() => {});
  }

  // Whether an offer is one this side shows (its kind on here, a phone app only with Mirror apps and wireless debugging).
  _shows(o) {
    const c = this.cfg();
    if (!c.on || !c.receive) return false;
    if (o.kind === 'web') return !!c.web;
    if (o.kind === 'doc') return !!c.docs;
    if (o.kind === 'app') return !!(c.apps && c.mirror && this._canMirror());
    if (o.kind === 'window') return this._windowsOn();
    return false;
  }

  _canMirror() {
    const peer = this.link.peer();
    const adb = peer && peer.os === P.OS.ANDROID ? this.adb() : null;
    return !!(adb && adb.ready);
  }

  _offer(m) {
    const kind = m.kind === 'web' || m.kind === 'doc' || m.kind === 'app' || m.kind === 'window' ? m.kind : '';
    const id = str(m.id, 64);
    if (!kind || !id) return;
    const o = { id, kind, title: str(m.title, 300), app: str(m.app, 300), appName: str(m.appName, 100), icon: imgUrl(m.icon), at: Date.now() };
    if (kind === 'web' && !(o.url = httpUrl(m.url))) return;
    if (kind === 'doc') {
      o.name = path.basename(str(m.name, 255)) || 'Document';
      o.size = Number(m.size) >= 0 ? Number(m.size) : 0;
      o.live = m.live === true;
      o.window = m.window === true;
    }
    if (kind === 'app' && !/^[\w.]{1,200}$/.test(o.app)) return;
    if (kind === 'app' && NOT_AN_APP.test(o.app)) return;
    if (kind === 'window' && !o.app) return;
    this._fill(o);
    if (!this._shows(o)) return void console.log(`[rezume] ${kind} from the other side not shown here (its kind is off${kind === 'app' ? ', or no wireless debugging' : kind === 'window' ? ', window sharing' : ''})`);
    console.log(`[rezume] ${kind} from the other side${m.push === true ? ' (sent)' : ''}`);
    if (m.push === true && this.cfg().push) return void this.take(o);
    this._show(o);
  }

  // A phone app's name and icon from the phone's list, when it didn't send them.
  _fill(o) {
    if (o.kind !== 'app' || (o.appName && o.icon)) return;
    const a = (this.phoneApps() || []).find((x) => x.id === o.app);
    if (!a) return;
    o.appName = o.appName || str(a.name, 100);
    o.icon = o.icon || imgUrl(a.icon);
  }

  _show(o) {
    if (this.dismissed.has(o.id)) return;
    const same = this.incoming && this.incoming.kind === o.kind && this.incoming.title === o.title && (this.incoming.url || this.incoming.app) === (o.url || o.app);
    this.incoming = o;
    if (!same) this.emit('offer', o);
    this.emit('change');
    clearTimeout(this.ttl);
    this.ttl = setTimeout(() => this.incoming === o && this._drop(), TTL_MS);
  }

  _drop(quiet) {
    if (!this.incoming) return;
    this.incoming = null;
    clearTimeout(this.ttl);
    this.emit('gone');
    if (!quiet) this.emit('change');
  }

  dismiss(id) {
    if (!this.incoming || (id && id !== this.incoming.id)) return;
    this.dismissed.add(this.incoming.id);
    if (this.dismissed.size > 50) this.dismissed.delete(this.dismissed.values().next().value);
    this._drop();
  }

  // How a document may open here: a copy (Preview), the file itself (Edit: live on both sides), or
  // its app's window (window sharing on both sides).
  _ways(o) {
    const c = this.cfg();
    const ways = ['copy'];
    if (o.live && c.live && this.live) ways.push('live');
    if (o.window && this._windowsOn()) ways.push('window');
    return ways;
  }

  // Open it here. o: the incoming offer (default) or a pushed one. how: 'copy' | 'live' | 'window'
  // for a document (else as live says, or asked when its window may come too).
  async take(o = this.incoming, how) {
    if (!o) return false;
    if (o === this.incoming) this._drop();
    this.message = '';
    if (o.kind === 'doc') {
      const ways = this._ways(o);
      if (!ways.includes(how)) {
        how = ways.includes('window') ? await this.pick(o, ways) : ways.includes('live') ? 'live' : 'copy';
        if (!how) return false; // the chooser was closed
      }
      if (how === 'window') o = { ...o, kind: 'window', title: o.appName || o.title };
    }
    if (o.kind === 'web') {
      await this.open.url(o.url);
      this.emit('opened', { title: o.title, how: 'web' });
    } else if (o.kind === 'app') {
      if (!this._canMirror()) {
        this.message = 'Phone apps open here once wireless debugging is on (Phone page)';
        this.emit('change');
        return false;
      }
      await this.open.phoneApp(o.app, o.appName);
      this.emit('opened', { title: o.appName || o.title, how: 'app' });
    } else if (o.kind === 'window') {
      if (!this._windowsOn()) {
        this.message = 'Window sharing is turned off on this device (ReZume › Continue)';
        this.emit('change');
        return false;
      }
      await this._win('accept', true); // the windows that come are shown here (as the Apps tab's)
      this.wantWin = { id: o.id, title: o.appName || o.title };
      this.link.send({ t: T.RZ_TAKE, id: o.id, how: 'window' });
      this.emit('opened', { title: o.appName || o.title, how: 'window' });
    } else if (o.kind === 'doc') {
      this.waiting = { id: o.id, title: o.name, until: Date.now() + DOC_WAIT_MS, how };
      if (how === 'copy') this.expectFile('rz-' + o.id, this._cache());
      this.link.send({ t: T.RZ_TAKE, id: o.id, how });
      this.message = 'Getting ' + o.name + '…';
      setTimeout(() => this.waiting && this.waiting.id === o.id && this._failed('It didn’t come'), DOC_WAIT_MS);
    }
    this.emit('change');
    return true;
  }

  // A batch arrived (the receivers' onBatch): ours when it's a rezume one.
  received(b) {
    if (!b || b.kind !== 'rezume' || !this.waiting) return false;
    const w = this.waiting;
    this.waiting = null;
    const p = b.placed && b.placed[0];
    if (!b.ok || !p) {
      this._failed(w.title + ' didn’t arrive');
      return true;
    }
    this.message = '';
    Promise.resolve(this.open.file(p)).catch(() => {});
    this.emit('opened', { title: w.title, how: 'doc' });
    this.emit('change');
    return true;
  }

  // Where copies go: a folder of the cache, emptied when TwinDesk quits ('' = the platform's own).
  _cache() {
    if (!this.cacheDir) return '';
    try { fs.mkdirSync(this.cacheDir, { recursive: true }); } catch (_) { return ''; }
    return this.cacheDir;
  }

  // The other side shared the file itself: mounted here, then opened from there.
  async _mountLive(info) {
    const w = this.waiting;
    this.waiting = null;
    let p = '';
    try { p = await this._live('mount', info); } catch (e) { return this._failed((e && e.message) || 'The shared file could not be opened'); }
    if (!p) return this._failed('The shared file could not be opened');
    this.message = '';
    Promise.resolve(this.open.file(p)).catch(() => {});
    this.emit('opened', { title: w.title, how: 'doc' });
    this.emit('change');
  }

  _failed(why) {
    this.waiting = null;
    this.message = why;
    this.emit('change');
  }

  // A phone without Accessibility: its app in front, through wireless debugging.
  async _askPhone() {
    const adb = this.adb();
    if (!adb || !adb.ready || this.asking) return;
    this.asking = true;
    let pkg = '';
    try { pkg = String((await adb.front()) || ''); } catch (_) { pkg = ''; } finally { this.asking = false; }
    if (!/^[\w.]{1,200}$/.test(pkg) || NOT_AN_APP.test(pkg)) return;
    if (this.incoming && this.incoming.kind === 'app' && this.incoming.app === pkg) return;
    const o = { id: 'adb-' + pkg, kind: 'app', app: pkg, appName: '', title: '', icon: '', at: Date.now() };
    this._fill(o);
    if (!o.appName) return; // not in its app list: nothing that opens
    o.title = o.appName;
    if (this._shows(o)) this._show(o);
  }

  get view() {
    const c = this.cfg();
    const peer = this.link.peer();
    const pp = this.peerPolicy;
    const i = this.incoming;
    const o = this.out;
    return {
      ...normalize(c),
      windowApps: this._rows('windows'),
      fileApps: this._rows('files'),
      windowsHere: !!this.window && this._win('canSend') !== false, // this computer can send its windows
      peerWindows: !!(pp && pp.windows),
      connected: !!peer,
      phone: !!(peer && peer.os === P.OS.ANDROID),
      peerOn: !!(pp && pp.on),
      peerKnows: !!pp, // the other side has ReZume (an older app never says)
      peerDetects: !!(pp && pp.detect),
      mirrorReady: this._canMirror(),
      incoming: i ? { id: i.id, kind: i.kind, title: i.title, url: i.url || '', name: i.name || '', size: i.size || 0, app: i.app, appName: i.appName, icon: i.icon, at: i.at, ways: i.kind === 'doc' ? this._ways(i) : [] } : null,
      liveHere: !!this.live,
      peerLive: !!(pp && pp.live),
      out: o ? { kind: o.kind, title: o.title, url: o.url || '', name: o.name || '', appName: o.appName || '' } : null,
      last: this.last ? { kind: this.last.kind, title: this.last.title } : null,
      waiting: this.waiting ? this.waiting.title : '',
      message: this.message,
      why: this.why,
    };
  }

  // A list for the tab: newest first, with the app's icon once it's known.
  _rows(list) {
    const recs = this.cfg()[LISTS[list]] || {};
    return Object.entries(recs)
      .map(([app, r]) => ({ app, name: r.name || app, on: r.on !== false, found: r.found || 0, sent: r.sent || 0, last: r.last || 0, icon: this._knownIcon(app) }))
      .sort((x, y) => (y.last || y.found) - (x.last || x.found));
  }

  _knownIcon(app) {
    if (this.icons.has(app)) return this.icons.get(app);
    if (!this.iconAsks.has(app) && this.iconAsks.size < 200) {
      this.iconAsks.add(app);
      this._icon(app).then((i) => i && this.emit('change')).catch(() => {});
    }
    return '';
  }

  shutdown() {
    this._live('shutdown');
    if (this.cacheDir) clearCache(this.cacheDir);
    if (this.saveTimer) { // a change to the lists not saved yet
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      try { this.save(); } catch (_) { /* quitting */ }
    }
    clearInterval(this.timer);
    clearInterval(this.adbTimer);
    clearTimeout(this.ttl);
    this.timer = this.adbTimer = null;
  }
}

module.exports = { ReZume, DEFAULTS, normalize, httpUrl, NOT_AN_APP, POLL_MS, STABLE_MS, TTL_MS };

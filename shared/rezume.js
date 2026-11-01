// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume (Mac, PC and Linux, with a computer or a phone): what is in use on one device, to go on
// with on the other. A browser tab (its address), a document (its file, sent when it's taken), or a
// phone app (opened here in a phone window, Mirror apps). Off until turned on; nothing is read and no
// permission is asked before that.
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
//   settings.rezume, detect() → activity | null, appIcon(app) → data: URL, open {url(u), file(p),
//   phoneApp(pkg, name)}, sendFile(path, batch) → bool, expectFile(batch), adb() → {ready, front(),
//   openUrl(u)} | null, phoneApps() → [{id, name, icon}]. Events: 'change', 'offer' (a new one
//   to show), 'gone' (none to show any more), 'opened' ({title, how}).
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

const DEFAULTS = { on: false, send: true, receive: true, web: true, docs: true, apps: true, mirror: true, push: true, notify: false, taskbar: true, tray: true, tab: true, video: true };
// video: a YouTube video goes on at the same second (shared/mediapos.js)

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

function normalize(h) {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (h && typeof h[k] === 'boolean') out[k] = h[k];
  return out;
}

class ReZume extends EventEmitter {
  constructor(opts) {
    super();
    Object.assign(this, { adb: () => null, phoneApps: () => [], appIcon: async () => '', expectFile() {}, sendFile: () => false }, opts);
    this.peerPolicy = null; // {on, web, docs, apps, push, detect}
    this.out = null; // what we offer: {id, kind, title, url, path, name, size, app, appName, icon, at, key}
    this.sent = new Map(); // id → path, the last few documents offered (taken a bit later still works)
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
    const { link } = this;
    // The other side's policy may come before our own welcome (it hosts): only a session's end forgets it.
    link.welcome(() => { this._reset(false); this.apply(); });
    link.closed(() => { this._reset(true); this._timers(); this.emit('change'); });
    link.on(T.RZ_POLICY, (m) => this._policy(m || {}));
    link.on(T.RZ_OFFER, (m) => this._offer(m || {}));
    link.on(T.RZ_CLEAR, (m) => m && this.incoming && m.id === this.incoming.id && this._drop());
    link.on(T.RZ_TAKE, (m) => m && this._taken(String(m.id || '')));
    link.on(T.RZ_DONE, (m) => m && this.waiting && m.id === this.waiting.id && !m.ok && this._failed(str(m.why, 200) || 'It couldn’t be sent'));
  }

  get enabled() {
    return !!this.cfg().on;
  }

  _reset(ended) {
    if (ended) this.peerPolicy = null;
    this.out = null;
    this.seen = null;
    this.waiting = null;
    this.message = '';
    if (this.incoming) this._drop(true);
  }

  _policyMsg() {
    const c = this.cfg();
    return { t: T.RZ_POLICY, on: !!(c.on && c.receive), web: !!c.web, docs: !!c.docs, apps: !!(c.apps && c.mirror), push: !!c.push };
  }

  // The settings changed, or a session began: the other side hears what we take, and we look or stop.
  apply() {
    const c = this.cfg();
    if (this.link.peer()) this.link.send(this._policyMsg());
    if (!c.on || !c.receive) this._drop(true);
    else if (this.incoming && !this._shows(this.incoming)) this._drop(true);
    if (this.out && !(c.on && c.send)) this._clearOut();
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
    const pp = this.peerPolicy;
    const c = this.cfg();
    if (!pp || !pp.on || !c.send) return;
    if (this.out && Date.now() - this.out.seenAt > TTL_MS) this._clearOut();
    if (!a || !(a.kind === 'web' ? c.web && pp.web : a.kind === 'doc' ? c.docs && pp.docs : false)) return void (this.seen = null);
    if (this.out && this.out.key === a.key) return void (this.out.seenAt = Date.now());
    if (!this.seen || this.seen.key !== a.key) return void (this.seen = { key: a.key, since: Date.now() });
    if (Date.now() - this.seen.since < STABLE_MS) return;
    this.seen = null;
    await this._send(a, false);
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
    return null;
  }

  async _icon(app) {
    if (!app) return '';
    if (this.icons.has(app)) return this.icons.get(app);
    let icon = '';
    try { icon = imgUrl(await this.appIcon(app)); } catch (_) { icon = ''; }
    if (this.icons.size > 50) this.icons.clear();
    this.icons.set(app, icon);
    return icon;
  }

  async _send(a, push) {
    const id = crypto.randomBytes(8).toString('hex');
    const icon = await this._icon(a.app);
    this.out = { ...a, id, icon, at: Date.now(), seenAt: Date.now() };
    if (a.kind === 'doc') {
      this.sent.set(id, a.path);
      if (this.sent.size > 8) this.sent.delete(this.sent.keys().next().value);
    }
    const m = { t: T.RZ_OFFER, id, kind: a.kind, title: a.title, app: a.app, appName: a.appName, icon, at: this.out.at };
    if (a.kind === 'web') m.url = a.url;
    // Video handoff: a YouTube video playing here opens there at the same second.
    if (a.kind === 'web' && (this.cfg ? this.cfg().video !== false : true) && mediapos.isVideo(a.url)) {
      try { m.url = mediapos.atTime(a.url, await mediapos.position()); } catch (_) { /* without the time */ }
      this.out.url = m.url;
    }
    else Object.assign(m, { name: a.name, size: a.size });
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
    if (!pp || !pp.on || !(a.kind === 'web' ? pp.web : pp.docs)) {
      this.message = !pp ? '{name} has no ReZume yet: update TwinDesk there' : 'ReZume is off on {name}';
      this.emit('change');
      return false;
    }
    await this._send(a, true);
    this.emit('opened', { title: a.title, how: 'sent' });
    return true;
  }

  // The other side took a document of ours: its file follows.
  _taken(id) {
    const p = this.sent.get(id);
    if (!p) return void this.link.send({ t: T.RZ_DONE, id, ok: false, why: 'It isn’t offered any more' });
    if (!fs.existsSync(p)) return void this.link.send({ t: T.RZ_DONE, id, ok: false, why: path.basename(p) + ' isn’t there any more' });
    if (!this.sendFile(p, 'rz-' + id)) this.link.send({ t: T.RZ_DONE, id, ok: false, why: 'It couldn’t be sent' });
  }

  // ---- taking ----

  _policy(m) {
    const was = !!(this.peerPolicy && this.peerPolicy.on);
    const first = !this.peerPolicy;
    if (!this.peerPolicy || this.peerPolicy.on !== (m.on === true)) console.log(`[rezume] ${m.on === true ? 'on' : 'off'} on the other side`);
    this.peerPolicy = { on: m.on === true, web: m.web !== false, docs: m.docs !== false, apps: m.apps === true, push: m.push !== false, detect: m.detect !== false };
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
    if (!a || this.out || !c.on || !c.send || Date.now() - a.seenAt > TTL_MS) return;
    if (!(a.kind === 'web' ? c.web && pp.web : a.kind === 'doc' ? c.docs && pp.docs : false)) return;
    this._send(a, false).catch(() => {});
  }

  // Whether an offer is one this side shows (its kind on here, a phone app only with Mirror apps and wireless debugging).
  _shows(o) {
    const c = this.cfg();
    if (!c.on || !c.receive) return false;
    if (o.kind === 'web') return !!c.web;
    if (o.kind === 'doc') return !!c.docs;
    if (o.kind === 'app') return !!(c.apps && c.mirror && this._canMirror());
    return false;
  }

  _canMirror() {
    const peer = this.link.peer();
    const adb = peer && peer.os === P.OS.ANDROID ? this.adb() : null;
    return !!(adb && adb.ready);
  }

  _offer(m) {
    const kind = m.kind === 'web' || m.kind === 'doc' || m.kind === 'app' ? m.kind : '';
    const id = str(m.id, 64);
    if (!kind || !id) return;
    const o = { id, kind, title: str(m.title, 300), app: str(m.app, 300), appName: str(m.appName, 100), icon: imgUrl(m.icon), at: Date.now() };
    if (kind === 'web' && !(o.url = httpUrl(m.url))) return;
    if (kind === 'doc') {
      o.name = path.basename(str(m.name, 255)) || 'Document';
      o.size = Number(m.size) >= 0 ? Number(m.size) : 0;
    }
    if (kind === 'app' && !/^[\w.]{1,200}$/.test(o.app)) return;
    if (kind === 'app' && NOT_AN_APP.test(o.app)) return;
    this._fill(o);
    if (!this._shows(o)) return void console.log(`[rezume] ${kind} from the other side not shown here (its kind is off${kind === 'app' ? ', or no wireless debugging' : ''})`);
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

  // Open it here. o: the incoming offer (default) or a pushed one.
  async take(o = this.incoming) {
    if (!o) return false;
    if (o === this.incoming) this._drop();
    this.message = '';
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
    } else if (o.kind === 'doc') {
      this.waiting = { id: o.id, title: o.name, until: Date.now() + DOC_WAIT_MS };
      this.expectFile('rz-' + o.id);
      this.link.send({ t: T.RZ_TAKE, id: o.id });
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
      connected: !!peer,
      phone: !!(peer && peer.os === P.OS.ANDROID),
      peerOn: !!(pp && pp.on),
      peerKnows: !!pp, // the other side has ReZume (an older app never says)
      peerDetects: !!(pp && pp.detect),
      mirrorReady: this._canMirror(),
      incoming: i ? { id: i.id, kind: i.kind, title: i.title, url: i.url || '', name: i.name || '', size: i.size || 0, app: i.app, appName: i.appName, icon: i.icon, at: i.at } : null,
      out: o ? { kind: o.kind, title: o.title, url: o.url || '', name: o.name || '', appName: o.appName } : null,
      last: this.last ? { kind: this.last.kind, title: this.last.title } : null,
      waiting: this.waiting ? this.waiting.title : '',
      message: this.message,
      why: this.why,
    };
  }

  shutdown() {
    clearInterval(this.timer);
    clearInterval(this.adbTimer);
    clearTimeout(this.ttl);
    this.timer = this.adbTimer = null;
  }
}

module.exports = { ReZume, DEFAULTS, normalize, httpUrl, NOT_AN_APP, POLL_MS, STABLE_MS, TTL_MS };

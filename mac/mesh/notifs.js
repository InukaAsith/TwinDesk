// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Notifications across every connected device (docs/mesh.md, one pool): this Mac's notifications go
// to every device that accepts them (`notif.policy`); the other devices' show here as native
// notifications from TwinDesk. Reading needs Full Disk Access (the helper reads the Notification
// Center database). Port of windows/notifs.js; the Mac keeps the subtitle line.
//
// Events: 'change' — this.view changed; 'click' ({app, appName, originId}) — one of the others' was clicked.
'use strict';

const { EventEmitter } = require('events');
const P = require('../../shared/protocol.js');
const { Pool } = require('../../shared/mesh.js');
const { NotifGuard, isOwn } = require('../../shared/notif-guard.js');
const { IconsOut, IconsIn } = require('../../shared/notificon.js');
const { withMeshPhoneActions, hidden, present } = require('../../shared/notifacts.js');
const { otpOf } = require('../../shared/otp.js');

const T = P.T;
const str = (v, n = 500) => (typeof v === 'string' ? v.slice(0, n) : '');

// The Pool's view of the mesh for notifications. Items from a device are always shown here; items
// go only to devices whose notif.policy accepted (mesh entry .notifPool === true), checked in send().
function notifPeers(mesh, notifs) {
  return mesh.peers().map((e) => ({
    id: e.id,
    mesh: e.mesh,
    pool: true,
    send: (msg) => {
      if (e.notifPool !== true || !notifs._sendsTo(e.id)) return false; // and our pair with it sends (consent)
      // The app's icon (sent once per app and device session), kept out of the pool's own copies.
      const { _icon, ...rest } = msg;
      const icon = _icon ? notifs.iconsOut.take(e.id, rest.app, _icon) : undefined;
      return e.send(icon ? { ...rest, icon } : rest);
    },
  }));
}

class Notifs extends EventEmitter {
  // opts:
  //   bus, mesh      as in clipboard.js
  //   getSettings()  -> settings (settings.notifs is used); saveSettings() persists it
  //   helper         the helper process: running, on('ready'|'event'), request(name, args) -> Promise
  //   selfName       this device's name (string or function): sent as `on` with our notifications
  //   peerName(id)   fallback name of a device when the mesh does not know it
  //   Notification   optional; default Electron's
  constructor(opts) {
    super();
    this.bus = opts.bus;
    this.mesh = opts.mesh;
    this.consent = opts.consent || null; // shared/consent.js: each device's own Send / Receive (else the settings' for all)
    this.getSettings = opts.getSettings;
    this.saveSettings = opts.saveSettings || (() => {});
    this.helper = opts.helper;
    this.selfName = opts.selfName;
    this.peerName = opts.peerName;
    this.Notification = opts.Notification || require('electron').Notification;
    this.iconsOut = new IconsOut(); // our app icons go with the first notification of each app per device session
    this.iconsIn = new IconsIn(require('electron').nativeImage); // none: macOS shows TwinDesk's icon with every notification
    this.pool = new Pool({ name: 'notif', selfId: this.mesh.selfId, peers: () => notifPeers(this.mesh, this) });
    this.access = 'unknown'; // 'ok' | 'noAccess' (Full Disk Access) | 'unknown'
    this.apps = new Map(); // app -> {app, appName, at} seen here (newest first in the view)
    this.sent = 0;
    this.shown = 0;
    this.live = new Set(); // shown toasts, kept alive until closed
    this.guard = new NotifGuard(); // the same text from the same app within seconds goes once (a loop between devices)
    this.echoes = []; // {title, body, until}: shown here from another device, never sent back

    const bus = this.bus;
    bus.on(T.NOTIF, (m, from) => this._show(m, from));
    bus.on('notif.gone', (m, from) => { const h = (this.history || []).find((x) => x.id === m.id); if (h && h.from === from) this.gone(m.id); }); // gone from the phone (shared/notifacts.js)
    bus.on(T.NOTIF_POLICY, (m, from) => {
      const e = this.mesh.get(from);
      if (e) e.notifPool = m.accept === true;
      this._watch();
      this.emit('change');
    });
    bus.onPeer('welcome', (id) => {
      const e = this.mesh.get(id);
      if (e) e.notifPool = false; // until its notif.policy says otherwise
      this._sendPolicy(id);
      this._watch();
    });
    bus.onPeer('closed', (id) => {
      const e = this.mesh.get(id);
      if (e) e.notifPool = false;
      this._watch();
    });
    this.helper.on('ready', () => this._watch());
    this.helper.on('event', (name, ev) => {
      if (name === 'notif') this._local(ev);
      else if (name === 'notifState') this._setAccess(ev.state === 'ok' ? 'ok' : 'noAccess');
    });
  }

  get cfg() {
    return this.getSettings().notifs;
  }

  // True when some connected device shows our notifications.
  get peerAccepts() {
    return this._anyAccepts();
  }

  _anyAccepts() {
    return this.bus.connectedIds().some((id) => {
      const e = this.mesh.get(id);
      return !!e && e.notifPool === true && this._sendsTo(id);
    });
  }

  // Our pair with that device: our notifications go there / theirs show here (shared/consent.js).
  _sendsTo(id) {
    return this.consent ? this.consent.get(id, 'notifs', 'out') : !!this.cfg.send;
  }

  _takes(id) {
    if (this.consent && this.cfg.takeAll) return true; // Receive all notifications (Multi-device)
    return this.consent ? this.consent.get(id, 'notifs', 'in') : !!this.cfg.receive;
  }

  _selfName() {
    const n = typeof this.selfName === 'function' ? this.selfName() : this.selfName;
    return str(n, 100);
  }

  // Our notif.policy to every connected device.
  sendPolicy() {
    for (const id of this.bus.connectedIds()) this._sendPolicy(id);
  }

  _sendPolicy(id) {
    this.bus.send(id, { t: T.NOTIF_POLICY, accept: this._takes(id), rich: require('../../shared/notifpop.js').popupOn(this.cfg) }); // rich: pictures and live progress, only for TwinDesk's pop-ups
  }

  applySettings() {
    this.sendPolicy();
    this._watch();
    this.emit('change');
  }

  setMuted(app, muted) {
    const list = new Set(this.cfg.muted || []);
    if (muted) list.add(String(app));
    else list.delete(String(app));
    this.cfg.muted = [...list].slice(0, 500);
    this.saveSettings();
    this.emit('change');
  }

  // Name of the device where a notification started: the mesh entry, else the `on` it carries,
  // else the sender's own name.
  _nameOf(origin, on, from) {
    const o = this.mesh.get(origin);
    if (o && o.name) return o.name;
    const name = str(on, 100);
    if (name) return name;
    const f = this.mesh.get(from);
    if (f && f.name) return f.name;
    return (this.peerName && this.peerName(from)) || from;
  }

  // The helper reads the database only while something would be sent; else just checks the access
  // for the Notifications tab.
  _watch() {
    if (!this.helper.running) return;
    const on = this._anyAccepts() || !!this.webWant;
    this.helper.request('notifWatch', { on }).then((r) => this._setAccess(r.readable ? 'ok' : 'noAccess'), () => {});
  }

  _setAccess(a) {
    if (this.access === a) return;
    this.access = a;
    this.emit('change');
  }

  // TwinDesk Web's devices that show this Mac's notifications (shared/web/webhub.js notifSource).
  want(on) {
    if (!!on === !!this.webWant) return;
    this.webWant = !!on;
    this._watch();
  }

  _local(ev) {
    const app = str(ev.app, 300);
    if (!app) return;
    // One we showed from another device, read back from this Mac's notifications: sending it would
    // bounce it between the devices forever.
    const now = Date.now();
    this.echoes = this.echoes.filter((e) => e.until > now);
    if (this.echoes.some((e) => e.title === str(ev.title, 200) && str(ev.body).includes(e.body))) return;
    if (isOwn(app, ev.appName)) return; // TwinDesk's own toasts are never forwarded
    if (this.guard.repeat('out', app, ev.title, ev.body)) return;
    this.apps.set(app, { app, appName: str(ev.appName, 100) || app, at: Date.now() });
    if (this.webWant && !(this.cfg.muted || []).includes(app)) {
      this.emit('notif', { id: str(ev.id, 64), app, appName: str(ev.appName, 100), title: str(ev.title), subtitle: str(ev.subtitle), body: this.cfg.hideText ? '' : str(ev.body), at: Math.round(Number(ev.at)) || Date.now() });
    }
    if (!(this.cfg.muted || []).includes(app) && this._anyAccepts()) {
      const r = this.pool.publish({
        t: T.NOTIF, id: str(ev.id, 64), app, appName: str(ev.appName, 100), title: str(ev.title), subtitle: str(ev.subtitle),
        body: this.cfg.hideText ? '' : str(ev.body), at: Math.round(Number(ev.at)) || Date.now(), on: this._selfName(),
        _icon: ev.icon, // stripped per device in notifPeers (the icon goes once per app and session)
      });
      if (r.sent.length) this.sent++;
    }
    this.emit('change');
  }

  // A notification from another device: relayed by the pool, shown here once when fresh.
  // The apps seen from each device (newest last, a few dozen each), kept for this run.
  _seen(origin, m) {
    const app = str(m.app, 200);
    if (!origin || !app) return;
    if (!this.seenFrom) this.seenFrom = new Map();
    let one = this.seenFrom.get(origin);
    if (!one) { one = new Map(); this.seenFrom.set(origin, one); if (this.seenFrom.size > 32) this.seenFrom.delete(this.seenFrom.keys().next().value); }
    one.delete(app);
    one.set(app, str(m.appName, 100) || app);
    if (one.size > 60) one.delete(one.keys().next().value);
  }

  // Per device: [{app, name, hidden}], the apps seen from it and the ones hidden from it (Who shares what).
  appsFrom() {
    const out = {};
    const hiddenFrom = (this.cfg && this.cfg.fromApps) || {};
    const ids = new Set([...(this.seenFrom ? this.seenFrom.keys() : []), ...Object.keys(hiddenFrom)]);
    for (const id of ids) {
      const list = new Map(this.seenFrom && this.seenFrom.get(id));
      for (const [app, name] of Object.entries(hiddenFrom[id] || {})) if (!list.has(app)) list.set(app, name);
      out[id] = [...list].map(([app, name]) => ({ app, name, hidden: !!(hiddenFrom[id] && hiddenFrom[id][app] !== undefined) })).sort((a, b) => a.name.localeCompare(b.name));
    }
    return out;
  }

  _show(m, from) {
    if (!this._takes(from)) return;
    const r = this.pool.receive(from, m);
    if (r.fresh && r.msg.o && r.msg.o !== from && !this._takes(r.msg.o)) return; // relayed from a device whose notifications we don't take
    if (!r.fresh || !this.Notification || !this.Notification.isSupported()) return;
    if (this.guard.repeat('in', m.app, m.title, m.body)) return; // a repeat of what was just shown
    this._seen(r.msg.o || from, m); // the apps each device sends, for Who shares what › Notifications
    if (hidden(this, m, r.msg.o || from)) return; // an app set to Hide (Notifications, or from that device): not kept either
    const origin = this._nameOf(r.msg.o, m.on, from);
    const appName = str(m.appName, 100);
    // The recent ones, for Overview and Messages' chat apps; buttons and Reply go back to the device.
    const item = this.remember(m, { from, origin: r.msg.o || from, on: origin, direct: !r.msg.o || r.msg.o === from });
    const title = item.title;
    const body = str(m.body);
    // TwinDesk's window (Reply, buttons, picture, progress), the system's, or none (quiet).
    const how = present(this, item, m, { from: origin, code: require('../../shared/otp.js').otpOf([title, body].join(' ')), icon: m.icon || (this.historyIcons && this.historyIcons.get(item.app)) });
    if (how !== 'native') {
      if (how === 'popup') this.shown++;
      return void this.changed();
    }
    this.echoes.push({ title, body: body.slice(0, 80), until: Date.now() + 30000 });
    // A one-time code: a Copy button on the notification; then the phone's own buttons (Mark as read…).
    const code = otpOf([title, body].join(' '));
    const n = new this.Notification({
      title,
      icon: this.iconsIn.for(m),
      subtitle: [appName, origin].filter(Boolean).join(' · '),
      body: [str(m.subtitle, 200), body].filter(Boolean).join('\n'),
      actions: [...(code ? ['Copy ' + code] : []), ...item.actions].map((text) => ({ type: 'button', text })),
    });
    n.tdId = item.id;
    if (n.on) n.on('action', (_e, i) => {
      if (code && i === 0) return require('electron').clipboard.writeText(code);
      this.act(item.id, i - (code ? 1 : 0));
    });
    this.live.add(n);
    const drop = () => this.live.delete(n);
    n.on('close', drop);
    n.on('click', () => this.emit('click', { app: str(m.app, 200), appName, originId: r.msg.o }));
    const timer = setTimeout(drop, 60000);
    if (timer && timer.unref) timer.unref();
    n.show();
    this.shown++;
    this.emit('change');
  }

  get view() {
    return {
      access: this.access,
      peerAccepts: this.peerAccepts,
      sent: this.sent,
      shown: this.shown,
      apps: [...this.apps.values()].sort((a, b) => b.at - a.at).slice(0, 40),
      appsFrom: this.appsFrom(), // per device: its apps and which are hidden here (Who shares what › Notifications)
      ...this.historyView(),
    };
  }

  changed() { this.emit('change'); }
}

withMeshPhoneActions(Notifs);

module.exports = { Notifs };

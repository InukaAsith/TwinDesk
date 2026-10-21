// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications across every connected device (docs/mesh.md, one pool): this Mac's notifications go
// to every device that accepts them (`notif.policy`); the other devices' show here as native
// notifications from TwinDesk. Reading needs Full Disk Access (the helper reads the Notification
// Center database). Port of windows/notifs.js; the Mac keeps the subtitle line.
//
// Events: 'change' — this.view changed; 'click' ({app, appName, originId}) — one of the others' was clicked.
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { Pool } = require('../shared/mesh.js');
const { NotifGuard, isOwn } = require('../shared/notif-guard.js');
const { IconsOut, IconsIn } = require('../shared/notificon.js');

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
      if (e.notifPool !== true) return false;
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
      return !!e && e.notifPool === true;
    });
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
    this.bus.send(id, { t: T.NOTIF_POLICY, accept: !!this.cfg.receive });
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
    const on = !!(this.cfg.send && this._anyAccepts());
    this.helper.request('notifWatch', { on }).then((r) => this._setAccess(r.readable ? 'ok' : 'noAccess'), () => {});
  }

  _setAccess(a) {
    if (this.access === a) return;
    this.access = a;
    this.emit('change');
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
    if (this.cfg.send && !(this.cfg.muted || []).includes(app) && this._anyAccepts()) {
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
  _show(m, from) {
    if (!this.cfg.receive) return;
    const r = this.pool.receive(from, m);
    if (!r.fresh || !this.Notification || !this.Notification.isSupported()) return;
    if (this.guard.repeat('in', m.app, m.title, m.body)) return; // a repeat of what was just shown
    const origin = this._nameOf(r.msg.o, m.on, from);
    const appName = str(m.appName, 100);
    const title = str(m.title, 200) || appName || origin;
    const body = str(m.body);
    this.echoes.push({ title, body: body.slice(0, 80), until: Date.now() + 30000 });
    const n = new this.Notification({
      title,
      icon: this.iconsIn.for(m),
      subtitle: [appName, origin].filter(Boolean).join(' · '),
      body: [str(m.subtitle, 200), body].filter(Boolean).join('\n'),
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
    };
  }
}

module.exports = { Notifs };

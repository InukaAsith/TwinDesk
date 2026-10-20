// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications across every connected device (docs/mesh.md, one pool): this PC's notifications go
// to every device that accepts them (`notif.policy`); the helper reads them from the Windows
// notification database. Notifications from the other devices show here as Windows toasts from
// TwinDesk (main.js sets the AppUserModelID, or Windows shows none). Port of mac/notifs.js.
const electron = require('electron');
const P = require('../shared/protocol.js');
const { Pool } = require('../shared/mesh.js');

const electronNotification = electron.Notification; // undefined under plain node (tests inject one)
const { NotifGuard, isOwn } = require('../shared/notif-guard.js');

const T = P.T;
const str = (v, n = 500) => (typeof v === 'string' ? v.slice(0, n) : '');

// The Pool's view of the mesh for notifications. Items from a device are always shown here; items
// go only to devices whose notif.policy accepted (mesh entry .notifPool === true), checked in send().
function notifPeers(mesh) {
  return mesh.peers().map((e) => ({
    id: e.id,
    mesh: e.mesh,
    pool: true,
    send: (msg) => e.notifPool === true && e.send(msg),
  }));
}

class Notifs {
  // opts:
  //   bus      same shape as in clip.js
  //   mesh     shared/mesh.js Mesh
  //   helper   the notification helper: running, ready/event emitter, request(name, args) -> Promise
  //   settings shared settings object (settings.notifs is used)
  //   save()   persist settings
  //   selfIds  [AUMID] of this app's own toasts
  //   peerName(id)   fallback name of a device when the mesh does not know it
  //   onChange()
  //   onClick({app, appName, originId})  a toast from another device was clicked
  //   Notification  optional; default Electron's
  //   selfName  optional: this device's name (string or function), sent as `on` with our notifications
  constructor(opts) {
    this.bus = opts.bus;
    this.mesh = opts.mesh;
    this.helper = opts.helper;
    this.settings = opts.settings;
    this.save = opts.save;
    this.selfIds = opts.selfIds;
    this.peerName = opts.peerName;
    this.onChange = opts.onChange;
    this.onClick = opts.onClick;
    this.selfName = opts.selfName;
    this.Notification = opts.Notification || electronNotification;
    this.pool = new Pool({ name: 'notif', selfId: this.mesh.selfId, peers: () => notifPeers(this.mesh) });
    this.readable = null; // the helper can read the database
    this.apps = new Map(); // app → {app, appName, at} seen here
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
      this.onChange();
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
    this.helper.on('event', (name, ev) => name === 'notif' && this._local(ev));
  }

  get cfg() {
    return this.settings.notifs;
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
    this.onChange();
  }

  setMuted(app, muted) {
    const list = new Set(this.cfg.muted);
    if (muted) list.add(app);
    else list.delete(app);
    this.cfg.muted = [...list].slice(0, 500);
    this.save();
    this.onChange();
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

  // The helper polls the database only while something would be sent; the reply says whether it
  // can read it at all (Notifications tab).
  _watch() {
    if (!this.helper.running) return;
    const on = !!(this.cfg.send && this._anyAccepts());
    this.helper.request('notifWatch', { on, self: this.selfIds }).then((r) => {
      if (this.readable === !!r.readable) return;
      this.readable = !!r.readable;
      this.onChange();
    }, () => {});
  }

  _local(ev) {
    const app = str(ev.app, 300);
    if (!app) return;
    // One we showed from another device, read back from this computer's notifications: sending it
    // would bounce it between the devices forever (the app-id filter misses it on some setups).
    const now = Date.now();
    this.echoes = this.echoes.filter((e) => e.until > now);
    if (this.echoes.some((e) => e.title === str(ev.title, 200) && str(ev.body).includes(e.body))) return;
    if (isOwn(app, ev.appName)) return; // TwinDesk's own toasts are never forwarded
    if (this.guard.repeat('out', app, ev.title, ev.body)) return;
    this.apps.set(app, { app, appName: str(ev.appName, 100) || app, at: Date.now() });
    if (this.apps.size > 60) this.apps.delete(this.apps.keys().next().value);
    if (this.cfg.send && !this.cfg.muted.includes(app) && this._anyAccepts()) {
      const r = this.pool.publish({
        t: T.NOTIF, id: str(ev.id, 64), app, appName: str(ev.appName, 100), title: str(ev.title), subtitle: str(ev.subtitle),
        body: this.cfg.hideText ? '' : str(ev.body), at: Math.round(Number(ev.at)) || Date.now(), on: this._selfName(),
      });
      if (r.sent.length) this.sent++;
    }
    this.onChange();
  }

  // A notification from another device: relayed by the pool, shown here once when fresh.
  _show(m, from) {
    if (!this.cfg.receive) return;
    const r = this.pool.receive(from, m);
    if (!r.fresh || !this.Notification.isSupported()) return;
    if (this.guard.repeat('in', m.app, m.title, m.body)) return; // a repeat of what was just shown
    const origin = this._nameOf(r.msg.o, m.on, from);
    const appName = str(m.appName, 100);
    const title = str(m.title, 200) || appName || origin;
    const body = str(m.body);
    this.echoes.push({ title, body: body.slice(0, 80), until: Date.now() + 30000 });
    // Windows toasts have no subtitle: the first line is "<appName> · <device>".
    const n = new this.Notification({
      title,
      body: [[appName, origin].filter(Boolean).join(' · '), str(m.subtitle, 200), body].filter(Boolean).join('\n'),
    });
    this.live.add(n);
    const drop = () => this.live.delete(n);
    n.on('close', drop);
    n.on('click', () => this.onClick && this.onClick({ app: str(m.app, 200), appName, originId: r.msg.o }));
    const timer = setTimeout(drop, 60000);
    if (timer && timer.unref) timer.unref();
    n.show();
    this.shown++;
    this.onChange();
  }

  view() {
    return {
      readable: this.readable,
      peerAccepts: this.peerAccepts,
      sent: this.sent,
      shown: this.shown,
      apps: [...this.apps.values()].sort((a, b) => b.at - a.at).slice(0, 40),
    };
  }
}

module.exports = Notifs;

// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Notifications across every connected device (docs/mesh.md, one pool; windows/mesh/notifs.js with
// ../notifs.js's way of reading them): this computer's notifications go to every device that accepts
// them (`notif.policy`); we read them off the session bus (`dbus-monitor` on
// org.freedesktop.Notifications.Notify, which every desktop's notification daemon serves), only while
// something would be sent. Notifications from the other devices show here as desktop notifications
// from TwinDesk (libnotify).
const electron = require('electron');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const P = require('../../shared/protocol.js');
const { Pool } = require('../../shared/mesh.js');
const { IconsIn } = require('../../shared/notificon.js');

const electronNotification = electron.Notification; // undefined under plain node (tests inject one)
const { NotifGuard, isOwn } = require('../../shared/notif-guard.js');

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

class Notifs extends EventEmitter {
  // opts:
  //   bus      same shape as in clip.js
  //   mesh     shared/mesh.js Mesh
  //   settings shared settings object (settings.notifs is used)
  //   save()   persist settings
  //   peerName(id)   fallback name of a device when the mesh does not know it
  //   onChange()
  //   onClick({app, appName, originId})  a notification from another device was clicked
  //   Notification  optional; default Electron's
  //   selfName  optional: this device's name (string or function), sent as `on` with our notifications
  //   spawn     optional: child_process.spawn (tests give a fake dbus-monitor)
  constructor(opts) {
    super();
    this.bus = opts.bus;
    this.mesh = opts.mesh;
    this.settings = opts.settings;
    this.save = opts.save;
    this.peerName = opts.peerName;
    this.onChange = opts.onChange;
    this.onClick = opts.onClick;
    this.selfName = opts.selfName;
    this.Notification = opts.Notification || electronNotification;
    this.spawn = opts.spawn || spawn;
    this.iconsIn = electron.nativeImage ? new IconsIn(electron.nativeImage, path.join(__dirname, '..', 'assets', 'sidebar-icon@2x.png')) : null; // TwinDesk's for apps without one
    this.pool = new Pool({ name: 'notif', selfId: this.mesh.selfId, peers: () => notifPeers(this.mesh) });
    this.readable = null; // dbus-monitor could start
    this.apps = new Map(); // app → {app, appName, at} seen here
    this.sent = 0;
    this.shown = 0;
    this.live = new Set(); // shown notifications, kept alive until closed
    this.guard = new NotifGuard(); // the same text from the same app within seconds goes once (a loop between devices)
    this.echoes = []; // {title, body, until}: shown here from another device, never sent back
    this.mon = null; // the dbus-monitor process while watching

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

  // dbus-monitor runs only while something would be sent; whether it could start is `readable`
  // (Notifications tab).
  _watch() {
    const on = !!(this.cfg.send && this._anyAccepts()) || !!this.webWant;
    if (!on) {
      if (this.mon) { this.mon.stdin.end(); this.mon = null; } // the wrapper stops dbus-monitor
      return;
    }
    if (this.mon) return;
    let proc;
    try {
      // Tied to our stdin: if TwinDesk dies without quitting, the pipe closes and dbus-monitor goes
      // too (it would keep sockets it inherited from Electron open).
      proc = this.spawn('sh', ['-c', 'command -v dbus-monitor >/dev/null || exit 127; dbus-monitor --session "$1" & p=$!; cat >/dev/null; kill $p',
        'sh', "type='method_call',interface='org.freedesktop.Notifications',member='Notify'"], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return this._readable(false);
    }
    this.mon = proc;
    let buf = '';
    let block = null;
    proc.stdout.on('data', (d) => {
      buf += d;
      let n;
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n);
        buf = buf.slice(n + 1);
        if (/^(method call|signal|method return|error) /.test(line)) {
          if (block) this._parse(block);
          block = / member=Notify$/.test(line) ? [] : null;
        } else if (block) block.push(line);
      }
      // A message is printed in one go: done once the output pauses (the next header may be hours away).
      clearTimeout(this.flush);
      this.flush = setTimeout(() => { if (block) { const b = block; block = null; this._parse(b); } }, 120);
    });
    proc.on('error', () => { if (this.mon === proc) this.mon = null; this._readable(false); });
    proc.on('spawn', () => this._readable(true));
    proc.stdin.on('error', () => {});
    proc.on('exit', (code) => {
      if (code === 127) { if (this.mon === proc) this.mon = null; return this._readable(false); }
      if (block) this._parse(block);
      if (this.mon === proc) { this.mon = null; setTimeout(() => this._watch(), 5000); }
    });
  }

  _readable(v) {
    if (this.readable === v) return;
    this.readable = v;
    this.onChange();
  }

  // Notify(app_name, replaces_id, app_icon, summary, body, actions, hints, timeout): the top-level
  // arguments are the lines indented by three spaces; a string may run over several lines.
  _parse(lines) {
    const args = [];
    for (const l of lines) {
      if (/^ {3}\S/.test(l)) args.push(l.slice(3));
      else if (args.length && /^string "/.test(args[args.length - 1]) && !/^ {4,}/.test(l)) args[args.length - 1] += '\n' + l;
    }
    const arg = (a) => (a && a.startsWith('string "') ? a.slice(8).replace(/"$/, '') : '');
    const appName = arg(args[0]);
    if (!appName || /^(TwinDesk|Electron|macshare)/i.test(appName)) return; // ours (from another device)
    this._local({ id: String(Date.now()), app: appName, appName, title: arg(args[3]), body: arg(args[4]), at: Date.now() });
  }

  // TwinDesk Web's devices that show this computer's notifications (shared/web/webhub.js notifSource).
  want(on) {
    if (!!on === !!this.webWant) return;
    this.webWant = !!on;
    this._watch();
  }

  _local(ev) {
    const app = str(ev.app, 300);
    if (!app) return;
    // One we showed from another device, read back from this computer's notifications: sending it
    // would bounce it between the devices forever (the app-name filter misses it on some setups).
    const now = Date.now();
    this.echoes = this.echoes.filter((e) => e.until > now);
    if (this.echoes.some((e) => e.title === str(ev.title, 200) && str(ev.body).includes(e.body))) return;
    if (isOwn(app, ev.appName)) return; // TwinDesk's own notifications are never forwarded
    if (this.guard.repeat('out', app, ev.title, ev.body)) return;
    this.apps.set(app, { app, appName: str(ev.appName, 100) || app, at: Date.now() });
    if (this.apps.size > 60) this.apps.delete(this.apps.keys().next().value);
    if (this.webWant && !this.cfg.muted.includes(app)) {
      this.emit('notif', { id: str(ev.id, 64), app, appName: str(ev.appName, 100), title: str(ev.title), subtitle: str(ev.subtitle), body: this.cfg.hideText ? '' : str(ev.body), at: Math.round(Number(ev.at)) || Date.now() });
    }
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
    // Desktop notifications have no subtitle: the first line is "<appName> · <device>".
    const n = new this.Notification({
      title,
      icon: this.iconsIn ? this.iconsIn.for(m) : undefined,
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

  shutdown() {
    if (this.mon) this.mon.stdin.end();
    this.mon = null;
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

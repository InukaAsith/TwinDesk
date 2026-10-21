// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications both ways (copy of windows/notifs.js): this
// computer's notifications go to the other computer while it accepts them (`notif.policy`); we read
// them off the session bus (`dbus-monitor` on org.freedesktop.Notifications.Notify, which every
// desktop's notification daemon serves), only while something would be sent. The other computer's
// show here as desktop notifications from TwinDesk (libnotify).
const { Notification, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const P = require('../shared/protocol.js');
const { IconsIn } = require('../shared/notificon.js');

const T = P.T;
const str = (v, n = 500) => (typeof v === 'string' ? v.slice(0, n) : '');

class Notifs {
  // opts: link, helper, settings (shared), save(), selfIds: [AUMID], peerName(), onChange(), onClick({app, appName})? (main.js: a phone's notification clicked)
  constructor(opts) {
    this.iconsIn = new IconsIn(nativeImage, path.join(__dirname, 'assets', 'sidebar-icon@2x.png')); // TwinDesk's for apps without one
    Object.assign(this, opts);
    this.peerAccepts = false; // the other side's notif.policy (assume no until told)
    this.readable = null; // the helper can read the database
    this.apps = new Map(); // app → {app, appName, at} seen here
    this.sent = 0;
    this.shown = 0;
    this.live = new Set(); // shown toasts, kept alive until closed
    this.echoes = []; // {title, body, until}: shown here from the other side, never sent back

    const link = this.link;
    link.on('welcome', () => {
      this.peerAccepts = false;
      this.sendPolicy();
      this._watch();
    });
    link.on('closed', () => {
      this.peerAccepts = false;
      this._watch();
    });
    link.on(T.NOTIF_POLICY, (m) => {
      this.peerAccepts = m.accept === true;
      this._watch();
      this.onChange();
    });
    link.on(T.NOTIF, (m) => this._show(m));
    this.mon = null; // the dbus-monitor process while watching
  }

  get cfg() {
    return this.settings.notifs;
  }

  get connected() {
    return this.link.status.state === 'connected';
  }

  sendPolicy() {
    if (this.connected) this.link.send({ t: T.NOTIF_POLICY, accept: !!this.cfg.receive });
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

  // dbus-monitor runs only while something would be sent; whether it could start is `readable`
  // (Notifications tab).
  _watch() {
    const on = !!(this.cfg.send && this.peerAccepts && this.connected);
    if (!on) {
      if (this.mon) { this.mon.stdin.end(); this.mon = null; } // the wrapper stops dbus-monitor
      return;
    }
    if (this.mon) return;
    let proc;
    try {
      // Tied to our stdin: if TwinDesk dies without quitting, the pipe closes and dbus-monitor goes
      // too (it would keep sockets it inherited from Electron open).
      proc = spawn('sh', ['-c', 'command -v dbus-monitor >/dev/null || exit 127; dbus-monitor --session "$1" & p=$!; cat >/dev/null; kill $p',
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
    const str = (a) => (a && a.startsWith('string "') ? a.slice(8).replace(/"$/, '') : '');
    const appName = str(args[0]);
    if (!appName || /^(TwinDesk|Electron|macshare)/i.test(appName)) return; // ours (from the other computer)
    this._local({ id: String(Date.now()), app: appName, appName, title: str(args[3]), body: str(args[4]), at: Date.now() });
  }

  _local(ev) {
    const app = str(ev.app, 300);
    if (!app) return;
    // One we showed from the other side, read back from this computer's notifications: sending it
    // would bounce it between the two forever (the app-id filter misses it on some setups).
    const now = Date.now();
    this.echoes = this.echoes.filter((e) => e.until > now);
    if (this.echoes.some((e) => e.title === str(ev.title, 200) && str(ev.body).includes(e.body))) return;
    this.apps.set(app, { app, appName: str(ev.appName, 100) || app, at: Date.now() });
    if (this.apps.size > 60) this.apps.delete(this.apps.keys().next().value);
    if (this.cfg.send && this.peerAccepts && this.connected && !this.cfg.muted.includes(app)) {
      this.link.send({
        t: T.NOTIF, id: str(ev.id, 64), app, appName: str(ev.appName, 100), title: str(ev.title), subtitle: str(ev.subtitle),
        body: this.cfg.hideText ? '' : str(ev.body), at: Math.round(Number(ev.at)) || Date.now(),
      });
      this.sent++;
    }
    this.onChange();
  }

  // Desktop notifications have no subtitle: the first line is "<appName> · <peer>".
  _show(m) {
    if (!this.cfg.receive || !Notification.isSupported()) return;
    const peer = this.peerName();
    const appName = str(m.appName, 100);
    const title = str(m.title, 200) || appName || peer;
    this.echoes.push({ title, body: str(m.body).slice(0, 80), until: Date.now() + 30000 });
    const n = new Notification({
      title,
      icon: this.iconsIn.for(m),
      body: [[appName, peer].filter(Boolean).join(' · '), str(m.subtitle, 200), str(m.body)].filter(Boolean).join('\n'),
    });
    this.live.add(n);
    const drop = () => this.live.delete(n);
    n.on('close', drop);
    n.on('click', () => this.onClick && this.onClick({ app: str(m.app, 200), appName }));
    setTimeout(drop, 60000);
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

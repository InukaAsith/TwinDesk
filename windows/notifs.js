// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications both ways: this PC's notifications
// go to the other computer while it accepts them (`notif.policy`); the helper reads them from the
// Windows notification database. The other computer's show here as Windows toasts from TwinDesk
// (main.js sets the AppUserModelID, or Windows shows none). Port of mac/notifs.js.
const { Notification } = require('electron');
const P = require('../shared/protocol.js');

const T = P.T;
const str = (v, n = 500) => (typeof v === 'string' ? v.slice(0, n) : '');

class Notifs {
  // opts: link, helper, settings (shared), save(), selfIds: [AUMID], peerName(), onChange()
  constructor(opts) {
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
    this.helper.on('ready', () => this._watch());
    this.helper.on('event', (name, ev) => name === 'notif' && this._local(ev));
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

  // The helper polls the database only while something would be sent; the reply says whether it
  // can read it at all (Notifications tab).
  _watch() {
    if (!this.helper.running) return;
    const on = !!(this.cfg.send && this.peerAccepts && this.connected);
    this.helper.request('notifWatch', { on, self: this.selfIds }).then((r) => {
      if (this.readable === !!r.readable) return;
      this.readable = !!r.readable;
      this.onChange();
    }, () => {});
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

  // Windows toasts have no subtitle: the first line is "<appName> · <peer>".
  _show(m) {
    if (!this.cfg.receive || !Notification.isSupported()) return;
    const peer = this.peerName();
    const appName = str(m.appName, 100);
    const title = str(m.title, 200) || appName || peer;
    this.echoes.push({ title, body: str(m.body).slice(0, 80), until: Date.now() + 30000 });
    const n = new Notification({
      title,
      body: [[appName, peer].filter(Boolean).join(' · '), str(m.subtitle, 200), str(m.body)].filter(Boolean).join('\n'),
    });
    this.live.add(n);
    const drop = () => this.live.delete(n);
    n.on('close', drop);
    setTimeout(drop, 60000);
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

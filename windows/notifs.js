// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications both ways: this PC's notifications
// go to the other computer while it accepts them (`notif.policy`); the helper reads them from the
// Windows notification database. The other computer's show here as Windows toasts from TwinDesk
// (main.js sets the AppUserModelID, or Windows shows none). Port of mac/notifs.js.
const { Notification, nativeImage } = require('electron');
const { EventEmitter } = require('events');
const path = require('path');
const P = require('../shared/protocol.js');
const { IconsIn } = require('../shared/notificon.js');
const { otpOf } = require('../shared/otp.js');
const { actionsOf, withPhoneActions } = require('../shared/notifacts.js');

const xmlEsc = (t) => String(t).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

const T = P.T;
const str = (v, n = 500) => (typeof v === 'string' ? v.slice(0, n) : '');

class Notifs extends EventEmitter {
  // opts: link, helper, settings (shared), save(), selfIds: [AUMID], peerName(), onChange(), onClick({app, appName})? (main.js: a phone's notification clicked)
  constructor(opts) {
    super();
    this.iconsIn = new IconsIn(nativeImage, path.join(__dirname, 'assets', 'sidebar-icon@2x.png')); // TwinDesk's for apps without one
    Object.assign(this, opts);
    this.peerAccepts = false; // the other side's notif.policy (assume no until told)
    this.readable = null; // the helper can read the database
    this.apps = new Map(); // app → {app, appName, at} seen here
    this.sent = 0;
    this.shown = 0;
    this.live = new Set(); // shown toasts, kept alive until closed
    this.echoes = []; // {title, body, until}: shown here from the other side, never sent back
    this.history = []; // received notifications history from peer
    // app → its icon (data: URL): the phone sends it with an app's first notification only, so the
    // later ones in Recent take it from here; sent once per app in view(), not with every item
    this.historyIcons = new Map();

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
    link.on('notif.gone', (m) => this.gone(m.id)); // gone from the phone (shared/notifacts.js)
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
    const on = !!(this.cfg.send && this.peerAccepts && this.connected) || !!this.webWant;
    this.helper.request('notifWatch', { on, self: this.selfIds }).then((r) => {
      if (this.readable === !!r.readable) return;
      this.readable = !!r.readable;
      this.onChange();
    }, () => {});
  }

  // TwinDesk Web's devices that show this PC's notifications (shared/web/webhub.js notifSource).
  want(on) {
    if (!!on === !!this.webWant) return;
    this.webWant = !!on;
    this._watch();
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
    if (this.webWant && !this.cfg.muted.includes(app)) {
      this.emit('notif', { id: str(ev.id, 64), app, appName: str(ev.appName, 100), title: str(ev.title), subtitle: str(ev.subtitle), body: this.cfg.hideText ? '' : str(ev.body), at: Math.round(Number(ev.at)) || Date.now() });
    }
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
    if (!this.cfg.receive) return;
    const peer = this.peerName();
    const appName = str(m.appName, 100);
    const title = str(m.title, 200) || appName || peer;
    const item = {
      id: str(m.id, 200) || String(Date.now()), // the phone's key, whole: notif.act and notif.dismiss name it
      app: str(m.app, 200),
      appName,
      title,
      subtitle: str(m.subtitle, 200),
      body: str(m.body, 1000),
      at: Math.round(Number(m.at)) || Date.now(),
      reply: m.reply === true, // a phone chat's: answered with reply() (notif.reply)
      actions: actionsOf(m), // its buttons, clicked from Overview (act())
    };
    if (item.app && typeof m.icon === 'string' && m.icon.startsWith('data:image/') && m.icon.length < 200000) {
      this.historyIcons.delete(item.app);
      this.historyIcons.set(item.app, m.icon);
      if (this.historyIcons.size > 60) this.historyIcons.delete(this.historyIcons.keys().next().value);
    }
    this.history = [item, ...(this.history || []).filter((x) => x.id !== item.id)].slice(0, 50);

    if (Notification.isSupported()) {
      this.echoes.push({ title, body: str(m.body).slice(0, 80), until: Date.now() + 30000 });
      const icon = this.iconsIn.for(m);
      const body = [[appName, peer].filter(Boolean).join(' · '), str(m.subtitle, 200), str(m.body)].filter(Boolean).join('\n');
      // A one-time code: a Copy button on the toast (twindesk:copy, main.js openLink); the toast
      // itself opens the app as before (twindesk:open).
      const code = otpOf([title, str(m.body)].join(' '));
      const n = code ? new Notification({
        title,
        icon,
        toastXml: '<toast launch="' + xmlEsc('twindesk:open?app=' + encodeURIComponent(item.app) + '&name=' + encodeURIComponent(appName)) + '" activationType="protocol">'
          + '<visual><binding template="ToastGeneric"><text>' + xmlEsc(title) + '</text><text>' + xmlEsc(body) + '</text></binding></visual>'
          + '<actions><action content="' + xmlEsc('Copy ' + code) + '" activationType="protocol" arguments="twindesk:copy?code=' + code + '"/></actions></toast>',
      }) : new Notification({ title, icon, body });
      n.tdId = item.id;
      this.live.add(n);
      const drop = () => this.live.delete(n);
      n.on('close', drop);
      n.on('click', () => this.onClick && this.onClick({ app: str(m.app, 200), appName }));
      setTimeout(drop, 60000);
      n.show();
    }
    this.shown++;
    this.onChange();
  }

  // An answer to a phone's notification (a chat's Reply), typed here: the phone sends it with the app.
  reply(id, text) {
    const item = (this.history || []).find((h) => h.id === id);
    if (!item || !item.reply || typeof text !== 'string' || !text.trim()) return false;
    this.link.send({ t: 'notif.reply', id: str(id, 200), text: text.slice(0, 5000) });
    item.replies = [...(item.replies || []), { text: text.slice(0, 5000), at: Date.now() }].slice(-20); // shown under it here
    this.onChange();
    return true;
  }

  send(m) { this.link.send(m); }
  changed() { this.onChange(); }

  clearHistory() {
    this.history = [];
    this.onChange();
  }

  view() {
    return {
      readable: this.readable,
      peerAccepts: this.peerAccepts,
      sent: this.sent,
      shown: this.shown,
      apps: [...this.apps.values()].sort((a, b) => b.at - a.at).slice(0, 40),
      history: this.history || [],
      historyIcons: Object.fromEntries([...new Set(this.history.map((h) => h.app))]
        .filter((a) => this.historyIcons.has(a)).map((a) => [a, this.historyIcons.get(a)])),
    };
  }
}

withPhoneActions(Notifs);

module.exports = Notifs;

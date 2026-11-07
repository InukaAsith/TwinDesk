// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Notifications both ways: this Mac's notifications go to the peer
// while it accepts them (`notif.policy`); the peer's show here as native notifications from
// TwinDesk. Reading needs Full Disk Access (the helper reads the Notification Center database).
//
// Events: 'change' — this.view changed; 'click' ({app, appName}) — one of the peer's was clicked.
'use strict';

const { Notification, nativeImage } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { IconsOut, IconsIn } = require('../shared/notificon.js');
const { actionsOf, withPhoneActions } = require('../shared/notifacts.js');

const T = P.T;
const str = (v, n = 500) => (typeof v === 'string' ? v.slice(0, n) : '');

class Notifs extends EventEmitter {
  constructor({ server, helper, getSettings, saveSettings }) {
    super();
    this.iconsOut = new IconsOut();
    this.iconsIn = new IconsIn(nativeImage); // none: macOS shows TwinDesk's icon with every notification
    Object.assign(this, { server, helper, getSettings, saveSettings });
    this.peerAccepts = false;
    this.access = 'unknown'; // 'ok' | 'noAccess' (Full Disk Access) | 'unknown'
    this.apps = new Map(); // app -> {app, appName, at} seen here (newest first in the view)
    this.sent = 0;
    this.shown = 0;
    this.live = []; // keep shown Notification objects alive until closed

    server.on('client', () => {
      this.peerAccepts = false;
      this.sendPolicy();
      this._watch();
    });
    server.on('closed', () => {
      if (server.current) return;
      this.peerAccepts = false;
      this._watch();
    });
    server.on(`t:${T.NOTIF_POLICY}`, (m) => {
      this.peerAccepts = !!m.accept;
      this._watch();
      this.emit('change');
    });
    server.on(`t:${T.NOTIF}`, (m) => this._show(m));
    server.on('t:notif.gone', (m) => this.gone(m.id)); // gone from the phone (shared/notifacts.js)
    helper.on('ready', () => this._watch());
    helper.on('event', (name, ev) => {
      if (name === 'notif') this._local(ev);
      else if (name === 'notifState') this._setAccess(ev.state === 'ok' ? 'ok' : 'noAccess');
    });
  }

  get cfg() {
    return this.getSettings().notifs;
  }

  sendPolicy() {
    this.server.sendToClient({ t: T.NOTIF_POLICY, accept: !!this.cfg.receive });
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

  // Read the database only while something would be sent; else just check access for the tab.
  _watch() {
    if (!this.helper.running) return;
    const on = !!(this.cfg.send && this.peerAccepts && this.server.current) || !!this.webWant;
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
    const app = str(ev.app, 200);
    this.apps.set(app, { app, appName: str(ev.appName, 100) || app, at: Date.now() });
    if (this.webWant && !(this.cfg.muted || []).includes(app)) {
      this.emit('notif', { id: str(ev.id, 64), app, appName: str(ev.appName, 100), title: str(ev.title), subtitle: str(ev.subtitle), body: this.cfg.hideText ? '' : str(ev.body), at: Number(ev.at) || Date.now() });
    }
    if (!this.cfg.send || !this.peerAccepts || !this.server.current || (this.cfg.muted || []).includes(app)) return this.emit('change');
    this.server.sendToClient({
      t: T.NOTIF, id: str(ev.id, 64), app, appName: str(ev.appName, 100), title: str(ev.title), subtitle: str(ev.subtitle),
      body: this.cfg.hideText ? '' : str(ev.body), at: Number(ev.at) || Date.now(),
      icon: this.iconsOut.take(this.server.current, app, ev.icon),
    });
    this.sent++;
    this.emit('change');
  }

  _show(m) {
    if (!this.cfg.receive) return;
    const peer = this.server.current ? this.server.current.name : '';
    const appName = str(m.appName, 100);
    // The recent ones, for Overview and Messages' chat apps (as the PC keeps them).
    const item = { id: str(m.id, 200) || String(Date.now()), app: str(m.app, 200), appName, title: str(m.title, 200) || appName || peer, subtitle: str(m.subtitle, 200), body: str(m.body, 1000), at: Math.round(Number(m.at)) || Date.now(), reply: m.reply === true, actions: actionsOf(m) };
    if (!this.historyIcons) this.historyIcons = new Map();
    if (item.app && typeof m.icon === 'string' && m.icon.startsWith('data:image/') && m.icon.length < 200000) {
      this.historyIcons.delete(item.app);
      this.historyIcons.set(item.app, m.icon);
      if (this.historyIcons.size > 60) this.historyIcons.delete(this.historyIcons.keys().next().value);
    }
    this.history = [item, ...(this.history || []).filter((x) => x.id !== item.id)].slice(0, 50);
    if (!Notification.isSupported()) return void this.emit('change');
    // A one-time code: a Copy button on the notification.
    const code = require('../shared/otp.js').otpOf([item.title, item.body].join(' '));
    const n = new Notification({
      title: item.title,
      subtitle: [appName, peer].filter(Boolean).join(' · '),
      body: [str(m.subtitle, 200), str(m.body)].filter(Boolean).join('\n'),
      icon: this.iconsIn.for(m),
      // A one-time code's Copy, then the phone's own buttons (Mark as read…), tapped there.
      actions: [...(code ? ['Copy ' + code] : []), ...item.actions].map((text) => ({ type: 'button', text })),
    });
    n.tdId = item.id;
    n.on('action', (_e, i) => {
      if (code && i === 0) return require('electron').clipboard.writeText(code);
      this.act(item.id, i - (code ? 1 : 0));
    });
    this.live.push(n);
    const drop = () => { this.live = this.live.filter((x) => x !== n); };
    n.on('close', drop);
    n.on('click', () => this.emit('click', { app: str(m.app, 200), appName }));
    setTimeout(drop, 60000);
    n.show();
    this.shown++;
    this.emit('change');
  }

  // An answer to a phone's notification (a chat's Reply), typed here: the phone sends it with the app.
  reply(id, text) {
    const item = (this.history || []).find((h) => h.id === id);
    if (!item || !item.reply || typeof text !== 'string' || !text.trim()) return false;
    this.server.sendToClient({ t: 'notif.reply', id: str(id, 200), text: text.slice(0, 5000) });
    item.replies = [...(item.replies || []), { text: text.slice(0, 5000), at: Date.now() }].slice(-20);
    this.emit('change');
    return true;
  }

  send(m) { if (this.server.current) this.server.sendToClient(m); }
  changed() { this.emit('change'); }

  get view() {
    return {
      access: this.access,
      peerAccepts: this.peerAccepts,
      sent: this.sent,
      shown: this.shown,
      apps: [...this.apps.values()].sort((a, b) => b.at - a.at).slice(0, 40),
      history: this.history || [],
      historyIcons: Object.fromEntries([...new Set((this.history || []).map((h) => h.app))]
        .filter((a) => this.historyIcons && this.historyIcons.has(a)).map((a) => [a, this.historyIcons.get(a)])),
    };
  }
}

withPhoneActions(Notifs);

module.exports = { Notifs };

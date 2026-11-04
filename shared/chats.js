// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Messages' chat apps (Mac, PC and Linux): WhatsApp, Instagram, Telegram, Messenger and Signal
// conversations from a phone, kept here per phone so they're there after a restart.
//   chat.want {on}                      to the phone: send them (Messages › Chat apps in Messages)
//   chat.conv {key, app, appName, name, group, id?, reply, items: [{at, from, text, me}]}
//                                       from the phone: a conversation's recent messages, as its
//                                       notification shows them (MessagingStyle); on chat.want, the
//                                       ones open on the phone now; afterwards each one as it changes
//   notif.reply {id, text}              to the phone: an answer, through the notification's own Reply
//   chat.pic {ref, id, app, chat, image, text}
//                                       to the phone (one whose chat.conv says pic): a picture (a JPEG
//                                       data: URL), through the Reply where it takes one, else the app
//                                       opens on that conversation with it attached, to send there
//   chat.picd {ref, ok, opened, error?} from the phone: how that went (opened: waiting on the phone)
// A phone without them (an older TwinDesk) never sends chat.conv: Messages then builds the chats
// from the notifications (shared/ui-messages.js), as before.
// link: on('welcome' | 'closed' | type, fn), send(msg), current?: {deviceId}; want(): the switch.
'use strict';

const fs = require('fs');
const path = require('path');

const T = { WANT: 'chat.want', CONV: 'chat.conv', PIC: 'chat.pic', PICD: 'chat.picd' };
const PICTURE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const APPS = /^(?:com\.whatsapp(?:\.w4b)?|com\.instagram\.android|org\.telegram\.messenger(?:\.web)?|org\.thunderdog\.challegram|com\.facebook\.orca|org\.thoughtcrime\.securesms)$/;
// Any other app's conversations too (Viber, LINE, Discord, Slack…: the phone sends those in Android's
// conversation style), never a texting app's: those are Messages' texts.
const PKG = /^[A-Za-z][\w]*(?:\.[\w]+)+$/;
const SMS_APPS = /^(?:com\.google\.android\.apps\.messaging|com\.samsung\.android\.messaging|com\.android\.mms|com\.android\.messaging)$/;
const isChatApp = (app) => APPS.test(app) || (PKG.test(app) && app.length <= 200 && !SMS_APPS.test(app));
const MAX_CONVS = 100; // per phone
const MAX_ITEMS = 150; // per conversation
const VIEW_CONVS = 60;
const VIEW_ITEMS = 80;
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const same = (a, b) => a.me === b.me && a.text === b.text && Math.abs(a.at - b.at) < (a.local || b.local ? 5 * 60000 : 1500);

class Chats {
  constructor({ link, dir, want, who, onChange }) {
    Object.assign(this, { link, want, onChange: onChange || (() => {}) });
    this.who = who || (() => (link.current && link.current.deviceId) || '');
    this.file = path.join(dir, 'chats.json');
    this.phones = {}; // deviceId -> {key -> conv}
    this.sessionUp = false;
    this.sentWant = null; // what the phone was told (null: nothing this session)
    this.heard = false; // the phone sent one this session: it knows chat.conv
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && typeof j.phones === 'object') this.phones = j.phones;
    } catch {}
    link.on('welcome', () => {
      this.sessionUp = true;
      this.sentWant = null;
      this.sync();
    });
    link.on('closed', () => {
      this.sessionUp = false;
      this.sentWant = null;
    });
    link.on(T.CONV, (m) => this._conv(m || {}));
    link.on(T.PICD, (m) => this._picd(m || {}));
  }

  // Tell the phone whether to send them (the switch changed, or a new session).
  sync() {
    const on = !!this.want();
    if (!this.sessionUp || on === this.sentWant) return;
    this.sentWant = on;
    this.link.send({ t: T.WANT, on });
  }

  _conv(m) {
    const app = str(m.app, 80);
    const key = str(m.key, 300);
    const dev = this.who();
    if (!isChatApp(app) || !key || !dev || !Array.isArray(m.items)) return;
    this.heard = true;
    const convs = (this.phones[dev] = this.phones[dev] || {});
    const k = app + '|' + key;
    const c = convs[k] || { key: k, app, items: [] };
    c.appName = str(m.appName, 60) || c.appName || app;
    c.name = str(m.name, 200) || c.name || '';
    c.group = m.group === true;
    c.pic = m.pic === true;
    if (typeof m.id === 'string' && m.id) {
      c.id = str(m.id, 200);
      c.reply = m.reply === true;
    }
    for (const x of m.items.slice(-60)) {
      if (!x || typeof x !== 'object') continue;
      const it = { at: Number(x.at) > 0 ? Math.round(Number(x.at)) : Date.now(), from: str(x.from, 120), text: str(x.text, 4000), me: x.me === true };
      if (!it.text) continue;
      const i = c.items.findIndex((y) => same(y, it));
      if (i >= 0) c.items[i] = it; // the phone's copy replaces one typed here
      else c.items.push(it);
    }
    c.items.sort((a, b) => a.at - b.at);
    c.items = c.items.slice(-MAX_ITEMS);
    c.at = c.items.length ? c.items[c.items.length - 1].at : Date.now();
    convs[k] = c;
    const keys = Object.keys(convs);
    if (keys.length > MAX_CONVS) {
      keys.sort((a, b) => convs[a].at - convs[b].at);
      for (const old of keys.slice(0, keys.length - MAX_CONVS)) delete convs[old];
    }
    this._save();
    this.onChange();
  }

  // An answer typed here: through the conversation's notification Reply; shown at once, the
  // phone's own copy (its notification updates with it) replaces it.
  reply(key, text, image) {
    const c = (this.phones[this.who()] || {})[key];
    const t = typeof text === 'string' ? text.trim().slice(0, 5000) : '';
    if (image) return this.picture(c, t, image);
    if (!c || !c.id || !c.reply || !t || !this.sessionUp) return false;
    this.link.send({ t: 'notif.reply', id: c.id, text: t });
    c.items.push({ at: Date.now(), from: '', text: t, me: true, local: true });
    c.at = Date.now();
    this._save();
    this.onChange();
    return true;
  }

  // A picture (and its caption) to a conversation: shown at once as "Picture", its state after it
  // as the phone says (chat.picd): sent, or open on the phone to send there, or not sent.
  picture(c, text, image) {
    if (!c || !c.pic || !this.sessionUp || typeof image !== 'string' || image.length > 6000000 || !PICTURE.test(image)) return false;
    const ref = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.link.send({ t: T.PIC, ref, id: c.id || '', app: c.app, chat: c.key.slice(c.app.length + 1), image, text });
    c.items.push({ at: Date.now(), from: '', text, me: true, local: true, pic: 'sending', ref });
    c.at = Date.now();
    this._save();
    this.onChange();
    return true;
  }

  _picd(m) {
    const ref = str(m.ref, 60);
    for (const c of Object.values(this.phones[this.who()] || {})) {
      const it = c.items.find((x) => x.ref === ref);
      if (!it) continue;
      it.pic = m.ok ? (m.opened ? 'opened' : 'sent') : 'failed';
      if (!m.ok) it.error = str(m.error, 120);
      this._save();
      this.onChange();
      return;
    }
  }

  clear() {
    delete this.phones[this.who()];
    this._save();
    this.onChange();
  }

  _save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const tmp = this.file + '.tmp';
      try {
        fs.writeFileSync(tmp, JSON.stringify({ phones: this.phones }));
        fs.renameSync(tmp, this.file);
      } catch (e) {
        console.log('[chats] save: ' + e.message);
      }
    }, 1500);
  }

  // For the state: this phone's, newest first (null: the phone hasn't sent any, ever).
  view() {
    this.sync();
    const convs = this.phones[this.who()];
    if (!convs && !this.heard) return null;
    return Object.values(convs || {}).sort((a, b) => b.at - a.at).slice(0, VIEW_CONVS)
      .map((c) => ({ key: c.key, app: c.app, appName: c.appName, name: c.name, group: c.group, reply: !!(c.reply && this.sessionUp), pic: !!(c.pic && this.sessionUp), at: c.at, items: c.items.slice(-VIEW_ITEMS) }));
  }

  stop() {
    clearTimeout(this.saveTimer);
    try { fs.writeFileSync(this.file, JSON.stringify({ phones: this.phones })); } catch {}
  }
}

module.exports = { Chats, T, APPS, isChatApp };

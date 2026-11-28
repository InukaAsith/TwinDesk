// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A phone's notifications here (notifs.js on Mac, PC and Linux) kept in step with the phone
// (Notifs.kt there):
//   notif {..., actions?: [title]}   from the phone: its buttons that need no typing (Mark as read…)
//   notif.act {id, i}                to the phone: one of them, clicked here
//   notif.dismiss {id}               to the phone: dismissed here, gone from the phone too
//   notif.gone {id}                  from the phone: gone there (swiped, opened, answered), gone here
// An older phone app sends no actions and no notif.gone, and ignores the other two.
'use strict';

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

// The buttons of a notif message: up to 3 short titles.
function actionsOf(m) {
  return Array.isArray(m && m.actions) ? m.actions.filter((a) => typeof a === 'string' && a.trim()).slice(0, 3).map((a) => a.slice(0, 40)) : [];
}

// Adds gone(id), act(id, i) and dismiss(id) to a notifs.js class. Its instances have history
// (newest first), live (an Array or a Set of shown Notifications, each with tdId), a way to send
// (send(m)) and to say they changed (changed()).
function withPhoneActions(Cls) {
  Object.assign(Cls.prototype, {
    // Gone here: from the list, and its notification closed.
    gone(id) {
      id = str(id, 200);
      if (!id) return;
      if (this.pop) this.pop.gone(id);
      const had = (this.history || []).length;
      this.history = (this.history || []).filter((h) => h.id !== id);
      for (const n of [...(this.live || [])]) {
        if (n.tdId !== id) continue;
        try { n.close(); } catch {}
        if (this.live instanceof Set) this.live.delete(n);
        else this.live = this.live.filter((x) => x !== n);
      }
      if (this.history.length !== had) this.changed();
    },
    act(id, i) {
      const item = (this.history || []).find((h) => h.id === id);
      if (!item || !Number.isInteger(i) || !(item.actions || [])[i]) return false;
      this.send({ t: 'notif.act', id: item.id, i });
      return true;
    },
    dismiss(id) {
      const item = (this.history || []).find((h) => h.id === id);
      if (!item) return false;
      this.send({ t: 'notif.dismiss', id: item.id });
      this.gone(item.id);
      return true;
    },
  });
}

// Multi-device (mac|windows|linux/mesh/notifs.js): the same list, for every device's notifications.
// Each item keeps the device it came from (`from`); its buttons, Reply and dismiss go back to that
// device only, and only while it is connected here (a notification relayed by another computer has
// none). Its instances have bus (send(id, m), connectedIds()) and changed().
function withMeshPhoneActions(Cls) {
  withPhoneActions(Cls);
  Object.assign(Cls.prototype, {
    // A notification just shown: into the list (newest first, 50 kept). `direct` = it came from the
    // device it started on. Returns the item.
    remember(m, { from, origin, on, direct }) {
      if (!this.history) this.history = [];
      if (!this.historyIcons) this.historyIcons = new Map();
      const appName = str(m.appName, 100);
      const item = {
        id: str(m.id, 200) || String(Date.now()),
        app: str(m.app, 200), appName,
        title: str(m.title, 200) || appName || str(on, 100),
        subtitle: str(m.subtitle, 200), body: str(m.body, 1000),
        at: Math.round(Number(m.at)) || Date.now(),
        on: str(on, 100), from: str(origin || from, 200),
        reply: direct && m.reply === true,
        actions: direct ? actionsOf(m) : [],
      };
      if (item.app && typeof m.icon === 'string' && m.icon.startsWith('data:image/') && m.icon.length < 200000) {
        this.historyIcons.delete(item.app);
        this.historyIcons.set(item.app, m.icon);
        if (this.historyIcons.size > 60) this.historyIcons.delete(this.historyIcons.keys().next().value);
      }
      this.history = [item, ...this.history.filter((x) => !(x.id === item.id && x.from === item.from))].slice(0, 50);
      return item;
    },
    // notif.act / notif.dismiss / notif.reply: to the device the notification came from.
    send(m) {
      const item = (this.history || []).find((h) => h.id === m.id);
      if (!item || !item.from || !this.bus.connectedIds().includes(item.from)) return false;
      this.bus.send(item.from, m);
      return true;
    },
    reply(id, text) {
      const item = (this.history || []).find((h) => h.id === id);
      if (!item || !item.reply || typeof text !== 'string' || !text.trim()) return false;
      if (!this.send({ t: 'notif.reply', id: item.id, text: text.slice(0, 5000) })) return false;
      item.replies = [...(item.replies || []), { text: text.slice(0, 5000), at: Date.now() }].slice(-20);
      this.changed();
      return true;
    },
    clearHistory() {
      this.history = [];
      this.changed();
    },
    // For view(): the list and the icons of its apps.
    historyView() {
      const h = this.history || [];
      const icons = this.historyIcons || new Map();
      return {
        history: h,
        historyIcons: Object.fromEntries([...new Set(h.map((x) => x.app))].filter((a) => icons.has(a)).map((a) => [a, icons.get(a)])),
      };
    },
  });
}

// How a phone's notification is shown here (shared/notifrules.js, shared/notifpop.js), for every
// notifs.js. Before anything: hidden(n, m) → true for an app set to Hide (not kept either). After
// it's in the list: present(n, item, m, {from, code, icon}) → 'popup' (TwinDesk's window showed it),
// 'native' (the caller shows the system's) or 'none' (quiet: the list only). A one-time code goes
// on the clipboard by itself when that's on. A progress bar's updates fill TwinDesk's window in
// place; with the system's, only its first one and its end show.
const rules = () => require('./notifrules.js');
// origin: the device it started on (Multi-device: an app hidden from that device, notifrules fromApps).
function hidden(n, m, origin) {
  return rules().modeOf(n.cfg, m, undefined, origin) === 'hide';
}
function present(n, item, m, { from, code, icon } = {}) {
  const r = rules();
  const mode = r.modeOf(n.cfg, m, undefined, item && item.origin);
  if (code && n.cfg.otpCopy && mode !== 'hide') { try { require('./otp.js').quietCopy(code); } catch (_) { /* no clipboard (tests) */ } }
  if (mode !== 'show') return 'none';
  const pop = require('./notifpop.js');
  let electron = null;
  try { electron = require('electron'); } catch (_) { /* plain node */ }
  if (pop.popupOn(n.cfg) && electron && typeof electron === 'object' && electron.BrowserWindow) { // under plain node (tests): the system's
    if (!n.pop) {
      n.pop = new pop.NotifPop({
        corner: process.platform === 'win32' ? 'bottom' : 'top',
        getLanguage: () => languageOf(n),
        act: (id, i) => n.act(id, i),
        reply: (id, text) => n.reply(id, text),
        dismiss: (id) => n.dismiss(id),
        open: (it) => { const c = { app: it.app, appName: it.appName, ...(it.from ? { originId: it.from } : {}) }; if (n.onClick) n.onClick(c); else if (n.emit) n.emit('click', c); },
        copy: (c) => require('electron').clipboard.writeText(c),
      });
    }
    n.pop.show(item, { from, code, icon });
    return 'popup';
  }
  if (item.live) {
    if (!n.liveSeen) n.liveSeen = new Set();
    const seen = n.liveSeen.has(item.id);
    n.liveSeen.add(item.id);
    if (n.liveSeen.size > 100) n.liveSeen.delete(n.liveSeen.values().next().value);
    if (seen && !item.live.done) return 'none';
  }
  return 'native';
}
// Gone from the phone: its TwinDesk window too.
function popGone(n, id) {
  if (n.pop) n.pop.gone(id);
}
function languageOf(n) {
  try {
    const s = n.settings || (n.getSettings && n.getSettings()) || {};
    const I18n = require('./i18n.js');
    return I18n.resolveLanguage((s.ui && s.ui.language) || '', require('electron').app.getLocale());
  } catch (_) {
    return 'en';
  }
}

module.exports = { actionsOf, withPhoneActions, withMeshPhoneActions, hidden, present, popGone };

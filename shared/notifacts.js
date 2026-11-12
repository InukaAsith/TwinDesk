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

module.exports = { actionsOf, withPhoneActions, withMeshPhoneActions };

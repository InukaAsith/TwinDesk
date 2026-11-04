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

module.exports = { actionsOf, withPhoneActions };

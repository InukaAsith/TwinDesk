// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device (mac|windows|linux/mesh): a phone feature written for one phone's link ('client',
// 'closed', 't:<type>', sendToClient, current) once per phone of the PhoneSet (mesh/phones.js).
// Each is made with that phone's stack (PhoneSet's onUnit), so it hears the phone's first messages,
// or, for one behind a switch, when the switch is turned on; the pages see the active phone's.
//
//   const set = new PerPhone((link, unit) => instance, { want: () => bool })
//   set.unit(u)      from onUnit: made now, while wanted
//   set.load(units)  the switch turned on: made for every phone there is
//   set.of(u)        that phone's, or null;  set.each(fn)
//
//   phoneMedia({ NowPlaying, cfg, onChange, phones: () => PhoneSet }) → the ipc's `nowPlaying`
//     (apply(), control(a, pos), view) over one shared/nowplaying.js per phone, plus unit(u).
'use strict';

class PerPhone {
  constructor(make, { want = () => true } = {}) {
    this.make = make;
    this.want = want;
    this.made = new Map(); // unit → instance
  }

  unit(u) {
    if (!u) return null;
    if (this.made.has(u)) return this.made.get(u);
    if (!this.want()) return null;
    const x = this.make(u.link, u);
    this.made.set(u, x);
    return x;
  }

  load(units) {
    for (const u of units || []) this.unit(u);
  }

  of(u) {
    return (u && this.made.get(u)) || null;
  }

  each(fn) {
    for (const x of this.made.values()) fn(x);
  }
}

// What plays on each phone (Audio › Media controls): one NowPlaying per phone while the switch is
// on; the Overview's controls and view are the active phone's.
function phoneMedia({ NowPlaying, cfg, onChange, phones }) {
  const set = new PerPhone((link) => {
    const n = new NowPlaying({ server: link, cfg });
    n.on('change', onChange);
    n.apply(); // a phone already there is asked now
    return n;
  }, { want: () => cfg().phoneMedia !== false });
  const active = () => { const p = phones(); return p ? set.of(p.active) : null; };
  return {
    unit: (u) => set.unit(u),
    // The switch: on, made for every phone and asked; off, each one stops.
    apply() {
      const p = phones();
      if (p) set.load(p.all);
      set.each((n) => n.apply());
    },
    control(a, pos) {
      const n = active();
      if (n) n.control(a, pos);
    },
    get view() {
      const n = active();
      return n ? n.view : null;
    },
  };
}

module.exports = { PerPhone, phoneMedia };

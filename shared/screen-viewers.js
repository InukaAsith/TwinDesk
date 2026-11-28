// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Monitor 2 per device (#256), Windows and Linux: another computer's screen in a window here, one window per
// computer. The first Monitor 2 (the tray's, the apps windows'; on a sticky link that stays with the device
// it shows while open, and follows a device that starts sharing) stays as it was. Open for a device it isn't
// showing, while it shows another, opens a Monitor 2 of that device's own, on its own link: two computers'
// screens at once, each with its own picture, input, sound and screen.ctl, instead of one taking the other's.
//
// Never two on one device: both answered its one stream and both stayed black. So a closed Monitor 2 of a
// device's own lets go of its device (its link is bound to nobody until it opens again), and the first one
// doesn't go to a device another one shows: it waits on nobody instead.
//
//   screenViewers({ hub, primary, primaryLink, make(link, id) → Screen })
//     open(id)        the Monitor 2 of that device (the first one when it's free or already that device's)
//     of(id)          its Screen if there is one showing or open for it, else null
//     showing(id)     whether a Monitor 2 of its own (not the first one) shows that device
//     each(fn)        every Monitor 2 (a setting changed)
'use strict';

const { scopedLink } = require('./scoped-link.js');
const { LinkMemory } = require('./link-memory.js');

class ScreenViewers {
  constructor({ hub, primary, primaryLink, make }) {
    Object.assign(this, { hub, primary, primaryLink, make });
    this.extra = new Map(); // device id -> { s: Screen, link, fns: type -> [fn] }, made the first time it's opened
    // Each device's last screen.state, told to its own Monitor 2 as it opens: it's made (or comes back) long
    // after that device said it, and without it never asked a device to share ("Waiting for the other computer").
    this.memory = new LinkMemory(hub.bus, ['screen.state']);
    const moveTo = primaryLink.moveTo;
    primaryLink.moveTo = (next) => moveTo(next && this.showing(next) ? null : next);
  }

  _shown(s) {
    return !!(s && s.win && !s.win.isDestroyed() && s.win.isVisible());
  }

  showing(id) {
    const x = id ? this.extra.get(id) : null;
    return !!(x && x.link.id === id && this._shown(x.s));
  }

  of(id) {
    if (!id) return null;
    if (this.primaryLink.id === id) return this.primary();
    return this.showing(id) ? this.extra.get(id).s : null;
  }

  open(id) {
    if (this.showing(id)) return this.extra.get(id).s.open(false);
    const first = this.primary();
    if (!id || !this._shown(first) || this.primaryLink.id === id) {
      if (id && this.primaryLink.id !== id) this.primaryLink.moveTo(id);
      return first.open(false);
    }
    let x = this.extra.get(id);
    if (!x) {
      const link = scopedLink(this.hub, id);
      const fns = new Map();
      const on = link.on;
      link.on = (type, fn) => { if (!fns.has(type)) fns.set(type, []); fns.get(type).push(fn); on(type, fn); };
      x = { link, fns, s: null };
      x.s = this.make(link, id);
      this.extra.set(id, x);
    } else if (x.link.id === id) {
      return x.s.open(false);
    }
    x.link.bind(id);
    x.link.welcome(); // its device is connected already: as if it had just come
    for (const m of this.memory.replay(id)) for (const fn of x.fns.get(m.t) || []) fn(m);
    x.s.open(false);
    this._watch(x, id);
  }

  // Closed (hidden): after its own close work (screen.policy off, Stop for sharing it started), it lets go.
  _watch(x, id) {
    const w = x.s.win;
    if (!w || w.viewersWatched) return;
    w.viewersWatched = true;
    w.on('hide', () => setImmediate(() => {
      if (this._shown(x.s) || x.link.id !== id) return;
      for (const fn of x.fns.get('closed') || []) fn({});
      x.link.bind(null);
    }));
  }

  each(fn) {
    fn(this.primary());
    for (const x of this.extra.values()) fn(x.s);
  }
}

module.exports = { ScreenViewers, screenViewers: (o) => new ScreenViewers(o) };

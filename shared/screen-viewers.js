// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Monitor 2 per device (#256), Windows and Linux: another computer's screen in a window here, one window per
// computer. The first Monitor 2 (the tray's, the apps windows'; on a sticky link that stays with the device
// it shows while open, and follows a device that starts sharing) stays as it was. Open for a device it isn't
// showing, while it shows another, opens a Monitor 2 of that device's own, on its own link: two computers'
// screens at once, each with its own picture, input, sound and screen.ctl, instead of one taking the other's.
//
//   screenViewers({ hub, primary, primaryLink, make(link, id) → Screen })
//     open(id)        the Monitor 2 of that device (the first one when it's free or already that device's)
//     of(id)          its Screen if there is one showing or open for it, else null
//     each(fn)        every Monitor 2 (a setting changed)
'use strict';

const { scopedLink } = require('./scoped-link.js');

class ScreenViewers {
  constructor({ hub, primary, primaryLink, make }) {
    Object.assign(this, { hub, primary, primaryLink, make });
    this.extra = new Map(); // device id -> Screen, made the first time it's opened
  }

  _shown(s) {
    return !!(s && s.win && !s.win.isDestroyed() && s.win.isVisible());
  }

  of(id) {
    if (!id) return null;
    if (this.primaryLink.id === id) return this.primary();
    const s = this.extra.get(id);
    return s && this._shown(s) ? s : null;
  }

  open(id) {
    const first = this.primary();
    if (!id || !this._shown(first) || this.primaryLink.id === id) {
      if (id && this.primaryLink.id !== id) this.primaryLink.moveTo(id);
      return first.open(false);
    }
    let s = this.extra.get(id);
    if (!s) {
      const link = scopedLink(this.hub, id);
      s = this.make(link, id);
      this.extra.set(id, s);
      link.welcome(); // its device is connected already: as if it had just come
    }
    return s.open(false);
  }

  each(fn) {
    fn(this.primary());
    for (const s of this.extra.values()) fn(s);
  }
}

module.exports = { ScreenViewers, screenViewers: (o) => new ScreenViewers(o) };

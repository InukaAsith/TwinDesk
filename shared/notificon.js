// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// App icons with notifications (notif {icon}: a small PNG data: URL). The sender adds an app's icon
// to its first notification in a session only (Bluetooth stays light); the receiver keeps it by app
// for the ones after, and shows TwinDesk's own icon for an app it has none for.
'use strict';

const MAX = 48000; // characters of the data: URL (a 64 px PNG is far less)

const valid = (s) => typeof s === 'string' && s.length <= MAX && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s);

class IconsOut {
  constructor() {
    this.session = null;
    this.sent = new Set();
  }

  // The icon to put in this notification for this session, or undefined (sent already, or none).
  take(session, app, icon) {
    if (session !== this.session) {
      this.session = session;
      this.sent = new Set();
    }
    if (!valid(icon) || this.sent.has(app)) return undefined;
    this.sent.add(app);
    return icon;
  }
}

class IconsIn {
  // fallback: a path or NativeImage for apps without an icon (null: the system shows the app's own).
  constructor(nativeImage, fallback = null) {
    this.nativeImage = nativeImage;
    this.fallback = fallback;
    this.byApp = new Map();
  }

  // The icon for a notification that came in (keeps one that came with it).
  for(m) {
    const app = typeof m.app === 'string' ? m.app.slice(0, 300) : '';
    if (valid(m.icon) && app) {
      const img = this.nativeImage.createFromDataURL(m.icon);
      if (!img.isEmpty()) {
        this.byApp.delete(app);
        this.byApp.set(app, img);
        if (this.byApp.size > 200) this.byApp.delete(this.byApp.keys().next().value);
      }
    }
    return this.byApp.get(app) || this.fallback || undefined;
  }
}

module.exports = { IconsOut, IconsIn };

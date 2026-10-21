// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files on their way, in a notification with a live progress bar: org.freedesktop.Notifications
// through gdbus (glib's, on every desktop), each update replacing the last (replaces_id) with the
// `value` hint, which KDE and others draw as a bar; GNOME shows the percentage in the text.
// Electron's own notifications can't do either. One per tag ('recv', 'send').
'use strict';

const { execFile } = require('child_process');

const q = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; // a GVariant string

class LiveProgress {
  constructor(icon) {
    this.icon = icon;
    this.ids = {}; // tag -> the notification's id (0: none yet)
    this.busy = {}; // tag -> a call is running (updates in between are dropped; the next one says it all)
    this.at = {}; // tag -> when it was last updated
  }

  // value: 0..100, or -1 when it isn't known.
  progress(tag, title, body, value) {
    if (this.busy[tag] || Date.now() - (this.at[tag] || 0) < 500) return;
    this.at[tag] = Date.now();
    const hints = value >= 0 ? `{'value': <int32 ${Math.round(value)}>, 'transient': <true>}` : "{'transient': <true>}";
    this._notify(tag, title, value >= 0 ? `${body} · ${Math.round(value)} %` : body, hints, 0);
  }

  // The bar's notification says how it ended ('' title: it goes).
  done(tag, title, body) {
    if (!this.ids[tag] && !this.busy[tag]) return;
    const id = this.ids[tag];
    this.ids[tag] = 0;
    this.at[tag] = 0;
    if (!title) {
      if (id) this._call(['--method', 'org.freedesktop.Notifications.CloseNotification', String(id)], () => {});
      return;
    }
    this._notify(tag, title, body, '{}', 5000, id, true);
  }

  _notify(tag, title, body, hints, timeout, replace = this.ids[tag] || 0, last = false) {
    this.busy[tag] = true;
    this._call(['--method', 'org.freedesktop.Notifications.Notify', q('TwinDesk'), String(replace), q(this.icon), q(title), q(body), '[]', hints, String(timeout)], (out) => {
      this.busy[tag] = false;
      const m = /uint32 (\d+)/.exec(out || '');
      if (m && !last) this.ids[tag] = Number(m[1]);
    });
  }

  _call(args, done) {
    execFile('gdbus', ['call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications', ...args],
      { timeout: 5000 }, (err, out) => done(err ? '' : out));
  }
}

module.exports = { LiveProgress };

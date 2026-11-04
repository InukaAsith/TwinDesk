// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Mac apps on the PC: app list, launch, and the windows of launched
// apps as rectangles normalized over the stream picture, so the PC crops each into its own window.
// ReZume sends an app that is already open the same way (adopt): independent of "apps.offer", and
// closing its copy on the PC stops only that copy (the window stays open here). A window moved to
// the PC (Move windows, the move key held) goes the same way too: that one window onto the shared
// display; closing its copy there brings it back where it was.
//
// Events: 'change' — this.view changed.
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

const POLL_MS = 100; // ≤ 10 app.windows per second, only when something changed
const IDLE_OFF_MS = 8000; // no app windows this long: the screen share we turned on goes off again

class Apps extends EventEmitter {
  constructor({ server, helper, displays, stream, getSettings }) {
    super();
    Object.assign(this, { server, helper, displays, stream, getSettings });
    this.launched = new Map(); // bundle id -> { pid, name, rz?, skip? }
    this.moved = new Map(); // wid -> { pid, x, y }: windows moved to the PC, and where they were (points)
    this.lastKey = '';
    this.windows = [];
    this.timer = null;
    // Opening an app turns screen sharing on if it was off; it goes off again when the apps are
    // done. setSharing(on) is wired by main (ipc actions).
    this.setSharing = null;
    this.autoShare = false;
    this.emptySince = 0;

    const on = (t, fn) => server.on(`t:${t}`, fn);
    on(P.T.APPS_LIST, () => this._list());
    on(P.T.APP_LAUNCH, (m) => this._launch(String(m.id || '')));
    on(P.T.APP_FOCUS, (m) => this.helper.request('appFocus', { wid: Number(m.wid) }).catch(() => {}));
    on(P.T.APP_CLOSE, (m) => {
      const wid = Number(m.wid);
      if (this.moved.has(wid)) return this.bringBack(wid); // a moved window isn't closed: it comes back
      if (!this._unfollow(wid)) this.helper.request('appClose', { wid }).catch(() => {});
    });
    // Its copy there dragged back past the edge with the move key: it comes in under the pointer.
    on(P.T.APP_RETURN, (m) => this.moved.has(Number(m.wid)) && this.bringBack(Number(m.wid), true));
    server.on('closed', () => {
      if (!server.current) {
        this.bringBack();
        this._stopPolling();
        if (this.autoShare && this.setSharing) this.setSharing(false, 'apps');
        this.autoShare = false;
      }
    });
  }

  get enabled() {
    return this.getSettings().apps.offer !== false;
  }

  async _list() {
    if (!this.enabled) return this.server.sendToClient({ t: P.T.APPS_RESULT, apps: [], why: 'off' });
    try {
      const r = await this.helper.request('appsList', {}, 20000);
      this.server.sendToClient({ t: P.T.APPS_RESULT, apps: r.apps });
    } catch (e) {
      this.server.sendToClient({ t: P.T.APPS_RESULT, apps: [], why: e.message });
    }
  }

  async _launch(id) {
    const reply = (ok, why) => this.server.sendToClient({ t: P.T.APP_LAUNCHED, id, ok, ...(why ? { why } : {}) });
    if (!this.enabled) return reply(false, 'off');
    if (!/^[A-Za-z0-9.-]{1,200}$/.test(id) || /^com\.apple\.(Siri|siri)/.test(id)) return reply(false, 'not offered');
    if (!this.getSettings().sharing.on && this.setSharing) {
      this.autoShare = true;
      this.setSharing(true, 'apps');
    }
    this.emptySince = 0;
    try {
      const { pid } = await this.helper.request('appLaunch', { appId: id }, 20000);
      this.launched.set(id, { pid });
      reply(true);
      this._follow(pid);
    } catch (e) {
      reply(false, e.message);
    }
  }

  // ReZume: the windows of an app that is open here (its bundle id), on the PC. Like opening it
  // from the PC's Apps tab, without its switch.
  async adopt(id) {
    if (!/^[A-Za-z0-9.-]{1,200}$/.test(id) || !this.server.current) return false;
    const had = this.launched.get(id);
    if (had) {
      if (had.skip) had.skip.clear();
      this.lastKey = '';
      this._moveOnto(had.pid);
      return true;
    }
    if (!this.getSettings().sharing.on && this.setSharing) {
      this.autoShare = true;
      this.setSharing(true, 'apps');
    }
    this.emptySince = 0;
    try {
      const { pid } = await this.helper.request('appLaunch', { appId: id }, 20000);
      this.launched.set(id, { pid, rz: true, skip: new Set() });
      this._follow(pid);
      return true;
    } catch (e) {
      console.log('[apps] ReZume window not sent: ' + e.message);
      return false;
    }
  }

  // ReZume's window sharing turned off (app: only that app's windows).
  unadopt(app) {
    for (const [id, a] of this.launched) if (a.rz && (!app || id === app)) this.launched.delete(id);
    this.lastKey = '';
  }

  // A window ReZume sent, closed on the PC: only its copy goes.
  _unfollow(wid) {
    const w = this.windows.find((x) => x.wid === wid);
    const a = w && this.launched.get(w.id);
    if (!a || !a.rz) return false;
    a.skip.add(wid);
    this.lastKey = '';
    return true;
  }

  // Move windows: a window grabbed with the move key crossed to the PC. It goes over as the PC's
  // Apps tab opens Mac apps: onto the shared display (screen sharing on if it was off), cropped there.
  async moveOut(wid, pid) {
    if (!wid || !pid || !this.getSettings().apps.moveWindows || !this.server.current) return false;
    if (this.moved.has(wid) || this.windows.some((w) => w.wid === wid)) return false;
    const r = await this.helper.request('appWindows', { pids: [pid] }).catch(() => null);
    const w = r && Array.isArray(r.windows) && r.windows.find((x) => x.wid === wid);
    if (!w) return false;
    if (!this.getSettings().sharing.on && this.setSharing) {
      this.autoShare = true;
      this.setSharing(true, 'apps');
    }
    this.emptySince = 0;
    this.moved.set(wid, { pid, x: w.x, y: w.y, w: w.w });
    this.lastKey = '';
    this._startPolling();
    // Once the grab let go (and the shared display exists): that window onto it.
    for (const ms of [60, 500, 1500, 3000]) setTimeout(() => this._placeOnto(wid), ms);
    this.emit('change');
    return true;
  }

  _placeOnto(wid) {
    const t = this.moved.has(wid) && this.displays.target();
    if (t) this.helper.request('appPlace', { wid, x: t.bounds.x + 40, y: t.bounds.y + 60 }).catch(() => {});
  }

  // Moved windows (one, or all of them) back where they were. home: dragged back, so it shows where
  // the pointer came in, its title bar under it.
  bringBack(wid, home = false) {
    let any = false;
    for (const [id, m] of [...this.moved]) {
      if (wid !== undefined && id !== wid) continue;
      this.moved.delete(id);
      any = true;
      let at = { x: m.x, y: m.y };
      if (home) {
        const p = require('electron').screen.getCursorScreenPoint();
        at = { x: Math.round(p.x - m.w / 2), y: Math.max(0, Math.round(p.y - 12)) };
      }
      this.helper.request('appPlace', { wid: id, x: at.x, y: at.y }).catch(() => {});
    }
    if (any) {
      this.lastKey = '';
      this.emit('change');
    }
  }

  _follow(pid) {
    this.lastKey = '';
    this._startPolling();
    // New windows appear a moment after launch: move them onto the shared display a few times.
    for (const ms of [300, 1000, 2500]) setTimeout(() => this._moveOnto(pid), ms);
    this.emit('change');
  }

  _moveOnto(pid) {
    const t = this.displays.target();
    if (t) this.helper.request('appMove', { pid, bounds: t.bounds }).catch(() => {});
  }

  _startPolling() {
    if (!this.timer) this.timer = setInterval(() => this._poll(), POLL_MS);
  }

  _stopPolling() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // The apps are done (all quit, or no windows for a while): undo the screen share we turned on.
  _idle(empty) {
    if (!empty) {
      this.emptySince = 0;
      return;
    }
    if (!this.emptySince) this.emptySince = Date.now();
    if (this.autoShare && Date.now() - this.emptySince > IDLE_OFF_MS) {
      this.autoShare = false;
      if (this.setSharing) this.setSharing(false, 'apps');
      console.log('[apps] no app windows left: screen sharing off again');
    }
    if (!this.launched.size && !this.moved.size && !this.autoShare) this._stopPolling();
  }

  async _poll() {
    if ((!this.launched.size && !this.moved.size) || !this.server.current) return this._idle(true);
    const t = this.displays.target();
    if (!t) return;
    let r;
    try {
      const pids = new Set([...this.launched.values()].map((a) => a.pid).concat([...this.moved.values()].map((m) => m.pid)));
      r = await this.helper.request('appWindows', { pids: [...pids] });
    } catch {
      return;
    }
    const idOf = new Map([...this.launched].map(([id, a]) => [a.pid, id]));
    const b = t.bounds;
    // A moved window that closed here is forgotten; of a moved window's app only that window goes.
    for (const wid of [...this.moved.keys()]) if (!r.windows.some((w) => w.wid === wid)) this.moved.delete(wid);
    const skipped = (w) => {
      if (this.moved.has(w.wid)) return false;
      const a = this.launched.get(idOf.get(w.pid));
      return !a || !!(a.skip && a.skip.has(w.wid));
    };
    const wins = r.windows
      .filter((w) => !skipped(w))
      .filter((w) => w.x < b.x + b.width && w.x + w.w > b.x && w.y < b.y + b.height && w.y + w.h > b.y) // on the shared display
      .map((w) => ({
        wid: w.wid, id: idOf.get(w.pid) || 'moved', title: w.title, ...(this.moved.has(w.wid) ? { moved: true } : {}),
        x: (w.x - b.x) / b.width, y: (w.y - b.y) / b.height, w: w.w / b.width, h: w.h / b.height,
      }));
    // Apps that quit are forgotten.
    const alive = new Set(r.windows.map((w) => w.pid));
    for (const [id, a] of this.launched) if (!alive.has(a.pid) && !(await this._running(a.pid))) this.launched.delete(id);
    // Compare at ~1/1000 of the picture so 1 px jitter while resizing doesn't resend.
    this._idle(!wins.length);
    const key = JSON.stringify(wins.map((w) => [w.wid, w.title, w.x.toFixed(3), w.y.toFixed(3), w.w.toFixed(3), w.h.toFixed(3)]));
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.windows = wins;
    // pw/ph: pixel size of the stream picture, so the PC opens each app window at 1:1 (no scaling).
    const pw = this.stream.view.width || t.pixelWidth;
    const ph = this.stream.view.height || t.pixelHeight;
    this.server.sendToClient({ t: P.T.APP_WINDOWS, windows: wins, pw, ph });
    this.emit('change');
  }

  _running(pid) {
    try {
      process.kill(pid, 0);
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }

  applySettings() {
    if (!this.getSettings().apps.moveWindows) this.bringBack(); // Move windows off: every moved window back here
    if (!this.enabled) {
      for (const [id, a] of this.launched) if (!a.rz) this.launched.delete(id);
      this.lastKey = '';
      if (!this.launched.size && !this.moved.size) {
        this._stopPolling();
        this.server.sendToClient({ t: P.T.APP_WINDOWS, windows: [] });
      }
    }
    this.emit('change');
  }

  shutdown() {
    this.bringBack(); // quitting: every moved window back here
  }

  get view() {
    return { launched: [...this.launched.keys()], windows: this.windows.length };
  }
}

module.exports = { Apps };

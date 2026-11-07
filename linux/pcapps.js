// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Apps, this computer → the other one (copy of windows/pcapps.js): the
// app-menu apps (desktopapps.js) with icons, opened on the other computer's request; every visible
// window of an app opened that way is streamed on its own (`rtc2` kind 'window', sender.js) while
// its `papp.policy` accepts and "Open {me}'s apps on {name}" is on — menus and pop-ups too, as
// `popup` entries with their `owner` and offset. Its input in such a window (`in.*` + `wid`) is
// injected at that window. A GTK window's shadow is cut off its picture (`inset`). Windows come
// from the helper (`windows`, EWMH): X11 only; on Wayland no app may list or capture other
// apps' windows. ReZume sends an app that is already open the same way (adopt, by its WM_CLASS):
// independent of this tab's switch, and closing its copy there stops only that copy.
const { desktopCapturer, screen: displays } = require('electron');
const fs = require('fs');
const path = require('path');
const P = require('../shared/protocol.js');
const desktopApps = require('./desktopapps');
const RemoteInput = require('./remote-input');
const PcScreen = require('./pcscreen'); // fps()

const T = P.T;
const POLL_MS = 250;
const ICON_PX = 128;
const MAX_POPUPS = 6; // per app: a menu, its submenus, a drop-down
const MAX_W = 3840, MAX_H = 2160; // window pictures follow the window's size up to this
const WAYLAND = process.env.XDG_SESSION_TYPE === 'wayland';

// /proc: a process's parent and program name.
function procInfo(pid) {
  try {
    const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]) || 0;
    let exe = '';
    try { exe = path.basename(fs.readlinkSync('/proc/' + pid + '/exe')); } catch (_) { exe = st.slice(st.indexOf('(') + 1, st.lastIndexOf(')')); }
    return { ppid, exe: exe.toLowerCase() };
  } catch (_) {
    return { ppid: 0, exe: '' };
  }
}

class PcApps {
  // opts: link, helper, sender, settings (shared), inputAllowed(), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.macAccepts = false; // papp.policy
    this.apps = null; // desktopapps.list() (cached)
    this.icons = new Map(); // id → data URL
    this.launched = new Map(); // id → {id, exe, pids: Set, since, before: Set(wid), had, lastSeen}
    this.windows = []; // the list last sent to the Mac
    this.streams = new Map(); // wid → session
    this.moved = new Map(); // wid → {x, y, w, h, pid}: windows moved to the other computer (shared/movewin.js), and where they were
    this.failed = new Set(); // wids whose capture failed (not retried)
    this.timer = null;
    this.sentKey = '';
    this.message = '';
    this.input = new RemoteInput(opts);

    const link = this.link;
    link.on('welcome', () => { this.macAccepts = false; this.sentKey = ''; });
    link.on('closed', () => { this.macAccepts = false; this.launched.clear(); this.bringBack(); this._sync([]); });
    link.on(T.PAPP_POLICY, (m) => {
      this.macAccepts = m.accept === true;
      if (this.macAccepts && this.allowed) this._build().catch(() => {}); // icons ready before the Mac asks
      this._sync(this.windows);
      this.onChange();
    });
    link.on(T.PAPPS_LIST, () => this._list());
    link.on(T.PAPP_LAUNCH, (m) => typeof m.id === 'string' && this._launch(m.id));
    link.on(T.PAPP_FOCUS, (m) => this._mine(m.wid) && !this._popup(m.wid) && this._raise(m.wid));
    // Closing a moved window's copy over there brings it back here (it isn't closed); one ReZume sent stays open here.
    link.on(T.PAPP_CLOSE, (m) => this._mine(m.wid) && (this.moved.has(m.wid) ? this.bringBack(m.wid) : this._unfollow(m.wid) || this.helper.send('winClose', { wid: m.wid })));
    link.on(T.PAPP_RETURN, (m) => this.moved.has(m.wid) && this.bringBack(m.wid, true));
    link.on(T.PAPP_SIZE, (m) => {
      const ok = (v) => Number.isInteger(v) && v >= 50 && v <= 16384;
      if (this._mine(m.wid) && !this._popup(m.wid) && ok(m.w) && ok(m.h)) this.helper.send('winSize', { wid: m.wid, w: m.w, h: m.h });
    });
    for (const t of RemoteInput.TYPES) link.on(t, (m) => this._input(m));
    // A top-level window appeared or went (a menu opened?): look right away instead of at the next tick.
    this.helper.on('event', (name) => name === 'winShown' && (this.launched.size || this.moved.size) && this._poll(true));
    this.helper.on('ready', () => this._moveKey()); // a restarted helper is told the move key again
    this.sender.on('state', (session, s) => {
      if (s.status !== 'ended' && s.status !== 'failed') return;
      for (const [wid, ses] of this.streams) {
        if (ses !== session) continue;
        this.streams.delete(wid);
        this.failed.add(wid);
        this.sender.stop(session);
      }
    });
  }

  get allowed() {
    return this.settings.pcApps.allow;
  }

  // An app followed for ReZume (adopt), which this tab's switch doesn't stop.
  get rezumes() {
    for (const a of this.launched.values()) if (a.rz) return true;
    return false;
  }

  // The switch changed. Off: nothing is followed or streamed any more (the apps keep running),
  // except what ReZume sent.
  apply() {
    if (!this.settings.pcApps.moveWindows) this.bringBack(); // moving is its own switch, apart from letting the other open apps
    this._moveKey();
    if (!this.allowed) {
      for (const [id, a] of this.launched) if (!a.rz) this.launched.delete(id);
      if (this.launched.size) this._poll(true);
      else this._sync([]);
    }
    this.onChange();
  }

  // The helper grabs a window with the move key and a click (wins.c, X11); "" = off.
  _moveKey() {
    const c = this.settings.pcApps;
    this.helper.send('moveWin', { key: c.moveWindows && !WAYLAND ? c.moveKey : '' });
  }

  // Move windows (shared/movewin.js, loaded only when used): a grabbed window crossed with the
  // pointer goes over there; bringBack returns one or all of them.
  moveOut(wid) {
    if (!this.settings.pcApps.moveWindows || WAYLAND) return Promise.resolve(false);
    return require('../shared/movewin.js').moveOut(this, wid);
  }

  bringBack(wid, home = false) {
    if (this.moved.size) require('../shared/movewin.js').bringBack(this, wid, home);
  }

  _cursorPx() {
    const p = displays.getCursorScreenPoint();
    const k = displays.getPrimaryDisplay().scaleFactor || 1; // X11: one scale for the whole desktop
    return { x: Math.round(p.x * k), y: Math.round(p.y * k) };
  }

  _movedExtra(w) {
    return { ...workArea(w), ...inset(w) };
  }

  // ReZume can send windows only where they can be listed and captured (X11).
  get canAdopt() {
    return !WAYLAND;
  }

  // ReZume: the windows of an app that is open here (its WM_CLASS), streamed to the other computer.
  adopt(cls) {
    if (WAYLAND || typeof cls !== 'string' || !cls || this.link.status.state !== 'connected') return false;
    const key = cls.toLowerCase();
    for (const a of this.launched.values()) {
      if (a.cls !== key) continue;
      if (a.skip) a.skip.clear();
      this._poll(true);
      return true;
    }
    this.launched.set(cls, { id: cls, exe: '', cls: key, rz: true, skip: new Set(), pids: new Set(), since: Date.now(), had: false, lastSeen: 0, before: new Set(), beforePids: new Set() });
    this._poll(true);
    return true;
  }

  // ReZume's window sharing turned off (app: only that app's windows).
  unadopt(app) {
    let any = false;
    for (const [id, a] of this.launched) if (a.rz && (!app || a.id === app)) { this.launched.delete(id); any = true; }
    if (any) this._poll(true);
  }

  // A window ReZume sent, closed there: only its copy goes. The window stays open here and comes
  // back to the front (it never left this screen).
  _unfollow(wid) {
    const w = this.windows.find((x) => x.wid === wid);
    const a = w && this.launched.get(w.id);
    if (!a || !a.rz) return false;
    a.skip.add(wid);
    this._raise(wid);
    this._poll(true);
    return true;
  }

  _mine(wid) {
    return typeof wid === 'number' && this.windows.some((w) => w.wid === wid);
  }

  _popup(wid) {
    return this.windows.some((w) => w.wid === wid && w.popup);
  }

  _raise(wid) {
    this.lastRaised = wid;
    this.helper.send('winRaise', { wid });
  }

  async _apps() {
    if (this.apps && Date.now() - this.appsAt < 60000) return this.apps;
    this.apps = desktopApps.list();
    this.appsAt = Date.now();
    return this.apps;
  }

  // The list with icons (cached; drawn once). One build at a time.
  _build() {
    if (!this.building) {
      this.building = (async () => {
        const apps = await this._apps();
        for (const a of apps) if (!this.icons.has(a.id)) this.icons.set(a.id, await desktopApps.icon(a, ICON_PX));
        return apps.map((a) => ({ id: a.id, name: a.name, icon: this.icons.get(a.id) || '' }));
      })().finally(() => { this.building = null; });
    }
    return this.building;
  }

  async _list() {
    if (!this.allowed || WAYLAND) {
      if (WAYLAND) this.message = 'Needs an Xorg session: Wayland doesn’t let apps show other apps’ windows';
      this.onChange();
      return this.link.send({ t: T.PAPPS_RESULT, apps: [] });
    }
    try {
      const apps = await this._build();
      this.message = '';
      this.link.send({ t: T.PAPPS_RESULT, apps });
    } catch (e) {
      this.message = 'Couldn’t list this computer’s apps: ' + e.message;
      this.link.send({ t: T.PAPPS_RESULT, apps: [] });
    }
    this.onChange();
  }

  async _launch(id) {
    const reply = (ok, why) => this.link.send(why ? { t: T.PAPP_LAUNCHED, id, ok, why } : { t: T.PAPP_LAUNCHED, id, ok });
    if (!this.allowed) return reply(false, 'This computer doesn’t let you open its apps (its Apps tab)');
    if (WAYLAND) return reply(false, 'Needs an Xorg session on this computer');
    const app = (await this._apps().catch(() => [])).find((a) => a.id === id);
    if (!app) return reply(false, 'No such app on this computer');
    const open = this.windows.find((w) => w.id === id);
    if (open) {
      this._raise(open.wid);
      return reply(true);
    }
    const now = await this.helper.request('windows').catch(() => ({ windows: [] }));
    let started;
    try {
      started = desktopApps.launch(app);
    } catch (e) {
      return reply(false, e.message);
    }
    const cls = String(app.wmClass || app.id.replace(/\.desktop$/, '')).toLowerCase();
    this.launched.set(id, {
      id, exe: started.exe.toLowerCase(), cls, pids: new Set(started.pid ? [started.pid] : []), since: Date.now(), had: false, lastSeen: 0,
      before: new Set((now.windows || []).map((w) => w.wid)), beforePids: new Set((now.windows || []).map((w) => w.pid)),
    });
    reply(true);
    this._poll();
  }

  // now: look right away (a window was shown/hidden); a look already running looks once more after.
  _poll(now) {
    if (this.ticking) { if (now) this.again = true; return; }
    if (this.timer && !now) return;
    clearTimeout(this.timer);
    const tick = async () => {
      this.timer = null;
      this.ticking = true;
      try {
        do {
          this.again = false;
          if ((!this.launched.size && !this.moved.size) || this.link.status.state !== 'connected') return this._sync([]);
          const r = await this.helper.request('windows').catch(() => null);
          if (r && Array.isArray(r.windows)) this._match(r.windows);
        } while (this.again);
      } finally {
        this.ticking = false;
      }
      if ((this.launched.size || this.moved.size) && !this.timer) this.timer = setTimeout(tick, POLL_MS);
    };
    this.timer = setTimeout(tick, 0);
  }

  // Which windows belong to the apps the other computer opened: the same WM_CLASS as the desktop
  // entry says, the same program, or a process already known to be the app's (and its children).
  // An app started through D-Bus or a wrapper learns its program from the first new window that
  // shows up after the launch.
  _match(all) {
    const now = Date.now();
    const info = new Map();
    for (const w of all) {
      if (!info.has(w.pid)) info.set(w.pid, w.pid ? procInfo(w.pid) : { ppid: 0, exe: '' });
      const pi = info.get(w.pid);
      w.exe = pi.exe;
      w.ppid = pi.ppid;
      w.scale = 1;
    }
    const clsOf = (w) => [w.cls, w.inst].map((x) => String(x || '').toLowerCase());
    const out = [];
    const pops = [];
    const taken = new Set();
    if (this.moved.size) require('../shared/movewin.js').list(this, all, taken, out, pops); // moved windows (Move windows)
    for (const a of this.launched.values()) {
      const id = a.id.toLowerCase();
      const mine = all.filter((w) => !taken.has(w.wid) && !(a.skip && a.skip.has(w.wid)) && ((a.cls && clsOf(w).includes(a.cls))
        || (a.exe && String(w.exe).toLowerCase() === a.exe) || a.pids.has(w.pid) || a.pids.has(w.ppid)));
      let main = mine.filter((w) => !w.popup);
      if (!main.length && !a.rz && now - a.since > 1500 && now - a.since < 20000) { // started through D-Bus or a wrapper
        const fresh = all.find((w) => !w.popup && !a.before.has(w.wid) && !a.beforePids.has(w.pid) && !taken.has(w.wid));
        if (fresh) { a.exe = String(fresh.exe).toLowerCase(); main = [fresh]; }
      }
      for (const w of main) {
        taken.add(w.wid);
        a.pids.add(w.pid);
        out.push({ wid: w.wid, id: a.id, title: w.title, w: w.w, h: w.h, scale: w.scale, ...workArea(w), ...inset(w) });
      }
      // Pop-ups: over their owner if it's one of these windows; menus have no owner, so the window
      // of the same process that was raised last, else the one under the pop-up, else the first.
      // Tiny ones (Alt key-letter hints, tooltips) are left out; at most MAX_POPUPS, biggest first.
      const popups = mine.filter((x) => x.popup && (x.w >= 64 || x.h >= 64)).sort((x, y) => y.w * y.h - x.w * x.h).slice(0, MAX_POPUPS);
      for (const w of popups) {
        const same = main.filter((m) => m.pid === w.pid);
        const owner = main.find((m) => m.wid === w.owner) || same.find((m) => m.wid === this.lastRaised)
          || same.find((m) => w.x >= m.x && w.y >= m.y && w.x < m.x + m.w && w.y < m.y + m.h) || same[0] || main[0];
        if (!owner) continue;
        taken.add(w.wid);
        pops.push({ wid: w.wid, id: a.id, title: w.title, w: w.w, h: w.h, scale: w.scale, popup: true, owner: owner.wid, x: w.x - owner.x, y: w.y - owner.y, ...inset(w) });
      }
      if (main.length) { a.had = true; a.lastSeen = now; }
      // Closed (no windows for 3 s), or never showed one in 30 s: stop following it.
      if ((a.had && now - a.lastSeen > 3000) || (!a.had && now - a.since > 30000)) this.launched.delete(a.id);
    }
    this._sync(out.concat(pops)); // owners before their pop-ups
  }

  // Send the window list on change; start/stop one stream per window.
  async _sync(list) {
    const key = JSON.stringify(list);
    if (key !== this.sentKey && this.link.status.state === 'connected') this.link.send({ t: T.PAPP_WINDOWS, windows: list.map(({ inset: _, ...w }) => w) });
    const changed = key !== this.sentKey;
    this.sentKey = key;
    this.windows = list;
    for (const wid of this.failed) if (!list.some((w) => w.wid === wid)) this.failed.delete(wid);
    const want = this.macAccepts && (this.allowed || this.rezumes) ? new Set(list.map((w) => w.wid)) : new Set();
    for (const [wid, session] of this.streams) {
      if (!want.has(wid)) {
        this.streams.delete(wid);
        this.sender.stop(session);
      } else if (changed) {
        this.sender.inset(session, (list.find((w) => w.wid === wid) || {}).inset); // maximized: no shadow any more
      }
    }
    const start = [...want].filter((wid) => !this.streams.has(wid) && !this.failed.has(wid));
    if (start.length) {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
      for (const wid of start) {
        if (this.streams.has(wid) || !this.windows.some((w) => w.wid === wid)) continue;
        const src = sources.find((s) => s.id.startsWith('window:' + wid + ':'));
        const session = this.sender.start({
          sourceId: src ? src.id : 'window:' + wid + ':0', width: MAX_W, height: MAX_H, follow: true,
          mbps: this.settings.pcScreen.mbps, fps: PcScreen.fps(displays.getPrimaryDisplay(), this.settings.pcScreen.fps),
          steady: !!(this.settings.monitor && this.settings.monitor.pacing === 'steady'), // Playback › Steady
          inset: (this.windows.find((w) => w.wid === wid) || {}).inset, offer: { kind: 'window', wid },
        });
        this.streams.set(wid, session);
      }
    }
    if (!list.length) this.input.release();
    if (changed) this.onChange();
  }

  _input(m) {
    if (m.wid == null || !this.streams.has(m.wid)) return;
    const wid = m.wid;
    // A moved window (or its pop-up): back on a screen while it's used there, so the pointer reaches it.
    // Not while this computer drives the other one: the helper holds the X pointer then (XGrabPointer).
    const pop = this.windows.find((w) => w.wid === wid && w.popup);
    const moved = !this.inputAllowed() ? 0 : this.moved.has(wid) ? wid : pop && this.moved.has(pop.owner) ? pop.owner : 0;
    if (moved) require('../shared/movewin.js').touch(this, moved);
    // A pop-up is never raised (that would close a menu); its owner is already in front.
    this.input.handle(m, (x, y) => this.helper.send('winMove', { wid, x, y }), this._popup(wid) ? null : () => this._raise(wid), undefined, !!moved);
  }

  // Quit: stop the window streams (the apps keep running on the PC).
  shutdown() {
    this.launched.clear();
    this.bringBack(); // quitting: every moved window back here
    for (const session of this.streams.values()) this.sender.stop(session);
    this.streams.clear();
  }

  view() {
    return { wayland: WAYLAND, allow: this.allowed, macAccepts: this.macAccepts, open: this.windows.length, streaming: this.streams.size, moved: this.moved.size, moveWindows: this.settings.pcApps.moveWindows, moveKey: this.settings.pcApps.moveKey, message: this.message };
  }
}

// A window's invisible border (GTK's shadow), cut off its picture: [left, right, top, bottom].
// Its place and size (x, y, w, h) are already of what's inside (the helper).
function inset(w) {
  const i = Array.isArray(w.inset) && w.inset.length === 4 ? w.inset.map((v) => Math.max(0, Number(v) || 0)) : null;
  return i && i.some(Boolean) ? { inset: i } : {};
}

// The work area of the monitor a window is on, in physical px (the other computer never
// lets its copy of the window grow past it). X11 px = DIP × scale.
function workArea(w) {
  try {
    const k = displays.getPrimaryDisplay().scaleFactor || 1;
    const d = displays.getDisplayMatching({ x: Math.round(w.x / k), y: Math.round(w.y / k), width: Math.max(1, Math.round(w.w / k)), height: Math.max(1, Math.round(w.h / k)) });
    return { maxW: Math.round(d.workArea.width * d.scaleFactor), maxH: Math.round(d.workArea.height * d.scaleFactor) };
  } catch (_) { return {}; }
}

module.exports = PcApps;

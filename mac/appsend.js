// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This Mac's apps on another Mac, way (port of windows/pcapps.js +
// sender.js). The other Mac's viewer (its pcapps.js) asks for the list (`papps.list`), opens an app
// (`papp.launch` → `open -b` through the helper), and gets `papp.windows` for the apps it opened:
// their windows and their menus / pop-ups (`popup`, `owner`, offset). Every window is its own `rtc2`
// session (kind 'window', `win: 'send'`) from a hidden capture window, only while the viewer's
// `papp.policy` accepts and "apps.offer" is on. Its input (`in.*` + `wid`) is injected at that
// window. Nothing is captured before the viewer opened an app, or ReZume sent one that is open here
// (adopt): independent of "apps.offer", and closing its copy there stops only that copy.
// Opened or adopted apps' windows are never moved here. Only a window moved over (Move windows,
// movewin.js) is kept out of the way: on TwinDesk's virtual display (held for it, displays.hold('apps')),
// else past the right edge of the screens.
//
// Events: 'change'.
'use strict';

const path = require('path');
const { BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const ScreenCodec = require('../shared/screencodec.js');

const T = P.T;
const POLL_MS = 250;
const MAX_W = 3840, MAX_H = 2160;
const MAX_POPUPS = 6;
const IN_TYPES = [T.IN_MOVE, T.IN_DOWN, T.IN_UP, T.IN_WHEEL, T.IN_KEY_DOWN, T.IN_KEY_UP];

class AppSend extends EventEmitter {
  constructor({ server, helper, displays, getSettings }) {
    super();
    Object.assign(this, { server, helper, displays, getSettings });
    this.accepts = false; // the viewer's papp.policy
    this.launched = new Map(); // app id -> {id, pids: Set, since, had, lastSeen}
    this.moved = new Map(); // wid -> {pid, x, y, w, h}: windows moved to the other computer (movewin.js), and where they were (points)
    this.windows = []; // the list last sent
    this.bounds = new Map(); // wid -> {x, y, width, height} points
    this.streams = new Map(); // wid -> session
    this.failed = new Set();
    this.live = new Set();
    this.counter = 0;
    this.sentKey = '';
    this.win = null;
    this.ready = false;
    this.queue = [];
    this.timer = null;

    server.on('client', () => {
      this.accepts = false;
      this.sentKey = '';
    });
    server.on('closed', () => {
      if (server.current) return;
      this.accepts = false;
      for (const id of [...this.launched.keys()]) this._forget(id);
      this.bringBack();
      this._sync([]);
      this._idle();
    });
    helper.on('ready', () => this._moveKey()); // a restarted helper is told the move key again
    const on = (t, fn) => server.on(`t:${t}`, fn);
    on(T.PAPP_POLICY, (m) => {
      this.accepts = m.accept === true;
      this._sync(this.windows);
    });
    on(T.PAPPS_LIST, () => this._list());
    on(T.PAPP_LAUNCH, (m) => typeof m.id === 'string' && this._launch(m.id));
    on(T.PAPP_FOCUS, (m) => this._mine(m.wid) && !this._popup(m.wid) && this.helper.request('appFocus', { wid: m.wid }).catch(() => {}));
    // Closing a moved window's copy there brings it back here (it isn't closed); one ReZume sent stays open here.
    on(T.PAPP_CLOSE, (m) => this._mine(m.wid) && (this.moved.has(m.wid) ? this.bringBack(m.wid) : !this._unfollow(m.wid) && this.helper.request('appClose', { wid: m.wid }).catch(() => {})));
    on(T.PAPP_RETURN, (m) => this.moved.has(m.wid) && this.bringBack(m.wid, true));
    on(T.PAPP_SIZE, (m) => {
      const ok = (v) => Number.isInteger(v) && v >= 50 && v <= 16384;
      const w = this.windows.find((x) => x.wid === m.wid);
      if (w && !w.popup && ok(m.w) && ok(m.h)) this.helper.request('appResize', { wid: m.wid, w: m.w / w.scale, h: m.h / w.scale }).catch(() => {});
    });
    for (const t of IN_TYPES) on(t, (m) => this._input(m));
    // Answers and candidates from the other Mac's viewer for our sessions (`win: 'view'`).
    const ours = (m) => this.live.has(m.session) && m.win === 'view';
    on(T.RTC2_ANSWER, (m) => ours(m) && typeof m.sdp === 'string' && this._toWin(m));
    on(T.RTC2_ICE, (m) => ours(m) && this._toWin(m));

    ipcMain.on('appsend-out', (e, m) => {
      if (!this._fromWin(e) || !m || !this.live.has(m.session)) return;
      if (m.t === T.RTC2_OFFER || m.t === T.RTC2_ICE) this.server.sendToClient({ ...m, win: 'send' });
    });
    ipcMain.on('appsend-state', (e, s) => {
      if (!this._fromWin(e) || !s || !this.live.has(s.session)) return;
      if (s.status !== 'ended' && s.status !== 'failed') return;
      for (const [wid, ses] of this.streams) {
        if (ses !== s.session) continue;
        this.streams.delete(wid);
        this.failed.add(wid);
        this._stop(ses);
      }
    });
    ipcMain.on('appsend-ready', (e) => {
      if (!this._fromWin(e)) return;
      this.ready = true;
      for (const m of this.queue.splice(0)) this.win.webContents.send('appsend', m);
    });
  }

  get allowed() {
    return this.getSettings().apps.offer !== false;
  }

  // An app followed for ReZume (adopt), which the Apps switch doesn't stop.
  get rezumes() {
    for (const a of this.launched.values()) if (a.rz) return true;
    return false;
  }

  applySettings() {
    const mv = !!this.getSettings().apps.moveWindows;
    if (!mv) this.bringBack(); // Move windows off: every moved window back here
    this._moveKey();
    if (!this.allowed) {
      for (const [id, a] of this.launched) if (!a.rz) this._forget(id);
      if (this.launched.size) this._poll();
      else this._sync([]);
    }
  }

  // The helper grabs a window with the move key and a click (Grab.swift); "" = off.
  _moveKey() {
    const a = this.getSettings().apps;
    this.helper.send('moveWin', { key: a.moveWindows ? a.moveKey || 'MetaRight' : '' });
  }

  // Move windows (movewin.js, loaded only when used): a grabbed window crossed with the pointer
  // goes over there; bringBack returns one or all of them.
  moveOut(wid, pid) {
    if (!this.getSettings().apps.moveWindows) return Promise.resolve(false);
    return require('./movewin.js').moveOut(this, Number(wid), Number(pid));
  }

  bringBack(wid, home = false) {
    if (this.moved.size) require('./movewin.js').bringBack(this, wid, home);
  }

  // ReZume: the windows of an app that is open here (its bundle id), streamed to the other Mac.
  async adopt(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9.-]{1,200}$/.test(id) || !this.server.current) return false;
    const had = this.launched.get(id);
    if (had) {
      if (had.skip) had.skip.clear();
      this._poll();
      return true;
    }
    const r = await this.helper.request('appLaunch', { appId: id }).catch(() => null); // it's running: its pid
    if (!r || !r.pid) return false;
    this.launched.set(id, { id, rz: true, skip: new Set(), pids: new Set([r.pid]), since: Date.now(), had: false, lastSeen: 0 });
    this._poll();
    return true;
  }

  // ReZume's window sharing turned off (app: only that app's windows).
  unadopt(app) {
    let any = false;
    for (const [id, a] of this.launched) if (a.rz && (!app || a.id === app)) { this._forget(id); any = true; }
    if (any && !this.launched.size) this._sync([]);
  }

  // A window ReZume sent, closed there: only its copy goes (the window stays open here).
  _unfollow(wid) {
    const w = this.windows.find((x) => x.wid === wid);
    const a = w && this.launched.get(w.id);
    if (!a || !a.rz) return false;
    a.skip.add(wid);
    this.helper.request('appFocus', { wid }).catch(() => {}); // back to the front here (it never left this screen)
    return true;
  }

  _mine(wid) {
    return typeof wid === 'number' && this.windows.some((w) => w.wid === wid);
  }

  _popup(wid) {
    return this.windows.some((w) => w.wid === wid && w.popup);
  }

  async _list() {
    if (!this.allowed) return this.server.sendToClient({ t: T.PAPPS_RESULT, apps: [] });
    const r = await this.helper.request('appsList').catch(() => ({ apps: [] }));
    this.server.sendToClient({ t: T.PAPPS_RESULT, apps: (r.apps || []).map((a) => ({ id: a.id, name: a.name, icon: a.icon || '' })) });
  }

  async _launch(id) {
    const reply = (ok, why) => this.server.sendToClient(why ? { t: T.PAPP_LAUNCHED, id, ok, why } : { t: T.PAPP_LAUNCHED, id, ok });
    if (!this.allowed) return reply(false, 'This Mac doesn’t let you open its apps (its Apps tab)');
    const open = this.windows.find((w) => w.id === id && !w.popup);
    if (open) {
      this.helper.request('appFocus', { wid: open.wid }).catch(() => {});
      return reply(true);
    }
    try {
      const r = await this.helper.request('appLaunch', { appId: id });
      const a = this.launched.get(id) || { id, pids: new Set(), since: Date.now(), had: false, lastSeen: 0 };
      if (r && r.pid) a.pids.add(r.pid);
      this.launched.set(id, a);
      reply(true);
      this._poll();
    } catch (e) {
      reply(false, e.message);
    }
  }

  _poll() {
    if (this.timer) return;
    const tick = async () => {
      this.timer = null;
      if ((!this.launched.size && !this.moved.size) || !this.server.current) return this._sync([]);
      const pids = [...this.launched.values()].flatMap((a) => [...a.pids]).concat([...this.moved.values()].map((m) => m.pid));
      const r = await this.helper.request('appWindows', { pids, popups: true }).catch(() => null);
      if (r && Array.isArray(r.windows)) this._match(r.windows);
      if (this.launched.size || this.moved.size) this.timer = setTimeout(tick, POLL_MS);
    };
    this.timer = setTimeout(tick, 0);
  }

  // The windows of the apps the viewer opened, then their pop-ups over the front one.
  _match(all) {
    const now = Date.now();
    const out = [];
    const pops = [];
    this.bounds.clear();
    if (this.moved.size) require('./movewin.js').list(this, all, out, pops); // moved windows (Move windows)
    for (const a of this.launched.values()) {
      const mine = all.filter((w) => a.pids.has(w.pid) && !(a.skip && a.skip.has(w.wid)));
      const main = mine.filter((w) => !w.popup);
      for (const w of main) out.push(this._entry(w, a.id));
      const popups = mine.filter((w) => w.popup).sort((x, y) => y.w * y.h - x.w * x.h).slice(0, MAX_POPUPS);
      for (const w of popups) {
        const owner = main.find((m) => w.x >= m.x && w.y >= m.y && w.x < m.x + m.w && w.y < m.y + m.h) || main[0];
        if (!owner) continue;
        const e = this._entry(w, a.id);
        pops.push({ ...e, popup: true, owner: owner.wid, x: Math.round((w.x - owner.x) * e.scale), y: Math.round((w.y - owner.y) * e.scale) });
      }
      if (main.length) {
        a.had = true;
        a.lastSeen = now;
      }
      if ((a.had && now - a.lastSeen > 3000) || (!a.had && now - a.since > 30000)) this._forget(a.id);
    }
    this._sync(out.concat(pops)); // owners before their pop-ups
  }

  // A moved window (movewin.js) waits past the right edge of all the screens: helper's appMove places a window 40 pt into these bounds,
  // so 1 pt of it stays on a screen (macOS wants some of every window there).
  _edge() {
    const all = screen.getAllDisplays();
    const right = Math.max(...all.map((d) => d.bounds.x + d.bounds.width));
    const top = screen.getPrimaryDisplay().bounds.y + 80;
    return { x: right - 41, y: top, width: 100000, height: 100000 };
  }

  // The virtual display is held only while a window is moved over (no screen sharing needed).
  _holdDisplay() {
    if (!this.displays || !this.displays.hold) return Promise.resolve();
    const want = this.moved.size > 0 && this.server.current != null;
    if (want !== !!this.holding) {
      this.holding = want;
      this.holdDone = this.displays.hold('apps', want).catch(() => {});
    }
    return this.holdDone;
  }

  _forget(id) {
    const a = this.launched.get(id);
    if (!a) return;
    this.launched.delete(id);
  }

  // One entry of papp.windows: sizes in physical px, `scale` = the display's backing scale.
  _entry(w, id) {
    const b = { x: w.x, y: w.y, width: w.w, height: w.h };
    this.bounds.set(w.wid, b);
    const d = screen.getDisplayMatching({ x: Math.round(w.x), y: Math.round(w.y), width: Math.max(1, Math.round(w.w)), height: Math.max(1, Math.round(w.h)) });
    const k = d.scaleFactor || 1;
    return {
      wid: w.wid, id, title: w.title || '', w: Math.round(w.w * k), h: Math.round(w.h * k), scale: k,
      maxW: Math.round(d.workArea.width * k), maxH: Math.round(d.workArea.height * k),
    };
  }

  async _sync(list) {
    this._holdDisplay();
    const key = JSON.stringify(list);
    const changed = key !== this.sentKey;
    if (changed && this.server.current) this.server.sendToClient({ t: T.PAPP_WINDOWS, windows: list });
    this.sentKey = key;
    this.windows = list;
    for (const wid of this.failed) if (!list.some((w) => w.wid === wid)) this.failed.delete(wid);
    const want = this.accepts && (this.allowed || this.rezumes || this.moved.size > 0) ? new Set(list.map((w) => w.wid)) : new Set();
    for (const [wid, session] of this.streams) {
      if (want.has(wid)) continue;
      this.streams.delete(wid);
      this._stop(session);
    }
    const start = [...want].filter((wid) => !this.streams.has(wid) && !this.failed.has(wid));
    if (start.length) {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
      for (const wid of start) {
        if (this.streams.has(wid) || !this.windows.some((w) => w.wid === wid)) continue;
        const src = sources.find((s) => s.id.startsWith(`window:${wid}:`));
        const fps = Math.min(120, Math.max(30, Math.round(screen.getPrimaryDisplay().displayFrequency || 60)));
        const session = ++this.counter;
        this.live.add(session);
        this.streams.set(wid, session);
        this._toWin({
          t: 'start', session, sourceId: src ? src.id : `window:${wid}:0`, width: MAX_W, height: MAX_H, follow: true,
          mbps: this.getSettings().bitrateMbps, fps, offer: { kind: 'window', wid },
          codec: ScreenCodec.mode((this.getSettings().sharing || {}).codec), // Share screen › Encoder
        });
      }
    }
    if (changed) this.emit('change');
  }

  _stop(session) {
    if (!this.live.delete(session)) return;
    this._toWin({ t: 'stop', session });
    if (this.server.current) this.server.sendToClient({ t: T.RTC2_STOP, session, win: 'send' });
    this._idle();
  }

  // No window streamed and no session: the hidden capture window goes after 30 s (made again for the next).
  _idle() {
    clearTimeout(this.dropTimer);
    if (!this.win) return;
    this.dropTimer = setTimeout(() => {
      if (this.live.size || this.server.current || !this.win) return;
      const w = this.win;
      this.win = null;
      this.ready = false;
      if (!w.isDestroyed()) w.destroy();
    }, 30000);
    if (this.dropTimer.unref) this.dropTimer.unref();
  }

  // The viewer's input in one of our windows: at that window (normalized 0–1 over its frame).
  // Clicks and keys bring it to the front first; a pop-up is never raised (that closes a menu).
  _input(m) {
    if (m.wid == null || !this.streams.has(m.wid)) return;
    const bounds = this.bounds.get(m.wid);
    if (!bounds) return;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    let ev;
    switch (m.t) {
      case T.IN_MOVE: ev = { t: m.t, x: num(m.x), y: num(m.y) }; break;
      case T.IN_DOWN: case T.IN_UP: ev = { t: m.t, x: num(m.x), y: num(m.y), b: Math.max(0, Math.min(4, num(m.b) | 0)) }; break;
      case T.IN_WHEEL: ev = { t: m.t, dx: num(m.dx), dy: num(m.dy) }; break;
      default:
        if (typeof m.code !== 'string' || m.code.length > 32) return;
        ev = { t: m.t, code: this.server.keySwap(this.getSettings()) ? P.mapKeyFromOtherPlatform(m.code) : m.code };
    }
    if ((m.t === T.IN_DOWN || m.t === T.IN_KEY_DOWN) && !this._popup(m.wid) && this.front !== m.wid) {
      this.front = m.wid;
      this.helper.request('appFocus', { wid: m.wid }).catch(() => {});
    }
    this.helper.send('input', { ev, bounds });
  }

  _fromWin(e) {
    return this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
  }

  _toWin(m) {
    if (!this.win || this.win.isDestroyed()) {
      if (m.t !== 'start') return;
      this._create();
    }
    if (this.ready) this.win.webContents.send('appsend', m);
    else this.queue.push(m);
  }

  _create() {
    clearTimeout(this.dropTimer);
    this.ready = false;
    this.queue = [];
    this.win = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(__dirname, 'preload-appsend.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    this.win.webContents.on('console-message', (e) => e.level === 'error' && console.log(`[appsend] ${e.message}`));
    this.win.loadFile(path.join(__dirname, 'appsend.html'));
    this.win.on('closed', () => {
      this.win = null;
      this.ready = false;
    });
  }

  shutdown() {
    for (const id of [...this.launched.keys()]) this._forget(id);
    this.bringBack(); // quitting: every moved window back here
    if (this.holding && this.displays) this.displays.hold('apps', false).catch(() => {});
    for (const session of this.streams.values()) this._stop(session);
    this.streams.clear();
  }

  get view() {
    return { accepts: this.accepts, open: this.windows.filter((w) => !w.popup).length, streaming: this.streams.size, moved: this.moved.size };
  }
}

module.exports = { AppSend };

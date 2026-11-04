// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Apps › PC apps on this Mac: list and open the PC's apps; each of
// their windows arrives as its own `rtc2` session (kind `window`, `wid`) and is shown in its own
// Mac window (low-latency viewer), sized like on the PC. Each PC app gets its own
// Dock icon (dockstub.js). Input carries `wid`; focus / close / resize go back to the PC window.
//
// Events: 'change' — this.view changed.
'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const I18n = require('../shared/i18n.js');
const { attachKeys } = require('./viewer-keys');
const { DockStub, addToDock } = require('./dockstub');

const T = P.T;
const POINTER = new Set([T.IN_MOVE, T.IN_DOWN, T.IN_UP, T.IN_WHEEL]);

class PcApps extends EventEmitter {
  constructor({ server, getSettings }) {
    super();
    Object.assign(this, { server, getSettings });
    this.apps = []; // [{id, name, icon}]
    this.listing = false;
    this.launch = {}; // id -> '' (opening) | 'ok' | why
    this.wins = new Map(); // wid -> {info, win, session, ready, queue, keys, closing, focusedAt}
    this.stubs = new Map(); // app id -> DockStub

    this.pendingLink = null; // {id, at}: a kept Dock icon was clicked before the PC was connected
    server.on('client', () => {
      this.rz = false;
      this.apps = [];
      this.launch = {};
      this._policy();
      if (this.cfg.on) this.list();
      const p = this.pendingLink;
      this.pendingLink = null;
      if (p && Date.now() - p.at < 120000) setTimeout(() => this.open(p.id), 500);
    });
    server.on('closed', () => {
      if (server.current) return;
      this._sync([]);
      this.emit('change');
    });
    server.on(`t:${T.PAPPS_RESULT}`, (m) => {
      this.listing = false;
      const str = (v, n) => String(v == null ? '' : v).slice(0, n);
      this.apps = (Array.isArray(m.apps) ? m.apps : []).filter((a) => a && a.id != null)
        .map((a) => ({ id: str(a.id, 1024), name: str(a.name, 200), icon: /^data:image\/png;base64,/.test(a.icon) ? a.icon : '' }));
      this.emit('change');
    });
    server.on(`t:${T.PAPP_LAUNCHED}`, (m) => {
      this.launch[String(m.id)] = m.ok ? 'ok' : String(m.why || 'didn’t start');
      this.emit('change');
    });
    server.on(`t:${T.PAPP_WINDOWS}`, (m) => this.accepting && Array.isArray(m.windows) && this._sync(m.windows));
    server.on(`t:${T.RTC2_OFFER}`, (m) => this._onOffer(m));
    // `win: 'view'` is another Mac's viewer talking to our own sender (appsend.js), not for us.
    server.on(`t:${T.RTC2_ICE}`, (m) => {
      if (m.win === 'view') return;
      const w = this._bySession(m.session);
      if (w) this._toWin(w, { ...m });
    });
    server.on(`t:${T.RTC2_STOP}`, (m) => {
      if (m.win === 'view') return;
      const w = this._bySession(m.session);
      if (!w) return;
      w.session = null;
      w.keys.release();
      this._toWin(w, { t: 'stop', why: '' });
    });

    const mine = (e) => [...this.wins.values()].find((w) => !w.win.isDestroyed() && w.win.webContents === e.sender);
    ipcMain.on('pcview:out', (e, m) => {
      const w = mine(e);
      if (!w || !m || !this.server.current) return;
      if ((m.t === T.RTC2_ANSWER || m.t === T.RTC2_ICE) && m.session === w.session) this.server.sendToClient({ ...m, win: 'view' });
      else if (POINTER.has(m.t) && (m.t === T.IN_UP || w.info.popup || w.win.isFocused())) this.server.sendToClient({ ...m, wid: w.info.wid });
    });
    ipcMain.on('pcview:state', () => {}); // stats of app windows aren't shown
    ipcMain.on('pcview:ready', (e) => {
      const w = mine(e);
      if (!w) return;
      w.ready = true;
      for (const m of w.queue.splice(0)) w.win.webContents.send('pcview', m);
    });
  }

  get cfg() {
    return this.getSettings().papps;
  }

  // Windows ReZume took from the other computer come too, with this tab's switch off (rezume.js take).
  acceptReZume(on) {
    if (this.rz === (on === true)) return;
    this.rz = on === true;
    if (this.server.current) this._policy();
    if (!this.accepting) this._sync([]);
  }

  get accepting() {
    return !!this.cfg.on || this.rz === true || !!this.getSettings().apps.moveWindows; // Move windows takes the windows moved here too
  }

  _policy() {
    this.server.sendToClient({ t: T.PAPP_POLICY, accept: this.accepting });
  }

  list() {
    if (!this.server.current) return;
    this.listing = true;
    this.server.sendToClient({ t: T.PAPPS_LIST });
    this.emit('change');
  }

  open(id) {
    if (!this.server.current || !this.cfg.on) return;
    const name = this._appName(String(id)) || { key: 'the app' };
    this.emit('popup', 'away', { key: 'Opening {app} on {name}…', vars: { app: name, name: this.server.current.name } });
    this.launch[String(id)] = '';
    this.server.sendToClient({ t: T.PAPP_LAUNCH, id: String(id) });
    this.emit('change');
  }

  _bySession(session) {
    return [...this.wins.values()].find((w) => w.session !== null && w.session === session);
  }

  // The PC's list of app windows: open new ones, retitle/resize, close the ones that went away.
  _sync(list) {
    const seen = new Set();
    for (const raw of list) {
      if (!raw || !Number.isFinite(Number(raw.wid))) continue;
      const info = {
        wid: Number(raw.wid), id: String(raw.id == null ? '' : raw.id), title: String(raw.title || '').slice(0, 300),
        w: Math.max(80, Number(raw.w) || 800), h: Math.max(60, Number(raw.h) || 600), scale: Math.min(4, Math.max(1, Number(raw.scale) || 1)),
        popup: raw.popup === true, owner: Number(raw.owner), x: Number(raw.x) || 0, y: Number(raw.y) || 0,
        // The PC screen's work area (physical px) — windows here never grow past it.
        maxW: Number(raw.maxW) > 0 ? Number(raw.maxW) : 0, maxH: Number(raw.maxH) > 0 ? Number(raw.maxH) : 0,
        moved: raw.moved === true, // dragged over from there (shared/movewin.js): it opens where the pointer came in
      };
      if (info.popup) {
        // A menu / drop-down: needs its owner's window here (listed before it).
        if (!this.wins.has(info.owner) || this.wins.get(info.owner).info.popup) continue;
        info.w = Math.max(8, Number(raw.w) || 8);
        info.h = Math.max(8, Number(raw.h) || 8);
      }
      seen.add(info.wid);
      const w = this.wins.get(info.wid);
      if (!w) this._create(info);
      else this._update(w, info);
    }
    for (const [wid, w] of this.wins) if (!seen.has(wid)) this._close(w);
    this._stubs();
    this.emit('change');
  }

  _appName(id) {
    const a = this.apps.find((x) => x.id === id);
    return a ? a.name : '';
  }

  // Pop-up bounds in Mac points: owner's content origin + offset / scale.
  _popupBounds(info) {
    const owner = this.wins.get(info.owner);
    const o = owner.win.getContentBounds();
    return {
      x: Math.round(o.x + info.x / info.scale), y: Math.round(o.y + info.y / info.scale),
      width: Math.round(info.w / info.scale), height: Math.round(info.h / info.scale),
    };
  }

  // A pop-up: borderless, shadowed, non-activating panel above its
  // owner — keys stay with the owner; mouse in it goes to the pop-up's wid.
  _createPopup(info) {
    const owner = this.wins.get(info.owner);
    const win = new BrowserWindow({
      ...this._popupBounds(info),
      parent: owner.win, // moves with its owner, stays above it
      type: 'panel',
      frame: false,
      hasShadow: true,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#000000',
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload-pcview.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const w = { info, win, session: null, ready: false, queue: [], closing: true, focusedAt: 0, sizedAt: 0, keys: { release() {} } };
    win.webContents.on('console-message', (e) => e.level === 'error' && console.log(`[pcapps] ${e.message}`));
    win.once('ready-to-show', () => !win.isDestroyed() && win.showInactive());
    win.on('closed', () => {
      if (this.wins.get(w.info.wid) === w) this.wins.delete(w.info.wid);
      this.emit('change');
    });
    this.wins.set(info.wid, w);
    win.loadFile(path.join(__dirname, 'pcview.html'), { query: { language: this._i18n().locale, ...this._playerTitle(info) } });
  }

  _create(info) {
    if (info.popup) return this._createPopup(info);
    // A moved window comes in with the pointer: on that screen, its title bar under the pointer.
    const at = info.moved ? screen.getCursorScreenPoint() : null;
    const wa = (at ? screen.getDisplayNearestPoint(at) : screen.getPrimaryDisplay()).workArea;
    const width = Math.min(Math.round(info.w / info.scale), wa.width);
    const height = Math.min(Math.round(info.h / info.scale), wa.height);
    const where = at ? {
      x: Math.round(Math.min(Math.max(at.x - width / 2, wa.x), wa.x + wa.width - width)),
      y: Math.round(Math.min(Math.max(at.y - 16, wa.y), wa.y + wa.height - height)),
    } : {};
    const win = new BrowserWindow({
      title: this._title(info),
      width,
      height,
      ...where,
      useContentSize: true,
      backgroundColor: '#000000',
      fullscreenable: false, // full screen stretched the picture; zoom resizes the PC window instead
      webPreferences: {
        preload: path.join(__dirname, 'preload-pcview.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const w = { info, win, session: null, ready: false, queue: [], closing: false, focusedAt: Date.now(), sizedAt: 0 };
    if (info.moved && this.driven) this._toWin(w, { t: 'cursor', own: true });
    win.on('page-title-updated', (e) => {
      e.preventDefault();
      win.setTitle(this._title(w.info));
    });
    this._limit(w);
    w.keys = attachKeys(win, {
      send: (m) => this.server.current && this.server.sendToClient({ ...m, wid: w.info.wid }),
      enabled: () => !!(w.session !== null && this.server.current),
    });
    win.webContents.on('console-message', (e) => e.level === 'error' && console.log(`[pcapps] ${e.message}`));
    win.on('focus', () => {
      w.focusedAt = Date.now();
      if (this.server.current) this.server.sendToClient({ t: T.PAPP_FOCUS, wid: w.info.wid });
    });
    win.on('blur', () => {
      w.keys.release();
      this._toWin(w, { t: 'blur' });
    });
    // The person resized it here: resize the PC window to match (the capture follows).
    win.on('resized', () => {
      const [cw, ch] = win.getContentSize();
      w.sizedAt = Date.now();
      if (this.server.current) this.server.sendToClient({ t: T.PAPP_SIZE, wid: w.info.wid, w: Math.round(cw * w.info.scale), h: Math.round(ch * w.info.scale) });
    });
    // The red button closes the PC window; this one goes when the PC's list drops it.
    win.on('close', (e) => {
      if (w.closing) return;
      e.preventDefault();
      if (this.server.current) this.server.sendToClient({ t: T.PAPP_CLOSE, wid: w.info.wid });
    });
    win.on('closed', () => {
      w.keys.release();
      if (this.wins.get(w.info.wid) === w) this.wins.delete(w.info.wid);
      this._stubs();
      this.emit('change');
    });
    this.wins.set(info.wid, w);
    win.loadFile(path.join(__dirname, 'pcview.html'), { query: { language: this._i18n().locale, ...this._playerTitle(info) } });
  }

  // Never bigger than the PC's screen (1:1 pixels, nothing upscaled) nor this Mac's work area.
  _limit(w) {
    const wa = screen.getDisplayMatching(w.win.getBounds()).workArea;
    const s = w.info.scale;
    const mw = Math.min(wa.width, w.info.maxW ? Math.floor(w.info.maxW / s) : wa.width);
    const mh = Math.min(wa.height, w.info.maxH ? Math.floor(w.info.maxH / s) : wa.height);
    const bar = w.win.getSize()[1] - w.win.getContentSize()[1]; // title bar: the limit is for the content
    w.win.setMaximumSize(Math.max(200, mw), Math.max(150, mh + bar));
  }

  _i18n() {
    const settings = this.getSettings();
    return I18n.create(I18n.resolveLanguage(settings.ui && settings.ui.language, app.getLocale()));
  }

  _title(info) {
    // Moved here from the other computer: its name says so (it goes back when closed or dragged back).
    if (info.moved) return this._i18n().t('{title} (from {name})', { title: info.title || this._i18n().t('PC app'), name: (this.server.current && this.server.current.name) || this._i18n().t('the PC') });
    const app = this._appName(info.id);
    return info.title && app && !info.title.includes(app) ? `${info.title} · ${app}` : info.title || app || this._i18n().t('PC app');
  }

  _playerTitle(info) {
    return { title: this._title(info), titleKey: info.title || this._appName(info.id) ? '' : 'PC app' };
  }

  _update(w, info) {
    const old = w.info;
    w.info = info;
    if (w.win.isDestroyed()) return;
    if (info.popup) {
      if (this.wins.has(info.owner)) w.win.setBounds(this._popupBounds(info));
      return;
    }
    w.win.setTitle(this._title(info));
    this._toWin(w, { t: 'title', ...this._playerTitle(info) });
    if (old.maxW !== info.maxW || old.maxH !== info.maxH || old.scale !== info.scale) this._limit(w);
    // Resized on the PC (not by us a moment ago): follow it.
    if ((old.w !== info.w || old.h !== info.h) && Date.now() - w.sizedAt > 1500) {
      w.win.setContentSize(Math.round(info.w / info.scale), Math.round(info.h / info.scale));
    }
  }

  _close(w) {
    w.keys.release();
    w.closing = true;
    this.wins.delete(w.info.wid);
    if (!w.win.isDestroyed()) w.win.close();
  }

  _onOffer(m) {
    if (m.kind !== 'window' || m.win === 'view' || typeof m.sdp !== 'string' || !this.accepting) return;
    const w = this.wins.get(Number(m.wid));
    if (!w || w.win.isDestroyed()) return; // not listed (yet): the PC lists before it offers
    w.session = m.session;
    this._toWin(w, { t: 'offer', session: m.session, sdp: m.sdp, audio: false, volume: 0, input: true });
  }

  _toWin(w, m) {
    if (w.win.isDestroyed()) return;
    if (w.ready) w.win.webContents.send('pcview', m);
    else w.queue.push(m);
  }

  // One Dock icon per PC app that has windows here.
  _stubs() {
    const byApp = new Map();
    for (const w of this.wins.values()) {
      if (w.info.popup) continue;
      if (!byApp.has(w.info.id)) byApp.set(w.info.id, []);
      byApp.get(w.info.id).push(w);
    }
    for (const [id, stub] of this.stubs) {
      if (!byApp.has(id)) {
        stub.stop();
        this.stubs.delete(id);
      }
    }
    for (const [id, ws] of byApp) {
      let stub = this.stubs.get(id);
      if (!stub) {
        const a = this.apps.find((x) => x.id === id) || { id, name: this._appName(id) || ws[0].info.title, icon: '' };
        stub = new DockStub(a, (ev, i) => this._onStub(id, ev, i));
        this.stubs.set(id, stub);
      }
      stub.menu(ws.map((w) => w.info.title));
    }
  }

  _onStub(id, ev, i) {
    const ws = [...this.wins.values()].filter((w) => w.info.id === id && !w.info.popup && !w.win.isDestroyed());
    if (ev === 'quit') {
      for (const w of ws) if (this.server.current) this.server.sendToClient({ t: T.PAPP_CLOSE, wid: w.info.wid });
      return;
    }
    const pick = ev === 'focus' ? ws[i] : ws.sort((a, b) => b.focusedAt - a.focusedAt)[0];
    if (ev === 'activate') for (const w of ws) w.win.showInactive();
    if (pick) {
      app.focus({ steal: true }); // TwinDesk has no Dock icon of its own
      pick.win.show();
      pick.win.focus();
    }
  }

  // macshare://pc-app/<id> (a kept Dock icon, Launchpad, Spotlight): open it now or once connected.
  openFromLink(id) {
    if (this.server.current && this.cfg.on) return this.open(id);
    this.pendingLink = { id, at: Date.now() };
    this.emit('popup', 'driven', { key: 'Opening it when the other computer connects…' });
  }

  // Apps tab: put a PC app in the Dock (and in ~/Applications/MacShare Apps for Launchpad).
  async keepInDock(id) {
    const a = this.apps.find((x) => x.id === id);
    if (!a) return;
    const ok = await addToDock(a);
    this.emit('popup', ok ? 'home' : 'driven', { key: ok ? '{app} is in the Dock' : 'Couldn’t add {app} to the Dock', vars: { app: a.name } });
  }

  // The PC drives this Mac (kvm.js mode): its pointer is hidden there, so a moved window's copy
  // (whose picture has no pointer then) shows this Mac's own over it.
  setDriven(on) {
    on = !!on;
    if (on === !!this.driven) return;
    this.driven = on;
    for (const w of this.wins.values()) if (w.info.moved && !w.info.popup) this._toWin(w, { t: 'cursor', own: on });
  }

  // Is one of the PC app windows focused? (kvm.js doesn't cross the edge while it is.)
  get focused() {
    return [...this.wins.values()].some((w) => !w.win.isDestroyed() && w.win.isFocused());
  }

  // A window grabbed with the move key crossed back (kvm.js, the helper's `moving` CGWindowID): if
  // it's the copy of a window moved here, that window goes home (shared/movewin.js).
  returnWindow(cgId) {
    if (!cgId) return false;
    for (const w of this.wins.values()) {
      if (!w.info.moved || w.win.isDestroyed()) continue;
      const m = /^window:(\d+):/.exec(w.win.getMediaSourceId() || '');
      if (!m || Number(m[1]) !== cgId) continue;
      this.server.sendToClient({ t: T.PAPP_RETURN, wid: w.info.wid });
      return true;
    }
    return false;
  }

  applySettings() {
    this._policy();
    if (!this.accepting) this._sync([]);
    else if (!this.apps.length) this.list();
    this.emit('change');
  }

  shutdown() {
    for (const w of [...this.wins.values()]) this._close(w);
    for (const s of this.stubs.values()) s.stop();
    this.stubs.clear();
  }

  get view() {
    return {
      apps: this.apps,
      listing: this.listing,
      launch: this.launch,
      windows: [...this.wins.values()].filter((w) => !w.info.popup).map((w) => ({ wid: w.info.wid, id: w.info.id, title: w.info.title, live: w.session !== null })),
    };
  }
}

module.exports = { PcApps };

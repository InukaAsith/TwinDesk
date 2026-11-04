// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Apps from a PC or another Linux computer here (copy of
// windows/peerapps.js): list and open its apps (papps.list / papp.launch); each of their windows
// arrives as its own `rtc2` session (kind 'window') and is shown in its own window here
// (appview.html), sized like over there, with the app's icon. Input carries `wid`; focus / close /
// resize go back to its window. The other direction (this computer's apps there) is pcapps.js.
// Not with a Mac: it sends its own apps (apps.js).
const path = require('path');
const { app, BrowserWindow, ipcMain, nativeImage, screen: displays } = require('electron');
const P = require('../shared/protocol.js');
const I18n = require('../shared/i18n.js');

const T = P.T;
const POINTER = new Set([T.IN_MOVE, T.IN_DOWN, T.IN_UP, T.IN_WHEEL]);

class PeerApps {
  // opts: link (peer.js), settings (shared; macApps.on = "Open <peer>'s apps here"), popup(kind, text), peerName(), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.list = [];  // [{id, name, icon}]
    this.loading = false;
    this.message = '';
    this.wins = new Map(); // wid → {info, win, session, ready, queue, keys, closing, sizedAt}

    const link = this.link;
    link.on('welcome', () => {
      this.rz = false;
      this.list = [];
      this.message = '';
      this._policy();
    });
    link.on('closed', () => {
      this.loading = false;
      this._sync([]);
    });
    link.on(T.PAPPS_RESULT, (m) => {
      if (!this.appsHere) return;
      this.loading = false;
      const str = (v, n) => String(v == null ? '' : v).slice(0, n);
      this.list = (Array.isArray(m.apps) ? m.apps : []).filter((a) => a && a.id != null)
        .map((a) => ({ id: str(a.id, 1024), name: str(a.name, 200), icon: /^data:image\/png;base64,/.test(a.icon) ? a.icon : '' }));
      this.onChange();
    });
    link.on(T.PAPP_LAUNCHED, (m) => {
      if (!this.appsHere || m.ok) return;
      const a = this.list.find((x) => x.id === String(m.id));
      this.message = 'Couldn’t open ' + (a ? a.name : 'the app') + (m.why ? ': ' + m.why : '');
      this.onChange();
    });
    link.on(T.PAPP_WINDOWS, (m) => this.active && this.accepting && Array.isArray(m.windows) && this._sync(this.fromMac ? movedOnly(m.windows) : m.windows));
    link.on(T.RTC2_OFFER, (m) => this._onOffer(m));
    link.on(T.RTC2_ICE, (m) => {
      if (m.win !== 'send') return; // our own sender's sessions (sender.js)
      const w = this._bySession(m.session);
      if (w) this._toWin(w, { ...m });
    });
    link.on(T.RTC2_STOP, (m) => {
      if (m.win !== 'send') return;
      const w = this._bySession(m.session);
      if (!w) return;
      w.session = null;
      w.keys.release();
      this._toWin(w, { t: 'stop', why: '' });
    });

    const mine = (e) => [...this.wins.values()].find((w) => !w.win.isDestroyed() && w.win.webContents === e.sender);
    ipcMain.on('appview:out', (e, m) => {
      const w = mine(e);
      if (!w || !m || !this.active) return;
      if ((m.t === T.RTC2_ANSWER || m.t === T.RTC2_ICE) && m.session === w.session) this.link.send({ ...m, win: 'view' });
      else if (POINTER.has(m.t) && (m.t === T.IN_UP || w.info.popup || w.win.isFocused())) this.link.send({ ...m, wid: w.info.wid });
    });
    ipcMain.on('appview:ready', (e) => {
      const w = mine(e);
      if (!w) return;
      w.ready = true;
      for (const m of w.queue.splice(0)) w.win.webContents.send('appview', m);
    });
  }

  get cfg() {
    return this.settings.macApps;
  }

  // A PC or a Linux computer on the other end (the Mac does with apps.js instead).
  // Any computer on the other end: its windows come here. A Mac's apps don't (it opens them with
  // apps.js, as always): from a Mac only the windows moved here with Move windows.
  get active() {
    return this.link.status.state === 'connected';
  }

  get fromMac() {
    return this.link.peerOs === P.OS.MAC;
  }

  // Its apps listed and opened here: a PC or a Linux computer only.
  get appsHere() {
    return this.active && !this.fromMac;
  }

  // Windows ReZume took from the other computer come too, with this tab's switch off (rezume.js take).
  acceptReZume(on) {
    if (this.rz === (on === true)) return;
    this.rz = on === true;
    this._policy();
    if (!this.accepting) this._sync([]);
  }

  get accepting() {
    const moves = !!(this.settings.pcApps && this.settings.pcApps.moveWindows); // Move windows takes the windows moved here too
    if (this.fromMac) return moves; // a Mac's apps and ReZume windows come through apps.js
    return !!this.cfg.on || this.rz === true || moves;
  }

  _policy() {
    if (this.active) this.link.send({ t: T.PAPP_POLICY, accept: this.accepting });
  }

  // Apps tab switch changed.
  apply() {
    this._policy();
    if (!this.accepting) this._sync([]);
    else if (!this.list.length) this.refresh();
    this.onChange();
  }

  refresh() {
    if (!this.appsHere || !this.cfg.on) return;
    if (this.link.send({ t: T.PAPPS_LIST })) { this.loading = true; this.onChange(); }
  }

  launch(id) {
    if (!this.appsHere || !this.cfg.on || typeof id !== 'string') return;
    const a = this.list.find((x) => x.id === id);
    this.message = '';
    this.popup('away', { key: 'Opening {app} on {name}…', vars: { app: a ? a.name : { key: 'the app' }, name: this.peerName() } });
    this.link.send({ t: T.PAPP_LAUNCH, id });
    this.onChange();
  }

  _bySession(session) {
    return [...this.wins.values()].find((w) => w.session !== null && w.session === session);
  }

  // The other PC's list of app windows: open new ones, retitle/resize, close the ones that went.
  _sync(list) {
    const seen = new Set();
    for (const raw of list) {
      if (!raw || !Number.isFinite(Number(raw.wid))) continue;
      const info = {
        wid: Number(raw.wid), id: String(raw.id == null ? '' : raw.id), title: String(raw.title || '').slice(0, 300),
        w: Math.max(80, Number(raw.w) || 800), h: Math.max(60, Number(raw.h) || 600), scale: Math.min(4, Math.max(1, Number(raw.scale) || 1)),
        popup: raw.popup === true, owner: Number(raw.owner), x: Number(raw.x) || 0, y: Number(raw.y) || 0,
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
    this.onChange();
  }

  // A window grabbed with the move key crossed back (kvm.js, the helper's `moving`): if it's the
  // copy of a window moved here, that window goes home (shared/movewin.js); the pointer goes there too.
  returnWindow(xid) {
    if (!this.active || !xid) return false;
    for (const w of this.wins.values()) {
      if (!w.info.moved || w.win.isDestroyed()) continue;
      const h = w.win.getNativeWindowHandle();
      const id = h.length >= 8 ? Number(h.readBigUInt64LE(0)) : h.readUInt32LE(0);
      if (id !== xid) continue;
      this.link.send({ t: T.PAPP_RETURN, wid: w.info.wid });
      return true;
    }
    return false;
  }

  _app(id) {
    return this.list.find((x) => x.id === id) || null;
  }

  _i18n() {
    return I18n.create(I18n.resolveLanguage(this.settings.ui && this.settings.ui.language, app.getLocale()));
  }

  _title(info) {
    // Moved here from the other computer: its name says so (it goes back when closed or dragged back).
    if (info.moved) return this._i18n().t('{title} (from {name})', { title: info.title || this._i18n().t('App'), name: this.peerName() });
    const a = this._app(info.id);
    const name = a ? a.name : '';
    return info.title && name && !info.title.includes(name) ? info.title + ' · ' + name : info.title || name || this._i18n().t('App');
  }

  _playerTitle(info) {
    const a = this._app(info.id);
    return { title: this._title(info), titleKey: info.title || (a && a.name) ? '' : 'App' };
  }

  _webPrefs() {
    return { preload: path.join(__dirname, 'preload-appview.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false };
  }

  // Pop-up bounds here: owner's content origin + offset / scale (DIPs, same size as over there).
  _popupBounds(info) {
    const o = this.wins.get(info.owner).win.getContentBounds();
    return {
      x: Math.round(o.x + info.x / info.scale), y: Math.round(o.y + info.y / info.scale),
      width: Math.round(info.w / info.scale), height: Math.round(info.h / info.scale),
    };
  }

  // A menu or drop-down: borderless, never focused (keys stay with its owner), above its owner.
  _createPopup(info) {
    const owner = this.wins.get(info.owner);
    const win = new BrowserWindow({
      ...this._popupBounds(info), parent: owner.win, frame: false, roundedCorners: false, focusable: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, show: false, hasShadow: true,
      backgroundColor: '#000000', webPreferences: this._webPrefs(),
    });
    const w = { info, win, session: null, ready: false, queue: [], closing: true, sizedAt: 0, keys: { release() {} } };
    win.once('ready-to-show', () => !win.isDestroyed() && win.showInactive());
    win.on('closed', () => { if (this.wins.get(w.info.wid) === w) this.wins.delete(w.info.wid); });
    this.wins.set(info.wid, w);
    win.loadFile(path.join(__dirname, 'appview.html'), { query: { language: this._i18n().locale, ...this._playerTitle(info) } });
  }

  _create(info) {
    if (info.popup) return this._createPopup(info);
    // A moved window comes in with the pointer: on that screen, its title bar under the pointer.
    const at = info.moved ? displays.getCursorScreenPoint() : null;
    const wa = (at ? displays.getDisplayNearestPoint(at) : displays.getPrimaryDisplay()).workArea;
    const width = Math.min(Math.round(info.w / info.scale), wa.width);
    const height = Math.min(Math.round(info.h / info.scale), wa.height - 40);
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
      fullscreenable: false, // full screen stretched the picture; maximize resizes it over there
      autoHideMenuBar: true,
      webPreferences: this._webPrefs(),
    });
    win.setMenu(null);
    const w = { info, win, session: null, ready: false, queue: [], closing: false, sizedAt: 0 };
    this._dress(w);
    this._limit(w);
    w.keys = attachKeys(win, {
      send: (m) => this.active && this.link.send({ ...m, wid: w.info.wid }),
      enabled: () => w.session !== null && this.active,
    });
    win.on('page-title-updated', (e) => {
      e.preventDefault();
      win.setTitle(this._title(w.info));
    });
    win.on('focus', () => this.active && this.link.send({ t: T.PAPP_FOCUS, wid: w.info.wid }));
    win.on('blur', () => {
      w.keys.release();
      this._toWin(w, { t: 'blur' });
    });
    // Resized here: resize the window over there to match (its capture follows). Electron has no
    // 'resized' on Linux: 'resize', once it has been still for a moment; a size the window already
    // has over there (our own setContentSize below) isn't sent back.
    win.on('resize', () => {
      clearTimeout(w.sizeTimer);
      w.sizeTimer = setTimeout(() => {
        if (win.isDestroyed()) return;
        const [cw, ch] = win.getContentSize();
        const pw = Math.round(cw * w.info.scale), ph = Math.round(ch * w.info.scale);
        if (Math.abs(pw - w.info.w) <= 2 && Math.abs(ph - w.info.h) <= 2) return;
        w.sizedAt = Date.now();
        if (this.active) this.link.send({ t: T.PAPP_SIZE, wid: w.info.wid, w: pw, h: ph });
      }, 300);
    });
    // The close button closes the window over there; this one goes when its list drops it.
    win.on('close', (e) => {
      if (w.closing || !this.active) return;
      e.preventDefault();
      this.link.send({ t: T.PAPP_CLOSE, wid: w.info.wid });
    });
    win.on('closed', () => {
      clearTimeout(w.sizeTimer);
      w.keys.release();
      if (this.wins.get(w.info.wid) === w) this.wins.delete(w.info.wid);
      this.onChange();
    });
    this.wins.set(info.wid, w);
    win.loadFile(path.join(__dirname, 'appview.html'), { query: { language: this._i18n().locale, ...this._playerTitle(info) } });
  }

  // The app's icon on its window (the window list / dock shows it).
  _dress(w) {
    const a = this._app(w.info.id);
    const img = a && a.icon ? nativeImage.createFromDataURL(a.icon) : null;
    if (img && !img.isEmpty()) w.win.setIcon(img);
  }

  // Never bigger than the other PC's work area (1:1 pixels, nothing upscaled) nor this monitor's.
  _limit(w) {
    const wa = displays.getDisplayMatching(w.win.getBounds()).workArea;
    const s = w.info.scale;
    const mw = Math.min(wa.width, w.info.maxW ? Math.floor(w.info.maxW / s) : wa.width);
    const mh = Math.min(wa.height, w.info.maxH ? Math.floor(w.info.maxH / s) : wa.height);
    const [ow, oh] = w.win.getSize(), [cw, ch] = w.win.getContentSize();
    w.win.setMaximumSize(Math.max(200, mw + ow - cw), Math.max(150, mh + oh - ch));
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
    if (old.id !== info.id) this._dress(w);
    if (old.maxW !== info.maxW || old.maxH !== info.maxH || old.scale !== info.scale) this._limit(w);
    // Resized over there (not by us a moment ago): follow it.
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
    if (m.kind !== 'window' || typeof m.sdp !== 'string' || !this.accepting || !this.active) return;
    const w = this.wins.get(Number(m.wid));
    if (!w || w.win.isDestroyed()) return; // not listed yet: the sender lists before it offers
    w.session = m.session;
    this._toWin(w, { t: 'offer', session: m.session, sdp: m.sdp, pacing: this.settings.monitor.pacing || 'fast' });
  }

  _toWin(w, m) {
    if (w.win.isDestroyed()) return;
    if (w.ready) w.win.webContents.send('appview', m);
    else w.queue.push(m);
  }

  shutdown() {
    for (const w of [...this.wins.values()]) this._close(w);
  }

  view() {
    const open = [...this.wins.values()].filter((w) => !w.info.popup).length;
    return { list: this.list, loading: this.loading, message: this.message, open, peerPc: true };
  }
}

// Keys from an app window, taken in main (before-input-event): no renderer hop, and Alt+F4,
// Ctrl+W, F5… go to the app over there instead of acting on this window.
function attachKeys(win, { send, enabled }) {
  const held = new Set();
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' && input.type !== 'keyUp') return;
    e.preventDefault();
    if (!input.code || !enabled()) return;
    if (input.type === 'keyDown') {
      held.add(input.code);
      send({ t: T.IN_KEY_DOWN, code: input.code });
    } else {
      held.delete(input.code);
      send({ t: T.IN_KEY_UP, code: input.code });
    }
  });
  return { release: () => { for (const c of [...held]) { held.delete(c); send({ t: T.IN_KEY_UP, code: c }); } } };
}

// A Mac's papp.windows: only the windows moved here (Move windows) and their pop-ups.
function movedOnly(list) {
  const moved = new Set(list.filter((w) => w && w.moved === true && !w.popup).map((w) => Number(w.wid)));
  return list.filter((w) => w && (moved.has(Number(w.wid)) || (w.popup && moved.has(Number(w.owner)))));
}

module.exports = PeerApps;

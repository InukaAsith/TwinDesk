// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone in windows on the Mac: its screen (mirror, with its sound), and phone apps each in a
// window of their own on a virtual display of the window's size (scrcpy new_display + flex, so
// resizing the window resizes the app). One scrcpy session per window (scrcpy.js); the window
// decodes the H.264 itself (phoneview-renderer.js) and sends touches, keys and scrolls back.
// A phone app with windows here has a Dock icon of its own (dockstub.js, like a PC app), and pin()
// keeps it in the Dock: opened from there, it asks TwinDesk for macshare://pc-app/phone:<package>.
//
// A phone notification clicked on the Mac opens its app here (openNotified): the phone wakes and
// asks for its unlock first if it's locked (Wake.kt), as the app's window would show the lock screen.
//
// Events: 'change' — the window list changed.
'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { Session, ACTION, TYPE } = require('./scrcpy');
const { KeyState, ANDROID } = require('./android-keys');
const { DockStub, addToDock } = require('./dockstub');

const T = P.T;
const NOTIFIED_MS = 60000; // how long a clicked notification waits for the unlock and wireless debugging
let nextId = 1;

class PhoneViews extends EventEmitter {
  constructor({ bridge, phone, getSettings, server, fileSend }) {
    super();
    Object.assign(this, { bridge, phone, getSettings, server, fileSend });
    this.views = new Map(); // id -> {id, kind, app, title, win, session, keys, size}
    this.stubs = new Map(); // package -> DockStub, while that app has a window here
    bridge.views = this;
    this.on('change', () => bridge._tellPhone());
    this.notified = null; // {pkg, name, at, unlocked}: a clicked notification's app, waiting to open
    server.on(`t:${T.PHONE_AWAKE}`, (m) => this._awake(m));
    bridge.on('change', () => this._openNotified());
    server.on('closed', () => { this.notified = null; });
    ipcMain.on('phoneview:in', (e, m) => {
      const v = [...this.views.values()].find((x) => x.win && !x.win.isDestroyed() && x.win.webContents === e.sender);
      if (v && m && typeof m === 'object') this._input(v, m);
    });
    // Files dropped on a phone window go to the phone (its Downloads).
    ipcMain.on('phoneview:drop', (e, paths) => {
      if (!Array.isArray(paths) || !paths.length || !this.server.current) return;
      const b = this.fileSend.sendBatch(paths.filter((p) => typeof p === 'string' && p.startsWith('/')).slice(0, 1000), 'send');
      if (b) this.bridge.emit('popup', 'away', `Sending ${b.name} to ${this.server.current.name}`);
    });
  }

  // The phone's sound on its own (no screen window): an audio-only session in a hidden window.
  sound(on) {
    const open = [...this.views.values()].find((v) => v.kind === 'sound');
    if (on && !open && this.bridge.serial) {
      this._open({ kind: 'sound', title: 'Phone sound', width: 200, height: 100, hidden: true, opts: { video: false, audio: true, control: false, audioSource: 'output' } });
    } else if (!on && open) this.close(open.id);
  }

  // The phone's sound captured by the phone itself (no wireless debugging, phone-bridge.js): a
  // hidden window with no adb session, fed what comes through the session.
  netSound(on) {
    const open = [...this.views.values()].find((v) => v.kind === 'netsound');
    if (on && !open) this._open({ kind: 'netsound', title: 'Phone sound', width: 200, height: 100, hidden: true });
    else if (!on && open) this.close(open.id);
  }

  netAudio(m) {
    const v = [...this.views.values()].find((x) => x.kind === 'netsound');
    if (v) this._send(v, 'phoneview:netaudio', { codec: m.codec === 'pcm' ? 'pcm' : 'opus', p: Array.isArray(m.p) ? m.p.filter((x) => typeof x === 'string').slice(0, 10) : [] });
  }

  list() {
    return [...this.views.values()].filter((v) => v.kind !== 'sound' && v.kind !== 'netsound').map((v) => ({ id: v.id, kind: v.kind, app: v.app || null, title: v.title }));
  }

  get focused() {
    return [...this.views.values()].some((v) => v.win && !v.win.isDestroyed() && v.win.isFocused());
  }

  openScreen() {
    const open = [...this.views.values()].find((v) => v.kind === 'screen');
    if (open) return open.win.show(), open.win.focus();
    const info = this.phone.info || {};
    const d = info.display || { w: 1080, h: 2400 };
    const work = screen.getPrimaryDisplay().workAreaSize;
    const h = Math.min(860, work.height - 80);
    const w = Math.round(h * Math.min(d.w, d.h) / Math.max(d.w, d.h));
    const name = (this.server.current && this.server.current.name) || 'Phone';
    this._open({ kind: 'screen', title: name, width: w, height: h, opts: this.bridge.sessionOpts('screen') });
  }

  // Opens the phone camera as a high-definition webcam feed using scrcpy camera mode.
  openCamera(opts = {}) {
    const open = [...this.views.values()].find((v) => v.kind === 'camera');
    if (open) return open.win.show(), open.win.focus();
    const name = ((this.server.current && this.server.current.name) || 'Phone') + ' Camera';
    const cameraOpts = {
      videoSource: 'camera',
      cameraFacing: opts.facing || 'back',
      cameraSize: opts.size || '1920x1080',
      cameraFps: opts.fps || 30,
      control: true,
      stayAwake: true,
      ...opts,
    };
    const w = 960;
    const h = 540;
    this._open({
      kind: 'camera',
      title: name,
      width: w,
      height: h,
      opts: this.bridge.sessionOpts('camera', cameraOpts),
    });
  }

  openApp(pkg, name) {
    const open = [...this.views.values()].find((v) => v.kind === 'app' && v.app === pkg);
    if (open) return open.win.show(), open.win.focus();
    const w = 412;
    const h = 860;
    // At least 2 pixels per point (sharp at 100% scaling); the dpi keeps 1 dp = 1 point, so the
    // app's text is as big as this computer's. The window's resizes use the same rule.
    const scale = Math.max(2, screen.getPrimaryDisplay().scaleFactor || 1);
    const newDisplay = `${Math.round(w * scale)}x${Math.round((h - 32) * scale)}/${Math.round(160 * scale)}`;
    this._open({ kind: 'app', app: pkg, title: name || pkg, width: w, height: h, opts: this.bridge.sessionOpts('app', { newDisplay }) });
  }

  // A notification from the phone was clicked: wake it (unlocked: it answers at once), then open
  // the app once the phone is unlocked and wireless debugging is back (MIUI drops it while locked).
  openNotified(pkg, name) {
    if (!pkg || !this.server.current) return;
    const n = { pkg, name, at: Date.now(), unlocked: false, answered: false };
    this.notified = n;
    this.server.sendToClient({ t: T.PHONE_WAKE });
    // An older app doesn't answer: open it anyway.
    setTimeout(() => {
      if (this.notified !== n || n.answered) return;
      n.unlocked = true;
      this._openNotified();
    }, 2000);
  }

  _awake(m) {
    const n = this.notified;
    if (!n) return;
    n.answered = true;
    if (!m.unlocked) {
      const phone = (this.server.current && this.server.current.name) || 'the phone';
      return void (m.waiting && this.bridge.emit('popup', 'away', `Unlock ${phone} to open ${n.name || 'the app'}`));
    }
    n.unlocked = true;
    this._openNotified();
  }

  _openNotified() {
    const n = this.notified;
    if (!n || !n.unlocked) return;
    if (Date.now() - n.at > NOTIFIED_MS) return void (this.notified = null);
    const ble = this.server.current && this.server.current.transport === 'ble'; // Wi-Fi first: onNoAdb
    if ((this.bridge.state !== 'ready' || !this.bridge.serial) && !(ble && this.onNoAdb)) return;
    this.notified = null;
    this.openApp(n.pkg, this._info(n.pkg, n.name).name);
  }

  close(id) {
    const v = this.views.get(id);
    if (v && v.win && !v.win.isDestroyed()) v.win.close();
  }

  closeAll() {
    for (const v of [...this.views.values()]) this.close(v.id);
  }

  get screenWithSound() {
    return [...this.views.values()].some((v) => v.kind === 'screen' && v.session && v.session.opts.audio);
  }

  _open({ kind, app, title, width, height, opts, hidden = false }) {
    if (!this.bridge.serial && kind !== 'netsound') {
      // Through Bluetooth: the phone's hotspot first (main.js), then this window.
      if (this.onNoAdb && this.onNoAdb({ kind, app, title, width, height, opts, hidden })) return;
      return this.bridge.emit('popup', 'home', 'Set up wireless debugging on the Phone page first');
    }
    const id = nextId++;
    const win = new BrowserWindow({
      width, height, minWidth: 220, minHeight: 300, title, show: false,
      titleBarStyle: 'hiddenInset', backgroundColor: '#000000',
      webPreferences: { preload: path.join(__dirname, 'preload-phoneview.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    const v = { id, kind, app, title, win, session: null, keys: new KeyState(), size: null, ready: false, queue: [] };
    this.views.set(id, v);
    if (kind === 'app') setImmediate(() => this._stubs());
    win.loadFile(path.join(__dirname, 'phoneview.html'), { query: { kind, title } });
    if (!hidden) win.once('ready-to-show', () => win.show());
    win.webContents.once('did-finish-load', () => {
      v.ready = true;
      for (const [ch, m] of v.queue.splice(0)) win.webContents.send(ch, m);
    });
    win.on('closed', () => {
      if (v.session) v.session.stop();
      this.views.delete(id);
      this._stubs();
      this.emit('change');
    });
    this.emit('change');
    if (kind !== 'netsound') this._start(v, opts).catch((e) => {
      console.log(`[phone] ${kind} window: ${e.message}`);
      this._send(v, 'phoneview:status', { error: e.message });
    });
  }

  _send(v, ch, m) {
    if (!v.win || v.win.isDestroyed()) return;
    if (!v.ready) return v.queue.push([ch, m]);
    v.win.webContents.send(ch, m);
  }

  async _start(v, opts) {
    const s = new Session(this.bridge.adb, this.bridge.serial, opts);
    const via = this.bridge.via;
    v.session = s;
    s.on('size', (size) => {
      v.size = size;
      this._send(v, 'phoneview:size', size);
      if ((v.kind === 'screen' || v.kind === 'camera') && v.win && !v.win.isDestroyed()) v.win.setAspectRatio(size.width / size.height);
    });
    s.on('video', (p) => this._send(v, 'phoneview:video', p));
    s.on('audio', (p) => !p.config && this._send(v, 'phoneview:audio', p.data));
    s.on('closed', (why) => this._send(v, 'phoneview:status', { closed: why }));
    await s.start();
    if (v.app) setTimeout(() => s.startApp(v.app), 300);
    this._send(v, 'phoneview:status', { ready: true, via });
  }

  _input(v, m) {
    const s = v.session;
    const size = v.size;
    if (!s || s.closed) return;
    const num = (x) => (Number.isFinite(x) ? x : 0);
    switch (m.t) {
      case 'touch': // a finger (pointer ≥ 0) or the mouse (-1) at video coordinates
        if (!size) return;
        s.touch(m.action | 0, Math.max(-3, Math.min(9, m.pointer | 0)), num(m.x), num(m.y), size.width, size.height,
          m.action === ACTION.UP ? 0 : 1, m.actionButton | 0, m.buttons | 0);
        break;
      case 'scroll':
        if (!size) return;
        s.scroll(num(m.x), num(m.y), size.width, size.height, num(m.hs), num(m.vs), 0);
        break;
      case 'key': {
        if (typeof m.code !== 'string') return;
        const swap = P.keySwapNeeded(P.OS.MAC, P.OS.ANDROID) && this.getSettings().keys.swapCtrlCmd !== false;
        const e = v.keys.event(swap ? P.mapKeyFromOtherPlatform(m.code) : m.code, !!m.down);
        if (e) s.key(m.down ? ACTION.DOWN : ACTION.UP, e.keycode, e.meta, m.repeat ? 1 : 0);
        break;
      }
      case 'nav': {
        const k = { back: ANDROID.BACK, home: ANDROID.HOME, recents: ANDROID.APP_SWITCH, power: ANDROID.POWER }[m.key];
        if (m.key === 'back') { s.backOrScreenOn(ACTION.DOWN); s.backOrScreenOn(ACTION.UP); } else if (k) s.tap(k);
        if (m.key === 'notifications') s.simple(TYPE.EXPAND_NOTIFICATIONS);
        if (m.key === 'rotate') s.simple(TYPE.ROTATE);
        break;
      }
      case 'resetVideo': // the window skipped frames: a keyframe now
        s.simple(TYPE.RESET_VIDEO);
        break;
      case 'cameraTorch':
        if (s && s.setTorch) s.setTorch(!!m.on);
        break;
      case 'cameraZoomIn':
        if (s && s.zoomIn) s.zoomIn();
        break;
      case 'cameraZoomOut':
        if (s && s.zoomOut) s.zoomOut();
        break;
      case 'cameraSwitch': {
        const newFacing = m.facing === 'front' ? 'back' : 'front';
        this.close(v.id);
        this.openCamera({ facing: newFacing });
        break;
      }
      case 'resize': // an app window changed size: its virtual display follows (flex)
        if (v.kind === 'app' && m.w > 50 && m.h > 50) s.resizeDisplay(Math.round(m.w), Math.round(m.h));
        break;
      default: break;
    }
  }

  shutdown() {
    this.closeAll();
    for (const st of this.stubs.values()) st.stop();
    this.stubs.clear();
  }

  // ---- the Dock ----

  _info(pkg, name) {
    const a = (this.phone.apps || []).find((x) => x.id === pkg);
    return { id: `phone:${pkg}`, name: (a && a.name) || name || pkg, icon: (a && a.icon) || '' };
  }

  // One Dock icon per phone app with windows here: click brings them up, Quit closes them.
  _stubs() {
    const open = new Map();
    for (const v of this.views.values()) if (v.kind === 'app' && v.win && !v.win.isDestroyed()) open.set(v.app, [...(open.get(v.app) || []), v]);
    for (const [pkg, st] of this.stubs) if (!open.has(pkg)) { st.stop(); this.stubs.delete(pkg); }
    for (const [pkg, vs] of open) {
      if (!this.stubs.has(pkg)) {
        this.stubs.set(pkg, new DockStub(this._info(pkg, vs[0].title), (ev, i) => {
          const ws = [...this.views.values()].filter((v) => v.kind === 'app' && v.app === pkg && v.win && !v.win.isDestroyed());
          if (ev === 'quit') return ws.forEach((v) => v.win.close());
          const w = ws[ev === 'focus' ? i : 0];
          if (w) {
            app.focus({ steal: true }); // TwinDesk has no Dock icon of its own
            w.win.show();
            w.win.focus();
          }
        }));
      }
      this.stubs.get(pkg).menu(vs.map((v) => v.title));
    }
  }

  // Phone page › an app › Add to Dock (and ~/Applications/MacShare Apps, for Launchpad and Spotlight).
  async pin(pkg, name) {
    const info = this._info(pkg, name);
    const ok = await addToDock(info);
    this.bridge.emit('popup', ok ? 'home' : 'driven', ok ? `${info.name} is in the Dock` : `Couldn’t add ${info.name} to the Dock`);
  }
}

module.exports = { PhoneViews };

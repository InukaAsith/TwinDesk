// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone in windows on this PC: its screen (mirror, with its sound), and phone apps each in a
// window of their own on a virtual display of the window's size (scrcpy new_display + flex, so
// resizing the window resizes the app). One scrcpy session per window (scrcpy.js); the window
// decodes the H.264 itself (phoneview-renderer.js) and sends touches, keys and scrolls back.
// Port of mac/phoneview.js: Windows title bar (its own buttons drawn over ours), no Ctrl/Cmd swap.
// The window's controls sit in the title bar, as on the Mac (the default), or a side panel
// (settings.phone.controls 'side'), and the window is sized for the picture plus those bars.
// A phone app's windows have a taskbar identity of their own (its icon, Pin to taskbar starts it),
// and pin() puts it in Start › TwinDesk Apps: both start "TwinDesk.exe --phone-app=<package>".
//
// Events: 'change' — the window list changed; 'focus' — a phone window got or lost focus.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, screen, shell, nativeImage, clipboard } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const I18n = require('../shared/i18n.js');
const { Session, ACTION, TYPE } = require('./scrcpy');
const { NativeScreen } = require('../shared/nativescreen.js');
const { KeyState, ANDROID } = require('./android-keys');
const chat = require('../shared/phonechat.js');
const { writeClipImage } = require('../shared/clipimage.js');

const T = P.T;
const NOTIFIED_MS = 60000; // how long a clicked notification waits for the unlock and wireless debugging
// The window's own bars around the picture (phoneview.css): the title bar and the side panel.
const TITLE_H = 32, PANEL_W = 44;
const HIDDEN = ['sound', 'netsound', 'mic']; // windows that only play the phone's sound: no picture, no bars
let nextId = 1;
let quitting = false; // a camera's window hides on close, but not on quit
app.on('before-quit', () => { quitting = true; });

class PhoneViews extends EventEmitter {
  constructor({ bridge, phone, getSettings, server, fileSend }) {
    super();
    Object.assign(this, { bridge, phone, getSettings, server, fileSend });
    this.views = new Map(); // id -> {id, kind, app, title, win, session, keys, size}
    bridge.views = this;
    this.on('change', () => bridge._tellPhone()); // its Screen and Camera pages follow the windows here
    this.notified = null; // {pkg, name, at, unlocked}: a clicked notification's app, waiting to open (openNotified)
    // The app in front on the phone, which its Accessibility says (the full app): Enter in a chat
    // app sends (shared/phonechat.js); a11y: the phone clicks Send itself.
    this.activeApp = '';
    this.a11y = false;
    server.on(`t:${T.PHONE_ACTIVE_APP}`, (m) => {
      if (!m || typeof m.pkg !== 'string') return;
      this.activeApp = m.pkg.slice(0, 200);
      this.a11y = true;
    });
    server.on(`t:${T.PHONE_AWAKE}`, (m) => this._awake(m));
    // The phone's own Show and Close (its Screen page): its screen in a window here (openScreen
    // decides how: wireless debugging, Wi-Fi first when on Bluetooth, or a popup saying what's
    // missing), or its windows here closed (not the hidden ones playing its sound).
    // The phone's own Camera page: its camera running here (the Camera tab's picture, the virtual
    // camera), back or front, or stopped.
    server.on(`t:${T.PHONE_CAMERA}`, (m) => {
      if (m && m.open === false) {
        for (const v of this.list()) if (v.kind === 'camera') this.close(v.id);
      } else this.openCamera({ facing: m && m.facing });
    });
    server.on(`t:${T.PHONE_MIRROR}`, (m) => {
      if (m && m.open === false) {
        for (const v of this.list()) this.close(v.id);
      } else this.openScreen();
    });
    bridge.on('change', () => this._openNotified());
    server.on('closed', () => {
      this.notified = null;
      this.activeApp = '';
      this.a11y = false;
    });
    this.on('change', () => bridge._sound()); // a Native screen window with its sound takes the phone's own capture
    ipcMain.on('phoneview:in', (e, m) => {
      const v = [...this.views.values()].find((x) => x.win && !x.win.isDestroyed() && x.win.webContents === e.sender);
      if (v && m && typeof m === 'object') this._input(v, m);
    });
    // Files dropped on a phone window go to the phone (its Downloads).
    ipcMain.on('phoneview:drop', (e, paths) => {
      if (!Array.isArray(paths) || !paths.length || !this.server.current) return;
      const b = this.fileSend.sendBatch(paths.filter((p) => typeof p === 'string' && path.win32.isAbsolute(p)).slice(0, 1000), 'send');
      if (b) this.bridge.emit('popup', 'away', `Sending ${b.name} to ${this.server.current.name}`);
    });
  }

  // The phone's sound on its own (no screen window): an audio-only session in a hidden window.
  sound(on) {
    const open = [...this.views.values()].find((v) => v.kind === 'sound');
    if (on && !open && this.bridge.serial) {
      this._open({ kind: 'sound', title: this._i18n().t('Phone sound'), titleKey: 'Phone sound', width: 200, height: 100, hidden: true, opts: { video: false, audio: true, control: false, audioSource: 'output' } });
    } else if (!on && open) this.close(open.id);
  }

  // The phone's microphone as a microphone here (Audio › Microphone, Android 11 or later): an
  // audio-only session capturing the phone's mic, in a hidden window that plays it into the
  // TwinDesk Microphone (Linux) or a virtual audio cable (phoneview-renderer.js picks it).
  mic(on, out = '') {
    const open = [...this.views.values()].find((v) => v.kind === 'mic');
    if (open && on && open.sink !== out) this.close(open.id); // another output picked: start again
    else if (open && on) return;
    if (on && this.bridge.serial) {
      this._open({ kind: 'mic', title: this._i18n().t('Phone microphone'), titleKey: 'Phone microphone', width: 200, height: 100, hidden: true, sink: out, opts: { video: false, audio: true, control: false, audioSource: 'mic' } });
    } else if (!on && open) this.close(open.id);
  }

  // The phone's sound captured by the phone itself (no wireless debugging, phone-bridge.js): a
  // hidden window with no adb session, fed what comes through the session.
  netSound(on) {
    const open = [...this.views.values()].find((v) => v.kind === 'netsound');
    if (on && !open) this._open({ kind: 'netsound', title: this._i18n().t('Phone sound'), titleKey: 'Phone sound', width: 200, height: 100, hidden: true });
    else if (!on && open) this.close(open.id);
  }

  netAudio(m) {
    const p = { codec: m.codec === 'pcm' ? 'pcm' : 'opus', p: Array.isArray(m.p) ? m.p.filter((x) => typeof x === 'string').slice(0, 10) : [] };
    for (const v of this.views.values()) if (v.kind === 'netsound' || (v.native && v.session && v.session.opts.audio)) this._send(v, 'phoneview:netaudio', p);
  }

  // A Native screen window (Mirroring › Native) that plays the phone's sound: phone-bridge.js asks
  // the phone for it (phone.sound.want).
  get nativeScreenSound() {
    return [...this.views.values()].some((v) => v.kind === 'screen' && v.native && v.session && !v.session.closed && v.session.opts.audio);
  }

  list() {
    return [...this.views.values()].filter((v) => v.kind !== 'sound' && v.kind !== 'netsound' && v.kind !== 'mic').map((v) => ({ id: v.id, kind: v.kind, app: v.app || null, title: v.title, facing: v.facing || null, screenOff: !!v.screenOff, native: !!v.native, shown: !!(v.win && !v.win.isDestroyed() && v.win.isVisible()), error: v.error || '' }));
  }

  get focused() {
    return [...this.views.values()].some((v) => v.win && !v.win.isDestroyed() && v.win.isFocused());
  }

  openScreen(opts) {
    const isAirplay = typeof opts === 'object' ? !!opts?.airplay : (opts === true);
    const open = [...this.views.values()].find((v) => v.kind === 'screen');
    if (open) return open.win.show(), open.win.focus();
    const info = (this.phone && this.phone.info) || {};
    const d = info.display || { w: 1080, h: 2400 };
    const work = screen.getPrimaryDisplay().workAreaSize;
    const c = this._chrome();
    const h = Math.min(860, work.height - 80);
    const w = Math.round((h - c.h) * Math.min(d.w, d.h) / Math.max(d.w, d.h)) + c.w;
    const devName = (opts && typeof opts === 'object' && opts.name) || (this.server && this.server.current && this.server.current.name);
    const name = isAirplay ? (devName || 'AirPlay') : (devName || this._i18n().t('Phone'));
    const titleKey = isAirplay ? '' : (devName ? '' : 'Phone');
    // Mirroring › Native (or Automatic without wireless debugging): the phone shares it itself.
    const native = isAirplay || (this.bridge && this.bridge.mirrorVia === 'native');
    this._open({ kind: 'screen', native, airplay: isAirplay, title: name, titleKey, width: w, height: h, opts: isAirplay ? null : (this.bridge ? this.bridge.sessionOpts('screen') : {}) });
  }

  // The phone's camera (Camera's switch, or the phone's Camera page; scrcpy's camera source, Android
  // 12 or later): facing 'back' or 'front'; the camera picks its best size up to 1920 on the long
  // side (a size it doesn't have would fail), at 30 fps. Its window opens hidden: the picture goes
  // to the Camera tab and the virtual camera (shared/vcam.js); show: the window too (Camera ›
  // Window), its light and zoom from the window's controls. Closing the window only hides it. The other facing with it
  // running: the same window switches (_flip).
  openCamera(opts) {
    if (!this.cameraOn) return; // Camera is off here: the phone's Camera page says so (cameraState)
    opts = opts && typeof opts === 'object' ? opts : {};
    const want = opts.facing === 'front' || opts.facing === 'back' ? opts.facing : null;
    const open = [...this.views.values()].find((v) => v.kind === 'camera' && !v.ending);
    if (open) {
      if (want && want !== open.facing) this._flip(open, want);
      if (opts.show) {
        open.win.show();
        open.win.focus();
      }
      return;
    }
    const facing = want || 'back';
    const titleName = (this.server.current && this.server.current.name) || '';
    const titleKey = titleName ? '{name} Camera' : 'Phone Camera';
    const name = this._i18n().t(titleKey, { name: titleName });
    const c = this._chrome();
    const v = this._open({ kind: 'camera', title: name, titleKey, titleName, width: 854 + c.w, height: 480 + c.h, opts: this._cameraOpts(facing, opts.size), hidden: !opts.show });
    if (!v) return;
    v.facing = facing;
    this.emit('change'); // with its facing, for the tab and the phone
  }

  _cameraOpts(facing, size) {
    const cam = { videoSource: 'camera', cameraFacing: facing, cameraFps: 30, maxSize: 1920 };
    if (/^\d{2,5}x\d{2,5}$/.test(String(size || ''))) cam.cameraSize = size;
    return this.bridge.sessionOpts('camera', cam);
  }

  // Front or back in the same window: the phone lets go of one camera a moment after its session
  // ends, and a session started before that can't open the other (it ended, and its window with it).
  async _flip(v, facing) {
    v.facing = facing;
    v.error = '';
    const token = (v.flips = (v.flips || 0) + 1);
    const old = v.session;
    v.session = null; // first: its end isn't the window's
    if (old) old.stop();
    this.bridge._tellPhone();
    this.emit('change');
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 1200 + attempt * 1000));
      if (v.flips !== token || v.win.isDestroyed()) return;
      try {
        await this._start(v, this._cameraOpts(facing));
        return;
      } catch (e) {
        v.error = e.message;
      }
    }
    this.emit('change');
  }

  // For the phone's Camera page (phone-bridge.js): its camera here, which one, and the virtual camera.
  // The Camera tab's switch (settings.camera.on): off, no camera runs here.
  get cameraOn() {
    const c = this.getSettings().camera;
    return !c || c.on !== false;
  }

  cameraState() {
    if (!this.cameraOn) return { on: false, facing: null, error: 'Camera is off on this computer: turn it on in TwinDesk’s Camera tab there', virtual: false };
    const v = [...this.views.values()].find((x) => x.kind === 'camera' && !x.ending);
    return { on: !!v, facing: v ? v.facing : null, error: v ? v.error || '' : '', virtual: !!(this.vcam && this.vcam.ready) };
  }

  openApp(pkg, name) {
    const open = [...this.views.values()].find((v) => v.kind === 'app' && v.app === pkg);
    if (open) return open.win.show(), open.win.focus();
    const c = this._chrome();
    const w = 412; // the app's own area; the window adds its bars
    const h = 860 - c.h;
    // At least 2 pixels per point (sharp at 100% scaling); the dpi keeps 1 dp = 1 point, so the
    // app's text is as big as this computer's. The window's resizes use the same rule.
    const scale = Math.max(2, screen.getPrimaryDisplay().scaleFactor || 1);
    const newDisplay = `${Math.round(w * scale)}x${Math.round(h * scale)}/${Math.round(160 * scale)}`;
    this._open({ kind: 'app', app: pkg, title: name || pkg, width: w + c.w, height: h + c.h, opts: this.bridge.sessionOpts('app', { newDisplay }) });
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
    const a = this._app(n.pkg);
    this.openApp(n.pkg, (a && a.name) || n.name);
  }

  close(id) {
    const v = this.views.get(id);
    if (!v || !v.win || v.win.isDestroyed()) return;
    v.ending = true;
    v.win.close();
  }

  closeAll() {
    for (const v of [...this.views.values()]) this.close(v.id);
  }

  get screenWithSound() {
    return [...this.views.values()].some((v) => v.kind === 'screen' && v.session && v.session.opts.audio);
  }

  _i18n() {
    const settings = this.getSettings();
    return I18n.create(I18n.resolveLanguage(settings.ui && settings.ui.language, app.getLocale()));
  }

  _open({ kind, app, title, titleKey = '', titleName = '', width, height, opts, hidden = false, sink = '', native = false, airplay = false }) {
    if (!this.bridge.serial && kind !== 'netsound' && !native && !airplay) {
      // Wireless debugging not up yet (just on Wi-Fi after Bluetooth): main.js opens it once it is.
      if (kind !== 'mic' && this.onNoAdb && this.onNoAdb({ kind, app, title, titleKey, titleName, width, height, opts, hidden })) return;
      return this.bridge.emit('popup', 'home', 'Set up wireless debugging on the Phone page first');
    }
    const id = nextId++;
    const win = new BrowserWindow({
      width, height, minWidth: 220, minHeight: 300, title, show: false,
      titleBarStyle: 'hidden', titleBarOverlay: { color: '#1c1c1e', symbolColor: '#f5f5f7', height: 32 }, backgroundColor: '#000000',
      icon: path.join(__dirname, 'assets', 'icon.png'), autoHideMenuBar: true,
      // autoplayPolicy: the phone's sound plays without a click (its sound window is hidden, so a
      // click never comes: without this its AudioContext stays suspended and silent).
      webPreferences: { preload: path.join(__dirname, 'preload-phoneview.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    const v = { id, kind, app, title, win, sink, native, airplay: !!airplay, session: null, keys: new KeyState(), size: null, ready: false, queue: [], chrome: this._chrome(), screenOff: false, torch: false, eaten: new Set() };
    this.views.set(id, v);
    this._send(v, 'phoneview:opts', this._opts(v));
    win.loadFile(path.join(__dirname, 'phoneview.html'), { query: { kind, title, titleKey, titleName, ...(kind === 'mic' ? { sink, virtual: process.platform === 'linux' ? '1' : '' } : {}), controls: this._controls(), language: this._i18n().locale } });
    // The phone's screen: the window keeps the picture's shape, its bars added (snapped exact
    // when a resize ends: with the bars in, the right ratio changes a little with the size).
    if (kind === 'screen') win.on('resized', () => this._fit(v, 'height'));
    if (kind === 'app') this._details(win, app, title);
    if (!hidden) win.once('ready-to-show', () => win.show());
    win.webContents.once('did-finish-load', () => {
      v.ready = true;
      for (const [ch, m] of v.queue.splice(0)) win.webContents.send(ch, m);
    });
    win.on('focus', () => this.emit('focus'));
    win.on('blur', () => this.emit('focus'));
    // A camera's window: closed, it only hides (the camera stops with Camera's switch).
    if (kind === 'camera') {
      win.on('close', (e) => {
        if (v.ending || quitting) return;
        e.preventDefault();
        win.hide();
        this.emit('change');
      });
      win.on('show', () => this.emit('change'));
    }
    win.on('closed', () => {
      if (v.swipeTimer) clearInterval(v.swipeTimer);
      if (v.screenOff && v.session && !v.session.closed) {
        try { v.session.setDisplayPower(true); } catch {}
      }
      if (v.session) v.session.stop();
      this.views.delete(id);
      this.emit('change');
    });
    this.emit('change');
    if (airplay) {
      this._send(v, 'phoneview:status', { ready: true, via: 'airplay' });
    } else if (kind !== 'netsound') {
      this._start(v, opts).catch((e) => {
        console.log(`[phone] ${kind} window: ${e.message}`);
        this._send(v, 'phoneview:status', { error: e.message, errorKey: e.messageKey, errorVars: e.messageVars });
      });
    }
    return v;
  }

  // Where the window's controls sit: 'top' (Back, Home, Recents and Notifications in the title bar,
  // as on the Mac: the default; Rotate and Phone screen off are on the Phone page) or 'side' (Phone
  // page › Side panel: all of them in a panel down the right).
  _controls() {
    const ph = this.getSettings().phone;
    return ph && ph.controls === 'side' ? 'side' : 'top';
  }

  // The Phone page's Rotate and Phone screen off, for the phone screen window (as on the Mac).
  screenAct(key) {
    if (key !== 'rotate' && key !== 'screenPower') return;
    const v = [...this.views.values()].find((x) => x.kind === 'screen' && !x.ending);
    if (!v) return;
    this._input(v, { t: 'nav', key });
    this.emit('change');
  }

  // The size of a window's bars around the picture.
  _chrome(controls = this._controls()) {
    return { w: controls === 'side' ? PANEL_W : 0, h: TITLE_H };
  }

  // The window's switches as they are now (its controls light up).
  _opts(v) {
    const ph = this.getSettings().phone || {};
    return { enterSends: ph.enterSends !== false, arrowSwipe: ph.arrowSwipe === true, screenOff: !!v.screenOff, pinned: !!(v.win && !v.win.isDestroyed() && v.win.isAlwaysOnTop()), torch: !!v.torch };
  }

  // Enter sends / Arrow keys swipe changed (here, or on the Phone page): every window shows it.
  applyOpts() {
    for (const v of this.views.values()) if (!HIDDEN.includes(v.kind)) this._send(v, 'phoneview:opts', this._opts(v));
  }

  // Enter in a chat app, an arrow that swipes (shared/phonechat.js): done here, the key (and its
  // release) left out. True when the key was used up.
  _special(v, code, down) {
    if (!down) return v.eaten.delete(code);
    if (v.eaten.has(code)) return true; // held: once
    const ph = this.getSettings().phone || {};
    const s = v.session;
    let done = false;
    const dir = chat.swipeOf(code, ph.arrowSwipe === true, v.keys.held);
    if (dir) {
      this._swipe(v, dir);
      done = true;
    } else if (chat.isEnter(code)) {
      done = chat.enter({
        on: ph.enterSends !== false,
        pkg: v.app || this.activeApp,
        shift: v.keys.held.has('ShiftLeft') || v.keys.held.has('ShiftRight'),
        a11y: this.a11y,
        phoneSend: () => this.server.sendToClient({ t: T.PHONE_SEND }),
        tap: (k) => !s.closed && s.tap(k),
        text: (t) => s.text(t),
      });
    }
    if (done) v.eaten.add(code);
    return done;
  }

  // The setting changed: the open windows move their controls, and grow or shrink by the bars so
  // the picture keeps its size.
  applyControls() {
    const controls = this._controls();
    const c = this._chrome(controls);
    for (const v of this.views.values()) {
      if (HIDDEN.includes(v.kind) || !v.win || v.win.isDestroyed()) continue;
      this._send(v, 'phoneview:opts', { controls, ...this._opts(v) });
      const b = v.win.getBounds();
      v.win.setBounds({ x: b.x, y: b.y, width: b.width + c.w - v.chrome.w, height: b.height + c.h - v.chrome.h });
      v.chrome = c;
      if (v.kind === 'screen') this._fit(v, 'height');
    }
  }

  // A screen window sized to its picture plus its bars. keep: 'height' (after a resize), or
  // 'long' (the picture's long side stays, so the phone turning round turns the window too).
  _fit(v, keep) {
    if (!v.size || !v.win || v.win.isDestroyed() || v.win.isMaximized() || v.win.isFullScreen()) return;
    const b = v.win.getBounds();
    const c = v.chrome;
    const a = v.size.width / v.size.height;
    let cw, ch;
    if (keep === 'height') {
      ch = b.height - c.h;
      cw = Math.round(ch * a);
    } else {
      const long = Math.max(b.width - c.w, b.height - c.h);
      cw = a >= 1 ? long : Math.round(long * a);
      ch = a >= 1 ? Math.round(long / a) : long;
    }
    v.win.setBounds({ x: b.x, y: b.y, width: cw + c.w, height: ch + c.h });
    // For the next drag: the whole window's ratio at this size (setAspectRatio counts the bars too).
    v.win.setAspectRatio((cw + c.w) / (ch + c.h));
  }

  // An app window's Rotate: its area's width and height swap (its virtual display follows the
  // window, so the app gets the other orientation).
  _rotateApp(v) {
    const b = v.win.getBounds();
    const c = v.chrome;
    v.win.setBounds({ x: b.x, y: b.y, width: b.height - c.h + c.w, height: b.width - c.w + c.h });
  }

  // The side panel's screenshot button: the window's picture (a PNG from phoneview-renderer.js)
  // onto this PC's clipboard.
  _shot(v, png) {
    if (!(png instanceof Uint8Array) || png.length < 64 || png.length > 64 * 1024 * 1024) return;
    const buf = Buffer.from(png);
    if (buf.readUInt32BE(0) !== 0x89504e47) return; // not a PNG
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return;
    writeClipImage(clipboard, img, buf).catch(() => {}); // Electron 44: write(), shared/clipimage.js
    this.bridge.emit('popup', 'away', 'Screenshot copied: paste it with Ctrl+V');
  }

  _send(v, ch, m) {
    if (!v.win || v.win.isDestroyed()) return;
    if (!v.ready) return v.queue.push([ch, m]);
    v.win.webContents.send(ch, m);
  }

  async _start(v, opts) {
    const s = v.native ? new NativeScreen(this.server, opts) : new Session(this.bridge.adb, this.bridge.serial, opts);
    const via = v.native ? null : this.bridge.via;
    if (v.native) setImmediate(() => this.bridge._sound()); // its sound, when it plays it
    if (v.native) s.on('waiting', () => this._send(v, 'phoneview:status', { error: 'Tap Start on the phone to share its screen', errorKey: 'Tap Start on the phone to share its screen' }));
    v.session = s;
    s.on('size', (size) => {
      v.size = size;
      this._send(v, 'phoneview:size', size);
      if (v.kind === 'screen' || v.kind === 'camera') this._fit(v, 'long');
    });
    s.on('video', (p) => this._send(v, 'phoneview:video', p));
    s.on('audio', (p) => !p.config && this._send(v, 'phoneview:audio', p.data));
    s.on('closed', (why, metadata) => {
      if (v.session !== s) return; // one a flip replaced
      this._send(v, 'phoneview:status', { closed: why, closedKey: metadata && metadata.messageKey, closedVars: metadata && metadata.messageVars });
      if (v.kind === 'camera' && why !== 'stopped') {
        v.error = why;
        this.emit('change');
      }
    });
    await s.start();
    if (v.app) setTimeout(() => s.startApp(v.app), 300);
    this._send(v, 'phoneview:status', { ready: true, via });
  }

  _input(v, m) {
    // The window's own: no phone needed.
    if (m.t === 'shot') return this._shot(v, m.png);
    if (m.t === 'pin') {
      const on = !v.win.isAlwaysOnTop();
      v.win.setAlwaysOnTop(on);
      return this._send(v, 'phoneview:opts', { pinned: on });
    }
    if (m.t === 'nav' && m.key === 'rotate' && v.kind === 'app') return this._rotateApp(v);
    // Fullscreen (its title-bar button, F11): only the picture, black around it; F11 again leaves.
    if (m.t === 'full') {
      const on = !v.win.isFullScreen();
      v.win.setFullScreen(on);
      return this._send(v, 'phoneview:opts', { full: on });
    }
    if (m.t === 'toggle' && (m.what === 'enterSends' || m.what === 'arrowSwipe')) {
      const ph = this.getSettings().phone;
      ph[m.what] = m.what === 'enterSends' ? ph.enterSends === false : ph.arrowSwipe !== true;
      this.bridge.emit('save');
      this.applyOpts();
      return this.emit('change');
    }
    const s = v.session;
    const size = v.size;
    if (!s || s.closed) return;
    // A camera's picture isn't the phone's screen: touches and keys there would land on whatever the screen shows.
    if (v.kind === 'camera' && (m.t === 'touch' || m.t === 'scroll' || m.t === 'key')) return;
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
        const swap = P.keySwapNeeded(P.OS.WIN, P.OS.ANDROID) && this.getSettings().keys.swapCtrlCmd !== false;
        const code = swap ? P.mapKeyFromOtherPlatform(m.code) : m.code;
        if (this._special(v, code, !!m.down)) break;
        const e = v.keys.event(code, !!m.down);
        if (e) s.key(m.down ? ACTION.DOWN : ACTION.UP, e.keycode, e.meta, m.repeat ? 1 : 0);
        break;
      }
      case 'nav': {
        const k = {
          back: ANDROID.BACK, home: ANDROID.HOME, recents: ANDROID.APP_SWITCH, power: ANDROID.POWER,
          volumeUp: ANDROID.VOLUME_UP, volumeDown: ANDROID.VOLUME_DOWN, mute: ANDROID.VOLUME_MUTE,
        }[m.key];
        if (m.key === 'back') { s.backOrScreenOn(ACTION.DOWN); s.backOrScreenOn(ACTION.UP); } else if (k) s.tap(k);
        if (m.key === 'notifications') s.simple(TYPE.EXPAND_NOTIFICATIONS);
        if (m.key === 'settings') s.simple(TYPE.EXPAND_SETTINGS);
        if (m.key === 'rotate') s.simple(TYPE.ROTATE);
        // The phone's own screen off, its picture still here (scrcpy's display power).
        if (m.key === 'screenPower' && v.kind === 'screen' && !v.native) {
          v.screenOff = !v.screenOff;
          s.setDisplayPower(!v.screenOff);
          this._send(v, 'phoneview:opts', { screenOff: v.screenOff });
        }
        break;
      }
      case 'resetVideo': // the window skipped frames: a keyframe now
        s.simple(TYPE.RESET_VIDEO);
        break;
      case 'camera': // a camera window's controls
        if (v.kind !== 'camera') break;
        if (m.what === 'torch') {
          v.torch = !v.torch;
          s.setTorch(v.torch);
          this._send(v, 'phoneview:opts', { torch: v.torch });
        } else if (m.what === 'zoomIn') s.zoomIn();
        else if (m.what === 'zoomOut') s.zoomOut();
        else if (m.what === 'flip') { // the other camera: a session of its own
          this._flip(v, v.facing === 'front' ? 'back' : 'front');
        }
        break;
      case 'resize': // an app window changed size: its virtual display follows (flex)
        if (v.kind === 'app' && m.w > 50 && m.h > 50) s.resizeDisplay(Math.round(m.w), Math.round(m.h));
        break;
      case 'swipe':
        if (typeof m.dir === 'string') this._swipe(v, m.dir);
        break;
      default: break;
    }
  }

  _swipe(v, dir) {
    const s = v.session;
    const size = v.size;
    if (!s || s.closed || !size) return;
    if (v.swiping) {
      // Buffer at most 1 subsequent swipe so rapid taps are never dropped
      v.pendingSwipe = dir;
      return;
    }
    v.swiping = true;

    const w = size.width;
    const h = size.height;
    let startX, startY, endX, endY;

    // Inverted directional swipe for natural navigation:
    // ArrowDown -> content moves down (finger swipes UP from bottom to top)
    // ArrowUp -> content moves up (finger swipes DOWN from top to bottom)
    // ArrowRight -> content moves right (finger swipes LEFT from right to left)
    // ArrowLeft -> content moves left (finger swipes RIGHT from left to right)
    switch (dir) {
      case 'down':
        startX = Math.round(w * 0.5);
        startY = Math.round(h * 0.78);
        endX = Math.round(w * 0.5);
        endY = Math.round(h * 0.22);
        break;
      case 'up':
        startX = Math.round(w * 0.5);
        startY = Math.round(h * 0.22);
        endX = Math.round(w * 0.5);
        endY = Math.round(h * 0.78);
        break;
      case 'right':
        startX = Math.round(w * 0.82);
        startY = Math.round(h * 0.5);
        endX = Math.round(w * 0.18);
        endY = Math.round(h * 0.5);
        break;
      case 'left':
        startX = Math.round(w * 0.18);
        startY = Math.round(h * 0.5);
        endX = Math.round(w * 0.82);
        endY = Math.round(h * 0.5);
        break;
      default:
        v.swiping = false;
        return;
    }

    const duration = 160; // ms: natural flick duration
    const startTime = Date.now();
    const dx = endX - startX;
    const dy = endY - startY;

    // Send touch down directly over control socket (pointer: -2 = FINGER)
    s.touch(ACTION.DOWN, -2, startX, startY, w, h, 1, 0, 0);

    const timer = setInterval(() => {
      if (s.closed) {
        clearInterval(timer);
        v.swiping = false;
        v.swipeTimer = null;
        v.pendingSwipe = null;
        return;
      }

      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / duration);

      if (progress < 1) {
        // Mild ease-in curve (t^1.15): starts cleanly without jerk and maintains brisk velocity
        // right through release (ACTION.UP), ensuring Android's VelocityTracker detects a
        // natural fling and triggers a smooth inertia scroll.
        const ease = Math.pow(progress, 1.15);
        const curX = Math.round(startX + dx * ease);
        const curY = Math.round(startY + dy * ease);
        s.touch(ACTION.MOVE, -2, curX, curY, w, h, 1, 0, 0);
      } else {
        clearInterval(timer);
        v.swipeTimer = null;
        // Liftoff at terminal position with authentic release velocity
        s.touch(ACTION.UP, -2, endX, endY, w, h, 0, 0, 0);
        setTimeout(() => {
          v.swiping = false;
          if (v.pendingSwipe) {
            const next = v.pendingSwipe;
            v.pendingSwipe = null;
            this._swipe(v, next);
          }
        }, 30);
      }
    }, 10);
    v.swipeTimer = timer;
  }

  shutdown() {
    this.closeAll();
  }

  // ---- pinning ----

  static aumid(pkg) {
    return 'org.macshare.phoneapp.' + crypto.createHash('sha1').update(pkg).digest('hex').slice(0, 10);
  }

  // How this copy of TwinDesk opens one phone app: "TwinDesk.exe --phone-app=<package>".
  static relaunch(pkg) {
    const args = (app.isPackaged ? [] : [app.getAppPath()]).concat('--phone-app=' + pkg);
    return { target: process.execPath, args: args.map((x) => (/\s/.test(x) ? '"' + x + '"' : x)).join(' ') };
  }

  _app(pkg) {
    return (this.phone.apps || []).find((a) => a.id === pkg) || null;
  }

  // The app's icon as an .ico (Start shortcuts and taskbar buttons take only files).
  _ico(pkg) {
    const a = this._app(pkg);
    const img = a && a.icon ? nativeImage.createFromDataURL(a.icon) : null;
    if (!img || img.isEmpty()) return '';
    try {
      const dir = path.join(app.getPath('userData'), 'app-icons');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'phone.' + pkg.replace(/[^\w.-]/g, '_') + '.ico');
      const png = img.resize({ width: 64, height: 64 }).toPNG();
      const head = Buffer.alloc(22);
      head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4); // ICONDIR: 1 image
      head.writeUInt8(64, 6); head.writeUInt8(64, 7); head.writeUInt8(0, 8); head.writeUInt8(0, 9);
      head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
      fs.writeFileSync(file, Buffer.concat([head, png]));
      return file;
    } catch (_) { return ''; }
  }

  _details(win, pkg, name) {
    const a = this._app(pkg);
    const img = a && a.icon ? nativeImage.createFromDataURL(a.icon) : null;
    if (img && !img.isEmpty()) win.setIcon(img);
    const ico = this._ico(pkg);
    const r = PhoneViews.relaunch(pkg);
    win.setAppDetails({ appId: PhoneViews.aumid(pkg), relaunchCommand: '"' + r.target + '" ' + r.args, relaunchDisplayName: name, ...(ico ? { appIconPath: ico, appIconIndex: 0 } : {}) });
  }

  // Phone page › an app › Pin to Start: a shortcut in Start › TwinDesk Apps (pin it from there).
  pin(pkg, name) {
    const a = this._app(pkg) || { id: pkg, name: name || pkg };
    const dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TwinDesk Apps');
    const safe = String(a.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 100) || 'Phone app';
    const file = path.join(dir, safe + '.lnk');
    const ico = this._ico(pkg);
    const r = PhoneViews.relaunch(pkg);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const ok = shell.writeShortcutLink(file, fs.existsSync(file) ? 'replace' : 'create', {
        target: r.target, args: r.args, description: a.name + ' on ' + ((this.server.current && this.server.current.name) || 'the phone') + ' (TwinDesk)',
        appUserModelId: PhoneViews.aumid(pkg), ...(ico ? { icon: ico, iconIndex: 0 } : {}),
      });
      if (!ok) throw new Error('Windows refused the shortcut');
      this.bridge.emit('popup', 'home', a.name + ' is in Start › TwinDesk Apps');
    } catch (e) {
      this.bridge.emit('popup', 'driven', 'Couldn’t add ' + a.name + ' to Start: ' + e.message);
    }
  }
}

module.exports = { PhoneViews };

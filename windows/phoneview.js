// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone in windows on this PC: its screen (mirror, with its sound), and phone apps each in a
// window of their own on a virtual display of the window's size (scrcpy new_display + flex, so
// resizing the window resizes the app). One scrcpy session per window (scrcpy.js); the window
// decodes the H.264 itself (phoneview-renderer.js) and sends touches, keys and scrolls back.
// Port of mac/phoneview.js: Windows title bar (its own buttons drawn over ours), no Ctrl/Cmd swap.
// The window's controls sit in a side panel (the default), the title bar or a bar under the picture
// (settings.phone.controls), and the window is sized for the picture plus those bars.
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
const { Session, ACTION, TYPE } = require('./scrcpy');
const { KeyState, ANDROID } = require('./android-keys');

const T = P.T;
const NOTIFIED_MS = 60000; // how long a clicked notification waits for the unlock and wireless debugging
// The window's own bars around the picture (phoneview.css): the title bar, the side panel, the bottom bar.
const TITLE_H = 32, PANEL_W = 44, NAVBAR_H = 40;
const HIDDEN = ['sound', 'netsound']; // windows that only play the phone's sound: no picture, no bars
let nextId = 1;

class PhoneViews extends EventEmitter {
  constructor({ bridge, phone, getSettings, server, fileSend }) {
    super();
    Object.assign(this, { bridge, phone, getSettings, server, fileSend });
    this.views = new Map(); // id -> {id, kind, app, title, win, session, keys, size}
    bridge.views = this;
    this.notified = null; // {pkg, name, at, unlocked}: a clicked notification's app, waiting to open (openNotified)
    server.on(`t:${T.PHONE_AWAKE}`, (m) => this._awake(m));
    // The phone's own Show and Close (its Screen page): its screen in a window here (openScreen
    // decides how: wireless debugging, Wi-Fi first when on Bluetooth, or a popup saying what's
    // missing), or its windows here closed (not the hidden ones playing its sound).
    server.on(`t:${T.PHONE_MIRROR}`, (m) => {
      if (m && m.open === false) {
        for (const v of this.list()) this.close(v.id);
      } else this.openScreen();
    });
    bridge.on('change', () => this._openNotified());
    server.on('closed', () => { this.notified = null; });
    this.on('change', () => bridge._tellPhone());
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
    const c = this._chrome();
    const h = Math.min(860, work.height - 80);
    const w = Math.round((h - c.h) * Math.min(d.w, d.h) / Math.max(d.w, d.h)) + c.w;
    const name = (this.server.current && this.server.current.name) || 'Phone';
    this._open({ kind: 'screen', title: name, width: w, height: h, opts: this.bridge.sessionOpts('screen') });
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
      // Wireless debugging not up yet (just on Wi-Fi after Bluetooth): main.js opens it once it is.
      if (this.onNoAdb && this.onNoAdb({ kind, app, title, width, height, opts, hidden })) return;
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
    const v = { id, kind, app, title, win, session: null, keys: new KeyState(), size: null, ready: false, queue: [], chrome: this._chrome() };
    this.views.set(id, v);
    win.loadFile(path.join(__dirname, 'phoneview.html'), { query: { kind, title, controls: this._controls() } });
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
    win.on('closed', () => {
      if (v.session) v.session.stop();
      this.views.delete(id);
      this.emit('change');
    });
    this.emit('change');
    if (kind !== 'netsound') this._start(v, opts).catch((e) => {
      console.log(`[phone] ${kind} window: ${e.message}`);
      this._send(v, 'phoneview:status', { error: e.message });
    });
  }

  // Where the window's controls sit (Phone page › Settings › Window controls): 'side' (a panel
  // down the right, the default), 'top' (the title bar) or 'bottom' (Back, Home and Recents in a
  // bar under the picture, the rest in the title bar).
  _controls() {
    const ph = this.getSettings().phone;
    return ph && ['side', 'top', 'bottom'].includes(ph.controls) ? ph.controls : 'side';
  }

  // The size of a window's bars around the picture.
  _chrome(controls = this._controls()) {
    return { w: controls === 'side' ? PANEL_W : 0, h: TITLE_H + (controls === 'bottom' ? NAVBAR_H : 0) };
  }

  // The setting changed: the open windows move their controls, and grow or shrink by the bars so
  // the picture keeps its size.
  applyControls() {
    const controls = this._controls();
    const c = this._chrome(controls);
    for (const v of this.views.values()) {
      if (HIDDEN.includes(v.kind) || !v.win || v.win.isDestroyed()) continue;
      this._send(v, 'phoneview:opts', { controls });
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
    clipboard.writeImage(img);
    this.bridge.emit('popup', 'away', 'Screenshot copied: paste it with Ctrl+V');
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
      if (v.kind === 'screen') this._fit(v, 'long');
    });
    s.on('video', (p) => this._send(v, 'phoneview:video', p));
    s.on('audio', (p) => !p.config && this._send(v, 'phoneview:audio', p.data));
    s.on('closed', (why) => this._send(v, 'phoneview:status', { closed: why }));
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
        const swap = P.keySwapNeeded(P.OS.WIN, P.OS.ANDROID) && this.getSettings().keys.swapCtrlCmd !== false;
        const e = v.keys.event(swap ? P.mapKeyFromOtherPlatform(m.code) : m.code, !!m.down);
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
        break;
      }
      case 'resetVideo': // the window skipped frames: a keyframe now
        s.simple(TYPE.RESET_VIDEO);
        break;
      case 'resize': // an app window changed size: its virtual display follows (flex)
        if (v.kind === 'app' && m.w > 50 && m.h > 50) s.resizeDisplay(Math.round(m.w), Math.round(m.h));
        break;
      default: break;
    }
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

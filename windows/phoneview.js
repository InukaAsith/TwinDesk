// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone in windows on this PC: its screen (mirror, with its sound), and phone apps each in a
// window of their own on a virtual display of the window's size (scrcpy new_display + flex, so
// resizing the window resizes the app). One scrcpy session per window (scrcpy.js); the window
// decodes the H.264 itself (phoneview-renderer.js) and sends touches, keys and scrolls back.
// Port of mac/phoneview.js: Windows title bar (its own buttons drawn over ours), no Ctrl/Cmd swap.
// A phone app's windows have a taskbar identity of their own (its icon, Pin to taskbar starts it),
// and pin() puts it in Start › TwinDesk Apps: both start "TwinDesk.exe --phone-app=<package>".
//
// Events: 'change' — the window list changed; 'focus' — a phone window got or lost focus.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, screen, shell, nativeImage } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { Session, ACTION, TYPE } = require('./scrcpy');
const { KeyState, ANDROID } = require('./android-keys');

const T = P.T;
const NOTIFIED_MS = 60000; // how long a clicked notification waits for the unlock and wireless debugging
let nextId = 1;

class PhoneViews extends EventEmitter {
  constructor({ bridge, phone, getSettings, server, fileSend }) {
    super();
    Object.assign(this, { bridge, phone, getSettings, server, fileSend });
    this.views = new Map(); // id -> {id, kind, app, title, win, session, keys, size}
    bridge.views = this;
    this.notified = null; // {pkg, name, at, unlocked}: a clicked notification's app, waiting to open (openNotified)
    this.activeApp = '';
    server.on(`t:${T.PHONE_ACTIVE_APP}`, (m) => { if (m && m.pkg) this.activeApp = m.pkg; });
    server.on(`t:${T.PHONE_AWAKE}`, (m) => this._awake(m));
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
    const h = Math.min(860, work.height - 80);
    const w = Math.round(h * Math.min(d.w, d.h) / Math.max(d.w, d.h));
    const name = (this.server.current && this.server.current.name) || 'Phone';
    this._open({ kind: 'screen', title: name, width: w, height: h, opts: this.bridge.sessionOpts('screen') });
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
    const v = { id, kind, app, title, win, session: null, keys: new KeyState(), size: null, ready: false, queue: [], screenOff: false };
    this.views.set(id, v);
    win.loadFile(path.join(__dirname, 'phoneview.html'), { query: { kind, title } });
    if (kind === 'app') this._details(win, app, title);
    if (!hidden) win.once('ready-to-show', () => win.show());
    win.webContents.once('did-finish-load', () => {
      v.ready = true;
      for (const [ch, m] of v.queue.splice(0)) win.webContents.send(ch, m);
    });
    win.on('focus', () => this.emit('focus'));
    win.on('blur', () => this.emit('focus'));
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
      if (v.kind === 'screen' && v.win && !v.win.isDestroyed()) v.win.setAspectRatio(size.width / size.height);
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
        const swap = P.keySwapNeeded(P.OS.WIN, P.OS.ANDROID) && this.getSettings().keys.swapCtrlCmd !== false;
        const e = v.keys.event(swap ? P.mapKeyFromOtherPlatform(m.code) : m.code, !!m.down);
        if (e) s.key(m.down ? ACTION.DOWN : ACTION.UP, e.keycode, e.meta, m.repeat ? 1 : 0);
        break;
      }
      case 'newline':
        if (s && !s.closed) s.text('\n');
        break;
      case 'sendMsg':
        this._sendMsg(v);
        break;
      case 'nav': {
        const k = { back: ANDROID.BACK, home: ANDROID.HOME, recents: ANDROID.APP_SWITCH, power: ANDROID.POWER }[m.key];
        if (m.key === 'back') { s.backOrScreenOn(ACTION.DOWN); s.backOrScreenOn(ACTION.UP); } else if (k) s.tap(k);
        if (m.key === 'notifications') s.simple(TYPE.EXPAND_NOTIFICATIONS);
        if (m.key === 'rotate') s.simple(TYPE.ROTATE);
        if (m.key === 'screenPower') {
          v.screenOff = !v.screenOff;
          s.setDisplayPower(!v.screenOff);
          this._send(v, 'phoneview:screenPower', { off: v.screenOff });
        }
        break;
      }
      case 'resetVideo': // the window skipped frames: a keyframe now
        s.simple(TYPE.RESET_VIDEO);
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

  _sendMsg(v) {
    const s = v.session;
    if (!s || s.closed) return;

    // 1. Tell companion app on phone to click Send button via Accessibility (InputService)
    if (this.server) {
      try { this.server.sendToClient({ t: T.PHONE_SEND }); } catch {}
    }

    const pkg = (v.app || this.activeApp || '').toLowerCase();
    const isInsta = pkg.includes('instagram');
    const isWhatsApp = pkg.includes('whatsapp');

    if (isInsta) {
      // Instagram direct message composer:
      // Tab to focus Send button, then Enter to click it.
      s.tap(61); // KEYCODE_TAB
      setTimeout(() => {
        if (v.session && !v.session.closed) {
          s.tap(66); // KEYCODE_ENTER
        }
      }, 40);
    } else if (isWhatsApp) {
      // WhatsApp:
      // 1. Enter key sends natively if "Enter is send" is enabled in WhatsApp settings
      s.tap(66); // KEYCODE_ENTER
      // 2. Tab + Enter if "Enter is send" was not toggled in WhatsApp settings
      setTimeout(() => {
        if (v.session && !v.session.closed) {
          s.tap(61);
          setTimeout(() => {
            if (v.session && !v.session.closed) s.tap(66);
          }, 35);
        }
      }, 50);
    } else {
      // General chat / messaging apps:
      s.tap(66);
      setTimeout(() => {
        if (v.session && !v.session.closed) {
          s.tap(61);
          setTimeout(() => {
            if (v.session && !v.session.closed) s.tap(66);
          }, 35);
        }
      }, 50);
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

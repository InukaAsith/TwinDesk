// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Everything this PC does to the phone through wireless debugging (adb.js + scrcpy.js), while a
// phone is the peer:
//   setup   find the phone's adb (mDNS), pair once with the code from Developer options, connect,
//           then grant the TwinDesk app what it can't ask for itself (switching wireless debugging
//           on by itself next time, notification access, the pointer overlay, background running).
//   control one control-only scrcpy session: this PC's mouse and keyboard across the screen edge
//           (Kvm drives the phone through us: kvm.take → we answer kvm.accept, inject the input at
//           positions we keep, and send kvm.home when the pointer comes back over the edge), and
//           the phone's clipboard (scrcpy reads it in the background, which the app can't).
//   windows the phone's screen in a window, and phone apps in windows of their own, each on its
//           own virtual display (phoneview.js).
// Port of mac/phone-bridge.js; server is phone-link.js.
//
// Events: 'change' — this.view changed; 'popup' (kind, text) — for the HUD.
'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const { Adb } = require('./adb');
const { Session, ACTION } = require('./scrcpy');
const { KeyState, ANDROID } = require('./android-keys');

const T = P.T;
const APP_ID = 'com.twindesk.android';
const POLL_MS = 3000;
const INPUT_BLOCKED = 'Xiaomi blocks touch and keys: on the phone, Developer options › USB debugging (Security settings)';
const BUTTON = { 0: 1, 1: 2, 2: 4, 3: 8, 4: 16 }; // our button numbers -> MotionEvent.BUTTON_*
const isPhone = (ctx) => !!ctx && ctx.os === P.OS.ANDROID;
const knownFile = () => path.join(require('electron').app.getPath('userData'), 'phone-adb-known.json');
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
// TwinDesk for Android with notification access (the "full" build). People download the standard
// build (Play Protect blocks downloaded apps that read notifications); this one we install over it
// through wireless debugging, which Play Protect doesn't check. In the app: vendor/ (installer/build.js
// copies it there); from a checkout: the Android build's dist/.
function fullApk() {
  const vendor = path.join(__dirname, 'vendor', 'twindesk-android-full.apk');
  if (fs.existsSync(vendor)) return vendor;
  const dist = path.join(__dirname, '..', 'android', 'dist');
  try {
    const f = fs.readdirSync(dist).filter((n) => /-full\.apk$/.test(n)).sort().pop();
    return f ? path.join(dist, f) : null;
  } catch {
    return null;
  }
}

class PhoneBridge extends EventEmitter {
  constructor({ server, phone, getSettings, clipboard }) {
    super();
    Object.assign(this, { server, phone, getSettings, clipboard });
    this.adb = new Adb();
    // off | missing | waitingWifi | needsPair | connecting | ready | error
    this.state = 'off';
    this.message = '';
    this.serial = null;
    this.control = null; // control-only session
    this.kvm = null; // the pointer while this PC drives the phone: {route, x, y, push}
    this.keys = new KeyState();
    this.views = null; // phoneview.js sets this
    this.setupDone = new Set(); // serials granted this run
    this.lastPort = new Map(); // phone address -> the wireless debugging port that last worked
    this.misses = 0; // tries in a row that found no way in
    // Phones (by id) adb has reached before. Android keeps the computer's key (Settings lists it),
    // so not finding one again (wireless debugging back on, at a new port, after a screen lock on
    // MIUI) is "not yet", never "pair again": only adb refusing the key asks for a code. Kept
    // across restarts.
    this.known = new Set(readJson(knownFile(), []));
    this.canPair = false; // still looking, but the code field shows (its pairing may be gone)
    this.inputBlocked = false; // Xiaomi with “USB debugging (Security settings)” off: touches and keys are refused
    this.wired = null; // wired.js: the phone on the USB cable
    this.install = null; // {state: 'installing'|'done'|'failed', message} for the full build

    phone.on('adb', () => this._kick());
    // The pairing code typed on the phone (its guide's notification), with its pairing port.
    server.on(`t:${T.ADB_PAIR}`, (m, ctx) => {
      if (!isPhone(ctx)) return;
      const port = Number(m.port) | 0;
      const address = (this.phone.adb && this.phone.adb.address) || ctx.address;
      this.pair(m.code, port > 0 && port < 65536 ? `${address}:${port}` : '');
    });
    phone.on('info', () => this._kick());
    server.on('client', (ctx) => {
      if (isPhone(ctx)) {
        this.adb.wake();
        this._tellPhone();
        return this._kick();
      }
      this._stopAll('');
    });
    server.on('closed', () => {
      if (!isPhone(server.current)) this._stopAll('');
    });
    setInterval(() => this._poll(), POLL_MS);
  }

  get view() {
    return {
      state: this.state, message: this.message, serial: this.serial, available: this.adb.available, canPair: this.canPair, inputBlocked: this.inputBlocked,
      via: this.via, // 'usb' | 'wifi' | null: how adb reaches the phone
      control: !!(this.control && !this.control.closed), driving: !!this.kvm,
      install: this.install, fullApk: !!fullApk(),
      windows: this.views ? this.views.list() : [],
    };
  }

  _set(state, message = '') {
    if (state === this.state && message === this.message) return;
    console.log(`[phone] ${state}${message ? `: ${message}` : ''}`);
    this.state = state;
    this.message = message;
    if (state !== 'connecting') this.canPair = false;
    // The phone's guide shows how it's going.
    this._tellPhone();
    this.emit('change');
  }

  get via() {
    if (!this.serial) return null;
    return /[:]/.test(this.serial) || this.serial.includes('._adb-tls') ? 'wifi' : 'usb';
  }

  // viewed: a phone window is open here (meanwhile the phone keeps its Wi-Fi out of power save).
  _tellPhone() {
    if (!isPhone(this.server.current)) return;
    const viewed = !!(this.views && this.views.list().length);
    this.server.sendToClient({ t: T.ADB_BRIDGE, state: this.state, message: this.message, canPair: this.canPair, inputBlocked: this.inputBlocked, viewed });
  }

  // MIUI and HyperOS refuse adb's touches and keys (INJECT_EVENTS) until Developer options ›
  // “USB debugging (Security settings)” is on. It needs a Mi account, and adb can't switch it.
  async _checkInput(serial) {
    const r = await this.adb.shell(serial, 'getprop ro.product.manufacturer; getprop persist.security.adbinput', { timeout: 4000 });
    const [maker, on] = (r.out || '').trim().split(/\s+/);
    const blocked = /xiaomi|redmi|poco/i.test(maker || '') && on === '0';
    if (blocked === this.inputBlocked) return;
    this.inputBlocked = blocked;
    if (blocked) this.emit('popup', 'home', INPUT_BLOCKED);
    this._tellPhone();
    this.emit('change');
  }

  _stopAll(message) {
    if (this.control) this.control.stop();
    this.control = null;
    if (this.kvm) this._kvmEnd(false);
    if (this.views) this.views.closeAll();
    this.serial = null;
    this._set('off', message);
  }

  // ---- setup ----

  _kick() {
    clearTimeout(this.kickTimer);
    this.kickTimer = setTimeout(() => this._poll(), 50);
  }

  // The phone's sound here on its own when Sound › receive is on (the screen window carries its own).
  _sound() {
    if (!this.views) return;
    const want = this.state === 'ready' && isPhone(this.server.current) && !!this.getSettings().audio.receive && !this.views.screenWithSound;
    this.views.sound(want);
  }

  async _poll() {
    this._sound();
    if (this.polling || !isPhone(this.server.current)) return;
    if (this.state === 'ready' && this.control && !this.control.closed) {
      const usb = this.wired && this.wired.serialOf(this.server.current.deviceId);
      if (usb && usb !== this.serial) {
        // The cable was plugged in: move onto it (windows opened from now on use it too).
        console.log(`[phone] moving onto the USB cable (${usb})`);
        this.control.stop();
        this.control = null;
      } else {
        // Watch for the switch going on (no restart needed).
        if (this.inputBlocked && this.serial) await this._checkInput(this.serial).catch(() => {});
        return;
      }
    }
    this.polling = true;
    try {
      await this._step();
    } catch (e) {
      console.log(`[phone] ${e.message}`);
      this._set('error', e.message);
    } finally {
      this.polling = false;
    }
  }

  async _step() {
    if (!this.adb.available) return this._set('missing', 'adb or the scrcpy server is missing from this build.');
    const a = this.phone.adb;
    if (!a) return this._set('connecting', 'Waiting for the phone…');
    const address = a.address || (this.server.current && this.server.current.address);
    const ready = await this._findDevice(address);
    if (ready) {
      this._known(true);
      this.serial = ready;
      await this._setup(ready);
      await this._checkInput(ready);
      return this._startControl();
    }
    if (!a.wifi) {
      if (a.canEnable) {
        this.server.sendToClient({ t: T.ADB_ENABLE, on: true });
        return this._set('connecting', 'Turning on wireless debugging…');
      }
      return this._set('waitingWifi', a.devOptions ? 'Turn on USB debugging and Wireless debugging on the phone (both).' : 'Turn on Developer options, then USB debugging and Wireless debugging on the phone (both).');
    }
    // Wireless debugging is on: connect where it listens. The phone tells us its port (it finds
    // itself over mDNS), our own mDNS may see it, and the port that worked last time is worth a try.
    // It moves to a new port every time it's switched on, and mDNS misses phones often (MIUI,
    // One UI), so a refused or unseen port only means "not yet": only adb's "failed to
    // authenticate", or a phone never reached, asks for the pairing code again.
    await this._dropStale(address);
    const services = await this.adb.mdns();
    const seen = services.filter((s) => s.type === 'connect' && s.address === address).map((s) => s.port);
    const ports = [...new Set([a.port, ...seen, this.lastPort.get(address)])].filter((n) => n > 0 && n < 65536);
    let unpaired = false;
    for (const port of ports) {
      const r = await this.adb.connect(address, port);
      if (r.ok && await this._findDevice(address)) {
        this.lastPort.set(address, port);
        this.misses = 0;
        return this._kick();
      }
      if (/authenticat|unauthorized/i.test(r.text)) unpaired = true;
    }
    // Just paired: the pairing screen can linger in mDNS caches for a while; it's connecting now.
    const justPaired = Date.now() - (this.pairedAt || 0) < 60000;
    this.pairing = justPaired ? null : services.find((s) => s.type === 'pairing' && s.address === address) || null;
    this.misses++;
    // Paired before (this phone reached us since TwinDesk started): keep looking, with the code
    // field there in case its pairing really was removed.
    if (unpaired) this._known(false);
    const known = !unpaired && this.known.has(this.server.current.deviceId);
    if (!unpaired && !this.pairing && (known || this.lastPort.has(address) || this.misses < 5)) {
      this.canPair = this.misses >= 5; // the code field (here and on the phone), in case its pairing really is gone
      return this._set('connecting', this.canPair
        ? 'Can’t reach the phone’s wireless debugging. Check it’s on (same Wi-Fi), or pair again if it was reset.'
        : 'Looking for the phone’s wireless debugging…');
    }
    this._set('needsPair', unpaired ? 'Pair this PC with the phone once: on the phone, Wireless debugging › Pair device with pairing code.'
      : this.pairing ? 'Type the code the phone shows.'
        : 'On the phone: Settings › Developer options › Wireless debugging › Pair device with pairing code.');
  }

  _known(on) {
    const id = this.server.current && this.server.current.deviceId;
    if (!id || this.known.has(id) === on) return;
    if (on) this.known.add(id);
    else this.known.delete(id);
    try {
      fs.writeFileSync(knownFile(), JSON.stringify([...this.known]));
    } catch {}
  }

  // Old connections to this phone's earlier ports linger as "offline" and get in the way.
  async _dropStale(address) {
    for (const d of await this.adb.devices()) {
      if (d.state !== 'device' && d.serial.startsWith(`${address}:`)) await this.adb.disconnect(d.serial);
    }
  }

  async _findDevice(address) {
    const list = await this.adb.devices();
    // On the USB cable (wired.js knows which device it is): that one, Wi-Fi or not.
    const usb = this.wired && this.server.current && this.wired.serialOf(this.server.current.deviceId);
    if (usb && list.some((x) => x.serial === usb && x.state === 'device')) return usb;
    const d = (address && list.find((x) => x.state === 'device' && x.serial.startsWith(`${address}:`)))
      || (address && list.find((x) => x.state === 'device' && x.serial.includes(address)))
      || (process.env.TWINDESK_ADB_SERIAL && list.find((x) => x.serial === process.env.TWINDESK_ADB_SERIAL && x.state === 'device'));
    if (d) return d.serial;
    // Plugged in with a USB cable: the same phone if its Wi-Fi address is the one on the link.
    for (const x of list.filter((y) => y.state === 'device' && !/[:]/.test(y.serial) && !y.serial.startsWith('emulator-'))) {
      const r = await this.adb.shell(x.serial, 'ip -4 addr show wlan0', { timeout: 4000 });
      if (address && new RegExp(`inet ${address.replace(/\./g, '\\.')}/`).test(r.out)) return x.serial;
    }
    return null;
  }

  // The code from "Pair device with pairing code" (and its address:port when mDNS can't see it).
  async pair(code, where) {
    code = String(code || '').replace(/\D/g, '');
    if (code.length !== 6) return this._set('needsPair', 'The pairing code has six digits.');
    let address, port;
    const m = /^([\d.]+):(\d+)$/.exec(String(where || '').trim());
    if (m) [address, port] = [m[1], Number(m[2])];
    else {
      const a = this.phone.adb || {};
      const services = await this.adb.mdns();
      const p = services.find((s) => s.type === 'pairing' && s.address === a.address) || this.pairing;
      if (!p) return this._set('needsPair', 'Can’t see the phone’s pairing code screen. Keep it open, or type its address and port.');
      [address, port] = [p.address, p.port];
    }
    this._set('connecting', 'Pairing…');
    const r = await this.adb.pair(address, port, code);
    if (!r.ok) return this._set('needsPair', `Pairing didn’t work (${r.text.split('\n').pop() || 'no answer'}). Try a new code.`);
    this.pairedAt = Date.now();
    this.misses = 0;
    this._known(true);
    this._set('connecting', 'Paired. Connecting…');
    setTimeout(() => this._kick(), 1000);
  }

  async _setup(serial) {
    if (this.setupDone.has(serial)) return;
    this._set('connecting', 'Setting up the phone…');
    const cmds = [
      `pm grant ${APP_ID} android.permission.WRITE_SECURE_SETTINGS`,
      // Android forgets a computer's pairing after 7 days without a connection; 0 keeps it.
      'settings put global adb_allowed_connection_time 0',
      `pm grant ${APP_ID} android.permission.POST_NOTIFICATIONS`,
      `appops set ${APP_ID} SYSTEM_ALERT_WINDOW allow`,
      `cmd notification allow_listener ${APP_ID}/${APP_ID}.NotifListener`,
      `dumpsys deviceidle whitelist +${APP_ID}`,
      `appops set ${APP_ID} RUN_ANY_IN_BACKGROUND allow`,
    ];
    if (this.getSettings().phone && this.getSettings().phone.wallpaper !== false) cmds.push(`appops set ${APP_ID} MANAGE_EXTERNAL_STORAGE allow`);
    for (const c of cmds) await this.adb.shell(serial, c, { timeout: 8000 });
    this.setupDone.add(serial);
    setTimeout(() => this.server.sendToClient({ t: T.PHONE_APPS_LIST }), 500);
  }

  async _startControl() {
    if (this.control && !this.control.closed) return this._set('ready');
    this._set('connecting', 'Connecting to the phone’s screen…');
    const s = new Session(this.adb, this.serial, { video: false, audio: false, control: true, clipboardAutosync: true });
    s.on('clipboard', (text) => this._phoneCopied(text));
    s.on('closed', (why) => {
      if (this.control !== s) return;
      this.control = null;
      if (this.kvm) this._kvmEnd(true);
      this._set('error', `The phone connection stopped (${why}).`);
      setTimeout(() => this._kick(), 2000);
    });
    await s.start();
    this.control = s;
    this._set('ready');
  }

  // The phone copied something (scrcpy sees it even with TwinDesk in the background): it goes
  // through this PC's clipboard rules as if the app had sent it.
  _phoneCopied(text) {
    if (!text || typeof text !== 'string') return;
    if (text === this.lastPhoneClip) return;
    this.lastPhoneClip = text;
    this.server.inject({ t: T.CLIP, text });
  }

  // Install the full build over the phone's TwinDesk: settings and pairing stay (same app, same
  // signature). The app restarts, so we grant notification access, open it and invite it back.
  async installFull() {
    const apk = fullApk();
    const c = this.server.current;
    if (!this.serial || !isPhone(c)) return this._install('failed', 'Set up wireless debugging first.');
    if (!apk) return this._install('failed', 'This build of TwinDesk doesn’t carry the Android app.');
    const id = c.deviceId;
    const serial = this.serial;
    this._install('installing', `Installing on ${c.name}…`);
    const r = await this.adb.run(['-s', serial, 'install', '-r', apk], { timeout: 180000 });
    const text = `${r.out}${r.err}`.trim();
    if (!/Success/.test(text)) {
      const why = /INSTALL_FAILED_USER_RESTRICTED/.test(text) ? 'The phone refused: allow “Install via USB” in Developer options (Xiaomi), then try again.'
        : (text.split('\n').pop() || 'no answer');
      return this._install('failed', `Couldn’t install (${why})`);
    }
    await this.adb.shell(serial, `cmd notification allow_listener ${APP_ID}/${APP_ID}.NotifListener`, { timeout: 8000 });
    await this.adb.shell(serial, `am start -n ${APP_ID}/.MainActivity`, { timeout: 8000 });
    this._install('done', 'Installed. The phone’s notifications can show here now.');
    setTimeout(() => this.phone.connect(id), 3000); // the app restarted: ask it to come back
  }

  _install(state, message) {
    this.install = { state, message };
    this.emit('change');
    if (state !== 'installing') this.emit('popup', state === 'done' ? 'driven' : 'home', message);
  }

  // ---- this PC's mouse and keyboard on the phone (Kvm drives us) ----

  // True when the device Kvm is driving (id) is the phone this bridge serves; without an id, when a phone is connected.
  drives(id) {
    const c = this.server.current;
    return isPhone(c) && (id === undefined || id === null || c.deviceId === id);
  }

  _display() {
    const info = this.phone.info;
    return info && info.display;
  }

  handle(m) {
    switch (m.t) {
      case T.KVM_TAKE: return this._take(m);
      case T.KVM_RELEASE: return this._kvmEnd(false);
      case T.K_MOVE: return this._move(m);
      case T.K_DOWN: case T.K_UP: return this._button(m);
      case T.K_WHEEL: return this._wheel(m);
      case T.K_KEY_DOWN: case T.K_KEY_UP: return this._key(m);
      case T.K_GESTURE: return this._gesture(m);
      default: break;
    }
  }

  _take(m) {
    const d = this._display();
    if (!this.control || this.control.closed || !d) {
      setImmediate(() => this.server.inject({ t: T.KVM_REFUSE, route: m.route, why: P.REFUSE.NOT_ALLOWED }));
      this.emit('popup', 'home', this.state === 'ready' ? 'The phone isn’t ready yet' : 'Set up wireless debugging on the Phone page first');
      return;
    }
    const off = Math.max(0, Math.min(1, Number(m.offset) || 0.5));
    const side = m.side || 'left';
    const x = side === 'left' ? 0 : side === 'right' ? d.w - 1 : off * (d.w - 1);
    const y = side === 'top' ? 0 : side === 'bottom' ? d.h - 1 : off * (d.h - 1);
    this.kvm = { route: m.route, x, y, side, push: 0, buttons: 0, mouse: m.mouse !== false };
    this.keys.clear();
    if (this.inputBlocked) this.emit('popup', 'home', INPUT_BLOCKED);
    // Answer after Kvm's _take returns: it starts its "no answer" timer right after sending kvm.take.
    setImmediate(() => this.server.inject({ t: T.KVM_ACCEPT, route: m.route }));
    this._hover();
    this.emit('change');
  }

  // The pointer is where we say; the app draws it there.
  _pointer(on) {
    const k = this.kvm;
    const now = Date.now();
    if (on && now - (this.lastPointer || 0) < 8) {
      clearTimeout(this.pointerTimer);
      this.pointerTimer = setTimeout(() => this._pointer(true), 8);
      return;
    }
    this.lastPointer = now;
    this.server.sendToClient(on && k ? { t: T.PHONE_POINTER, on: true, x: Math.round(k.x), y: Math.round(k.y) } : { t: T.PHONE_POINTER, on: false });
  }

  _hover() {
    const k = this.kvm;
    const d = this._display();
    if (!k || !d || !this.control) return;
    if (k.buttons) this.control.mouse(ACTION.MOVE, k.x, k.y, d.w, d.h, 0, k.buttons);
    else this.control.mouse(ACTION.HOVER_MOVE, k.x, k.y, d.w, d.h, 0, 0);
    this._pointer(true);
  }

  _move(m) {
    const k = this.kvm;
    const d = this._display();
    if (!k || !d || !k.mouse) return;
    const cfg = this.getSettings().kvm;
    const scale = Math.max(1, Math.min(3.5, (d.dpi || 420) / 160)) * (cfg.speed || 1);
    const dx = (Number(m.dx) || 0) * scale;
    const dy = (Number(m.dy) || 0) * scale;
    // Back over the edge toward this PC (after a little push, the resistance).
    const back = { left: [dx, k.x <= 0, -1], right: [dx, k.x >= d.w - 1, 1], top: [dy, k.y <= 0, -1], bottom: [dy, k.y >= d.h - 1, 1] }[k.side];
    if (back && back[1] && Math.sign(back[0]) === back[2]) {
      k.push += Math.abs(back[0]);
      if (k.push > Math.max(8, (cfg.resistancePx ?? P.RESISTANCE_PX) / 3)) {
        return this._goHome();
      }
    } else k.push = 0;
    k.x = Math.max(0, Math.min(d.w - 1, k.x + dx));
    k.y = Math.max(0, Math.min(d.h - 1, k.y + dy));
    this._hover();
  }

  _goHome() {
    const k = this.kvm;
    const d = this._display();
    if (!k) return;
    const offset = k.side === 'left' || k.side === 'right' ? k.y / Math.max(1, d.h - 1) : k.x / Math.max(1, d.w - 1);
    const route = k.route;
    this._kvmEnd(false);
    this.server.inject({ t: T.KVM_HOME, route, offset });
  }

  _kvmEnd(tellKvm) {
    const k = this.kvm;
    if (!k) return;
    const d = this._display();
    if (k.buttons && d && this.control) this.control.mouse(ACTION.UP, k.x, k.y, d.w, d.h, k.buttons, 0);
    for (const code of [...this.keys.held]) this._key({ t: T.K_KEY_UP, code });
    this.kvm = null;
    clearTimeout(this.pointerTimer);
    this._pointer(false);
    if (tellKvm) this.server.inject({ t: T.KVM_HOME, route: k.route });
    this.emit('change');
  }

  _button(m) {
    const k = this.kvm;
    const d = this._display();
    if (!k || !d || !this.control) return;
    const down = m.t === T.K_DOWN;
    const b = Number(m.b) | 0;
    // Like scrcpy: right = Back, middle = Home; left (and the side buttons) are the mouse's.
    if (b === 1) return this.control.backOrScreenOn(down ? ACTION.DOWN : ACTION.UP);
    if (b === 2) return void (down && this.control.tap(ANDROID.HOME));
    if (b === 3) return void (down && this.control.tap(ANDROID.BACK));
    const bit = BUTTON[b] || 1;
    if (down) k.buttons |= bit;
    else k.buttons &= ~bit;
    this.control.mouse(down ? ACTION.DOWN : ACTION.UP, k.x, k.y, d.w, d.h, bit, k.buttons);
  }

  _wheel(m) {
    const k = this.kvm;
    const d = this._display();
    if (!k || !d || !this.control) return;
    const line = m.mode === 'line';
    const rev = this.getSettings().kvm.reverseScroll ? -1 : 1;
    const hs = (-(Number(m.dx) || 0) / (line ? 1 : 40)) * rev;
    const vs = (-(Number(m.dy) || 0) / (line ? 1 : 40)) * rev;
    if (hs || vs) this.control.scroll(k.x, k.y, d.w, d.h, hs, vs, k.buttons);
  }

  _key(m) {
    if (!this.kvm || !this.control || typeof m.code !== 'string') return;
    const swap = this.server.keySwap(this.getSettings());
    const code = swap ? P.mapKeyFromOtherPlatform(m.code) : m.code;
    const down = m.t === T.K_KEY_DOWN;
    const e = this.keys.event(code, down);
    if (e) this.control.key(down ? ACTION.DOWN : ACTION.UP, e.keycode, e.meta);
  }

  _gesture(m) {
    if (!this.control || m.phase === 'begin' || m.phase === 'change') return;
    const key = { back: ANDROID.BACK, overview: ANDROID.APP_SWITCH, appWindows: ANDROID.APP_SWITCH, desktop: ANDROID.HOME, launcher: ANDROID.ALL_APPS }[m.g];
    if (key) this.control.tap(key);
  }

  // ---- windows (phoneview.js) ----

  // Options for a new screen/app session, from settings.
  sessionOpts(kind, extra = {}) {
    const ph = this.getSettings().phone || {};
    const base = { video: true, control: true, maxFps: 60, videoBitRate: (ph.bitrateMbps || 8) * 1000000 };
    if (kind === 'screen') return { ...base, audio: !!ph.sound, maxSize: ph.maxSize || 0, stayAwake: true, ...extra };
    return { ...base, audio: false, flex: true, ...extra };
  }

  setupView() {
    return { state: this.state, message: this.message, pairing: !!this.pairing };
  }
}

module.exports = { PhoneBridge };

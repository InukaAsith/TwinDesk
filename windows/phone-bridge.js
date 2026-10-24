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
const { PhoneInput } = require('../shared/phoneinput.js');

const T = P.T;
const APP_ID = 'com.twindesk.android';
const POLL_MS = 3000;
// adb's older TCP mode: unlike wireless debugging it doesn't need a Wi-Fi network (Android switches
// wireless debugging off on a Wi-Fi Direct link), and stays on until the phone restarts.
const TCPIP_PORT = 5555;
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
    // Without wireless debugging: the phone applies the input itself (shared/phoneinput.js), when
    // it says it can (phone.input {on}).
    this.input = new PhoneInput((m) => this.server.sendToClient(m));
    this.phoneInput = false;
    this.kvm = null; // the pointer while this PC drives the phone: {route, x, y, push}
    this.keys = new KeyState();
    this.views = null; // phoneview.js sets this
    this.setupDone = new Set(); // serials granted this run
    this.tcpipDone = new Set(); // serials whose TCP mode was checked this run
    this.lastPort = new Map(); // phone address -> the wireless debugging port that last worked
    this.misses = 0; // tries in a row that found no way in
    // Phones (by id) adb has reached before. Android keeps the computer's key (Settings lists it),
    // so not finding one again (wireless debugging back on, at a new port, after a screen lock on
    // MIUI) is "not yet", never "pair again": only adb refusing the key asks for a code. Kept
    // across restarts.
    this.known = new Set(readJson(knownFile(), []));
    server.on(`t:${T.PHONE_INPUT}`, (m, ctx) => {
      if (!isPhone(ctx)) return;
      this.phoneInput = m.on === true;
      // The phone's choice of input (changed there, or on connecting): the same setting here.
      const ph = this.getSettings().phone;
      if ((m.via === 'adb' || m.via === 'phone') && ph && (ph.input !== m.via || !ph.inputPicked)) { // 'auto' there: as it is here
        ph.input = m.via;
        ph.inputPicked = true;
        this.emit('save');
      }
      this.emit('change');
    });
    server.on('closed', () => { this.phoneInput = false; });
    this.canPair = false; // still looking, but the code field shows (its pairing may be gone)
    this.inputBlocked = false; // Xiaomi with “USB debugging (Security settings)” off: touches and keys are refused
    this.wired = null; // wired.js: the phone on the USB cable
    this.install = null; // {state: 'installing'|'done'|'failed', message} for the full build

    phone.on('adb', () => this._kick());
    // The pairing code typed on the phone (its guide's notification), with its pairing port.
    server.on(`t:${T.ADB_PAIR}`, (m, ctx) => {
      if (!isPhone(ctx)) return;
      const port = Number(m.port) | 0;
      const address = this.adbAddress();
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
    // The phone's sound without wireless debugging (Sound.kt there): asked for while adb can't carry
    // it; what comes plays in a hidden window (phoneview.js netSound).
    this.netSound = { asked: false, on: false, waiting: false, error: '' };
    const soundReset = () => Object.assign(this.netSound, { asked: false, on: false, waiting: false, error: '' });
    server.on(`t:${T.PHONE_SOUND_STATE}`, (m, ctx) => {
      if (!isPhone(ctx)) return;
      Object.assign(this.netSound, { on: m.on === true, waiting: m.waiting === true, error: typeof m.error === 'string' ? m.error.slice(0, 200) : '' });
      this.emit('change');
    });
    server.on(`t:${T.PHONE_SOUND}`, (m, ctx) => isPhone(ctx) && this.netSound.asked && this.views && this.views.netAudio(m));
    server.on('client', () => { soundReset(); this._sound(); });
    server.on('closed', () => { if (!isPhone(server.current)) soundReset(); this._sound(); });
    server.on('transport', () => this._sound());
    setInterval(() => this._poll(), POLL_MS);
  }

  get view() {
    return {
      state: this.state, message: this.message, serial: this.serial, available: this.adb.available, canPair: this.canPair, inputBlocked: this.inputBlocked,
      via: this.via, // 'usb' | 'wifi' | null: how adb reaches the phone
      input: this.inputVia, inputMode: this.inputMode, // the mouse and keyboard: what they go through now, and the choice
      control: !!(this.control && !this.control.closed), driving: !!this.kvm,
      install: this.install, fullApk: !!fullApk(),
      windows: this.views ? this.views.list() : [],
      // the phone's sound without adb: asked for, playing, waiting for Start on the phone, or why not
      sound: { net: this.netSound.asked, on: this.netSound.on, waiting: this.netSound.waiting, error: this.netSound.error },
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

  // The phone's sound here when Sound › receive is on (the screen window carries its own): through
  // adb once it's ready, else captured by the phone (Start there), which then stays until it stops.
  // Not through Bluetooth: too much for it.
  _sound() {
    if (!this.views) return;
    const c = this.server.current;
    const want = isPhone(c) && !!this.getSettings().audio.receive && !this.views.screenWithSound;
    const adb = this.state === 'ready';
    const net = want && (!adb || this.netSound.on) && c.transport !== 'ble';
    this.views.sound(want && adb && !net);
    if (net !== this.netSound.asked) {
      this.netSound.asked = net;
      if (!net) Object.assign(this.netSound, { on: false, waiting: false, error: '' });
      if (isPhone(c)) this.server.sendToClient({ t: T.PHONE_SOUND_WANT, on: net });
      this.emit('change');
    }
    this.views.netSound(net);
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
    const address = this.adbAddress();
    const ready = await this._findDevice(address);
    if (ready) {
      this._known(true);
      this.serial = ready;
      await this._setup(ready);
      if (await this._tcpip(ready)) return; // adbd restarts: found again on the next poll
      await this._checkInput(ready);
      return this._startControl();
    }
    // TCP mode, switched on the last time we were in (USB cable or wireless debugging): works on a
    // direct Wi-Fi link too, where wireless debugging can't (though its switch may still say on).
    // Only at the session's own network address: on Bluetooth or the cable that's 127.0.0.1, where
    // port 5555 is this computer's Android emulator, and the phone's Wi-Fi address is out of reach.
    const c = this.server.current;
    const sessionIp = c && c.transport !== 'ble' && c.address && !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(c.address) ? c.address.replace(/^::ffff:/, '') : '';
    if (sessionIp && sessionIp === address) {
      const serial = `${address}:${TCPIP_PORT}`;
      const r = await this.adb.connect(address, TCPIP_PORT);
      if (r.ok && await this._findDevice(address)) return this._kick();
      // Not allowed yet ("failed to authenticate", kept as unauthorized): the phone asks; keep that connection.
      if ((await this.adb.devices()).some((d) => d.serial === serial && d.state === 'unauthorized')) {
        return this._set('waitingWifi', 'Tap Allow on the phone (“Allow USB debugging?”).');
      }
      if (r.ok) await this.adb.disconnect(serial);
    }
    // A direct Wi-Fi link without a Wi-Fi network on the phone: wireless debugging can’t come on. (On
    // its own Wi-Fi as well it can, reached at the session's address; older apps don't say: the address.)
    const direct = a.net === false || (!a.wifi && /^192\.168\.(49|137)\./.test(address));
    if (!a.wifi || direct) {
      if (a.canEnable) this.server.sendToClient({ t: T.ADB_ENABLE, on: true }); // also refreshes adb.state
      if (a.canEnable && !direct) return this._set('connecting', 'Turning on wireless debugging…');
      // Android keeps wireless debugging off without a Wi-Fi network: a Wi-Fi Direct group isn't one.
      if (direct) return this._set('waitingWifi', 'On a direct Wi-Fi link the phone can’t turn wireless debugging on (it needs a Wi-Fi network). Connect it once by USB cable or on the same Wi-Fi, and it works here too until the phone restarts. Meanwhile the mouse and keyboard work through Accessibility.');
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
      const p = services.find((s) => s.type === 'pairing' && (s.address === a.address || s.address === this.adbAddress())) || this.pairing;
      if (!p) return this._set('needsPair', 'Can’t see the phone’s pairing code screen. Keep it open, or type its address and port.');
      [address, port] = [this.adbAddress() || p.address, p.port];
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

  // TCP mode on (once per phone restart), for a direct Wi-Fi link later. True: adbd restarts now.
  // On the USB cable wired.js has done it before the session moved onto it (here it would restart adbd under it).
  async _tcpip(serial) {
    if (this.tcpipDone.has(serial) || !serial.includes(':')) return false;
    this.tcpipDone.add(serial);
    const r = await this.adb.shell(serial, 'getprop service.adb.tcp.port', { timeout: 4000 });
    if (r.out.trim() === String(TCPIP_PORT)) return false;
    this._set('connecting', 'Setting up the phone for Wi-Fi Direct…');
    await this.adb.run(['-s', serial, 'tcpip', String(TCPIP_PORT)], { timeout: 8000 });
    setTimeout(() => this._kick(), 2000);
    return true;
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

  drives() {
    return isPhone(this.server.current);
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

  // Where the Mac's input goes: wireless debugging (scrcpy), else the phone itself.
  // Where the phone's wireless debugging is reached: the session's own address while it's on a
  // network (on a direct Wi-Fi link the Wi-Fi address the phone reports is on another network,
  // or it has none), else that one (the session on the cable or Bluetooth, 127.0.0.1).
  adbAddress() {
    const c = this.server.current;
    const a = this.phone.adb || {};
    const onNet = c && c.address && c.address !== '127.0.0.1' && c.address !== '::1' && c.transport !== 'ble';
    return (onNet ? c.address.replace(/^::ffff:/, '') : '') || a.address || (c && c.address) || '';
  }

  // settings.phone.input 'phone': always the phone itself (its Accessibility service), on Wi-Fi too.
  get ctl() {
    if (!this.viaPhone && this.control && !this.control.closed) return this.control;
    return this.phoneInput ? this.input : null;
  }

  // The input choice changed here: to the phone, so its toggle shows the same.
  tellVia() {
    if (isPhone(this.server.current)) this.server.sendToClient({ t: T.PHONE_INPUT_VIA, via: this.inputMode });
  }

  get viaPhone() {
    return (this.getSettings().phone || {}).input === 'phone';
  }

  // 'auto' until one is picked (here or on the phone): ADB once wireless debugging is ready, else
  // Accessibility, whose permission the phone asks for only then. An 'adb' saved before it could
  // be picked is 'auto'.
  get inputMode() {
    const ph = this.getSettings().phone || {};
    return ph.input === 'phone' ? 'phone' : ph.input === 'adb' && ph.inputPicked ? 'adb' : 'auto';
  }

  // What the mouse and keyboard go through now, for the window's toggle.
  get inputVia() {
    const m = this.inputMode;
    return m === 'auto' ? (this.state === 'ready' ? 'adb' : 'phone') : m;
  }

  _take(m) {
    const d = this._display();
    if (!this.ctl || !d) {
      setImmediate(() => this.server.inject({ t: T.KVM_REFUSE, route: m.route, why: P.REFUSE.NOT_ALLOWED }));
      if (d && (this.viaPhone || (this.state !== 'ready' && this.inputMode !== 'adb'))) { // no wireless debugging (Bluetooth), or chosen: the phone does it itself, once allowed
        this.server.sendToClient({ t: T.PHONE_INPUT_ASK });
        this.emit('popup', 'home', 'On the phone, allow TwinDesk to control it (the notification there)');
      } else {
        this.emit('popup', 'home', this.state === 'ready' ? 'The phone isn’t ready yet' : 'Set up wireless debugging on the Phone page first');
      }
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
    const gap = this.ctl === this.input ? 40 : 8; // through the session (maybe Bluetooth): fewer
    if (on && now - (this.lastPointer || 0) < gap) {
      clearTimeout(this.pointerTimer);
      this.pointerTimer = setTimeout(() => this._pointer(true), gap);
      return;
    }
    this.lastPointer = now;
    this.server.sendToClient(on && k ? { t: T.PHONE_POINTER, on: true, x: Math.round(k.x), y: Math.round(k.y) } : { t: T.PHONE_POINTER, on: false });
  }

  _hover() {
    const k = this.kvm;
    const d = this._display();
    if (!k || !d || !this.ctl) return;
    if (k.buttons) this.ctl.mouse(ACTION.MOVE, k.x, k.y, d.w, d.h, 0, k.buttons);
    else this.ctl.mouse(ACTION.HOVER_MOVE, k.x, k.y, d.w, d.h, 0, 0);
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
    if (k.buttons && d && this.ctl) this.ctl.mouse(ACTION.UP, k.x, k.y, d.w, d.h, k.buttons, 0);
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
    if (!k || !d || !this.ctl) return;
    const down = m.t === T.K_DOWN;
    const b = Number(m.b) | 0;
    // Like scrcpy: right = Back, middle = Home; left (and the side buttons) are the mouse's.
    if (b === 1) return this.ctl.backOrScreenOn(down ? ACTION.DOWN : ACTION.UP);
    if (b === 2) return void (down && this.ctl.tap(ANDROID.HOME));
    if (b === 3) return void (down && this.ctl.tap(ANDROID.BACK));
    const bit = BUTTON[b] || 1;
    if (down) k.buttons |= bit;
    else k.buttons &= ~bit;
    this.ctl.mouse(down ? ACTION.DOWN : ACTION.UP, k.x, k.y, d.w, d.h, bit, k.buttons);
  }

  _wheel(m) {
    const k = this.kvm;
    const d = this._display();
    if (!k || !d || !this.ctl) return;
    const line = m.mode === 'line';
    const rev = this.getSettings().kvm.reverseScroll ? -1 : 1;
    const hs = (-(Number(m.dx) || 0) / (line ? 1 : 40)) * rev;
    const vs = (-(Number(m.dy) || 0) / (line ? 1 : 40)) * rev;
    if (hs || vs) this.ctl.scroll(k.x, k.y, d.w, d.h, hs, vs, k.buttons);
  }

  _key(m) {
    if (!this.kvm || !this.ctl || typeof m.code !== 'string') return;
    const swap = this.server.keySwap(this.getSettings());
    const code = swap ? P.mapKeyFromOtherPlatform(m.code) : m.code;
    const down = m.t === T.K_KEY_DOWN;
    const e = this.keys.event(code, down);
    if (e) this.ctl.key(down ? ACTION.DOWN : ACTION.UP, e.keycode, e.meta);
  }

  _gesture(m) {
    if (!this.ctl || m.phase === 'begin' || m.phase === 'change') return;
    const key = { back: ANDROID.BACK, overview: ANDROID.APP_SWITCH, appWindows: ANDROID.APP_SWITCH, desktop: ANDROID.HOME, launcher: ANDROID.ALL_APPS }[m.g];
    if (key) this.ctl.tap(key);
  }

  // ---- windows (phoneview.js) ----

  // Options for a new screen/app/camera session, from settings.
  sessionOpts(kind, extra = {}) {
    const ph = this.getSettings().phone || {};
    const base = { video: true, control: true, maxFps: 60, videoBitRate: (ph.bitrateMbps || 8) * 1000000 };
    if (kind === 'camera') return { ...base, audio: false, stayAwake: true, flex: false, ...extra };
    if (kind === 'screen') return { ...base, audio: !!ph.sound, maxSize: ph.maxSize || 0, stayAwake: true, ...extra };
    return { ...base, audio: false, flex: true, ...extra };
  }

  async listCameras() {
    if (!this.serial || this.state !== 'ready') return [];
    try {
      const { Session } = require('./scrcpy');
      return await Session.listCameras(this.adb, this.serial);
    } catch (e) {
      console.log('[phone-bridge] listCameras failed:', e && e.message);
      return [];
    }
  }

  setupView() {
    return { state: this.state, message: this.message, pairing: !!this.pairing };
  }
}

module.exports = { PhoneBridge };

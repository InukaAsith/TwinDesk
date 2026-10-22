// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone as the peer: which paired phones are nearby (the sidebar tile), connecting one on
// purpose (it takes the session from the computer), letting it go, and what it tells about
// itself (phone.info, adb.state, phone.apps). The screen, input and app windows go through the
// adb bridge (phone-bridge.js), which this hub starts while a phone is connected. Port of
// windows/phone.js: server is phone-link.js, raw our server.js.
//
// Events: 'change' — this.view changed.
'use strict';

const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');

const T = P.T;
const CONNECT_WAIT_MS = 8000; // an invited phone that doesn't say hello by then isn't coming
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const isPhone = (ctx) => !!ctx && ctx.os === P.OS.ANDROID;

class Phone extends EventEmitter {
  constructor({ server, raw, discovery, pairing }) {
    super();
    Object.assign(this, { server, raw, discovery, pairing });
    this.info = null; // phone.info
    this.adb = null; // adb.state
    this.apps = []; // phone.apps
    this.assets = 0; // bumps when the wallpaper or the app list changed (the window fetches them: assetsView)
    this.connecting = null; // {id, name, timer}
    this.message = '';
    this.bridge = null; // set by main.js
    this.wired = null; // wired.js: phones on a USB cable

    server.on('client', (ctx) => {
      if (!isPhone(ctx)) return;
      this._doneConnecting('');
      this.server.sendToClient({ t: T.PHONE_APPS_LIST });
      this.emit('change');
    });
    server.on('closed', (ctx) => {
      if (ctx && isPhone(ctx)) this._reset();
      else if (!this.connected) this._reset();
    });
    const on = (t, fn) => server.on(`t:${t}`, (m, ctx) => isPhone(ctx) && fn(m, ctx));
    on(T.PHONE_INFO, (m) => {
      const colors = Array.isArray(m.colors) ? m.colors.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 3) : [];
      const wallpaper = typeof m.wallpaper === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(m.wallpaper) && m.wallpaper.length < 400000 ? m.wallpaper : (this.info && this.info.wallpaper) || '';
      const prev = this.info;
      const display = m.display && Number.isInteger(m.display.w) && Number.isInteger(m.display.h)
        ? { w: m.display.w, h: m.display.h, rot: m.display.rot | 0, dpi: m.display.dpi | 0 } : null;
      this.info = {
        model: str(m.model, 80), maker: str(m.maker, 40), release: str(m.release, 20), sdk: m.sdk | 0,
        battery: Number.isFinite(m.battery) ? Math.max(0, Math.min(100, Math.round(m.battery))) : null,
        charging: !!m.charging, colors, wallpaper, display,
      };
      if (wallpaper !== ((prev && prev.wallpaper) || '')) this.assets++;
      this.emit('info', this.info);
      this.emit('change');
    });
    on(T.ADB_STATE, (m) => {
      // full: the build with notification access; net: on a Wi-Fi network, without which Android keeps
      // wireless debugging off. Older apps said neither (they all had notification access).
      this.adb = { devOptions: !!m.devOptions, wifi: !!m.wifi, canEnable: !!m.canEnable, address: str(m.address, 64), full: m.full !== false, port: Number(m.port) | 0, net: m.net !== false };
      this.emit('adb', this.adb);
      this.emit('change');
    });
    on(T.PHONE_APPS, (m) => {
      if (!Array.isArray(m.apps)) return;
      this.apps = m.apps.slice(0, 2000).filter((a) => a && typeof a.id === 'string' && /^[\w.]{1,200}$/.test(a.id)).map((a) => ({
        id: a.id, name: str(a.name, 100) || a.id,
        icon: typeof a.icon === 'string' && a.icon.startsWith('data:image/png;base64,') && a.icon.length < 60000 ? a.icon : '',
      })).sort((a, b) => a.name.localeCompare(b.name));
      this.assets++;
      this.emit('change');
    });
  }

  get connected() {
    return isPhone(this.server.phone || this.server.current);
  }

  // Paired phones that discovery sees right now, plus the connected one.
  nearby() {
    const paired = new Map(this.pairing.list().filter((p) => p.os === P.OS.ANDROID).map((p) => [p.id, p]));
    const out = [];
    const c = this.server.phone || (isPhone(this.server.current) ? this.server.current : null);
    if (isPhone(c)) out.push({ id: c.deviceId, name: c.name, connected: true, usb: !!c.ice });
    // On the cable (it connected through it before): no Wi-Fi needed to show it.
    for (const id of this.wired ? this.wired.byDevice.keys() : []) {
      if (paired.has(id) && !out.some((x) => x.id === id)) out.push({ id, name: paired.get(id).name, connected: false, usb: true });
    }
    for (const d of this.discovery.list()) {
      if (d.os !== P.OS.ANDROID || !paired.has(d.id) || out.some((x) => x.id === d.id)) continue;
      out.push({ id: d.id, name: d.name || paired.get(d.id).name, address: d.address, connected: false });
    }
    return out;
  }

  // The tile was clicked: ask the phone to connect. Its hello takes the session from the computer.
  connect(id) {
    if (this.wired && !this.connected && this.wired.connect(String(id))) {
      const p = this.pairing.list().find((x) => x.id === String(id));
      clearTimeout(this.connecting && this.connecting.timer);
      this.connecting = { id: String(id), name: p ? p.name : 'The phone', timer: setTimeout(() => this._doneConnecting(`${p ? p.name : 'The phone'} didn’t answer. Open TwinDesk on it.`), CONNECT_WAIT_MS) };
      this.message = '';
      return this.emit('change');
    }
    const d = this.discovery.get(String(id)) || this.discovery.near(String(id)); // the network, else Bluetooth
    if (!d || d.os !== P.OS.ANDROID) return this._fail('That phone isn’t nearby any more.');
    if (this.connected && this.server.current.deviceId === d.id) return;
    clearTimeout(this.connecting && this.connecting.timer);
    this.connecting = { id: d.id, name: d.name, timer: setTimeout(() => this._doneConnecting(`${d.name} didn’t answer. Open TwinDesk on it.`), CONNECT_WAIT_MS) };
    this.message = '';
    this.discovery.invite(d.address);
    setTimeout(() => this.connecting && this.connecting.id === d.id && this.discovery.invite(d.address), 700); // UDP may drop one
    this.emit('change');
  }

  // Let the phone go: it won't resume, and the computer reconnects by itself.
  disconnect() {
    if (this.raw.current && this.raw.current.os === P.OS.ANDROID) this.raw.release();
    else this.raw.endPhoneGrace(); // dropped and waiting to resume: let it go too
  }

  _fail(message) {
    this.message = message;
    this.emit('change');
  }

  _doneConnecting(message) {
    if (!this.connecting && !message) return;
    clearTimeout(this.connecting && this.connecting.timer);
    this.connecting = null;
    this.message = message;
    this.emit('change');
  }

  _reset() {
    if (!this.info && !this.adb && !this.apps.length) return this.emit('change');
    this.info = null;
    this.adb = null;
    this.apps = [];
    this.assets++;
    this.emit('change');
  }

  // Big things the state push leaves out (it goes out every second): fetched when `assets` bumps.
  assetsView() {
    return { wallpaper: (this.info && this.info.wallpaper) || '', apps: this.apps };
  }

  get view() {
    const c = this.server.phone || (isPhone(this.server.current) ? this.server.current : null);
    return {
      nearby: this.nearby(),
      connected: isPhone(c) ? { id: c.deviceId, name: c.name, rttMs: c.rttMs, usb: !!c.ice } : null,
      connecting: this.connecting ? { id: this.connecting.id, name: this.connecting.name } : null,
      message: this.message,
      held: !isPhone(c) && this.raw.phoneHolds(), // the phone dropped and may come back
      info: this.info && { ...this.info, wallpaper: !!this.info.wallpaper },
      adb: this.adb,
      apps: this.apps.length,
      assets: this.assets,
      bridge: this.bridge ? this.bridge.view : null,
    };
  }
}

module.exports = { Phone };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This PC's Wi-Fi for a session through Bluetooth (shared/netlink.js): hosting a network the other
// side joins (Wi-Fi Direct's access point, in the helper: Wfd.cs), or joining the other side's (a
// phone's Wi-Fi Direct group, another PC's access point). Joining: a temporary profile, connect,
// wait for an address; leaving deletes the profile and goes back to the network this PC was on.
// Wi-Fi switched off in Windows is switched on for it, and off again after.
//
// netsh output is localized: only the SSID lines (never translated), interface GUIDs and the
// Location URI are read. Since Windows 11 24H2 Wi-Fi details need Location; netsh, in System32,
// never gets Windows' prompt for it and prints where to switch it on instead. Then the helper says
// which network this PC is on (Windows tells it that without Location), or a new address tells;
// should netsh refuse to add or connect, Location is asked for (the helper gets the prompt) and
// its settings open when that didn't do it.
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const JOIN_MS = 45000;
const LOCATION = 'ms-settings:privacy-location';

function netsh(args) {
  return new Promise((resolve, reject) => {
    execFile('netsh', ['wlan', ...args], { windowsHide: true, timeout: 15000 }, (err, out) => {
      if (String(out).includes(LOCATION)) reject(Object.assign(new Error('Location is off'), { location: true }));
      else if (err) reject(new Error(String(out || err.message).trim().split(/\r?\n/).pop() || 'netsh failed'));
      else resolve(String(out));
    });
  });
}

const esc = (s) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const hex = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// IPv4 addresses on the Wi-Fi adapters (on every adapter when none is named like one).
function addresses() {
  const all = [];
  const wifi = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      all.push(a.address);
      if (/wi-?fi|wlan|wireless/i.test(name)) wifi.push(a.address);
    }
  }
  return wifi.length ? wifi : all;
}

class Wifi {
  // helper: helper.js; onLocation(): netsh refused for want of Location (open its settings).
  constructor(helper, onLocation) {
    this.helper = helper;
    this.onLocation = onLocation;
    this.ok = false; // a Wi-Fi adapter exists
    this.hostOk = false; // … that does Wi-Fi Direct (hosts)
    this.joined = '';
    this.previous = '';
    this.refusedLocation = false; // the last join: netsh refused for want of Location
    this.holds = new Set(); // 'host', 'join': who needs Wi-Fi on
    this.wasOff = false; // … and it was off before
    this.radioQueue = Promise.resolve();
    netsh(['show', 'interfaces'])
      .then((out) => { this.ok = this.ok || /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(out); })
      .catch(() => {});
  }

  can() {
    return this.ok;
  }

  canHost() {
    return this.hostOk;
  }

  // What this PC can do, from the helper (Wi-Fi adapters come and go). True when it changed.
  async refresh() {
    const r = await this.helper.request('wfdCaps', {}, 15000);
    const was = `${this.ok} ${this.hostOk}`;
    if (r.wifi !== undefined) this.ok = !!r.wifi; // an older helper doesn't say
    this.hostOk = !!r.host;
    return was !== `${this.ok} ${this.hostOk}`;
  }

  async host(ssid, pass) {
    await this._hold('host');
    await this.helper.request('wfdHost', { ssid, pass }, 20000);
  }

  async unhost() {
    await this.helper.request('wfdStop', {}, 5000).catch(() => {});
    await this._release('host');
  }

  async join(ssid, pass) {
    this.refusedLocation = false;
    await this._hold('join');
    const now = await this._current();
    this.previous = now === ssid ? '' : now || '';
    const before = new Set(addresses());
    const xml = `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${esc(ssid)}</name>
  <SSIDConfig><SSID><hex>${hex(ssid)}</hex><name>${esc(ssid)}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM><security>
    <authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
    <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${esc(pass)}</keyMaterial></sharedKey>
  </security></MSM>
</WLANProfile>`;
    const file = path.join(os.tmpdir(), `twindesk-wifi-${process.pid}.xml`);
    fs.writeFileSync(file, xml, { mode: 0o600 });
    try {
      await this._netsh(['add', 'profile', `filename=${file}`, 'user=current']);
    } finally {
      fs.rmSync(file, { force: true });
    }
    this.joined = ssid;
    const until = Date.now() + JOIN_MS;
    let tries = 0;
    while (Date.now() < until) {
      // The network may not be in the scan list yet (a group that just came up): ask again.
      if (tries++ % 5 === 0) {
        const err = await this._netsh(['connect', `name=${ssid}`, `ssid=${ssid}`]).then(() => null, (e) => e);
        if (err && err.location) {
          await this.leave();
          throw err;
        }
      }
      await sleep(1000);
      const on = await this._current();
      // Nobody says which network: an address it didn't have before is the new one.
      const there = on === null ? addresses().some((a) => !before.has(a)) : on === ssid && this._hasAddress();
      if (there) {
        await sleep(1500); // DHCP done; let the route settle before discovery looks
        return;
      }
    }
    await this.leave();
    throw new Error('Windows didn’t connect to it');
  }

  _hasAddress() {
    let wifi = false;
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      if (!/wi-?fi|wlan|wireless/i.test(name)) continue;
      wifi = true;
      if ((list || []).some((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))) return true;
    }
    return !wifi; // a renamed adapter: connected is enough
  }

  async leave() {
    const ssid = this.joined;
    this.joined = '';
    if (ssid) {
      await netsh(['delete', 'profile', `name=${ssid}`]).catch(() => {});
      // Windows usually goes back by itself (auto-connect); asking makes it quick.
      if (this.previous) await netsh(['connect', `name=${this.previous}`]).catch(() => {});
      this.previous = '';
    }
    await this._release('join');
  }

  // The SSID the Wi-Fi is on now ('' = none, null = nobody can say).
  async _current() {
    try {
      const m = (await netsh(['show', 'interfaces'])).match(/^\s*SSID\s*:\s*(.+)$/m);
      return m ? m[1].trim() : '';
    } catch (e) {
      if (!e.location) return '';
    }
    const r = await this.helper.request('wfdSsid', {}, 5000).catch(() => ({}));
    return typeof r.ssid === 'string' ? r.ssid : null;
  }

  // netsh's Wi-Fi command; refused for want of Location: asked for once (Windows' prompt, to the
  // helper), else where to switch it on.
  async _netsh(args) {
    try {
      return await netsh(args);
    } catch (e) {
      if (!e.location) throw e;
    }
    const r = await this.helper.request('wfdLocation', {}, 30000).catch(() => ({}));
    if (r.status === 'allowed') {
      try {
        return await netsh(args);
      } catch (e) {
        if (!e.location) throw e;
      }
    }
    this.refusedLocation = true;
    if (this.onLocation) this.onLocation();
    throw Object.assign(new Error('Windows’ Location is off. Turn on Location services and “Let desktop apps access your location” in Settings › Privacy & security › Location'), { location: true });
  }

  // Wi-Fi on while hosting or joining, one change at a time (hosting can end while joining
  // starts); off again once neither needs it, when it was off.
  _hold(who) {
    return this._radio(async () => {
      if (this.holds.has(who)) return;
      if (!this.holds.size) {
        const r = await this.helper.request('wfdRadio', { on: true }, 15000).catch((e) => {
          if (/unknown cmd/.test(e.message)) return {}; // an older helper: Wi-Fi as it is
          throw e;
        });
        this.wasOff = r.was === 'off';
      }
      this.holds.add(who);
    });
  }

  _release(who) {
    return this._radio(async () => {
      if (!this.holds.delete(who) || this.holds.size || !this.wasOff) return;
      this.wasOff = false;
      await this.helper.request('wfdRadio', { on: false }, 15000).catch(() => {});
    });
  }

  _radio(fn) {
    const p = this.radioQueue.then(fn);
    this.radioQueue = p.catch(() => {});
    return p;
  }
}

module.exports = { Wifi };

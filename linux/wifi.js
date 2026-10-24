// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This computer's Wi-Fi for a session through Bluetooth (shared/netlink.js), through NetworkManager
// (nmcli; the Linux side of windows/wifi.js): hosting a network the other side joins (an access
// point with NetworkManager's shared IPv4, as Windows' Wi-Fi Direct access point), or joining the
// other side's (a phone's Wi-Fi Direct group or hotspot, another computer's access point).
// Joining: a temporary connection, up, and when it's done deleted and back to the network this
// computer was on. Wi-Fi switched off is switched on for it, and off again after.
//
// Hosting takes the Wi-Fi adapter: its network goes while we host and comes back after. Joining
// costs it too, so with a computer that only joins (a Mac) we host. Never for a phone: it joins
// through Android's Wi-Fi Direct API, which only reaches a Wi-Fi Direct group, never an access point
// like ours; it hosts its group (keeping its own Wi-Fi) and we join that: canHost(peerOs).
// An adapter that can be a station and an access point at once keeps its network: we host on a
// second interface beside it (on the same channel; made as twdap0, udev may rename it), made by twindesk-wifiap
// (linux-helper/wifiap), which needs CAP_NET_ADMIN: installed once as root through pkexec (the
// password prompt) the first time it's needed, or from General (setup). General's "Keep Wi-Fi
// while hosting" off (settings.net.keepWifi) leaves it alone. The same tool gives Bluetooth LE links
// this computer opens a 5 s supervision timeout instead of the kernel's 420 ms (bleTimeout).
// The connections are this user's (connection.permissions: no administrator prompt) and keep no
// password: it's handed to nmcli through a file only we can read (passwd-file), never argv.
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../shared/protocol.js');

const HOST = 'TwinDesk host';
const JOIN = 'TwinDesk link';
const JOIN_MS = 45000;
const TOOL = process.env.TWINDESK_WIFIAP
  || (fs.existsSync('/run/wrappers/bin/twindesk-wifiap') ? '/run/wrappers/bin/twindesk-wifiap' : '/usr/local/libexec/twindesk-wifiap');
const TOOL_VERSION = '3'; // linux-helper/wifiap/wifiap.c WIFIAP_VERSION: an older one installed is replaced
const TOOL_SRC = process.env.TWINDESK_WIFIAP_SRC || path.join(__dirname, '..', 'linux-helper', 'bin', 'twindesk-wifiap');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(file, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout }, (err, out, errOut) => {
      if (err) reject(Object.assign(new Error(String(errOut || err.message).trim().split('\n').pop()), { code: err.code }));
      else resolve(String(out).trim());
    });
  });
}

function nmcli(args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile('nmcli', args, { timeout, env: { ...process.env, LC_ALL: 'C' } }, (err, out, errOut) => {
      if (err) reject(new Error(String(errOut || out || err.message).trim().split('\n').pop().replace(/^Error:\s*/, '') || 'nmcli failed'));
      else resolve(String(out));
    });
  });
}

// nmcli -t output: fields split on unescaped ':'.
const fields = (line) => line.split(/(?<!\\):/).map((f) => f.replace(/\\:/g, ':'));

// `nmcli connection up` with the network's password from a file only we can read.
async function up(name, pass, ifname, wait) {
  const file = path.join(os.tmpdir(), `twindesk-wifi-${process.pid}-${Date.now()}`);
  fs.writeFileSync(file, `802-11-wireless-security.psk:${pass}\n`, { mode: 0o600 });
  try {
    await nmcli(['--wait', String(wait), 'connection', 'up', 'id', name, ...(ifname ? ['ifname', ifname] : []), 'passwd-file', file], (wait + 5) * 1000);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

class Wifi {
  // keepWifi() -> true: host beside the adapter's network when it can (General's switch).
  constructor({ keepWifi = () => true, onChange = () => {} } = {}) {
    this.keepWifi = keepWifi;
    this.onChange = onChange;
    this.busy = false; // the adapter is on its own network
    this.both = false; // … and can host beside it (a station and an access point at once)
    this.bothDev = ''; // the adapter `both` was checked on
    this.vif = ''; // the second interface we host on now
    this.cleaned = false; // a second interface left over from a run that didn't end well: removed once
    this.setupState = ''; // '' | 'asking' | 'declined' | the error of the last setup
    this.ok = false; // NetworkManager with a Wi-Fi adapter
    this.apOk = false; // … that can be an access point
    this.band5 = true; // … that reaches 5 GHz (a phone's Wi-Fi Direct group goes on 2.4 GHz for one that doesn't)
    this.dev = ''; // the adapter
    this.joined = '';
    this.previous = ''; // the connection we were on before joining or hosting
    this.refusedLocation = false; // Windows' only; netlink's view reads it
    this.holds = new Set(); // 'host', 'join': who needs Wi-Fi on
    this.wasOff = false; // … and it was off before
    this.radioQueue = Promise.resolve();
    // Left over from a run that didn't end well: nobody needs them.
    for (const name of [HOST, JOIN]) nmcli(['connection', 'delete', 'id', name], 8000).catch(() => {});
    this.refresh().catch(() => {});
  }

  can() {
    return this.ok;
  }

  // peerOs: a phone can't join an access point (see above): it hosts.
  canHost(peerOs) {
    return this.apOk && peerOs !== P.OS.ANDROID;
  }

  // Hosting beside the adapter's network: possible here, and whether it's set up (General).
  get side() {
    return { possible: this.both, ready: this.both && this.current, current: this.current, keep: !!this.keepWifi(), setup: this.setupState };
  }

  installed() {
    return fs.existsSync(TOOL);
  }

  // Installed and this version (refresh() asks it).
  get current() {
    return this.toolVersion === TOOL_VERSION;
  }

  // Bluetooth LE links we open: 5 s of silence before they drop, not the kernel's 420 ms (a phone or
  // a Mac busy with Wi-Fi for half a second lost TwinDesk's link). Again after an adapter reset puts
  // the default back: main.js calls this now and then. Only with the tool already set up: no prompt.
  async bleTimeout() {
    if (!this.current) return;
    const err = await run(TOOL, ['bletimeout'], 5000).then(() => '', (e) => e.message);
    if (err !== this.bleTimeoutErr && err) console.log(`[wifi] Bluetooth timeout: ${err}`);
    this.bleTimeoutErr = err;
  }

  // Installed, this version, with its capability (else the setup again: the password prompt).
  async _tool() {
    if (this.installed() && (await this._version()) === TOOL_VERSION) return true;
    if (this.setupState === 'declined') return false;
    return this.setup();
  }

  async _version() {
    this.toolVersion = this.installed() ? await run(TOOL, ['version'], 5000).catch(() => '') : '';
    return this.toolVersion;
  }

  // twindesk-wifiap installed as root with CAP_NET_ADMIN (pkexec asks for the password). True when it is.
  async setup() {
    if (this.setupState === 'asking') return false;
    this.setupState = 'asking';
    this.onChange();
    // Copied out first: root can't read an AppImage's mount.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-'));
    const src = path.join(dir, 'twindesk-wifiap');
    try {
      fs.copyFileSync(TOOL_SRC, src);
      fs.chmodSync(src, 0o755);
      await run('pkexec', ['/bin/sh', '-c', `install -D -o root -g root -m 0755 "$0" ${TOOL} && setcap cap_net_admin+ep ${TOOL}`, src], 120000);
      this.setupState = '';
      await this._version();
      this.bleTimeout();
      return true;
    } catch (e) {
      // 126: the prompt was dismissed; 127: not authorized
      this.setupState = e.code === 126 || e.code === 127 ? 'declined' : e.message || 'failed';
      console.log(`[wifi] setup: ${this.setupState}`);
      return false;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      this.onChange();
    }
  }

  // Can this adapter host beside its network? (asked once per adapter; no privileges needed)
  async _checkBoth(dev) {
    if (!dev || dev === this.bothDev) return;
    this.bothDev = dev;
    const tool = fs.existsSync(TOOL_SRC) ? TOOL_SRC : TOOL;
    this.both = (await run(tool, ['check', dev], 8000).catch(() => '')) === 'yes';
  }

  // What this computer can do (adapters come and go, Wi-Fi joins networks). True when it changed.
  async refresh() {
    const was = `${this.ok} ${this.apOk} ${this.both} ${this.band5}`;
    let dev = '';
    let busy = false;
    try {
      for (const line of (await nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device'], 8000)).split('\n')) {
        const [d, type, state, conn] = fields(line);
        if (type !== 'wifi' || state === 'unavailable' || state === 'unmanaged') continue;
        if (!dev || d === this.dev) {
          dev = d;
          busy = /^connect/.test(state) && conn !== HOST && conn !== JOIN; // on its own network (or getting there)
        }
      }
    } catch (_) {
      dev = ''; // no NetworkManager
    }
    this.dev = dev;
    this.ok = !!dev;
    this.apOk = false;
    this.busy = busy;
    if (dev) {
      const props = await nmcli(['-t', '-f', 'WIFI-PROPERTIES', 'device', 'show', dev], 8000).catch(() => '');
      this.apOk = /\.AP:yes\s*$/m.test(props);
      this.band5 = !/\.5GHZ:no\s*$/m.test(props);
      if (this.apOk) await this._checkBoth(dev);
      if (this.toolVersion === undefined) await this._version();
      if (!this.cleaned && this.both && this.installed()) {
        this.cleaned = true;
        await run(TOOL, ['del', dev], 8000).catch(() => {});
      }
    }
    return was !== `${this.ok} ${this.apOk} ${this.both} ${this.band5}`;
  }

  // Hosting beside the adapter's network: the second interface up and NetworkManager's, the setup
  // first when it isn't (the password prompt, once). Its name, or '': host on the adapter itself.
  async _side() {
    if (!this.busy || !this.both || !this.keepWifi() || this.joined || !(await this._tool())) return '';
    const name = async () => {
      const idx = await run(TOOL, ['add', this.dev], 8000);
      await sleep(1000); // udev may rename it
      for (const n of fs.readdirSync('/sys/class/net')) {
        if (fs.readFileSync(`/sys/class/net/${n}/ifindex`, 'utf8').trim() === idx) return n;
      }
      throw new Error('it went');
    };
    try {
      const vif = await name().catch(async (e) => {
        if (!/not permitted/i.test(e.message) || !(await this.setup())) throw e; // installed without the capability (a copy)
        return name();
      });
      for (let i = 0; i < 20; i++) { // NetworkManager picks it up
        const line = (await nmcli(['-t', '-f', 'DEVICE,STATE', 'device'], 5000).catch(() => '')).split('\n').find((l) => fields(l)[0] === vif);
        if (line && fields(line)[1] === 'unmanaged') await nmcli(['device', 'set', vif, 'managed', 'yes'], 5000).catch(() => {});
        else if (line && !/unavailable/.test(fields(line)[1])) return vif;
        await sleep(250);
      }
      throw new Error(`NetworkManager didn’t take ${vif}`);
    } catch (e) {
      console.log(`[wifi] hosting beside the network: ${e.message}`);
      await run(TOOL, ['del', this.dev], 8000).catch(() => {});
      return '';
    }
  }

  // The channel the adapter is on: the access point beside it has to use the same one.
  async _channel() {
    const out = await nmcli(['-t', '-f', 'IN-USE,CHAN,FREQ', 'device', 'wifi', 'list', 'ifname', this.dev, '--rescan', 'no'], 8000).catch(() => '');
    const line = out.split('\n').find((l) => l.startsWith('*'));
    if (!line) return null;
    const [, chan, freq] = fields(line);
    return { chan: Number(chan) || 0, band: parseInt(freq, 10) >= 4900 ? 'a' : 'bg' };
  }

  // The Wi-Fi connection the adapter is on now (not ours), to go back to after.
  async _current() {
    try {
      for (const line of (await nmcli(['-t', '-f', 'NAME,TYPE,DEVICE', 'connection', 'show', '--active'], 8000)).split('\n')) {
        const [name, type, d] = fields(line);
        if (type === '802-11-wireless' && (!this.dev || d === this.dev) && name !== JOIN && name !== HOST) return name;
      }
    } catch (_) { /* none */ }
    return '';
  }

  // Back to the network we were on (NetworkManager usually goes back by itself; asking makes it quick).
  _back() {
    if (this.previous && !this.holds.size) nmcli(['connection', 'up', 'id', this.previous], 30000).catch(() => {});
    if (!this.holds.size) this.previous = '';
  }

  async host(ssid, pass) {
    await this._hold('host');
    this.vif = await this._side();
    const ch = this.vif ? await this._channel() : null;
    if (!this.vif) {
      const now = await this._current();
      if (now) this.previous = now; // else straight from joining: still the one before
    }
    const ifname = this.vif || this.dev;
    console.log(`[wifi] hosting ${ssid} on ${ifname || 'any adapter'}${this.vif ? ` beside the network (channel ${ch ? ch.chan : '?'})` : ''}`);
    try {
      await nmcli(['connection', 'delete', 'id', HOST], 8000).catch(() => {});
      await nmcli(['connection', 'add', 'type', 'wifi', 'ifname', ifname || '*', 'con-name', HOST, 'autoconnect', 'no', 'ssid', ssid,
        'connection.permissions', `user:${os.userInfo().username}`,
        '802-11-wireless.mode', 'ap', '802-11-wireless.band', ch ? ch.band : 'bg', ...(ch && ch.chan ? ['802-11-wireless.channel', String(ch.chan)] : []),
        'ipv4.method', 'shared', 'ipv6.method', 'ignore',
        'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.proto', 'rsn', 'wifi-sec.pairwise', 'ccmp', 'wifi-sec.group', 'ccmp', 'wifi-sec.psk-flags', '2']);
      await up(HOST, pass, ifname, 30);
    } catch (e) {
      await this.unhost();
      throw new Error('Couldn’t start the Wi-Fi network: ' + e.message);
    }
  }

  async unhost() {
    await nmcli(['connection', 'delete', 'id', HOST], 10000).catch(() => {});
    if (this.vif) {
      this.vif = '';
      await run(TOOL, ['del', this.dev], 8000).catch(() => {});
    }
    await this._release('host');
    this._back();
  }

  async join(ssid, pass) {
    await this._hold('join');
    const now = await this._current();
    if (now) this.previous = now; // else straight from hosting: still the one before
    await nmcli(['connection', 'delete', 'id', JOIN], 8000).catch(() => {});
    try {
      await nmcli(['connection', 'add', 'type', 'wifi', 'ifname', this.dev || '*', 'con-name', JOIN, 'autoconnect', 'no', 'ssid', ssid,
        'connection.permissions', `user:${os.userInfo().username}`, 'ipv6.method', 'ignore',
        'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk-flags', '2']);
    } catch (e) {
      await this.leave();
      throw new Error('Couldn’t join it: ' + e.message);
    }
    this.joined = ssid;
    const until = Date.now() + JOIN_MS;
    let last = '';
    let seen = false;
    while (Date.now() < until) {
      // Connect only once a scan shows it (a group that just came up takes a moment): a `connection
      // up` while it isn't there scans by itself, and the next one interrupts it.
      if (!(await this._visible(ssid))) {
        await sleep(1500);
        continue;
      }
      seen = true;
      try {
        await up(JOIN, pass, this.dev, 20);
        await sleep(1500); // DHCP done; let the route settle before discovery looks
        return;
      } catch (e) {
        last = e.message;
        await sleep(2000);
      }
    }
    await this.leave();
    if (!seen) throw new Error(`this computer’s Wi-Fi never saw it${this.band5 ? '' : ' (its adapter is 2.4 GHz only)'}`);
    throw new Error('NetworkManager didn’t connect to it' + (last ? ` (${last})` : ''));
  }

  // A fresh scan lists this network.
  async _visible(ssid) {
    const out = await nmcli(['-t', '-f', 'SSID', 'device', 'wifi', 'list', ...(this.dev ? ['ifname', this.dev] : []), '--rescan', 'yes'], 15000).catch(() => '');
    return out.split('\n').some((l) => l.replace(/\\:/g, ':') === ssid);
  }

  async leave() {
    this.joined = '';
    await nmcli(['connection', 'delete', 'id', JOIN], 10000).catch(() => {});
    await this._release('join');
    this._back();
  }

  // Wi-Fi on while hosting or joining, one change at a time (hosting can end while joining
  // starts); off again once neither needs it, when it was off.
  _hold(who) {
    return this._radio(async () => {
      if (this.holds.has(who)) return;
      if (!this.holds.size) {
        const r = (await nmcli(['radio', 'wifi'], 5000).catch(() => '')).trim();
        this.wasOff = r === 'disabled';
        if (this.wasOff) {
          await nmcli(['radio', 'wifi', 'on'], 10000);
          await sleep(3000); // the adapter comes back and scans
          await this.refresh().catch(() => {});
        }
      }
      this.holds.add(who);
    });
  }

  _release(who) {
    return this._radio(async () => {
      if (!this.holds.delete(who) || this.holds.size || !this.wasOff) return;
      this.wasOff = false;
      await nmcli(['radio', 'wifi', 'off'], 10000).catch(() => {});
    });
  }

  _radio(fn) {
    const p = this.radioQueue.then(fn);
    this.radioQueue = p.catch(() => {});
    return p;
  }
}

module.exports = { Wifi };

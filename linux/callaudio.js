// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The calls' sound on this computer over Bluetooth (shared/phonehub.js makes this only while Calls
// and its Bluetooth option are on with a phone connected): BlueZ connects to the phone as its
// hands-free, like a headset, and PipeWire (its hfp_hf role, on by default) plays the call through
// the default speakers and microphone. Nothing runs of it otherwise: busctl when asked, and while
// connected one `gdbus monitor` that only wakes when the phone's Bluetooth state changes.
// stop() ends it all: the phone gets its calls back.
//
// view: {state: 'starting'|'unavailable'|'needs-pair'|'choose'|'connecting'|'ready'|'failed'|'off',
//        message, device, devices, here, address}. Events: 'change', 'address' (this computer's).
'use strict';

const fs = require('fs');
const { execFile, spawn } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');

const AG = '0000111f-0000-1000-8000-00805f9b34fb'; // Hands-Free Audio Gateway: what a phone offers
const RETRY_MS = [5000, 15000, 30000, 60000, 120000];
const NO_HF = 'this computer’s sound server doesn’t take calls over Bluetooth (PipeWire with its hfp_hf role)';

const run = (cmd, args, timeout = 10000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) =>
    resolve({ err, out: String(out || ''), errOut: String(errOut || '').trim() }));
});
// Never starts BlueZ: with no adapter, starting it only times out (25 s).
const busctl = (args, timeout) => run('busctl', ['--system', '--auto-start=no', ...args], timeout);
const val = (v) => (v && typeof v === 'object' && 'data' in v ? v.data : v); // busctl --json: {type, data}
const brief = (s) => String(s || '').split('\n')[0].replace(/^Call failed:\s*/i, '').slice(0, 120);

class CallAudio extends EventEmitter {
  constructor({ device, save }) {
    super();
    this.saved = device; // () => the paired phone chosen before (its Bluetooth address)
    this.save = save;
    this.phoneName = '';
    this.devices = [];
    this.adapter = '';
    this.address = '';
    this.power = true;
    this.id = '';
    this.state = 'starting';
    this.error = '';
    this.here = false;
    this.parked = false; // moved to the phone for this call (the profile let go on purpose)
    this.micWas = null; // the microphone's mute before Mute, put back after
    this.forgetting = false; // unpair() removing the phone's devices: not looked at meanwhile
    this.tries = 0;
    this.timer = null;
    this.watcher = null;
    this.gen = 0; // a newer start() or stop() makes older answers moot
    this.stopped = false;
  }

  start(phoneName) {
    this.stopped = false;
    if (phoneName) this.phoneName = phoneName;
    this.tries = 0;
    clearTimeout(this.timer);
    this._info(++this.gen);
  }

  // The phone's Bluetooth name (hub.state, also sent once it pairs): which paired device it is.
  phone(name) {
    const renamed = !!name && name !== this.phoneName; // its Bluetooth name came: picked again by it
    if (name) this.phoneName = name;
    if (!this.stopped && (['needs-pair', 'choose'].includes(this.state) || (renamed && this.state !== 'ready'))) this._info(this.gen);
  }

  // Forget the phone on this computer, over classic Bluetooth and LE both (the phone forgets it too:
  // phonehub.js), so neither keeps keys the other dropped: the device picked for it, and every other
  // paired one with its name. Then looked for again, to be paired in the desktop's Bluetooth settings.
  async unpair() {
    const d = this._device();
    const name = ((d && d.name) || this.phoneName).trim().toLowerCase();
    if (!d && !name) return;
    const gen = ++this.gen;
    clearTimeout(this.timer);
    this._unwatch();
    this.save('');
    this.id = '';
    this.here = false;
    this.parked = false;
    this.forgetting = true;
    this._set('needs-pair');
    const r = await busctl(['--json=short', 'call', 'org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects']);
    let objs;
    try { objs = JSON.parse(r.out).data[0] || {}; } catch { objs = {}; }
    for (const [p, o] of Object.entries(objs)) {
      const x = o['org.bluez.Device1'];
      if (!x || !val(x.Paired)) continue;
      const same = (d && String(val(x.Address) || '').toUpperCase() === d.id)
        || (name && String(val(x.Alias) || val(x.Name) || '').trim().toLowerCase() === name);
      if (same) await busctl(['call', 'org.bluez', String(val(x.Adapter)), 'org.bluez.Adapter1', 'RemoveDevice', 'o', p]);
    }
    this.forgetting = false;
    if (gen === this.gen && !this.stopped) this._info(gen);
  }

  // Paired meanwhile (in the desktop's Bluetooth settings)? Looked at again while it isn't, and connected to then.
  check() {
    if (!this.stopped && !this.forgetting && (['needs-pair', 'choose'].includes(this.state) || (this.state === 'unavailable' && !this.power))) this._info(this.gen);
  }

  // Here: the hands-free connected again. Phone: let go of it, as when a headset goes away; the
  // call stays on the phone. A call ending brings it back for the next one (idle()).
  transfer(here) {
    const d = this._device();
    if (!d || this.stopped) return;
    if (here) {
      this.parked = false;
      return this._connect(d, this.gen);
    }
    this.parked = true;
    this.here = false;
    busctl(['call', 'org.bluez', d.path, 'org.bluez.Device1', 'DisconnectProfile', 's', AG]);
    this.emit('change');
  }

  // Over Bluetooth the call hears this computer's microphone: muted here, put back as it was.
  async mute(on) {
    if (on) {
      if (this.micWas === null) {
        const r = await run('pactl', ['get-source-mute', '@DEFAULT_SOURCE@']);
        this.micWas = !r.err && /yes|true|1/i.test(r.out);
      }
      return this._mic(true);
    }
    if (this.micWas === null) return;
    const was = this.micWas;
    this.micWas = null;
    return this._mic(was);
  }

  // The call ended: the microphone as it was, and the next call here again.
  idle() {
    this.mute(false);
    if (this.parked) this.transfer(true);
  }

  stop() {
    this.stopped = true;
    this.gen++;
    clearTimeout(this.timer);
    this._unwatch();
    this.mute(false);
    const d = this._device();
    if (d && (this.state === 'ready' || this.state === 'connecting')) {
      busctl(['call', 'org.bluez', d.path, 'org.bluez.Device1', 'DisconnectProfile', 's', AG]);
    }
    this.here = false;
    this.parked = false;
    this._set('off');
  }

  async _mic(on) {
    const r = await run('pactl', ['set-source-mute', '@DEFAULT_SOURCE@', on ? '1' : '0']);
    if (r.err && r.err.code === 'ENOENT') run('wpctl', ['set-mute', '@DEFAULT_AUDIO_SOURCE@', on ? '1' : '0']);
  }

  _device() {
    return this.devices.find((d) => d.id === this.id) || null;
  }

  // This computer's adapter and the phones paired with it, from BlueZ.
  async _info(gen) {
    const r = await busctl(['--json=short', 'call', 'org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects']);
    if (gen !== this.gen || this.stopped) return;
    if (r.err) {
      const adapter = fs.existsSync('/sys/class/bluetooth') && fs.readdirSync('/sys/class/bluetooth').length > 0;
      this.error = r.err.code === 'ENOENT' ? 'busctl (systemd) is missing'
        : !adapter ? 'no Bluetooth adapter'
          : /ServiceUnknown|not provided|activat/i.test(r.errOut) ? 'Bluetooth (BlueZ) isn’t running'
            : r.err.killed ? 'Bluetooth (BlueZ) didn’t answer' : brief(r.errOut || r.err.message);
      return this._set('unavailable');
    }
    let objs;
    try { objs = JSON.parse(r.out).data[0] || {}; } catch { objs = {}; }
    const adapters = Object.entries(objs).filter(([, o]) => o['org.bluez.Adapter1']);
    const [path, a] = adapters.find(([, o]) => val(o['org.bluez.Adapter1'].Powered)) || adapters[0] || [];
    if (!path) { this.error = 'no Bluetooth adapter'; return this._set('unavailable'); }
    const ad = a['org.bluez.Adapter1'];
    this.adapter = path;
    this.power = !!val(ad.Powered);
    const address = String(val(ad.Address) || '').toUpperCase();
    if (address && address !== this.address) {
      this.address = address;
      this.emit('address', address);
    }
    this.devices = Object.entries(objs).map(([p, o]) => [p, o['org.bluez.Device1']]).filter(([, d]) => {
      if (!d || !val(d.Paired) || val(d.Adapter) !== path) return false;
      const uuids = val(d.UUIDs) || [];
      return (Array.isArray(uuids) && uuids.some((u) => String(u).toLowerCase() === AG)) || ((Number(val(d.Class)) >> 8) & 0x1f) === 2; // a phone
    }).slice(0, 20).map(([p, d]) => {
      const id = String(val(d.Address) || '').toUpperCase();
      return { id, name: String(val(d.Alias) || val(d.Name) || id), path: p };
    });
    this._pick(gen);
  }

  // Which paired device is the phone: the one picked for it before (each phone its own), else the
  // one with its Bluetooth name. Not found: the user picks it ('choose'), never just the first one,
  // which was another phone paired before.
  _pick(gen) {
    if (!this.power) { this.error = ''; return this._set('unavailable'); }
    const saved = this.saved();
    const name = this.phoneName.trim().toLowerCase();
    const d = this.devices.find((x) => x.id === saved)
      || (name && this.devices.find((x) => x.name.trim().toLowerCase() === name));
    if (!d) { this.id = ''; return this._set(this.devices.length ? 'choose' : 'needs-pair'); }
    this.id = d.id;
    if (d.id !== saved) this.save(d.id);
    if (!this.parked) this._connect(d, gen);
  }

  async _connect(d, gen) {
    this._set('connecting');
    const r = await busctl(['--timeout=40', 'call', 'org.bluez', d.path, 'org.bluez.Device1', 'ConnectProfile', 's', AG], 45000);
    if (gen !== this.gen || this.stopped || this.parked) return;
    if (r.err && !/AlreadyConnected|already connected/i.test(r.errOut)) {
      if (r.err.code === 'ENOENT') { this.error = 'busctl (systemd) is missing'; return this._set('unavailable'); }
      // No hands-free on this side to connect: BlueZ knows no profile for the phone's gateway.
      if (/InvalidArguments|Invalid arguments|NotSupported|ProfileUnavailable/i.test(r.errOut)) { this.error = NO_HF; return this._set('unavailable'); }
      this.error = brief(r.errOut || r.err.message);
      return this._retry();
    }
    this.tries = 0;
    this.error = '';
    this.here = true;
    this._watch(d, gen);
    this._set('ready');
  }

  // While connected: told when the phone goes (out of range, Bluetooth off), and then again.
  _watch(d, gen) {
    this._unwatch();
    const check = async () => {
      const r = await busctl(['--json=short', 'get-property', 'org.bluez', d.path, 'org.bluez.Device1', 'Connected']);
      if (gen !== this.gen || this.stopped || this.parked || this.state !== 'ready') return;
      let on = true;
      try { on = !!JSON.parse(r.out).data; } catch { on = !r.err; }
      if (!on) { this.here = false; this._unwatch(); this._retry(); }
    };
    const p = spawn('gdbus', ['monitor', '--system', '--dest', 'org.bluez', '--object-path', d.path], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.watcher = p;
    p.on('error', () => { // no gdbus: a look now and then instead
      if (this.watcher !== p) return;
      const t = setInterval(check, 20000);
      t.unref();
      this.watcher = { kill: () => clearInterval(t) };
    });
    readline.createInterface({ input: p.stdout }).on('line', (l) => { if (/Connected/.test(l)) check(); });
  }

  _unwatch() {
    const w = this.watcher;
    this.watcher = null;
    if (w) try { w.kill(); } catch {}
  }

  // Dropped or refused (the phone busy with a car, or out of range): again a little later, a few times.
  _retry() {
    if (this.stopped) return;
    const wait = RETRY_MS[this.tries++];
    this._set('failed');
    clearTimeout(this.timer);
    const gen = this.gen;
    if (wait) this.timer = setTimeout(() => !this.stopped && gen === this.gen && this._info(gen), wait);
  }

  _set(state) {
    this.state = state;
    this.emit('change');
  }

  get view() {
    const dev = this._device();
    const name = (dev && dev.name) || this.phoneName || 'the phone';
    const MESSAGES = {
      starting: 'Starting…',
      unavailable: this.error ? `Not available: ${this.error}` : 'Bluetooth is off on this computer',
      'needs-pair': `Not paired with ${this.phoneName || 'the phone'} over classic Bluetooth: pair them in Bluetooth settings, as below`,
      choose: `Which one is ${this.phoneName || 'the phone'}? Pick it, or pair it below if it isn’t there`,
      connecting: `Connecting to ${name}…`,
      ready: this.parked ? `This call plays on ${name}` : `Connected to ${name} over Bluetooth: calls play on this computer`,
      failed: `Couldn’t reach ${name} over Bluetooth${this.error ? ` (${this.error})` : ''}. ${this.tries > RETRY_MS.length ? 'Click Connect to try again' : 'Trying again soon'}`,
      off: 'Off',
    };
    return {
      state: this.state, message: MESSAGES[this.state] || '', device: this.id,
      canUnpair: true, devices: this.devices.map(({ id, name: n }) => ({ id, name: n })), here: this.here, address: this.address,
      pairHow: `In Settings › Bluetooth, pick ${this.phoneName || 'the phone'} from the devices found and confirm`,
    };
  }
}

module.exports = { create: (opts) => new CallAudio(opts) };

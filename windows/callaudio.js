// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The calls' sound on this PC over Bluetooth (shared/phonehub.js makes this only while Calls and
// its Bluetooth option are on with a phone connected): windows-helper's macshare-calls connects to
// the phone as its hands-free, like a headset, and Windows plays the call through the PC's speakers
// and microphone once asked to (each call is moved here as it starts), and not at all while a
// Bluetooth headset is connected to the PC (whatever the default devices: its hands-free link and the
// phone's can't both be up). Windows lets only an app with a package identity do that (PhoneLineTransportDevice),
// so first its sparse package is registered for this user, pointing at where TwinDesk is (the
// installer trusts its certificate). The phone has to be paired with this PC over Bluetooth once, in
// Windows' own Bluetooth settings (the Calls page's setup). stop() ends it: the process lets the
// phone line go and exits.
//
// view: as linux/callaudio.js. Events: 'change', 'address' (this PC's).
'use strict';

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { script } = require('./ps');

const ROOT = path.join(__dirname, '..'); // the package's external location: its exe is windows-helper\bin\macshare-calls.exe in it
const BIN = path.join(ROOT, 'windows-helper', 'bin');
const EXE = path.join(BIN, 'macshare-calls.exe');
const MSIX = path.join(BIN, 'twindesk-calls.msix');
const CER = path.join(BIN, 'twindesk-calls.cer');
const PKG = 'TwinDesk.Calls';
const PKG_VERSION = '1.0.1.0'; // as windows-helper/calls/AppxManifest.xml
const RETRY_MS = [5000, 15000, 30000, 60000, 120000];
const SYSTEM_ONLY = 'Windows keeps calls over Bluetooth for Phone Link on this PC. Calls still ring, answer and dial here; their sound stays on the phone';
let refused = ''; // Windows said no: not asked again until the app restarts

const parse = (s) => { try { return JSON.parse(String(s).trim().split('\n').pop()) || {}; } catch { return {}; } };

// Why Windows wouldn't add the package, in words.
function addError(e) {
  if (/0x800B0109|0x800B010A|trust|certificate/i.test(e)) {
    return `Windows doesn’t trust TwinDesk’s calls package. Reinstall TwinDesk, or (a dev build) as administrator: certutil -addstore TrustedPeople "${CER}"`;
  }
  if (/0x80073CFF|sideload|developer/i.test(e)) return 'Windows won’t add TwinDesk’s calls package: allow apps from any source in Settings › System › For developers';
  return `TwinDesk’s calls package: ${String(e).slice(0, 140)}`;
}

class CallAudio extends EventEmitter {
  constructor({ device, save }) {
    super();
    this.saved = device; // () => the paired phone chosen before (its device id)
    this.save = save;
    this.proc = null;
    this.phoneName = '';
    this.devices = [];
    this.address = '';
    this.power = true;
    this.id = '';
    this.state = refused ? 'unavailable' : 'starting';
    this.error = refused;
    this.here = false; // a call under way with its sound on this PC (macshare-calls' call events)
    this.local = true; // Windows can play calls here (false while this PC's call devices are Bluetooth)
    this.forced = false; // registered again once, when the exe came up without its identity
    this.denied = false; // Windows said no (its privacy settings, or another app has the line): Connect after fixing that
    this.tries = 0;
    this.timer = null;
    this.gen = 0;
    this.stopped = false;
  }

  start(phoneName) {
    this.stopped = false;
    if (phoneName) this.phoneName = phoneName;
    if (refused) { this.error = refused; return this._set('unavailable'); }
    this.tries = 0;
    clearTimeout(this.timer);
    if (this.proc) return this._send({ cmd: 'info' });
    this._launch(++this.gen, false);
  }

  phone(name) {
    const renamed = !!name && name !== this.phoneName; // its Bluetooth name came: picked again by it
    if (name) this.phoneName = name;
    if (this.proc && (['needs-pair', 'choose'].includes(this.state) || (renamed && this.state !== 'ready'))) this._send({ cmd: 'info' });
  }

  // Forget the phone on this PC, its classic and LE pairings both (the phone forgets it too:
  // phonehub.js), so neither side keeps keys the other dropped.
  unpair() {
    const d = this.devices.find((x) => x.id === this.id);
    const name = (d && d.name) || this.phoneName;
    if (!name || !this.proc) return;
    this.save('');
    this.id = '';
    this._send({ cmd: 'unpair', name });
    this._set('needs-pair');
  }

  // Paired meanwhile (in Windows' Bluetooth settings)? Looked at again while it isn't, and connected to then.
  check() {
    if (this.proc && (['needs-pair', 'choose'].includes(this.state) || (this.state === 'unavailable' && !this.power))) this._send({ cmd: 'info' });
  }

  // Where the call's sound goes, this call and the next ones: this PC, or back to the phone.
  transfer(here) {
    this._send({ cmd: 'audio', here: !!here });
  }

  // The microphone here, for the call.
  mute(on) {
    this._send({ cmd: 'mute', on: !!on });
  }

  // The call ended: the next one here again, not muted.
  idle() {
    this._send({ cmd: 'audio', here: true });
    this._send({ cmd: 'mute', on: false });
  }

  stop() {
    this.stopped = true;
    this.gen++;
    clearTimeout(this.timer);
    this._end();
    this._set('off');
  }

  _end() {
    const p = this.proc;
    this.proc = null;
    if (p) {
      try { p.stdin.end(); } catch {} // it lets the phone line go, then exits
      setTimeout(() => { try { p.kill(); } catch {} }, 1500).unref();
    }
  }

  async _launch(gen, force) {
    if (!fs.existsSync(EXE) || !fs.existsSync(MSIX)) {
      this.error = 'macshare-calls is missing (npm run build:helper)';
      return this._set('unavailable');
    }
    this._set('starting');
    let r;
    // scripts/calls-register.ps1: for this user only, again when its version or place changed (force).
    try { r = parse(await script('calls-register', { Name: PKG, Version: PKG_VERSION, Msix: MSIX, Root: ROOT, Force: !!force }, 90000)); } catch (e) { r = { error: e.message }; }
    if (gen !== this.gen || this.stopped) return;
    if (!r.ok) {
      this._log(`package: ${r.error || 'failed'}`);
      this.error = addError(r.error || '');
      return this._set('unavailable');
    }
    this._spawn();
    this._send({ cmd: 'info' });
  }

  _spawn() {
    const p = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = p;
    p.stdin.on('error', () => {});
    readline.createInterface({ input: p.stdout }).on('line', (l) => this._line(l));
    readline.createInterface({ input: p.stderr }).on('line', (l) => this._log(l));
    p.on('exit', () => {
      if (this.proc !== p) return;
      this.proc = null;
      if (!this.stopped) { this.error = 'stopped'; this._retry(); }
    });
    p.on('error', (e) => this._log(e.message));
  }

  _log(line) {
    console.log(`[calls] ${line}`);
  }

  _send(o) {
    if (this.proc) this.proc.stdin.write(`${JSON.stringify(o)}\n`);
  }

  _line(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.ev === 'info') {
      // Started without the package's identity (registered for TwinDesk somewhere else, say a dev
      // copy): registered again here, once.
      if (m.identity === false) {
        this._end();
        if (this.forced) { this.error = 'Windows didn’t give macshare-calls TwinDesk’s package identity'; return this._set('unavailable'); }
        this.forced = true;
        return this._launch(this.gen, true);
      }
      this.power = m.power !== false;
      this.devices = (Array.isArray(m.devices) ? m.devices : []).filter((d) => d && typeof d.id === 'string' && d.id)
        .slice(0, 20).map((d) => ({ id: d.id, name: String(d.name || 'Phone') }));
      if (typeof m.address === 'string' && m.address && m.address !== this.address) {
        this.address = m.address;
        this.emit('address', m.address);
      }
      return this._pick();
    }
    if (m.ev === 'routing') {
      this.local = m.local !== false;
      return this.emit('change');
    }
    if (m.ev === 'call') {
      const here = !!m.here && !['ended', 'lost'].includes(m.status);
      if (here !== this.here) this._log(`call ${m.status}: sound ${here ? 'here' : 'on the phone'}`);
      this.here = here;
      return this.emit('change');
    }
    if (m.ev === 'state') {
      this._log(`hands-free ${m.state}${m.access ? ` (access ${m.access})` : ''}${m.error ? ` (${m.error})` : ''}`);
      this.denied = false;
      if (m.state !== 'connected') this.here = false;
      if (m.state === 'connected') { this.tries = 0; this.error = ''; return this._set('ready'); }
      if (m.state === 'connecting') return this._set('connecting');
      if (m.access === 'DeniedByUser') {
        this.denied = true;
        this.error = 'Windows’ privacy settings keep calls from TwinDesk: allow it in Settings › Privacy & security › Phone calls, then Connect';
        this.tries = RETRY_MS.length + 1;
        return this._set('failed');
      }
      // Windows gave this phone's line to another app (one registered for it before, Phone Link
      // say): it's TwinDesk's once the phone is paired again.
      if (m.error === 'unregistered') {
        this.denied = true;
        this.error = `Windows keeps ${this.phoneName || 'the phone'}’s calls for another app: Forget it below and pair it again`;
        this.tries = RETRY_MS.length + 1;
        return this._set('failed');
      }
      // DeniedBySystem: Windows keeps the phone line for its own (Phone Link). Asked again only
      // once the app restarts.
      if (m.access && m.access !== 'Allowed') {
        refused = SYSTEM_ONLY;
        this.error = refused;
        this._end();
        return this._set('unavailable');
      }
      this.error = String(m.error || '').slice(0, 120);
      return this._retry();
    }
  }

  // Which paired device is the phone: the one picked for it before (each phone its own), else the
  // one with its Bluetooth name. Not found: the user picks it ('choose'), never just the first one,
  // which was another phone paired before.
  _pick() {
    if (!this.power) { this.error = ''; return this._set('unavailable'); }
    const saved = this.saved();
    const name = this.phoneName.trim().toLowerCase();
    const d = this.devices.find((x) => x.id === saved)
      || (name && this.devices.find((x) => x.name.trim().toLowerCase() === name));
    if (!d) { this.id = ''; return this._set(this.devices.length ? 'choose' : 'needs-pair'); }
    this.id = d.id;
    if (d.id !== saved) this.save(d.id);
    this._send({ cmd: 'connect', id: d.id });
  }

  // Dropped or refused (the phone busy with a car, or out of range): again a little later, a few times.
  _retry() {
    if (this.stopped) return;
    const wait = RETRY_MS[this.tries++];
    this._set('failed');
    clearTimeout(this.timer);
    const gen = this.gen;
    if (wait) this.timer = setTimeout(() => !this.stopped && gen === this.gen && (this.proc ? this._send({ cmd: 'info' }) : this._launch(gen, false)), wait);
  }

  _set(state) {
    this.state = state;
    this.emit('change');
  }

  get view() {
    const dev = this.devices.find((d) => d.id === this.id);
    const name = (dev && dev.name) || this.phoneName || 'the phone';
    const MESSAGES = {
      starting: 'Starting…',
      unavailable: this.error || 'Bluetooth is off on this PC',
      'needs-pair': `Not paired with ${this.phoneName || 'the phone'} over classic Bluetooth: pair them in Bluetooth settings, as below`,
      choose: `Which one is ${this.phoneName || 'the phone'}? Pick it, or pair it below if it isn’t there`,
      connecting: `Connecting to ${name}…`,
      ready: this.local ? `Connected to ${name} over Bluetooth: calls play on this PC`
        : `Connected to ${name}, but calls stay on the phone while a Bluetooth headset is connected to this PC: Windows plays calls only through wired or built-in speakers and a microphone, with no Bluetooth headset connected`,
      failed: this.denied ? this.error : `Couldn’t reach ${name} over Bluetooth${this.error && this.error !== 'stopped' ? ` (${this.error})` : ''}. ${this.tries > RETRY_MS.length ? 'Click Connect to try again' : 'Trying again soon'}`,
      off: 'Off',
    };
    return {
      state: this.state, message: MESSAGES[this.state] || '', device: this.id,
      devices: this.devices, here: this.here, address: this.address, canMute: this.here, canMove: this.local, canUnpair: true,
      pairHow: `In Settings › Bluetooth & devices: Add device › Bluetooth, then pick ${this.phoneName || 'the phone'} (the one with a phone icon)`,
    };
  }
}

// Said under Calls' switch: what no app can change (Windows decides it before any routing).
const LIMIT = 'Through this PC’s wired or built-in speakers and microphone only. Windows keeps calls on the phone while a Bluetooth headset is connected to this PC, so no app can bring them to the headset';

module.exports = { create: (opts) => new CallAudio(opts), LIMIT };

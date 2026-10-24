// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The bundled adb (Android platform-tools), for the phone's wireless debugging: pairing with
// its code, connecting, shell commands, pushing scrcpy-server and port forwards. Port of
// windows/adb.js. The packages have adb in linux/vendor/adb (installer/build.js fetches it,
// scripts/fetch-adb.js for a dev run).
// The same on X11 and Wayland: nothing here goes through the desktop.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const adbmdns = require('../shared/adbmdns.js');

// A developer's own adb comes first: the one named by ADB (scrcpy's setting), else the Android
// SDK's platform-tools, which Flutter, Android Studio and a terminal use. Two different adb
// builds on one machine keep killing each other's server on port 5037, dropping every device on
// both sides. The bundled one is for everyone else; the distribution's and any other on PATH
// come last, as before (a distribution's can be too old to pair).
function findAdb() {
  const onPath = String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'adb'));
  const sdk = (p) => path.basename(path.dirname(p)) === 'platform-tools';
  const candidates = [
    process.env.ADB,
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
    path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', 'adb'),
    ...onPath.filter(sdk),
    path.join(__dirname, 'vendor', 'adb', 'adb'),
    ...onPath.filter((p) => !sdk(p)),
    '/usr/bin/adb',
    '/usr/lib/android-sdk/platform-tools/adb',
  ];
  const runnable = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };
  return candidates.find((p) => p && runnable(p)) || null;
}

function findServer() {
  const candidates = [
    path.join(__dirname, 'vendor', 'scrcpy-server'),
    path.join(__dirname, '..', 'mac', 'vendor', 'scrcpy-server'), // a dev run from the repo
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

class Adb {
  // Nothing runs until a phone is linked (wake) or plugged in: no mDNS watching, no adb server.
  constructor() {
    this.bin = findAdb();
    this.server = findServer();
  }

  // A phone is linked: from now on keep its announcements (mdns() finds them).
  wake() {
    adbmdns.watcher.start();
  }

  get available() {
    if (!this.bin) this.bin = findAdb(); // installed since (Try Again)
    return !!(this.bin && this.server);
  }

  run(args, { timeout = 15000, input } = {}) {
    return new Promise((resolve) => {
      if (!this.bin) return resolve({ code: -1, out: '', err: 'adb is missing' });
      const p = execFile(this.bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(out || ''), err: String(errOut || (err && err.message) || '') });
      });
      if (input != null) p.stdin.end(input);
    });
  }

  // [{serial, state}]
  async devices() {
    const r = await this.run(['devices']);
    return r.out.split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2).map(([serial, state]) => ({ serial, state }));
  }

  // The phone's wireless debugging services: [{name, type: 'pairing'|'connect', address, port}].
  // adb's own mDNS often sees nothing where the system's does, so ours (shared/adbmdns.js, which
  // also keeps the phone's announcements) count too.
  async mdns() {
    this.wake();
    const [r, ours] = await Promise.all([this.run(['mdns', 'services'], { timeout: 5000 }), adbmdns.query()]);
    const out = [];
    for (const l of r.out.split('\n')) {
      const m = /^(\S+)\s+_adb-tls-(pairing|connect)\._tcp\.?\s+([\d.]+):(\d+)/.exec(l.trim());
      if (m) out.push({ name: m[1], type: m[2], address: m[3], port: Number(m[4]) });
    }
    for (const s of [...ours]) if (!out.some((o) => o.type === s.type && o.address === s.address && o.port === s.port)) out.push(s);
    return out;
  }

  async pair(address, port, code) {
    const r = await this.run(['pair', `${address}:${port}`, String(code)], { timeout: 20000 });
    const text = `${r.out}${r.err}`;
    return { ok: /Successfully paired/i.test(text), text: text.trim() };
  }

  async connect(address, port) {
    const r = await this.run(['connect', `${address}:${port}`], { timeout: 10000 });
    const text = `${r.out}${r.err}`;
    return { ok: /connected to|already connected/i.test(text) && !/failed|unable|cannot/i.test(text), text: text.trim() };
  }

  disconnect(serial) {
    return this.run(['disconnect', serial], { timeout: 5000 });
  }

  shell(serial, command, opts) {
    return this.run(['-s', serial, 'shell', command], opts);
  }

  push(serial, local, remote) {
    return this.run(['-s', serial, 'push', local, remote], { timeout: 30000 });
  }

  // A local TCP port forwarded to an abstract socket on the phone; resolves to the port.
  async forward(serial, abstractName) {
    const r = await this.run(['-s', serial, 'forward', 'tcp:0', `localabstract:${abstractName}`]);
    const port = Number(r.out.trim());
    if (!port) throw new Error(`adb forward failed: ${r.err.trim() || r.out.trim()}`);
    return port;
  }

  unforward(serial, port) {
    return this.run(['-s', serial, 'forward', '--remove', `tcp:${port}`], { timeout: 5000 });
  }

  // A long-running shell command (scrcpy-server), as a child process.
  spawnShell(serial, command) {
    return spawn(this.bin, ['-s', serial, 'shell', command], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  // The adb server keeps running after the app quits (and an AppImage's copy of adb is gone once
  // it is unmounted): stop it at quit, when it is ours (not the Android SDK's or the system's).
  killServer() {
    if (this.bin && this.bin.startsWith(__dirname)) try { spawn(this.bin, ['kill-server'], { stdio: 'ignore', detached: true }).unref(); } catch {}
  }
}

module.exports = { Adb };

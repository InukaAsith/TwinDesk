// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The bundled adb (Android platform-tools), for the phone's wireless debugging: pairing with
// its code, connecting, shell commands, pushing scrcpy-server and port forwards. The built app has
// it in Resources/adb (build-app.sh).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const adbmdns = require('../shared/adbmdns.js');

// A developer's own adb comes first: the one named by ADB (scrcpy's setting), else the Android
// SDK's platform-tools, which Flutter and Android Studio use, else Homebrew's (the
// android-platform-tools cask, as scrcpy's install notes have it). Two different adb builds on
// one machine keep killing each other's server on port 5037, dropping every device on both
// sides. The bundled one is for everyone else.
function findAdb() {
  const candidates = [
    process.env.ADB,
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
    path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    process.resourcesPath && path.join(process.resourcesPath, 'adb', 'adb'),
    path.join(__dirname, 'vendor', 'adb', 'adb'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function findServer() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'scrcpy-server'),
    path.join(__dirname, 'vendor', 'scrcpy-server'),
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
    return r.out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2).map(([serial, state]) => ({ serial, state }));
  }

  // The phone's wireless debugging services: [{name, type: 'pairing'|'connect', address, port}].
  // adb's own mDNS often sees nothing where the system's does, so ours (shared/adbmdns.js, which
  // also keeps the phone's announcements) and Bonjour's cache count too.
  async mdns() {
    this.wake();
    const [r, ours, cached] = await Promise.all([this.run(['mdns', 'services'], { timeout: 5000 }), adbmdns.query(), bonjour()]);
    const out = [];
    for (const l of r.out.split('\n')) {
      const m = /^(\S+)\s+_adb-tls-(pairing|connect)\._tcp\.?\s+([\d.]+):(\d+)/.exec(l.trim());
      if (m) out.push({ name: m[1], type: m[2], address: m[3], port: Number(m[4]) });
    }
    for (const s of [...ours, ...cached]) if (!out.some((o) => o.type === s.type && o.address === s.address && o.port === s.port)) out.push(s);
    return out;
  }

  // macOS's Local Network privacy judges the adb server by whoever started it. One started
  // before TwinDesk (a terminal, Android Studio, a dev run) is refused the LAN ("No route to
  // host") even with TwinDesk allowed, so the first time that happens we start our own and retry.
  async _lan(args, timeout) {
    let r = await this.run(args, { timeout });
    if (/no route to host/i.test(`${r.out}${r.err}`) && !this.restarted) {
      this.restarted = true;
      console.log('[adb] no route to host: restarting the adb server from TwinDesk');
      await this.run(['kill-server'], { timeout: 5000 });
      await this.run(['start-server'], { timeout: 10000 });
      r = await this.run(args, { timeout });
    }
    return r;
  }

  async pair(address, port, code) {
    const r = await this._lan(['pair', `${address}:${port}`, String(code)], 20000);
    const text = `${r.out}${r.err}`;
    return { ok: /Successfully paired/i.test(text), text: text.trim() };
  }

  async connect(address, port) {
    const r = await this._lan(['connect', `${address}:${port}`], 10000);
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
}

// The Mac's Bonjour cache (dns-sd), which keeps the phone's announcements from before we asked:
// browse each service type, resolve each name to host:port, the host to its IPv4 address.
function dnssd(args, ms, pattern) {
  return new Promise((resolve) => {
    const out = [];
    let buf = '';
    let p;
    try {
      p = spawn('/usr/bin/dns-sd', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(out);
    }
    p.on('error', () => {});
    p.stdout.on('data', (d) => {
      buf += d;
      for (let k; (k = buf.indexOf('\n')) >= 0; buf = buf.slice(k + 1)) {
        const m = pattern.exec(buf.slice(0, k));
        if (m) out.push(m);
      }
    });
    setTimeout(() => {
      p.kill();
      resolve(out);
    }, ms);
  });
}

async function bonjour() {
  const all = await Promise.all(['connect', 'pairing'].map(async (type) => {
    const svc = `_adb-tls-${type}._tcp`;
    const names = [...new Set((await dnssd(['-B', svc, 'local.'], 700, /\sAdd\s.*_adb-tls-\w+\._tcp\.\s+(.+)$/)).map((m) => m[1].trim()))];
    return Promise.all(names.slice(0, 8).map(async (name) => {
      const at = (await dnssd(['-L', name, svc, 'local.'], 700, /can be reached at (\S+?)\.?:(\d+)/))[0];
      if (!at) return null;
      const ip = (await dnssd(['-G', 'v4', at[1]], 700, /\sAdd\s.*\s(\d+\.\d+\.\d+\.\d+)\s/))[0];
      return ip ? { name, type, address: ip[1], port: Number(at[2]) } : null;
    }));
  }));
  return all.flat().filter(Boolean);
}

module.exports = { Adb };

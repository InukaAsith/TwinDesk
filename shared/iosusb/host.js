// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// An iPhone's or iPad's screen over its USB cable, on a PC (AirPlay & SMB › iPhone over USB). Loaded
// only when asked (shared/airplay/viewer.js requires it on the first use), and nothing runs until
// then: no polling, no process. While mirroring, twindesk-iosusb.exe (windows-helper/iosusb) moves the
// bytes and qt.js speaks the protocol; the picture and sound go to the AirPlay window.
//
// Needs, on the PC: Apple's USB driver (Apple Devices from the Microsoft Store, or iTunes), and
// libusb-win32's filter on top of it. setup() downloads libusb-win32 1.4.0.2 (signed; LGPL, from its
// GitHub releases, checked against its SHA-256), unpacks it under the app's data folder, and adds the
// filter to the plugged-in phones (install-filter, once, as administrator), then restarts them.
//
// iosUsb({dir}) → EventEmitter
//   .status() → Promise<{supported, lib, devices: [{id, name, filter}], usb: [{serial, qt}], why}>
//   .setup() → Promise<{ok, why}>    .start() → Promise<{ok, why}>    .stop()    .live
// Events: 'config' | 'frame' | 'audio' (qt.js's) | 'live' | 'end' ({why})
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { execFile, spawn } = require('child_process');
const { QtSession } = require('./qt.js');

const EXE = process.env.TWD_IOSUSB_EXE || path.join(__dirname, '..', '..', 'windows-helper', 'bin', 'twindesk-iosusb.exe');
const LIBUSB = {
  version: '1.4.0.2',
  url: 'https://github.com/mcuee/libusb-win32/releases/download/release_1.4.0.2/libusb-win32-bin-1.4.0.2.zip',
  sha256: '00004c92cdb99be36e17fb2377165eb97e63b48ba895bfc04a642ea9c3e26d94',
};

const run = (file, args, o = {}) => new Promise((resolve) => {
  execFile(file, args, { timeout: 20000, windowsHide: true, maxBuffer: 4 << 20, ...o }, (err, out, errOut) => resolve({ err, out: String(out || ''), errOut: String(errOut || '') }));
});

function iosUsb(o) {
  const ev = new EventEmitter();
  const base = path.join(o.dir, 'libusb-win32');
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const binDir = path.join(base, `libusb-win32-bin-${LIBUSB.version}`, 'bin', arch);
  const env = () => ({ ...process.env, TWD_LIBUSB0: process.env.TWD_LIBUSB0 || path.join(binDir, 'libusb0.dll') });
  let proc = null;
  let qt = null;

  // The libusb0 kernel driver Windows has, by its file version ('' none). It must be the one our
  // libusb0.dll goes with: another app's older driver (or a broken install of it) times out every
  // transfer, so Set up puts ours in its place.
  async function driverVersion() {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'libusb0.sys');
    if (!fs.existsSync(sys)) return '';
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:TWD_SYS).VersionInfo.FileVersion'], { env: { ...process.env, TWD_SYS: sys } });
    return r.out.trim();
  }

  async function status() {
    if (process.platform !== 'win32') return { supported: false, lib: false, devices: [], usb: [], why: 'platform' };
    if (!fs.existsSync(EXE)) return { supported: false, lib: false, devices: [], usb: [], why: 'noexe' };
    const [r, driver] = await Promise.all([run(EXE, ['status'], { env: env() }), driverVersion()]);
    let v = null;
    try { v = JSON.parse(r.out.trim().split('\n').pop()); } catch (_) {}
    if (!v) return { supported: true, lib: false, devices: [], usb: [], driver, why: r.err ? r.err.message : 'status' };
    // Ready: the filter on, our driver, and libusb sees the phone.
    const ready = (v.usb || []).length > 0 && driver === LIBUSB.version;
    return { supported: true, why: '', driver, ready, ...v };
  }

  async function download() {
    if (fs.existsSync(path.join(binDir, 'install-filter.exe'))) return;
    fs.mkdirSync(base, { recursive: true });
    const res = await fetch(LIBUSB.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download: HTTP ${res.status}`);
    const zip = Buffer.from(await res.arrayBuffer());
    const sum = crypto.createHash('sha256').update(zip).digest('hex');
    if (sum !== LIBUSB.sha256) throw new Error('download: the file isn’t the expected one');
    const file = path.join(base, 'libusb-win32.zip');
    fs.writeFileSync(file, zip);
    // Windows' own tar (bsdtar) reads zip files.
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const r = await run(tar, ['-xf', file, '-C', base]);
    try { fs.unlinkSync(file); } catch (_) {}
    if (r.err || !fs.existsSync(path.join(binDir, 'install-filter.exe'))) throw new Error('unpack failed');
  }

  // The filter on each phone (by its hardware id), then the phone restarted so the filter loads.
  async function setup() {
    try {
      const st = await status();
      if (!st.supported) return { ok: false, why: st.why };
      const phones = st.devices || [];
      if (!phones.length) return { ok: false, why: 'nodevice' };
      await download();
      const lines = ['@echo off'];
      // Our driver, when Windows has another version (it's used once the phone restarts).
      if (st.driver !== LIBUSB.version) lines.push('copy /y "%~dp0libusb0.sys" "%SystemRoot%\\System32\\drivers\\libusb0.sys" >nul');
      for (const d of phones) {
        const hwid = d.id.split('\\').slice(0, 2).join('\\');
        if (!/^USB\\VID_05AC&PID_[0-9A-F]{4}$/i.test(hwid) || /["%^]/.test(d.id)) continue;
        lines.push(`"%~dp0install-filter.exe" install "--device=${hwid}"`);
        // Only on the phone itself: its interfaces (photos, usbmux) keep their own drivers alone.
        for (let i = 0; i < 4; i++) lines.push(`"%~dp0install-filter.exe" uninstall "--device=${hwid}&MI_0${i}" >nul 2>&1`);
        lines.push(`pnputil /restart-device "${d.id}"`);
      }
      const script = path.join(binDir, 'twindesk-filter.cmd');
      fs.writeFileSync(script, lines.join('\r\n') + '\r\n');
      // One administrator prompt for all of it.
      const ps = `Start-Process -FilePath $env:ComSpec -ArgumentList '/c', ('"' + $env:TWD_SCRIPT + '"') -Verb RunAs -Wait -WindowStyle Hidden`;
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 180000, env: { ...process.env, TWD_SCRIPT: script } });
      if (r.err) return { ok: false, why: /cancel/i.test(r.errOut) ? 'cancelled' : 'admin' };
      // The phone comes back on the bus with the filter: wait for libusb to see it.
      for (let i = 0; i < 20; i++) {
        await new Promise((ok) => setTimeout(ok, 500));
        const s = await status();
        if (s.ready) return { ok: true, why: '' };
      }
      return { ok: false, why: 'replug' };
    } catch (e) {
      return { ok: false, why: e.message };
    }
  }

  function start(serial = '') {
    if (proc) return Promise.resolve({ ok: true, why: '' });
    return new Promise((resolve) => {
      let done = false;
      const settle = (v) => { if (!done) { done = true; resolve(v); } };
      const p = spawn(EXE, ['run', serial], { env: env(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      proc = p;
      qt = new QtSession((b) => { if (p.stdin.writable) p.stdin.write(b); });
      for (const e of ['config', 'frame', 'audio']) qt.on(e, (x) => ev.emit(e, x));
      qt.on('warn', (w) => console.warn('[iosusb]', w));
      qt.on('closed', () => { try { p.stdin.end(); } catch (_) {} });
      let why = '';
      let errBuf = '';
      p.stderr.on('data', (d) => {
        errBuf += d;
        let i;
        while ((i = errBuf.indexOf('\n')) >= 0) {
          const line = errBuf.slice(0, i).trim();
          errBuf = errBuf.slice(i + 1);
          let m = null;
          try { m = JSON.parse(line); } catch (_) { continue; }
          if (m.t === 'debug') console.log('[iosusb]', m.text);
          if (m.t === 'ready') { ev.live = true; ev.emit('live', { serial: m.serial }); settle({ ok: true, why: '' }); }
          if (m.t === 'error') { why = m.why; console.warn('[iosusb]', m.why, m.detail); settle({ ok: false, why: m.why, detail: m.detail }); }
        }
      });
      p.stdout.on('data', (d) => qt && qt.feed(d));
      p.stdin.on('error', () => {});
      p.on('error', (e) => { why = why || e.message; settle({ ok: false, why: e.message }); });
      p.on('exit', () => {
        if (proc === p) { proc = null; qt = null; }
        const was = ev.live;
        ev.live = false;
        settle({ ok: false, why: why || 'exit' });
        if (was) ev.emit('end', { why });
      });
    });
  }

  // Ask the phone to stop, then let the helper put it back (end of stdin); kill it if it hangs.
  function stop() {
    const p = proc;
    if (!p) return;
    if (qt) qt.close();
    setTimeout(() => { try { p.stdin.end(); } catch (_) {} }, 1500);
    setTimeout(() => { if (p.exitCode == null) try { p.kill(); } catch (_) {} }, 6000);
  }

  ev.live = false;
  ev.status = status;
  ev.setup = setup;
  ev.start = start;
  ev.stop = stop;
  return ev;
}

module.exports = { iosUsb, LIBUSB };

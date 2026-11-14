// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What the machine node (headless.js) gives for require('electron'): it runs as plain Node
// (ELECTRON_RUN_AS_NODE) at the login screen, with no windows and no display. app.getPath() is the
// machine folder (TWINDESK_MACHINE_DIR: /var/lib/twindesk, %ProgramData%\TwinDesk\machine), so store.js
// and identity.js read the copy of the person's settings and certificate that System-wide made
// (linux/fullkvm/install.sh, Windows' twindesk-fullkvm.exe --apply). The monitors: the app's own when
// System-wide was turned on (fullkvm-displays.json, written by manager.js), else, on Linux, the
// kernel's (DRM), as no display server is ours.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const DIR = process.env.TWINDESK_MACHINE_DIR || '/var/lib/twindesk';
const OS = path.join(__dirname, '..', '..', process.platform === 'win32' ? 'windows' : 'linux');
const pkg = (() => { try { return require(path.join(OS, 'package.json')); } catch (_) { return { version: '0.0.0' }; } })();

// The app's displays as it saw them (manager.js: Electron's bounds), or null.
function saved() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(DIR, 'fullkvm-displays.json'), 'utf8'));
    if (!Array.isArray(list) || !list.length) return null;
    return list.map((d, i) => ({ id: d.id || i + 1, label: d.label || 'screen', bounds: d.bounds, workArea: d.bounds, scaleFactor: d.scaleFactor || 1, rotation: 0 }));
  } catch (_) { return null; }
}

// Connected outputs and their first (preferred) mode, side by side in name order: { id, bounds }.
function drmDisplays() {
  const out = [];
  let x = 0;
  let names = [];
  try { names = fs.readdirSync('/sys/class/drm').filter((n) => /^card\d+-/.test(n)).sort(); } catch (_) { /* no DRM */ }
  for (const n of names) {
    try {
      if (fs.readFileSync(path.join('/sys/class/drm', n, 'status'), 'utf8').trim() !== 'connected') continue;
      const m = /^(\d+)x(\d+)/.exec(fs.readFileSync(path.join('/sys/class/drm', n, 'modes'), 'utf8'));
      if (!m) continue;
      const w = Number(m[1]), h = Number(m[2]);
      out.push({ id: out.length + 1, label: n, bounds: { x, y: 0, width: w, height: h }, workArea: { x, y: 0, width: w, height: h }, scaleFactor: 1, rotation: 0 });
      x += w;
    } catch (_) { /* not readable */ }
  }
  return out;
}

const FALLBACK = [{ id: 1, label: 'screen', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, rotation: 0 }];
function displays() {
  if (process.platform !== 'win32') { const d = drmDisplays(); if (d.length) return d; }
  return saved() || FALLBACK;
}

const screen = Object.assign(new EventEmitter(), {
  getAllDisplays: displays,
  getPrimaryDisplay: () => displays()[0],
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
});

const app = Object.assign(new EventEmitter(), {
  isPackaged: true,
  getPath: (name) => (name === 'temp' ? os.tmpdir() : name === 'logs' ? path.join(DIR, 'logs') : DIR),
  getVersion: () => pkg.version,
  getName: () => 'TwinDesk',
  getLocale: () => 'en',
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  quit: () => process.exit(0),
  exit: (c) => process.exit(c || 0),
});

class Notification { show() {} static isSupported() { return false; } }
const none = new Proxy({}, { get: () => undefined });

module.exports = {
  app,
  screen,
  powerMonitor: new EventEmitter(),
  nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: true, themeSource: 'system' }),
  Notification,
  ipcMain: { handle() {}, on() {}, removeHandler() {} },
  shell: { openPath: async () => '', openExternal: async () => {} },
  // Not here: windows, utilityProcess (fx2 goes on in this process), net. No sealing: the machine
  // folder is the service's own (System-wide wrote the certificate's passphrase there unsealed).
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => String(b) },
  BrowserWindow: undefined,
  utilityProcess: undefined,
  net: undefined,
  clipboard: none,
  displays,
  drmDisplays,
};

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Full KVM on Linux, the app's side (docs/full-kvm.md), the Full KVM build only (main.js attaches
// it when shared/edition.js says so): the Full KVM tab's state and its Off / Signed in / Always,
// which install.sh carries out as root through pkexec (one approval per change).
//   require('./fullkvm/manager.js').attach({ helper })
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { app, ipcMain, session } = require('electron');

const UNIT = '/etc/systemd/system/twindesk-fullkvm.service';
const CONF = '/etc/twindesk/fullkvm.json';
const SCRIPT = path.join(__dirname, 'install.sh');
const APP_ROOT = path.join(__dirname, '..', '..');
const MODES = ['off', 'simple', 'system'];

function run(cmd, args, ms = 10000) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: ms, maxBuffer: 1 << 20 }, (err, out, errOut) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(out || ''), err: String(errOut || '').trim() })));
}

function readMode() {
  if (!fs.existsSync(UNIT)) return 'off';
  try { return JSON.parse(fs.readFileSync(CONF, 'utf8')).mode === 'system' ? 'system' : 'simple'; } catch (_) { return 'simple'; }
}

let helper = null;
let lastError = '';

async function state() {
  const mode = readMode();
  const active = mode !== 'off' && (await run('systemctl', ['is-active', 'twindesk-fullkvm.service'])).out.trim() === 'active';
  return { os: 'linux', mode, active, connected: !!(helper && helper.viaService), error: lastError };
}

// install.sh as root: its text through `pkexec sh -c` (inside an AppImage root can't read our mount).
async function asRoot(args) {
  const script = fs.readFileSync(SCRIPT, 'utf8');
  const r = await run('pkexec', ['sh', '-c', script, 'install.sh', ...args], 180000);
  if (r.code === 0) return;
  throw new Error(r.code === 126 || r.code === 127 ? 'The administrator’s approval was not given' : r.err.split('\n').pop() || 'Full KVM could not be changed');
}

async function set(mode) {
  if (!MODES.includes(mode)) throw new Error('bad mode');
  const now = readMode();
  lastError = '';
  try {
    if (mode === now) return state();
    const cfg = app.getPath('userData'); // System-wide: our certificate, device id and pairings for the machine node
    if (mode === 'off') await asRoot(['remove']);
    else if (now === 'off') {
      const appImage = process.env.APPIMAGE;
      await asRoot(['install', mode, appImage || process.execPath, appImage ? '@APPDIR' : APP_ROOT, cfg]);
    } else await asRoot(['mode', mode, cfg]);
  } catch (e) {
    lastError = e.message;
  }
  return state();
}

function attach(ctx) {
  helper = ctx.helper;
  ipcMain.handle('fullkvm', (_e, op, arg) => (op === 'set' ? set(String(arg)) : state()));
  const preload = path.join(__dirname, 'preload.js');
  const ses = session.defaultSession;
  if (typeof ses.registerPreloadScript === 'function') ses.registerPreloadScript({ type: 'frame', id: 'twindesk-fullkvm', filePath: preload });
  else ses.setPreloads([...ses.getPreloads(), preload]);
}

module.exports = { attach, state, set };

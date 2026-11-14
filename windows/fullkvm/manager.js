// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Full KVM on Windows, the app's side (docs/full-kvm.md), the Full KVM build only (main.js attaches
// it when shared/edition.js says so): the Full KVM tab's state and its Off / Signed in / Always,
// which twindesk-fullkvm.exe carries out (--setup asks for an administrator: one UAC prompt per
// change). No PowerShell, no scripts: the service's own exe does it all (docs/full-kvm.md).
//   require('./fullkvm/manager.js').attach({ helper })
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { app, ipcMain, session, screen } = require('electron');

const EXE = path.join(__dirname, 'bin', 'twindesk-fullkvm.exe');
const MODES = ['off', 'simple', 'system'];
// What System-wide copies for the machine node (shared/fullkvm/headless.js): this computer as the
// others know it.
const FILES = ['device.json', 'paired.json', 'paired-mesh.json', 'pairing.json', 'pairings.json', 'multi.json', 'settings.json'];

function run(args, ms = 10000) {
  return new Promise((resolve) => execFile(EXE, args, { timeout: ms, windowsHide: true, maxBuffer: 1 << 20 }, (err, out, errOut) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(out || ''), err: String(errOut || '').trim() })));
}

let helper = null;
let lastError = '';

async function state() {
  let s = { mode: 'off', active: false };
  if (fs.existsSync(EXE)) {
    const r = await run(['--state']);
    try { s = JSON.parse(r.out); } catch (_) { /* not installed right */ }
  } else lastError = lastError || 'twindesk-fullkvm.exe is missing';
  return { os: 'win32', mode: MODES.includes(s.mode) ? s.mode : 'off', active: !!s.active, connected: !!(helper && helper.viaService), error: lastError };
}

// System-wide: what the machine node needs, in a folder of our own (the user's temp, only theirs)
// for --apply to copy to %ProgramData%\TwinDesk\machine. The certificate's passphrase goes unsealed:
// DPAPI (safeStorage) is this user's, LOCAL SERVICE couldn't open it; the machine folder is the
// service's and the administrators' only.
function stage() {
  const from = app.getPath('userData');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-fullkvm-'));
  for (const f of FILES) if (fs.existsSync(path.join(from, f))) fs.copyFileSync(path.join(from, f), path.join(dir, f));
  const id = path.join(from, 'identity');
  if (fs.existsSync(path.join(id, 'identity.pfx'))) {
    fs.mkdirSync(path.join(dir, 'identity'));
    fs.copyFileSync(path.join(id, 'identity.pfx'), path.join(dir, 'identity', 'identity.pfx'));
    const pass = require('../identity.js').readPass(path.join(id, 'identity.pass'));
    fs.writeFileSync(path.join(dir, 'identity', 'identity.pass'), pass);
  }
  const displays = screen.getAllDisplays().map((d, i) => ({ id: i + 1, label: d.label || 'screen', bounds: d.bounds, scaleFactor: d.scaleFactor }));
  fs.writeFileSync(path.join(dir, 'fullkvm-displays.json'), JSON.stringify(displays));
  return dir;
}

async function set(mode) {
  if (!MODES.includes(mode)) throw new Error('bad mode');
  lastError = '';
  const now = (await state()).mode;
  if (mode === now) return state();
  let dir = '';
  try {
    if (mode === 'system') dir = stage();
    // The client the service lets in: this exe (TwinDesk.exe; electron.exe in a checkout).
    const r = await run(['--setup', mode, process.execPath, dir || app.getPath('userData'), process.execPath], 180000);
    if (r.code === 5) throw new Error('The administrator’s approval was not given');
    if (r.code !== 0) throw new Error(r.err.split('\n').pop() || 'Full KVM could not be changed (' + r.code + ')');
  } catch (e) {
    lastError = e.message;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
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

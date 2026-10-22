// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Puts a downloaded update in place of the running app and starts it again (shared/updates.js).
//
// plan({ platform, file, pid, execPath, dir, env }) -> { kind, scriptPath, script, cmd, args } or
// { kind: 'manual', reason } when the app can't replace itself here (the file is opened instead).
// run(plan) writes the script and starts it detached, so it survives the app quitting; the script
// waits for the app (pid) to exit, replaces it, and starts it again, whatever happened, so the user
// is never left without the app.
//
// Only the app itself is replaced. The user's data folder (settings, pairings, keys) is never
// touched, and the replacement keeps the app's identity (same path and bundle id on macOS, same
// install folder on Windows, same file on Linux), so the permissions granted to the app stay.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX single quote
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell single quote

// The folder name of a .app bundle from the running executable (…/TwinDesk Mesh.app/Contents/MacOS/TwinDesk Mesh).
function macAppPath(execPath) {
  const m = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(execPath).replace(/\\/g, '/'));
  return m ? m[1] : '';
}

function writable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function winScript({ file, pid, exe, log }) {
  return [
    "$ErrorActionPreference = 'Continue'",
    `$log = ${psq(log)}`,
    "function Say($t) { try { Add-Content -LiteralPath $log -Value ((Get-Date -Format s) + ' ' + $t) } catch {} }",
    `Say 'waiting for the app (pid ${Number(pid) || 0}) to quit'`,
    `try { Wait-Process -Id ${Number(pid) || 0} -Timeout 60 -ErrorAction SilentlyContinue } catch {}`,
    // The installer is per-machine: it asks Windows for elevation (the usual prompt) and runs silent.
    'try {',
    `  $p = Start-Process -FilePath ${psq(file)} -ArgumentList '/S' -Verb RunAs -Wait -PassThru`,
    "  Say ('installer exit code ' + $p.ExitCode)",
    '} catch { Say ("installer did not run: " + $_.Exception.Message) }',
    // Start the app again whatever happened (the new one, or the old one when the installer was declined).
    `if (Test-Path -LiteralPath ${psq(exe)}) { Start-Process -FilePath ${psq(exe)}; Say 'started the app' }`,
    '',
  ].join('\r\n');
}

function macScript({ file, pid, app, log }) {
  const parent = path.posix.dirname(app);
  return [
    '#!/bin/bash',
    'set -u',
    `LOG=${sq(log)}`,
    'say() { echo "$(date +%H:%M:%S) $*" >> "$LOG"; }',
    `APP=${sq(app)}`,
    `DMG=${sq(file)}`,
    `NEW=${sq(parent + '/.TwinDesk-Mesh-update.app')}`,
    `OLD=${sq(parent + '/.TwinDesk-Mesh-old.app')}`,
    `PID=${Number(pid) || 0}`,
    'for i in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done',
    'MNT=$(mktemp -d /tmp/twindesk-mesh-mnt.XXXXXX)',
    'if hdiutil attach "$DMG" -nobrowse -readonly -noverify -mountpoint "$MNT" >/dev/null 2>&1; then',
    '  SRC=$(find "$MNT" -maxdepth 1 -name "*.app" | head -1)',
    '  rm -rf "$NEW" "$OLD"',
    // ditto keeps the signature, resources forks and attributes; no quarantine flag comes with a file we downloaded,
    // and it is removed anyway so Gatekeeper does not ask again.
    '  if [ -n "$SRC" ] && ditto "$SRC" "$NEW"; then',
    '    xattr -dr com.apple.quarantine "$NEW" 2>/dev/null',
    '    if mv "$APP" "$OLD" && mv "$NEW" "$APP"; then rm -rf "$OLD"; say "replaced $APP"',
    '    else say "could not swap the app"; [ -d "$OLD" ] && [ ! -d "$APP" ] && mv "$OLD" "$APP"; fi',
    '  else say "could not copy the new app"; fi',
    '  rm -rf "$NEW"',
    '  hdiutil detach "$MNT" -quiet -force >/dev/null 2>&1',
    'else say "could not open the disk image"; fi',
    'rmdir "$MNT" 2>/dev/null',
    'open "$APP"',
    '',
  ].join('\n');
}

function appImageScript({ file, pid, target, log }) {
  return [
    '#!/bin/sh',
    `LOG=${sq(log)}`,
    'say() { echo "$(date +%H:%M:%S) $*" >> "$LOG"; }',
    `TARGET=${sq(target)}`,
    `NEW=${sq(file)}`,
    `PID=${Number(pid) || 0}`,
    'i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 120 ]; do sleep 0.5; i=$((i+1)); done',
    'if cp "$NEW" "$TARGET.new" && chmod +x "$TARGET.new" && mv -f "$TARGET.new" "$TARGET"; then say "replaced $TARGET"; else say "could not replace $TARGET"; rm -f "$TARGET.new"; fi',
    '"$TARGET" >/dev/null 2>&1 &',
    '',
  ].join('\n');
}

function debScript({ file, pid, exe, log }) {
  return [
    '#!/bin/sh',
    `LOG=${sq(log)}`,
    'say() { echo "$(date +%H:%M:%S) $*" >> "$LOG"; }',
    `PID=${Number(pid) || 0}`,
    'i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 120 ]; do sleep 0.5; i=$((i+1)); done',
    // The package manager asks for the password through the desktop's own dialog.
    `if pkexec dpkg -i ${sq(file)} >> "$LOG" 2>&1; then say "installed"; else say "dpkg did not install it"; fi`,
    `${sq(exe)} >/dev/null 2>&1 &`,
    '',
  ].join('\n');
}

function plan({ platform, file, pid, execPath, dir, env = {} }) {
  const log = path.join(dir, 'update.log');
  if (platform === 'win') {
    const scriptPath = path.join(dir, 'update.ps1');
    const exe = path.join(path.dirname(execPath), 'TwinDesk Mesh.exe');
    return { kind: 'win', scriptPath, script: winScript({ file, pid, exe, log }), cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath], log };
  }
  if (platform === 'mac') {
    const app = macAppPath(execPath);
    if (!app) return { kind: 'manual', reason: 'This copy of TwinDesk isn’t an installed app.' };
    if (!/\.dmg$/i.test(file)) return { kind: 'manual', reason: 'Open the downloaded file to install it.' };
    if (!writable(path.posix.dirname(app))) return { kind: 'manual', reason: 'TwinDesk’s folder isn’t writable: install the opened disk image by hand.' };
    const scriptPath = path.join(dir, 'update.sh');
    return { kind: 'mac', scriptPath, script: macScript({ file, pid, app, log }), cmd: '/bin/bash', args: [scriptPath], log };
  }
  if (platform === 'linux') {
    const scriptPath = path.join(dir, 'update.sh');
    if (/\.AppImage$/i.test(file)) {
      const target = env.APPIMAGE;
      if (!target || !writable(path.dirname(target))) return { kind: 'manual', reason: 'TwinDesk isn’t running from an AppImage file here.' };
      return { kind: 'appimage', scriptPath, script: appImageScript({ file, pid, target, log }), cmd: '/bin/sh', args: [scriptPath], log };
    }
    if (/\.deb$/i.test(file)) {
      return { kind: 'deb', scriptPath, script: debScript({ file, pid, exe: execPath, log }), cmd: '/bin/sh', args: [scriptPath], log };
    }
  }
  return { kind: 'manual', reason: 'Open the downloaded file to install it.' };
}

// Writes the script and starts it on its own (it outlives this process).
function run(p) {
  fs.mkdirSync(path.dirname(p.scriptPath), { recursive: true });
  fs.writeFileSync(p.scriptPath, p.script, { mode: 0o755 });
  // Windows: a detached PowerShell has no console and never runs the script, and a plain child dies with
  // its parent in some job setups. `start` makes it an independent process that outlives the app.
  const child = p.kind === 'win'
    ? spawn('cmd.exe', ['/d', '/c', 'start', '""', '/min', p.cmd, ...p.args.map((a) => (/[\\/]/.test(a) ? `"${a}"` : a))],
      { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
    : spawn(p.cmd, p.args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

module.exports = { plan, run, macAppPath };

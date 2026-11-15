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

// System-wide: while seat0 isn't ours (the login screen, another person), the machine node or their
// TwinDesk is this computer to the mesh, and we must not hold the network (discovery's port, the links
// to the same devices with the same id). On X11 an app in a session off screen can't even notice: its
// main thread waits on the display (seen in the VM: the Mac's link went silent, discovery's queue
// filled). So a guard outside us does it: plain sh as this user (no AppImage mount, which ends with
// us), started with the app. With System-wide on and seat0 someone else's for 3 s, it ends TwinDesk;
// once seat0 is ours again it starts it as it was. TwinDesk quit by the person (seat0 ours) stays quit.
function guard() {
  const q = (a) => "'" + String(a).replace(/'/g, "'\\''") + "'";
  const exe = process.env.APPIMAGE || process.execPath;
  const again = 'cd ' + q(process.cwd()) + ' && exec ' + [exe, ...process.argv.slice(1)].map(q).join(' ');
  const sh = `pid=${process.pid}; uid=${process.getuid()}
ours() { s=$(loginctl show-seat seat0 -p ActiveSession --value 2>/dev/null); [ -z "$s" ] && return 0; [ "$(loginctl show-session "$s" -p User --value 2>/dev/null)" = "$uid" ]; }
system() { grep -q '"system"' ${CONF} 2>/dev/null && [ -e ${UNIT} ]; }
away=0
while kill -0 $pid 2>/dev/null; do
  sleep 1
  if system && ! ours; then away=$((away + 1)); else away=0; fi
  if [ $away -ge 3 ]; then
    kill -TERM $pid 2>/dev/null; sleep 2; kill -KILL $pid 2>/dev/null
    break
  fi
done
[ $away -ge 3 ] || exit 0
until ours; do sleep 2; done
sleep 1
${again}`;
  const { spawn } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Its own unit (systemd-run --user), so it outlives whatever started TwinDesk (a launcher's scope
  // is torn down with the app); plain detached where there is no user manager.
  const fs2 = require('fs');
  const bin = ['/usr/bin/systemd-run', '/bin/systemd-run'].find((f) => fs2.existsSync(f));
  const p = bin
    ? spawn(bin, ['--user', '--collect', '--quiet', '--unit', 'twindesk-fullkvm-guard-' + process.pid,
      // The unit has the user manager's environment, not ours: what starting TwinDesk again needs.
      ...['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'APPIMAGE', 'HOME', 'PATH', 'LANG']
        .filter((k) => env[k]).map((k) => '--setenv=' + k + '=' + env[k]),
      '/bin/sh', '-c', sh], { detached: true, stdio: 'ignore', env })
    : spawn('/bin/sh', ['-c', sh], { detached: true, stdio: 'ignore', env });
  p.on('exit', (code) => { if (code && bin) spawn('/bin/sh', ['-c', sh], { detached: true, stdio: 'ignore', env }).unref(); });
  p.unref();
}

function attach(ctx) {
  helper = ctx.helper;
  guard();
  ipcMain.handle('fullkvm', (_e, op, arg) => (op === 'set' ? set(String(arg)) : state()));
  const preload = path.join(__dirname, 'preload.js');
  const ses = session.defaultSession;
  if (typeof ses.registerPreloadScript === 'function') ses.registerPreloadScript({ type: 'frame', id: 'twindesk-fullkvm', filePath: preload });
  else ses.setPreloads([...ses.getPreloads(), preload]);
}

module.exports = { attach, state, set };

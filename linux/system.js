// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Linux checks for Setup and General: the desktop session, input access on Wayland and the
// firewall (ufw or firewalld must let 47800/tcp and 47801/udp in). Fixes ask for the password once
// through pkexec.
//
// Input access (#144): on Wayland the helper reads /dev/input/event* (to see the mouse cross an edge
// and the hotkey; it grabs the devices only while this computer drives the other) and writes
// /dev/uinput. Both belong to the `input` group. That group is given to the helper alone, never to
// the user: Fix installs a root-owned copy of it, setgid `input`, in /usr/local/libexec/twindesk (on
// NixOS the module's security.wrappers), and /dev/uinput goes to the `input` group. Other programs
// the user runs can't read the keyboard. Remove undoes everything Fix (or an older Fix, which added
// the user to `input`) did.
'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../shared/protocol.js');

const PORTS = { tcp: P.PORT, udp: P.DISCOVERY_PORT };

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(stdout || '').trim(), err: String(stderr || '').trim() });
    });
  });
}

// 'x11' | 'wayland' | 'unknown'; wsl: running in WSL (WSLg).
function session() {
  const t = String(process.env.XDG_SESSION_TYPE || '').toLowerCase();
  const type = t === 'x11' || t === 'wayland' ? t
    : process.env.WAYLAND_DISPLAY ? 'wayland' : process.env.DISPLAY ? 'x11' : 'unknown';
  let wsl = false;
  try { wsl = /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch (_) { /* not Linux */ }
  return { type, wsl, desktop: process.env.XDG_CURRENT_DESKTOP || '' };
}

// {ok, tool: 'ufw'|'firewalld'|'', message}. `fixed` = this app already ran the ufw fix (ufw's
// rules can't be read without root).
async function checkFirewall(fixed) {
  const ufw = await run('systemctl', ['is-active', 'ufw']);
  if (ufw.out === 'active') {
    return fixed ? { ok: true, tool: 'ufw', message: 'ufw lets TwinDesk in' }
      : { ok: false, tool: 'ufw', message: 'ufw is on and may block TwinDesk.' };
  }
  const fwd = await run('firewall-cmd', ['--state']);
  if (fwd.out === 'running') {
    const tcp = await run('firewall-cmd', ['--query-port=' + PORTS.tcp + '/tcp']);
    const udp = await run('firewall-cmd', ['--query-port=' + PORTS.udp + '/udp']);
    const ok = tcp.out === 'yes' && udp.out === 'yes';
    return { ok, tool: 'firewalld', message: ok ? 'firewalld lets TwinDesk in' : 'firewalld blocks TwinDesk.' };
  }
  return { ok: true, tool: '', message: 'No firewall is on' };
}

// Also mDNS (5353/udp): adb finds a phone's wireless debugging with it (phone-bridge.js).
async function fixFirewall(tool) {
  if (fs.existsSync('/etc/NIXOS')) {
    throw new Error('On NixOS, add networking.firewall.allowedTCPPorts = [ 47800 ]; and networking.firewall.allowedUDPPorts = [ 47801 5353 ]; in configuration.nix (or enable services.twindesk.enable).');
  }
  const script = tool === 'firewalld'
    ? 'firewall-cmd --permanent --add-port=' + PORTS.tcp + '/tcp --add-port=' + PORTS.udp + '/udp --add-service=mdns && firewall-cmd --reload'
    : 'ufw allow ' + PORTS.tcp + '/tcp && ufw allow ' + PORTS.udp + '/udp && ufw allow 5353/udp';
  const r = await run('pkexec', ['sh', '-c', script], 120000);
  if (r.ok) return true;
  throw new Error(r.code === 126 ? 'the password prompt was closed' : r.err || 'pkexec failed');
}

// '' or why the helper can't run in this session (helper.js canRun).
function inputBlocker(s) {
  if (s.type === 'x11') return process.env.DISPLAY ? '' : 'No X11 display';
  if (s.type !== 'wayland') return 'No desktop session';
  const st = inputAccess();
  if (!st.uinput) return 'Needs input access (Setup)';
  return '';
}

// ---- input access ----

const BIN_DIR = path.join(__dirname, '..', 'linux-helper', 'bin');
const HELPERS = ['macshare-linuxhelper', 'macshare-linuxhelper-multi'];
const SCOPED_DIR = '/usr/local/libexec/twindesk'; // Fix's setgid copies
const NIX_WRAPPERS = '/run/wrappers/bin'; // the NixOS module's (flake.nix security.wrappers)
const NIX_NAMES = { 'macshare-linuxhelper': 'twindesk-linuxhelper', 'macshare-linuxhelper-multi': 'twindesk-linuxhelper-multi' };
const UINPUT_RULE = 'KERNEL=="uinput", SUBSYSTEM=="misc", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"';
const nixos = () => fs.existsSync('/etc/NIXOS');

// The input group's id, or null.
function inputGid() {
  try {
    const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find((l) => l.startsWith('input:'));
    const gid = line ? Number(line.split(':')[2]) : NaN;
    return Number.isInteger(gid) ? gid : null;
  } catch (_) { return null; }
}

// Root's, setgid, group input: a helper with the input group of its own.
function setgidInput(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.uid === 0 && (st.mode & 0o2000) !== 0 && st.gid === inputGid();
  } catch (_) { return false; }
}

const digests = new Map(); // path -> {key (mtime, size), hex}
function digest(p) {
  const st = fs.statSync(p);
  const key = `${st.mtimeMs}:${st.size}`;
  const d = digests.get(p);
  if (d && d.key === key) return d.hex;
  const hex = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  digests.set(p, { key, hex });
  return hex;
}

// What to run for the bundled helper `bundled`: on Wayland, its setgid copy when there is one of
// this very version (an update makes Fix ask once more), else the bundled one.
function helperBin(bundled) {
  if (session().type !== 'wayland') return bundled;
  const name = path.basename(bundled);
  if (nixos()) {
    const w = path.join(NIX_WRAPPERS, NIX_NAMES[name] || name);
    return setgidInput(w) ? w : bundled;
  }
  const copy = path.join(SCOPED_DIR, name);
  try {
    if (setgidInput(copy) && digest(copy) === digest(bundled)) return copy;
  } catch (_) { /* not there */ }
  return bundled;
}

// Wayland: can the helper inject (/dev/uinput) and read the devices (/dev/input/event*)? Through
// its setgid copy (scoped), or because this user can (the input group from an older Fix: `group`,
// which lets every program the user runs read the keyboard). stale: a copy from another version.
function inputAccess() {
  const can = (p, mode) => { try { fs.accessSync(p, mode); return true; } catch (_) { return false; } };
  const gid = inputGid();
  const byGroup = (p, bit) => { try { const st = fs.statSync(p); return gid !== null && st.gid === gid && (st.mode & bit) !== 0; } catch (_) { return false; } };
  let events = [];
  try { events = fs.readdirSync('/dev/input').filter((n) => n.startsWith('event')).map((n) => '/dev/input/' + n); } catch (_) { /* none */ }
  const bundled = path.join(BIN_DIR, HELPERS[0]);
  const scoped = helperBin(bundled) !== bundled;
  const uinput = can('/dev/uinput', fs.constants.W_OK) || (scoped && byGroup('/dev/uinput', 0o020));
  const read = events.some((p) => can(p, fs.constants.R_OK) || (scoped && byGroup(p, 0o040)));
  const stale = !scoped && !nixos() && fs.existsSync(path.join(SCOPED_DIR, HELPERS[0]));
  const group = gid !== null && process.getgroups().includes(gid);
  return { uinput, read, scoped, stale, group };
}

function user() {
  const u = require('os').userInfo().username;
  if (!/^[a-z_][a-z0-9_.-]*\$?$/i.test(u)) throw new Error('unexpected user name');
  return u;
}

async function asRoot(script, args = []) {
  const r = await run('pkexec', ['sh', '-c', script, 'sh', ...args], 120000);
  if (r.ok) return true;
  throw new Error(r.code === 126 ? 'the password prompt was closed' : r.err || 'pkexec failed');
}

// Once, as root: uinput at boot and in the input group, and the helpers' setgid input copies. The
// user stays out of the group. Works at once (no logging out).
async function fixInput() {
  if (nixos()) {
    throw new Error('On NixOS, set programs.twindesk.enable = true; in configuration.nix (docs/nixos.md): it gives the helper alone the input group.');
  }
  const bins = HELPERS.map((n) => path.join(BIN_DIR, n)).filter((p) => fs.existsSync(p));
  if (!bins.length) throw new Error('the helper isn’t built');
  await asRoot([
    'set -e',
    'getent group input >/dev/null || groupadd -r input',
    'modprobe uinput || true',
    'echo uinput > /etc/modules-load.d/twindesk-uinput.conf',
    `echo '${UINPUT_RULE}' > /etc/udev/rules.d/70-twindesk-uinput.rules`,
    'udevadm control --reload-rules || true',
    'udevadm trigger --action=change --sysname-match=uinput || true',
    'udevadm settle --timeout=5 || true',
    `install -d -m 0755 -o root -g root ${SCOPED_DIR}`,
    `for f in "$@"; do install -m 2755 -o root -g input "$f" "${SCOPED_DIR}/$(basename "$f")"; done`,
  ].join('\n'), bins);
  digests.clear();
  return true;
}

// Takes this user out of the input group (an older Fix put it there). Counts from the next login.
async function leaveInputGroup() {
  await asRoot('gpasswd -d "$1" input >/dev/null 2>&1 || true', [user()]);
  return true;
}

// Undoes everything: the setgid copies, the uinput rules (Remote › Real gamepad's too: it asks
// again), loading uinput at boot, and this user in the input group.
async function removeInput() {
  if (nixos()) throw new Error('On NixOS, remove programs.twindesk from configuration.nix and rebuild (docs/nixos.md).');
  await asRoot([
    `rm -f ${HELPERS.map((n) => `${SCOPED_DIR}/${n}`).join(' ')}`,
    `rmdir ${SCOPED_DIR} 2>/dev/null || true`,
    'rm -f /etc/udev/rules.d/70-twindesk-uinput.rules /etc/udev/rules.d/60-twindesk-uinput.rules /etc/modules-load.d/twindesk-uinput.conf',
    'udevadm control --reload-rules || true',
    'udevadm trigger --action=change --sysname-match=uinput || true',
    '[ -e /dev/uinput ] && chown root:root /dev/uinput && chmod 0600 /dev/uinput || true', // udev leaves the old owner till a reboot
    'gpasswd -d "$1" input >/dev/null 2>&1 || true',
  ].join('\n'), [user()]);
  digests.clear();
  return true;
}

module.exports = { session, checkFirewall, fixFirewall, inputBlocker, inputAccess, fixInput, leaveInputGroup, removeInput, helperBin };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Linux checks for Setup and General: the desktop session, input access on Wayland
// (/dev/uinput writable and /dev/input readable, through a udev rule and the `input`
// group) and the firewall (ufw or firewalld must let 47800/tcp and 47801/udp in). Fixes ask for
// the password once through pkexec.
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
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

// Wayland: can we inject (/dev/uinput) and read the devices (/dev/input/event*)?
function inputAccess() {
  const can = (p, mode) => { try { fs.accessSync(p, mode); return true; } catch (_) { return false; } };
  let read = false;
  try { read = fs.readdirSync('/dev/input').some((n) => n.startsWith('event') && can('/dev/input/' + n, fs.constants.R_OK)); } catch (_) { /* none */ }
  return { uinput: can('/dev/uinput', fs.constants.W_OK), read };
}

// Once, as root: load uinput at boot, let the input group use it, put this user in that group.
// The group counts from the next login.
async function fixInput() {
  const user = require('os').userInfo().username;
  if (!/^[a-z_][a-z0-9_.-]*\$?$/i.test(user)) throw new Error('unexpected user name');
  const rule = 'KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"';
  const script = [
    'modprobe uinput || true',
    'echo uinput > /etc/modules-load.d/twindesk-uinput.conf',
    "echo '" + rule + "' > /etc/udev/rules.d/70-twindesk-uinput.rules",
    'udevadm control --reload-rules && udevadm trigger --sysname-match=uinput || true',
    'usermod -aG input ' + user,
  ].join(' && ');
  const r = await run('pkexec', ['sh', '-c', script], 120000);
  if (r.ok) return true;
  throw new Error(r.code === 126 ? 'the password prompt was closed' : r.err || 'pkexec failed');
}

module.exports = { session, checkFirewall, fixFirewall, inputBlocker, inputAccess, fixInput };

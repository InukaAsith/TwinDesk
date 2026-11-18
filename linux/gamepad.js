// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Remote › Real gamepad on Linux (shared/phone-remote.js's pad driver): the phone's gamepad as a
// uinput gamepad with an Xbox 360 controller's ids, which games and SDL take as one. The first time
// it's turned on (one password prompt, pkexec) a udev rule gives the person at the computer
// /dev/uinput, and the uinput module loads now and at every start. linux-helper/bin/twindesk-pad
// makes the gamepad and feeds it the pad states on its stdin. Loaded only when Real gamepad is on.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const WRITER = path.join(__dirname, '..', 'linux-helper', 'bin', 'twindesk-pad');
const DEV = '/dev/uinput';

const INSTALL = `
set -e
printf 'KERNEL=="uinput", SUBSYSTEM=="misc", MODE="0660", GROUP="input", TAG+="uaccess", OPTIONS+="static_node=uinput"\\n' > /etc/udev/rules.d/60-twindesk-uinput.rules
printf 'uinput\\n' > /etc/modules-load.d/twindesk-uinput.conf
modprobe uinput || true
udevadm control --reload-rules
udevadm trigger --action=change --sysname-match=uinput || true
udevadm settle --timeout=5 || true
`;

function writable() {
  try { fs.accessSync(DEV, fs.constants.W_OK); return true; } catch { return false; }
}

const driver = {
  name: 'TwinDesk Gamepad',
  kinds: ['xbox', 'ds4'], // or a PlayStation DualShock 4 (#266)

  async check() {
    if (!fs.existsSync(WRITER)) return { supported: false, message: 'Not in this build of TwinDesk' };
    return { supported: true, installed: writable() };
  },

  async install() {
    const r = await new Promise((resolve) => {
      execFile('pkexec', ['sh', '-c', INSTALL], { timeout: 120000 }, (err, _out, stderr) => resolve({ err, stderr: String(stderr || '').trim() }));
    });
    if (r.err) throw new Error(r.err.code === 126 ? 'The password prompt was closed' : (r.stderr.split('\n').pop() || 'pkexec failed'));
    for (let i = 0; i < 30 && !writable(); i++) await new Promise((res) => setTimeout(res, 100));
    if (!writable()) throw new Error('/dev/uinput is there but not this user’s yet: log out and in again');
  },

  feed(onExit, kind) {
    const p = spawn(WRITER, kind === 'ds4' ? ['ds4'] : [], { stdio: ['pipe', 'ignore', 'pipe'] });
    p.stderr.on('data', (d) => console.log('[pad] ' + String(d).trim()));
    p.on('exit', onExit);
    p.on('error', onExit);
    p.stdin.on('error', () => {});
    return p;
  },
};

module.exports = driver;

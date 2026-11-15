// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Portable (installer/build.js portable): one .exe, run without installing. electron-builder's
// portable launcher unpacks the app to a temporary folder each run and says where it came from
// (PORTABLE_EXECUTABLE_FILE). What differs from the installed app:
//
//   level     'full' when it runs as administrator, else 'limited'. Limited does what needs no
//             administrator; the steps that would ask for one (scripts\elevate.ps1: the firewall,
//             sharing a folder, Wake on LAN, SSH keys of administrators) say to run it as
//             administrator instead (ps.js). Full does those too, without a prompt.
//   never     what would install something on this PC: the virtual display, virtual camera and
//             gamepad drivers, OpenSSH Server, the calls' sound package and Full KVM (not in this
//             build). Even as administrator, these need the installed TwinDesk.
//   launcher  the login item and shortcuts start the portable .exe, not the unpacked copy.
//   updates   a new version is shown and downloaded by the browser; nothing installs itself.
// Settings stay in %APPDATA%\MacShare, as the installed app's (the same PC, the same pairings).
// TWINDESK_PORTABLE=1 makes a dev checkout behave as the portable build.
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const EXE = process.env.PORTABLE_EXECUTABLE_FILE || '';
const ON = !!EXE || process.env.TWINDESK_PORTABLE === '1';

// Scripts that install something: never in the portable build.
const INSTALLS = new Set(['vdd-install', 'vcam-install', 'vigem-install', 'sshd-setup']);

let admin = null;
// Elevated now? `fltmc` (the filter manager) answers only an administrator: no output, no prompt.
function isAdmin() {
  if (admin === null) {
    try {
      const r = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'fltmc.exe'), [], { windowsHide: true, timeout: 5000 });
      admin = r.status === 0;
    } catch (_) {
      admin = false;
    }
  }
  return admin;
}

const level = () => (isAdmin() ? 'full' : 'limited');

// An elevated script (ps.js scriptElevated): null when it may run, else why not.
function refuse(name) {
  if (!ON) return null;
  if (INSTALLS.has(name)) return 'Not in TwinDesk Portable: this installs a part of TwinDesk on the PC. Use the installed TwinDesk for it.';
  if (!isAdmin()) return 'TwinDesk Portable is running without administrator rights. Run it as administrator for this.';
  return null;
}

// For the window: the pill beside the name and General's Portable card.
function view() {
  if (!ON) return null;
  return { on: true, level: level(), exe: EXE };
}

module.exports = { ON, EXE, INSTALLS, isAdmin, level, refuse, view };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The About page's facts for all three apps: this app (version, Electron, Chrome, Node) and the
// computer it runs on (OS, CPU, memory). Read once at start; nothing here changes while running.
//
// aboutInfo(app) -> { app: {...}, pc: {...} }; LINKS are the only URLs the About page may open.
'use strict';

const os = require('os');
const fs = require('fs');

const LINKS = {
  portfolio: 'https://inukaasith.vercel.app',
  github: 'https://github.com/InukaAsith/TwinDesk',
  releases: 'https://github.com/InukaAsith/TwinDesk/releases',
  licence: 'https://github.com/InukaAsith/TwinDesk/blob/main/LICENSE',
};

const NAME = { darwin: 'TwinDesk for macOS', win32: 'TwinDesk for Windows', linux: 'TwinDesk for Linux' };
const THANKS = { darwin: 'DeskPad (virtual display header, MIT)' };
const ARCH = { x64: '64-bit Intel/AMD (x64)', arm64: 'ARM 64-bit (arm64)', ia32: '32-bit (x86)' };

function systemVersion() {
  try { return process.getSystemVersion(); } catch (_) { return os.release(); } // Electron only
}

// "macOS 14.5", "Windows 11 (build 22631)", "Ubuntu 24.04 LTS".
function osName() {
  const v = systemVersion();
  if (process.platform === 'darwin') return 'macOS ' + v;
  if (process.platform === 'win32') {
    const build = Number(String(v).split('.')[2]) || 0;
    return (build >= 22000 ? 'Windows 11' : 'Windows 10') + (build ? ' (build ' + build + ')' : '');
  }
  try {
    const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(fs.readFileSync('/etc/os-release', 'utf8'));
    if (m) return m[1];
  } catch (_) { /* no os-release */ }
  return 'Linux ' + os.release();
}

function gb(bytes) {
  return Math.round(bytes / (1024 ** 3)) + ' GB';
}

function aboutInfo(app) {
  const cpus = os.cpus() || [];
  const v = process.versions;
  return {
    app: {
      name: NAME[process.platform] || 'TwinDesk',
      thanks: THANKS[process.platform] || '',
      version: app.getVersion(),
      electron: v.electron || '',
      chrome: v.chrome || '',
      node: v.node || '',
      arch: ARCH[process.arch] || process.arch,
    },
    pc: {
      host: os.hostname(),
      os: osName(),
      kernel: os.type() + ' ' + os.release(),
      cpu: cpus.length ? cpus[0].model.replace(/\s+/g, ' ').trim() : '',
      cores: cpus.length,
      memory: gb(os.totalmem()),
      arch: ARCH[os.arch()] || os.arch(),
    },
  };
}

module.exports = { aboutInfo, LINKS };

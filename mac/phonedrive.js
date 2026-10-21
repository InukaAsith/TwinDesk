// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// An Android phone in Finder: shared/phonedrive.js's WebDAV server, which Finder mounts as a
// network volume (Locations, like any server). Basic auth with a password made per run.
'use strict';

const { execFile, execFileSync } = require('child_process');
const shared = require('../shared/phonedrive.js');

// Where the volume served on this port is mounted ('' if it isn't).
// (host: the phone's address, for its shared folder: shared/foldershare.js)
function mountedAt(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    if (!port) return resolve('');
    execFile('/sbin/mount', [], { timeout: 5000 }, (err, out) => {
      const line = String(out || '').split('\n').find((l) => l.includes(`${host}:${port}/`));
      const m = line && / on (.+?) \(/.exec(line);
      resolve(m ? m[1] : '');
    });
  });
}

// Finder's "Connect to Server" by AppleScript. osascript often doesn't come back after a WebDAV
// mount that worked, so the mount table says when it's there; resolves to the mount point.
function mount(url, { user, password, port, host }) {
  return new Promise((resolve, reject) => {
    let err = '';
    const child = execFile('/usr/bin/osascript', ['-e', `mount volume "${url}" as user name "${user}" with password "${password}"`], (e, out, errOut) => {
      if (e && !e.killed) err = String(errOut || e.message).trim();
    });
    const started = Date.now();
    const tick = async () => {
      const at = await mountedAt(port, host);
      if (at) {
        child.kill();
        return resolve(at);
      }
      if (err || Date.now() - started > 30000) {
        child.kill();
        return reject(new Error(err || 'Finder didn’t mount it'));
      }
      setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
  });
}

const mounter = {
  auth: 'basic',
  // Finder asks for these everywhere; they never exist on a phone (or live in memory: sidecar).
  hide: /^(\.metadata_never_index.*|\.Spotlight-V100|\.Trashes|\.fseventsd|\.hidden|\.localized|Backups\.backupdb|\.ql_disable.*|\.VolumeIcon\.icns|\.com\.apple\..*|mach_kernel|\.TemporaryItems)$/,
  sidecar: /^(\.DS_Store|\._.*)$/,
  mount,
  mountedAt,
  unmount: (at) => new Promise((res) => execFile('/usr/sbin/diskutil', ['unmount', 'force', at], { timeout: 15000 }, () => res())),
  unmountSync: (at) => execFileSync('/usr/sbin/diskutil', ['unmount', 'force', at], { timeout: 5000, stdio: 'ignore' }),
  reveal: (at) => execFile('/usr/bin/open', [at], () => {}),
};

class PhoneDrive extends shared.PhoneDrive {
  constructor(opts) {
    super({ ...opts, mounter });
  }
}

module.exports = { PhoneDrive, mounter };

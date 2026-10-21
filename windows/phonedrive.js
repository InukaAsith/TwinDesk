// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// An Android phone in Explorer: shared/phonedrive.js's WebDAV server, mapped to a drive letter
// through Windows' WebDAV client (the WebClient service; `net use` starts it). WebClient won't
// send Basic auth over plain http, so a secret in the path keeps other apps out. Explorer would
// name the drive after that path: the drive's label is set to the phone's name instead.
// WebClient refuses files over 50 MB unless FileSizeLimitInBytes says otherwise (the installer
// raises it to the 4 GB maximum).
'use strict';

const path = require('path');
const { execFile, execFileSync } = require('child_process');
const shared = require('../shared/phonedrive.js');

const SYS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const NET = path.join(SYS, 'net.exe');
const REG = path.join(SYS, 'reg.exe');
const LABELS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\MountPoints2';

const run = (file, args, timeout = 30000) => new Promise((resolve) => {
  execFile(file, args, { timeout, windowsHide: true }, (err, out, errOut) => resolve({ err, out: String(out || ''), errOut: String(errOut || '') }));
});

// The drive the volume on this port is mapped to ('Z:'), from `net use` (its words are in the
// system's language; the drive and the \\127.0.0.1@port\ path aren't).
// (host: the phone's address, for its shared folder: shared/foldershare.js)
async function mountedAt(port, host = '127.0.0.1') {
  if (!port) return '';
  const { out } = await run(NET, ['use'], 10000);
  const m = new RegExp(`([A-Z]:)\\s+\\\\\\\\${host.replace(/\./g, '\\.')}@${port}\\\\`, 'i').exec(out);
  return m ? m[1].toUpperCase() : '';
}

// The share as Explorer keys it: \\127.0.0.1@port\a\b -> ##127.0.0.1@port#a#b.
const labelKey = (url) => {
  const u = new URL(url);
  return `${LABELS}\\##${u.hostname}@${u.port}${decodeURIComponent(u.pathname).replace(/\//g, '#')}`;
};

async function mount(url, { port, volume, host }) {
  await run(REG, ['add', labelKey(url), '/v', '_LabelFromReg', '/t', 'REG_SZ', '/d', volume, '/f'], 5000);
  const r = await run(NET, ['use', '*', url, '/persistent:no'], 60000);
  const at = await mountedAt(port, host);
  if (at) return at;
  const why = `${r.errOut}\n${r.out}`.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  // 67: the network name can't be found, which is what a stopped or disabled WebClient gives.
  if (/\b67\b/.test(why.join(' '))) throw new Error('Windows’ WebClient service isn’t running (Services › WebClient: Manual or Automatic, then Start)');
  throw new Error(why.pop() || 'Windows didn’t map the drive');
}

async function unmount(at) {
  await run(NET, ['use', at, '/delete', '/y'], 15000);
}

const mounter = {
  auth: 'path',
  above: true,
  // Explorer looks for these in every folder; they're never on a phone (or live in memory: sidecar).
  hide: /^(\$RECYCLE\.BIN|System Volume Information|autorun\.inf)$/i,
  sidecar: /^(desktop\.ini|Thumbs\.db|ehthumbs(_vista)?\.db)$/i,
  mount,
  mountedAt,
  unmount,
  unmountSync: (at) => execFileSync(NET, ['use', at, '/delete', '/y'], { timeout: 5000, stdio: 'ignore', windowsHide: true }),
  reveal: (at) => execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [`${at}\\`], () => {}),
};

class PhoneDrive extends shared.PhoneDrive {
  constructor(opts) {
    super({ ...opts, mounter });
  }

  // The label's key is per port (a new one each run): it goes with the drive.
  async unmount(message) {
    const url = this.port && this.volume ? this._url() : '';
    await super.unmount(message);
    if (url && !this.mountPath) run(REG, ['delete', labelKey(url), '/f'], 5000);
  }
}

module.exports = { PhoneDrive, mounter };

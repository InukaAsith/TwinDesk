// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// An Android phone in the file manager: shared/phonedrive.js's WebDAV server, mounted with GVFS
// (`gio mount dav://…`, no root), so it shows in the sidebar of Files and the other GTK file
// managers and as a folder under $XDG_RUNTIME_DIR/gvfs for every app. GVFS would ask for a
// password on a terminal, so a secret in the path keeps other apps out instead.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const shared = require('../shared/phonedrive.js');

const gvfsDir = () => path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, 'gvfs');
const dav = (url) => url.replace(/^http:/, 'dav:');

const run = (args, timeout = 30000) => new Promise((resolve) => {
  const child = execFile('gio', args, { timeout }, (err, out, errOut) => resolve({ err, out: String(out || ''), errOut: String(errOut || '') }));
  child.stdin.end(); // never wait on a prompt
});

// GVFS's folder for the volume on this port ('' if it isn't mounted):
// dav:host=127.0.0.1,port=<port>,ssl=false,prefix=…
// (host: the phone's address, for its shared folder: shared/foldershare.js)
function mountedAt(port, host = '127.0.0.1') {
  if (!port) return Promise.resolve('');
  let names = [];
  try {
    names = fs.readdirSync(gvfsDir());
  } catch {}
  const name = names.find((n) => n.startsWith('dav:') && n.includes(`host=${host},`) && n.includes(`port=${port},`));
  return Promise.resolve(name ? path.join(gvfsDir(), name) : '');
}

async function mount(url, { port, host }) {
  const r = await run(['mount', dav(url)], 60000);
  if (r.err && r.err.code === 'ENOENT') throw new Error('GVFS’s gio is missing (install gvfs and gvfs-backends)');
  // The FUSE folder can show up a moment after gio returns.
  for (let i = 0; i < 20; i++) {
    const at = await mountedAt(port, host);
    if (at) return at;
    await new Promise((res) => setTimeout(res, 250));
  }
  const why = `${r.errOut}\n${r.out}`.trim().split('\n').map((s) => s.trim()).filter(Boolean).pop();
  throw new Error(why || (r.err ? 'GVFS didn’t mount it' : 'GVFS mounted it, but its folder isn’t there (gvfs-fuse missing?)'));
}

const mounter = {
  auth: 'path',
  hide: /^\.Trash(-\d+)?$/, // GVFS deletes on WebDAV for good, it never makes a trash there
  sidecar: /^\.directory$/, // KDE's folder settings
  mount,
  mountedAt,
  unmount: (at) => run(['mount', '-u', at], 15000),
  unmountSync: (at) => execFileSync('gio', ['mount', '-u', at], { timeout: 5000, stdio: 'ignore' }),
  reveal: (at) => execFile('xdg-open', [at], () => {}),
};

class PhoneDrive extends shared.PhoneDrive {
  constructor(opts) {
    super({ ...opts, mounter });
  }
}

module.exports = { PhoneDrive, mounter };

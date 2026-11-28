// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Windows 11's first-level right-click menu: "TwinDesk" › Send to <device> (one per paired device,
// as Send to's shortcuts, sendto.js) and Share folder (one folder, shared/foldermenu.js), where
// Windows 11 otherwise puts the classic menu (explorer.js) under Show more options. Windows shows
// only a packaged app's IExplorerCommand there, so the menu is windows-helper/shellmenu's DLL in a
// sparse package of its own, for this PC's architecture, registered for this user (pointing at where
// TwinDesk is; the installer trusts its certificate, the calls' one). The DLL reads what to start,
// its labels (in this app's language) and the devices from HKCU\Software\TwinDesk\ShellMenu, which
// this writes (only when they change). Windows 10, the Store's MSIX (which would declare its own) and
// the portable build keep the classic menu only.
'use strict';

const { app } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launcher, STORE } = require('./storepkg');
const Portable = require('./portable');

const ROOT = path.join(__dirname, '..'); // the package's external location, as the calls' (callaudio.js)
const BIN = path.join(ROOT, 'windows-helper', 'bin');
const PKG = 'TwinDesk.Shell';
const PKG_VERSION = '1.0.0.0'; // as windows-helper/shellmenu/AppxManifest.xml
const KEY = 'HKCU\\Software\\TwinDesk\\ShellMenu';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';

// Windows 11 is 10.0.22000 and later.
const win11 = () => process.platform === 'win32' && Number(String(os.release()).split('.')[2] || 0) >= 22000;

class ShellMenu {
  // t(text, vars): the app's translation. markFile: where the last registration is noted (version, place).
  constructor({ t, markFile }) {
    this.t = t || ((s) => s);
    this.markFile = markFile;
    this.msix = path.join(BIN, `twindesk-shell-${ARCH}.msix`);
    this.on = win11() && !STORE && !Portable.ON && fs.existsSync(this.msix) && fs.existsSync(path.join(BIN, `twindesk-shell-${ARCH}.dll`));
    this.written = {}; // value name -> what was written this run
  }

  // At start: the values the DLL reads, then the package (again only when its version or place changed).
  start() {
    if (!this.on) return;
    this.labels();
    const pre = app.isPackaged ? '' : ` "${path.resolve(process.argv[1] || app.getAppPath())}"`; // a dev copy: electron.exe <app folder>
    this._set('Command', 'REG_SZ', `"${launcher()}"${pre}`);
    this._set('Icon', 'REG_SZ', `${process.execPath},0`);
    let mark = {};
    try { mark = JSON.parse(fs.readFileSync(this.markFile, 'utf8')); } catch {}
    const force = mark.root !== ROOT || mark.arch !== ARCH; // moved, or another architecture's: registered again
    require('./ps').script('calls-register', { Name: PKG, Version: PKG_VERSION, Msix: this.msix, Root: ROOT, Force: force }, 90000)
      .then((out) => {
        let r = {};
        try { r = JSON.parse(String(out).trim().split('\n').pop()) || {}; } catch {}
        if (r.ok) { try { fs.writeFileSync(this.markFile, JSON.stringify({ version: PKG_VERSION, root: ROOT, arch: ARCH })); } catch {} }
        else console.log(`[shellmenu] package: ${r.error || 'not added'}`);
      })
      .catch((e) => console.log(`[shellmenu] package: ${e.message}`));
  }

  // The labels in the app's language (again when it changes).
  labels() {
    if (!this.on) return;
    this._set('Title', 'REG_SZ', 'TwinDesk');
    this._set('SendLabel', 'REG_SZ', this.t('Send to {name}', { name: '{name}' }));
    this._set('ShareLabel', 'REG_SZ', this.t('Share folder'));
  }

  // The paired devices, as sendto.js gets them: a name (one-to-one) or [{id, name}] (Multi-device).
  devices(peers) {
    if (!this.on) return;
    const list = (Array.isArray(peers) ? peers : peers ? [{ id: '', name: peers }] : [])
      .map((p) => ({ id: String(p.id || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64), name: String(p.name || '').replace(/[\x00-\x1f\\]/g, ' ').trim().slice(0, 80) }))
      .filter((p) => p.name)
      .slice(0, 10);
    if (!list.length) return this._del('Devices');
    this._set('Devices', 'REG_MULTI_SZ', list.map((p) => `${p.id}\t${p.name}`).join('\\0'));
  }

  _set(name, type, data) {
    if (this.written[name] === data) return;
    this.written[name] = data;
    execFile('reg.exe', ['add', KEY, '/v', name, '/t', type, '/d', data, '/f'], { windowsHide: true }, (e) => e && console.log(`[shellmenu] ${name}: ${e.message}`));
  }

  _del(name) {
    if (this.written[name] === null) return;
    this.written[name] = null;
    execFile('reg.exe', ['delete', KEY, '/v', name, '/f'], { windowsHide: true }, () => {});
  }
}

module.exports = { ShellMenu, win11 };

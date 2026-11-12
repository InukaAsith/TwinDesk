// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Explorer's right-click › TwinDesk (Show more options on Windows 11): one menu with
//   Send to phone        files and folders: the Send files flow, as Send to's shortcut (sendto.js)
//   Import from phone    a folder, or a folder's background: Phone Files opens, and what's saved
//                        from the phone goes into that folder (received.js redirectTo)
//   Capture from phone   the same: the phone's camera opens (cam.capture), every photo taken comes
//                        into that folder until the camera is closed there
// The keys are the user's own (HKCU\Software\Classes), written at start from one .reg file, and the
// uninstaller takes them away (installer.nsh). The commands start TwinDesk with --td <what> <path>;
// a running TwinDesk gets them through second-instance (main.js).
'use strict';

const { app } = require('electron');
const { execFile } = require('child_process');
const { launcher } = require('./storepkg');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { redirectTo, redirected } = require('../shared/received.js');

const ARG = '--td';
const IMPORT_MS = 10 * 60000;
const CAPTURE_MS = 20 * 60000;

class Explorer {
  // opts: phoneOn() → a phone is connected; send(msg) to it; on(type, fn) from it; goTab(tab);
  //   popup(kind, text, sub); onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.on('cam.capture', (m) => {
      if (m && m.on === false && (redirected() || {}).why === 'capture') {
        redirectTo('', 0);
        this.onChange();
      }
    });
  }

  // The menu in the registry (again at every start: the app may have moved).
  install() {
    const exe = launcher(); // the Store's MSIX: its alias (storepkg.js); the icon is this exe's
    const pre = app.isPackaged ? '' : `"${path.resolve(process.argv[1] || app.getAppPath())}" `; // a dev copy: electron.exe <app folder>
    const esc = (t) => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); // a .reg string's escapes
    const cmd = (args) => `"${esc(`"${exe}" ${pre}${args}`)}"`;
    const icon = `"${esc(process.execPath)},0"`;
    const key = (root, ...sub) => '[' + ['HKEY_CURRENT_USER', 'Software', 'Classes', root, 'shell', 'TwinDesk', ...sub].join('\\') + ']';
    const menu = (root, items) => [
      key(root), '"MUIVerb"="TwinDesk"', `"Icon"=${icon}`, '"SubCommands"=""', '',
      ...items.flatMap(([id, label, args, ico]) => [
        key(root, 'shell', id), `"MUIVerb"="${label}"`, `"Icon"="${esc(ico)}"`, '',
        key(root, 'shell', id, 'command'), `@=${cmd(args)}`, '',
      ]),
    ];
    const send = ['1send', 'Send to phone', '--send-files "%1"', 'shell32.dll,-16761'];
    const imp = (v) => ['2import', 'Import from phone', `${ARG} import "${v}"`, 'shell32.dll,-16752'];
    const cap = (v) => ['3capture', 'Capture from phone', `${ARG} capture "${v}"`, 'imageres.dll,-5359'];
    const reg = ['Windows Registry Editor Version 5.00', '',
      ...menu('*', [send]),
      ...menu('Directory', [send, imp('%1'), cap('%1')]),
      ...menu('Directory\\Background', [imp('%V'), cap('%V')]),
    ].join('\r\n');
    const file = path.join(os.tmpdir(), 'twindesk-explorer.reg');
    try {
      fs.writeFileSync(file, '﻿' + reg, 'utf16le');
    } catch (e) {
      return;
    }
    execFile('reg.exe', ['import', file], { windowsHide: true }, (err) => {
      fs.unlink(file, () => {});
      if (err) console.log('[explorer] menu: ' + err.message);
    });
  }

  // argv with --td <what> <folder>: true when it was ours.
  handle(argv) {
    const i = (argv || []).indexOf(ARG);
    if (i < 0) return false;
    const what = String(argv[i + 1] || '');
    const dir = String(argv[i + 2] || '').replace(/"$/, '');
    if (!path.isAbsolute(dir)) return true;
    if (what === 'import') this.import(dir);
    else if (what === 'capture') this.capture(dir);
    return true;
  }

  import(dir) {
    redirectTo(dir, IMPORT_MS, 'import');
    this.goTab('pfiles');
    if (!this.phoneOn()) this.popup('phoneOff', 'Connect your phone', 'Then choose files in Phone Files');
    this.onChange();
  }

  capture(dir) {
    if (!this.phoneOn()) {
      this.goTab('connection');
      return this.popup('phoneOff', 'Connect your phone', 'Capture from phone needs it');
    }
    redirectTo(dir, CAPTURE_MS, 'capture');
    this.send({ t: 'cam.capture', on: true });
    this.popup('camera', 'Take photos on your phone', 'They come into ' + path.basename(dir));
    this.onChange();
  }

  cancel() {
    const r = redirected();
    if (r && r.why === 'capture' && this.phoneOn()) this.send({ t: 'cam.capture', on: false });
    redirectTo('', 0);
    this.onChange();
  }

  get view() {
    const r = redirected();
    return r ? { dir: r.dir, name: path.basename(r.dir) || r.dir, why: r.why, until: r.until } : null;
  }
}

module.exports = { Explorer, ARG };

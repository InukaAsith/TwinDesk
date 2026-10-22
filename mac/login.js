// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Open at login. A packaged app uses the system login item; a dev checkout gets a
// LaunchAgent that starts this Electron with this folder and --hidden (no window, menu bar only).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const LABEL = 'org.macshare.mac';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function apply(on) {
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true, args: ['--hidden'] });
    return;
  }
  if (!on) {
    fs.rmSync(PLIST, { force: true });
    return;
  }
  const args = [process.execPath, app.getAppPath(), '--hidden'];
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${esc(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
`);
}

function isOn() {
  return app.isPackaged ? app.getLoginItemSettings().openAtLogin : fs.existsSync(PLIST);
}

module.exports = { apply, isOn };

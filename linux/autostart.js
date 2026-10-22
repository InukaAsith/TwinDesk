// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// "Open at login": an XDG autostart entry, ~/.config/autostart/twindesk.desktop, that
// starts TwinDesk in the tray (--hidden). It starts the AppImage itself when run from one (its
// path is in $APPIMAGE), else the installed binary, else (development) electron with this folder.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const file = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'twindesk.desktop');
const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : '"' + String(s).replace(/(["`$\\])/g, '\\$1') + '"');

function command() {
  if (process.env.APPIMAGE) return [process.env.APPIMAGE, '--hidden'];
  if (app.isPackaged) return [process.execPath, '--hidden'];
  return [process.execPath, app.getAppPath(), '--hidden'];
}

function get() {
  try {
    const t = fs.readFileSync(file(), 'utf8');
    return !/^Hidden=true$/m.test(t) && !/^X-GNOME-Autostart-enabled=false$/m.test(t);
  } catch (_) {
    return false;
  }
}

function set(on) {
  const f = file();
  if (!on) {
    try { fs.unlinkSync(f); } catch (_) { /* not there */ }
    return;
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=TwinDesk',
    'Comment=Share mouse, keyboard, clipboard and screens with your other computer',
    'Exec=' + command().map(quote).join(' '),
    'Icon=twindesk',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n'));
}

module.exports = { get, set };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// "Open at login": an XDG autostart entry, ~/.config/autostart/twindesk.desktop, that
// starts TwinDesk in the tray (--hidden). It starts the AppImage itself when run from one (its
// path is in $APPIMAGE), else the installed binary, else (development) electron with this folder.
// Through sh with stdout and stderr to /dev/null: a session start has no terminal, and a pipe nobody
// reads is what made the console logger loop (#162). refresh() at start rewrites an older entry.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const file = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'twindesk.desktop');
// The Exec key's quoting (a reserved character after a backslash, inside double quotes), then the
// desktop file's own string escape (a backslash doubled), which a reader undoes first; % is %% (field codes).
const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : '"' + String(s).replace(/(["`$\\])/g, '\\$1') + '"').replace(/\\/g, '\\\\').replace(/%/g, '%%');
const QUIET = 'exec "$0" "$@" >/dev/null 2>&1';

function command() {
  if (process.env.TWINDESK_BIN) return [process.env.TWINDESK_BIN, '--hidden'];
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

function entry() {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=TwinDesk',
    'Comment=Share mouse, keyboard, clipboard and screens with your other computer',
    'Exec=' + ['sh', '-c', QUIET, ...command()].map(quote).join(' '),
    'Icon=twindesk',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function set(on) {
  const f = file();
  if (!on) {
    try { fs.unlinkSync(f); } catch (_) { /* not there */ }
    return;
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, entry());
}

// An entry that's on but written by an older version (no redirect, or a moved AppImage): written again.
function refresh() {
  try {
    if (get() && fs.readFileSync(file(), 'utf8') !== entry()) fs.writeFileSync(file(), entry());
  } catch (_) { /* best effort */ }
}

module.exports = { get, set, refresh };

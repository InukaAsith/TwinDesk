// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The file managers' right-click menu gets "Send to <peer> (TwinDesk)" (port of
// windows/sendto.js): a script in Nautilus' and Caja's Scripts menu, a Nemo action, a Dolphin
// service menu and a Thunar custom action, each running `twindesk --send-files <paths>`. That copy
// of TwinDesk hands them to this one (second-instance) and they go with the Send files flow
// (filedrop.js, drop:'send'). The entries follow the paired computer's name and go when nothing is
// paired; only file managers that are installed get one.
'use strict';

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ARG = '--send-files';
const HOME = os.homedir();
const DATA = process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');
const CONFIG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
const UCA_ID = 'twindesk-send-files';

// Is a program on PATH?
function installed(cmd) {
  return String(process.env.PATH || '/usr/bin:/bin').split(':').some((d) => { try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch (_) { return false; } });
}

// The command that starts this TwinDesk: the AppImage, the installed binary, or electron + this folder.
function launcher() {
  if (process.env.APPIMAGE) return [process.env.APPIMAGE];
  return app.isPackaged ? [process.execPath] : [process.execPath, app.getAppPath()];
}

const sh = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const desk = (s) => (/[\s"'\\$`]/.test(s) ? '"' + String(s).replace(/["\\$`]/g, '\\$&') + '"' : s); // a desktop entry's Exec
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Nautilus and Caja pass the selection in an environment variable (full paths, one a line), else
// as names relative to the folder: either way the script hands TwinDesk absolute paths.
function script(name) {
  return `#!/bin/sh
# TwinDesk: send the selected files to ${name.replace(/\n/g, ' ')} (made by TwinDesk, ${ARG})
set -f
IFS='
'
sel="\${NAUTILUS_SCRIPT_SELECTED_FILE_PATHS:-\$CAJA_SCRIPT_SELECTED_FILE_PATHS}"
[ -n "$sel" ] && set -- $sel
for f; do case "$f" in /*) ;; *) f="$PWD/$f" ;; esac; set -- "$@" "$f"; shift; done
exec ${launcher().map(sh).join(' ')} ${ARG} "$@"
`;
}

class SendTo {
  // opts: fileDrop, link, peerName() → name | '', popup(kind, text, sub)
  constructor(opts) {
    Object.assign(this, opts);
    this.name = null; // the peer name our entries have now ('' = none)
    this.pending = null; // {paths, until}: started with --send-files before the link was up
    this.link.on('welcome', () => {
      const p = this.pending;
      this.pending = null;
      if (p && Date.now() < p.until) this._send(p.paths);
    });
  }

  // Keep the entries in step with the paired computer's name (called with every state push).
  sync(peer) {
    const name = peer ? String(peer).replace(/[/\\\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 80) : '';
    if (name === this.name) return;
    this.name = name;
    const label = 'Send to ' + name + ' (TwinDesk)';
    const exec = launcher().map(desk).join(' ') + ' ' + ARG + ' %F';
    try {
      // Scripts menus: the file name is the label.
      for (const [dir, cmd] of [[path.join(DATA, 'nautilus', 'scripts'), 'nautilus'], [path.join(CONFIG, 'caja', 'scripts'), 'caja']]) {
        this._clear(dir, (f) => f.endsWith(' (TwinDesk)'));
        if (name && installed(cmd)) write(path.join(dir, label), script(name), 0o755);
      }
      const nemo = path.join(DATA, 'nemo', 'actions', 'twindesk-send.nemo_action');
      if (name && installed('nemo')) {
        write(nemo, `[Nemo Action]\nName=${label}\nComment=Send the selected files with TwinDesk (${ARG})\nExec=${exec}\nIcon-Name=document-send\nSelection=notnone\nExtensions=any;\n`, 0o644);
      } else rm(nemo);
      // Dolphin: KDE Frameworks 6 and 5 look in different folders; service menus must be executable.
      const service = `[Desktop Entry]\nType=Service\nMimeType=all/all;\nActions=twindeskSend;\nX-KDE-Priority=TopLevel\n\n[Desktop Action twindeskSend]\nName=${label}\nIcon=document-send\nExec=${exec}\n`;
      for (const dir of [path.join(DATA, 'kio', 'servicemenus'), path.join(DATA, 'kservices5', 'ServiceMenus')]) {
        const f = path.join(dir, 'twindesk-send.desktop');
        if (name && installed('dolphin')) write(f, service, 0o755);
        else rm(f);
      }
      this._thunar(name && installed('thunar') ? label : '', exec);
    } catch (e) {
      console.warn('[sendto]', e.message);
    }
  }

  // Our scripts in a Scripts folder: the ones that run TwinDesk with --send-files.
  _clear(dir, match) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const f of names) {
      if (!match(f)) continue;
      const file = path.join(dir, f);
      try { if (fs.readFileSync(file, 'utf8').includes(ARG)) fs.rmSync(file, { force: true }); } catch (_) { /* not ours */ }
    }
  }

  // Thunar's custom actions (uca.xml): our <action> (by its unique-id) replaced, added or removed.
  _thunar(label, exec) {
    const file = path.join(CONFIG, 'Thunar', 'uca.xml');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { if (!label) return; }
    const ours = new RegExp('\\s*<action>(?:(?!</action>)[\\s\\S])*<unique-id>' + UCA_ID + '</unique-id>[\\s\\S]*?</action>', 'g');
    text = text.replace(ours, '');
    if (label) {
      const action = `\n<action>\n\t<icon>document-send</icon>\n\t<name>${xml(label)}</name>\n\t<unique-id>${UCA_ID}</unique-id>\n\t<command>${xml(exec)}</command>\n\t<description>Send the selected files with TwinDesk</description>\n\t<patterns>*</patterns>\n\t<directories/>\n\t<audio-files/>\n\t<image-files/>\n\t<other-files/>\n\t<text-files/>\n\t<video-files/>\n</action>`;
      if (!/<\/actions>/.test(text)) text = '<?xml version="1.0" encoding="UTF-8"?>\n<actions>\n</actions>\n';
      text = text.replace(/<\/actions>/, action + '\n</actions>');
    }
    write(file, text, 0o644);
  }

  // A command line (ours at start, or a second instance's): true when it was a Send to.
  handle(argv) {
    const list = Array.isArray(argv) ? argv : [];
    const at = list.indexOf(ARG);
    if (at < 0) return false;
    // Chromium may move its own switches around, so take every existing absolute path after it.
    const skip = new Set([process.execPath, app.getAppPath(), process.env.APPIMAGE || ''].map((x) => path.resolve(x)));
    const paths = list.slice(at + 1).filter((a) => typeof a === 'string' && !a.startsWith('--') && path.isAbsolute(a)
      && !skip.has(path.resolve(a)) && fs.existsSync(a)).slice(0, 1000);
    if (!paths.length) return true;
    if (this.link.status.state !== 'connected') {
      this.pending = { paths, until: Date.now() + 30000 }; // sent once the link is up
      this.popup('away', 'Not connected yet', 'Sending once ' + (this.peerName() || 'the other computer') + ' is connected');
      return true;
    }
    this._send(paths);
    return true;
  }

  _send(paths) {
    const r = this.fileDrop.sendBatch(paths, 'send');
    const who = this.peerName() || 'the other computer';
    if (!r) return this.popup('away', 'Nothing to send', 'Couldn’t read ' + (paths.length === 1 ? path.basename(paths[0]) : 'those items'));
    const n = r.items.length;
    this.popup('away', 'Sending ' + (n === 1 ? r.name : n + ' items') + ' to ' + who);
  }
}

function write(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
}

function rm(file) {
  try { fs.rmSync(file, { force: true }); } catch (_) { /* none */ }
}

module.exports = SendTo;

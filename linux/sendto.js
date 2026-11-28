// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The file managers' right-click menu gets "Send to <peer> (TwinDesk)" (port of
// windows/sendto.js): a script in Nautilus' and Caja's Scripts menu, a Nemo action, a Dolphin
// service menu and a Thunar custom action, each running `twindesk --send-files <paths>`. That copy
// of TwinDesk hands them to this one (second-instance) and they go with the Send files flow
// (filedrop.js, drop:'send'). The entries follow the paired computer's name and go when nothing is
// paired; only file managers that are installed get one.
// Share folder (TwinDesk), on folders, in the same file managers: `twindesk --td share <folder>`,
// which makes it the folder this computer shares with the phone (shared/foldermenu.js). Written
// once a run, paired or not; the entries name the flag so they're recognised as ours.
// Multi-device: one entry per paired computer, `--send-files --send-to=<id>`, and the files go to that
// device whichever is selected. One entry for the selected device was renamed and rewritten on every
// crossing, and sent to whichever device was selected by the time it ran (#313).
'use strict';

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ARG = '--send-files';
const TO = '--send-to='; // the device, in Multi-device
const HOME = os.homedir();
const DATA = process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share');
const CONFIG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
const UCA_ID = 'twindesk-send-files';
const SHARE = '--td share';
const SHARE_LABEL = 'Share folder (TwinDesk)';
const OLD_SHARE_LABELS = ['Share with phone (TwinDesk)']; // its name before shared folders: its scripts go
const SHARE_UCA = 'twindesk-share-folder';

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
function script(name, id) {
  return `#!/bin/sh
# TwinDesk: send the selected files to ${name.replace(/\n/g, ' ')} (made by TwinDesk, ${ARG})
set -f
IFS='
'
sel="\${NAUTILUS_SCRIPT_SELECTED_FILE_PATHS:-\$CAJA_SCRIPT_SELECTED_FILE_PATHS}"
[ -n "$sel" ] && set -- $sel
for f; do case "$f" in /*) ;; *) f="$PWD/$f" ;; esac; set -- "$@" "$f"; shift; done
exec ${launcher().map(sh).join(' ')} ${ARG}${id ? ' ' + sh(TO + id) : ''} "$@"
`;
}

// Share folder in Nautilus' and Caja's Scripts menu: the selected folder (or the open one).
function shareScript() {
  return `#!/bin/sh
# TwinDesk: share the selected folder with the phone (made by TwinDesk, ${SHARE})
sel="\${NAUTILUS_SCRIPT_SELECTED_FILE_PATHS:-\$CAJA_SCRIPT_SELECTED_FILE_PATHS}"
f="\${sel%%
*}"
[ -n "$f" ] || f="$1"
[ -n "$f" ] || f="$PWD"
case "$f" in /*) ;; *) f="$PWD/$f" ;; esac
[ -d "$f" ] || exit 0
exec ${launcher().map(sh).join(' ')} ${SHARE} "$f"
`;
}

class SendTo {
  // opts: fileDrop, link, peerName() → name | '', popup(kind, text, sub)
  //   bus, nameOf(id): Multi-device (fileDrop is the FileDropSet: unit(id) sends to that device)
  constructor(opts) {
    Object.assign(this, opts);
    this.key = null; // the entries we made last ('' = none)
    this.pending = null; // {paths, until, to}: started with --send-files before the link was up
    const flush = (id) => {
      const p = this.pending;
      if (!p || (p.to && p.to !== id)) return;
      this.pending = null;
      if (Date.now() < p.until) this._send(p.paths, p.to);
    };
    if (this.bus) this.bus.onPeer('welcome', (id) => flush(id));
    else this.link.on('welcome', () => flush(null));
  }

  // Keep the entries in step with the paired computers (called with every state push): a name (one-to-one),
  // or [{id, name}] (Multi-device, one each). Written only when they changed.
  sync(peers) {
    const list = (Array.isArray(peers) ? peers : peers ? [{ id: '', name: peers }] : [])
      .map((p) => ({ id: String(p.id || '').replace(/[^A-Za-z0-9._-]/g, ''), name: String(p.name || '').replace(/[/\\\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 80) }))
      .filter((p) => p.name);
    if (!this.shared) { this.shared = true; this._share(); }
    const key = list.map((p) => p.id + '=' + p.name).join('|');
    if (key === this.key) return;
    this.key = key;
    const entries = list.map((p, i) => ({
      ...p, label: 'Send to ' + p.name + ' (TwinDesk)', n: i,
      exec: launcher().map(desk).join(' ') + ' ' + ARG + (p.id ? ' ' + TO + p.id : '') + ' %F',
    }));
    try {
      // Scripts menus: the file name is the label.
      for (const [dir, cmd] of [[path.join(DATA, 'nautilus', 'scripts'), 'nautilus'], [path.join(CONFIG, 'caja', 'scripts'), 'caja']]) {
        this._clear(dir, (f) => f.endsWith(' (TwinDesk)'));
        if (installed(cmd)) for (const e of entries) write(path.join(dir, e.label), script(e.name, e.id), 0o755);
      }
      const nemoDir = path.join(DATA, 'nemo', 'actions');
      this._clear(nemoDir, (f) => /^twindesk-send(-\d+)?\.nemo_action$/.test(f));
      if (installed('nemo')) {
        for (const e of entries) {
          write(path.join(nemoDir, e.n ? `twindesk-send-${e.n}.nemo_action` : 'twindesk-send.nemo_action'), `[Nemo Action]\nName=${e.label}\nComment=Send the selected files with TwinDesk (${ARG})\nExec=${e.exec}\nIcon-Name=document-send\nSelection=notnone\nExtensions=any;\n`, 0o644);
        }
      }
      // Dolphin: KDE Frameworks 6 and 5 look in different folders; service menus must be executable.
      const service = `[Desktop Entry]\nType=Service\nMimeType=all/all;\nActions=${entries.map((e) => 'twindeskSend' + e.n).join(';')};\nX-KDE-Priority=TopLevel\n`
        + entries.map((e) => `\n[Desktop Action twindeskSend${e.n}]\nName=${e.label}\nIcon=document-send\nExec=${e.exec}\n`).join('');
      for (const dir of [path.join(DATA, 'kio', 'servicemenus'), path.join(DATA, 'kservices5', 'ServiceMenus')]) {
        const f = path.join(dir, 'twindesk-send.desktop');
        if (entries.length && installed('dolphin')) write(f, service, 0o755);
        else rm(f);
      }
      this._thunar(installed('thunar') ? entries : []);
    } catch (e) {
      console.warn('[sendto]', e.message);
    }
  }

  // Share folder on folders, in each file manager that is installed (and gone from those that aren't).
  _share() {
    const exec = launcher().map(desk).join(' ') + ' ' + SHARE + ' %f';
    try {
      for (const [dir, cmd] of [[path.join(DATA, 'nautilus', 'scripts'), 'nautilus'], [path.join(CONFIG, 'caja', 'scripts'), 'caja']]) {
        for (const n of OLD_SHARE_LABELS) this._clearShare(path.join(dir, n));
        const f = path.join(dir, SHARE_LABEL);
        if (installed(cmd)) write(f, shareScript(), 0o755);
        else this._clearShare(f);
      }
      const nemo = path.join(DATA, 'nemo', 'actions', 'twindesk-share.nemo_action');
      if (installed('nemo')) write(nemo, `[Nemo Action]\nName=${SHARE_LABEL}\nComment=Share this folder with your devices (${SHARE})\nExec=${exec}\nIcon-Name=folder-remote\nSelection=s\nExtensions=dir;\n`, 0o644);
      else rm(nemo);
      const service = `[Desktop Entry]\nType=Service\nMimeType=inode/directory;\nActions=twindeskShare;\nX-KDE-Priority=TopLevel\n\n[Desktop Action twindeskShare]\nName=${SHARE_LABEL}\nIcon=folder-remote\nExec=${exec}\n`;
      for (const dir of [path.join(DATA, 'kio', 'servicemenus'), path.join(DATA, 'kservices5', 'ServiceMenus')]) {
        const f = path.join(dir, 'twindesk-share.desktop');
        if (installed('dolphin')) write(f, service, 0o755);
        else rm(f);
      }
      this._thunarShare(installed('thunar') ? exec : '');
    } catch (e) {
      console.warn('[sendto] share:', e.message);
    }
  }

  _clearShare(file) {
    try { if (fs.readFileSync(file, 'utf8').includes(SHARE)) fs.rmSync(file, { force: true }); } catch (_) { /* none, or not ours */ }
  }

  _thunarShare(exec) {
    const file = path.join(CONFIG, 'Thunar', 'uca.xml');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { if (!exec) return; }
    text = text.replace(new RegExp('\\s*<action>(?:(?!</action>)[\\s\\S])*<unique-id>' + SHARE_UCA + '</unique-id>[\\s\\S]*?</action>', 'g'), '');
    if (exec) {
      if (!/<\/actions>/.test(text)) text = '<?xml version="1.0" encoding="UTF-8"?>\n<actions>\n</actions>\n';
      text = text.replace(/<\/actions>/, `\n<action>\n\t<icon>folder-remote</icon>\n\t<name>${xml(SHARE_LABEL)}</name>\n\t<unique-id>${SHARE_UCA}</unique-id>\n\t<command>${xml(exec)}</command>\n\t<description>Share this folder with your devices</description>\n\t<patterns>*</patterns>\n\t<directories/>\n</action>\n</actions>`);
    }
    write(file, text, 0o644);
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

  // Thunar's custom actions (uca.xml): ours (by their unique-id) replaced, added or removed.
  _thunar(entries) {
    const file = path.join(CONFIG, 'Thunar', 'uca.xml');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { if (!entries.length) return; }
    const ours = new RegExp('\\s*<action>(?:(?!</action>)[\\s\\S])*<unique-id>' + UCA_ID + '(?:-\\d+)?</unique-id>[\\s\\S]*?</action>', 'g');
    text = text.replace(ours, '');
    if (entries.length) {
      const actions = entries.map((e) => `\n<action>\n\t<icon>document-send</icon>\n\t<name>${xml(e.label)}</name>\n\t<unique-id>${UCA_ID}${e.n ? '-' + e.n : ''}</unique-id>\n\t<command>${xml(e.exec)}</command>\n\t<description>Send the selected files with TwinDesk</description>\n\t<patterns>*</patterns>\n\t<directories/>\n\t<audio-files/>\n\t<image-files/>\n\t<other-files/>\n\t<text-files/>\n\t<video-files/>\n</action>`).join('');
      if (!/<\/actions>/.test(text)) text = '<?xml version="1.0" encoding="UTF-8"?>\n<actions>\n</actions>\n';
      text = text.replace(/<\/actions>/, actions + '\n</actions>');
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
    const toArg = list.find((a) => typeof a === 'string' && a.startsWith(TO));
    const to = toArg && this.bus ? toArg.slice(TO.length) : null;
    if (!(to ? this.bus.connectedIds().includes(to) : this.link.status.state === 'connected')) {
      this.pending = { paths, until: Date.now() + 30000, to }; // sent once the link is up
      this.popup('away', { key: 'Not connected yet' }, { key: 'Sending once {name} is connected', vars: { name: this._who(to) } });
      return true;
    }
    this._send(paths, to);
    return true;
  }

  _who(to) {
    return (to && this.nameOf ? this.nameOf(to) : this.peerName()) || { key: 'the other computer' };
  }

  // to: the device (Multi-device); else the selected one.
  _send(paths, to = null) {
    const unit = to && this.fileDrop.unit ? this.fileDrop.unit(to) : null;
    const r = unit ? unit.sendBatch(paths, 'send') : this.fileDrop.sendBatch(paths, 'send');
    const who = this._who(to);
    if (!r) return this.popup('away', { key: 'Nothing to send' }, { key: paths.length === 1 ? 'Couldn’t read {file}' : 'Couldn’t read those items', vars: { file: path.basename(paths[0]) } });
    const n = r.items.length;
    this.popup('away', { key: 'Sending {item} to {name}', vars: { item: n === 1 ? r.name : { key: '{count} items', vars: { count: n } }, name: who } });
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

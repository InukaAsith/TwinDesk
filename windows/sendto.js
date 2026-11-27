// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Explorer's right-click › Send to
// gets "<peer name> (TwinDesk)", a shortcut in shell:sendto to `TwinDesk.exe --send-files`. Explorer
// appends the chosen paths; that copy of TwinDesk hands them to this one (second-instance) and they
// go with the Send files flow (filedrop.js, drop:'send'). The shortcut follows the paired computer's
// name and goes when nothing is paired; the uninstaller removes it too (installer.nsh).
// Multi-device: one shortcut per paired computer, `--send-files --send-to=<id>`, and the files go to that
// device whichever is selected. One shortcut for the selected device was renamed and rewritten on every
// crossing, and sent to whichever device was selected by the time it ran (#313).
'use strict';

const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { launcher } = require('./storepkg'); // the Store's MSIX starts its alias

const ARG = '--send-files';
const TO = '--send-to='; // the device, in Multi-device
const SUFFIX = ' (TwinDesk).lnk';
const OLD_SUFFIX = ' (MacShare).lnk'; // the app's old name: replaced by the new one

class SendTo {
  // opts: fileDrop, link, peerName() → name | '', popup(kind, text, sub)
  //   bus, nameOf(id): Multi-device (fileDrop is the FileDropSet: unit(id) sends to that device)
  constructor(opts) {
    Object.assign(this, opts);
    this.dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo');
    this.key = null; // the shortcuts we made last ('' = none)
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

  // Keep the shortcuts in step with the paired computers (called with every state push): a name (one-to-one),
  // or [{id, name}] (Multi-device, one each). Written only when they changed.
  sync(peers) {
    const list = (Array.isArray(peers) ? peers : peers ? [{ id: '', name: peers }] : [])
      .map((p) => ({ id: String(p.id || '').replace(/[^A-Za-z0-9._-]/g, ''), name: String(p.name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) }))
      .filter((p) => p.name);
    const key = list.map((p) => p.id + '=' + p.name).join('|');
    if (key === this.key) return;
    this.key = key;
    const names = new Set(list.map((p) => p.name + SUFFIX));
    try {
      for (const f of fs.readdirSync(this.dir)) {
        const old = f.endsWith(OLD_SUFFIX) || (f.endsWith(SUFFIX) && !names.has(f));
        if (old && this._ours(path.join(this.dir, f))) fs.rmSync(path.join(this.dir, f), { force: true });
      }
      for (const p of list) {
        const args = (app.isPackaged ? [] : [app.getAppPath()]).map((x) => (/\s/.test(x) ? '"' + x + '"' : x)).concat(ARG, p.id ? [TO + p.id] : []).join(' ');
        const file = path.join(this.dir, p.name + SUFFIX);
        const ok = shell.writeShortcutLink(file, fs.existsSync(file) ? 'replace' : 'create', {
          target: launcher(), args, description: 'Send to ' + p.name + ' with TwinDesk', icon: process.execPath, iconIndex: 0,
        });
        if (!ok) console.warn('[sendto] Windows refused the Send to shortcut');
      }
    } catch (e) {
      console.warn('[sendto]', e.message);
    }
  }

  _ours(file) {
    try {
      return String(shell.readShortcutLink(file).args).includes(ARG);
    } catch (_) {
      return false;
    }
  }

  // A command line (ours at start, or a second instance's): true when it was a Send to.
  handle(argv) {
    const list = Array.isArray(argv) ? argv : [];
    const at = list.indexOf(ARG);
    if (at < 0) return false;
    // Chromium may move its own switches around, so take every existing absolute path after it.
    const skip = new Set([process.execPath, launcher(), app.getAppPath()].map((x) => path.resolve(x).toLowerCase()));
    const paths = list.slice(at + 1).filter((a) => typeof a === 'string' && !a.startsWith('--') && path.win32.isAbsolute(a)
      && !skip.has(path.resolve(a).toLowerCase()) && fs.existsSync(a)).slice(0, 1000);
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

module.exports = SendTo;

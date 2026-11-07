// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Copy and paste files between the computers with two global shortcuts (default
// ⌃⌥C / ⌃⌥V, Files tab). Copy announces the files selected in Finder (else the files on the
// clipboard) with `fclip.offer`; paste on the other computer asks for them with `fclip.paste` and
// they arrive as a batch (filesend.js / drop.js, drop:'paste') in the folder that was in front.
// With an app in front instead of Finder (a chat, a mail, a document), they go into it
// (shared/pastefiles.js: on the clipboard as files, then ⌘V there).
//
// Events: 'change' — this.view changed; 'popup' (kind, text) — for hud.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { globalShortcut } = require('electron');
const { EventEmitter } = require('events');
const P = require('../shared/protocol.js');
const pastefiles = require('../shared/pastefiles.js');

const T = P.T;
const DESKTOP = path.join(os.homedir(), 'Desktop');

function osascript(script) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 3000 }, (err, out) => resolve(err ? '' : String(out).trim()));
  });
}

const finderSelection = () => osascript(
  'tell application "Finder"\nset out to ""\nrepeat with i in (get selection)\nset out to out & POSIX path of (i as alias) & linefeed\nend repeat\nreturn out\nend tell',
).then((o) => o.split('\n').map((l) => l.replace(/\/$/, '')).filter(Boolean));

const finderFolder = () => osascript(
  'tell application "Finder" to if (count of Finder windows) > 0 then return POSIX path of (target of front Finder window as alias)',
);

class FileClip extends EventEmitter {
  constructor({ server, helper, fileSend, drop, getSettings }) {
    super();
    Object.assign(this, { server, helper, fileSend, drop, getSettings });
    this.offer = null; // ours: { id, paths, items, files, bytes }
    this.incoming = null; // theirs: { id, items, files, bytes, at }
    this.pasting = null; // { id, files }
    this.error = '';

    server.on(`t:${T.FCLIP_OFFER}`, (m) => {
      if (typeof m.id !== 'string' || !Array.isArray(m.items)) return;
      const items = m.items.slice(0, 1000).map((i) => ({ name: String(i.name || '').slice(0, 200), dir: !!i.dir, size: Number(i.size) || 0 }));
      this.incoming = { id: m.id, items, files: Number(m.files) || 0, bytes: Number(m.bytes) || 0, at: Date.now() };
      this.emit('change');
    });
    server.on(`t:${T.FCLIP_GONE}`, (m) => {
      if (this.incoming && this.incoming.id === m.id) this.incoming = null;
      if (this.pasting && this.pasting.id === m.id) {
        this.pasting = null;
        this.emit('popup', 'home', { key: 'Those files aren’t there any more' });
      }
      this.emit('change');
    });
    server.on(`t:${T.FCLIP_PASTE}`, (m) => this._send(m.id));
    // The other computer's keyboard pressed its copy/paste shortcut while the pointer is here.
    server.on(`t:${T.FCLIP_KEY}`, (m) => {
      if (m.action === 'copy') this.copy();
      else if (m.action === 'paste') this.paste();
    });
    server.on('closed', () => {
      if (server.current) return;
      this.incoming = null;
      this.pasting = null;
      this.emit('change');
    });
    drop.on('batch', (b) => {
      if (b.kind !== 'paste') return;
      const p = this.pasting;
      this.pasting = null;
      const done = { key: b.ok ? (b.files === 1 ? 'Pasted {count} file' : 'Pasted {count} files') : 'Pasted {count} of {total} files', vars: { count: b.files, ...(b.ok ? {} : { total: b.count }) } };
      if (p && p.into && b.files && b.placed && b.placed.length) {
        pastefiles.pasteInto(this.helper, b.placed)
          .then(() => this.emit('popup', 'home', done))
          .catch(() => this.emit('popup', 'home', { key: '{result}: they’re on the clipboard, paste them with {keys}', vars: { result: done, keys: '⌘V' } }));
      } else {
        this.emit('popup', 'home', done);
      }
      this.emit('change');
    });
    this.apply();
  }

  get cfg() {
    return this.getSettings().files;
  }

  get peerName() {
    return this.server.current ? this.server.current.name : 'the other computer';
  }

  // (Re)register the two shortcuts from settings.files.copyKeys / pasteKeys: only while connected
  // (syncConnected), so they're other apps' keys the rest of the time.
  apply() {
    for (const acc of this.registered || []) globalShortcut.unregister(acc); // only ours: the cursor lock key is one too
    this.registered = [];
    this.error = '';
    if (this.cfg.shortcuts !== false && this.live) {
      const bad = [];
      for (const [acc, fn] of [[this.cfg.copyKeys, () => this.shortcut('copy')], [this.cfg.pasteKeys, () => this.shortcut('paste')]]) {
        try {
          if (!acc || !globalShortcut.register(acc, fn)) bad.push(acc);
          else this.registered.push(acc);
        } catch {
          bad.push(acc);
        }
      }
      if (bad.length) this.error = `Couldn’t use ${bad.join(' and ')}. Another app may have it.`;
    }
    this.emit('change');
  }

  // Our shortcut, pressed at home. With the pointer on the other computer and the keyboard not
  // shared (so intercept() never saw it), it happens over there.
  shortcut(action) {
    const k = this.kvm;
    if (k && k.mode === 'driving' && !(k.local && k.local.drives())) return void this.server.sendToClient({ t: T.FCLIP_KEY, action });
    if (action === 'copy') this.copy();
    else this.paste();
  }

  // main.js, with every state push: whether anything is connected.
  syncConnected(on) {
    this.session = !!on;
    on = !!on || !!this.local; // files from a web device: the shortcut works without a session too
    if (!!on === !!this.live) return;
    this.live = !!on;
    this.apply();
  }

  // While this Mac drives the other computer, its key events go through here (kvm.js) before they
  // are sent: our own copy/paste shortcut becomes `fclip.key`, so it happens where the pointer is.
  // Returns true when the event was used up.
  intercept(e) {
    const MODS = { ControlLeft: 'Control', ControlRight: 'Control', AltLeft: 'Alt', AltRight: 'Alt', ShiftLeft: 'Shift', ShiftRight: 'Shift', MetaLeft: 'Command', MetaRight: 'Command' };
    if (!this.held) this.held = new Set();
    if (!this.eaten) this.eaten = new Set();
    if (e.t !== T.K_KEY_DOWN && e.t !== T.K_KEY_UP) return false;
    if (MODS[e.code]) {
      if (e.t === T.K_KEY_DOWN) this.held.add(e.code);
      else this.held.delete(e.code);
      return false;
    }
    if (e.t === T.K_KEY_UP) return this.eaten.delete(e.code);
    if (this.cfg.shortcuts === false) return false;
    const mods = [...new Set([...this.held].map((c) => MODS[c]))].sort().join('+');
    const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.code;
    const match = (acc) => {
      const parts = String(acc || '').split('+');
      return parts.pop() === key && parts.sort().join('+') === mods;
    };
    const action = match(this.cfg.copyKeys) ? 'copy' : match(this.cfg.pasteKeys) ? 'paste' : '';
    if (!action) return false;
    this.eaten.add(e.code);
    this.server.sendToClient({ t: T.FCLIP_KEY, action });
    return true;
  }

  async copy() {
    if (!this.server.current) return this.emit('popup', 'home', { key: 'Not connected' });
    let paths = [];
    try {
      const src = await this.helper.request('fileSource');
      paths = src.front === 'com.apple.finder' ? await finderSelection() : [];
      if (!paths.length) paths = src.files || [];
    } catch { /* no helper: nothing to copy */ }
    paths = paths.filter((p) => fs.existsSync(p));
    if (!paths.length) return this.emit('popup', 'home', { key: 'Select files in Finder first' });
    const plan = this.fileSend.planDrag(paths);
    if (!plan) return this.emit('popup', 'home', { key: 'Nothing to copy there' });
    if (this.offer) this.server.sendToClient({ t: T.FCLIP_GONE, id: this.offer.id }); // newest copy wins
    this.offer = { id: crypto.randomUUID(), paths, items: plan.items, files: plan.files, bytes: plan.bytes };
    // list / dirs: the whole tree, so a PC pastes it with Windows' own copy dialog.
    this.server.sendToClient({
      t: T.FCLIP_OFFER, id: this.offer.id, items: plan.items, files: plan.files, bytes: plan.bytes,
      list: plan.list.map((f) => ({ rel: f.rel, size: f.size })), dirs: plan.dirs,
    });
    this.emit('popup', 'away', { key: 'Copied {item} for {name}', vars: { item: plan.items.length === 1 ? plan.items[0].name : { key: '{count} items', vars: { count: plan.items.length } }, name: this.peerName } });
    this.emit('change');
  }

  // Files a web device sent (shared/web/webhub.js): ⌃⌥V pastes them here, as it does the other
  // computer's. Kept 30 minutes; the other computer's newer copy goes first.
  offerLocal(paths, from) {
    const there = (paths || []).filter((p) => fs.existsSync(p));
    if (!there.length) return;
    this.local = { paths: there, from: String(from || ''), at: Date.now() };
    clearTimeout(this.localTimer);
    this.localTimer = setTimeout(() => { this.local = null; this.syncConnected(this.session); this.emit('change'); }, 30 * 60000);
    this.localTimer.unref?.();
    this.syncConnected(this.session);
    this.emit('change');
  }

  async _pasteLocal() {
    const l = this.local;
    let dir = '';
    let into = false;
    try {
      const src = await this.helper.request('fileSource');
      if (src.front === 'com.apple.finder') dir = await finderFolder();
      else if (src.front && !src.front.startsWith('org.macshare.')) into = true;
    } catch { /* Desktop */ }
    const paths = l.paths.filter((p) => fs.existsSync(p));
    const done = { key: paths.length === 1 ? 'Pasted {count} file' : 'Pasted {count} files', vars: { count: paths.length } };
    if (!paths.length) return this.emit('popup', 'home', { key: 'Those files aren’t there any more' });
    if (into) {
      return pastefiles.pasteInto(this.helper, paths).then(() => this.emit('popup', 'home', done))
        .catch(() => this.emit('popup', 'home', { key: '{result}: they’re on the clipboard, paste them with {keys}', vars: { result: done, keys: '⌘V' } }));
    }
    dir = dir && fs.existsSync(dir) ? dir.replace(/\/$/, '') : DESKTOP;
    const { freeName } = require('../shared/web/webhub.js');
    for (const p of paths) {
      try { await fs.promises.cp(p, freeName(dir, path.basename(p)), { recursive: true, errorOnExist: true }); } catch (e) { console.warn('[fclip] paste:', e.message); }
    }
    this.emit('popup', 'home', done);
  }

  async paste() {
    const inc = this.incoming;
    if (this.local && (!inc || !this.server.current || this.local.at > inc.at)) return this._pasteLocal();
    if (!this.server.current) return this.emit('popup', 'home', { key: 'Not connected' });
    if (!inc) return this.emit('popup', 'home', { key: 'Nothing copied on {name}', vars: { name: this.peerName } });
    let dir = '';
    let into = null;
    try {
      const src = await this.helper.request('fileSource');
      if (src.front === 'com.apple.finder') dir = await finderFolder();
      // An app in front (not Finder, nor TwinDesk and its windows): the files go into it.
      else if (src.front && !src.front.startsWith('org.macshare.')) into = { app: src.front };
    } catch { /* Desktop */ }
    if (into) dir = pastefiles.pasteDir();
    dir = dir && fs.existsSync(dir) ? dir.replace(/\/$/, '') : DESKTOP;
    if (dir === DESKTOP) into = null;
    this.drop.expectBatch(inc.id, dir, !!into);
    this.pasting = { id: inc.id, files: inc.files, into };
    this.server.sendToClient({ t: T.FCLIP_PASTE, id: inc.id });
    this.emit('popup', 'driven', { key: inc.files === 1 ? 'Pasting {count} file…' : 'Pasting {count} files…', vars: { count: inc.files } });
    this.emit('change');
  }

  // The peer pasted: send our copied files (or say they're gone).
  _send(id) {
    const o = this.offer;
    if (!o || o.id !== id || !o.paths.some((p) => fs.existsSync(p))) {
      return this.server.sendToClient({ t: T.FCLIP_GONE, id });
    }
    if (!this.fileSend.sendBatch(o.paths.filter((p) => fs.existsSync(p)), 'paste', id)) {
      this.server.sendToClient({ t: T.FCLIP_GONE, id });
    }
  }

  get view() {
    return {
      error: this.error,
      offer: this.offer && { files: this.offer.files, items: this.offer.items.length },
      incoming: this.incoming && { files: this.incoming.files, items: this.incoming.items.length, name: this.incoming.items.length === 1 ? this.incoming.items[0].name : '' },
      pasting: !!this.pasting,
    };
  }
}


module.exports = { FileClip };

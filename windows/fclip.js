// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Copy and paste files between the computers with two global shortcuts (default
// Ctrl+Alt+C / Ctrl+Alt+V, Files tab).
// Copy announces the files selected in the Explorer window in front (else the files on the
// clipboard) with `fclip.offer`; paste on the other computer asks for them with `fclip.paste` and
// they arrive as a batch (filedrop.js / filerecv.js, drop:'paste') in the folder that was in front.
// Port of mac/fclip.js. When the offer lists every file (`list`, `dirs`), the paste is
// done by Windows itself — dragrecv.js drops the files as virtual files onto the folder, so the
// native copy dialog (progress, replace/skip) shows, as for a drag.
// With an app in front instead (a chat, a mail, a document), the files go into it: they arrive in
// a folder of ours, then go on the clipboard as files and the helper presses Ctrl+V there.
const { app, globalShortcut } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../shared/protocol.js');

const T = P.T;
const PASTE_KEEP_MS = 24 * 3600 * 1000; // files pasted into apps stay this long (an app may read them late)

class FileClip {
  // opts: link, helper, fileDrop, fileRecv, dragRecv, settings (shared), peerName(), popup(kind, text), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.offer = null; // ours: {id, paths, items, files, bytes}
    this.incoming = null; // theirs: {id, items, files, bytes, at}
    this.pasting = null; // {id, files}
    this.error = '';
    this.copySequence = 0;
    this.pastePending = null;
    this.held = new Set(); // modifiers held while driving (intercept)
    this.eaten = new Set(); // shortcut keys whose release isn't sent

    const link = this.link;
    link.on(T.FCLIP_OFFER, (m) => {
      if (typeof m.id !== 'string' || !Array.isArray(m.items)) return;
      const items = m.items.slice(0, 1000).map((i) => ({ name: String((i && i.name) || '').slice(0, 200), dir: !!(i && i.dir), size: Number(i && i.size) || 0 }));
      this.incoming = { id: m.id, items, files: Number(m.files) || 0, bytes: Number(m.bytes) || 0, at: Date.now(),
        list: Array.isArray(m.list) ? m.list : null, dirs: Array.isArray(m.dirs) ? m.dirs : [] }; // The whole tree
      this.onChange();
    });
    link.on(T.FCLIP_GONE, (m) => {
      if (this.incoming && this.incoming.id === m.id) this.incoming = null;
      if (this.pasting && this.pasting.id === m.id) {
        this.pasting = null;
        this.popup('home', { key: 'Those files aren’t there any more' });
      }
      this.onChange();
    });
    link.on(T.FCLIP_PASTE, (m) => this._send(m.id));
    // The other computer's keyboard pressed its copy/paste shortcut while the pointer
    // is here (it drives this PC): do it here.
    link.on(T.FCLIP_KEY, (m) => {
      if (m.action === 'copy') this.copy();
      else if (m.action === 'paste') this.paste();
    });
    link.on('closed', () => {
      ++this.copySequence;
      this.offer = null;
      this.incoming = null;
      this.pasting = null;
      this.pastePending = null;
      this.onChange();
    });
    this.apply();
  }

  get cfg() {
    return this.settings.files;
  }

  get connected() {
    return this.link.status.state === 'connected';
  }

  // The paste batch landed (filerecv.js onBatch). For an app: into it, as files on the clipboard.
  pasted(b) {
    const p = this.pasting;
    if (!p || b.batch !== p.id) return;
    this.pasting = null;
    const done = { key: b.ok ? (b.files === 1 ? 'Pasted {count} file' : 'Pasted {count} files') : 'Pasted {count} of {total} files', vars: { count: b.files, ...(b.ok ? {} : { total: b.count }) } };
    if (p && p.into && b.files && b.placed && b.placed.length) {
      this.helper.request('pasteFiles', { paths: b.placed, hwnd: p.into.hwnd })
        .then(() => this.popup('home', p.into.title ? { key: '{result} into {title}', vars: { result: done, title: short(p.into.title) } } : done))
        .catch(() => this.popup('home', { key: '{result}: they’re on the clipboard, paste them with {keys}', vars: { result: done, keys: 'Ctrl+V' } }));
    } else {
      this.popup('home', done);
    }
    this.onChange();
  }

  // (Re)register the two shortcuts from settings.files.copyKeys / pasteKeys, only while connected
  // (syncConnected): the rest of the time they're other apps' keys. Ctrl+Alt is AltGr on many
  // layouts: if Windows won't give us a key, the Files tab says so (pick another).
  apply() {
    for (const acc of this.registered || []) globalShortcut.unregister(acc);
    this.registered = [];
    this.error = '';
    if (this.cfg.shortcuts && this.live) {
      const bad = [];
      for (const [acc, fn] of [[this.cfg.copyKeys, () => this.shortcut('copy')], [this.cfg.pasteKeys, () => this.shortcut('paste')]]) {
        let ok = false;
        try { ok = globalShortcut.register(acc, fn); } catch (_) { /* invalid */ }
        if (ok) this.registered.push(acc);
        else bad.push(keysLabel(acc));
      }
      if (bad.length) this.error = 'Couldn’t use ' + bad.join(' and ') + '. Another app may have it.';
    }
    this.onChange();
  }

  // main.js, with every state push: whether anything is connected.
  syncConnected(on) {
    this.session = !!on;
    on = !!on || !!this.local; // files from a web device: the shortcut works without a session too
    if (!!on === !!this.live) return;
    this.live = !!on;
    this.apply();
  }

  // Our shortcut, pressed at home. With the pointer on the other computer and the keyboard not
  // shared (so intercept() never saw it), it happens over there.
  shortcut(action) {
    const k = this.kvm;
    if (k && k.mode === 'driving' && !(k.local && k.local.drives())) return void this.link.send({ t: T.FCLIP_KEY, action });
    if (action === 'copy') this.copy();
    else this.paste();
  }

  // While this PC drives the other computer its key events pass through here (kvm.js) before they
  // are sent: our own copy/paste shortcut becomes `fclip.key`, so it happens where the pointer is.
  // Modifiers still go over as keys; the shortcut's key and its release are used up. Returns true
  // when the event was used up.
  intercept(e) {
    const MODS = { ControlLeft: 'Control', ControlRight: 'Control', AltLeft: 'Alt', AltRight: 'Alt', ShiftLeft: 'Shift', ShiftRight: 'Shift', MetaLeft: 'Super', MetaRight: 'Super' };
    if (e.t !== T.K_KEY_DOWN && e.t !== T.K_KEY_UP) return false;
    if (MODS[e.code]) {
      if (e.t === T.K_KEY_DOWN) this.held.add(e.code);
      else this.held.delete(e.code);
      return false;
    }
    if (e.t === T.K_KEY_UP) return this.eaten.delete(e.code);
    if (!this.cfg.shortcuts) return false;
    const mods = [...new Set([...this.held].map((c) => MODS[c]))].sort().join('+');
    const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.code;
    const match = (acc) => {
      const parts = String(acc || '').split('+');
      return parts.pop() === key && parts.sort().join('+') === mods;
    };
    const action = match(this.cfg.copyKeys) ? 'copy' : match(this.cfg.pasteKeys) ? 'paste' : '';
    if (!action) return false;
    this.eaten.add(e.code);
    this.link.send({ t: T.FCLIP_KEY, action });
    return true;
  }

  // Capture ended: nothing is held any more.
  resetKeys() {
    this.held.clear();
    this.eaten.clear();
  }

  async copy() {
    if (!this.connected) return this.popup('home', { key: 'Not connected' });
    const sequence = ++this.copySequence;
    let paths = [];
    try {
      const src = await this.helper.request('fileSource');
      paths = src.explorer && src.selection.length ? src.selection : src.files || [];
    } catch (_) { /* no helper: nothing to copy */ }
    if (!this.connected || sequence !== this.copySequence) return;
    paths = paths.filter((p) => typeof p === 'string' && fs.existsSync(p));
    if (!paths.length) return this.popup('home', { key: 'Select files in File Explorer first' });
    const plan = this.fileDrop.plan(paths);
    if (!plan || !plan.jobs.length) return this.popup('home', { key: 'Nothing to copy there' });
    if (this.offer) this.link.send({ t: T.FCLIP_GONE, id: this.offer.id }); // newest copy wins
    const files = plan.jobs.length;
    this.offer = { id: crypto.randomUUID(), paths, items: plan.items, files, bytes: plan.bytes };
    // list/dirs: every file and folder, so a PC can paste it with Windows' own copy.
    this.link.send({ t: T.FCLIP_OFFER, id: this.offer.id, items: plan.items, files, bytes: plan.bytes, list: plan.list, dirs: plan.dirs });
    this.popup('away', { key: 'Copied {item} for {name}', vars: { item: plan.items.length === 1 ? plan.items[0].name : { key: '{count} items', vars: { count: plan.items.length } }, name: this.peerName() } });
    this.onChange();
  }

  // Files a web device sent (shared/web/webhub.js): the paste shortcut pastes them here, as it does
  // the other computer's. Kept 30 minutes; the other computer's newer copy goes first.
  offerLocal(paths, from) {
    const there = (paths || []).filter((p) => fs.existsSync(p));
    if (!there.length) return;
    this.local = { paths: there, from: String(from || ''), at: Date.now() };
    clearTimeout(this.localTimer);
    this.localTimer = setTimeout(() => { this.local = null; this.syncConnected(this.session); this.onChange(); }, 30 * 60000);
    this.localTimer.unref?.();
    this.syncConnected(this.session);
    this.onChange();
  }

  async _pasteLocal() {
    const l = this.local;
    let front = {};
    try { front = (await this.helper.request('frontFolder')) || {}; } catch (_) { /* Desktop */ }
    const paths = l.paths.filter((p) => fs.existsSync(p));
    if (!paths.length) return this.popup('home', { key: 'Those files aren’t there any more' });
    const done = { key: paths.length === 1 ? 'Pasted {count} file' : 'Pasted {count} files', vars: { count: paths.length } };
    const into = !front.path && front.app && front.pid !== process.pid ? { hwnd: front.hwnd, title: String(front.title || '') } : null;
    if (into) {
      return this.helper.request('pasteFiles', { paths, hwnd: into.hwnd })
        .then(() => this.popup('home', into.title ? { key: '{result} into {title}', vars: { result: done, title: short(into.title) } } : done))
        .catch(() => this.popup('home', { key: '{result}: they’re on the clipboard, paste them with {keys}', vars: { result: done, keys: 'Ctrl+V' } }));
    }
    const dir = front.path && fs.existsSync(front.path) ? front.path : app.getPath('desktop');
    const { freeName } = require('../shared/web/webhub.js');
    for (const p of paths) {
      try { await fs.promises.cp(p, freeName(dir, path.basename(p)), { recursive: true, errorOnExist: true }); } catch (e) { console.warn('[fclip] paste:', e.message); }
    }
    this.popup('home', done);
  }

  async paste() {
    const inc = this.incoming;
    if (this.local && (!inc || !this.connected || this.local.at > inc.at)) return this._pasteLocal();
    if (!this.connected) return this.popup('home', { key: 'Not connected' });
    if (!inc) return this.popup('home', { key: 'Nothing copied on {name}', vars: { name: this.peerName() } });
    if (this.pasting || this.pastePending) return;
    const pending = this.pastePending = {};
    let front = {};
    try {
      front = (await this.helper.request('frontFolder')) || {};
    } catch (_) { /* Desktop */ }
    if (this.pastePending !== pending) return;
    this.pastePending = null;
    if (!this.connected || this.incoming !== inc) return;
    let dir = front.path || '';
    // An app in front (not File Explorer, the desktop or TwinDesk itself): the files go into it.
    const into = !dir && front.app && front.pid !== process.pid ? { hwnd: front.hwnd, title: String(front.title || '') } : null;
    if (into) dir = this._pasteDir();
    if (!dir || !fs.existsSync(dir)) dir = app.getPath('desktop');
    // Windows' own copy (its dialog) when we know the whole tree; else straight in.
    const native = !into && inc.list && this.dragRecv && this.dragRecv.startPaste({ batch: inc.id, list: inc.list, dirs: inc.dirs, items: inc.items, dir });
    if (!native) this.fileRecv.expectBatch(inc.id, dir, inc.bytes, !!into);
    this.pasting = { id: inc.id, files: inc.files, into };
    this.link.send({ t: T.FCLIP_PASTE, id: inc.id });
    if (!native) this.popup('driven', { key: into && into.title ? (inc.files === 1 ? 'Pasting {count} file into {title}…' : 'Pasting {count} files into {title}…') : inc.files === 1 ? 'Pasting {count} file…' : 'Pasting {count} files…', vars: { count: inc.files, title: into && into.title ? short(into.title) : '' } });
    this.onChange();
  }

  // A new folder for files pasted into an app; the ones from earlier pastes go after a day.
  _pasteDir() {
    const root = path.join(app.getPath('temp'), 'TwinDesk Paste');
    try {
      for (const d of fs.readdirSync(root)) {
        const p = path.join(root, d);
        if (Date.now() - fs.statSync(p).mtimeMs > PASTE_KEEP_MS) fs.rmSync(p, { recursive: true, force: true });
      }
    } catch (_) { /* none yet */ }
    try {
      fs.mkdirSync(root, { recursive: true });
      return fs.mkdtempSync(path.join(root, 'paste-'));
    } catch (_) {
      return '';
    }
  }

  // The other side pasted: send our copied files (or say they're gone).
  _send(id) {
    if (this.fileDrop.batches.has(id)) return; // a repeated shortcut while this copy is already going
    const o = this.offer;
    const there = o && o.id === id ? o.paths.filter((p) => fs.existsSync(p)) : [];
    if (!there.length || !this.fileDrop.sendBatch(there, 'paste', id)) this.link.send({ t: T.FCLIP_GONE, id });
  }

  shutdown() {
    for (const acc of this.registered || []) globalShortcut.unregister(acc);
  }

  view() {
    return {
      error: this.error,
      offer: this.offer && { files: this.offer.files, items: this.offer.items.length },
      incoming: this.incoming && { files: this.incoming.files, items: this.incoming.items.length, name: this.incoming.items.length === 1 ? this.incoming.items[0].name : '' },
      pasting: !!this.pasting,
    };
  }
}

// A window's title for a popup ("Chat - Slack" → as it is, long ones cut).
function short(title) {
  const t = String(title || '').trim();
  return t.length > 40 ? t.slice(0, 39) + '…' : t;
}


// "Control+Alt+C" → "Ctrl+Alt+C".
function keysLabel(acc) {
  return String(acc || '').replace('Control', 'Ctrl').replace('Super', 'Win');
}

module.exports = FileClip;

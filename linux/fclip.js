// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Copy and paste files between the computers with two shortcuts (default Ctrl+Alt+C /
// Ctrl+Alt+V, Files tab). Port of windows/fclip.js.
// The helper sees the shortcuts at home (shortcut.c: Electron's global shortcuts need X11 and an X
// window in front); while this computer drives the other one, kvm.js passes our key events
// through intercept() first, so the shortcut happens where the pointer is (`fclip.key`).
// Copy: with a file manager in front (fm.js) we send it Ctrl+C, then take the files on the
// clipboard (text/uri-list, or GNOME's x-special/gnome-copied-files); files copied earlier in any
// app count too. The helper reads the clipboard as an X client (xclip.c): a Wayland desktop only
// shows it to the app in front, but mirrors it to XWayland. `fclip.offer` announces them; the other computer's paste asks for them with
// `fclip.paste` and they go as a batch (filedrop.js, drop:'paste'). Paste here: the batch lands in
// the folder of the file manager window in front, else Downloads (filerecv.js); with an app in
// front instead (a chat, a mail, a document) it goes into it (shared/pastefiles.js: on the
// clipboard as files, then Ctrl+V there).
const { app } = require('electron');
const clipboard = require('./wlclip').clipboard(); // the copied files' list too (#97)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../shared/protocol.js');
const fm = require('./fm');
const pastefiles = require('../shared/pastefiles.js');
const eclip = require('../shared/eclip.js');
const { receivedDir } = require('../shared/received.js');

const T = P.T;

class FileClip {
  // opts: link, helper, fileDrop, fileRecv, settings (shared), peerName(), popup(kind, text), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.offer = null; // ours: {id, paths, items, files, bytes}
    this.incoming = null; // theirs: {id, items, files, bytes, at}
    this.pasting = null; // {id, files}
    this.held = new Set(); // modifiers held while driving (intercept)
    this.eaten = new Set(); // shortcut keys whose release isn't sent
    this.busy = false;

    const link = this.link;
    link.on(T.FCLIP_OFFER, (m) => {
      if (typeof m.id !== 'string' || !Array.isArray(m.items)) return;
      const items = m.items.slice(0, 1000).map((i) => ({ name: String((i && i.name) || '').slice(0, 200), dir: !!(i && i.dir), size: Number(i && i.size) || 0 }));
      this.incoming = { id: m.id, items, files: Number(m.files) || 0, bytes: Number(m.bytes) || 0, at: Date.now() };
      this.onChange();
    });
    link.on(T.FCLIP_GONE, (m) => {
      if (this.incoming && this.incoming.id === m.id) this.incoming = null;
      if (this.pasting && this.pasting.id === m.id) {
        this.pasting = null;
        this.popup('home', 'Those files aren’t there any more');
      }
      this.onChange();
    });
    link.on(T.FCLIP_PASTE, (m) => this._send(m.id));
    // The other computer pressed its copy/paste shortcut while the pointer is here (it drives
    // this computer): do it here.
    link.on(T.FCLIP_KEY, (m) => {
      if (m.action === 'copy') this.copy();
      else if (m.action === 'paste') this.paste();
    });
    link.on('closed', () => {
      this.incoming = null;
      this.pasting = null;
      this.onChange();
    });
    this.helper.on('event', (name, m) => {
      if (name !== 'shortcut' || !this.cfg.shortcuts) return;
      if (m.action === 'copy' || m.action === 'paste') this.shortcut(m.action);
    });
  }

  // Our shortcut, seen at home. With the pointer on the other computer and the keyboard not shared
  // (so intercept() never saw it), it happens over there.
  shortcut(action) {
    const k = this.kvm;
    if (k && k.mode === 'driving' && !(k.local && k.local.drives())) return void this.link.send({ t: T.FCLIP_KEY, action });
    if (action === 'copy') this.copy();
    else this.paste();
  }

  get cfg() {
    return this.settings.files;
  }

  get connected() {
    return this.link.status.state === 'connected';
  }

  // The paste batch landed (filerecv.js onBatch).
  pasted(b) {
    const p = this.pasting;
    this.pasting = null;
    const done = b.ok ? 'Pasted ' + plural(b.files, 'file') : 'Pasted ' + b.files + ' of ' + b.count + ' files';
    if (p && p.into && b.files && b.placed && b.placed.length) {
      pastefiles.pasteInto(this.helper, b.placed)
        .then(() => this.popup('home', done))
        .catch(() => this.popup('home', done + ': they’re on the clipboard, paste them with Ctrl+V'));
    } else {
      this.popup('home', done);
    }
    this.onChange();
  }

  // Settings changed: the helper watches the keys (kvmConfig, sent by kvm.applyConfig).
  apply() {
    this.onChange();
  }

  // While this computer drives the other one its key events pass through here (kvm.js) before
  // they're sent: our own copy/paste shortcut becomes `fclip.key`. Modifiers still go over as keys;
  // the shortcut's key and its release are used up. Returns true when the event was used up.
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

  // The files to copy: the file manager's selection (sent Ctrl+C), else what's on the clipboard.
  async _selection() {
    const win = await fm.front(this.helper);
    if (win && (win.fm || win.desktop)) { // desktop icons copy their selection too
      const before = (await this._clipboard()).join('\n');
      for (const [t, code] of [['k.kd', 'ControlLeft'], ['k.kd', 'KeyC'], ['k.ku', 'KeyC'], ['k.ku', 'ControlLeft']]) this.helper.send('inject', { ev: { t, code } });
      // The file manager answers within a moment; a selection identical to the old clipboard is fine too.
      for (let i = 0; i < 10; i++) {
        await sleep(80);
        const now = await this._clipboard();
        if (now.length && now.join('\n') !== before) return now;
      }
    }
    return this._clipboard();
  }

  // Files on the clipboard: through the helper (any session), else Electron's view of it.
  async _clipboard() {
    const r = await this.helper.request('clipFiles').catch(() => null);
    const list = r ? filesIn(r.text) : [];
    return list.length ? list : filesIn(await electronClipboard());
  }

  async copy() {
    if (this.busy) return;
    if (!this.connected) return this.popup('home', 'Not connected');
    this.busy = true;
    let paths = [];
    try {
      paths = (await this._selection()).filter((p) => fs.existsSync(p));
    } finally {
      this.busy = false;
    }
    if (!paths.length) return this.popup('home', 'Select files in the file manager first');
    const plan = this.fileDrop.plan(paths);
    if (!plan || !plan.jobs.length) return this.popup('home', 'Nothing to copy there');
    if (this.offer) this.link.send({ t: T.FCLIP_GONE, id: this.offer.id }); // newest copy wins
    const files = plan.jobs.length;
    this.offer = { id: crypto.randomUUID(), paths, items: plan.items, files, bytes: plan.bytes };
    // list/dirs: every file and folder, so a PC can paste it with Windows' own copy.
    this.link.send({ t: T.FCLIP_OFFER, id: this.offer.id, items: plan.items, files, bytes: plan.bytes, list: plan.list, dirs: plan.dirs });
    this.popup('away', 'Copied ' + (plan.items.length === 1 ? plan.items[0].name : plural(plan.items.length, 'item')) + ' for ' + this.peerName());
    this.onChange();
  }

  // Files a web device sent (shared/web/webhub.js): the paste shortcut pastes them here, as it does
  // the other computer's. Kept 30 minutes; the other computer's newer copy goes first.
  offerLocal(paths, from) {
    const there = (paths || []).filter((p) => fs.existsSync(p));
    if (!there.length) return;
    this.local = { paths: there, from: String(from || ''), at: Date.now() };
    clearTimeout(this.localTimer);
    this.localTimer = setTimeout(() => { this.local = null; this.onChange(); }, 30 * 60000);
    this.localTimer.unref?.();
    this.onChange();
  }

  async _pasteLocal() {
    const paths = this.local.paths.filter((p) => fs.existsSync(p));
    if (!paths.length) return this.popup('home', 'Those files aren’t there any more');
    const done = 'Pasted ' + plural(paths.length, 'file');
    const win = await fm.front(this.helper).catch(() => null);
    const front = win && win.folder && fs.existsSync(win.folder) ? win.folder : '';
    if (!front && win && win.app && !win.fm && !win.desktop && !/twindesk/i.test(win.app)) {
      return pastefiles.pasteInto(this.helper, paths).then(() => this.popup('home', done))
        .catch(() => this.popup('home', done + ': they’re on the clipboard, paste them with Ctrl+V'));
    }
    const dir = front || app.getPath('desktop');
    const { freeName } = require('../shared/web/webhub.js');
    for (const p of paths) {
      try { await fs.promises.cp(p, freeName(dir, path.basename(p)), { recursive: true, errorOnExist: true }); } catch (e) { console.warn('[fclip] paste:', e.message); }
    }
    this.popup('home', done);
  }

  async paste() {
    const inc = this.incoming;
    if (this.local && (!inc || !this.connected || this.local.at > inc.at)) return this._pasteLocal();
    if (!this.connected) return this.popup('home', 'Not connected');
    if (!inc) return this.popup('home', 'Nothing copied on ' + this.peerName());
    if (this.pasting) return;
    this.pasting = { id: inc.id, files: inc.files };
    const win = await fm.front(this.helper);
    const front = win && win.folder && fs.existsSync(win.folder) ? win.folder : '';
    // An app in front (not a file manager, the desktop or TwinDesk itself): the files go into it.
    const into = !front && win && win.app && !win.fm && !win.desktop && !/twindesk/i.test(win.app) ? pastefiles.pasteDir() : '';
    if (into) this.pasting.into = { app: win.app };
    this.fileRecv.expectBatch(inc.id, front || into || receivedDir(this.settings, app.getPath('downloads')), inc.bytes, !front && !into);
    this.link.send({ t: T.FCLIP_PASTE, id: inc.id });
    this.popup('driven', 'Pasting ' + plural(inc.files, 'file') + '…');
    this.onChange();
  }

  // The other side pasted: send our copied files (or say they're gone).
  _send(id) {
    const o = this.offer;
    const there = o && o.id === id ? o.paths.filter((p) => fs.existsSync(p)) : [];
    if (!there.length || !this.fileDrop.sendBatch(there, 'paste', id)) this.link.send({ t: T.FCLIP_GONE, id });
  }

  shutdown() {}

  view() {
    const why = !this.cfg.shortcuts ? '' : !this.helper.running ? 'Needs the mouse and keyboard helper (General)' : '';
    return {
      error: why,
      offer: this.offer && { files: this.offer.files, items: this.offer.items.length },
      incoming: this.incoming && { files: this.incoming.files, items: this.incoming.items.length, name: this.incoming.items.length === 1 ? this.incoming.items[0].name : '' },
      pasting: !!this.pasting,
    };
  }
}

// The clipboard as Electron sees it (when TwinDesk is in front on Wayland, or on X11).
async function electronClipboard() {
  try {
    const s = await eclip.snapshot(clipboard);
    for (const f of ['x-special/gnome-copied-files', 'text/uri-list']) {
      const text = s.formats.includes(f) ? (await s.raw(f)).toString('utf8') : '';
      if (text) return text;
    }
    return String((await clipboard.readText()) || '');
  } catch (_) { return ''; }
}

// text/uri-list (most file managers), GNOME's x-special/gnome-copied-files ("copy" or "cut", then
// one URI a line), or file:// lines as text → paths.
function filesIn(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith('file://')) continue;
    try { out.push(decodeURIComponent(new URL(l).pathname)); } catch (_) { /* not a file URI */ }
  }
  return out.slice(0, 1000);
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = FileClip;

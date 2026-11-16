// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone window's Screenshot and Record (shared/mirror-rail.js), the app's side: a screenshot is
// copied and saved in Pictures › TwinDesk; a recording is written to Movies (Videos) › TwinDesk as
// its parts come, and shown in the file manager when it ends. One per window at a time.
//
//   const saver = new MirrorSave({ electron, popup });
//   in the window's input: if (saver.handle(win, m)) return;   on its close: saver.closed(win)
'use strict';

const fs = require('fs');
const path = require('path');
const { writeClipImage } = require('./clipimage.js');

const MAX_PNG = 64 * 1024 * 1024;
const MAX_PART = 64 * 1024 * 1024;
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
};

class MirrorSave {
  // electron: {app, shell, clipboard, nativeImage}; popup(textKey, vars): a short note to the user.
  constructor({ electron, popup = () => {}, name = () => 'Phone' }) {
    this.e = electron;
    this.popup = popup;
    this.name = name;
    this.recs = new Map(); // window key -> {fd, file, id, bytes}
  }

  folder(kind) {
    const { app } = this.e;
    let base;
    // 'videos' is ~/Movies on a Mac: Electron has no 'movies' (asking for it threw, so recordings
    // landed in ~/TwinDesk).
    try { base = app.getPath(kind === 'shot' ? 'pictures' : 'videos'); } catch (_) { base = app.getPath('home'); }
    const dir = path.join(base, 'TwinDesk');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _unique(dir, base, ext) {
    for (let i = 1; ; i++) {
      const p = path.join(dir, `${base}${i === 1 ? '' : ` ${i}`}.${ext}`);
      if (!fs.existsSync(p)) return p;
    }
  }

  // m: the window's {t: 'shot'|'rec', …}. key: the window (one recording each). True when it was ours.
  handle(key, m) {
    if (!m || typeof m !== 'object') return false;
    if (m.t === 'shot' && m.save) { this._shot(m.png); return true; }
    if (m.t === 'rec') { this._rec(key, m); return true; }
    return false;
  }

  _shot(png) {
    if (!(png instanceof Uint8Array) || png.length < 64 || png.length > MAX_PNG) return;
    const buf = Buffer.from(png);
    if (buf.readUInt32BE(0) !== 0x89504e47) return; // not a PNG
    const { clipboard, nativeImage } = this.e;
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return;
    writeClipImage(clipboard, img, buf).catch(() => {});
    try {
      const file = this._unique(this.folder('shot'), `${this.name()} ${stamp()}`, 'png');
      fs.writeFileSync(file, buf);
      this.popup('Screenshot copied, and saved in {folder}', { folder: path.basename(path.dirname(path.dirname(file))) + ' › TwinDesk' });
    } catch (e) {
      this.popup('Screenshot copied (not saved: {error})', { error: e.message });
    }
  }

  _rec(key, m) {
    const ext = m.ext === 'webm' ? 'webm' : 'mp4';
    let r = this.recs.get(key);
    if (m.begin) {
      if (r) this._end(key);
      try {
        const file = this._unique(this.folder('rec'), `${this.name()} ${stamp()}`, ext);
        this.recs.set(key, { fd: fs.openSync(file, 'w'), file, id: String(m.id), bytes: 0 });
        this.popup('Recording…');
      } catch (e) {
        this.popup('Couldn’t record: {error}', { error: e.message });
      }
      return;
    }
    if (!r || r.id !== String(m.id)) return;
    if (m.part instanceof Uint8Array && m.part.length <= MAX_PART) {
      try { fs.writeSync(r.fd, m.part); r.bytes += m.part.length; } catch (e) { this._end(key, e.message); }
    }
    if (m.end) this._end(key);
  }

  _end(key, error) {
    const r = this.recs.get(key);
    if (!r) return;
    this.recs.delete(key);
    try { fs.closeSync(r.fd); } catch (_) {}
    if (!r.bytes) { try { fs.rmSync(r.file, { force: true }); } catch (_) {} return; }
    if (error) this.popup('Recording stopped: {error}', { error });
    else this.popup('Recording saved in {folder}', { folder: path.basename(path.dirname(path.dirname(r.file))) + ' › TwinDesk' });
    try { this.e.shell.showItemInFolder(r.file); } catch (_) {}
  }

  // The window closed: what it recorded so far is kept.
  closed(key) {
    this._end(key);
  }
}

module.exports = { MirrorSave, stamp };

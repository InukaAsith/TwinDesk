// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Where the other side's ReZume shows on a computer (shared/rezume.js), each as ReZume's settings
// say: a notification (silent, the last one only), and a button on the taskbar with the app's icon
// ("Continue … from {name}") that opens it when clicked. Windows and Linux: a small window of its
// own, minimized, so it sits on the taskbar until it's clicked (restored); the Mac passes its own
// (a Dock icon, mac/dockstub.js). The tray's item and the tabs read rezume.view.
// The button carries a small TwinDesk badge, so it reads as ReZume's and not the app's own: on
// Windows the taskbar's overlay icon, elsewhere drawn into the corner of the icon (badged()).
// opts: rezume, cfg() → settings.rezume, peerName(), appIcon (path, when the offer has none),
//   badge? (path: TwinDesk's icon, default appIcon), appId (Windows: the button's own taskbar group),
//   dock? {show(o, take, dismiss), hide()} (o.icon there is already badged).
'use strict';

const { app, BrowserWindow, Notification, nativeImage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const what = (o) => (o.kind === 'web' ? hostOf(o.url) : o.kind === 'doc' ? o.name : o.appName || 'App');
const hostOf = (u) => { try { return new URL(u).host; } catch (_) { return ''; } };

// `base` with `badge` in its bottom-right corner (a third of it), as a new image. Both are
// nativeImages; the bitmaps are premultiplied BGRA, so "over" is src + dst × (1 − src alpha).
function badged(base, badge, size = 256) {
  try {
    if (!base || base.isEmpty() || !badge || badge.isEmpty()) return base;
    const b = base.resize({ width: size, height: size, quality: 'best' });
    const bs = Math.round(size * 0.4);
    const m = badge.resize({ width: bs, height: bs, quality: 'best' });
    const out = Buffer.from(b.toBitmap());
    const src = m.toBitmap();
    if (out.length !== size * size * 4 || src.length !== bs * bs * 4) return base;
    const x0 = size - bs, y0 = size - bs;
    for (let y = 0; y < bs; y++) {
      for (let x = 0; x < bs; x++) {
        const si = (y * bs + x) * 4;
        const a = src[si + 3];
        if (!a) continue;
        const di = ((y0 + y) * size + x0 + x) * 4;
        const k = 1 - a / 255;
        for (let c = 0; c < 4; c++) out[di + c] = Math.min(255, Math.round(src[si + c] + out[di + c] * k));
      }
    }
    const img = nativeImage.createFromBitmap(out, { width: size, height: size });
    return img.isEmpty() ? base : img;
  } catch (_) {
    return base;
  }
}

// `img` as a .ico at `file` that embeds the PNG (supported since Windows Vista); '' when it can't be written.
function toIco(img, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const png = img.resize({ width: 64, height: 64, quality: 'best' }).toPNG();
    const head = Buffer.alloc(22);
    head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4); // ICONDIR: 1 image
    head.writeUInt8(64, 6); head.writeUInt8(64, 7); head.writeUInt8(0, 8); head.writeUInt8(0, 9);
    head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
    fs.writeFileSync(file, Buffer.concat([head, png]));
    return file;
  } catch (_) { return ''; }
}

class ReZumeShelf {
  constructor(opts) {
    Object.assign(this, opts);
    this.note = null;
    this.win = null;
    this.shown = null; // the offer the taskbar shows
    const h = this.rezume;
    h.on('offer', (o) => this._show(o));
    h.on('gone', () => this._hide());
    h.on('change', () => this._sync());
  }

  _icon(o) {
    try {
      if (o.icon) {
        const img = nativeImage.createFromDataURL(o.icon);
        if (!img.isEmpty()) return img;
      }
    } catch (_) { /* not an image */ }
    return this.appIcon ? nativeImage.createFromPath(this.appIcon) : undefined;
  }

  _badge() {
    const p = this.badge || this.appIcon;
    if (this._badgeImg === undefined) this._badgeImg = p ? nativeImage.createFromPath(p) : null;
    return this._badgeImg && !this._badgeImg.isEmpty() ? this._badgeImg : null;
  }

  // The taskbar's icon: the app's with TwinDesk in the corner (only TwinDesk's when the offer has none).
  _barIcon(o) {
    const own = o.icon ? this._icon(o) : null;
    if (!own || own.isEmpty() || process.platform === 'win32') return own || this._icon(o); // Windows: the overlay icon
    return badged(own, this._badge());
  }

  _show(o) {
    const c = this.cfg();
    const from = this.peerName();
    const title = o.title || what(o);
    if (c.notify && Notification.isSupported()) {
      if (this.note) this.note.close(); // the last one only: every tab there would leave one here
      this.note = new Notification({ title: 'Continue from ' + from, body: title + (what(o) && what(o) !== title ? '\n' + what(o) : ''), icon: this._icon(o), silent: true });
      this.note.on('click', () => this.rezume.incoming && this.rezume.incoming.id === o.id && this.rezume.take());
      this.note.show();
    }
    if (c.taskbar) this._bar(o, title, from);
  }

  _bar(o, title, from) {
    this.shown = o;
    const take = () => { if (this.rezume.incoming && this.rezume.incoming.id === o.id) this.rezume.take(); this._hide(); };
    const dismiss = () => { this.rezume.dismiss(o.id); this._hide(); };
    if (this.dock) {
      const icon = o.icon ? this._barIcon(o) : null;
      return void this.dock.show(icon && !icon.isEmpty() ? { ...o, icon: icon.toDataURL() } : o, take, dismiss);
    }
    const label = 'Continue ' + title + ' from ' + from;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    const icon = this._barIcon(o);
    const win = new BrowserWindow({
      width: 360, height: 110, show: false, title: label, icon, resizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: false, autoHideMenuBar: true, backgroundColor: '#1f1f22',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
    });
    this.win = win;
    if (process.platform === 'win32' && this.appId) this._details(win, o, icon); // its own button, not in TwinDesk's group
    const img = o.icon ? `<img src="${esc(o.icon)}">` : '';
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>${esc(label)}</title>
<style>body{margin:0;font:13px system-ui,sans-serif;background:#1f1f22;color:#eee;display:flex;align-items:center;gap:12px;padding:16px;height:78px;box-sizing:border-box}
img{width:44px;height:44px;border-radius:10px}b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:270px}span{opacity:.7}</style>
${img}<div><b>${esc(title)}</b><span>From ${esc(from)} · ${esc(what(o))}</span></div>`));
    // On the taskbar, not in front. A window that was never shown can stay off the taskbar when
    // only minimized (it did on Windows), so it's shown inactive first, see-through until minimized.
    const toBar = () => {
      if (win.isDestroyed() || win.isMinimized()) return;
      if (process.platform !== 'win32') return void win.minimize();
      win.setOpacity(0);
      win.showInactive();
      win.minimize();
      setTimeout(() => !win.isDestroyed() && win.setOpacity(1), 300); // its taskbar preview isn't blank
    };
    const badge = this._badge();
    const overlay = () => {
      if (process.platform !== 'win32' || win.isDestroyed() || !badge) return;
      try { win.setOverlayIcon(badge.resize({ width: 32, height: 32, quality: 'best' }), 'TwinDesk ReZume'); } catch (_) { /* older taskbar */ }
    };
    win.once('ready-to-show', () => { toBar(); overlay(); });
    win.webContents.once('did-finish-load', () => setTimeout(() => { toBar(); overlay(); }, 50)); // ready-to-show can be skipped for a hidden window
    win.on('minimize', overlay);
    win.on('restore', () => { win.hide(); setImmediate(take); }); // its button clicked (not destroyed inside its own event)
    win.on('close', (e) => { // closed from the taskbar: dismissed
      if (this.win !== win) return;
      e.preventDefault();
      dismiss();
    });
  }

  // Windows: a button with its own AppUserModelID shows the relaunch icon (a file, not the window's
  // icon), and that only with a relaunch command. One id per app and icon, since the taskbar keeps an
  // id's icon (an app's id from when its icon was wrong would stay wrong).
  _details(win, o, icon) {
    const has = icon && !icon.isEmpty();
    const key = crypto.createHash('sha1').update(String(o.app || o.kind || '')).update(has ? icon.toPNG() : '').digest('hex').slice(0, 12);
    const ico = has ? toIco(icon, path.join(app.getPath('userData'), 'app-icons', 'rezume.' + key + '.ico')) : '';
    const args = app.isPackaged ? '' : ' "' + app.getAppPath() + '"';
    try {
      win.setAppDetails({
        appId: this.appId + '.' + key, relaunchCommand: '"' + process.execPath + '"' + args, relaunchDisplayName: 'ReZume',
        ...(ico ? { appIconPath: ico, appIconIndex: 0 } : {}),
      });
    } catch (_) { /* older taskbar */ }
  }

  _hide() {
    this.shown = null;
    if (this.dock) this.dock.hide();
    const w = this.win;
    this.win = null;
    if (w && !w.isDestroyed()) setImmediate(() => !w.isDestroyed() && w.destroy());
    if (this.note) { this.note.close(); this.note = null; }
  }

  // Settings changed: what's shown follows.
  _sync() {
    const c = this.cfg();
    const i = this.rezume.incoming;
    if (!i) return this.shown && this._hide();
    if (!c.taskbar && this.shown) {
      this.shown = null;
      if (this.dock) this.dock.hide();
      if (this.win && !this.win.isDestroyed()) { const w = this.win; this.win = null; w.destroy(); }
    } else if (c.taskbar && (!this.shown || this.shown.id !== i.id)) this._bar(i, i.title || what(i), this.peerName());
    if (!c.notify && this.note) { this.note.close(); this.note = null; }
  }

  shutdown() {
    this._hide();
  }
}

module.exports = { ReZumeShelf, badged };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A small, local-only surface for files already received by TwinDesk.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow, ipcMain, nativeImage, nativeTheme, screen, shell } = require('electron');

const shelves = new Map();
let wired = false;
const LIMIT = 8;

function fileIdentity(file) {
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file) || fs.realpathSync(file) !== file) return null;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() && !stat.isDirectory()) return null;
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, folder: stat.isDirectory() };
  } catch { return null; }
}

function same(a, b) {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtime === b.mtime && a.folder === b.folder;
}

function owner(event) {
  const shelf = shelves.get(event.sender.id);
  return shelf && shelf.win && !shelf.win.isDestroyed() && event.sender === shelf.win.webContents &&
    event.senderFrame === shelf.win.webContents.mainFrame ? shelf : null;
}

function wire() {
  if (wired) return;
  wired = true;
  ipcMain.handle('file-shelf:read', (event) => owner(event)?._read() || null);
  ipcMain.on('file-shelf:close', (event) => owner(event)?.win.close());
  ipcMain.on('file-shelf:reveal', (event, id) => {
    const shelf = owner(event), item = shelf?._item(id);
    if (item) shell.showItemInFolder(item.path);
  });
  ipcMain.on('file-shelf:drag', (event, id) => {
    const shelf = owner(event), item = shelf?._item(id);
    if (!item) return;
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets/sidebar-icon@2x.png')).resize({ width: 48, height: 48 });
    if (icon.isEmpty()) return;
    try { event.sender.startDrag({ file: item.path, icon }); } catch { /* The native drag may already have ended. */ }
  });
}

class FileShelf {
  constructor({ drop, latestPhoto = () => null, t = (key) => key }) {
    this.drop = drop;
    this.latestPhoto = latestPhoto;
    this.t = t;
    this.win = null;
    this.items = new Map();
    this.onChange = () => this._publish();
    this.closed = false;
    this.lastSent = '';
    wire();
  }

  _sources() {
    let photo = null;
    try { photo = this.latestPhoto(); } catch { /* A revoked or unreadable backup has no item. */ }
    const sources = [photo && { ...photo, photo: true }, ...(this.drop?.recent || []).slice(0, 40).filter(item => item.ok)].filter(Boolean);
    const seen = new Set(), found = [];
    for (const source of sources) {
      if (found.length >= LIMIT) break;
      if (seen.has(source.path)) continue;
      const identity = fileIdentity(source.path);
      if (!identity) continue;
      seen.add(source.path);
      found.push({ path: source.path, name: path.basename(source.path), photo: source.photo === true, identity });
    }
    return found;
  }

  _snapshot() {
    const previous = this.items;
    this.items = new Map();
    const items = this._sources().map(source => {
      const old = [...previous.values()].find(item => item.path === source.path && item.photo === source.photo && same(item.identity, source.identity));
      const item = { ...source, id: old?.id || randomUUID() };
      this.items.set(item.id, item);
      return { id: item.id, name: item.name, size: item.identity.folder ? null : item.identity.size,
        kind: item.photo ? 'photo' : item.identity.folder ? 'folder' : 'file',
        extension: item.identity.folder ? '' : path.extname(item.name).slice(1, 9).toUpperCase() };
    });
    return { title: this.t('File Shelf'), empty: this.t('Nothing received'), drag: this.t('Drag a file into another app'),
      reveal: this.t('Show in Finder'), close: this.t('Close'), photo: this.t('Latest backed-up photo'), folder: this.t('Folder'), items };
  }

  _item(id) {
    if (typeof id !== 'string') return null;
    const item = this.items.get(id);
    if (!item || !same(item.identity, fileIdentity(item.path))) { this._publish(); return null; }
    // latestPhoto may have been revoked since the sheet was drawn, or Recent may have been cleared.
    const current = this._sources().some(source => source.path === item.path && source.photo === item.photo && same(source.identity, item.identity));
    if (!current) this._publish();
    return current ? item : null;
  }

  _read() {
    const state = this._snapshot();
    this.lastSent = JSON.stringify(state);
    return state;
  }

  _publish() {
    if (!this.win || this.win.isDestroyed()) return;
    const state = this._snapshot();
    const key = JSON.stringify(state);
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.win.webContents.send('file-shelf:state', state);
  }

  refresh() { this._publish(); }

  show() {
    if (this.closed) return;
    if (this.win && !this.win.isDestroyed()) {
      this._publish();
      this.win.show();
      return this.win.focus();
    }
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(420, area.width), height = Math.min(560, area.height);
    const win = new BrowserWindow({
      x: Math.round(area.x + area.width - width - Math.min(16, area.width - width)),
      y: Math.round(area.y + Math.min(16, area.height - height)), width, height,
      show: false, title: this.t('File Shelf'), resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
      backgroundColor: nativeTheme?.shouldUseDarkColors === false ? '#f5f5f7' : '#202124', titleBarStyle: 'hiddenInset',
      webPreferences: { preload: path.join(__dirname, 'preload-file-shelf.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.win = win;
    this.lastSent = '';
    const contentsId = win.webContents.id;
    shelves.set(contentsId, this);
    this.drop?.on('change', this.onChange);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.once('ready-to-show', () => { if (this.win === win && !win.isDestroyed()) win.show(); });
    win.once('closed', () => {
      shelves.delete(contentsId);
      this.drop?.removeListener('change', this.onChange);
      if (this.win === win) this.win = null;
      this.items.clear();
    });
    win.loadFile(path.join(__dirname, 'file-shelf.html')).catch(() => { if (!win.isDestroyed()) win.close(); });
  }

  shutdown() {
    this.closed = true;
    this.items.clear();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { FileShelf };

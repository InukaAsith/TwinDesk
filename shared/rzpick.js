// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume's chooser (shared/rezume.js pick): a document that may open more than one way asks how,
// in a window in the middle of the screen with one large button per way: Preview (a copy, kept in
// the cache until TwinDesk quits), Edit (the file itself, saved on the other device) and Window
// (the app's own window from there). Escape, the close button or clicking away answers null.
'use strict';

const path = require('path');
const { BrowserWindow, ipcMain, screen, nativeTheme } = require('electron');

const H = 300;
const PER = 210; // width per way
let current = null; // {win, resolve, ask}
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  ipcMain.handle('rzpick:ask', (e) => (current && e.sender === current.win.webContents ? current.ask : null));
  ipcMain.on('rzpick:answer', (e, how) => {
    if (!current || e.sender !== current.win.webContents) return;
    finish(current.ask.ways.includes(how) ? how : null);
  });
}

function finish(how) {
  const c = current;
  if (!c) return;
  current = null;
  c.resolve(how);
  if (!c.win.isDestroyed()) c.win.close();
}

// offer: {name, title, appName, icon}; ways: ['copy' | 'live' | 'window']; peer: the other device's name.
function pick(offer, ways, { peer, language } = {}) {
  wire();
  if (current) finish(null); // one question at a time: a newer offer replaces it
  const width = 80 + PER * ways.length;
  const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const win = new BrowserWindow({
    x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - H) / 2), width, height: H,
    show: false, frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, title: 'ReZume', transparent: process.platform === 'darwin', vibrancy: process.platform === 'darwin' ? 'popover' : undefined,
    backgroundColor: process.platform === 'darwin' ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#2a2a2c' : '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload-rzpick.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  return new Promise((resolve) => {
    current = { win, resolve, ask: { ways, peer: peer || '', name: offer.name || offer.title || '', appName: offer.appName || '', icon: offer.icon || '' } };
    win.loadFile(path.join(__dirname, 'rzpick.html'), { query: { language: language || 'en' } });
    win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
    win.on('blur', () => current && current.win === win && finish(null));
    win.on('closed', () => current && current.win === win && finish(null));
  });
}

module.exports = { pick };

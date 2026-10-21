// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The small window for a phone call (phonehub.js): who's calling with Answer and Decline, then the
// time, Mute, End and where the sound is. Made when a call starts and closed a moment after it
// ends; never made while Calls is off (this module isn't even loaded then).
'use strict';

const path = require('path');
const { BrowserWindow, ipcMain, screen, nativeTheme } = require('electron');

const W = 360;
const H = 124;
let win = null;
let hub = null;
let opts = null;
let closeTimer = null;
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  ipcMain.on('callpop:act', (_e, r) => hub && hub.act(r));
  ipcMain.on('callpop:open', () => opts && opts.open('calls'));
  ipcMain.on('callpop:close', () => close());
  ipcMain.handle('callpop:state', () => view());
}

function view() {
  if (!hub) return null;
  const v = hub.view;
  return { call: v.call, ended: v.ended, muted: v.muted, audio: v.audio, phone: v.name };
}

// Where it goes: the corner notifications use (top right on a Mac and Linux, bottom right on Windows).
function place() {
  const a = screen.getPrimaryDisplay().workArea;
  const m = 12;
  return { x: a.x + a.width - W - m, y: opts.corner === 'bottom' ? a.y + a.height - H - m : a.y + m };
}

function open() {
  const at = place();
  win = new BrowserWindow({
    ...at, width: W, height: H, show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, focusable: true, title: 'Call',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#2a2a2c' : '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload-callpop.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'callpop.html'));
  win.once('ready-to-show', () => win && !win.isDestroyed() && win.showInactive()); // never takes the keyboard from what you're typing in
  win.on('closed', () => { win = null; });
}

function close() {
  clearTimeout(closeTimer);
  closeTimer = null;
  if (win && !win.isDestroyed()) win.close();
  win = null;
}

// A call started, changed or ended (phonehub 'call'), or the hub's view changed while it's open.
function update(h, o) {
  hub = h;
  opts = o;
  wire();
  const v = hub.view;
  if (v.call) {
    clearTimeout(closeTimer);
    closeTimer = null;
    if (!win || win.isDestroyed()) open();
  } else if (win && !win.isDestroyed() && !closeTimer) {
    closeTimer = setTimeout(close, v.ended && v.ended.missed ? 6000 : 2000); // "Missed call" stays a little longer
  }
  if (win && !win.isDestroyed()) win.webContents.send('callpop:state', view());
}

module.exports = { update, close };

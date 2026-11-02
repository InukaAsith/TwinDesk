// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The switching popup: a small pill at the bottom centre of
// the screen under the pointer. Click-through, never focused, top-most, excluded from screen
// capture where the desktop supports it (not on X11), off with General › "Show a popup".
// Copy of windows/hud.js. Transparent corners need a compositing window manager.
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');
const I18n = require('../shared/i18n.js');

const W = 380, H = 64, SHOW_MS = 1400;
const BIG_W = 460, BIG_H = 230, BIG_MS = 2200; // the cursor sharing on/off card

class Hud {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.win = null;
    this.ready = null;
    this.timer = null;
  }

  _ensure() {
    if (this.win && !this.win.isDestroyed()) return this.ready;
    this.win = new BrowserWindow({
      width: W, height: H, show: false, frame: false, roundedCorners: false, transparent: true, resizable: false, movable: false,
      focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, type: 'notification',
      webPreferences: { preload: path.join(__dirname, 'preload-hud.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    this.win.setIgnoreMouseEvents(true);
    this.win.setAlwaysOnTop(true, 'screen-saver'); // over full-screen apps too
    this.win.setVisibleOnAllWorkspaces(true);
    this.win.setContentProtection(true); // where supported: never in the Mac's view of this screen
    this.ready = this.win.loadFile(path.join(__dirname, 'hud.html'), { query: { language: I18n.resolveLanguage((this.getSettings().ui || {}).language, app.getLocale()) } });
    return this.ready;
  }

  // kind: 'away' (we use the other computer), 'driven' (it uses this computer), 'home';
  // 'linkOn' / 'linkOff': the big card in the middle of the screen, with `sub`. 'lock': cursor lock on/off.
  async show(kind, text, sub = '') {
    const big = kind === 'linkOn' || kind === 'linkOff';
    if (this.getSettings().app.hud === false && !big && kind !== 'lock') return; // the on/off card and the lock always show
    await this._ensure();
    if (this.win.isDestroyed()) return;
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const [w, h] = big ? [BIG_W, BIG_H] : [W, H];
    const y = big ? d.y + (d.height - h) / 2 - d.height * 0.08 : d.y + d.height - h - 72;
    this.win.setBounds({ x: Math.round(d.x + (d.width - w) / 2), y: Math.round(y), width: w, height: h });
    this.win.webContents.send('hud', { kind, text, sub });
    this.win.showInactive();
    this.win.moveTop();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.win && !this.win.isDestroyed()) this.win.webContents.send('hud', { kind: 'hide' });
      this.timer = setTimeout(() => this.win && !this.win.isDestroyed() && this.win.hide(), 400);
    }, big ? BIG_MS : SHOW_MS);
  }
}

module.exports = Hud;

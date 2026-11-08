// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The popup that says where the mouse and keyboard are: a small pill at
// the bottom of the screen under the pointer, like the volume HUD. Click-through, on every Space,
// never captured into a screen stream (content protection), off with General › "Show a popup".
// Its window lives while a session is on (made when it starts, so the first popup is instant) and
// goes IDLE_MS after the last popup once there's none: no renderer kept for an idle menu bar.
'use strict';

const path = require('path');
const { app, BrowserWindow, screen } = require('electron');
const I18n = require('../shared/i18n.js');

const W = 360, H = 64, SHOW_MS = 1400;
const BIG_W = 460, BIG_H = 230, BIG_MS = 2200; // the sharing on/off card
const IDLE_MS = 30000;

class Hud {
  constructor(getSettings) {
    this.getSettings = getSettings;
    this.win = null;
    this.ready = null;
    this.timer = null;
    this.idleTimer = null;
    this.keep = () => false; // main: true while a session is on
  }

  // A session started: the window now, so the first popup shows at once.
  warm() {
    if (this.getSettings().app.hud === false) return;
    clearTimeout(this.idleTimer);
    this._ensure();
  }

  // The window goes when nothing needs it: no session, nothing showing, for IDLE_MS.
  idle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.keep() || !this.win || this.win.isDestroyed() || this.win.isVisible()) return;
      const w = this.win;
      this.win = null;
      this.ready = null;
      w.destroy();
    }, IDLE_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  _ensure() {
    if (this.win && !this.win.isDestroyed()) return this.ready;
    this.win = new BrowserWindow({
      width: W, height: H, show: false, frame: false, transparent: true, resizable: false, movable: false,
      focusable: false, skipTaskbar: true, hasShadow: false, type: 'panel', alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'preload-hud.js'), contextIsolation: true, nodeIntegration: false },
    });
    this.win.setIgnoreMouseEvents(true);
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.setContentProtection(true); // never in a screen share or Monitor 2
    this.ready = this.win.loadFile(path.join(__dirname, 'hud.html'), { query: { language: I18n.resolveLanguage((this.getSettings().ui || {}).language, app.getLocale()) } });
    return this.ready;
  }

  // kind: 'away' (we use the other computer), 'driven' (it uses this Mac), 'home';
  // 'linkOn' / 'linkOff': the big card in the middle of the screen (sharing switched on/off), with `sub`.
  // 'lock': cursor lock on/off.
  async show(kind, text, sub = '') {
    const big = kind === 'linkOn' || kind === 'linkOff';
    if (this.getSettings().app.hud === false && !big && kind !== 'lock') return; // the on/off card and the lock always show
    await this._ensure();
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const [w, h] = big ? [BIG_W, BIG_H] : [W, H];
    const y = big ? d.y + (d.height - h) / 2 - d.height * 0.08 : d.y + d.height - h - 72;
    this.win.setBounds({ x: Math.round(d.x + (d.width - w) / 2), y: Math.round(y), width: w, height: h });
    this.win.webContents.send('hud', { kind, text, sub });
    this.win.showInactive();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.win && !this.win.isDestroyed()) this.win.webContents.send('hud', { kind: 'hide' });
      this.timer = setTimeout(() => {
        if (this.win && !this.win.isDestroyed()) this.win.hide();
        if (!this.keep()) this.idle();
      }, 400);
    }, big ? BIG_MS : SHOW_MS);
  }
}

module.exports = { Hud };

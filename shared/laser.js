// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The presentation remote's laser (remote.laser {on}): a glowing red dot on this computer's screen
// that follows the pointer while the phone points. A transparent window the size of the display the
// pointer is on, above everything (a slideshow in full screen too), that clicks go through; the dot
// is drawn where the pointer is, about 60 times a second, and the window goes away when it's off.
'use strict';

const PAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent;cursor:none}
#d{position:fixed;left:-100px;top:-100px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;
background:radial-gradient(circle,#fff 0 14%,#ff3b30 30%,rgba(255,59,48,.55) 55%,rgba(255,59,48,0) 72%);
box-shadow:0 0 18px 6px rgba(255,40,30,.55);will-change:transform}
</style><div id="d"></div><script>const d=document.getElementById('d');window.m=(x,y)=>{d.style.left=x+'px';d.style.top=y+'px'};</script>`;

class Laser {
  constructor() {
    this.win = null;
    this.timer = null;
    this.display = null;
    this.last = '';
  }

  set(on) {
    if (on) this._show(); else this._hide();
  }

  _show() {
    const { BrowserWindow, screen } = require('electron');
    if (this.timer) return;
    const at = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(at);
    if (!this.win || this.win.isDestroyed()) {
      this.win = new BrowserWindow({
        x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
        transparent: true, frame: false, focusable: false, skipTaskbar: true, resizable: false, movable: false,
        hasShadow: false, show: false, alwaysOnTop: true, fullscreenable: false, enableLargerThanScreen: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      this.win.setIgnoreMouseEvents(true);
      this.win.setAlwaysOnTop(true, 'screen-saver');
      if (process.platform === 'darwin') this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      this.win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
      this.win.once('ready-to-show', () => { if (this.timer && this.win && !this.win.isDestroyed()) this.win.showInactive(); });
      this.win.on('closed', () => { this.win = null; });
    } else this.win.showInactive();
    this.display = d.id;
    this.last = '';
    this.timer = setInterval(() => this._tick(), 16);
  }

  _tick() {
    const w = this.win;
    if (!w || w.isDestroyed()) return;
    const { screen } = require('electron');
    const p = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(p);
    if (d.id !== this.display) { // onto another display: the window follows
      this.display = d.id;
      w.setBounds(d.bounds);
    }
    const x = p.x - d.bounds.x, y = p.y - d.bounds.y;
    const k = x + ',' + y;
    if (k === this.last) return;
    this.last = k;
    w.webContents.executeJavaScript(`m(${x},${y})`).catch(() => {});
  }

  _hide() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { Laser };

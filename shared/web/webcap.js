// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Web's screen and sound for one web device at a time (shared/web/webhub.js): a hidden
// window of its own (webcap.html) in a session of its own, so it runs beside the TwinDesk session's
// capture (a computer watching this screen) without touching it.
//
// new WebCap({audio: 'loopback'|'helper', hub?: {acquire(name, webContents), release(name)},
//   worklet: file URL of the platform's pcm-worklet.js, display?() → electron Display})
// start({video, audio, maxH, fps, mbps}); stop(); remote(msg)
// Events: 'out' (rtc.offer / rtc.ice for the page), 'status' (text)
'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { BrowserWindow, ipcMain, session, desktopCapturer, screen } = require('electron');

const PARTITION = 'twindesk-webcap';

class WebCap extends EventEmitter {
  constructor({ audio = 'loopback', hub = null, worklet, display = null }) {
    super();
    Object.assign(this, { audioMode: audio, hub, worklet, display });
    this.win = null;
    this.session = 0;
    this.active = null;
    this.ses = session.fromPartition(PARTITION);
    this.ses.setDisplayMediaRequestHandler(async (req, cb) => {
      try {
        const want = (this.display && this.display()) || screen.getPrimaryDisplay();
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        const src = sources.find((s) => s.display_id === String(want.id)) || sources[0];
        if (!src) throw new Error('no screens (Screen Recording permission?)');
        cb({ video: src, ...(req.audioRequested ? { audio: 'loopback' } : {}) });
      } catch (e) {
        console.warn('[webcap]', e.message);
        cb({});
      }
    });
    const mine = (e) => this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
    ipcMain.on('webcap:out', (e, m) => {
      if (!mine(e) || !this.active || m.session !== this.active.session) return;
      delete m.session;
      this.emit('out', m);
    });
    ipcMain.on('webcap:state', (e, s) => {
      if (!mine(e) || !this.active || s.session !== this.active.session) return;
      this.emit('status', s.status);
    });
  }

  _window() {
    if (this.win && !this.win.isDestroyed()) return Promise.resolve(this.win);
    this.win = new BrowserWindow({
      show: false, width: 320, height: 200,
      webPreferences: { preload: path.join(__dirname, 'preload-webcap.js'), partition: PARTITION, backgroundThrottling: false, contextIsolation: true },
    });
    this.win.webContents.on('console-message', (e) => { const m = e.message || ''; if (m) console.log('[webcap]', m); });
    this.ready = this.win.loadFile(path.join(__dirname, 'webcap.html')).then(() => this.win);
    return this.ready;
  }

  async start({ video = true, audio = false, maxH = 1080, fps = 60, mbps = 12 }) {
    this.stop();
    const session = ++this.session;
    this.active = { session, audio };
    this.emit('status', 'starting');
    const win = await this._window();
    if (!this.active || this.active.session !== session) return;
    const mode = audio ? this.audioMode : false;
    if (mode === 'helper' && this.hub) {
      const ok = await this.hub.acquire('web', win.webContents);
      if (!ok) console.warn('[webcap] no system sound from the helper');
    }
    win.webContents.send('start', { session, video, audio: mode, maxH, fps, mbps, worklet: this.worklet });
  }

  stop() {
    if (!this.active) return;
    this.active = null;
    if (this.hub) this.hub.release('web');
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('stop');
    this.emit('status', 'off');
    // The window goes after a while unused (it holds a renderer process).
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.active || !this.win || this.win.isDestroyed()) return;
      this.win.destroy();
      this.win = null;
    }, 60000);
  }

  remote(m) {
    if (this.active && this.win && !this.win.isDestroyed()) this.win.webContents.send('remote', m);
  }
}

module.exports = { WebCap };

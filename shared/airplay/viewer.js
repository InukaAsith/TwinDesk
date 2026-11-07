// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Receive AirPlay on a PC or Linux computer (AirPlay & SMB): the receiver (receiver.js) while the
// switch is on, and a window with the picture while a device mirrors to it, in the device's shape
// (turning with it), with its sound (AAC-ELD, decoded in the window). Closing the window stops the
// mirroring. The Mac has its own receiver.
//
// airplayHost({dir, name(), t, pushState, say?}) → {view(), set(on), stop(), shutdown()}
'use strict';

const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');
const { AirPlayReceiver } = require('./receiver.js');

function airplayHost(o) {
  const t = o.t || ((s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? String(v[k]) : m)));
  let rx = null;
  let win = null;
  let ready = false;
  let config = null; // the last codec record: a window that opens late starts with it
  let shape = null;

  const send = (m) => { if (win && !win.isDestroyed() && ready) win.webContents.send('airplay:in', m); };

  function fit(w, h) {
    if (!win || win.isDestroyed() || !(w > 0 && h > 0)) return;
    if (shape && shape.w === w && shape.h === h) return;
    shape = { w, h };
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    const k = Math.min((area.width * 0.85) / w, (area.height * 0.85) / h, 1);
    const [cw, ch] = [Math.round(w * k), Math.round(h * k)];
    win.setAspectRatio(w / h);
    const b = win.getBounds();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    win.setContentSize(cw, ch);
    const nb = win.getBounds();
    win.setPosition(Math.round(Math.min(Math.max(cx - nb.width / 2, area.x), area.x + area.width - nb.width)), Math.round(Math.min(Math.max(cy - nb.height / 2, area.y), area.y + area.height - nb.height)));
  }

  function open(info) {
    if (win && !win.isDestroyed()) { win.setTitle(t('AirPlay · {name}', { name: info.name })); win.show(); return; }
    ready = false;
    shape = null;
    win = new BrowserWindow({
      width: 420, height: 860, backgroundColor: '#000000', title: t('AirPlay · {name}', { name: info.name }),
      autoHideMenuBar: true, show: true,
      webPreferences: { preload: path.join(__dirname, 'preload-viewer.js'), contextIsolation: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    win.on('page-title-updated', (e) => e.preventDefault());
    const me = win;
    win.on('closed', () => {
      if (win === me) { win = null; ready = false; }
      // Closed by hand while the device still mirrors: stop it there too.
      if (rx && rx.active && rx.active.info && rx.active.info.id === info.id) rx.end();
    });
    win.loadFile(path.join(__dirname, 'viewer.html'));
  }

  function close() {
    const w = win;
    win = null;
    ready = false;
    config = null;
    if (w && !w.isDestroyed()) w.destroy();
  }

  ipcMain.on('airplay:ready', (e) => {
    if (!win || e.sender !== win.webContents) return;
    ready = true;
    if (config) send(config);
  });
  ipcMain.on('airplay:size', (e, s) => { if (win && e.sender === win.webContents && s) fit(Number(s.w), Number(s.h)); });

  function start() {
    if (rx) return;
    const d = screen.getPrimaryDisplay();
    const px = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    // Landscape, at most 1920 × 1080: what the sender scales its picture for.
    const k = Math.min(1, 1920 / Math.max(px.width, px.height));
    rx = new AirPlayReceiver({ name: o.name(), dir: o.dir, display: { width: Math.round(Math.max(px.width, px.height) * k), height: Math.round(Math.min(px.width, px.height) * k), fps: 60 } });
    rx.on('session', (info) => {
      config = null;
      open(info);
      if (o.say) o.say(t('AirPlay'), t('{name} is mirroring to this computer', { name: info.name }));
    });
    rx.on('config', (c) => {
      config = { t: 'config', codec: c.codec, avcC: c.avcC };
      send(config);
      if (c.width && c.height) fit(c.width, c.height);
    });
    rx.on('frame', (f) => send({ t: 'frame', data: f.data, key: f.key }));
    rx.on('audio', (a) => { if (a.ct === 8) send({ t: 'audio', data: a.data, seq: a.seq, spf: a.spf }); });
    rx.on('volume', (db) => send({ t: 'volume', db }));
    rx.on('end', () => close());
    rx.on('change', () => o.pushState());
    rx.start().then(() => o.pushState());
  }

  function stop() {
    close();
    if (rx) { rx.stop(); rx.removeAllListeners(); rx = null; }
    o.pushState();
  }

  return {
    view: () => (rx ? rx.view() : { on: false, error: '', port: 0, session: null }),
    set: (on) => (on ? start() : stop()),
    end: () => { if (rx) rx.end(); },
    shutdown: stop,
  };
}

module.exports = { airplayHost };

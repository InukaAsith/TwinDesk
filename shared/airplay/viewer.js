// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Receive AirPlay on a PC or Linux computer (AirPlay & SMB): the receiver (receiver.js) while the
// switch is on, and a window with the picture while a device mirrors to it, in the device's shape
// (turning with it), with its sound (AAC-ELD, decoded in the window); its buttons go full screen,
// turn the sound off and stop. Closing it stops the mirroring.
// Music an app sends here (AirPlay to a speaker: ALAC) has no window: it plays from a hidden one
// (the same page, its decoders), and what plays (title, artist, album, art, where it is) shows on
// the Audio and Overview pages with Previous, Play/Pause, Next (dacp.js) and Stop.
// The Mac has its own receiver.
//
// airplayHost({dir, name(), t, pushState, say?, opts?()}) → {view(), set(on), end(), ctl(a), options(), shutdown()}
//   opts() → {music, sound, full}: accept music-only senders, play a mirrored screen's sound, open
//   the mirror full screen (AirPlay & SMB's switches; settings.web.airplayMusic/airplaySound/airplayFull).
//   view().session.now (music): {title, artist, album, art (data URL), playing, position, duration, at}.
//   ctl('toggle' | 'next' | 'prev' | 'stop').
//   view().session.via: how the sender came in ('ethernet' | 'wifi' | '', lantype.js).
'use strict';

const path = require('path');
const { BrowserWindow, ipcMain, screen, nativeImage } = require('electron');
const { AirPlayReceiver } = require('./receiver.js');
const { dacpSend } = require('./dacp.js');
const { lanType } = require('../lantype.js');

function airplayHost(o) {
  const t = o.t || ((s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? String(v[k]) : m)));
  let rx = null;
  let win = null;
  let ready = false;
  let config = null; // the last codec record: a window that opens late starts with it
  let shape = null;
  let mode = null; // {t: 'mode', mirroring, name}: the window's first message
  let now = null; // music: what plays
  let lastAudio = 0;
  let playTimer = null;
  const opts = () => ({ music: true, sound: true, full: false, ...(o.opts ? o.opts() : {}) });

  const send = (m) => { if (win && !win.isDestroyed() && ready) win.webContents.send('airplay:in', m); };

  function fit(w, h) {
    if (!win || win.isDestroyed() || !win.mirroring || win.isFullScreen() || !(w > 0 && h > 0)) return;
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
    const music = !info.mirroring;
    mode = { t: 'mode', mirroring: !music, name: info.name, text: music ? '' : t('Waiting for the picture…') };
    // A mirror window and music's hidden one: a new kind of session gets a new window.
    if (win && !win.isDestroyed() && win.mirroring === !music) {
      win.setTitle(t('AirPlay · {name}', { name: info.name }));
      send(mode);
      if (!music) win.show();
      return;
    }
    if (win && !win.isDestroyed()) { const w = win; win = null; w.destroy(); }
    ready = false;
    shape = null;
    win = new BrowserWindow({
      width: 420, height: 860, backgroundColor: '#000000', title: t('AirPlay · {name}', { name: info.name }),
      autoHideMenuBar: true, show: !music, skipTaskbar: music, fullscreen: !music && opts().full,
      webPreferences: { preload: path.join(__dirname, 'preload-viewer.js'), contextIsolation: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    win.mirroring = !music;
    win.on('enter-full-screen', () => send({ t: 'full', on: true }));
    win.on('leave-full-screen', () => send({ t: 'full', on: false }));
    win.on('page-title-updated', (e) => e.preventDefault());
    // Esc leaves full screen (Open full screen), F11 goes back.
    win.webContents.on('before-input-event', (e, i) => {
      if (i.type !== 'keyDown' || !win || win.isDestroyed()) return;
      if (i.key === 'Escape' && win.isFullScreen()) { e.preventDefault(); win.setFullScreen(false); }
      if (i.key === 'F11' && win.mirroring) { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    });
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
    if (mode) send(mode);
    send({ t: 'full', on: win.isFullScreen() });
    if (config) send(config);
  });
  // The window's buttons: full screen, and stop (the sender stops too).
  ipcMain.on('airplay:control', (e, cmd) => {
    if (!win || e.sender !== win.webContents) return;
    if (cmd === 'full' && win.mirroring) win.setFullScreen(!win.isFullScreen());
    if (cmd === 'stop') { if (rx && rx.active) rx.end(); else close(); }
  });
  ipcMain.on('airplay:size', (e, s) => { if (win && e.sender === win.webContents && s) fit(Number(s.w), Number(s.h)); });

  // Music: playing while packets come (a pause is a FLUSH, then none); the pages hear of a change.
  const setPlaying = (on) => {
    if (!now || now.playing === on) return;
    now.position = now.playing ? now.position + (Date.now() - now.at) / 1000 : now.position;
    now.at = Date.now();
    now.playing = on;
    o.pushState();
  };
  const musicOn = () => rx && rx.active && rx.active.info && !rx.active.info.mirroring;

  function start() {
    if (rx) return;
    const d = screen.getPrimaryDisplay();
    const px = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    // Landscape, at most 1920 × 1080: what the sender scales its picture for.
    const k = Math.min(1, 1920 / Math.max(px.width, px.height));
    rx = new AirPlayReceiver({ name: o.name(), dir: o.dir, allowMusic: opts().music, display: { width: Math.round(Math.max(px.width, px.height) * k), height: Math.round(Math.min(px.width, px.height) * k), fps: 60 } });
    rx.on('session', (info) => {
      config = null;
      now = info.mirroring ? null : { title: '', artist: '', album: '', art: '', playing: false, position: 0, duration: 0, at: Date.now() };
      open(info);
      clearInterval(playTimer);
      if (now) playTimer = setInterval(() => setPlaying(Date.now() - lastAudio < 1200), 500);
      if (o.say) o.say(t('AirPlay'), info.mirroring ? t('{name} is mirroring to this computer', { name: info.name }) : t('{name} is playing on this computer', { name: info.name }));
    });
    rx.on('config', (c) => {
      config = { t: 'config', codec: c.codec, avcC: c.avcC };
      send(config);
      if (c.width && c.height) fit(c.width, c.height);
    });
    rx.on('frame', (f) => send({ t: 'frame', data: f.data, key: f.key }));
    // ALAC (music), AAC-LC and AAC-ELD (mirroring): decoded in the window. Mirroring sound off: none.
    rx.on('audio', (a) => {
      if (!(a.ct === 2 || a.ct === 4 || a.ct === 8)) return;
      const music = musicOn();
      if (music) lastAudio = Date.now();
      if (music || opts().sound) send({ t: 'audio', ct: a.ct, data: a.data, seq: a.seq, spf: a.spf });
    });
    rx.on('volume', (db) => send({ t: 'volume', db }));
    rx.on('meta', (m) => { if (now) { Object.assign(now, m); o.pushState(); } });
    rx.on('art', (a) => {
      if (!now) return;
      // Small, for the pages' 56-px tile (the sender's is often 600 px and 150 KB).
      let url = '';
      try { if (a) { const img = nativeImage.createFromBuffer(a.data); url = img.isEmpty() ? '' : img.resize({ width: 160, quality: 'good' }).toDataURL(); } } catch (_) {}
      now.art = url;
      o.pushState();
    });
    rx.on('progress', (p) => { if (now) { now.position = p.position; now.duration = p.duration; now.at = Date.now(); o.pushState(); } });
    rx.on('flush', () => { if (now) { lastAudio = 0; setPlaying(false); } });
    rx.on('end', () => { mode = null; now = null; clearInterval(playTimer); close(); o.pushState(); });
    rx.on('change', () => o.pushState());
    rx.start().then(() => o.pushState());
  }

  function stop() {
    close();
    now = null;
    clearInterval(playTimer);
    if (rx) { rx.stop(); rx.removeAllListeners(); rx = null; }
    o.pushState();
  }

  return {
    view: () => {
      const v = rx ? rx.view() : { on: false, error: '', port: 0, session: null };
      if (v.session) {
        v.session = { ...v.session, via: { Ethernet: 'ethernet', 'Wi-Fi': 'wifi' }[lanType(v.session.ip)] || '' };
        if (now) v.session.now = { ...now, control: !!(rx.active && rx.active.dacp) };
      }
      return v;
    },
    set: (on) => (on ? start() : stop()),
    end: () => { if (rx) rx.end(); },
    // The pages' buttons for music: Previous, Play/Pause, Next back to the sender; Stop here.
    ctl: async (a) => {
      if (!rx || !rx.active) return false;
      if (a === 'stop') { rx.end(); return true; }
      const s = rx.active;
      const cmd = { toggle: 'playpause', next: 'nextitem', prev: 'previtem' }[a];
      if (!cmd || !s.dacp) return false;
      return dacpSend({ ip: s.ip, id: s.dacp.id, remote: s.dacp.remote }, cmd);
    },
    // The switches changed: music takes effect for the next sender, sound and full screen now.
    options: () => {
      const v = opts();
      if (rx) { rx.allowMusic = v.music; if (!v.music && musicOn()) rx.end(); }
      if (win && !win.isDestroyed() && win.mirroring) {
        win.setFullScreen(!!v.full);
        send({ t: 'mute', on: !v.sound });
      }
    },
    shutdown: () => stop(),
  };
}

module.exports = { airplayHost };

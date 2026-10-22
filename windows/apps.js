// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Mac apps on the PC, main-process side: the app list and launching
// for the Apps tab, and the per-app windows. Those windows are opened by the Monitor 2 renderer
// (window.open, so they can show the same video stream, cropped); here they get the app's title,
// icon and their own AppUserModelID, so each Mac app has its own taskbar button.
// Each Mac app gets a Start menu shortcut (folder "TwinDesk Apps") that starts
// `TwinDesk.exe --mac-app=<id>`, and its windows carry the same AppUserModelID and relaunch
// command, so Pin to Start / Pin to taskbar work. Its windows never go full screen or past 1:1.
const { app, BrowserWindow, nativeImage, shell, screen: displays } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const P = require('../shared/protocol.js');

const T = P.T;

class Apps {
  // opts: link, allowed() (macApps.on), getMonitor() → BrowserWindow|null, popup(kind, text), peerName(), onChange(),
  // onWatch() (an app window opened or closed: screen.policy may change)
  constructor(opts) {
    Object.assign(this, opts);
    this.opening = new Map(); // id → placeholder window: the app's taskbar button until its first window
    this.list = [];       // [{id, name, icon}] from apps.result
    this.windows = [];    // last app.windows list
    this.picture = null;  // {width, height}: stream pixel size from app.windows pw/ph
    this.message = '';
    this.loading = false;
    this.iconDir = path.join(app.getPath('userData'), 'app-icons');

    this.link.on(T.APPS_RESULT, (m) => {
      this.loading = false;
      this.list = (Array.isArray(m.apps) ? m.apps : [])
        .filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string')
        .map((a) => ({ id: a.id, name: a.name, icon: typeof a.icon === 'string' && a.icon.startsWith('data:image/png;base64,') ? a.icon : '' }));
      this.onChange();
    });
    this.link.on(T.APP_LAUNCHED, (m) => {
      const a = this.list.find((x) => x.id === m.id);
      this.message = m.ok ? '' : 'Couldn’t open ' + (a ? a.name : m.id) + (m.why ? ': ' + m.why : '');
      if (!m.ok) this._opened(m.id);
      this.onChange();
    });
    this.link.on(T.APP_WINDOWS, (m) => {
      this.windows = (Array.isArray(m.windows) ? m.windows : []).filter(validWindow);
      if (m.pw > 0 && m.ph > 0) this.picture = { width: Number(m.pw), height: Number(m.ph) };
      this._toMonitor();
      this.onWatch();
    });
    this.link.on('closed', () => {
      this.windows = [];
      this._toMonitor();
      for (const id of [...this.opening.keys()]) this._opened(id);
    });
  }

  refresh() {
    if (!this.allowed()) return;
    if (this.link.send({ t: T.APPS_LIST })) { this.loading = true; this.onChange(); }
  }

  launch(id) {
    if (typeof id !== 'string' || !this.allowed()) return;
    this.message = '';
    if (!this.link.send({ t: T.APP_LAUNCH, id })) return;
    const a = this.list.find((x) => x.id === id);
    const name = a ? a.name : this._shortcutName(id) || 'the app';
    this.popup('away', 'Opening ' + name + ' on ' + this.peerName() + '…');
    if (!this.windows.some((w) => w.id === id)) this._placeholder(id, name, a);
    this.onChange();
  }

  // The app's taskbar button right away, busy until its first window arrives.
  _placeholder(id, name, a) {
    if (this.opening.has(id)) return;
    const win = new BrowserWindow({
      width: 320, height: 120, show: false, title: 'Opening ' + name + '…', fullscreenable: false, backgroundColor: '#1e1e1f',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.setMenu(null);
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;font:13px Segoe UI,sans-serif;color:#aaa;background:#1e1e1f;display:grid;place-items:center;height:100vh">Opening ' + name.replace(/[<&]/g, '') + '…</body>'));
    this._details(win, id, a);
    win.setProgressBar(2, { mode: 'indeterminate' });
    win.minimize(); // only its taskbar button shows
    win.on('closed', () => { if (this.opening.get(id) === win) { this.opening.delete(id); this.onWatch(); } });
    this.opening.set(id, win);
    this.onWatch();
    setTimeout(() => this._opened(id), 30000);
  }

  _opened(id) {
    const win = this.opening.get(id);
    if (!this.opening.delete(id)) return;
    if (win && !win.isDestroyed()) win.destroy();
    this.onWatch();
  }

  // ---- pinning ----

  static aumid(id) {
    return 'org.macshare.macapp.' + crypto.createHash('sha1').update(id).digest('hex').slice(0, 10);
  }

  // How this copy of TwinDesk opens one Mac app: "TwinDesk.exe --mac-app=<id>".
  static relaunch(id) {
    const args = (app.isPackaged ? [] : [app.getAppPath()]).concat('--mac-app=' + id);
    return { target: process.execPath, args: args.map((x) => (/\s/.test(x) ? '"' + x + '"' : x)).join(' ') };
  }

  get startDir() {
    return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TwinDesk Apps');
  }

  _lnk(name) {
    const safe = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 100) || 'Mac app';
    return path.join(this.startDir, safe + '.lnk');
  }

  // The name of a Mac app we made a shortcut for earlier (the list isn't loaded yet at start).
  _shortcutName(id) {
    try {
      for (const f of fs.readdirSync(this.startDir)) {
        const l = shell.readShortcutLink(path.join(this.startDir, f));
        if (String(l.args).endsWith('--mac-app=' + id)) return f.replace(/\.lnk$/i, '');
      }
    } catch (_) { /* none yet */ }
    return '';
  }

  // Start menu shortcut for one Mac app (made on its first open, and by Apps tab › Pin to Start).
  pin(id, tell) {
    const a = this.list.find((x) => x.id === id);
    if (!a) return false;
    const img = a.icon ? nativeImage.createFromDataURL(a.icon) : null;
    const ico = img && !img.isEmpty() ? this._ico(a.id, img) : '';
    const r = Apps.relaunch(id);
    const file = this._lnk(a.name);
    try {
      fs.mkdirSync(this.startDir, { recursive: true });
      const ok = shell.writeShortcutLink(file, fs.existsSync(file) ? 'replace' : 'create', {
        target: r.target, args: r.args, description: a.name + ' on ' + this.peerName() + ' (TwinDesk)', appUserModelId: Apps.aumid(id),
        ...(ico ? { icon: ico, iconIndex: 0 } : {}),
      });
      if (!ok) throw new Error('Windows refused the shortcut');
    } catch (e) {
      this.message = 'Couldn’t add ' + a.name + ' to Start: ' + e.message;
      this.onChange();
      return false;
    }
    if (tell) {
      this.message = a.name + ' is in Start › TwinDesk Apps. Right-click it there to pin it to Start or the taskbar.';
      this.onChange();
    }
    return true;
  }

  // Taskbar identity of every window of one Mac app: grouped as that app with its icon, and Pin to
  // taskbar relaunches it.
  _details(win, id, a) {
    const img = a && a.icon ? nativeImage.createFromDataURL(a.icon) : null;
    if (img && !img.isEmpty()) win.setIcon(img);
    if (!win.setAppDetails) return;
    const ico = img && !img.isEmpty() ? this._ico(id, img) : '';
    const r = Apps.relaunch(id);
    win.setAppDetails({
      appId: Apps.aumid(id), ...(ico ? { appIconPath: ico, appIconIndex: 0 } : {}),
      relaunchCommand: '"' + r.target + '" ' + r.args, relaunchDisplayName: a ? a.name : 'Mac app',
    });
  }

  // The Monitor 2 renderer (re)loaded: give it the current windows.
  _toMonitor() {
    const w = this.getMonitor();
    if (w && !w.isDestroyed()) w.webContents.send('app-windows', this.windows);
  }

  resend() { this._toMonitor(); }

  // Called once per Monitor 2 window: lets the renderer open app windows and dresses them up.
  attach(monitorWin) {
    const wc = monitorWin.webContents;
    wc.setWindowOpenHandler((d) => {
      if (!/^app-\d+$/.test(d.frameName)) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          fullscreenable: false,
          backgroundColor: '#000000',
          autoHideMenuBar: true,
          show: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
        },
      };
    });
    wc.on('did-create-window', (win, d) => {
      const wid = Number(String(d.frameName).slice(4));
      this._dress(win, wid);
      win.setMenu(null);
      win.on('page-title-updated', (e) => e.preventDefault());
    });
  }

  // Title, size, icon and taskbar identity for one app window.
  _dress(win, wid) {
    const w = this.windows.find((x) => x.wid === wid);
    if (!w) return;
    const a = this.list.find((x) => x.id === w.id);
    win.setTitle(w.title || (a ? a.name : 'Mac app'));
    // 1:1 with the Mac's pixels: w·pw × h·ph device pixels, ÷ the scale of the monitor it opens on.
    const mon = this.getMonitor();
    const stream = this.picture || (mon && mon.streamSize) || { width: 1920, height: 1080 };
    const scale = displays.getDisplayMatching(win.getBounds()).scaleFactor || 1;
    let width = (w.w * stream.width) / scale, height = (w.h * stream.height) / scale;
    const grow = Math.max(1, 200 / width, 120 / height); // tiny windows grow, keeping their shape
    width = Math.round(width * grow);
    height = Math.round(height * grow);
    // Never bigger than 1:1 (the stretched picture looked bad) nor than this monitor's
    // work area; no full screen; maximize = the largest allowed size, centred.
    const work = displays.getDisplayMatching(win.getBounds()).workArea;
    const fit = Math.min(1, work.width / width, (work.height - 40) / height);
    const max = { width: Math.floor(width * fit), height: Math.floor(height * fit) };
    win.setFullScreenable(false);
    win.setContentSize(max.width, max.height);
    win.setAspectRatio(width / height);
    const [ow, oh] = win.getSize(), [cw, ch] = win.getContentSize();
    const maxW = max.width + ow - cw, maxH = max.height + oh - ch;
    win.setMaximumSize(maxW, maxH);
    win.on('maximize', () => {
      win.unmaximize();
      win.setBounds({ x: Math.round(work.x + (work.width - maxW) / 2), y: Math.round(work.y + (work.height - maxH) / 2), width: maxW, height: maxH });
    });
    // Own AppUserModelID → own taskbar button with the Mac app's icon; Pin to taskbar relaunches it.
    this._details(win, w.id, a);
    if (a) this.pin(a.id, false); // first open: its Start menu shortcut
    this._opened(w.id);
  }

  // A .ico that embeds the PNG (supported since Windows Vista), cached per app.
  _ico(id, img) {
    try {
      fs.mkdirSync(this.iconDir, { recursive: true });
      const file = path.join(this.iconDir, id.replace(/[^\w.-]/g, '_') + '.ico');
      if (fs.existsSync(file)) return file;
      const png = img.resize({ width: 64, height: 64 }).toPNG();
      const head = Buffer.alloc(22);
      head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4); // ICONDIR: 1 image
      head.writeUInt8(64, 6); head.writeUInt8(64, 7); head.writeUInt8(0, 8); head.writeUInt8(0, 9);
      head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
      fs.writeFileSync(file, Buffer.concat([head, png]));
      return file;
    } catch (_) { return ''; }
  }

  view() {
    return { list: this.list, loading: this.loading, message: this.message, open: this.windows.length };
  }
}

function validWindow(w) {
  const n = (v) => typeof v === 'number' && v >= 0 && v <= 1;
  return w && Number.isInteger(w.wid) && typeof w.id === 'string' && n(w.x) && n(w.y) && n(w.w) && n(w.h) && w.w > 0 && w.h > 0;
}

module.exports = Apps;

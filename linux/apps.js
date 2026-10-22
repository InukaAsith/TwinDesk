// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Mac apps on this computer (copy of windows/apps.js), main-process
// side: the app list and launching for the Apps tab, and the per-app windows. Those windows are
// opened by the Monitor 2 renderer (window.open, so they can show the same video stream, cropped);
// here they get the app's title and icon. Each Mac app opened once gets a launcher in the app menu
// (~/.local/share/applications/twindesk-mac-<hash>.desktop, "<App> (on <Mac>)") that starts
// `twindesk --mac-app=<id>`, so it can be pinned to the dock / favourites like any app. Its windows
// never go full screen or past 1:1.
const { app, BrowserWindow, nativeImage, screen: displays } = require('electron');
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
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;font:13px system-ui,Ubuntu,Cantarell,sans-serif;color:#aaa;background:#1e1e1f;display:grid;place-items:center;height:100vh">Opening ' + name.replace(/[<&]/g, '') + '…</body>'));
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

  // ---- pinning (as app-menu launchers) ----

  static key(id) {
    return crypto.createHash('sha1').update(id).digest('hex').slice(0, 10);
  }

  // How this copy of TwinDesk opens one Mac app.
  static command(id) {
    const base = process.env.APPIMAGE ? [process.env.APPIMAGE] : app.isPackaged ? [process.execPath] : [process.execPath, app.getAppPath()];
    return base.concat('--mac-app=' + id);
  }

  get menuDir() {
    return path.join(process.env.XDG_DATA_HOME || path.join(require('os').homedir(), '.local', 'share'), 'applications');
  }

  _desktopFile(id) {
    return path.join(this.menuDir, 'twindesk-mac-' + Apps.key(id) + '.desktop');
  }

  // The name of a Mac app we made a launcher for earlier (the list isn't loaded yet at start).
  _shortcutName(id) {
    try {
      const m = /^X-TwinDesk-Name=(.*)$/m.exec(fs.readFileSync(this._desktopFile(id), 'utf8'));
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }

  // App-menu launcher for one Mac app (made on its first open, and by Apps tab › Add to app menu).
  pin(id, tell) {
    const a = this.list.find((x) => x.id === id);
    if (!a) return false;
    const img = a.icon ? nativeImage.createFromDataURL(a.icon) : null;
    const icon = img && !img.isEmpty() ? this._png(id, img) : '';
    // Exec quoting per the Desktop Entry spec: "…" with \" \` \$ \\ escaped (and \\ doubled again by the file format).
    const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : '"' + String(s).replace(/(["`$\\])/g, '\\\\$1') + '"');
    const clean = (s) => String(s).replace(/[\r\n]/g, ' ');
    try {
      fs.mkdirSync(this.menuDir, { recursive: true });
      fs.writeFileSync(this._desktopFile(id), [
        '[Desktop Entry]', 'Type=Application',
        'Name=' + clean(a.name),
        'Comment=' + clean(a.name + ' on ' + this.peerName() + ' (TwinDesk)'),
        'Exec=' + Apps.command(id).map(q).join(' '),
        ...(icon ? ['Icon=' + icon] : []),
        'Terminal=false', 'Categories=Network;RemoteAccess;', 'X-TwinDesk-Name=' + clean(a.name), '',
      ].join('\n'));
    } catch (e) {
      this.message = 'Couldn’t add ' + a.name + ' to the app menu: ' + e.message;
      this.onChange();
      return false;
    }
    if (tell) {
      this.message = a.name + ' is in the app menu now (as "' + a.name + '"). Pin it to the dock from there.';
      this.onChange();
    }
    return true;
  }

  // The Mac app's icon on each of its windows.
  _details(win, id, a) {
    const img = a && a.icon ? nativeImage.createFromDataURL(a.icon) : null;
    if (img && !img.isEmpty()) win.setIcon(img);
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
    this._details(win, w.id, a);
    if (a) this.pin(a.id, false); // first open: its app-menu launcher
    this._opened(w.id);
  }

  // The app's icon as a PNG file for its launcher, cached per app.
  _png(id, img) {
    try {
      fs.mkdirSync(this.iconDir, { recursive: true });
      const file = path.join(this.iconDir, 'mac-' + Apps.key(id) + '.png');
      if (!fs.existsSync(file)) fs.writeFileSync(file, img.resize({ width: 128, height: 128 }).toPNG());
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

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// PC apps on the Mac: the Start-menu apps with icons, opened on the
// Mac's request; every visible window of an app opened that way is streamed on its own (`rtc2`
// kind 'window', sender.js) while the Mac's `papp.policy` accepts and "Let the Mac open this PC's
// apps" is on — menus, drop-downs and other pop-ups too, as `popup` entries with their `owner` and
// offset, so the Mac draws them over the right window. The Mac's input in such a window (`in.*` +
// `wid`) is injected at that window. ReZume sends an app that's already open the same way (adopt):
// its windows only while ReZume lets it (not this tab's switch), and closing one there stops only that.
const { desktopCapturer, screen: displays } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const P = require('../shared/protocol.js');
const { script } = require('./ps');
const RemoteInput = require('./remote-input');
const PcScreen = require('./pcscreen'); // fps()

const T = P.T;
const POLL_MS = 250;
const ICON_PX = 128;
const MAX_POPUPS = 6; // per app: a menu, its submenus, a drop-down
const MAX_W = 3840, MAX_H = 2160; // window pictures follow the window's size up to this
const SKIP = /\b(uninstall|uninstaller|readme|read me|help|documentation|manual|website|web site|release notes|license|support)\b/i;
// Known-folder ids Windows uses in Start-menu AppIDs of desktop apps.
const FOLDERS = {
  '{6D809377-6AF0-444B-8957-A3773F02200E}': process.env.ProgramW6432 || process.env.ProgramFiles,
  '{905E63B6-C1BF-494E-B29C-65B732D3D21A}': process.env.ProgramFiles,
  '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}': process.env['ProgramFiles(x86)'],
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}': path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
  '{F38BF404-1D43-42F2-9305-67DE0B28FC23}': process.env.SystemRoot,
  '{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}': path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64'),
};
const LIST_PS = 'pcapps-list'; // scripts/pcapps-list.ps1: Get-StartApps as JSON

// The exe of a desktop app's AppID ('{folder}\\dir\\app.exe' or a full path), else '' (an AUMID).
function exeOf(appId) {
  const m = /^(\{[0-9A-F-]{36}\})\\(.+)$/i.exec(appId);
  const p = m ? (FOLDERS[m[1].toUpperCase()] ? path.join(FOLDERS[m[1].toUpperCase()], m[2]) : '') : /^[a-z]:\\/i.test(appId) ? appId : '';
  return /\.exe$/i.test(p) ? p.toLowerCase() : '';
}

class PcApps {
  // opts: link, helper, sender, settings (shared), inputAllowed(), onChange()
  constructor(opts) {
    Object.assign(this, opts);
    this.generation = 0;
    this.syncGeneration = 0;
    this.pendingLaunches = new Set();
    this.stopped = false;
    this.macAccepts = false; // papp.policy
    this.apps = null; // [{id, name, exe}] from Get-StartApps (cached)
    this.icons = new Map(); // id → data URL
    this.launched = new Map(); // id → {id, exe, pids: Set, since, before: Set(wid), had, lastSeen}
    this.windows = []; // the list last sent to the Mac
    this.moved = new Map(); // wid → {x, y, w, h, pid}: windows moved to the other computer (moveOut), and where they were
    this.streams = new Map(); // wid → session
    this.failed = new Set(); // wids whose capture failed (not retried)
    this.timer = null;
    this.sentKey = '';
    this.message = '';
    this.input = new RemoteInput(opts);

    const link = this.link;
    link.on('welcome', () => { this.generation++; this.macAccepts = false; this.sentKey = ''; });
    link.on('closed', () => { this.generation++; clearTimeout(this.timer); this.timer = null; this.macAccepts = false; this.launched.clear(); this.bringBack(); this._sync([]); });
    link.on(T.PAPP_POLICY, (m) => {
      this.macAccepts = m.accept === true;
      if (this.macAccepts && this.allowed) this._build().catch(() => {}); // icons ready before the Mac asks
      this._sync(this.windows);
      this.onChange();
    });
    link.on(T.PAPPS_LIST, () => this._list());
    link.on(T.PAPP_LAUNCH, (m) => typeof m.id === 'string' && this._launch(m.id));
    link.on(T.PAPP_FOCUS, (m) => this._mine(m.wid) && !this._popup(m.wid) && this._raise(m.wid));
    // Closing a moved window's copy over there brings it back here (it isn't closed); one ReZume sent stays open here.
    link.on(T.PAPP_CLOSE, (m) => this._mine(m.wid) && (this.moved.has(m.wid) ? this.bringBack(m.wid) : this._unfollow(m.wid) || this.helper.send('winClose', { wid: m.wid })));
    link.on(T.PAPP_RETURN, (m) => this.moved.has(m.wid) && this.bringBack(m.wid, true));
    link.on(T.PAPP_SIZE, (m) => {
      const ok = (v) => Number.isInteger(v) && v >= 50 && v <= 16384;
      if (this._mine(m.wid) && !this._popup(m.wid) && ok(m.w) && ok(m.h)) this.helper.send('winSize', { wid: m.wid, w: m.w, h: m.h });
    });
    for (const t of RemoteInput.TYPES) link.on(t, (m) => this._input(m));
    // A top-level window appeared or went (a menu opened?): look right away instead of at the next tick.
    this.helper.on('event', (name) => name === 'winShown' && this.launched.size && this._poll(true));
    this.helper.on('ready', () => this._moveKey()); // a restarted helper is told the move key again
    this.sender.on('state', (session, s) => {
      if (s.status !== 'ended' && s.status !== 'failed') return;
      for (const [wid, ses] of this.streams) {
        if (ses !== session) continue;
        this.streams.delete(wid);
        this.failed.add(wid);
        this.sender.stop(session);
      }
    });
  }

  get allowed() {
    return this.settings.pcApps.allow;
  }

  // An app followed for ReZume (adopt), which this tab's switch doesn't stop.
  get rezumes() {
    for (const a of this.launched.values()) if (a.rz) return true;
    return false;
  }

  // The switch changed. Off: nothing is followed or streamed any more (the apps keep running), but
  // what ReZume sent.
  apply() {
    this.generation++;
    if (!this.settings.pcApps.moveWindows) this.bringBack(); // moving is its own switch, apart from letting the other open apps
    this._moveKey();
    if (!this.allowed) {
      for (const [id, a] of this.launched) if (!a.rz) this.launched.delete(id);
      if (this.launched.size) this._poll(true);
      else this._sync([]);
    }
    this.onChange();
  }

  // ReZume: the windows of an app that's open here (its exe), streamed to the other computer.
  adopt(exe) {
    if (this.stopped || typeof exe !== 'string' || !/\.exe$/i.test(exe) || this.link.status.state !== 'connected') return false;
    const key = exe.toLowerCase();
    for (const a of this.launched.values()) {
      if (a.exe !== key) continue;
      if (a.skip) a.skip.clear();
      this._poll(true);
      return true;
    }
    this.launched.set(exe, { id: exe, exe: key, rz: true, skip: new Set(), pids: new Set(), since: Date.now(), had: false, lastSeen: 0, before: new Set(), beforePids: new Set() });
    this._poll(true);
    return true;
  }

  // ReZume's window sharing off (app: only that one's): its windows stop going.
  unadopt(app) {
    let any = false;
    for (const [id, a] of this.launched) if (a.rz && (!app || a.id === app)) { this.launched.delete(id); any = true; }
    if (any) this._poll(true);
  }

  // A window ReZume sent, closed there: only its copy goes. The window stays open here and comes
  // back to the front (it never left this screen).
  _unfollow(wid) {
    const w = this.windows.find((x) => x.wid === wid);
    const a = w && this.launched.get(w.id);
    if (!a || !a.rz) return false;
    a.skip.add(wid);
    this._raise(wid);
    this._poll(true);
    return true;
  }

  _mine(wid) {
    return typeof wid === 'number' && this.windows.some((w) => w.wid === wid);
  }

  _popup(wid) {
    return this.windows.some((w) => w.wid === wid && w.popup);
  }

  _raise(wid) {
    this.lastRaised = wid;
    this.helper.send('winRaise', { wid });
  }

  // The helper grabs a window with the move key and a click (AppWindows.TryGrab); "" = off.
  _moveKey() {
    const c = this.settings.pcApps;
    this.helper.send('moveWin', { key: c.moveWindows ? c.moveKey : '' });
  }

  // Move windows (shared/movewin.js, loaded only when used): a grabbed window crossed with the
  // pointer goes over there; bringBack returns one or all of them.
  moveOut(wid, from) {
    if (!this.settings.pcApps.moveWindows) return Promise.resolve(false);
    return require('../shared/movewin.js').moveOut(this, wid, from);
  }

  bringBack(wid, home = false) {
    if (this.moved.size) require('../shared/movewin.js').bringBack(this, wid, home);
  }

  _cursorPx() {
    return displays.dipToScreenPoint(displays.getCursorScreenPoint());
  }

  _movedExtra(w) {
    return workArea(w);
  }

  async _apps() {
    if (this.apps && Date.now() - this.appsAt < 60000) return this.apps;
    const raw = JSON.parse((await script(LIST_PS, {}, 60000)).trim() || '[]');
    const seen = new Set();
    this.apps = (Array.isArray(raw) ? raw : [raw])
      .filter((a) => a && typeof a.Name === 'string' && typeof a.AppID === 'string' && !SKIP.test(a.Name))
      .filter((a) => !/\.[a-z0-9]{2,4}$/i.test(a.AppID) || /\.exe$/i.test(a.AppID)) // no .chm/.url/.txt…
      .filter((a) => !seen.has(a.AppID.toLowerCase()) && seen.add(a.AppID.toLowerCase()))
      .map((a) => ({ id: a.AppID, name: a.Name, exe: exeOf(a.AppID) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.appsAt = Date.now();
    return this.apps;
  }

  // The list with icons (cached; the first build takes several seconds). One build at a time.
  _build() {
    if (!this.building) {
      this.building = (async () => {
        const apps = await this._apps();
        const missing = apps.filter((a) => !this.icons.has(a.id));
        for (let i = 0; i < missing.length; i += 15) { // small batches: each helper reply is quick
          const batch = missing.slice(i, i + 15);
          const r = await this.helper.request('icons', { size: ICON_PX, paths: batch.map((a) => 'shell:AppsFolder\\' + a.id) }).catch(() => null);
          if (r) batch.forEach((a, k) => this.icons.set(a.id, (r.icons && r.icons[k]) || '')); // a timed-out batch is retried next time
        }
        return apps.map((a) => ({ id: a.id, name: a.name, icon: this.icons.get(a.id) || '' }));
      })().finally(() => { this.building = null; });
    }
    return this.building;
  }

  async _list() {
    const generation = this.generation;
    if (!this.allowed) return this.link.send({ t: T.PAPPS_RESULT, apps: [] });
    try {
      const apps = await this._build();
      if (!this._current(generation)) return;
      this.message = '';
      this.link.send({ t: T.PAPPS_RESULT, apps });
    } catch (e) {
      if (!this._current(generation)) return;
      this.message = 'Couldn’t list this PC’s apps: ' + e.message;
      this.link.send({ t: T.PAPPS_RESULT, apps: [] });
    }
    this.onChange();
  }

  _current(generation) {
    return !this.stopped && (this.allowed || this.rezumes || this.moved.size > 0) && this.generation === generation && this.link.status.state === 'connected';
  }

  async _launch(id) {
    if (this.pendingLaunches.has(id)) return;
    const generation = this.generation;
    this.pendingLaunches.add(id);
    try { await this._launchOne(id, generation); } finally { this.pendingLaunches.delete(id); }
  }

  async _launchOne(id, generation) {
    const reply = (ok, why) => this.link.send(why ? { t: T.PAPP_LAUNCHED, id, ok, why } : { t: T.PAPP_LAUNCHED, id, ok });
    if (!this.allowed) return reply(false, 'This computer doesn’t let you open its apps (its Apps tab)');
    const app = (await this._apps().catch(() => [])).find((a) => a.id === id);
    if (!this._current(generation)) return;
    if (!app) return reply(false, 'No such app on this PC');
    const open = this.windows.find((w) => w.id === id);
    if (open) {
      this._raise(open.wid);
      return reply(true);
    }
    const now = await this.helper.request('windows').catch(() => ({ windows: [] }));
    if (!this._current(generation)) return;
    this.launched.set(id, {
      id, exe: app.exe, pids: new Set(), since: Date.now(), had: false, lastSeen: 0,
      before: new Set((now.windows || []).map((w) => w.wid)), beforePids: new Set((now.windows || []).map((w) => w.pid)),
    });
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), ['shell:AppsFolder\\' + id], { detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      });
      if (!this._current(generation)) return;
      reply(true);
    } catch (e) {
      if (!this._current(generation)) return;
      this.launched.delete(id);
      return reply(false, e.message);
    }
    this._poll();
  }

  // now: look right away (a window was shown/hidden); a look already running looks once more after.
  _poll(now) {
    if (this.ticking) { if (now) this.again = true; return; }
    if (this.timer && !now) return;
    clearTimeout(this.timer);
    const tick = async () => {
      this.timer = null;
      this.ticking = true;
      try {
        do {
          this.again = false;
          if ((!this.launched.size && !this.moved.size) || !this._current(this.generation)) return this._sync([]);
          const generation = this.generation;
          const r = await this.helper.request('windows').catch(() => null);
          if (!this._current(generation)) return;
          if (r && Array.isArray(r.windows)) this._match(r.windows);
        } while (this.again);
      } finally {
        this.ticking = false;
      }
      if (this._current(this.generation) && (this.launched.size || this.moved.size) && !this.timer) this.timer = setTimeout(tick, POLL_MS);
    };
    this.timer = setTimeout(tick, 0);
  }

  // Which windows belong to the apps the Mac opened: same AppUserModelID, same exe, or a process
  // already known to be the app's (and its children). A desktop app whose exe we can't tell from
  // its AppID learns it from the first new window that shows up after the launch.
  _match(all) {
    const now = Date.now();
    const out = [];
    const pops = [];
    const taken = new Set();
    if (this.moved.size) require('../shared/movewin.js').list(this, all, taken, out, pops); // moved windows (Move windows)
    for (const a of this.launched.values()) {
      const id = a.id.toLowerCase();
      const mine = all.filter((w) => !taken.has(w.wid) && !(a.skip && a.skip.has(w.wid)) && ((w.aumid && w.aumid.toLowerCase() === id)
        || (a.exe && String(w.exe).toLowerCase() === a.exe) || a.pids.has(w.pid) || a.pids.has(w.ppid)));
      let main = mine.filter((w) => !w.popup);
      if (!main.length && !a.exe && now - a.since > 1500 && now - a.since < 20000) {
        const fresh = all.find((w) => !w.popup && !a.before.has(w.wid) && !a.beforePids.has(w.pid) && !taken.has(w.wid));
        if (fresh) { a.exe = String(fresh.exe).toLowerCase(); main = [fresh]; }
      }
      for (const w of main) {
        taken.add(w.wid);
        a.pids.add(w.pid);
        out.push({ wid: w.wid, id: a.id, title: w.title, w: w.w, h: w.h, scale: w.scale, ...workArea(w) });
      }
      // Pop-ups: over their owner if it's one of these windows; menus have no owner, so the window
      // of the same process that was raised last, else the one under the pop-up, else the first.
      // Tiny ones (Alt key-letter hints, tooltips) are left out; at most MAX_POPUPS, biggest first.
      const popups = mine.filter((x) => x.popup && (x.w >= 64 || x.h >= 64)).sort((x, y) => y.w * y.h - x.w * x.h).slice(0, MAX_POPUPS);
      for (const w of popups) {
        const same = main.filter((m) => m.pid === w.pid);
        const owner = main.find((m) => m.wid === w.owner) || same.find((m) => m.wid === this.lastRaised)
          || same.find((m) => w.x >= m.x && w.y >= m.y && w.x < m.x + m.w && w.y < m.y + m.h) || same[0] || main[0];
        if (!owner) continue;
        taken.add(w.wid);
        pops.push({ wid: w.wid, id: a.id, title: w.title, w: w.w, h: w.h, scale: w.scale, popup: true, owner: owner.wid, x: w.x - owner.x, y: w.y - owner.y });
      }
      if (main.length) { a.had = true; a.lastSeen = now; }
      // Closed (no windows for 3 s), or never showed one in 30 s: stop following it.
      if ((a.had && now - a.lastSeen > 3000) || (!a.had && now - a.since > 30000)) this.launched.delete(a.id);
    }
    this._sync(out.concat(pops)).catch(() => {}); // owners before their pop-ups
  }

  // Send the window list on change; start/stop one stream per window.
  async _sync(list) {
    const syncGeneration = ++this.syncGeneration;
    const key = JSON.stringify(list);
    if (key !== this.sentKey && this.link.status.state === 'connected') this.link.send({ t: T.PAPP_WINDOWS, windows: list });
    const changed = key !== this.sentKey;
    this.sentKey = key;
    this.windows = list;
    for (const wid of this.failed) if (!list.some((w) => w.wid === wid)) this.failed.delete(wid);
    const want = this.macAccepts && this._current(this.generation) ? new Set(list.map((w) => w.wid)) : new Set();
    for (const [wid, session] of this.streams) {
      if (!want.has(wid)) {
        this.streams.delete(wid);
        this.sender.stop(session);
      }
    }
    if (!want.size) this.input.release();
    const start = [...want].filter((wid) => !this.streams.has(wid) && !this.failed.has(wid));
    if (start.length) {
      if (!this.sourceLookup) {
        this.sourceLookup = desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
          .catch(() => []).finally(() => { this.sourceLookup = null; });
      }
      const sources = await this.sourceLookup;
      if (syncGeneration !== this.syncGeneration || !this.macAccepts || !this._current(this.generation)) return;
      for (const wid of start) {
        if (this.streams.has(wid) || !this.windows.some((w) => w.wid === wid)) continue;
        const src = sources.find((s) => s.id.startsWith('window:' + wid + ':'));
        const session = this.sender.start({
          sourceId: src ? src.id : 'window:' + wid + ':0', width: MAX_W, height: MAX_H, follow: true,
          mbps: this.settings.pcScreen.mbps, fps: PcScreen.fps(displays.getPrimaryDisplay(), this.settings.pcScreen.fps),
          steady: !!(this.settings.monitor && this.settings.monitor.pacing === 'steady'), // Playback › Steady
          offer: { kind: 'window', wid },
        });
        this.streams.set(wid, session);
      }
    }
    if (changed) this.onChange();
  }

  _input(m) {
    if (m.wid == null || !this.streams.has(m.wid)) return;
    const wid = m.wid;
    // A moved window (or its pop-up): back on a screen while it's used there, so the pointer reaches it.
    const pop = this.windows.find((w) => w.wid === wid && w.popup);
    const moved = this.moved.has(wid) ? wid : pop && this.moved.has(pop.owner) ? pop.owner : 0;
    if (moved) require('../shared/movewin.js').touch(this, moved);
    // A pop-up is never raised (that would close a menu); its owner is already in front.
    this.input.handle(m, (x, y) => this.helper.send('winMove', { wid, x, y }), this._popup(wid) ? null : () => this._raise(wid), undefined, !!moved);
  }

  // Quit: stop the window streams (the apps keep running on the PC).
  shutdown() {
    this.stopped = true;
    this.generation++;
    this.syncGeneration++;
    clearTimeout(this.timer);
    this.timer = null;
    this.windows = [];
    this.input.release();
    this.launched.clear();
    this.bringBack(); // quitting: every moved window back here
    for (const session of this.streams.values()) this.sender.stop(session);
    this.streams.clear();
  }

  view() {
    return { allow: this.allowed, macAccepts: this.macAccepts, open: this.windows.length, streaming: this.streams.size, moved: this.moved.size, moveWindows: this.settings.pcApps.moveWindows, moveKey: this.settings.pcApps.moveKey, message: this.message };
  }
}

// The work area of the monitor a window is on, in physical px (the Mac never lets its
// copy of the window grow past it).
function workArea(w) {
  try {
    const d = displays.getDisplayMatching(displays.screenToDipRect(null, { x: w.x, y: w.y, width: Math.max(1, w.w), height: Math.max(1, w.h) }));
    return { maxW: Math.round(d.workArea.width * d.scaleFactor), maxH: Math.round(d.workArea.height * d.scaleFactor) };
  } catch (_) { return {}; }
}

module.exports = PcApps;

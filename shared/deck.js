// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck on this computer (Mac, Windows, Linux): a phone or a TwinDesk Web device shows the tiles,
// this computer keeps the layout (settings.deck, shared/deck-model.js) and runs them through
// shared/deck-sys.js (no command lines, nothing an antivirus could take for malware). Loaded only
// while the Deck module is on (shared/modules.js); nothing else of it runs.
//
// Wire (shared/protocol.js DECK_*), only between this computer and a phone or web device:
//   computer → device  deck.offer {v}: on its welcome. A device without a Deck says nothing back,
//                      and this computer shows no Deck page.
//   device → computer  deck.hello {}: it has a Deck → deck.layout {layout, can, caps, mac}
//                      deck.run {id}: a tile → deck.done {id, ok, why?}
//                      deck.set {id, value}: a slider tile being dragged (the last one wins)
//                      deck.state {}: → deck.state {state}: levels, devices, switches, for its tiles
//                      deck.save {layout}: edited on the device → deck.layout to every device
//                      deck.apps {}: → deck.apps {apps: [{id, name, icon}]}
//                      deck.wins {}: the window space → deck.wins {apps, displays, front}
//                      deck.place {wid, display, zone?}: a window into a zone, or onto a display
//                      deck.arrange {display, items: [{key, wid?, zone}]}: apps side by side, each into
//                      its zone; one not running is opened first (a saved set from the shelf)
//   computer → device  deck.clip {text}: Clipboard › Send to the device
// One Deck per session kind (the phones', TwinDesk Web's): a layout saved through one goes to the
// others' devices too. Deck.view() → {surface: names of the devices with a Deck, layout, can, caps}
'use strict';

const P = require('./protocol.js');
const M = require('./deck-model.js');

const T = P.T;
const RUN_GAP_MS = 40; // one tile at a time: a burst of taps can't pile up key presses
const SET_GAP_MS = 60; // a dragged slider: at most this often, the last value always
const ZG = M.ZONE_GRID;

class Deck {
  constructor(o) {
    Object.assign(this, o);
    this.surface = null; // {name} of the device with a Deck, while one is connected
    this.busy = false;
    this.slide = new Map(); // tile id → {value, timer, at}
    this.micLevel = null;
    Deck.all.add(this);
    const on = (t, fn) => this.server.on(`t:${t}`, (m) => fn(m || {}));
    this.server.on('client', (ctx) => this.offer(ctx));
    this.server.on('closed', () => { this.surface = null; this.onChange(); });
    on(T.DECK_HELLO, () => {
      const c = this.server.current;
      this.surface = { name: (c && c.name) || '' };
      this._layout();
      this.onChange();
    });
    on(T.DECK_RUN, (m) => this.surface && this.run(String(m.id || '')));
    on(T.DECK_SET, (m) => this.surface && this.set(String(m.id || ''), Number(m.value)));
    on(T.DECK_STATE, () => this.surface && this.pushState());
    on(T.DECK_SAVE, (m) => this.surface && m.layout && this.setLayout(M.fromDevice(this.layout, m.layout)));
    on(T.DECK_APPS, () => this.surface && this._apps());
    on(T.DECK_WINS, () => this.surface && this._wins());
    on(T.DECK_PLACE, (m) => this.surface && this._place(m));
    on(T.DECK_ARRANGE, (m) => this.surface && this._arrange(m));
    if (this.server.current) this.offer(this.server.current); // loaded with a device already there
  }

  offer(ctx) {
    if (!this.web && ctx && P.isPhoneOs(ctx.os)) this.server.sendToClient({ t: T.DECK_OFFER, v: 2 }); // a computer has no Deck to show
  }

  get layout() { return M.normalize(this.load ? this.load() : null); }
  get caps() { return this.sys.caps(); }
  // The kinds of action this computer runs (the editor offers only these).
  get can() {
    const c = this.caps;
    return M.KINDS.filter((k) => ({
      volume: c.audio, mic: c.mic, output: c.outputs, input: c.outputs, bt: c.bt, bright: c.bright,
      slider: c.audio || c.bright,
    }[k] !== false));
  }
  static view() {
    const all = [...Deck.all];
    if (!all.length) return null;
    return { surface: all.filter((d) => d.surface).map((d) => d.surface.name), layout: all[0].layout, can: all[0].can, caps: all[0].caps, platform: all[0].platform };
  }

  // From this computer's Deck page or a device's editor.
  setLayout(l) {
    const n = M.normalize(l);
    this.save(n);
    for (const d of Deck.all) d._layout();
    this.onChange();
    return n;
  }

  _layout() {
    if (!this.surface) return;
    this.server.sendToClient({ t: T.DECK_LAYOUT, layout: M.forDevice(this.layout, { windows: this.caps.windows }), can: this.can, caps: this.caps, mac: this.platform === 'mac', platform: this.platform });
  }

  async _apps() {
    let apps = [];
    try { apps = await this.sys.apps(); } catch (_) { /* none */ }
    const ble = this._ble();
    this.server.sendToClient({ t: T.DECK_APPS, apps: apps.slice(0, 400).map((a) => ({ id: a.id, name: a.name, icon: ble ? '' : a.icon || '' })) });
  }

  // Levels, devices and switches for the device's tiles (and its pickers).
  async state() {
    const c = this.caps;
    const [audio, bt, bright, st] = await Promise.all([
      c.audio ? this.sys.audio().catch(() => null) : null,
      c.bt ? this.sys.bt().catch(() => null) : null,
      c.bright ? this.sys.bright().catch(() => null) : null,
      this.sys.state().catch(() => ({})),
    ]);
    return {
      ...(audio || {}),
      ...(bt ? { bt: { radio: bt.radio, devices: (bt.devices || []).slice(0, 60) } } : {}),
      ...(bright ? { displays: bright.displays || [] } : {}),
      dark: !!(st && st.dark), ...(st && st.dnd !== undefined ? { dnd: !!st.dnd } : {}),
      perf: this.sys.perf ? this.sys.perf(st || {}) : undefined,
    };
  }
  async pushState() {
    const state = await this.state();
    if (this.surface) this.server.sendToClient({ t: T.DECK_STATE, state });
    return state;
  }

  async run(id) {
    const t = M.find(this.layout, id);
    const done = (ok, why) => this.server.sendToClient({ t: T.DECK_DONE, id, ok, ...(why ? { why } : {}) });
    if (!t) return done(false, 'This tile isn’t on this computer’s Deck any more');
    if (this.busy) return done(false, 'busy');
    this.busy = true;
    try {
      await this.exec(t.action);
      done(true);
    } catch (e) {
      done(false, (e && e.message) || 'It didn’t work');
    } finally {
      setTimeout(() => { this.busy = false; }, RUN_GAP_MS);
    }
    if (['volume', 'mic', 'output', 'input', 'bt', 'bright', 'sys'].includes(t.action.k)) this.pushState().catch(() => {});
  }

  // A slider tile: its level now, then at most every SET_GAP_MS while it's dragged.
  set(id, value) {
    const t = M.find(this.layout, id);
    if (!t || t.action.k !== 'slider' || !Number.isFinite(value)) return;
    const s = this.slide.get(id) || {};
    s.value = Math.max(0, Math.min(1, value));
    this.slide.set(id, s);
    if (s.busy) return;
    const go = () => {
      const v = s.value;
      s.value = undefined;
      s.busy = true; // until the level is set and the gap after it is over
      this.level(t.action, v).catch(() => {}).finally(() => {
        s.timer = setTimeout(() => { s.timer = null; s.busy = false; if (s.value !== undefined) go(); }, SET_GAP_MS);
      });
    };
    go();
  }

  level(a, v) {
    if (a.what === 'volume') return this.sys.volume({ level: v });
    if (a.what === 'mic') return this.sys.volume({ input: true, level: v });
    return this.sys.setBright(a.display || '', v);
  }

  // Runs one action here (also from this computer's own Deck page: Try).
  async exec(a) {
    a = M.action(a);
    const mac = this.platform === 'mac';
    const s = this.sys;
    switch (a.k) {
      case 'keys': if (!a.combo) throw new Error('No shortcut set for this tile'); return this._press(M.codesOf(a.combo, mac));
      case 'text':
        if (a.text) this.helper.send('type', { text: a.text });
        if (a.enter) this._press(['Enter']);
        return undefined;
      case 'macro':
        for (const st of a.steps) {
          if (st.wait) await new Promise((r) => setTimeout(r, st.wait));
          await this.exec(st.action);
        }
        return undefined;
      case 'media': return this._press([M.MEDIA[a.what]]);
      case 'volume': {
        if (a.what === 'mute' || a.what === 'unmute') return s.volume({ mute: a.what === 'mute' });
        const cur = await s.audio();
        if (a.what === 'toggle') return s.volume({ mute: !cur.muted });
        if (a.what === 'set') return s.volume({ level: a.level / 100 });
        const v = Number(cur.volume) || 0;
        return s.volume({ level: v + (a.what === 'up' ? 1 : -1) * (a.step / 100), ...(a.what === 'up' && cur.muted ? { mute: false } : {}) });
      }
      case 'mic': {
        const on = a.what === 'toggle' ? !(await s.audio()).micMuted : a.what === 'mute';
        return s.volume({ input: true, mute: on });
      }
      case 'output': case 'input': {
        const input = a.k === 'input';
        if (a.id) return s.setDefault(a.id, input);
        const list = (await s.audio())[input ? 'inputs' : 'outputs'] || [];
        if (list.length < 2) throw new Error(input ? 'Only one microphone here' : 'Only one sound output here');
        const i = list.findIndex((d) => d.on);
        return s.setDefault(list[(i + 1) % list.length].id, input);
      }
      case 'bt': {
        if (a.what === 'on' || a.what === 'off') return s.btRadio(a.what === 'on');
        if (a.what === 'toggle') return s.btRadio(!(await s.bt()).radio);
        if (!a.id) throw new Error('No Bluetooth device set for this tile');
        let on = a.what === 'connect';
        if (a.what === 'toggleconn') { const d = ((await s.bt()).devices || []).find((x) => x.id === a.id); on = !(d && d.connected); }
        return s.btConnect(a.id, on);
      }
      case 'bright': {
        if (a.what === 'set') return s.setBright(a.display, a.level / 100);
        const ds = ((await s.bright()).displays || []).filter((d) => !a.display || d.id === a.display);
        if (!ds.length) {
          if (mac) return this._press([a.what === 'up' ? 'BrightnessUp' : 'BrightnessDown']); // a monitor macOS doesn't dim: the keys, as the keyboard has them
          throw new Error('No display here lets its brightness be changed');
        }
        for (const d of ds) await s.setBright(d.id, d.level + (a.what === 'up' ? 0.1 : -0.1));
        return undefined;
      }
      case 'slider': throw new Error('Drag it on the device');
      case 'app': if (!a.id) throw new Error('No app set for this tile'); return s.openApp(a.id);
      case 'url': if (!a.url) throw new Error('No website set for this tile'); return s.url(a.url);
      case 'open': if (!a.path) throw new Error('No file or folder set for this tile'); return s.open(a.path);
      case 'script': if (!a.path) throw new Error('No script set for this tile'); return s.script(a.path);
      case 'sys': return this._sys(a.what);
      case 'win': return this._win(a.what);
      case 'clip':
        if (a.what === 'send') return this.server.sendToClient({ t: T.DECK_CLIP, text: String(this.readClipboard() || '').slice(0, 100000) });
        return this._press(M.codesOf(`Mod+Key${{ copy: 'C', cut: 'X', paste: 'V' }[a.what]}`, mac));
      default: return undefined; // nav (the device's), none
    }
  }

  async _sys(what) {
    if ((what === 'dnd' && !this.caps.dnd) || (what === 'screenoff' && !this.caps.screenoff) || (what === 'darkmode' && !this.caps.darkmode)) throw new Error('Not on this computer');
    return this.sys.sys(what);
  }

  // The window in front: snapped to a part of its display, moved to the next one, or minimized,
  // full screen, closed. Linux: the desktop's own keys.
  async _win(what) {
    const keys = this.sys.winKeys(what);
    // Linux: the desktop's own keys where it has them (on Wayland, for everything it has).
    if (this.platform === 'linux' && (!this.caps.windows || ['min', 'close', 'max', 'full'].includes(what))) { if (!keys) throw new Error('Not on this computer'); return this._press(keys); }
    if (what === 'min' || what === 'close') return this.sys.winOp(0, what);
    if (what === 'full') return this.sys.winOp(0, this.platform === 'mac' ? 'full' : 'max');
    const { windows, front } = await this.sys.wins();
    const w = windows.find((x) => x.wid === front) || null;
    const fw = this.platform === 'linux' ? (w ? w.wid : 0) : 0; // Mac, Windows: 0 is the one in front
    const ds = this.sys.displays();
    if (!ds.length) throw new Error('No display');
    const at = w ? displayOf(ds, w) : ds.find((d) => d.main) || ds[0];
    if (what === 'nextdisplay') {
      if (ds.length < 2 || !w) throw new Error(ds.length < 2 ? 'Only one display here' : 'No window in front');
      const to = ds[(ds.indexOf(at) + 1) % ds.length];
      const fx = (w.x - at.x) / at.w, fy = (w.y - at.y) / at.h;
      return this.sys.frame(fw, { x: to.x + fx * to.w, y: to.y + fy * to.h, w: Math.min(w.w, to.w), h: Math.min(w.h, to.h) });
    }
    if (what === 'center') {
      const ww = w ? Math.min(w.w, at.w) : at.w * 0.6, hh = w ? Math.min(w.h, at.h) : at.h * 0.7;
      return this.sys.frame(fw, { x: at.x + (at.w - ww) / 2, y: at.y + (at.h - hh) / 2, w: ww, h: hh });
    }
    const z = SNAP[what];
    if (!z) throw new Error('Not a window action');
    return this.sys.frame(fw, zoneRect(at, { x: z[0], y: z[1], w: z[2], h: z[3] }));
  }

  // The device on Bluetooth: no app icons (pcnow.js sends no artwork there either). The window
  // space's answer with an icon for each of 60 apps, asked again every 4 s, filled the link until
  // it went silent and closed, and the device was back at Loading windows….
  _ble() { return (this.server.current || {}).transport === 'ble'; }

  // The window space: running apps with their windows, and the displays. One answer at a time:
  // asked again while one is being put together, that one goes out.
  async _wins() {
    if (this._winsBusy) return;
    this._winsBusy = true;
    try { await this._winsNow(); } finally { this._winsBusy = false; }
  }

  async _winsNow() {
    let out = { apps: [], displays: [], front: 0 };
    try {
      const { windows, minimized = [], front } = await this.sys.wins();
      const ds = this.sys.displays();
      const icons = this._ble() ? new Map() : await this._appIcons().catch(() => new Map());
      // Linux: an app's name from its desktop file, not its window class.
      const names = new Map();
      if (this.platform === 'linux') for (const a of await this.sys.apps().catch(() => [])) for (const k of linuxKeys(a)) if (!names.has(k)) names.set(k, a.name);
      const nameOf = (w) => names.get(appKey(w)) || appName(w);
      const apps = new Map();
      // Each window's place on its display (fractions, front first), for the device's picture of it.
      const r3 = (v) => Math.round(Math.max(-1, Math.min(2, v)) * 1000) / 1000;
      for (const w of windows) {
        const key = appKey(w);
        if (!apps.has(key)) apps.set(key, { key, name: nameOf(w), icon: icons.get(key) || '', windows: [] });
        const d = displayOf(ds, w);
        apps.get(key).windows.push({ wid: w.wid, title: String(w.title || '').slice(0, 120), display: d ? d.id : '',
          ...(d ? { f: [r3((w.x - d.x) / d.w), r3((w.y - d.y) / d.h), r3(w.w / d.w), r3(w.h / d.h)] } : {}) });
      }
      // Minimized windows: listed with their app, marked; an app with only those is marked too
      // (the device shows it apart, grayed, a tap brings it back).
      for (const w of minimized) {
        const key = appKey(w);
        if (!apps.has(key)) apps.set(key, { key, name: nameOf(w), icon: icons.get(key) || '', windows: [], min: true });
        apps.get(key).windows.push({ wid: w.wid, title: String(w.title || '').slice(0, 120), display: '', min: true });
      }
      // The saved sets' apps that aren't running: their names and icons for the shelf.
      const known = [];
      for (const s of this._sets()) for (const it of s.items) {
        if (apps.has(it.key) || known.some((k) => k.key === it.key)) continue;
        known.push({ key: it.key, name: it.name, icon: icons.get(it.key) || '' });
      }
      out = { apps: [...apps.values()].slice(0, 60), known: known.slice(0, 60), displays: ds.map((d) => ({ id: d.id, name: d.name, main: d.main, w: d.w, h: d.h })), front };
    } catch (e) {
      out.why = e.message;
    }
    this.server.sendToClient({ t: T.DECK_WINS, ...out });
  }

  // App icons by the key _wins() groups windows by (Mac: bundle id; Windows: the exe's path).
  async _appIcons() {
    const map = new Map();
    if (this.platform === 'mac') {
      for (const a of await this.sys.apps()) if (a.icon) map.set(a.id, a.icon);
    } else if (this.platform === 'win') {
      const { windows } = await this.sys.wins();
      const saved = this._sets().flatMap((x) => x.items.map((it) => it.key)).filter((k) => /\.exe$/i.test(k));
      const exes = [...new Set([...windows.map((w) => w.exe).filter(Boolean), ...saved])].slice(0, 50);
      const r = await this.helper.request('icons', { size: 64, paths: exes }).catch(() => null);
      if (r && r.icons) exes.forEach((e, i) => { if (r.icons[i]) map.set(e, r.icons[i]); });
    } else if (this.platform === 'linux') {
      for (const a of await this.sys.apps()) if (a.icon) for (const k of linuxKeys(a)) if (!map.has(k)) map.set(k, a.icon);
    }
    return map;
  }

  async _place(m) {
    const done = (ok, why) => this.server.sendToClient({ t: T.DECK_DONE, id: 'place', ok, ...(why ? { why } : {}) });
    try {
      if (!this.caps.windows) throw new Error('Not on this computer');
      const wid = Number(m.wid);
      const { windows, minimized = [] } = await this.sys.wins();
      const min = minimized.find((x) => x.wid === wid);
      // A window's own buttons: closed, minimized, the whole display (Windows: maximized), full screen (Mac).
      if (m.op !== undefined) {
        const op = String(m.op);
        if (!['close', 'min', 'max', 'full'].includes(op)) throw new Error('Not a window action');
        const w0 = windows.find((x) => x.wid === wid) || min;
        if (!w0) throw new Error('That window is gone');
        if (op === 'close' || op === 'min') await this.sys.winOp(wid, op);
        else if (op === 'full' && this.platform === 'mac') await this.sys.winOp(wid, 'full');
        else if (this.platform === 'win') await this.sys.winOp(wid, 'max');
        else {
          const ds = this.sys.displays();
          const at = (!min && displayOf(ds, w0)) || ds.find((d) => d.main) || ds[0];
          if (!at) throw new Error('No display');
          await this.sys.frame(wid, zoneRect(at, { x: 0, y: 0, w: 12, h: 12 }));
        }
        return done(true);
      }
      // A minimized window brought back as it was (or straight into a zone, below).
      if (min && (m.restore || !m.zone)) { await this.sys.winOp(wid, 'restore'); return done(true); }
      const w = windows.find((x) => x.wid === wid) || min;
      if (!w) throw new Error('That window is gone');
      const ds = this.sys.displays();
      const to = ds.find((d) => d.id === String(m.display)) || displayOf(ds, w) || ds[0];
      let r;
      if (m.zone && typeof m.zone === 'object') {
        r = zoneRect(to, zoneOf(m.zone));
      } else { // onto that display, where it was on its own (relative), as big as it fits
        const from = displayOf(ds, w) || to;
        const fx = (w.x - from.x) / from.w, fy = (w.y - from.y) / from.h;
        const ww = Math.min(w.w, to.w), hh = Math.min(w.h, to.h);
        r = { x: to.x + Math.min(fx * to.w, to.w - ww), y: to.y + Math.min(fy * to.h, to.h - hh), w: ww, h: hh };
      }
      await this.sys.frame(wid, r);
      done(true);
    } catch (e) {
      done(false, e.message);
    }
  }

  _sets() { return this.layout.spaces.filter((x) => x.kind === 'windows').flatMap((x) => x.sets || []); }

  // Apps side by side: each item's window (the one asked for, else the app's first one not used
  // yet) into its zone of the display. An app with no window is opened, and placed once one shows.
  async _arrange(m) {
    const done = (ok, why) => this.server.sendToClient({ t: T.DECK_DONE, id: 'arrange', ok, ...(why ? { why } : {}) });
    try {
      if (!this.caps.windows) throw new Error('Not on this computer');
      const items = (Array.isArray(m.items) ? m.items : []).slice(0, 6).filter((it) => it && typeof it === 'object' && it.zone)
        .map((it) => ({ key: String(it.key || '').slice(0, 300), wid: Number(it.wid) || 0, zone: zoneOf(it.zone) }));
      if (!items.length) throw new Error('No apps to arrange');
      const ds = this.sys.displays();
      const to = ds.find((d) => d.id === String(m.display || '')) || ds.find((d) => d.main) || ds[0];
      if (!to) throw new Error('No display');
      const used = new Set();
      const pick = (windows, it) => (it.wid && !used.has(it.wid) && windows.find((w) => w.wid === it.wid))
        || windows.find((w) => !used.has(w.wid) && it.key && appKey(w) === it.key) || null;
      // Minimized windows count too (placing one brings it back), after the ones showing.
      const all = (r) => [...r.windows, ...(r.minimized || [])];
      let windows = all(await this.sys.wins());
      const missing = [];
      for (const it of items) {
        const w = pick(windows, it);
        if (w) { used.add(w.wid); it.w = w; } else missing.push(it);
      }
      // Not running: opened (only apps this computer lists), then waited for.
      const failed = [];
      for (const it of missing) {
        try { await this._launch(it.key); } catch (e) { failed.push(e.message); it.skip = true; }
      }
      const waitFor = missing.filter((it) => !it.skip);
      for (let i = 0; waitFor.some((it) => !it.w) && i < 30; i++) {
        await new Promise((r) => setTimeout(r, this.arrangeWait || 400));
        windows = all(await this.sys.wins());
        for (const it of waitFor) if (!it.w) { const w = pick(windows, it); if (w) { used.add(w.wid); it.w = w; } }
      }
      // Last first: the first item ends up in front.
      for (const it of items.slice().reverse()) if (it.w) await this.sys.frame(it.w.wid, zoneRect(to, it.zone)).catch((e) => failed.push(e.message));
      if (items.every((it) => !it.w)) throw new Error(failed[0] || 'The apps didn’t open a window');
      done(true, failed.length ? failed[0] : (waitFor.some((it) => !it.w) ? 'Some apps didn’t open a window in time' : ''));
    } catch (e) {
      done(false, e.message);
    }
  }

  // An app by the key deck.wins groups it by: only one this computer lists as an app (Mac: its
  // bundle id; Windows: a Start menu app, its id or the program it starts), opened as the Start
  // menu or the Dock opens it.
  async _launch(key) {
    const apps = await this.sys.apps().catch(() => []);
    if (this.platform === 'mac') {
      if (!apps.some((a) => a.id === key)) throw new Error('That app isn’t on this Mac');
      return this.sys.openApp(key);
    }
    if (this.platform === 'win') {
      const k = key.toLowerCase();
      // A Start menu id is a known folder's GUID and the path under it: matched by the path's end.
      const a = apps.find((x) => x.id.toLowerCase() === k)
        || apps.find((x) => { const tail = x.id.toLowerCase().replace(/^\{[0-9a-f-]+\}/, ''); return /\.exe$/.test(tail) && tail.length > 4 && k.endsWith(tail); });
      if (!a) throw new Error('Open it on the PC once from the Start menu');
      return this.sys.openApp(a.id);
    }
    if (this.platform === 'linux') {
      const a = apps.find((x) => linuxKeys(x).includes(String(key).toLowerCase()));
      if (!a) throw new Error('That app isn’t on this computer');
      return this.sys.openApp(a.id);
    }
    throw new Error('Not on this computer');
  }

  _press(codes) {
    const ev = (t, code) => this.helper.send('inject', { ev: { t, code } });
    for (const c of codes) ev(T.K_KEY_DOWN, c);
    for (const c of codes.slice().reverse()) ev(T.K_KEY_UP, c);
  }

  shutdown() { this.surface = null; for (const s of this.slide.values()) clearTimeout(s.timer); Deck.all.delete(this); }
}

Deck.all = new Set();

// The window steps as zones on the 12 × 12 grid.
const SNAP = {
  left: [0, 0, 6, 12], right: [6, 0, 6, 12], top: [0, 0, 12, 6], bottom: [0, 6, 12, 6], max: [0, 0, 12, 12],
  tl: [0, 0, 6, 6], tr: [6, 0, 6, 6], bl: [0, 6, 6, 6], br: [6, 6, 6, 6],
  third1: [0, 0, 4, 12], third2: [4, 0, 4, 12], third3: [8, 0, 4, 12],
};
const appKey = (w) => w.bundle || w.aumid || w.exe || w.cls || w.app || String(w.pid); // Linux: the window's class
// A Linux app's window classes (lower case): its StartupWMClass, else its desktop file's name.
const linuxKeys = (a) => {
  const id = String(a.id || '').replace(/\.desktop$/, '').toLowerCase();
  return [String((a.entry && a.entry.wmClass) || '').toLowerCase(), id, id.split('.').pop()].filter(Boolean);
};
const appName = (w) => w.app || (w.exe ? w.exe.split(/[\\/]/).pop().replace(/\.exe$/i, '') : '') || w.title;
const zoneOf = (z) => M.normalize({ spaces: [{ kind: 'windows', layouts: [{ zones: [z] }] }] }).spaces[0].layouts[0].zones[0];
const zoneRect = (d, z) => ({ x: d.x + (d.w * z.x) / ZG, y: d.y + (d.h * z.y) / ZG, w: (d.w * z.w) / ZG, h: (d.h * z.h) / ZG });
// The display a window is mostly on.
function displayOf(ds, w) {
  let best = null, area = -1;
  for (const d of ds) {
    const a = Math.max(0, Math.min(w.x + w.w, d.x + d.w) - Math.max(w.x, d.x)) * Math.max(0, Math.min(w.y + w.h, d.y + d.h) - Math.max(w.y, d.y));
    if (a > area) { area = a; best = d; }
  }
  return best;
}

// The three apps' one call, only while the Deck module is on (main.js): the phones' Deck now, and
// web(bus) for TwinDesk Web's (webwire o.deck). settings.deck holds the layout.
//   o: {platform, helper (or () → helper), server (the phones' session; null in Multi-device, where
//       add(link) makes one per phone), settings() → settings,
//       saveSettings(), readClipboard() → text, onChange(), sys (tests: a stand-in for deck-sys)}
function startDeck(o) {
  const h = typeof o.helper === 'function' ? o.helper : () => o.helper; // Windows and Linux start theirs later
  const helper = {
    send: (...a) => { if (!h()) throw new Error('TwinDesk’s helper isn’t running'); return h().send(...a); },
    request: (...a) => (h() ? h().request(...a) : Promise.reject(new Error('TwinDesk’s helper isn’t running'))),
  };
  let deckOne = null;
  const press = (codes) => (deckOne || [...Deck.all][0])._press(codes);
  const base = {
    helper, platform: o.platform,
    load: () => o.settings().deck,
    save: (l) => { o.settings().deck = l; o.saveSettings(); },
    sys: o.sys || require('./deck-sys.js').sys(o.platform, { helper, press }),
    readClipboard: o.readClipboard, onChange: o.onChange,
  };
  const any = () => deckOne || [...Deck.all][0] || (deckOne = new Deck({ ...base, server: new (require('events').EventEmitter)() }));
  let phone = null;
  const api = {
    // The phones' session: now or once it's there (Windows and Linux make it after TwinDesk Web).
    attach(server) { if (!phone && server) { phone = new Deck({ ...base, server }); deckOne = deckOne || phone; } return api; },
    // Multi-device (mac|windows|linux/mesh): one more phone's session, a Deck of its own (each phone's buttons run here).
    add(server) { const d = new Deck({ ...base, server }); deckOne = deckOne || d; return d; },
    web: (bus) => new Deck({ ...base, server: bus, web: true }),
    view: () => Deck.view(),
    // This computer's Deck page: save the layout, try a tile here, its pickers' lists.
    save: (l) => any().setLayout(l),
    exec: (a) => any().exec(a),
    apps: () => base.sys.apps(),
    state: () => any().state(),
  };
  return api.attach(o.server);
}

module.exports = { Deck, startDeck, SNAP, zoneRect, displayOf };

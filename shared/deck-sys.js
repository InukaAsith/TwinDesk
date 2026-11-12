// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck's way into this computer (shared/deck.js), per platform, loaded with the Deck only.
//
// One rule above all: nothing here looks like malware to an antivirus. So no command lines are
// ever built or run, and on Windows no other program is started at all:
//   Windows: every system step is TwinDesk's own signed helper (windows-helper/src/DeckSys.cs:
//     Core Audio, Bluetooth, the display driver and DDC/CI, the window manager); websites, files
//     and scripts open through Electron's shell (Windows' ShellExecute, as a double-click does).
//   Mac: the Swift helper (mac-helper/Sources/macshare-helper/Deck.swift); files and scripts through
//     Electron's shell.
//   Linux: the desktop's own tools, run directly with their arguments (pactl, bluetoothctl,
//     brightnessctl, loginctl, systemctl, gsettings), never through a shell.
// A script is a file the person saved: it's opened as Finder or Explorer opens it.
//
// sys(platform, {helper, press(codes)}) → the calls below, each a Promise; what a platform can't do
// is left out of caps().
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process'); // execFile only (Linux): no shell, no spawn

const el = () => require('electron');
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
const which = (name) => (process.env.PATH || '').split(path.delimiter).some((d) => { try { return fs.statSync(path.join(d, name)).isFile(); } catch (_) { return false; } });
// Linux only: a tool with its arguments, no shell.
const run = (cmd, args, timeout = 8000) => new Promise((resolve, reject) => {
  cp.execFile(cmd, args, { timeout, shell: false }, (err, out) => (err ? reject(err) : resolve(String(out || ''))));
});
const CACHE_MS = 60000;

// Keys each platform presses for a step it has no API for (KeyboardEvent.code names).
const KEYS = {
  mac: {
    switcher: ['MetaLeft', 'Tab'], screenshot: ['MetaLeft', 'ShiftLeft', 'Digit3'], shotarea: ['MetaLeft', 'ShiftLeft', 'Digit4'],
  },
  win: {
    desktop: ['MetaLeft', 'KeyD'], switcher: ['AltLeft', 'Tab'], overview: ['MetaLeft', 'Tab'],
    screenshot: ['MetaLeft', 'PrintScreen'], shotarea: ['MetaLeft', 'ShiftLeft', 'KeyS'],
  },
  linux: {
    desktop: ['MetaLeft', 'KeyD'], switcher: ['AltLeft', 'Tab'], overview: ['MetaLeft'],
    screenshot: ['ShiftLeft', 'PrintScreen'], shotarea: ['PrintScreen'],
    left: ['MetaLeft', 'ArrowLeft'], right: ['MetaLeft', 'ArrowRight'], max: ['MetaLeft', 'ArrowUp'], min: ['MetaLeft', 'KeyH'],
    nextdisplay: ['MetaLeft', 'ShiftLeft', 'ArrowRight'], close: ['AltLeft', 'F4'],
  },
};

function sys(platform, { helper, press }) {
  // A device or app goes as `dev`: the helpers' `id` is the request's own number (helper.request sets it).
  const H = (cmd, args = {}, timeout = 15000) => helper.request(cmd, args, timeout);
  const linux = platform === 'linux';
  let appCache = null;
  let appAt = 0;

  const api = {
    platform,
    // What this computer can do, for the editor and the device (sub-steps are checked when run).
    caps() {
      const c = { audio: true, outputs: true, mic: true, bt: true, bright: true, win: true, windows: !linux, darkmode: true, dnd: platform !== 'mac', screenoff: !linux };
      if (linux) {
        c.audio = c.outputs = c.mic = which('pactl');
        c.bt = which('bluetoothctl');
        c.bright = which('brightnessctl');
        c.darkmode = c.dnd = which('gsettings');
      }
      return c;
    },

    // ---- Sound ----
    async audio() {
      if (!linux) return H('deckAudio');
      const blocks = async (kind) => (await run('pactl', ['list', kind])).split(/\n(?=\S)/).map((b) => ({
        id: (/^\s*Name:\s*(.+)$/m.exec(b) || [])[1], name: (/^\s*Description:\s*(.+)$/m.exec(b) || [])[1],
        vol: Number((/^\s*Volume:.*?(\d+)%/m.exec(b) || [])[1]), mute: /^\s*Mute:\s*yes/m.test(b),
      })).filter((x) => x.id && !/\.monitor$/.test(x.id));
      const [sinks, sources, ds, dsrc] = await Promise.all([blocks('sinks'), blocks('sources'), run('pactl', ['get-default-sink']), run('pactl', ['get-default-source'])]);
      const o = sinks.find((x) => x.id === ds.trim()), i = sources.find((x) => x.id === dsrc.trim());
      return {
        outputs: sinks.map((x) => ({ id: x.id, name: x.name || x.id, on: x === o })),
        inputs: sources.map((x) => ({ id: x.id, name: x.name || x.id, on: x === i })),
        ...(o ? { volume: o.vol / 100, muted: o.mute } : {}),
        ...(i ? { micVolume: i.vol / 100, micMuted: i.mute } : {}),
      };
    },
    async setDefault(id, input) {
      if (!linux) return H('deckAudioDefault', { dev: id, input: !!input });
      return run('pactl', [input ? 'set-default-source' : 'set-default-sink', id]);
    },
    // {input, level?, mute?}
    async volume(o) {
      if (!linux) return H('deckVolume', { input: !!o.input, ...(o.level !== undefined ? { level: clamp01(o.level) } : {}), ...(o.mute !== undefined ? { mute: !!o.mute } : {}) });
      const dev = o.input ? '@DEFAULT_SOURCE@' : '@DEFAULT_SINK@';
      if (o.level !== undefined) await run('pactl', [o.input ? 'set-source-volume' : 'set-sink-volume', dev, `${Math.round(clamp01(o.level) * 100)}%`]);
      if (o.mute !== undefined) await run('pactl', [o.input ? 'set-source-mute' : 'set-sink-mute', dev, o.mute ? '1' : '0']);
    },

    // ---- Bluetooth ----
    async bt() {
      if (!linux) return H('deckBt', {}, 20000);
      const show = await run('bluetoothctl', ['show']).catch(() => '');
      let list = await run('bluetoothctl', ['devices', 'Paired']).catch(() => '');
      if (!/Device /.test(list)) list = await run('bluetoothctl', ['paired-devices']).catch(() => '');
      const devices = await Promise.all(list.split('\n').map((l) => /^Device\s+([0-9A-F:]{17})\s+(.*)$/i.exec(l.trim())).filter(Boolean).map(async (m) => {
        const info = await run('bluetoothctl', ['info', m[1]]).catch(() => '');
        return { id: m[1], name: m[2], connected: /Connected:\s*yes/.test(info), audio: /Icon:\s*audio/.test(info) };
      }));
      return { radio: /Powered:\s*yes/.test(show), devices };
    },
    async btRadio(on) { return linux ? run('bluetoothctl', ['power', on ? 'on' : 'off']) : H('deckBtRadio', { on: !!on }); },
    async btConnect(id, on) {
      if (!linux) return H('deckBtConnect', { dev: id, on: !!on }, 30000);
      if (!/^[0-9A-F:]{17}$/i.test(id)) throw new Error('That Bluetooth device isn’t paired with this computer');
      return run('bluetoothctl', [on ? 'connect' : 'disconnect', id], 30000);
    },

    // ---- Brightness: {displays: [{id, name, level, internal}]} ----
    async bright() {
      if (!linux) return H('deckBright', {}, 20000);
      const out = await run('brightnessctl', ['-m', '-c', 'backlight']).catch(() => '');
      return { displays: out.split('\n').map((l) => l.split(',')).filter((p) => p.length >= 5).map((p) => ({ id: p[0], name: 'Built-in display', level: parseInt(p[3], 10) / 100, internal: true })) };
    },
    async setBright(id, level) {
      if (!linux) return H('deckBrightSet', { dev: id || '', level: clamp01(level) }, 20000);
      if (!which('brightnessctl')) throw new Error('Install brightnessctl to change the brightness from the Deck');
      return run('brightnessctl', [...(id ? ['-d', id] : []), 'set', `${Math.round(clamp01(level) * 100)}%`]);
    },

    // ---- Windows (Mac and Windows) ----
    // {windows: [{wid, pid, app, title, x, y, w, h}], front} in screen coordinates (Windows: pixels).
    async wins() {
      if (platform === 'mac') return H('deckWins');
      if (platform === 'win') {
        const [l, f] = await Promise.all([H('windows', {}, 15000), H('deckWinFront')]);
        return { windows: (l.windows || []).filter((w) => !w.popup), front: f.wid || 0 };
      }
      throw new Error('Not on Linux');
    },
    frame(wid, r) { return H(platform === 'mac' ? 'deckWinFrame' : 'deckWinFrame', { wid: wid || 0, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }); },
    winOp(wid, op) { return H('deckWinOp', { wid: wid || 0, op }); },
    // The displays' usable areas, in the coordinates wins() and frame() use.
    displays() {
      const { screen } = el();
      return screen.getAllDisplays().map((d, i) => {
        const a = platform === 'win' && screen.dipToScreenRect ? screen.dipToScreenRect(null, d.workArea) : d.workArea;
        return { id: String(d.id), name: d.label || `Display ${i + 1}`, main: d.id === screen.getPrimaryDisplay().id, x: a.x, y: a.y, w: a.width, h: a.height };
      });
    },

    // ---- System: lock, sleep, screens off, desktop, switcher, overview, screenshots, dark mode, Do not disturb ----
    async sys(what, o = {}) {
      const keys = (KEYS[platform] || {})[what];
      if (keys && !(platform === 'mac' && (what === 'desktop' || what === 'overview'))) return void press(keys);
      if (!linux) return H('deckSys', { what, ...(o.on !== undefined ? { on: !!o.on } : {}) });
      switch (what) {
        case 'lock': return run('loginctl', ['lock-session']);
        case 'sleep': return run('systemctl', ['suspend']);
        case 'darkmode': {
          const cur = await run('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme']).catch(() => '');
          const on = !/dark/.test(cur);
          await run('gsettings', ['set', 'org.gnome.desktop.interface', 'color-scheme', on ? 'prefer-dark' : 'default']);
          return { on };
        }
        case 'dnd': {
          const cur = await run('gsettings', ['get', 'org.gnome.desktop.notifications', 'show-banners']);
          const on = o.on !== undefined ? !!o.on : /true/.test(cur);
          await run('gsettings', ['set', 'org.gnome.desktop.notifications', 'show-banners', on ? 'false' : 'true']);
          return { on };
        }
        default: throw new Error('Not on this computer');
      }
    },
    // Linux's window steps are the desktop's own keys.
    winKeys: (what) => (linux ? (KEYS.linux[what] || null) : null),
    async state() {
      if (!linux) return H('deckState').catch(() => ({}));
      const dark = await run('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme']).catch(() => '');
      return { dark: /dark/.test(dark) };
    },

    // ---- Apps ----
    async apps() {
      if (appCache && Date.now() - appAt < CACHE_MS) return appCache;
      let list;
      if (platform === 'mac') list = ((await H('appsList', {}, 20000)).apps || []).map((a) => ({ id: a.id, name: a.name, icon: a.icon || '' }));
      else if (platform === 'win') {
        list = ((await H('deckApps', {}, 30000)).apps || []).map((a) => ({ id: a.id, name: a.name, icon: '' }));
        for (let i = 0; i < list.length; i += 15) {
          const batch = list.slice(i, i + 15);
          const r = await H('icons', { size: 64, paths: batch.map((a) => 'shell:AppsFolder\\' + a.id) }).catch(() => null);
          if (r && r.icons) batch.forEach((a, k) => { a.icon = r.icons[k] || ''; });
        }
      } else {
        const d = require('../linux/desktopapps.js');
        list = await Promise.all(d.list().map(async (e) => ({ id: e.id, name: e.name, icon: await d.icon(e, 64).catch(() => ''), entry: e })));
      }
      appCache = list;
      appAt = Date.now();
      return list;
    },
    async openApp(id) {
      if (platform === 'mac') {
        if (!/^[A-Za-z0-9.-]{1,200}$/.test(id)) throw new Error('No such app on this Mac');
        return H('appLaunch', { appId: id }, 20000);
      }
      if (platform === 'win') return H('deckAppOpen', { dev: id }, 20000);
      const a = (await api.apps()).find((x) => x.id === id);
      if (!a) throw new Error('No such app on this computer');
      require('../linux/desktopapps.js').launch(a.entry);
    },

    // ---- Files, scripts, websites: opened as a double-click opens them ----
    async open(p) {
      if (!p || !path.isAbsolute(p) || !fs.existsSync(p)) throw new Error('That file or folder isn’t on this computer any more');
      const err = await el().shell.openPath(p);
      if (err) throw new Error(err);
    },
    // A script file the person saved: run by the system's own handler for it (Windows: .bat, .cmd,
    // .exe, .lnk as Explorer runs them; Mac: .command, .app, .workflow, .shortcut in Terminal or
    // their app; Linux: a .desktop file or an executable as the file manager runs it). TwinDesk
    // never passes it to a shell or an interpreter itself.
    async script(p) {
      if (!p || !path.isAbsolute(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error('That script isn’t on this computer any more');
      const err = await el().shell.openPath(p);
      if (err) throw new Error(err);
    },
    async url(u) { return el().shell.openExternal(u); },
  };
  return api;
}

module.exports = { sys, KEYS };

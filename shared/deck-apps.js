// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck's way into this computer (shared/deck.js), per platform, loaded with the Deck only:
//   apps(platform, {helper}) → {list() → [{id, name, icon}], open(id)}
//     Mac: the helper's appsList / appLaunch (the apps Apps already offers).
//     Windows: the Start menu's apps (scripts/pcapps-list.ps1), icons from the helper, opened through
//       shell:AppsFolder.
//     Linux: the .desktop files (linux/desktopapps.js).
//   bright(platform, {helper}) → {can(), step(up)}: the display's brightness, a step up or down.
//     Mac: the brightness keys (the helper posts them as system keys; macOS shows its own HUD).
//     Windows: WMI (a laptop's own panel; an external monitor has no WMI brightness).
//     Linux: brightnessctl when it's installed, else a backlight this user may write.
// Nothing is asked for until a button is pressed: a permission a step needs is asked then.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const P = require('./protocol.js');

const run = (cmd, args, timeout = 8000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(String(out || ''))));
});
const which = (name) => (process.env.PATH || '').split(path.delimiter).some((d) => { try { return fs.statSync(path.join(d, name)).isFile(); } catch (_) { return false; } });
const CACHE_MS = 60000;

function apps(platform, { helper }) {
  let cache = null;
  let at = 0;
  const cached = async (make) => {
    if (cache && Date.now() - at < CACHE_MS) return cache;
    cache = await make();
    at = Date.now();
    return cache;
  };
  if (platform === 'mac') {
    return {
      list: () => cached(async () => ((await helper.request('appsList', {}, 20000)).apps || []).map((a) => ({ id: a.id, name: a.name, icon: a.icon || '' }))),
      open: async (id) => {
        if (!/^[A-Za-z0-9.-]{1,200}$/.test(id)) throw new Error('No such app on this Mac');
        await helper.request('appLaunch', { appId: id }, 20000);
      },
    };
  }
  if (platform === 'win') {
    const list = () => cached(async () => {
      const { script } = require('../windows/ps');
      const raw = JSON.parse((await script('pcapps-list', {}, 60000)).trim() || '[]');
      const out = (Array.isArray(raw) ? raw : [raw]).filter((a) => a && typeof a.Name === 'string' && typeof a.AppID === 'string')
        .map((a) => ({ id: a.AppID, name: a.Name, icon: '' })).sort((a, b) => a.name.localeCompare(b.name));
      for (let i = 0; i < out.length; i += 15) {
        const batch = out.slice(i, i + 15);
        const r = await helper.request('icons', { size: 64, paths: batch.map((a) => 'shell:AppsFolder\\' + a.id) }).catch(() => null);
        if (r && r.icons) batch.forEach((a, k) => { a.icon = r.icons[k] || ''; });
      }
      return out;
    });
    return {
      list,
      open: async (id) => {
        if (!(await list()).some((a) => a.id === id)) throw new Error('No such app on this PC');
        const p = spawn('explorer.exe', ['shell:AppsFolder\\' + id], { detached: true, stdio: 'ignore', windowsHide: true });
        p.on('error', () => {});
        p.unref();
      },
    };
  }
  const desktop = () => require('../linux/desktopapps.js');
  const entries = () => cached(async () => desktop().list());
  return {
    list: async () => Promise.all((await entries()).map(async (e) => ({ id: e.id, name: e.name, icon: await desktop().icon(e, 64).catch(() => '') }))),
    open: async (id) => {
      const e = (await entries()).find((x) => x.id === id);
      if (!e) throw new Error('No such app on this computer');
      desktop().launch(e);
    },
  };
}

// Windows: the panel's brightness through WMI, ±10 %.
const WIN_BRIGHT = (up) => `$b = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1
$n = [Math]::Max(0, [Math]::Min(100, $b.CurrentBrightness ${up ? '+' : '-'} 10))
Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{Timeout = 0; Brightness = [byte]$n} | Out-Null`;

function bright(platform, { helper }) {
  if (platform === 'mac') {
    return {
      can: () => true,
      step: (up) => {
        const code = up ? 'BrightnessUp' : 'BrightnessDown';
        helper.send('inject', { ev: { t: P.T.K_KEY_DOWN, code } });
        helper.send('inject', { ev: { t: P.T.K_KEY_UP, code } });
      },
    };
  }
  if (platform === 'win') {
    let ok = null; // learned on the first press: a desktop with only external monitors has none
    return {
      can: () => ok !== false,
      step: async (up) => {
        try {
          await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_BRIGHT(up)]);
          ok = true;
        } catch (_) {
          ok = false;
          throw new Error('This PC’s display has no brightness Windows can change (an external monitor)');
        }
      },
    };
  }
  // Linux: brightnessctl, else /sys/class/backlight when this user may write it.
  const sysLight = () => {
    try {
      const dir = '/sys/class/backlight';
      for (const n of fs.readdirSync(dir)) {
        const d = path.join(dir, n);
        try { fs.accessSync(path.join(d, 'brightness'), fs.constants.W_OK); return d; } catch (_) { /* next */ }
      }
    } catch (_) { /* none */ }
    return '';
  };
  return {
    can: () => which('brightnessctl') || !!sysLight(),
    step: async (up) => {
      if (which('brightnessctl')) return void await run('brightnessctl', ['set', up ? '10%+' : '10%-']);
      const d = sysLight();
      if (!d) throw new Error('Install brightnessctl to change the brightness from the Deck');
      const max = Number(fs.readFileSync(path.join(d, 'max_brightness'), 'utf8')) || 100;
      const cur = Number(fs.readFileSync(path.join(d, 'brightness'), 'utf8')) || 0;
      fs.writeFileSync(path.join(d, 'brightness'), String(Math.max(1, Math.min(max, Math.round(cur + (up ? 1 : -1) * max * 0.1)))));
    },
  };
}

module.exports = { apps, bright };

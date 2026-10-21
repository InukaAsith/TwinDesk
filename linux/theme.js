// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Dark unless the desktop explicitly asks for light: the portal's org.freedesktop.appearance
// color-scheme (0 no preference, 1 dark, 2 light), read through gdbus and followed with
// `gdbus monitor`. "No preference" and a light GTK theme alone stay dark. No portal or no
// gdbus: dark.
'use strict';

const { nativeTheme } = require('electron');
const { execFile, spawn } = require('child_process');
const readline = require('readline');

const PORTAL = ['--session', '--dest', 'org.freedesktop.portal.Desktop', '--object-path', '/org/freedesktop/portal/desktop'];

let watcher = null;

const apply = (scheme) => {
  const want = scheme === 2 ? 'light' : 'dark';
  if (nativeTheme.themeSource !== want) nativeTheme.themeSource = want;
};

function start() {
  apply(0);
  execFile('gdbus', ['call', ...PORTAL, '--method', 'org.freedesktop.portal.Settings.Read', 'org.freedesktop.appearance', 'color-scheme'],
    { timeout: 3000 }, (err, out) => {
      const m = !err && /uint32 (\d)/.exec(String(out));
      if (m) apply(Number(m[1]));
    });
  const p = spawn('gdbus', ['monitor', ...PORTAL], { stdio: ['ignore', 'pipe', 'ignore'] });
  watcher = p;
  p.on('error', () => { if (watcher === p) watcher = null; });
  readline.createInterface({ input: p.stdout }).on('line', (l) => {
    const m = /SettingChanged \('org\.freedesktop\.appearance', 'color-scheme', <uint32 (\d)>\)/.exec(l);
    if (m) apply(Number(m[1]));
  });
}

function stop() {
  const w = watcher;
  watcher = null;
  if (w) try { w.kill(); } catch {}
}

module.exports = { start, stop };

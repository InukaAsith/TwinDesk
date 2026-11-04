// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Where the video playing in a browser here is, for ReZume's video handoff (shared/rezume.js): the
// other device opens the same video at the same second. From the system's media controls:
// Windows' media sessions (GlobalSystemMediaTransportControls, through PowerShell), Linux's MPRIS
// (playerctl). The Mac has no system-wide position an app may read: the browser in front is asked
// through Apple Events instead (Safari, Chrome, Edge, Brave, Vivaldi, Opera, Arc), which works only
// where the browser allows JavaScript from Apple Events (its Develop / View › Developer menu); null
// otherwise.
//   position(app?) → Promise<seconds | null> (app: the browser's bundle id, on a Mac)
//   atTime(url, sec): the link that opens there (YouTube t=, Vimeo #t=, Twitch t=, Dailymotion
//   start=, a video file's #t= media fragment)
'use strict';

const { execFile } = require('child_process');

const run = (cmd, args, timeout = 6000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true }, (err, out) => resolve(err ? '' : String(out || '').trim()));
});

const WIN = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$await = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $t) { $task = $await.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
$m = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$s = $m.GetSessions() | ? { $_.SourceAppUserModelId -match 'chrome|msedge|firefox|brave|opera|vivaldi|arc' } | Select-Object -First 1
if ($s) { $t = $s.GetTimelineProperties(); $p = $s.GetPlaybackInfo(); $pos = $t.Position.TotalSeconds; if ($p.PlaybackStatus -eq 'Playing') { $pos += ((Get-Date).ToUniversalTime() - $t.LastUpdatedTime.UtcDateTime).TotalSeconds }; [math]::Floor($pos) }`;

// The playing (else the first) video element's time, in the front tab of a Mac browser.
const MAC_JS = "(function(){var v=[].slice.call(document.querySelectorAll('video'));var p=v.filter(function(x){return !x.paused})[0]||v[0];return p?Math.floor(p.currentTime):''})()";
const MAC = `
function run(argv) {
  const id = argv[0];
  try {
    const b = Application(id);
    if (/^com\\.apple\\.Safari/.test(id)) return String(b.doJavaScript(${JSON.stringify(MAC_JS)}, { in: b.windows[0].currentTab }));
    return String(b.windows[0].activeTab.execute({ javascript: ${JSON.stringify(MAC_JS)} }));
  } catch (e) { return ''; }
}`;

async function position(app) {
  let out = '';
  if (process.platform === 'win32') out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN], 8000);
  else if (process.platform === 'linux') out = await run('playerctl', ['--player=chromium,chrome,firefox,brave,%any', 'position']);
  else if (process.platform === 'darwin' && /^[A-Za-z0-9.-]{1,200}$/.test(String(app || '')) && !/firefox|librewolf|zen/i.test(app)) {
    out = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC, app], 5000);
  }
  const n = Math.floor(Number(String(out).split(/\r?\n/).pop()));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const FILE = /\.(mp4|m4v|webm|mov|ogv|mkv)$/i;

// A video's link with its time; anything else as it is.
function atTime(url, sec) {
  if (!sec || sec < 3) return url;
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^(www|m)\./, '');
    if ((h === 'youtube.com' && (u.pathname === '/watch' || u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/live/'))) || h === 'youtu.be') {
      u.searchParams.set('t', `${sec}s`);
    } else if (h === 'vimeo.com' && /^\/\d+/.test(u.pathname)) {
      u.hash = `t=${sec}s`;
    } else if (h === 'twitch.tv' && u.pathname.startsWith('/videos/')) {
      u.searchParams.set('t', `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m${sec % 60}s`);
    } else if (h === 'dailymotion.com' && u.pathname.startsWith('/video/')) {
      u.searchParams.set('start', String(sec));
    } else if (FILE.test(u.pathname)) {
      u.hash = `t=${sec}`;
    } else return url;
    return u.href;
  } catch (_) { return url; }
}

const isVideo = (url) => /^https?:\/\/((www|m)\.)?(youtube\.com\/(watch|shorts\/|live\/)|youtu\.be\/|vimeo\.com\/\d|twitch\.tv\/videos\/|dailymotion\.com\/video\/)/i.test(String(url || ''))
  || (() => { try { return FILE.test(new URL(url).pathname); } catch (_) { return false; } })();

module.exports = { position, atTime, isVideo };

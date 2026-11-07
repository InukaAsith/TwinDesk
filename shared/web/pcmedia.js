// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What plays on this computer, for TwinDesk Web's Now playing (shared/web/webhub.js opts.media) and
// its lock-screen controls: read every few seconds while a web device is open (active(true)), and
// Play, Pause, Next and Previous sent as the media keys (any player takes them).
//   macOS: Music and Spotify through AppleScript (only when they're running; nothing is launched).
//   Linux: MPRIS through playerctl, when it's installed.
//   Windows: the system media session (GlobalSystemMediaTransportControlsSessionManager) through
//   PowerShell, the player Windows shows in its own volume flyout.
// new PcMedia({key(code)}) — key presses one media key (MediaPlayPause, MediaTrackNext, …).
// state() → {title, artist, album, playing, app} or {}; do(cmd); active(on). Events: 'change'.
'use strict';

const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const POLL_MS = 3000;
const str = (v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');

const MAC_SCRIPT = `
function run() {
  const se = Application('System Events');
  const out = [];
  for (const [name, id] of [['Music', 'com.apple.Music'], ['Spotify', 'com.spotify.client']]) {
    if (!se.processes.whose({ bundleIdentifier: id }).length) continue;
    try {
      const a = Application(id);
      const st = String(a.playerState());
      if (st === 'stopped') continue;
      const t = a.currentTrack;
      out.push({ app: name, title: String(t.name() || ''), artist: String(t.artist() || ''), album: String(t.album() || ''), playing: st === 'playing' });
    } catch (e) {}
  }
  out.sort((x, y) => Number(y.playing) - Number(x.playing));
  return JSON.stringify(out[0] || {});
}`;

const WIN_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $as = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  function Await($op, $type) { $t = $as.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
  $m = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $s = $m.GetCurrentSession()
  if (-not $s) { '{}'; exit }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $st = $s.GetPlaybackInfo().PlaybackStatus.ToString()
  @{ app = $s.SourceAppUserModelId; title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle; playing = ($st -eq 'Playing') } | ConvertTo-Json -Compress
} catch { '{}' }`;

function readMac() {
  return new Promise((resolve) => execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT], { timeout: 4000 }, (err, out) => resolve(err ? '{}' : out)));
}

function readLinux() {
  const fmt = '{{status}}\t{{playerName}}\t{{xesam:title}}\t{{xesam:artist}}\t{{xesam:album}}';
  return new Promise((resolve) => execFile('playerctl', ['metadata', '--format', fmt], { timeout: 3000 }, (err, out) => {
    if (err) return resolve('{}');
    const [status, app, title, artist, album] = String(out).trim().split('\t');
    if (!title || status === 'Stopped') return resolve('{}');
    resolve(JSON.stringify({ app, title, artist, album, playing: status === 'Playing' }));
  }));
}

function readWin() {
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_SCRIPT],
    { timeout: 8000, windowsHide: true }, (err, out) => resolve(err ? '{}' : out)));
}

const READ = { darwin: readMac, linux: readLinux, win32: readWin };
const KEYS = { toggle: 'MediaPlayPause', play: 'MediaPlayPause', pause: 'MediaPlayPause', next: 'MediaTrackNext', previous: 'MediaTrackPrevious' };

class PcMedia extends EventEmitter {
  constructor({ key, platform = process.platform } = {}) {
    super();
    this.key = key;
    this.read = READ[platform] || null;
    this.platform = platform;
    this.now = {};
    this.last = '{}';
    this.timer = null;
    this.busy = false;
  }

  active(on) {
    if (!this.read || !!on === !!this.timer) return;
    if (!on) {
      clearInterval(this.timer);
      this.timer = null;
      return;
    }
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref?.();
    this.poll();
  }

  async poll() {
    if (this.busy || !this.read) return;
    this.busy = true;
    let m = {};
    try { m = JSON.parse(String(await this.read()).trim() || '{}') || {}; } catch (_) { m = {}; }
    this.busy = false;
    const next = m.title ? { title: str(m.title), artist: str(m.artist), album: str(m.album), app: str(m.app, 100), playing: m.playing !== false } : {};
    const k = JSON.stringify(next);
    if (k === this.last) return;
    this.last = k;
    this.now = next;
    this.emit('change');
  }

  state() {
    return this.now;
  }

  do(cmd) {
    // Play while playing (or Pause while paused) would toggle it the wrong way: nothing to do.
    if (cmd === 'play' && this.now.playing === true) return;
    if (cmd === 'pause' && this.now.playing === false) return;
    if (this.platform === 'linux') {
      const pc = { toggle: 'play-pause', play: 'play', pause: 'pause', next: 'next', previous: 'previous' }[cmd];
      execFile('playerctl', [pc], { timeout: 3000 }, (err) => { if (err && KEYS[cmd]) this.key(KEYS[cmd]); });
    } else if (KEYS[cmd]) {
      this.key(KEYS[cmd]);
    }
    setTimeout(() => this.poll(), 600);
  }
}

module.exports = { PcMedia };

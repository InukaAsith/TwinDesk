// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What plays on this computer, for TwinDesk Web's Now playing (shared/web/webhub.js opts.media) and
// its lock-screen controls: read every few seconds while a web device is open (active(true)), and
// Play, Pause, Next and Previous sent as the media keys (any player takes them).
//   macOS: any app macOS shows in its own Now Playing (a browser's YouTube too), with the artwork:
//   mac-helper's libtwindesk-nowplaying.dylib loaded into /usr/bin/perl (MediaRemote answers only
//   Apple's own processes), which streams each change and takes the controls. Without it: Music
//   and Spotify through AppleScript (only when they're running; nothing is launched).
//   Linux: MPRIS over D-Bus (shared/mpris.js, gdbus; playerctl only where there's no gdbus).
//   Windows: the system media session (the player Windows shows in its own volume flyout), read by
//   TwinDesk's own helper (windows-helper/src/DeckMix.cs, deckMedia): no PowerShell or other
//   program. Windows' main hands it over once (PcMedia.useHelper); without it nothing is read.
// new PcMedia({key(code)}) — key presses one media key (MediaPlayPause, MediaTrackNext, …).
// state() → {title, artist, album, playing, app} or {}; art() → a data: URL or ''; do(cmd); active(on).
// Events: 'change'.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');

const NOWPLAYING = path.join(__dirname, '..', '..', 'mac-helper', '.build', 'release', 'libtwindesk-nowplaying.dylib');
const PERL_LOAD = 'require DynaLoader; DynaLoader::dl_load_file($ARGV[0], 0) or die DynaLoader::dl_error(); sleep 1 while 1';

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


function readMac() {
  return new Promise((resolve) => execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_SCRIPT], { timeout: 4000 }, (err, out) => resolve(err ? '{}' : out)));
}

function readLinux() {
  return require('../mpris.js').now().then((p) => {
    if (p === undefined) return readPlayerctl(); // no gdbus here
    return p ? JSON.stringify({ app: p.app, title: p.title, artist: p.artist, album: p.album, playing: p.playing }) : '{}';
  });
}

function readPlayerctl() {
  const fmt = '{{status}}\t{{playerName}}\t{{xesam:title}}\t{{xesam:artist}}\t{{xesam:album}}';
  return new Promise((resolve) => execFile('playerctl', ['metadata', '--format', fmt], { timeout: 3000 }, (err, out) => {
    if (err) return resolve('{}');
    const [status, app, title, artist, album] = String(out).trim().split('\t');
    if (!title || status === 'Stopped') return resolve('{}');
    resolve(JSON.stringify({ app, title, artist, album, playing: status === 'Playing' }));
  }));
}

let winHelper = null; // (cmd, args) → Promise, from windows/main.js
function readWin() {
  if (!winHelper) return Promise.resolve('{}');
  return winHelper('deckMedia', {}).then((r) => {
    const p = r && r.playing;
    if (!p || !p.title) return '{}';
    return JSON.stringify({ app: p.app || '', title: p.title, artist: p.artist || '', album: p.album || '', playing: p.state === 'playing' });
  }, () => '{}');
}

const READ = { darwin: readMac, linux: readLinux, win32: readWin };
const KEYS = { toggle: 'MediaPlayPause', play: 'MediaPlayPause', pause: 'MediaPlayPause', next: 'MediaTrackNext', previous: 'MediaTrackPrevious' };

class PcMedia extends EventEmitter {
  // Windows: the helper's request(cmd, args), once at startup.
  static useHelper(fn) { winHelper = typeof fn === 'function' ? fn : null; }
  static ask(cmd, args = {}) { return winHelper ? winHelper(cmd, args) : Promise.reject(new Error('no helper')); }
  constructor({ key, platform = process.platform } = {}) {
    super();
    this.key = key;
    this.read = READ[platform] || null;
    this.platform = platform;
    this.now = {};
    this.last = '{}';
    this.timer = null;
    this.busy = false;
    this.artUrl = '';
    this.proc = null; // macOS: the Now Playing stream (perl + the dylib), while active
    this.streamOk = platform === 'darwin' && fs.existsSync(NOWPLAYING) && fs.existsSync('/usr/bin/perl');
  }

  active(on) {
    this.on = !!on;
    if (this.streamOk) {
      if (on && !this.proc) this._stream();
      if (!on && this.proc) { const p = this.proc; this.proc = null; try { p.kill(); } catch (_) {} }
      if (this.proc || !on) return;
    }
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

  // macOS's Now Playing, a JSON line on each change (mac-helper/Sources/twindesk-nowplaying).
  _stream() {
    let p;
    try { p = spawn('/usr/bin/perl', ['-e', PERL_LOAD, NOWPLAYING], { stdio: ['pipe', 'pipe', 'ignore'] }); } catch (_) { this.streamOk = false; return; }
    this.proc = p;
    let buf = '';
    let got = false;
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m = {};
        try { m = JSON.parse(line) || {}; } catch (_) { continue; }
        if (m.error) continue;
        got = true;
        this._set(m, typeof m.art === 'string' && m.art.startsWith('data:image/') && m.art.length < 400000 ? m.art : '');
      }
      if (buf.length > 1000000) buf = '';
    });
    p.stdin.on('error', () => {});
    p.on('exit', () => {
      if (this.proc !== p) return; // stopped
      this.proc = null;
      if (!got) this.streamOk = false; // it never worked here: AppleScript from now on
      setTimeout(() => this.on && this.active(true), got ? 2000 : 0);
    });
  }

  _set(m, art) {
    const next = m.title ? { title: str(m.title), artist: str(m.artist), album: str(m.album), app: str(m.app, 100), playing: m.playing !== false && m.playing !== 0 } : {};
    const k = JSON.stringify(next);
    if (k === this.last && art === this.artUrl) return;
    this.last = k;
    this.now = next;
    this.artUrl = next.title ? art : '';
    this.emit('change');
  }

  art() {
    return this.artUrl;
  }

  async poll() {
    if (this.busy || !this.read) return;
    this.busy = true;
    let m = {};
    try { m = JSON.parse(String(await this.read()).trim() || '{}') || {}; } catch (_) { m = {}; }
    this.busy = false;
    this._set(m, '');
  }

  state() {
    return this.now;
  }

  do(cmd) {
    // Play while playing (or Pause while paused) would toggle it the wrong way: nothing to do.
    if (cmd === 'play' && this.now.playing === true) return;
    if (cmd === 'pause' && this.now.playing === false) return;
    if (this.proc) {
      try { this.proc.stdin.write(`${cmd}\n`); } catch (_) {}
      return;
    }
    if (this.platform === 'linux') {
      const pc = { toggle: 'play-pause', play: 'play', pause: 'pause', next: 'next', previous: 'previous' }[cmd];
      require('../mpris.js').act(cmd).then((ok) => {
        if (!ok) execFile('playerctl', [pc], { timeout: 3000 }, (err) => { if (err && KEYS[cmd]) this.key(KEYS[cmd]); });
      });
    } else if (KEYS[cmd]) {
      this.key(KEYS[cmd]);
    }
    setTimeout(() => this.poll(), 600);
  }
}

module.exports = { PcMedia };

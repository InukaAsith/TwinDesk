// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The clipboard Linux's clipboard sharing reads and writes. On a Wayland desktop with the
// data-control protocol (Hyprland, Sway and other wlroots ones, KDE Plasma) Electron's clipboard
// neither sees other apps' copies nor reaches them, focused or not (#97): there it's wl-clipboard
// (wl-paste / wl-copy), with the same calls as Electron's before 44 (readText, writeText,
// availableFormats, readBuffer, readImage, writeImage), each returning a Promise. GNOME has no
// data-control (wl-clipboard would flash a window to get focus), X11 needs none: Electron's there.
'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX = 16 * 1024 * 1024;

function onPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch (_) { /* not here */ }
  }
  return false;
}

// wl-clipboard is used: Wayland, not GNOME, and wl-paste and wl-copy installed.
function wanted(env = process.env, has = onPath) {
  return !!env.WAYLAND_DISPLAY && !/gnome/i.test(String(env.XDG_CURRENT_DESKTOP || '')) && has('wl-paste') && has('wl-copy');
}

// args → stdout as a Buffer; an empty clipboard (wl-paste exits 1 with "Nothing is copied") is empty.
function paste(args, run = execFile) {
  return new Promise((resolve) => {
    run('wl-paste', args, { encoding: 'buffer', maxBuffer: MAX, timeout: 2000 }, (err, out) => resolve(err ? Buffer.alloc(0) : out));
  });
}

function copy(type, data, start = spawn) {
  return new Promise((resolve) => {
    const p = start('wl-copy', ['--type', type], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', (e) => { console.error('[clip] wl-copy:', e.message); resolve(false); });
    p.on('spawn', () => resolve(true)); // wl-copy stays in the background, serving the copy
    p.stdin.on('error', () => {});
    p.stdin.end(data);
  });
}

// opts.run / opts.start: execFile / spawn (tests); opts.nativeImage: Electron's.
function wlClipboard(opts = {}) {
  const run = opts.run || execFile;
  const start = opts.start || spawn;
  const nativeImage = () => opts.nativeImage || require('electron').nativeImage;
  return {
    wayland: true,
    async readText() { return (await paste(['--no-newline', '--type', 'text'], run)).toString('utf8'); },
    writeText(text) { return copy('text/plain;charset=utf-8', String(text), start); },
    async availableFormats() {
      return (await paste(['--list-types'], run)).toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    },
    async readBuffer(type) {
      if (!(await this.availableFormats()).includes(type)) return Buffer.alloc(0);
      return paste(['--type', type], run);
    },
    async readImage() {
      const types = await this.availableFormats();
      if (!types.includes('image/png')) return nativeImage().createEmpty();
      return nativeImage().createFromBuffer(await paste(['--type', 'image/png'], run));
    },
    writeImage(img) { return copy('image/png', img.toPNG(), start); },
  };
}

let chosen = null;
// The clipboard to use here (decided once).
function clipboard() {
  if (!chosen) chosen = wanted() ? wlClipboard() : require('electron').clipboard;
  return chosen;
}

module.exports = { clipboard, wlClipboard, wanted };

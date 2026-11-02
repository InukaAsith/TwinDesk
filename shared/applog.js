// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Log files, for all three apps (one-to-one and Multi-device): what's printed with console.* (the
// helpers' stderr too: helper.js prints it) also goes to TwinDesk.log in the system's log folder
// (app.getPath('logs'): ~/Library/Logs/TwinDesk on the Mac; on Windows and Linux logs in the settings
// folder, %APPDATA%\MacShare\logs, ~/.config/MacShare/logs), kept to 5 MB × 3 (TwinDesk.log, .1.log,
// .2.log). Crashes
// (an uncaught exception or rejection here, a window's renderer or another Electron process gone)
// go to crash.log as well, and the app goes on as before. While connected, once every 30 s, one
// line on the link: round trip p50/p95, pointer moves a second, bytes queued on the socket.
//
// start(app) as early as possible; dir(); open() (Open log folder); linkStats(sample): sample() ->
// null when not connected, else {rtt: ms | null, queued: bytes}, asked every second; returns stop().
'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

let maxBytes = 5 * 1024 * 1024;
const KEEP = 3; // TwinDesk.log and two older ones
const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
const STATS_MS = 30000;

let folder = '';
let fd = null; // TwinDesk.log, written in order with crash()'s lines (a stream's end() is too late to rename on Windows)
let size = 0;
let started = false;
let terminal = console.error.bind(console); // the console before start(): the terminal only

function dir() {
  return folder;
}

const file = (i) => path.join(folder, i ? `TwinDesk.${i}.log` : 'TwinDesk.log');
const stamp = () => new Date().toISOString();

function openStream() {
  try {
    size = fs.statSync(file(0)).size;
  } catch (_) {
    size = 0;
  }
  fd = fs.openSync(file(0), 'a');
}

function closeFd() {
  if (fd === null) return;
  try { fs.closeSync(fd); } catch (_) { /* gone */ }
  fd = null;
}

// TwinDesk.log -> .1.log -> .2.log; the oldest goes.
function rotate() {
  closeFd(); // closed before the rename: Windows doesn't rename an open file
  for (let i = KEEP - 1; i > 0; i--) {
    try { fs.renameSync(file(i - 1), file(i)); } catch (_) { /* not there yet */ }
  }
  try {
    openStream();
  } catch (_) {
    fd = null;
  }
}

function write(line) {
  if (fd === null) return;
  const bytes = Buffer.byteLength(line);
  if (size + bytes > maxBytes) rotate();
  if (fd === null) return;
  try {
    fs.writeSync(fd, line);
    size += bytes;
  } catch (_) {
    closeFd(); // a full or read-only disk: console only
  }
}

// What went wrong, at once and whatever happens next (crash.log and TwinDesk.log).
function crash(kind, detail) {
  const text = detail instanceof Error ? detail.stack || String(detail) : typeof detail === 'string' ? detail : util.inspect(detail);
  const line = `${stamp()} [crash] ${kind}: ${text}\n`;
  try { fs.appendFileSync(path.join(folder, 'crash.log'), line); } catch (_) { /* no folder */ }
  try { if (fd !== null) fs.writeSync(fd, line); } catch (_) { /* best effort */ }
  try { terminal(line.trimEnd()); } catch (_) { /* no terminal */ }
}

// opts.maxBytes: a smaller file, for tests.
function start(app, opts = {}) {
  if (started) return;
  started = true;
  if (opts.maxBytes) maxBytes = opts.maxBytes;
  try {
    folder = app.getPath('logs');
  } catch (_) {
    folder = path.join(app.getPath('userData'), 'logs');
  }
  try {
    fs.mkdirSync(folder, { recursive: true });
    openStream();
  } catch (_) {
    fd = null;
  }
  terminal = console.error.bind(console);
  for (const level of LEVELS) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      try { orig(...args); } catch (_) { /* no terminal (EPIPE) */ }
      try { write(`${stamp()} ${level === 'log' || level === 'info' ? '' : level.toUpperCase() + ' '}${util.format(...args)}\n`); } catch (_) { /* best effort */ }
    };
  }
  write(`${stamp()} ---- TwinDesk ${app.getVersion()} started (${process.platform} ${process.arch}, Electron ${process.versions.electron || ''}) ----\n`);
  // Handled here, the app goes on (as Electron's own dialog let it), and it's in the log.
  process.on('uncaughtException', (e) => crash('uncaughtException', e));
  process.on('unhandledRejection', (e) => crash('unhandledRejection', e));
  app.on('render-process-gone', (_e, wc, d) => {
    let url = '';
    try { url = wc.getURL(); } catch (_) { /* gone */ }
    crash('render-process-gone', `${d.reason} (exit ${d.exitCode}) ${url}`);
  });
  app.on('child-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return;
    crash('child-process-gone', `${d.type}${d.name ? ' ' + d.name : ''}: ${d.reason} (exit ${d.exitCode})`);
  });
}

function open() {
  if (!folder) return;
  try {
    require('electron').shell.openPath(folder);
  } catch (_) { /* not in Electron */ }
}

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p + 0.5))];
}

// The link line every 30 s while connected (sample: see above). Moves: shared/kvm-moves.js counts them.
function linkStats(sample, everyMs = STATS_MS, sampleMs = 1000) {
  const { KvmMoves } = require('./kvm-moves.js');
  let rtts = [];
  let queuedMax = 0;
  let seen = 0;
  let moves = KvmMoves.count;
  let since = Date.now();
  const tick = setInterval(() => {
    let s = null;
    try { s = sample(); } catch (_) { s = null; }
    if (s) {
      seen++;
      if (typeof s.rtt === 'number' && s.rtt >= 0) rtts.push(s.rtt);
      queuedMax = Math.max(queuedMax, Number(s.queued) || 0);
    }
    const now = Date.now();
    if (now - since < everyMs) return;
    if (seen) {
      const sorted = rtts.slice().sort((a, b) => a - b);
      const rtt = sorted.length ? `rtt p50 ${pct(sorted, 0.5)} ms / p95 ${pct(sorted, 0.95)} ms` : 'rtt –';
      const perSec = Math.round((KvmMoves.count - moves) / ((now - since) / 1000));
      console.log(`[link] ${rtt}, kvm moves ${perSec}/s, queued max ${queuedMax} bytes`);
    }
    rtts = [];
    queuedMax = 0;
    seen = 0;
    moves = KvmMoves.count;
    since = now;
  }, sampleMs);
  if (tick.unref) tick.unref();
  return () => clearInterval(tick);
}

module.exports = { start, dir, open, linkStats, crash };

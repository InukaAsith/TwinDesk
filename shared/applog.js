// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Log files, for all three apps (one-to-one and Multi-device): what's printed with console.* (the
// helpers' stderr too: helper.js prints it) also goes to TwinDesk.log in the system's log folder
// (app.getPath('logs'): ~/Library/Logs/TwinDesk on the Mac; on Windows and Linux logs in the settings
// folder, %APPDATA%\MacShare\logs, ~/.config/MacShare/logs), kept to 5 MB × 3 (TwinDesk.log, .1.log,
// .2.log). Crashes
// (an uncaught exception or rejection here, a window's renderer or another Electron process gone)
// go to crash.log as well (1 MB × 2: crash.log, crash.1.log; the same crash again is a count), and
// the app goes on as before. With TWINDESK_LINK_STATS=1, while connected (to link-stats.log, not TwinDesk.log),
// once every 30 s, one line on the link: round trip p50/p95/p99/max, the input lane's (shared/inputlane.js) when it's
// up, pointer moves a second, bytes queued on the socket, and how long the main thread's event loop
// was held up (p99 and max: garbage collection, sync writes, IPC).
//
// start(app) as early as possible; dir(); open() (Open log folder); linkStats(sample): sample() ->
// null when not connected, else {rtt: ms | null, lane?: ms | null, queued: bytes}, asked every
// second; returns stop().
'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

let maxBytes = 5 * 1024 * 1024;
const KEEP = 3; // TwinDesk.log and two older ones
const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
const STATS_MS = 30000;
let crashMax = 1024 * 1024; // crash.log, then crash.1.log: two files at most, whatever loops

let folder = '';
let fd = null; // TwinDesk.log, written in order with crash()'s lines (a stream's end() is too late to rename on Windows)
let size = 0;
let started = false;
let terminal = console.error.bind(console); // the console before start(): the terminal only
let consoleDead = false; // its pipe is gone (no terminal when launched from the menu): nothing more goes out to it
const crashes = new Map(); // kind + the first line of the stack -> how often it came back, and when it started

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

// A tenth, hundredth, thousandth time: one line, not one line per crash.
function milestone(n) {
  while (n >= 10 && n % 10 === 0) n /= 10;
  return n === 1;
}

// The EPIPE of a pipe nobody reads arrives as an 'error' event on the stream, asynchronously, not
// as a throw the caller could catch: left unanswered it becomes an uncaughtException, and that is
// what closed the loop (crash() wrote to the same dead terminal).
function watchPipe(stream) {
  if (!stream || typeof stream.on !== 'function') return;
  stream.on('error', (e) => {
    if (e && e.code === 'EPIPE') {
      consoleDead = true;
      return;
    }
    throw e; // anything else still goes through crash()
  });
}

// crash.log (what people send with a bug report) is kept to crashMax × 2 (crash.log, crash.1.log),
// TwinDesk.log keeps the same line under its own cap.
function crashLine(line) {
  const f = path.join(folder, 'crash.log');
  try {
    if (fs.statSync(f).size + Buffer.byteLength(line) > crashMax) fs.renameSync(f, path.join(folder, 'crash.1.log'));
  } catch (_) { /* not there yet */ }
  try { fs.appendFileSync(f, line); } catch (_) { /* no folder */ }
  write(line);
}

// What went wrong, at once and whatever happens next (crash.log and TwinDesk.log). The same crash,
// over and over, is one line and then a count: a loop must not fill the disk by itself.
function crash(kind, detail) {
  const text = detail instanceof Error ? detail.stack || String(detail) : typeof detail === 'string' ? detail : util.inspect(detail);
  const at = stamp();
  const key = `${kind}: ${text.split('\n')[0]}`;
  const seen = crashes.get(key);
  if (seen) {
    seen.count++;
    if (milestone(seen.count)) crashLine(`${at} [crash] ${key} (repeated ${seen.count} times since ${seen.first})\n`);
    return;
  }
  crashes.set(key, { count: 1, first: at });
  const line = `${at} [crash] ${kind}: ${text}\n`;
  crashLine(line);
  // Not on the terminal it is reporting about: that write is what came back as another crash.
  if (!consoleDead) {
    try { terminal(line.trimEnd()); } catch (_) { consoleDead = true; /* no terminal */ }
  }
}

// opts.maxBytes: a smaller file, for tests.
function start(app, opts = {}) {
  if (started) return;
  started = true;
  if (opts.maxBytes) maxBytes = opts.maxBytes;
  if (opts.crashBytes) crashMax = opts.crashBytes;
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
  watchPipe(process.stdout);
  watchPipe(process.stderr);
  for (const level of LEVELS) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      if (!consoleDead) {
        try { orig(...args); } catch (_) { consoleDead = true; /* no terminal (EPIPE) */ }
      }
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

// The link line goes to its own file (link-stats.log, 1 MB × 2), apart from TwinDesk.log's events (#143:
// a log full of measurements hid what happened). Before start() (no folder): the console.
function statsLine(line) {
  if (!folder) return void console.log(line);
  const f = path.join(folder, 'link-stats.log');
  try {
    let n = 0;
    try { n = fs.statSync(f).size; } catch (_) { /* none yet */ }
    if (n > crashMax) fs.renameSync(f, path.join(folder, 'link-stats.1.log'));
    fs.appendFileSync(f, `${stamp()} ${line}\n`);
  } catch (_) { /* a full disk: no stats */ }
}

// The link line every 30 s while connected (sample: see above). Moves: shared/kvm-moves.js counts them.
// Off unless TWINDESK_LINK_STATS=1 (a developer's measurement): its sampling (a 10 ms event-loop
// monitor and a 1 s timer) would wake the app all day, and its line would go to disk every 30 s.
function linkStats(sample, everyMs = STATS_MS, sampleMs = 1000) {
  if (process.env.TWINDESK_LINK_STATS !== '1') return () => {};
  const { KvmMoves } = require('./kvm-moves.js');
  let loop = null; // the event loop's delay, reset after each line
  try {
    loop = require('perf_hooks').monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
  } catch (_) { loop = null; }
  let rtts = [];
  let lanes = [];
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
      if (typeof s.lane === 'number' && s.lane >= 0) lanes.push(s.lane);
      queuedMax = Math.max(queuedMax, Number(s.queued) || 0);
    }
    const now = Date.now();
    if (now - since < everyMs) return;
    if (seen) {
      const sorted = rtts.slice().sort((a, b) => a - b);
      const rtt = sorted.length ? `rtt p50 ${pct(sorted, 0.5)} ms / p95 ${pct(sorted, 0.95)} ms / p99 ${pct(sorted, 0.99)} ms / max ${sorted[sorted.length - 1]} ms` : 'rtt –';
      const ls = lanes.slice().sort((a, b) => a - b);
      const lane = ls.length ? `, lane p50 ${ls[Math.floor((ls.length - 1) / 2)].toFixed(1)} ms / max ${ls[ls.length - 1].toFixed(1)} ms` : '';
      const perSec = Math.round((KvmMoves.count - moves) / ((now - since) / 1000));
      const lp = loop && loop.count ? `, loop p99 ${(loop.percentile(99) / 1e6).toFixed(1)} ms / max ${(loop.max / 1e6).toFixed(1)} ms` : '';
      statsLine(`[link] ${rtt}${lane}, kvm moves ${perSec}/s, queued max ${queuedMax} bytes${lp}`);
    }
    if (loop) loop.reset();
    rtts = [];
    lanes = [];
    queuedMax = 0;
    seen = 0;
    moves = KvmMoves.count;
    since = now;
  }, sampleMs);
  if (tick.unref) tick.unref();
  return () => {
    clearInterval(tick);
    if (loop) loop.disable();
  };
}

module.exports = { start, dir, open, linkStats, crash };

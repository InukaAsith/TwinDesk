// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tests for shared/applog.js: console into the log file, kept to three files, crashes, the link line.
// Run with: node shared/test/applog.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twindesk-log-'));
const app = Object.assign(new EventEmitter(), { getPath: () => dir, getVersion: () => '9.9.9' });
const applog = require('../applog.js');
const { KvmMoves } = require('../kvm-moves.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return ''; } };

(async () => {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true; // the test's own console stays quiet
  process.stderr.write = () => true;
  try {
    applog.start(app, { maxBytes: 4000, crashBytes: 3000 });
    assert.strictEqual(applog.dir(), dir);
    console.log('hello %s', 'world');
    console.warn('[helper] something');
    await wait(50);
    let log = read('TwinDesk.log');
    assert.ok(/TwinDesk 9\.9\.9 started/.test(log), 'the start line');
    assert.ok(/Z hello world\n/.test(log), 'console.log, formatted');
    assert.ok(/WARN \[helper\] something/.test(log), 'warn says so');

    // Past the size: TwinDesk.log -> .1 -> .2, never a fourth.
    for (let i = 0; i < 400; i++) console.log('line %d %s', i, 'x'.repeat(40));
    await wait(100);
    const files = fs.readdirSync(dir).filter((f) => /^TwinDesk/.test(f)).sort();
    assert.deepStrictEqual(files, ['TwinDesk.1.log', 'TwinDesk.2.log', 'TwinDesk.log'], files.join());
    for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 4200, `${f} kept small`);
    assert.ok(/line 399 /.test(read('TwinDesk.log')), 'the newest in TwinDesk.log');

    // Crashes: in crash.log at once, and the process goes on.
    process.emit('uncaughtException', new Error('boom'));
    process.emit('unhandledRejection', new Error('nobody caught me'));
    app.emit('render-process-gone', {}, { getURL: () => 'file:///app.html' }, { reason: 'crashed', exitCode: 11 });
    app.emit('child-process-gone', {}, { type: 'GPU', reason: 'clean-exit', exitCode: 0 });
    const crash = read('crash.log');
    assert.ok(/\[crash\] uncaughtException: Error: boom\n\s+at /.test(crash), 'the stack');
    assert.ok(/unhandledRejection: Error: nobody caught me/.test(crash));
    assert.ok(/render-process-gone: crashed \(exit 11\) file:\/\/\/app\.html/.test(crash));
    assert.ok(!/GPU/.test(crash), 'a clean exit is no crash');

    // The link line: only while connected, rtt p50/p95, moves a second, the most queued.
    let connected = true;
    let rtt = 0;
    process.env.TWINDESK_LINK_STATS = '1'; // off by default (no wakeups, no disk)
    const stop = applog.linkStats(() => (connected ? { rtt: (rtt = (rtt % 10) + 1), lane: 1.5, queued: rtt * 100 } : null), 200, 10);
    const moves = new KvmMoves({ send: () => {} });
    for (let i = 0; i < 100; i++) moves.add(1, 0);
    const linkLines = () => read('link-stats.log').split('\n').filter((l) => l.includes('[link]')); // its own file (#143)
    await wait(230);
    connected = false;
    await wait(250); // the window it went in
    const after = linkLines().length;
    await wait(450);
    stop();
    moves.drop();
    const lines = linkLines();
    assert.ok(lines.length >= 1, 'a line while connected');
    assert.strictEqual(lines.length, after, 'none once not connected');
    assert.ok(!read('TwinDesk.log').includes('[link] rtt'), 'TwinDesk.log keeps to events');
    assert.ok(/\[link\] rtt p50 \d+ ms \/ p95 (9|10) ms \/ p99 (9|10) ms \/ max 10 ms, lane p50 1\.5 ms \/ max 1\.5 ms, kvm moves (4\d\d|5\d\d)\/s, queued max (900|1000) bytes, loop p99 [\d.]+ ms \/ max [\d.]+ ms/.test(lines[0]), lines[0]);

    // Launched from the desktop menu on Linux there is no terminal: the pipe behind stdout is gone.
    // Node reports that EPIPE as an 'error' event on the stream, later, not as a throw — and every
    // console line used to come back through crash(), which wrote to the same dead pipe again.
    let piped = 0;
    process.stdout.write = () => {
      piped++;
      process.nextTick(() => process.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
      return false;
    };
    const crashBefore = read('crash.log');
    console.log('the pipe is dead');
    await wait(40); // the EPIPE lands here, after the write returned
    assert.ok(/the pipe is dead/.test(read('TwinDesk.log')), 'the line still reaches the file');
    const pipedOnce = piped;
    for (let i = 0; i < 200; i++) console.log('and %d more', i);
    await wait(60);
    assert.strictEqual(piped, pipedOnce, 'the dead terminal is written to once, then never again');
    assert.strictEqual(read('crash.log'), crashBefore, 'and none of it crashes anything');

    // The same crash, again and again: one line, then how many times it came back.
    for (let i = 0; i < 12; i++) process.emit('uncaughtException', new Error('same thing again'));
    const dedup = read('crash.log');
    assert.strictEqual((dedup.match(/\[crash\] uncaughtException: Error: same thing again\n/g) || []).length, 1, 'written once');
    assert.ok(/uncaughtException: Error: same thing again \(repeated 10 times since /.test(dedup), dedup.slice(-500));
    process.emit('uncaughtException', new Error('something else'));
    assert.ok(/\[crash\] uncaughtException: Error: something else\n\s+at /.test(read('crash.log')), 'a new one keeps its stack');

    // Different crashes, many of them: crash.log stays capped, one older file kept.
    for (let i = 0; i < 60; i++) process.emit('uncaughtException', new Error(`crash number ${i}`));
    assert.ok(fs.statSync(path.join(dir, 'crash.log')).size <= 3000, 'crash.log capped');
    assert.ok(fs.statSync(path.join(dir, 'crash.1.log')).size <= 3000, 'crash.1.log capped');
    assert.ok(/crash number 59/.test(read('crash.log')), 'the newest is kept');
    assert.ok(!fs.existsSync(path.join(dir, 'crash.2.log')), 'two files at most');
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows: TwinDesk.log is still open */ }
  realOut('applog: ok\n'); // not console.log: its terminal was killed above, on purpose
  process.exit(0);
})().catch((e) => {
  process.stderr.write(`${e && e.stack ? e.stack : e}\n`); // the console may be the dead one above
  process.exit(1);
});

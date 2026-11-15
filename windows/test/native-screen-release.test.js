'use strict';
// A frame whose hand-off to the sender window times out must still give its slot back to the capture
// exe (it has 3): else, slots stuck, no frame comes and the share ends 3 s later.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');
const EventEmitter = require('node:events');
const { PassThrough } = require('node:stream');

let sends = [];
const imported = [];
const electron = {
  sharedTexture: {
    importSharedTexture: (o) => { const t = { release() {}, o }; imported.push(t); return t; },
    sendSharedTexture: () => new Promise((resolve, reject) => sends.push({ resolve, reject })),
  },
};
let proc;
const childProcess = {
  spawn: () => {
    proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.written = [];
    proc.stdin = { writable: true, write: (s) => proc.written.push(s), end() {}, on() {} };
    proc.exitCode = null;
    proc.kill = () => {};
    return proc;
  },
};
const load = Module._load;
Module._load = function (name, ...rest) {
  if (name === 'electron') return electron;
  if (name === 'child_process') return childProcess;
  return load.call(this, name, ...rest);
};
const NativeScreen = require('../native-screen.js');
Module._load = load;

const line = (o) => proc.stdout.write(JSON.stringify(o) + '\n');
const tick = () => new Promise((r) => setImmediate(r));

test('a timed-out hand-off releases its slot once, and a late release does not free a newer frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  sends = [];
  const errors = [];
  const cap = new NativeScreen({}, 1, (e) => errors.push(e));
  const started = cap.start({ x: 0, y: 0, width: 100, height: 100 }, 30);
  line({ ready: true, backend: 'dda', width: 100, height: 100 });
  await tick();
  await started;
  line({ frame: 0, handle: '1', width: 100, height: 100, timestamp: 1 });
  await tick();
  sends[0].reject(new Error('transfer shared texture timed out after 1000ms'));
  await tick();
  assert.deepEqual(proc.written, [], 'not yet: Electron may still release it');
  t.mock.timers.tick(1500);
  assert.deepEqual(proc.written, ['0\n'], 'the slot is back after the deadline');
  // The exe puts the next frame in slot 0; the first frame's release arriving late must not free it.
  line({ frame: 0, handle: '1', width: 100, height: 100, timestamp: 2 });
  await tick();
  imported[0].o.allReferencesReleased();
  assert.deepEqual(proc.written, ['0\n'], 'an old frame never frees the slot a newer one is in');
  sends[1].resolve();
  await tick();
  imported[1].o.allReferencesReleased();
  assert.deepEqual(proc.written, ['0\n', '0\n']);
  imported[1].o.allReferencesReleased();
  assert.equal(proc.written.length, 2, 'released once');
  assert.deepEqual(errors, []);
  cap.stop();
});

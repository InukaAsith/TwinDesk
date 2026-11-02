// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const detail = 'native {name} $& <script>raw</script>';

function sessionClass(platform) {
  const file = path.resolve(__dirname, '../../', platform, 'scrcpy.js');
  const sandbox = { module: { exports: {} }, require: createRequire(file), Buffer, console, setTimeout: (fn) => { fn(); return 0; } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.module.exports.Session;
}

function adbFixture() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => {};
  return {
    proc, server: 'server.jar',
    push: async () => ({ code: 0, err: '', out: '' }),
    shell: async () => ({ code: 0, err: '', out: '' }),
    forward: async () => 12345, unforward: () => {}, spawnShell: () => proc,
  };
}

function socketFixture(data) {
  const sock = new EventEmitter();
  sock.resume = () => { if (data) { const next = data; data = null; sock.emit('data', next); } };
  sock.destroy = () => sock.emit('close');
  return sock;
}

async function rejectsWith(work, message, key, vars = {}) {
  await assert.rejects(work, (e) => {
    assert.equal(e.message, message, 'existing diagnostic text remains unchanged');
    assert.equal(e.messageKey, key, 'only the application-owned wrapper becomes a translation key');
    assert.equal(JSON.stringify(e.messageVars), JSON.stringify(vars), 'native details remain literal variables');
    return true;
  });
}

async function run(platform) {
  const Session = sessionClass(platform);
  const make = (adb = adbFixture(), opts) => new Session(adb, platform + '-' + Math.random(), opts);
  const push = adbFixture();
  push.push = async () => ({ code: 1, err: '  ' + detail + '  ', out: '' });
  await rejectsWith(make(push).start(), `Couldn’t copy the screen helper to the phone (${detail})`, 'Couldn’t copy the screen helper to the phone ({error})', { error: detail });

  const prepare = adbFixture();
  prepare.shell = async () => ({ code: 1, err: '', out: detail });
  await rejectsWith(make(prepare).start(), `Couldn’t prepare the screen helper (${detail})`, 'Couldn’t prepare the screen helper ({error})', { error: detail });

  for (const log of ['', detail]) {
    const s = make();
    s._connect = async () => { throw new Error(detail); };
    if (log) s.log.push(log);
    await rejectsWith(s._connectFirst(), 'The phone’s screen helper didn’t start' + (log ? ` (${log})` : ''),
      log ? 'The phone’s screen helper didn’t start ({error})' : 'The phone’s screen helper didn’t start', log ? { error: log } : {});
  }

  const native = adbFixture();
  native.forward = async () => { throw new Error(detail); };
  await assert.rejects(make(native).start(), (e) => e.message === detail && !e.messageKey);

  for (const [event, reason] of [['exit', 'the screen helper stopped'], ['socket', 'the connection closed'], ['stop', 'stopped']]) {
    const adb = adbFixture(), s = make(adb, { video: false, audio: false, control: event === 'socket' });
    const socket = socketFixture();
    s._connectFirst = async () => socket;
    s._readStreams = () => {};
    await s.start();
    const closed = new Promise((resolve) => s.once('closed', (why, meta) => resolve({ why, meta })));
    if (event === 'exit') adb.proc.emit('exit');
    else if (event === 'socket') socket.emit('close');
    else s.stop();
    const result = await closed;
    assert.equal(result.why, reason, 'legacy closed reason is the first argument');
    assert.equal(result.meta && result.meta.messageKey, reason);
    assert.equal(s.why, reason);
    await rejectsWith(Session.prototype._connectFirst.call(s), reason, reason);
  }

  for (const [kind, bytes, message, key, vars] of [
    ['video', Buffer.from([0, 0, 0, 0]), 'The phone can’t share its screen', 'The phone can’t share its screen', {}],
    ['video', Buffer.from([0, 0, 0, 255]), 'Unexpected video codec ff', 'Unexpected video codec {codec}', { codec: 'ff' }],
    ['control', Buffer.from([250]), 'Unknown device message 250', 'Unknown device message {type}', { type: 250 }],
  ]) {
    const s = make();
    s[kind] = socketFixture(Buffer.concat([Buffer.alloc(64), bytes]));
    const closed = new Promise((resolve) => s.once('closed', (why, meta) => resolve({ why, meta })));
    await s._readStreams(kind);
    const result = await closed;
    assert.equal(result.why, message);
    assert.equal(result.meta && result.meta.messageKey, key);
    assert.equal(JSON.stringify(result.meta.messageVars), JSON.stringify(vars));
  }

  const unknown = make();
  let received;
  unknown.once('closed', (why, meta) => { received = { why, meta }; });
  unknown._close(detail);
  assert.equal(received.why, detail);
  assert.ok(!received.meta, 'unknown native reason never becomes a translation key');
  await assert.rejects(unknown._connectFirst(), (e) => e.message === detail && !e.messageKey);

  const input = make();
  const sent = [];
  input.control = { write: (bytes) => sent.push(bytes) };
  input.setTorch(true); input.setTorch(false); input.zoomIn(); input.zoomOut();
  assert.deepEqual(sent.map((bytes) => [...bytes]), [[18, 1], [18, 0], [19], [20]], 'control protocol bytes stay unchanged');
}

(async () => {
  for (const platform of ['windows', 'mac']) await run(platform);
  console.log('i18n-phone-errors: both Session implementations preserve native details/legacy reasons and expose local message metadata; control bytes unchanged');
})().catch((e) => { console.error(e); process.exitCode = 1; });

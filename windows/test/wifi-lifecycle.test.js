'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
function fixture() {
  const calls = [], files = new Map(), requests = [];
  let command = async () => '', profile = async () => ({});
  // The profile goes over the helper's pipe (wlanProfile), never through a file or netsh add.
  const helper = { request: async (name, args) => { requests.push({ name, args }); if (name === 'wlanProfile') return profile(args); return name === 'wfdRadio' ? { was: 'off' } : {}; } };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../wifi.js'), 'utf8'), {
    require: name => ({ child_process: { execFile: (_file, args, _opts, cb) => { calls.push(args); command(args).then(out => cb(null, out), e => cb(e, '')); } },
      fs: { writeFileSync: (p, data) => files.set(p, data), rmSync: p => files.delete(p) }, os: { tmpdir: () => 'temp', networkInterfaces: () => ({}) }, path })[name],
    module: mod, Buffer, process: { pid: 1 }, setTimeout: fn => setImmediate(fn), Date,
  });
  const wifi = new mod.exports.Wifi(helper);
  return { wifi, calls, files, requests, helper, command: fn => { command = fn; }, profile: fn => { profile = fn; } };
}
test('cancel during Wi-Fi profile setup prevents all connection retries and releases radio', async () => {
  const f = fixture(), wait = deferred();
  f.wifi._current = async () => 'Home';
  f.profile(() => wait.promise);
  const joining = f.wifi.join('TwinDesk-test', 'password'); const rejected = assert.rejects(joining, /cancelled/); await tick();
  const leaving = f.wifi.leave(); wait.resolve(''); await rejected; await leaving;
  assert.equal(f.calls.some(a => a.includes('ssid=TwinDesk-test')), false);
  assert.equal(f.wifi.holds.size, 0); assert.equal(f.wifi.joined, ''); assert.equal(f.files.size, 0);
  assert.ok(f.calls.some(a => a.includes('name=Home')));
});
test('failed Wi-Fi profile setup cleans up profile and restores radio', async () => {
  const f = fixture(); f.wifi._current = async () => 'Home';
  f.profile(async () => { throw new Error('failed profile'); });
  await assert.rejects(f.wifi.join('TwinDesk-test', 'password'));
  assert.equal(f.wifi.holds.size, 0); assert.equal(f.files.size, 0);
  assert.ok(f.calls.some(a => a.includes('delete')));
  assert.ok(f.requests.some(r => r.name === 'wfdRadio' && r.args.on === false));
});
test('superseded Wi-Fi join never touches the old profile', async () => {
  const f = fixture(); f.wifi._current = async () => '';
  const old = f.wifi.join('Old', 'password'); const oldFailed = assert.rejects(old, /cancelled/);
  const next = f.wifi.join('Next', 'password'); const nextFailed = assert.rejects(next, /cancelled/);
  await f.wifi.leave(); await oldFailed; await nextFailed;
  assert.equal(f.requests.some(r => r.name === 'wlanProfile'), false);
});
test('Wi-Fi host stop waits for an in-progress start', async () => {
  const f = fixture(), wait = deferred();
  f.helper.request = async (name) => { f.requests.push({ name }); if (name === 'wfdHost') await wait.promise; return {}; };
  const hosting = f.wifi.host('TwinDesk-test', 'password'); await tick(); const stopping = f.wifi.unhost(); await tick();
  assert.equal(f.requests.some(r => r.name === 'wfdStop'), false);
  wait.resolve(); await hosting; await stopping;
  assert.equal(f.requests.at(-1).name, 'wfdStop'); assert.equal(f.wifi.holds.size, 0);
});
test('failed Wi-Fi host setup stops partial hosting and releases its radio hold', async () => {
  const f = fixture(); f.helper.request = async name => { f.requests.push({ name }); if (name === 'wfdHost') throw new Error('host failed'); return { was: 'off' }; };
  await assert.rejects(f.wifi.host('TwinDesk-test', 'password'), /host failed/);
  assert.ok(f.requests.some(r => r.name === 'wfdStop')); assert.equal(f.wifi.holds.size, 0);
});
test('successful Wi-Fi join stays held until leave and restores the previous network', async () => {
  const f = fixture(); let reads = 0;
  f.wifi._current = async () => reads++ === 0 ? 'Home' : 'TwinDesk-test';
  f.wifi._hasAddress = () => true;
  await f.wifi.join('TwinDesk-test', 'password');
  assert.equal(f.wifi.joined, 'TwinDesk-test'); assert.equal(f.wifi.holds.has('join'), true);
  await f.wifi.leave(); assert.equal(f.wifi.joined, ''); assert.equal(f.wifi.holds.size, 0);
  assert.ok(f.calls.some(a => a.includes('name=Home')));
});

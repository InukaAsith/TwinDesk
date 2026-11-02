'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const P = require('../../shared/protocol');
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const tick = () => new Promise(r => setImmediate(r));
function fixture() {
  const generated = deferred(), sent = []; let calls = 0;
  const settings = { terminal: { enabled: true } };
  const link = Object.assign(new EventEmitter(), { status: { state: 'connected' }, send: m => sent.push(m) });
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../terminal.js'), 'utf8'), {
    require: name => ({ electron: { app: { getPath: () => 'data' } }, child_process: { execFile: (_f, _a, _o, cb) => { calls++; generated.promise.then(() => cb(null, '', ''), e => cb(e, '', '')); } },
      fs: { existsSync: f => !f.endsWith('.pub'), mkdirSync() {}, rmSync() {}, readFileSync: () => 'ssh-ed25519 test' },
      os: { hostname: () => 'PC' }, path, '../shared/protocol.js': P, '../shared/sshconfig.js': { setHost() {} } })[name],
    module: mod, process: { env: {} },
  });
  const terminal = new mod.exports({ settings, link, onChange() {} });
  return { terminal, settings, link, sent, generated, calls: () => calls };
}
test('overlapping terminal setup generates one key and sends only the latest request', async () => {
  const f = fixture(); const a = f.terminal.apply(), b = f.terminal.apply();
  assert.equal(f.calls(), 1); f.generated.resolve(); await Promise.all([a, b]);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].t, P.T.SSH_KEY);
});
test('terminal disabled during key generation never sends its key', async () => {
  const f = fixture(); const a = f.terminal.apply(); f.settings.terminal.enabled = false; await f.terminal.apply();
  f.generated.resolve(); await a; assert.equal(f.sent.length, 0); assert.equal(f.terminal.status, 'off');
});
test('terminal disconnect invalidates late key generation failures', async () => {
  const f = fixture(); const a = f.terminal.apply(); f.link.emit('closed'); f.generated.reject(new Error('old failure')); await a;
  assert.equal(f.terminal.status, 'no_mac'); assert.equal(f.sent.length, 0);
});
test('failed terminal key generation can be retried', async () => {
  const f = fixture(); const a = f.terminal.apply(); f.generated.reject(new Error('key failed')); await a;
  assert.equal(f.terminal.keyTask, null); await f.terminal.apply(); await tick(); assert.equal(f.calls(), 2);
});

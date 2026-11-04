// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Caps Lock follows the input (shared/capsync.js, #131): the side handing its input over sends its
// Caps Lock; the side getting it turns its own that way, only right after a take it accepted or its
// input coming home; Linux reads the keyboard light and taps Caps Lock; an older helper changes nothing.
// Run with: node shared/test/capsync.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CapsSync, linuxCaps } = require('../capsync.js');
const P = require('../protocol.js');

const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // Windows / macOS: through the helper
  const calls = [];
  let on = false;
  const helper = { request: async (cmd, a) => { calls.push([cmd, a]); if ('set' in a) on = a.set; return { ok: true, on }; }, send: () => {} };
  const c = new CapsSync({ helper, platform: 'win' });
  const out = [];
  on = true;
  await c.handOver((m) => out.push(m));
  assert.deepStrictEqual(out, [{ t: P.T.KVM_CAPS, on: true }], 'hands over its Caps Lock');
  on = false;
  c.onPeer({ t: P.T.KVM_CAPS, on: true });
  await tick();
  assert.strictEqual(on, false, 'not expected: ignored (a refused take)');
  c.expect();
  c.onPeer({ t: P.T.KVM_CAPS, on: true });
  await tick();
  assert.strictEqual(on, true, 'expected: turned on');
  on = false;
  c.onPeer({ t: P.T.KVM_CAPS, on: true });
  await tick();
  assert.strictEqual(on, false, 'once per expect');
  c.expect(-1);
  c.onPeer({ t: P.T.KVM_CAPS, on: true });
  await tick();
  assert.strictEqual(on, false, 'too late: ignored');

  // an older helper: nothing sent
  const old = new CapsSync({ helper: { request: async () => { throw new Error('unknown command'); } }, platform: 'mac' });
  const none = [];
  await old.handOver((m) => none.push(m));
  assert.deepStrictEqual(none, [], 'older helper: nothing');
  const old2 = new CapsSync({ helper: { request: async () => ({ ok: false, error: 'unknown command' }) }, platform: 'win' });
  await old2.handOver((m) => none.push(m));
  assert.deepStrictEqual(none, [], 'helper says unknown: nothing');

  // Linux: the keyboard light, and a tap to change it
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-leds-'));
  assert.strictEqual(linuxCaps(dir), null, 'no light: unknown');
  fs.mkdirSync(path.join(dir, 'input3::capslock'));
  fs.mkdirSync(path.join(dir, 'input3::numlock'));
  fs.writeFileSync(path.join(dir, 'input3::capslock', 'brightness'), '0\n');
  fs.writeFileSync(path.join(dir, 'input3::numlock', 'brightness'), '1\n');
  assert.strictEqual(linuxCaps(dir), false);
  const sent = [];
  const lx = new CapsSync({ helper: { send: (cmd, a) => sent.push([cmd, a]) }, platform: 'linux', leds: dir });
  const lo = [];
  await lx.handOver((m) => lo.push(m));
  assert.deepStrictEqual(lo, [{ t: P.T.KVM_CAPS, on: false }]);
  lx.expect();
  lx.onPeer({ on: false });
  await tick();
  assert.deepStrictEqual(sent, [], 'the same: no tap');
  lx.expect();
  lx.onPeer({ on: true });
  await tick();
  assert.deepStrictEqual(sent.map(([, a]) => a.ev), [{ t: P.T.K_KEY_DOWN, code: 'CapsLock' }, { t: P.T.K_KEY_UP, code: 'CapsLock' }], 'different: a Caps Lock tap');
  fs.rmSync(dir, { recursive: true, force: true });

  // every kvm.js hands it over and takes it
  const root = path.join(__dirname, '..', '..');
  for (const f of ['windows/kvm.js', 'linux/kvm.js', 'mac/kvm.js', 'windows/mesh/kvm.js', 'linux/mesh/kvm.js', 'mac/mesh/kvm.js']) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    assert.strictEqual((s.match(/caps\.handOver\(/g) || []).length, 2, f + ': on take and on home');
    assert.ok(/KVM_CAPS/.test(s) && /caps\.expect\(\)/.test(s), f + ': takes it');
  }
  console.log('capsync: ok');
})().catch((e) => { console.error(e); process.exit(1); });

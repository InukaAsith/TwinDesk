// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General › Advanced › Engines in use (shared/engines.js): what each part says, and why a fallback.
// Run with: node shared/test/engines.js
'use strict';

const assert = require('assert');
const { snapshot } = require('../engines.js');
const { FastFiles } = require('../fastfile.js');

const fxFor = (session, fx2 = null) => new FastFiles({ session: () => session, deliver() {}, send() {}, fx2 });

assert.strictEqual(snapshot({ current: null }), null, 'nothing while not connected');

// The network, the lane natively, fx2 both ways.
{
  const fx2 = { client: true, ready: true, state: 'running', plainPort: 0 };
  const fx = fxFor({ host: true, token: 'a'.repeat(32), transport: 'ip', address: '192.168.1.5', fx2: true }, fx2);
  const e = snapshot({ current: { transport: 'ip', address: '::ffff:192.168.1.5' }, lane: { native: true, up: true, rttMs: 2.4 }, fx, fx2, lan: 'Wi-Fi' });
  assert.deepStrictEqual(e.link, { kind: 'ip', address: '192.168.1.5', lan: 'Wi-Fi' });
  assert.deepStrictEqual(e.input, { proto: 'tdv2', native: true, up: true, rttMs: 2, why: '' });
  assert.strictEqual(e.files.next, 'fx2');
  assert.strictEqual(e.engine, 'running');
  assert.strictEqual(e.screen, null);
  fx.broken2 = true;
  assert.deepStrictEqual([fx.describe().next, fx.describe().why], ['fx', 'failed'], 'fx2 failed: the fx way');
  fx.broken = true;
  assert.deepStrictEqual([fx.describe().next, fx.describe().why], ['chunk', 'failed']);
}

// A Wi-Fi Direct group: fast files there too; an app without fx2: fx, the other app can't.
{
  const fx = fxFor({ host: false, token: 'a'.repeat(32), transport: 'ip', address: '192.168.49.1', fx2: false }, { client: true, state: 'stopped' });
  const e = snapshot({ current: { transport: 'ip', address: '192.168.49.1' }, lane: null, il: {}, fx, fx2: { state: 'stopped' }, net: { onGroup: true, kind: 'direct' }, screen: { codec: 'h264', encoder: 'VideoToolbox' } });
  assert.strictEqual(e.link.kind, 'direct');
  assert.deepStrictEqual([e.files.next, e.files.why], ['fx', 'peer']);
  assert.deepStrictEqual([e.input.proto, e.input.why], ['tdv1', 'peer']);
  assert.deepStrictEqual(e.screen, { codec: 'h264', encoder: 'VideoToolbox' });
}

// Bluetooth: file.chunk and TCP, both for that reason; an older app: no fast files at all.
{
  const fx = fxFor({ host: true, token: 'a'.repeat(32), transport: 'ble', address: '127.0.0.1' });
  const e = snapshot({ current: { transport: 'ble', address: '127.0.0.1' }, lane: null, il: {}, fx, fx2: null });
  assert.deepStrictEqual([e.link.kind, e.link.address], ['ble', '']);
  assert.deepStrictEqual([e.files.next, e.files.why], ['chunk', 'bluetooth']);
  assert.deepStrictEqual([e.input.proto, e.input.why], ['tdv1', 'bluetooth']);
  assert.strictEqual(e.engine, 'off');
  const old = fxFor(null);
  assert.deepStrictEqual([old.describe().next, old.describe().why], ['chunk', 'peer']);
}

// The last file's way: a chunk sent, then one received.
{
  const fx = fxFor({ host: true, token: 'a'.repeat(32), transport: 'ip', address: '10.0.0.2' });
  fx.sentChunk();
  assert.deepStrictEqual([fx.last.way, fx.last.dir], ['chunk', 'send']);
  fx.incoming({ t: 'file.chunk', id: 'x', seq: 0, data: '' });
  assert.deepStrictEqual([fx.last.way, fx.last.dir], ['chunk', 'recv']);
}

console.log('engines: ok');

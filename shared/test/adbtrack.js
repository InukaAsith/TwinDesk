// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/adbtrack.js: adb's host:track-devices feed — the request, OKAY, length-prefixed lists in
// pieces, a list that changes, and null (fall back to `adb devices`) once the server goes.
// Run with: node shared/test/adbtrack.js
'use strict';

const assert = require('assert');
const net = require('net');
const { AdbTrack, parse, request } = require('../adbtrack.js');

assert.strictEqual(request('host:track-devices').toString(), '0012host:track-devices');
assert.deepStrictEqual(parse('R5CT\tdevice\n192.168.1.5:5555\toffline\n'), [{ serial: 'R5CT', state: 'device' }, { serial: '192.168.1.5:5555', state: 'offline' }]);
assert.deepStrictEqual(parse(''), []);
// An mDNS serial with a space (a second announcement of the same phone) keeps its state.
assert.deepStrictEqual(parse('adb-1328-RCLpRo (2)._adb-tls-connect._tcp\tdevice\r\n'), [{ serial: 'adb-1328-RCLpRo (2)._adb-tls-connect._tcp', state: 'device' }]);
// `adb devices -l` style extras after the state are dropped.
assert.deepStrictEqual(parse('R5CT\tdevice product:x model:y\n'), [{ serial: 'R5CT', state: 'device' }]);

const frame = (s) => Buffer.from(s.length.toString(16).padStart(4, '0') + s);

(async () => {
  let client;
  const server = net.createServer((c) => { client = c; });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const t = new AdbTrack({ port: server.address().port });
  const changes = [];
  t.on('change', (l) => changes.push(l));
  t.ensure();
  await new Promise((r) => server.once('connection', () => setTimeout(r, 30)));
  const asked = await new Promise((r) => client.once('data', (d) => r(d.toString())));
  assert.strictEqual(asked, '0012host:track-devices');
  // OKAY and the first list split across writes.
  const first = Buffer.concat([Buffer.from('OKAY'), frame('R5CT\tunauthorized\n')]);
  client.write(first.subarray(0, 6));
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(t.list, null);
  client.write(first.subarray(6));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(t.list, [{ serial: 'R5CT', state: 'unauthorized' }]);
  // Allowed on the phone, then the same list again (no change event), then unplugged.
  client.write(Buffer.concat([frame('R5CT\tdevice\n'), frame('R5CT\tdevice\n'), frame('')]));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(t.list, []);
  assert.strictEqual(changes.length, 3);
  // ensure() while connected does nothing.
  t.ensure();
  // The server goes: null, so adb.devices() runs `adb devices` again.
  client.destroy();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(t.list, null);
  assert.strictEqual(changes[changes.length - 1], null);
  // A refused connection: still null, no throw.
  t.lastTry = 0;
  server.close();
  t.ensure();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(t.list, null);
  t.stop();
  console.log('adbtrack: ok');
})().catch((e) => { console.error(e); process.exit(1); });

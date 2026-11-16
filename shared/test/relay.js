// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Your own relay: relay/twindesk-relay.js with shared/relay.js's RelayHost, end to end on this
// machine. A phone-like client joins, its bytes reach the "session server" and the answer comes
// back; a wrong key and an absent computer are refused. Run with: node shared/test/relay.js
'use strict';

const assert = require('assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const R = require('../relay.js');

const PORT = 47000 + Math.floor(Math.random() * 900);
const KEY = 'test-key-123';

function client(id, key, send) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: PORT });
    let got = '';
    s.on('connect', () => s.write(`TDR1 join ${id} ${key}\n`));
    s.on('data', (d) => {
      got += d.toString();
      if (got.startsWith('ok\n') && send) { const x = send; send = null; s.write(x); }
      if (/echo:|^no\n|^key\n/.test(got)) { s.destroy(); resolve(got); }
    });
    s.on('close', () => resolve(got));
    s.on('error', () => resolve(got));
  });
}

(async () => {
  const relay = spawn(process.execPath, [path.join(__dirname, '../../relay/twindesk-relay.js'), '--port', String(PORT), '--host', '127.0.0.1', '--key', KEY], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => relay.stdout.once('data', r));
  try {
    assert.deepStrictEqual(R.parseAddr('relay.example.com'), { host: 'relay.example.com', port: 47100 });
    assert.deepStrictEqual(R.parseAddr('[::1]:5000'), { host: '::1', port: 5000 });
    assert.strictEqual(R.parseAddr('http://x'), null);
    const id = R.idOf('AB:CD');
    assert.match(id, /^[0-9a-f]{32}$/);

    // No computer yet: refused.
    assert.strictEqual(await client(id, KEY), 'no\n');

    const stub = net.createServer((s) => s.on('data', (d) => s.write(`echo:${d}`)));
    const host = new R.RelayHost({ server: { https: stub }, addr: `127.0.0.1:${PORT}`, key: KEY, id });
    const ready = new Promise((r) => host.on('state', (v) => v.state === 'ready' && r()));
    host.start();
    await ready;

    assert.strictEqual(await client(id, KEY, 'hello'), 'ok\necho:hello');
    assert.strictEqual(await client(id, 'wrong', 'x'), 'key\n');
    // Two at once, each to its own.
    const [a, b] = await Promise.all([client(id, KEY, 'one'), client(id, KEY, 'two')]);
    assert.deepStrictEqual([a, b], ['ok\necho:one', 'ok\necho:two']);

    // A computer with the wrong key never gets ready.
    const bad = new R.RelayHost({ server: { https: stub }, addr: `127.0.0.1:${PORT}`, key: 'nope', id: R.idOf('x') });
    const failed = new Promise((r) => bad.on('state', (v) => v.state === 'failed' && r(v.error)));
    bad.start();
    assert.strictEqual(await failed, 'The relay’s key is wrong');
    bad.stop();

    host.stop();
    stub.close();
    console.log('relay: ok');
  } finally {
    relay.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });

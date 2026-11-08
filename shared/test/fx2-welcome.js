// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The files engine starts on demand (shared/fx2.js), and its port goes in the host's welcome: each
// server.js (Mac, Windows, Linux) waits for it when it isn't up yet, sends no wait at all when it
// is, gives up on a socket that went meanwhile, and still welcomes (the fx way) when it can't start.
// Run with: node shared/test/fx2-welcome.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { Fx2 } = require('../fx2.js');

// A tree without every app's node_modules (linux/ here): ws from whichever app has it.
process.env.NODE_PATH = ['mac', 'windows', 'linux'].map((a) => path.join(__dirname, '..', '..', a, 'node_modules')).join(path.delimiter);
require('module').Module._initPaths();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx2w-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test',
  '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
const tls = { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };

// A server without its sockets: authenticate() alone, as pairing.js / hostpair.js call it.
function server(file, fx2) {
  const { Server } = require(file);
  const s = Object.create(Server.prototype);
  EventEmitter.call(s);
  Object.assign(s, { sockets: new Set(), current: null, fxOn: true, fx2Port: () => fx2.port, fx2Wait: (ms) => fx2.whenReady(ms) });
  return s;
}

function socket(s) {
  const sent = [];
  const ws = { OPEN: 1, readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
  const ctx = { ws, authed: false, address: '127.0.0.1', transport: 'ip', fxWanted: true, fx2Wanted: true };
  s.sockets.add(ctx);
  return { ctx, sent };
}

const welcome = { t: 'welcome', v: 1 };
const who = { deviceId: 'd1', name: 'Other', os: 'mac' };
const until = async (cond, what, ms = 5000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

(async () => {
  for (const file of ['../../mac/server.js', '../../windows/server.js', '../../linux/server.js']) {
    const name = file.split('/')[2];
    // Not running: the welcome waits for its port, then carries it.
    const fx2 = new Fx2({ tls, idleMs: 60000 });
    const s = server(file, fx2);
    const a = socket(s);
    const t0 = Date.now();
    s.authenticate(a.ctx, who, welcome);
    assert.strictEqual(a.sent.length, 0, `${name}: no welcome before the engine listens`);
    await until(() => a.sent.length === 1, `${name}: the welcome`);
    assert.ok(a.sent[0].fx2 && a.sent[0].fx2.port === fx2.port && fx2.port > 0, `${name}: welcome {fx2: {port}}`);
    assert.ok(a.sent[0].fx, `${name}: and fx`);
    assert.strictEqual(s.current, a.ctx);
    console.log(`  ${name}: welcome waited ${Date.now() - t0} ms for a cold engine`);

    // Running: no wait at all (the welcome goes in the same tick).
    s.current = null;
    const b = socket(s);
    s.authenticate(b.ctx, who, welcome);
    assert.strictEqual(b.sent.length, 1, `${name}: welcome at once while the engine is up`);
    assert.strictEqual(b.sent[0].fx2.port, fx2.port);

    // The socket went while it waited: no welcome, no session.
    fx2.close();
    const fx2b = new Fx2({ tls, idleMs: 60000 });
    const s2 = server(file, fx2b);
    const c = socket(s2);
    s2.authenticate(c.ctx, who, welcome);
    c.ctx.ws.readyState = 3;
    await fx2b.whenReady(5000);
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(c.sent.length, 0, `${name}: nothing to a closed socket`);
    assert.strictEqual(s2.current, null);
    fx2b.close();

    // It can't start (it failed for good): the welcome goes without fx2, files go the fx way.
    const fx2c = new Fx2({ tls, idleMs: 60000 });
    fx2c.dead = true;
    const s3 = server(file, fx2c);
    const d = socket(s3);
    s3.authenticate(d.ctx, who, welcome);
    await until(() => d.sent.length === 1, `${name}: the welcome without fx2`);
    assert.ok(!d.sent[0].fx2 && d.sent[0].fx, `${name}: fx, no fx2`);

    // An app that didn't ask for fx2 (an older one, a phone): never waits.
    const fx2d = new Fx2({ tls, idleMs: 60000 });
    const s4 = server(file, fx2d);
    const e = socket(s4);
    e.ctx.fx2Wanted = false;
    s4.authenticate(e.ctx, who, welcome);
    assert.strictEqual(e.sent.length, 1, `${name}: no wait without fx2 in its hello`);
    assert.strictEqual(fx2d.state, 'stopped', `${name}: nor a start`);
    fx2d.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('fx2-welcome: ok');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

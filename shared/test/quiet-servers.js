// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Quiet links (shared/quiet.js, #143) in each session server (Mac, Windows, Linux): an older client
// that never says `idle` is pinged every second as before; a new one that is idle goes quiet (no pings
// but the safety one), input shared brings the second pings back, a message out while quiet gets a
// probe and a dead socket is closed, and coming out of quiet doesn't trip the 8 s limit at once.
// Run with: node shared/test/quiet-servers.js
'use strict';

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');

process.env.NODE_PATH = ['mac', 'windows', 'linux'].map((a) => path.join(__dirname, '..', '..', a, 'node_modules')).join(path.delimiter);
require('module').Module._initPaths();

const P = require('../protocol.js');
const Q = require('../quiet.js');

const realNow = Date.now;
let clock = 1_700_000_000_000;
Date.now = () => clock;

function server(file) {
  const { Server } = require(file);
  const s = Object.create(Server.prototype);
  EventEmitter.call(s);
  Object.assign(s, { sockets: new Set(), current: null, blePorts: new Map(), closed: false });
  return s;
}

function client(s) {
  const sent = [];
  const ws = { OPEN: 1, readyState: 1, transport: 'ip', address: '10.0.0.2', lastRx: clock, send: (m) => sent.push(JSON.parse(m)), terminated: false };
  ws.terminate = () => { ws.terminated = true; ws.readyState = 3; };
  const ctx = { ws, alt: null, authed: true, deviceId: 'd1', name: 'Phone', address: '10.0.0.2', transport: 'ip', lastRx: clock, connectedAt: clock };
  ws.ctx = ctx;
  ws.sent = sent;
  s.sockets.add(ctx);
  s.current = ctx;
  const c = { ctx, ws, sent, dead: false };
  ctx.client = c;
  return c;
}

// A message from the client, as the socket hands it over.
const from = (s, c, msg) => s._onMessage(c.ctx, Buffer.from(JSON.stringify(msg)), false, c.ws);
const pings = (c) => c.sent.filter((m) => m.t === 'ping').length;
// A second goes by. A live client answers each ping (as it would); a dead one (c.dead) doesn't.
const second = (s, n = 1) => {
  for (let i = 0; i < n; i++) {
    clock += P.PING_MS;
    for (const ctx of [...s.sockets]) ctx.ws.seen = ctx.ws.sent ? ctx.ws.sent.length : 0;
    s._liveness();
    for (const ctx of [...s.sockets]) {
      const c = ctx.client;
      if (!c || c.dead || c.ws.terminated) continue;
      const fresh = c.sent.slice(c.ws.seen || 0);
      if (fresh.some((m) => m.t === 'ping')) from(s, c, { t: 'pong', ts: 1 });
    }
  }
};

try {
  for (const file of ['../../mac/server.js', '../../windows/server.js', '../../linux/server.js']) {
    const name = file.split('/')[2];

    // An older client: never says idle, pinged every second for good (as before).
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      second(s, 120);
      assert.equal(pings(c), 120, `${name}: an older client is pinged every second`);
      assert.equal(c.ws.terminated, false);
      assert.deepEqual(c.sent.filter((m) => m.t === 'idle'), [{ t: 'idle', on: true }], `${name}: said idle once (ignored there)`);
    }

    // Both idle: quiet. No second pings; the safety ping; closed after a long silence.
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      from(s, c, { t: 'idle', on: true });
      second(s, Q.ACTIVE_MS / P.PING_MS + 1);
      const before = pings(c);
      second(s, 60);
      assert.equal(pings(c), before, `${name}: no pings for a minute while quiet`);
      assert.equal(c.ws.terminated, false, `${name}: a minute's silence is fine while quiet`);
      c.dead = true; // from here on, nothing answers
      second(s, 5 * 60);
      assert.ok(pings(c) >= before + 1, `${name}: the safety ping`);
      assert.equal(c.ws.terminated, false);
      second(s, 7 * 60);
      assert.equal(c.ws.terminated, true, `${name}: silent past the quiet limit: closed`);
    }

    // Input shared (a hold): second pings again, and the old silence doesn't close it at once.
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      from(s, c, { t: 'idle', on: true });
      second(s, 4 * 60); // quiet, nothing heard for minutes (no pings to answer)
      Q.hold('kvm', true);
      const before = pings(c);
      second(s, 3);
      assert.equal(c.ws.terminated, false, `${name}: leaving quiet doesn't trip the 8 s limit`);
      assert.ok(pings(c) >= before + 3, `${name}: pinged every second while input is shared`);
      assert.deepEqual(c.sent.filter((m) => m.t === 'idle').pop(), { t: 'idle', on: false }, `${name}: the client hears busy`);
      c.dead = true;
      second(s, 10); // no answers at all now
      assert.equal(c.ws.terminated, true, `${name}: a dead socket is found within the 8 s limit again`);
      Q.hold('kvm', false);
    }

    // A message out while quiet: one probe; no answer, closed (and the client comes back).
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      from(s, c, { t: 'idle', on: true });
      second(s, 60);
      const before = pings(c);
      c.dead = true;
      s.send(c.ctx, { t: 'clip.text', text: 'hi' });
      second(s);
      assert.equal(pings(c), before + 1, `${name}: a probe after a message out`);
      second(s, 8);
      assert.equal(c.ws.terminated, true, `${name}: no answer to the probe: closed`);
    }

    // … answered: still quiet, no more pings.
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      from(s, c, { t: 'idle', on: true });
      second(s, 60);
      s.send(c.ctx, { t: 'clip.text', text: 'hi' });
      second(s); // the probe, answered
      const before = pings(c);
      second(s, 60);
      assert.equal(pings(c), before, `${name}: answered: quiet again`);
      assert.equal(c.ws.terminated, false);
    }

    // Messages coming in don't end the quiet (a battery level going by is one message, not a burst).
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      from(s, c, { t: 'idle', on: true });
      second(s, 60);
      const before = pings(c);
      for (let i = 0; i < 10; i++) { from(s, c, { t: 'phone.battery', level: 50 - i }); second(s, 20); } // within the safety ping's 5 min
      assert.equal(pings(c), before, `${name}: messages in: still quiet`);
    }

    // Prioritize performance over battery life: every second, as before.
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      const settings = { app: { keepPinging: true } };
      Q.use(() => settings.app.keepPinging);
      from(s, c, { t: 'idle', on: true });
      second(s, 120);
      assert.ok(pings(c) >= 119, `${name}: Prioritize performance: pinged every second`);
      assert.equal(c.sent.filter((m) => m.t === 'idle').length, 0, `${name}: never says idle`);
    }

    // Through Bluetooth: never quiet (its own limits, as before).
    Q._reset();
    {
      const s = server(file);
      const c = client(s);
      c.ws.transport = 'ble';
      from(s, c, { t: 'idle', on: true });
      second(s, 60);
      assert.equal(pings(c), 60, `${name}: Bluetooth: pinged every second`);
    }
    console.log(`  ${name}: ok`);
  }
  console.log('quiet-servers: ok');
} finally {
  Date.now = realNow;
  Q._reset();
}

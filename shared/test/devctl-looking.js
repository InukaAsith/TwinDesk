// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/devctl.js Looking: a computer reads its own volume, Bluetooth… (PowerShell on Windows) every
// minute only while the other side looks at its controls; with an older peer or a phone, as before.
// Run with: node shared/test/devctl-looking.js
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');

// Fake timers: setInterval's tick is called by hand.
const { DevCtl } = require('../devctl.js');

function side({ watching = null } = {}) {
  const ev = new EventEmitter();
  const sent = [];
  let reads = 0;
  const link = { on: (e, fn) => ev.on(e, fn), send: (m) => sent.push(m), current: { os: 'mac', deviceId: 'x' } };
  const local = { can: () => ({ volume: true }), state: async () => { reads++; return { volume: 0.5, ringing: false }; }, stop() {} };
  const realSet = global.setInterval;
  let t = null;
  global.setInterval = (fn) => { t = fn; return 0; };
  const d = new DevCtl({ link, local, version: '3.2.2', watching });
  global.setInterval = realSet;
  return { d, ev, sent, reads: () => reads, tick: t };
}
const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  // An older peer (no asks): every minute, as before.
  {
    const s = side();
    s.ev.emit('welcome'); await flush();
    s.ev.emit('dev.state', { can: {} }); await flush();
    const before = s.reads();
    s.tick(); await flush(); s.tick(); await flush();
    assert.strictEqual(s.reads(), before + 2, 'old peer: polled every minute');
    assert.ok(!('asks' in s.sent[0]), 'no watching(): never says asks');
  }
  // A peer that asks, not looking: no reads at all after the start.
  {
    const s = side({ watching: () => false });
    s.ev.emit('welcome'); await flush();
    assert.strictEqual(s.sent[0].asks, 1);
    s.ev.emit('dev.state', { can: {}, asks: 1 }); await flush();
    const before = s.reads();
    for (let i = 0; i < 5; i++) { s.tick(); await flush(); }
    assert.strictEqual(s.reads(), before, 'peer asks and isn’t looking: no reads');
    // It looks: an ask arrives — a fresh read and send at once, then minute reads for a while.
    s.ev.emit('dev.state', { can: {}, asks: 1, ask: true }); await flush();
    assert.strictEqual(s.reads(), before + 1);
    s.tick(); await flush();
    assert.strictEqual(s.reads(), before + 2, 'asked recently: polls');
  }
  // This side looks: it asks at once (look()) and on each tick, without reading its own state.
  {
    let shown = true;
    const s = side({ watching: () => shown });
    s.ev.emit('welcome'); await flush();
    s.ev.emit('dev.state', { can: {}, asks: 1 }); await flush();
    const reads = s.reads();
    const n = s.sent.length;
    s.d.look(); await flush();
    assert.strictEqual(s.sent.length, n + 1);
    assert.strictEqual(s.sent[n].ask, true);
    assert.strictEqual(s.sent[n].volume, 0.5, 'the last state, as sent');
    assert.strictEqual(s.reads(), reads, 'asking reads nothing here');
    s.tick(); await flush();
    assert.strictEqual(s.sent[s.sent.length - 1].ask, true, 'asks every minute while shown');
    shown = false;
    const m = s.sent.length;
    s.tick(); await flush();
    s.d.look(); await flush();
    assert.strictEqual(s.sent.length, m, 'hidden: no asks');
  }
  console.log('devctl-looking: ok');
})().catch((e) => { console.error(e); process.exit(1); });

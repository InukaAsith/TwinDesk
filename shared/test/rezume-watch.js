// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume (shared/rezume.js) with a watch (the Mac's frontWatch): it looks when told of a change, at
// most every POLL_MS, and again once what it saw is stable, so the offer comes as with the poll; the
// slow safety tick instead of the poll; the poll again when the watch can't (no Accessibility).
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { ReZume, normalize } = require('../rezume.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function side(watchOk) {
  const bus = new EventEmitter();
  bus.up = true;
  bus.on('closed', () => { bus.up = false; });
  const sent = [];
  const link = {
    on: (t, fn) => bus.on(t, fn),
    send: (m) => { sent.push(m); return true; },
    peer: () => (bus.up ? { os: 'win', name: 'PC' } : null),
    welcome: (fn) => bus.on('welcome', fn),
    closed: (fn) => bus.on('closed', fn),
  };
  const cfg = normalize({ on: true });
  let looks = 0;
  const w = { fn: null, stopped: 0 };
  const h = new ReZume({
    link, cfg: () => cfg,
    detect: async () => { looks++; return h.now; },
    open: { url() {}, file() {}, phoneApp() {} },
    watch: { start: async (fn) => { w.fn = fn; return watchOk; }, stop: () => { w.stopped++; w.fn = null; } },
  });
  h.now = null;
  return { h, bus, sent, w, looks: () => looks };
}

(async () => {
  {
    const s = side(true);
    s.bus.emit('welcome');
    s.bus.emit('rz.policy', { on: true, web: true, docs: true, apps: true });
    await wait(20);
    assert.ok(s.h.timer, 'the safety tick runs');
    assert.strictEqual(s.h.timer._idleTimeout, 15000, 'every 15 s, not every 1.5 s');
    const before = s.looks();
    s.h.now = { kind: 'web', url: 'https://example.com/', title: 'Example', app: 'chrome', appName: 'Chrome' };
    s.w.fn(); // the tab changed
    await wait(1600); // at most every POLL_MS
    assert.ok(s.looks() > before, 'it looked after the change');
    assert.ok(!s.sent.some((m) => m.t === 'rz.offer'), 'not offered at once');
    await wait(2700); // stable: it looks again by itself and offers
    assert.ok(s.sent.some((m) => m.t === 'rz.offer' && m.url === 'https://example.com/'), 'offered once stable, without a poll');
    s.bus.emit('closed');
    assert.strictEqual(s.w.stopped, 1, 'the watch stops with the session');
    assert.strictEqual(s.h.timer, null);
  }
  {
    const s = side(false); // no Accessibility: the poll as always
    s.bus.emit('welcome');
    s.bus.emit('rz.policy', { on: true, web: true });
    await wait(20);
    assert.strictEqual(s.h.timer._idleTimeout, 1500);
    s.bus.emit('closed');
  }
  console.log('rezume-watch: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

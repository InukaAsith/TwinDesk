// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const P = require('../protocol.js');
const { ProximityLock } = require('../proximity-lock.js');

const phone = (deviceId = 'phone') => ({ deviceId, os: P.OS.ANDROID, authed: true });
const fresh = (f, ctx = phone()) => { f.lock.connected(ctx); return ctx; };
const drop = (f, ctx = fresh(f)) => f.lock.disconnected(ctx, true);

function fixture(options = {}) {
  const f = { enabled: true, available: true, opens: 0, hides: 0, locks: [], ticks: [] };
  let now = 0, timer = null;
  f.lock = new ProximityLock({
    ...(options.defaultOff ? {} : { enabled: () => f.enabled }),
    canLock: () => f.available,
    now: () => now,
    setTimer(fn, ms) { return timer = { at: now + ms, fn }; },
    clearTimer(t) { if (timer === t) timer = null; },
    prompt: {
      show(prompt) {
        assert.equal(prompt.seconds, 15);
        f.opens++;
        f.prompt = prompt;
        if (!options.deferPrompt) prompt.ready();
      },
      update(seconds) { f.ticks.push(seconds); },
      hide() { f.hides++; },
    },
    lock: () => f.locks.push(now),
  });
  f.advance = (ms) => {
    const until = now + ms;
    while (timer && timer.at <= until) {
      const { at, fn } = timer;
      timer = null;
      now = at;
      fn();
    }
    now = until;
  };
  return f;
}

test('an unexpected authenticated loss gives the visible prompt 15 seconds and locks once', () => {
  const f = fixture({ deferPrompt: true });
  const old = fresh(f);
  drop(f, old);
  assert.equal(f.opens, 1);
  f.advance(5000);
  assert.deepEqual(f.ticks, [], 'a slow renderer cannot run down the countdown');
  f.prompt.ready();
  f.advance(14999);
  assert.deepEqual(f.ticks, Array.from({ length: 15 }, (_, i) => 15 - i));
  assert.deepEqual(f.locks, []);
  f.advance(1);
  assert.deepEqual(f.locks, [20000]);
  assert.equal(f.hides, 1);
  drop(f, old);
  f.advance(30000);
  assert.deepEqual(f.locks, [20000], 'repeated closes cannot lock again');
});

test('cancellation consumes the attempt and only a fresh authenticated phone can rearm', async (t) => {
  await t.test('opt-in defaults off and enabling cannot act on the previous drop', () => {
    const f = fixture({ defaultOff: true });
    drop(f);
    f.advance(15000);
    assert.equal(f.opens, 0);

    const g = fixture();
    g.enabled = false;
    const ctx = fresh(g);
    drop(g, ctx);
    g.enabled = true;
    drop(g, ctx);
    assert.equal(g.opens, 0);
  });

  for (const [name, cancel] of [
    ['Cancel or Escape', (f) => f.prompt.cancel()],
    ['paired phone reconnects', (f) => fresh(f)],
    ['Forget', (f) => f.lock.forget('phone')],
    ['manual disconnect', (f) => f.lock.cancel()],
    ['setting switched off', (f) => { f.enabled = false; f.lock.cancel(); }],
    ['suspend', (f) => f.lock.reset()],
    ['lock-screen', (f) => f.lock.reset()],
    ['unlock-screen', (f) => f.lock.reset()],
    ['quit or mode switch', (f) => f.lock.shutdown()],
  ]) {
    await t.test(name, () => {
      const f = fixture();
      const old = fresh(f);
      drop(f, old);
      f.advance(8000);
      cancel(f);
      assert.equal(f.hides, 1, 'prompt is dismissed immediately');
      drop(f, old);
      f.advance(30000);
      assert.equal(f.opens, 1);
      assert.deepEqual(f.locks, []);
    });
  }

  await t.test('stale prompts, connections and closes cannot cancel or rearm a fresh attempt', () => {
    const f = fixture({ deferPrompt: true });
    const old = fresh(f);
    drop(f, old);
    const oldPrompt = f.prompt;
    oldPrompt.cancel();
    const replacement = fresh(f);
    drop(f, old);
    assert.equal(f.opens, 1);
    drop(f, replacement);
    oldPrompt.ready();
    oldPrompt.cancel();
    f.advance(20000);
    assert.deepEqual(f.locks, []);
    f.prompt.ready();
    f.advance(15000);
    assert.deepEqual(f.locks, [35000]);
  });

  await t.test('only unreleased phone sessions qualify and a second phone prevents a prompt', () => {
    const f = fixture();
    for (const ctx of [{ ...phone(), authed: false }, { ...phone(), authed: undefined }, { ...phone(), os: P.OS.WIN }, { ...phone(), os: P.OS.MAC }]) {
      fresh(f, ctx);
      drop(f, ctx);
    }
    const released = fresh(f);
    released.released = true;
    drop(f, released);
    const expected = fresh(f);
    f.lock.disconnected(expected, false);
    const stale = fresh(f);
    f.lock.reset();
    drop(f, stale); // a close delivered after a suspend, lock or unlock
    const forgot = fresh(f);
    f.lock.forget(forgot.deviceId);
    drop(f, forgot);
    const preReplacement = fresh(f);
    const replacement = fresh(f);
    drop(f, preReplacement);
    const other = fresh(f, { ...phone('second'), os: P.OS.IOS });
    drop(f, replacement);
    assert.equal(f.opens, 0);
    drop(f, other);
    assert.equal(f.opens, 1);
  });

  await t.test('guards are checked at start and again at expiry', () => {
    const f = fixture();
    f.available = false; // locked/asleep or another session already present
    drop(f);
    assert.equal(f.opens, 0);
    f.available = true;
    drop(f);
    f.advance(14999);
    f.available = false;
    f.advance(1);
    assert.equal(f.hides, 1);
    assert.deepEqual(f.locks, []);
  });
});

for (const [mode, file] of [['one-to-one', '../../mac/server'], ['Multi-device', '../../mac/mesh/server']]) {
  test(`${mode} server classifies real close events, BYE, Forget, replacement and transport fallback`, () => {
    const { Server } = require(file);
    const server = Object.setPrototypeOf(new EventEmitter(), Server.prototype);
    Object.assign(server, {
      sockets: new Set(), blePorts: new Map(), _arm() {}, _now: Date.now, _phoneGrace() {},
      ...(mode === 'one-to-one' ? { current: null } : { clients: new Map(), authSeq: 0, ilPool: { drop() {} } }),
    });
    const f = fixture();
    server.on('client', (ctx) => f.lock.connected(ctx));
    server.on('closed', (ctx, unexpected) => f.lock.disconnected(ctx, unexpected));
    server.on('forget', (id) => f.lock.forget(id));
    const socket = () => {
      const ws = Object.assign(new EventEmitter(), {
        OPEN: 1, readyState: 1, send() {}, close() { this.readyState = 3; }, terminate() { this.close(); },
      });
      server._onConnection(ws, { socket: { remoteAddress: '127.0.0.1', remotePort: 0 } });
      return ws;
    };
    const hello = () => {
      const ws = socket();
      server.authenticate(ws.ctx, { deviceId: 'phone', os: P.OS.ANDROID, name: 'Phone' }, {});
      return ws;
    };
    const close = (ws, code = 1006) => { ws.close(); ws.emit('close', code); };

    close(socket()); // unauthenticated
    close(hello(), 1000); // graceful closure without BYE
    const bye = hello();
    bye.emit('message', Buffer.from('{"t":"bye"}'), false);
    close(bye); // ungraceful close after a deliberate BYE
    const released = hello();
    server.release();
    close(released);
    const refused = hello();
    server.fail(refused.ctx, P.E.BAD_MESSAGE, 'protocol failure');
    close(refused);
    const forgotten = hello();
    server.closeDevice('phone', P.E.BAD_TOKEN, 'forgotten');
    close(forgotten);
    const previous = hello();
    const attached = hello();
    close(previous);
    const fallback = socket();
    server._resume(fallback.ctx, { id: 'phone', resume: attached.ctx.resumeKey });
    close(attached); // closing the old path of a successful resume
    assert.equal(f.opens, 0);
    close(fallback); // genuine loss of the very same authenticated session
    assert.equal(f.opens, 1);
    server.closeDevice('phone', P.E.BAD_TOKEN, 'forgotten while disconnected');
    assert.equal(f.hides, 1);
    f.advance(15000);
    assert.deepEqual(f.locks, []);
  });
}

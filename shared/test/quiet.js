// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Quiet links (shared/quiet.js, #143): an idle session stops pinging every second only when both ends
// say idle; an older app keeps today's pings; anything live makes it active at once, its silence limit
// counted from then; holds, the partner flag and Keep pinging keep it active.
'use strict';

const assert = require('assert');
const Q = require('../quiet.js');

const realNow = Date.now;
let clock = 1_000_000_000_000;
Date.now = () => clock;

function sock() {
  const out = [];
  const ws = { out };
  ws.raw = (m) => out.push(m);
  return ws;
}
const run = (ws, rx, busy) => Q.tick(ws, clock, rx, ws.raw, busy);

try {
  // An older app never says idle: never quiet, whatever the time. We say idle once (it ignores it).
  Q._reset();
  {
    const ws = sock();
    let r = run(ws, clock);
    assert.equal(r.quiet, false);
    assert.equal(ws.out.length, 0, 'nothing said while busy (the default an older app assumes)');
    clock += Q.ACTIVE_MS;
    r = run(ws, clock - 500);
    assert.equal(r.quiet, false);
    assert.deepEqual(ws.out, [{ t: 'idle', on: true }]);
    clock += 60 * 60 * 1000;
    r = run(ws, clock - 500);
    assert.equal(r.quiet, false, 'an older peer: never quiet');
    assert.equal(ws.out.length, 1, 'said once, not every tick');
  }

  // Both idle: quiet; a ping every QUIET_PING_MS, closed after QUIET_TIMEOUT_MS of silence.
  Q._reset();
  {
    const ws = sock();
    run(ws, clock);
    assert.equal(Q.seen(ws, { t: 'idle', on: true }), true, '`idle` is consumed');
    clock += Q.ACTIVE_MS;
    const quietAt = clock;
    let r = run(ws, clock);
    assert.equal(r.quiet, true);
    assert.equal(r.ping, false);
    clock += Q.QUIET_PING_MS - 1000;
    r = run(ws, quietAt);
    assert.equal(r.ping, false, 'no ping before the interval');
    clock += 1000;
    r = run(ws, quietAt);
    assert.equal(r.ping, true, 'the safety ping');
    r = run(ws, quietAt);
    assert.equal(r.ping, false, 'once per interval');
    assert.equal(r.dead, false, 'minutes of silence are fine while quiet');
    clock = quietAt + Q.QUIET_TIMEOUT_MS + 1;
    r = run(ws, quietAt);
    assert.equal(r.dead, true, 'gone for good: closed');
  }

  // Messages don't wake the link (a battery level going by costs one message, not a burst of pings).
  // One sent while quiet is followed by a probe: answered, still quiet; unanswered, closed.
  Q._reset();
  {
    const ws = sock();
    run(ws, clock);
    Q.seen(ws, { t: 'idle', on: true });
    clock += Q.ACTIVE_MS;
    let heard = clock;
    assert.equal(run(ws, heard).quiet, true);
    clock += 60 * 1000;
    Q.seen(ws, { t: 'dev.state', vol: 3 });
    assert.equal(run(ws, heard).quiet, true, 'a message in: still quiet');
    Q.sent(ws, { t: 'clip.text', text: 'x' });
    let r = run(ws, heard);
    assert.equal(r.quiet, true, 'a message out: still quiet');
    assert.equal(r.ping, true, '… with a probe');
    Q.sent(ws, { t: 'clip.text', text: 'y' });
    r = run(ws, heard);
    assert.equal(r.ping, false, 'one probe at a time');
    clock += 300;
    heard = clock; // the pong
    r = run(ws, heard);
    assert.equal(r.dead, false);
    clock += Q.PROBE_MS + 1;
    assert.equal(run(ws, heard).dead, false, 'answered: alive');
    // unanswered
    Q.sent(ws, { t: 'clip.text', text: 'z' });
    assert.equal(run(ws, heard).ping, true);
    clock += Q.PROBE_MS - 1;
    assert.equal(run(ws, heard).dead, false);
    clock += 2;
    assert.equal(run(ws, heard).dead, true, 'no answer to the probe: closed (and reconnects)');
  }

  // Leaving quiet: the silence limit counts from then, not from the last ping minutes ago.
  Q._reset();
  {
    const ws = sock();
    run(ws, clock);
    Q.seen(ws, { t: 'idle', on: true });
    clock += Q.ACTIVE_MS;
    const heard = clock;
    assert.equal(run(ws, heard).quiet, true);
    clock += 4 * 60 * 1000;
    Q.seen(ws, { t: 'idle', on: false });
    const r = run(ws, heard);
    assert.equal(r.quiet, false, 'the other end busy: not quiet here either');
    assert.equal(r.rx, clock, 'rx raised past the quiet spell: no instant timeout');
    assert.equal(Q.seen(ws, { t: 'ping', ts: 1 }), false);
  }

  // Holds (input shared, files moving), the partner flag and Keep pinging keep it active.
  Q._reset();
  {
    const ws = sock();
    run(ws, clock);
    Q.seen(ws, { t: 'idle', on: true });
    clock += Q.ACTIVE_MS;
    assert.equal(run(ws, clock).quiet, true);
    let changes = 0;
    Q.onChange(() => changes++);
    Q.hold('kvm', true);
    assert.equal(changes, 1, 'the timers hear of a hold at once');
    assert.equal(run(ws, clock).quiet, false);
    Q.hold('kvm', true);
    assert.equal(changes, 1, 'the same hold twice: one change');
    Q.hold('kvm', false);
    clock += 1;
    assert.equal(run(ws, clock).quiet, true);
    assert.equal(run(ws, clock, true).quiet, false, 'the input partner\'s link (multi-device)');
    Q.setKeep(true);
    assert.equal(run(ws, clock).quiet, false, 'General › Advanced › Keep pinging');
    Q.setKeep(false);
    assert.equal(run(ws, clock).quiet, true);
    Q.wake();
    assert.equal(run(ws, clock).quiet, false, 'woke: active for a while, so a dead link is found');
    clock += Q.ACTIVE_MS;
    assert.equal(run(ws, clock).quiet, true);
  }

  // use(): the app's settings, read live; a throwing getter keeps pinging (the safe side).
  Q._reset();
  {
    const settings = { app: { keepPinging: false } };
    Q.use(() => settings.app.keepPinging === true);
    assert.equal(Q.keep(), false);
    settings.app.keepPinging = true;
    assert.equal(Q.keep(), true, 'a change applies on the next tick');
    Q.use(() => { throw new Error('not loaded'); });
    assert.equal(Q.keep(), true);
  }

  console.log('quiet: ok');
} finally {
  Date.now = realNow;
  Q._reset();
}

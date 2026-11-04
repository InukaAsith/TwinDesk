// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tests for shared/kvm-moves.js: moves summed per turn, held while backed up, flushed before a click.
// Run with: node shared/test/kvm-moves.js
'use strict';

const assert = require('assert');
const { KvmMoves } = require('../kvm-moves.js');

const turn = () => new Promise((r) => setImmediate(r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // One message per turn, summed.
  {
    const out = [];
    const m = new KvmMoves({ send: (x) => out.push({ ...x }) });
    m.add(1, 2);
    m.add(3, 4);
    assert.deepStrictEqual(out, [], 'not before the turn ends');
    await turn();
    assert.deepStrictEqual(out, [{ dx: 4, dy: 6 }]);
    m.add(1, 1);
    await turn();
    assert.strictEqual(out.length, 2, 'the next turn: the next message');
  }

  // flush: at once (a click goes after the moves before it); drop: forgotten.
  {
    const out = [];
    const m = new KvmMoves({ send: (x) => out.push({ ...x }) });
    m.add(5, 0);
    m.flush();
    assert.deepStrictEqual(out, [{ dx: 5, dy: 0 }]);
    await turn();
    assert.strictEqual(out.length, 1, 'nothing left to send');
    m.add(7, 0);
    m.drop();
    await turn();
    assert.strictEqual(out.length, 1, 'dropped');
  }

  // Backed up: summed while it is, then one message once there's room.
  {
    const out = [];
    let backlog = 100000;
    const m = new KvmMoves({ send: (x) => out.push({ ...x }), backlog: () => backlog, limit: () => 16384, maxWait: () => 1000 });
    for (let i = 0; i < 50; i++) {
      m.add(1, 0);
      await wait(1);
    }
    assert.deepStrictEqual(out, [], 'held while backed up');
    backlog = 0;
    await wait(10);
    assert.deepStrictEqual(out, [{ dx: 50, dy: 0 }], 'one message with all of it');
  }

  // Backed up for good: one goes every maxWait, so the pointer still moves.
  {
    const out = [];
    const m = new KvmMoves({ send: (x) => out.push({ ...x }), backlog: () => 1e6, limit: () => 16384, maxWait: () => 16 });
    const end = Date.now() + 200;
    let added = 0; // Windows' timers tick every ~15.6 ms, so how many went in depends on the OS
    while (Date.now() < end) {
      m.add(1, 0);
      added++;
      await wait(1);
    }
    await wait(30);
    assert.ok(out.length >= 4 && out.length <= 16, `about one per 16 ms (${out.length})`); // 4: a 16 ms timer is two of Windows ~15.6 ms ticks
    assert.strictEqual(out.reduce((s, x) => s + x.dx, 0), added, 'nothing lost');
  }

  // Through Bluetooth: every delay ms, and held (no maxWait) while the radio is behind.
  {
    const out = [];
    let backlog = 0;
    const m = new KvmMoves({ send: (x) => out.push({ ...x }), delay: () => 16, backlog: () => backlog, limit: () => 512 });
    m.add(1, 0);
    await turn();
    assert.strictEqual(out.length, 0, 'waits the delay');
    await wait(25);
    assert.strictEqual(out.length, 1);
    backlog = 1000;
    m.add(1, 0);
    await wait(80);
    assert.strictEqual(out.length, 1, 'held while the radio is behind');
    backlog = 0;
    await wait(25);
    assert.strictEqual(out.length, 2);
  }

  console.log('kvm-moves: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

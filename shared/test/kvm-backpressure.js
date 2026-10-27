// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// KVM socket backpressure & memory resilience tests.
// Run with: node shared/test/kvm-backpressure.js
'use strict';

const assert = require('assert');
const P = require('../protocol.js');
const { KvmMoves } = require('../kvm-moves.js');

// 1. Verify protocol timeout & backpressure limits for low-RAM resilience
assert.strictEqual(P.TIMEOUT_MS, 12000, 'TIMEOUT_MS extended to 12s for GC/swap resilience');
assert.strictEqual(P.KVM_SILENCE_MS, 6000, 'KVM_SILENCE_MS extended to 6s for GC/swap resilience');
assert.strictEqual(P.KVM_IP_BACKLOG, 64 * 1024, 'KVM_IP_BACKLOG set to 64KB');
assert.strictEqual(P.KVM_MAX_BACKLOG, 64 * 1024, 'KVM_MAX_BACKLOG matches KVM_IP_BACKLOG');

// 2. Motion coalescing under simulated socket backpressure using KvmMoves
async function runTests() {
  // Scenario A: Under normal network conditions (no backpressure), moves sum and send on turn end
  {
    const sent = [];
    let backlog = 1024; // 1 KB < 64 KB threshold
    const moves = new KvmMoves({
      send: (m) => sent.push(m),
      backlog: () => backlog,
      limit: () => P.KVM_IP_BACKLOG,
      maxWait: () => P.KVM_MOVE_MAX_WAIT_MS,
    });

    moves.add(5, 10);
    assert.strictEqual(sent.length, 0, 'queued before next turn');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(sent.length, 1, 'flushed on next turn');
    assert.deepStrictEqual(sent[0], { dx: 5, dy: 10 });
  }

  // Scenario B: Under memory pressure / socket congestion (backlog > 64KB)
  {
    const sent = [];
    let backlog = 128 * 1024; // 128 KB > 64 KB threshold
    const moves = new KvmMoves({
      send: (m) => sent.push(m),
      backlog: () => backlog,
      limit: () => P.KVM_IP_BACKLOG,
      maxWait: () => 1000,
    });

    // Send rapid mouse moves
    moves.add(2, 3);
    moves.add(4, 5);
    moves.add(-1, 2);

    await new Promise((r) => setImmediate(r));
    assert.strictEqual(sent.length, 0, 'held and not flushed while socket backlog is high');

    // More moves arrive while backpressure continues
    moves.add(10, -5);
    assert.strictEqual(sent.length, 0, 'still held');

    // Remote machine finishes GC/swap, socket drains below threshold
    backlog = 4096;
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(sent.length, 1, 'single coalesced packet sent once socket drained');
    assert.deepStrictEqual(sent[0], { dx: 15, dy: 5 });
  }

  // Scenario C: Flush before non-move events (clicks/keys)
  {
    const sent = [];
    let backlog = 128 * 1024; // Backed up
    const moves = new KvmMoves({
      send: (m) => sent.push(m),
      backlog: () => backlog,
      limit: () => P.KVM_IP_BACKLOG,
      maxWait: () => 1000,
    });

    moves.add(8, 12);
    moves.flush(); // Click event flushes pending moves first
    assert.strictEqual(sent.length, 1, 'flushed immediately before click');
    assert.deepStrictEqual(sent[0], { dx: 8, dy: 12 });
  }

  console.log('kvm-backpressure: passed');
}

runTests();

// Tests for shared/kvm-edges.js: which device each screen edge leads to.
// Run with: node shared/test/kvm-edges.js
'use strict';

const assert = require('assert');
const E = require('../kvm-edges.js');

const none = { left: null, right: null, top: null, bottom: null };

// normalizeEdges: any value becomes one id or null per side.
{
  assert.deepStrictEqual(E.normalizeEdges(undefined), none, 'undefined: all null');
  assert.deepStrictEqual(E.normalizeEdges('x'), none, 'a string: all null');
  assert.deepStrictEqual(E.normalizeEdges({ top: 'B', bottom: 'C', left: 5, middle: 'Y' }), { ...none, top: 'B', bottom: 'C' },
    'bad ids and unknown sides are dropped');
  assert.deepStrictEqual(E.normalizeEdges({ top: 'B', left: 'B' }), { ...none, left: 'B' }, 'one device on one side only (first in SIDES order: left)');
  assert.deepStrictEqual(E.normalizeEdges({ top: 'x'.repeat(65) }), none, 'an id longer than 64 is dropped');
  assert.deepStrictEqual(E.normalizeEdges({ top: '' }), none, 'an empty id is dropped');
}

// edgeForPeer
{
  const edges = { ...none, top: 'B', right: 'C' };
  assert.strictEqual(E.edgeForPeer(edges, 'B'), 'top');
  assert.strictEqual(E.edgeForPeer(edges, 'C'), 'right');
  assert.strictEqual(E.edgeForPeer(edges, 'Z'), null, 'unknown device: null');
  assert.strictEqual(E.edgeForPeer(edges, null), null);
  assert.strictEqual(E.edgeForPeer(null, 'B'), null);
}

// setRemoteEdge: kvm.layout {pcSide} is the SENDER's crossing side; our edge for it is the opposite.
{
  const a = E.setRemoteEdge(none, 'left', 'B');
  assert.deepStrictEqual(a, { ...none, right: 'B' }, 'sender crosses on its left: it is on our right');
  const b = E.setRemoteEdge(none, 'bottom', 'C');
  assert.strictEqual(b.top, 'C', 'sender crosses on its bottom: it is on our top');

  // Refresh: the same device, same edge: unchanged.
  assert.deepStrictEqual(E.setRemoteEdge(a, 'left', 'B'), a);

  // A device that moves: its old edge is left.
  const moved = E.setRemoteEdge({ ...none, top: 'B' }, 'left', 'B');
  assert.deepStrictEqual(moved, { ...none, right: 'B' }, 'the device moves to the new edge');

  // Never overwrite another device's edge: refused (null).
  assert.strictEqual(E.setRemoteEdge({ ...none, right: 'C' }, 'left', 'B'), null, 'two devices on one side are refused');
  assert.strictEqual(E.setRemoteEdge({ ...none, right: 'C' }, 'bogus', 'B'), null, 'an unknown side is refused');
  assert.strictEqual(E.setRemoteEdge(none, 'left', ''), null, 'an empty id is refused');
}

// assignEdge (the user's choice): a side can be cleared, a device moves, an occupied side is refused.
{
  const one = E.assignEdge(none, 'top', 'B');
  assert.deepStrictEqual(one, { ...none, top: 'B' });
  assert.deepStrictEqual(E.assignEdge(one, 'right', 'B'), { ...none, right: 'B' }, 'B moves from top to right');
  assert.strictEqual(E.assignEdge(one, 'top', 'C'), null, 'top is taken by B: refused');
  assert.deepStrictEqual(E.assignEdge(one, 'top', null), none, 'null clears the side');
  assert.deepStrictEqual(E.assignEdge(one, 'top', 'B'), one, 'the same device on the same side: unchanged');
  assert.strictEqual(E.assignEdge(one, 'diagonal', 'C'), null);
  assert.deepStrictEqual(one, { ...none, top: 'B' }, 'the input object is not changed');
}

// clearPeer
{
  const edges = { ...none, top: 'B', bottom: 'C' };
  assert.deepStrictEqual(E.clearPeer(edges, 'B'), { ...none, bottom: 'C' });
  assert.deepStrictEqual(E.clearPeer(edges, 'Z'), edges, 'unknown device: nothing to clear');
  assert.deepStrictEqual(E.clearPeer(edges, 'C'), { ...none, top: 'B' });
  assert.deepStrictEqual(edges, { ...none, top: 'B', bottom: 'C' }, 'the input object is not changed');
}

// migrateEdges: an old pcSide with exactly one paired device becomes that device's edge.
{
  // pcSide 'left' = the PC is on the left of the other computer, so the other one is on our right.
  assert.deepStrictEqual(E.migrateEdges({ pcSide: 'left', edges: none }, ['B']), { ...none, right: 'B' });
  assert.deepStrictEqual(E.migrateEdges({ pcSide: 'top', edges: undefined }, ['B']), { ...none, bottom: 'B' });
  assert.deepStrictEqual(E.migrateEdges({ pcSide: 'right' }, ['B']), { ...none, left: 'B' });

  // Already migrated (edges set): left alone, whatever pcSide says.
  const set = { ...none, top: 'C' };
  assert.deepStrictEqual(E.migrateEdges({ pcSide: 'left', edges: set }, ['B']), set);

  // Not exactly one device, or no pcSide: nothing to migrate.
  assert.deepStrictEqual(E.migrateEdges({ pcSide: 'left', edges: none }, []), none, 'no device');
  assert.deepStrictEqual(E.migrateEdges({ pcSide: 'left', edges: none }, ['B', 'C']), none, 'two devices');
  assert.deepStrictEqual(E.migrateEdges({ pcSide: null, edges: none }, ['B']), none, 'no pcSide');
  assert.deepStrictEqual(E.migrateEdges({ pcSide: 'nope' }, ['B']), none, 'bad pcSide');
  assert.deepStrictEqual(E.migrateEdges(undefined, undefined), none, 'nothing at all');
}

console.log('kvm-edges: all checks passed');

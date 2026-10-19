// Tests for Roster in shared/mesh.js: who is connected to whom.
// Run with: node shared/test/mesh-roster.js
'use strict';

const assert = require('assert');
const { Roster } = require('../mesh.js');

// Self A linked to B and C. B is linked to A and D. C is linked to A only (as far as C knows).
{
  const r = new Roster({ selfId: 'A' });
  assert.deepStrictEqual(r.direct('A'), [], 'self starts with no links');
  assert.strictEqual(r.direct('B'), null, 'unknown device: null');

  r.setSelf(['B', 'C']);
  r.setPeer('B', ['A', 'D']);
  r.setPeer('C', ['A']);

  assert.deepStrictEqual(r.direct('A'), ['B', 'C']);
  assert.deepStrictEqual(r.direct('B'), ['A', 'D']);
  assert.deepStrictEqual(r.direct('C'), ['A']);
  assert.strictEqual(r.linked('A', 'B'), true);
  assert.strictEqual(r.linked('B', 'A'), true, 'linked is symmetric');
  assert.strictEqual(r.linked('B', 'D'), true, 'B lists D: linked, even though D has no entry');
  assert.strictEqual(r.linked('C', 'D'), false, 'no link known between C and D');
  assert.strictEqual(r.linked('X', 'A'), false, 'unknown device is not linked');

  // direct() and snapshot() return copies: changing them does not change the roster.
  r.direct('A').push('Z');
  r.snapshot().A.push('Z');
  assert.deepStrictEqual(r.direct('A'), ['B', 'C']);

  // setPeer copies its input and drops duplicates.
  const ids = ['E', 'E', 'F'];
  r.setPeer('E', ids);
  ids.push('G');
  assert.deepStrictEqual(r.direct('E'), ['E', 'F'], 'duplicates dropped, later changes to the input ignored');
}

// remove(): the device is forgotten, and removed from every other list.
{
  const r = new Roster({ selfId: 'A' });
  r.setSelf(['B', 'C', 'D']);
  r.setPeer('B', ['A', 'C']);
  r.setPeer('C', ['A', 'B', 'D']);
  r.setPeer('D', ['A', 'C']);

  r.remove('C');
  assert.strictEqual(r.direct('C'), null, 'removed device is unknown');
  assert.deepStrictEqual(r.direct('A'), ['B', 'D'], 'self no longer lists C');
  assert.deepStrictEqual(r.direct('B'), ['A'], 'B no longer lists C');
  assert.deepStrictEqual(r.direct('D'), ['A'], 'D no longer lists C');
  assert.strictEqual(r.linked('B', 'C'), false);

  // No list anywhere still contains C.
  for (const [id, list] of Object.entries(r.snapshot())) {
    assert.ok(!list.includes('C'), `${id} still lists C`);
  }

  // Removing a device that is not known does nothing.
  r.remove('Q');
  assert.deepStrictEqual(r.direct('A'), ['B', 'D']);
}

// setPeer replaces the earlier list of that device.
{
  const r = new Roster({ selfId: 'A' });
  r.setPeer('B', ['A', 'C']);
  r.setPeer('B', ['A']);
  assert.deepStrictEqual(r.direct('B'), ['A']);
  assert.strictEqual(r.linked('B', 'C'), false, 'a link that B no longer reports is gone');
}

console.log('mesh-roster: passed');

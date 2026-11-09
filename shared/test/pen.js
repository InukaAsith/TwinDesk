// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A phone stylus's `pen` on in.mm/md/mu (shared/protocol.js P.penOf): what the helpers get.
// Run with: node shared/test/pen.js
'use strict';

const assert = require('assert');
const P = require('../protocol.js');

// None, or not an object: a mouse.
assert.strictEqual(P.penOf(undefined), null);
assert.strictEqual(P.penOf('pen'), null);

// Touching: pressure, tilt and twist as sent.
assert.deepStrictEqual(P.penOf({ p: 0.5, tx: 30, ty: -12, tw: 90, c: true }),
  { p: 0.5, tx: 30, ty: -12, tw: 90, c: true, er: false, bar: false, out: false });

// Out of range values are clamped; twist wraps.
assert.deepStrictEqual(P.penOf({ p: 3, tx: 200, ty: -200, tw: -90, c: true, er: true }),
  { p: 1, tx: 90, ty: -90, tw: 270, c: true, er: true, bar: false, out: false });

// Hovering has no pressure; junk is 0.
assert.deepStrictEqual(P.penOf({ p: 0.7, tx: 'x', tw: NaN, bar: true }),
  { p: 0, tx: 0, ty: 0, tw: 0, c: false, er: false, bar: true, out: false });

// Out of range: neither touching nor the side button.
assert.deepStrictEqual(P.penOf({ p: 0.7, c: true, bar: true, out: true }),
  { p: 0, tx: 0, ty: 0, tw: 0, c: false, er: false, bar: false, out: true });

console.log('pen ok');

// in.tc's fingers (P.touchesOf), and RemoteInput's `touch` command for the helpers.
assert.deepStrictEqual(P.touchesOf([]), []);
assert.deepStrictEqual(P.touchesOf([[0, 0.5, 2], [3, -1, 0.25]]), [[0, 0.5, 1], [3, 0, 0.25]]);
assert.strictEqual(P.touchesOf('x'), null);
assert.strictEqual(P.touchesOf([[0, 0, 0], [0, 1, 1]]), null); // the same finger twice
assert.strictEqual(P.touchesOf([[10, 0, 0]]), null);
assert.strictEqual(P.touchesOf([[1, NaN, 0]]), null);
assert.strictEqual(P.touchesOf(Array.from({ length: 11 }, (_, i) => [i % 10, 0, 0])), null);
for (const os of ['windows', 'linux']) {
  const RI = require(`../../${os}/remote-input.js`);
  const sent = [];
  const ri = new RI({ helper: { send: (c, a) => sent.push([c, a]) }, settings: { pcScreen: { input: true }, keys: {} }, inputAllowed: () => true, link: {} });
  const at = (x, y) => ({ x: Math.round(x * 1919), y: Math.round(y * 1079) });
  const touches = [];
  ri.handle({ t: 'in.tc', p: [[0, 0.5, 0.5], [1, 0, 1]] }, null, null, null, false, (l) => touches.push(RI.touchCmd(l, at)));
  ri.handle({ t: 'in.tc', p: 'bad' }, null, null, null, false, (l) => touches.push(l));
  ri.handle({ t: 'in.tc', p: [] }, null, null, null, false, (l) => touches.push(RI.touchCmd(l, at)));
  ri.handle({ t: 'in.tc', p: [[0, 0, 0]] }, null, null, null, false); // an app window: no touch
  assert.deepStrictEqual(touches, [{ p: '0,960,540;1,0,1079' }, { p: '' }]);
  assert.ok(RI.TYPES.includes('in.tc'));
}
console.log('touch ok');

// A stroke's samples on one in.mm (P.penPoints), and what the PC's helper gets from them.
{
  const pen = P.penOf({ p: 0.5, tx: 10, ty: 0, c: true });
  assert.deepStrictEqual(P.penPoints([[0.1, 0.2, 0.3, 5, -5], [2, 0.4]], pen),
    [{ x: 0.1, y: 0.2, pen: { ...pen, p: 0.3, tx: 5, ty: -5 } }, { x: 1, y: 0.4, pen }]);
  assert.deepStrictEqual(P.penPoints([[0.1, 'x']], pen), []);
  assert.deepStrictEqual(P.penPoints([[0.1, 0.2]], { ...pen, c: false }), []); // hovering: no samples
  assert.deepStrictEqual(P.penPoints(undefined, pen), []);
  const RI = require('../../windows/remote-input.js');
  const got = [];
  const ri = new RI({ helper: { send() {} }, settings: { pcScreen: { input: true }, keys: {} }, inputAllowed: () => true, link: {} });
  ri.handle({ t: 'in.mm', x: 0.5, y: 0.5, pen: { p: 0.5, c: true }, pts: [[0.1, 0.1, 0.2], [0.3, 0.3, 0.4]] }, () => {}, null, (x, y, st) => got.push([x, y, st.p]));
  assert.deepStrictEqual(got, [[0.1, 0.1, 0.2], [0.3, 0.3, 0.4], [0.5, 0.5, 0.5]]);
}
console.log('pen points ok');

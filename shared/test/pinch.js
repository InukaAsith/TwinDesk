// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/pinch.js: a zoom gesture becomes two fingers on the phone. Run: node shared/test/pinch.js
'use strict';
const assert = require('assert');
const { Pinch } = require('../pinch.js');

const ctl = () => { const c = { ev: [], touch: (a, id, x, y, w, h) => c.ev.push({ a, id, x, y, w, h }) }; return c; };
const d = { w: 1080, h: 2400 };

{
  const c = ctl(), p = new Pinch();
  assert.strictEqual(p.feed(c, { g: 'back' }, { x: 0, y: 0 }, d), false, 'not a zoom');
  p.feed(c, { g: 'zoom', v: 0, phase: 'begin' }, { x: 540, y: 1200 }, d);
  assert.deepStrictEqual(c.ev.map((e) => e.a), [0, 0], 'two fingers down');
  const gap0 = c.ev[1].x - c.ev[0].x;
  p.feed(c, { g: 'zoom', v: 0.2, phase: 'change' }, { x: 540, y: 1200 }, d);
  const gap1 = c.ev[3].x - c.ev[2].x;
  assert.ok(gap1 > gap0 && c.ev[2].a === 2, 'spread: they move apart');
  for (let i = 0; i < 40; i++) p.feed(c, { g: 'zoom', v: 0.5, phase: 'change' }, { x: 540, y: 1200 }, d);
  for (const e of c.ev) assert.ok(e.x >= 0 && e.x <= d.w, 'on the screen');
  p.feed(c, { g: 'zoom', v: 0, phase: 'end' }, { x: 540, y: 1200 }, d);
  assert.deepStrictEqual(c.ev.slice(-2).map((e) => e.a), [1, 1], 'both lift');
  assert.strictEqual(p.on, false);
}
{
  const c = ctl(), p = new Pinch(); // at the very edge: the middle moves in so both fingers fit
  p.feed(c, { g: 'zoom', v: -0.1, phase: 'begin' }, { x: 2, y: 5 }, d);
  for (const e of c.ev) assert.ok(e.x > 0 && e.x < d.w);
  p.feed(c, { g: 'zoom', v: 0, phase: 'end' }, {}, d);
}
{
  const c = ctl(), p = new Pinch(); // no end: they lift by themselves
  p.feed(c, { g: 'zoom', v: 0.1, phase: 'change' }, { x: 300, y: 300 }, d);
  setTimeout(() => {
    assert.deepStrictEqual(c.ev.slice(-2).map((e) => e.a), [1, 1]);
    console.log('pinch: passed');
  }, 700);
}

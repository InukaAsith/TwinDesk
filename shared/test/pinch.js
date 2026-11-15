// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/pinch.js: a zoom gesture becomes two fingers on the phone. Run: node shared/test/pinch.js
'use strict';
const assert = require('assert');
const { Pinch } = require('../pinch.js');
const { PhoneInput } = require('../phoneinput.js');

const ctl = () => { const c = { ev: [], touch: (a, id, x, y, w, h) => c.ev.push({ a, id, x, y, w, h }) }; return c; };
const d = { w: 1080, h: 2400, dpi: 420 };
const gap = (ev, i) => Math.abs(ev[i + 1].y - ev[i].y);
const MIN_SPAN = 27 / 25.4 * d.dpi; // Android's ScaleGestureDetector minimum span (config_minScalingSpan)
const on = (c) => c.ev.every((e) => e.x >= 0 && e.x < d.w && e.y >= 0 && e.y < d.h);

{ // spreading: the fingers start near, but past Android's minimum span, and move apart
  const c = ctl(), p = new Pinch();
  assert.strictEqual(p.feed(c, { g: 'back' }, { x: 0, y: 0 }, d), false, 'not a zoom');
  p.feed(c, { g: 'zoom', v: 0, phase: 'begin' }, { x: 540, y: 1200 }, d);
  assert.strictEqual(c.ev.length, 0, 'nothing down before the pinch moves (its direction picks the start)');
  p.feed(c, { g: 'zoom', v: 0.1, phase: 'change' }, { x: 540, y: 1200 }, d);
  assert.deepStrictEqual(c.ev.slice(0, 2).map((e) => [e.a, e.id]), [[0, 1001], [0, 1002]], 'two fingers down');
  assert.strictEqual(c.ev[0].x, c.ev[1].x, 'portrait: along the long side');
  assert.ok(gap(c.ev, 0) >= MIN_SPAN, `start span ${gap(c.ev, 0)} ≥ ${MIN_SPAN.toFixed(0)}`);
  assert.ok(gap(c.ev, 2) > gap(c.ev, 0) && c.ev[2].a === 2, 'they move apart');
  assert.ok(p.active);
  for (let i = 0; i < 60; i++) p.feed(c, { g: 'zoom', v: 0.2, phase: 'change' }, { x: 540, y: 1200 }, d);
  assert.ok(on(c), 'on the screen');
  const downs = c.ev.filter((e) => e.a === 0).length;
  assert.ok(downs > 2, 'a long spread lifts and comes down again');
  p.feed(c, { g: 'zoom', v: 0, phase: 'end' }, { x: 540, y: 1200 }, d);
  assert.deepStrictEqual(c.ev.slice(-2).map((e) => e.a), [1, 1], 'both lift');
  assert.strictEqual(p.active, false);
}
{ // pinching in starts far apart, and closes
  const c = ctl(), p = new Pinch();
  p.feed(c, { g: 'zoom', v: -0.1, phase: 'begin' }, { x: 540, y: 1200 }, d);
  assert.ok(gap(c.ev, 2) < gap(c.ev, 0) && gap(c.ev, 2) >= MIN_SPAN, 'closes from far');
  p.cancel();
  assert.deepStrictEqual(c.ev.slice(-2).map((e) => e.a), [1, 1], 'cancel lifts');
}
{ // at the very edge, landscape, no dpi from an old app: the middle moves in so both fingers fit
  const c = ctl(), p = new Pinch(), l = { w: 2400, h: 1080 };
  p.feed(c, { g: 'zoom', v: -0.1, phase: 'begin' }, { x: 2, y: 5 }, l);
  assert.strictEqual(c.ev[0].y, c.ev[1].y, 'landscape: side by side');
  for (const e of c.ev) assert.ok(e.x > 0 && e.x < l.w && e.y > 0 && e.y < l.h);
  p.feed(c, { g: 'zoom', v: 0, phase: 'end' }, {}, l);
}
{ // a button held is a drag: no fingers
  const c = ctl(), p = new Pinch();
  p.feed(c, { g: 'zoom', v: 0.1, phase: 'change' }, { x: 300, y: 300, buttons: 1 }, d);
  assert.strictEqual(c.ev.length, 0);
}
{ // without wireless debugging: one Accessibility stroke per batch, never a throw
  const sent = [], input = new PhoneInput((m) => sent.push(m)), p = new Pinch();
  p.feed(input, { g: 'zoom', v: 0, phase: 'begin' }, { x: 540, y: 1200 }, d);
  for (let i = 0; i < 5; i++) p.feed(input, { g: 'zoom', v: 0.05, phase: 'change' }, { x: 540, y: 1200 }, d);
  assert.strictEqual(sent.length, 0, 'gathered');
  p.feed(input, { g: 'zoom', v: 0, phase: 'end' }, { x: 540, y: 1200 }, d);
  assert.strictEqual(sent.length, 1);
  const z = sent[0];
  assert.strictEqual(z.a, 'z');
  assert.strictEqual(z.vert, 1);
  assert.ok(z.to > z.from && z.from * 2 >= MIN_SPAN, 'spreads from past the minimum span');
  assert.strictEqual(p.active, false);
}
{ // no end: they lift by themselves
  const c = ctl(), p = new Pinch();
  p.feed(c, { g: 'zoom', v: 0.1, phase: 'change' }, { x: 300, y: 300 }, d);
  setTimeout(() => {
    assert.deepStrictEqual(c.ev.slice(-2).map((e) => e.a), [1, 1]);
    assert.strictEqual(p.active, false);
    console.log('pinch: passed');
  }, 700);
}

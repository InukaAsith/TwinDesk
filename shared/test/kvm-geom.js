// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tests for shared/kvm-geom.js: touching stretches, zones and offsets between two computers.
// Run with: node shared/test/kvm-geom.js
'use strict';

const assert = require('assert');
const G = require('../kvm-geom.js');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

// A Mac: a 1512×982 laptop screen, and a 2560×1440 monitor to its right, top-aligned.
const mac = [
  { id: 'laptop', x: 0, y: 0, w: 1512, h: 982 },
  { id: 'ext', x: 1512, y: 0, w: 2560, h: 1440 },
];
// A PC with one 1920×1080 monitor.
const pc = [{ id: 'pc', x: 0, y: 0, w: 1920, h: 1080 }];

// placement: across the side the PC slides in until it meets a monitor, never the bounding box.
{
  assert.deepStrictEqual(G.placement(mac, pc, { side: 'right', along: 100 }), { x: 4072, y: 100 }, 'right of the monitor');
  // Below, under the laptop only: it meets the laptop's bottom (982), not the monitor's (1440).
  assert.deepStrictEqual(G.placement(mac, pc, { side: 'bottom', along: -420 }), { x: -420, y: 982 }, 'under the laptop');
  // Under both: the taller monitor holds it down.
  assert.deepStrictEqual(G.placement(mac, pc, { side: 'bottom', along: 1000 }), { x: 1000, y: 1440 }, 'under both');
  assert.strictEqual(G.placement(mac, [], { side: 'right', along: 0 }), null, 'unknown');
}

// contact: the PC to the right touches only the external monitor.
{
  const cs = G.contact(mac, pc, { side: 'right', along: 100 });
  assert.strictEqual(cs.length, 1);
  assert.deepStrictEqual(cs[0], { mine: { display: 'ext', from: 100, to: 1180 }, theirs: { display: 'pc', from: 0, to: 1080 } });
  // Partly past the monitor's bottom: cut to where they overlap.
  const low = G.contact(mac, pc, { side: 'right', along: 1000 })[0];
  assert.deepStrictEqual(low, { mine: { display: 'ext', from: 1000, to: 1440 }, theirs: { display: 'pc', from: 0, to: 440 } });
  // Entirely below: no contact.
  assert.deepStrictEqual(G.contact(mac, pc, { side: 'right', along: 1500 }), []);
  // To the left: the laptop only.
  assert.deepStrictEqual(G.contact(mac, pc, { side: 'left', along: 0 })[0].mine.display, 'laptop');
  // Below both: only the taller monitor touches; below the laptop: the laptop.
  const below = G.contact(mac, pc, { side: 'bottom', along: 1000 });
  assert.deepStrictEqual(below.map((c) => [c.mine.display, c.mine.from, c.mine.to]), [['ext', 1512, 2920]]);
  const under = G.contact(mac, pc, { side: 'bottom', along: -420 });
  assert.deepStrictEqual(under.map((c) => [c.mine.display, c.mine.from, c.mine.to, c.theirs.from, c.theirs.to]), [['laptop', 0, 1500, 420, 1920]]);
}

// The other computer's view is the mirror and finds the same stretch.
{
  const a = { side: 'right', along: 100 };
  const mine = G.contact(mac, pc, a)[0];
  const theirs = G.contact(pc, mac, G.mirror(a))[0];
  assert.deepStrictEqual(theirs.mine, mine.theirs, 'their side');
  assert.deepStrictEqual(theirs.theirs, mine.mine, 'our side');
}

// exitPoint / entryPoint: 42 % down the stretch lands 42 % down on the other side.
{
  const c = G.contact(mac, pc, { side: 'right', along: 100 })[0];
  const t = G.exitPoint(c, 100 + 0.42 * 1080);
  near(t, 0.42, 'exit');
  near(G.entryPoint(c, t), 0.42 * 1080, 'entry');
  near(G.exitPoint(c, -50), 0, 'clamped before');
  near(G.exitPoint(c, 5000), 1, 'clamped after');
}

// zones and zonesText: fractions of our bounding box along the side.
{
  const z = G.zones(mac, pc, { side: 'right', along: 100 });
  assert.strictEqual(z.length, 1);
  near(z[0][0], 100 / 1440, 'zone from');
  near(z[0][1], 1180 / 1440, 'zone to');
  assert.strictEqual(G.zonesText(mac, pc, { side: 'right', along: 100 }), `${(100 / 1440).toFixed(4)}-${(1180 / 1440).toFixed(4)}`);
  assert.strictEqual(G.zonesText(mac, pc, { side: 'right', along: 1500 }), 'none', 'no contact: nothing crosses');
  assert.strictEqual(G.zonesText(mac, [], { side: 'right', along: 0 }), null, 'their displays unknown');
  // Two monitors side by side under a wide PC: one merged zone.
  const wide = [{ id: 'w', x: 0, y: 0, w: 5000, h: 1000 }];
  assert.deepStrictEqual(G.zones(mac, wide, { side: 'top', along: 0 }), [[0, 1]], 'merged');
}

// mapOffset: our helper's offset to theirs, through the stretch.
{
  const a = { side: 'right', along: 100 };
  // 42 % down the stretch on the Mac (in Mac bounding-box terms) → 42 % down the PC.
  const ours = (100 + 0.42 * 1080) / 1440;
  near(G.mapOffset(mac, pc, a, ours), 0.42, 'mac → pc');
  // And back: the PC's 42 % → the same point on the Mac.
  near(G.mapOffset(pc, mac, G.mirror(a), 0.42), ours, 'pc → mac');
  // Outside the stretch: the nearest end.
  near(G.mapOffset(mac, pc, a, 0), 0, 'above: top end');
  near(G.mapOffset(mac, pc, a, 1), 1, 'below: bottom end');
  // Unknown: unchanged.
  near(G.mapOffset(mac, [], a, 0.3), 0.3, 'unknown');
}

// Staggered monitors with a gap along the side: two zones, the gap doesn't cross.
{
  const stag = [
    { id: 'a', x: 0, y: 0, w: 1000, h: 500 },
    { id: 'b', x: 0, y: 500, w: 800, h: 500 }, // narrower: doesn't reach the right edge
    { id: 'c', x: 0, y: 1000, w: 1000, h: 500 },
  ];
  const tall = [{ id: 't', x: 0, y: 0, w: 1000, h: 1500 }];
  const z = G.zones(stag, tall, { side: 'right', along: 0 });
  assert.strictEqual(z.length, 2, 'two zones');
  near(z[0][1], 1 / 3, 'first ends at a');
  near(z[1][0], 2 / 3, 'second starts at c');
}

// centred, snap, normalize.
{
  assert.strictEqual(G.centred(mac, pc, 'right'), 180, 'centred: (1440 - 1080) / 2');
  // Too far down: pulled back to touch by MIN_TOUCH.
  assert.strictEqual(G.snap(mac, pc, 'right', 3000), 1440 - G.MIN_TOUCH);
  // Within SNAP of bottoms aligned (1440 - 1080 = 360): pulled onto it.
  assert.strictEqual(G.snap(mac, pc, 'right', 350), 360);
  // Within SNAP of tops aligned: 0.
  assert.strictEqual(G.snap(mac, pc, 'right', -10), 0);
  // Left of the Mac, low down: it tucks in under the laptop against the monitor's left edge, whose
  // exposed part ends at 1440; too low is pulled up to touch it by MIN_TOUCH.
  assert.strictEqual(G.snap(mac, pc, 'left', 2000), 1440 - G.MIN_TOUCH);
  assert.deepStrictEqual(G.contact(mac, pc, { side: 'left', along: 1200 }).map((c) => c.mine.display), ['ext'], 'under the laptop: the monitor');
  assert.deepStrictEqual(G.contact(mac, pc, { side: 'left', along: 0 }).map((c) => c.mine.display), ['laptop'], 'beside the laptop');
  // Below, just past the laptop's left end: kept (it touches the laptop).
  assert.strictEqual(G.snap(mac, pc, 'bottom', -1800), -1800);
  // Too far left: pulled back to touch the laptop by MIN_TOUCH.
  assert.strictEqual(G.snap(mac, pc, 'bottom', -5000), -1920 + G.MIN_TOUCH);
  // normalize: missing along → centred; bad side → right.
  assert.deepStrictEqual(G.normalize({ side: 'right' }, mac, pc), { side: 'right', along: 180 });
  assert.deepStrictEqual(G.normalize({ side: 'middle', along: 0 }, mac, pc), { side: 'right', along: 0 });
  assert.deepStrictEqual(G.normalize({ side: 'left', along: 50 }, mac, []), { side: 'left', along: 50 }, 'no snap when unknown');
  assert.deepStrictEqual(G.mirror({ side: 'top', along: 30 }), { side: 'bottom', along: -30 });
}

// Drag side follows the nearest possible placement, including a display tucked under another.
{
  const laptopAndTv = [
    { id: 'laptop', x: 2300, y: 1190, w: 1620, h: 1040 },
    { id: 'tv', x: 3500, y: 0, w: 2110, h: 1150 },
  ];
  const mini = [
    { id: 'mini-1', x: 0, y: 500, w: 1370, h: 750 },
    { id: 'arzopa', x: 1410, y: 0, w: 2070, h: 1150 },
  ];
  // The Arzopa is above the laptop and narrowly left of the TV. The centre-based selector
  // considers this left of the entire local desktop and cannot select this top contact.
  const x = 0, y = 40;
  assert.strictEqual(G.closestSide(laptopAndTv, mini, x, y, 'left'), 'top');
  const along = G.snap(laptopAndTv, mini, 'top', x - G.bounds(laptopAndTv).x);
  assert.deepStrictEqual(G.contact(laptopAndTv, mini, { side: 'top', along }).map((c) => [c.mine.display, c.theirs.display]), [['laptop', 'arzopa']]);

  const a = [{ id: 'a', x: 0, y: 0, w: 1000, h: 1000 }];
  const b = [{ id: 'b', x: 0, y: 0, w: 600, h: 600 }];
  assert.strictEqual(G.closestSide(a, b, -600, 200, 'top'), 'left');
  assert.strictEqual(G.closestSide(a, b, 1000, 200, 'top'), 'right');
  assert.strictEqual(G.closestSide(a, b, 200, -600, 'left'), 'top');
  assert.strictEqual(G.closestSide(a, b, 200, 1000, 'left'), 'bottom');
  assert.strictEqual(G.closestSide(a, b, -600, -600, 'left'), 'left', 'stable at a corner');
  assert.strictEqual(G.closestSide(a, b, -600, -600, 'top'), 'top', 'stable at a corner from the other side');
  assert.strictEqual(G.closestSide([], b, 0, 0, 'top'), 'top', 'unknown displays');
}

console.log('kvm-geom: ok');

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/movewin.js (Apps › Move windows): a grabbed window goes over (listed `moved`,
// parked here), comes back where it was or under the pointer, and is forgotten when it closes; with
// the switch off nothing moves. Run with: node shared/test/movewin.js
'use strict';

const assert = require('assert');
const MW = require('../movewin.js');

function fakePc(over = {}) {
  const sent = [];
  const pc = {
    settings: { pcApps: { moveWindows: true } },
    macAccepts: true,
    link: { current: { transport: 'ip' } },
    moved: new Map(),
    stopped: false,
    polls: 0,
    changes: 0,
    sent,
    helper: {
      send: (cmd, args) => sent.push([cmd, args]),
      request: async () => ({ windows: [{ wid: 7, pid: 70, x: 100, y: 50, w: 800, h: 600, title: 'Notes', scale: 1 }, { wid: 9, pid: 70, x: 150, y: 90, w: 120, h: 200, popup: true, scale: 1 }] }),
    },
    _mine: () => false,
    _poll() { this.polls++; },
    onChange() { this.changes++; },
    _cursorPx: () => ({ x: 1000, y: 300 }),
    _movedExtra: () => ({ maxW: 1920, maxH: 1040 }),
    ...over,
  };
  return pc;
}

(async () => {
  const pc = fakePc();
  assert.strictEqual(await MW.moveOut(pc, 7), true, 'moved');
  assert.deepStrictEqual(pc.moved.get(7), { x: 100, y: 50, w: 800, h: 600, pid: 70 }, 'where it was is kept');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepStrictEqual(pc.sent.find(([c]) => c === 'winPark'), ['winPark', { wid: 7 }], 'parked once the grab let go');
  assert.strictEqual(await MW.moveOut(pc, 7), false, 'already there');

  // The list over there: that window, `moved`, with its process's pop-up.
  const all = [{ wid: 7, pid: 70, x: 5000, y: 50, w: 800, h: 600, title: 'Notes', scale: 1 }, { wid: 9, pid: 70, x: 5050, y: 90, w: 120, h: 200, popup: true, title: '', scale: 1 }];
  const taken = new Set(), out = [], pops = [];
  MW.list(pc, all, taken, out, pops);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].moved, true);
  assert.strictEqual(out[0].maxW, 1920);
  assert.strictEqual(pops.length, 1);
  assert.deepStrictEqual([pops[0].owner, pops[0].x, pops[0].y], [7, 50, 40], 'the pop-up over its owner');
  assert.ok(taken.has(7) && taken.has(9));

  // Used from its copy: back where it was (once, not per input), parked again when the input stops.
  const before = pc.sent.length;
  MW.touch(pc, 7);
  MW.touch(pc, 7);
  assert.deepStrictEqual(pc.sent.slice(before), [['winPlace', { wid: 7, x: 100, y: 50 }]], 'placed on a screen once');
  await new Promise((r) => setTimeout(r, 2700));
  assert.deepStrictEqual(pc.sent.at(-1), ['winPark', { wid: 7 }], 'parked again after the input');
  MW.touch(pc, 123); // not moved: nothing
  assert.deepStrictEqual(pc.sent.at(-1), ['winPark', { wid: 7 }]);

  // Dragged back: under the pointer, title bar under it.
  MW.bringBack(pc, 7, true);
  assert.deepStrictEqual(pc.sent.at(-1), ['winPlace', { wid: 7, x: 600, y: 288 }]);
  assert.strictEqual(pc.moved.size, 0);

  // Closed or tray: back where it was.
  await MW.moveOut(pc, 7);
  MW.bringBack(pc);
  assert.deepStrictEqual(pc.sent.at(-1), ['winPlace', { wid: 7, x: 100, y: 50 }]);

  // Grabbed somewhere else and dragged to the edge: it comes back where it was grabbed, used from its copy or closed.
  await MW.moveOut(pc, 7, { x: 300, y: 200 });
  assert.deepStrictEqual([pc.moved.get(7).x, pc.moved.get(7).y], [300, 200], 'where it was grabbed, not where it crossed');
  MW.touch(pc, 7);
  assert.deepStrictEqual(pc.sent.at(-1), ['winPlace', { wid: 7, x: 300, y: 200 }]);
  MW.bringBack(pc);
  assert.deepStrictEqual(pc.sent.at(-1), ['winPlace', { wid: 7, x: 300, y: 200 }]);
  await MW.moveOut(pc, 7, { x: NaN, y: NaN }); // a helper without it: where it crossed
  assert.deepStrictEqual([pc.moved.get(7).x, pc.moved.get(7).y], [100, 50]);
  MW.bringBack(pc);

  // A moved window that closed here is forgotten.
  await MW.moveOut(pc, 7);
  MW.list(pc, [], new Set(), [], []);
  assert.strictEqual(pc.moved.size, 0);

  // Nothing moves: switch off, the other side doesn't take windows, Bluetooth, a window that isn't there.
  assert.strictEqual(await MW.moveOut(fakePc({ settings: { pcApps: { moveWindows: false } } }), 7), false);
  assert.strictEqual(await MW.moveOut(fakePc({ macAccepts: false }), 7), false);
  assert.strictEqual(await MW.moveOut(fakePc({ link: { current: { transport: 'ble' } } }), 7), false);
  assert.strictEqual(await MW.moveOut(fakePc(), 123), false);

  // pcapps.js loads it only when used: off, no require.
  const pcSrc = require('fs').readFileSync(require('path').join(__dirname, '../../windows/pcapps.js'), 'utf8');
  assert.ok(!/^const .*movewin/m.test(pcSrc), 'not required at the top of pcapps.js');
  console.log('movewin: ok');
})().catch((e) => { console.error(e); process.exit(1); });

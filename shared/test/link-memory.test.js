// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// shared/link-memory.js: what a link that moves between devices keeps itself (it replaced peerstate.js).
// LinkMemory: the last of the types it was given, from every device, without ask, forgotten when the device
// goes. Goodbyes: any *.policy turned on at its device, switched off once when it leaves.
// Run: node shared/test/link-memory.test.js
'use strict';

const assert = require('assert');
const { LinkMemory, Goodbyes } = require('../link-memory.js');

const on = new Map();
const peer = new Map();
const bus = {
  on: (t, fn) => { if (!on.has(t)) on.set(t, []); on.get(t).push(fn); },
  onPeer: (ev, fn) => { if (!peer.has(ev)) peer.set(ev, []); peer.get(ev).push(fn); },
};
const say = (from, m) => { for (const fn of on.get(m.t) || []) fn(m, from); };
const gone = (id) => { for (const fn of peer.get('closed') || []) fn(id); };

const mem = new LinkMemory(bus, ['screen.state', 'papp.policy']);
assert.deepStrictEqual([...on.keys()].sort(), ['papp.policy', 'screen.state'], 'it listens for its types only');
say('C', { t: 'screen.state', on: false });
say('C', { t: 'screen.state', on: true, mode: 'extend', ask: true });
say('C', { t: 'papp.policy', accept: true });
say('B', { t: 'screen.state', on: false });
assert.deepStrictEqual(mem.replay('C'), [{ t: 'screen.state', on: true, mode: 'extend' }, { t: 'papp.policy', accept: true }], 'the last of each, no ask');
assert.deepStrictEqual(mem.replay('B'), [{ t: 'screen.state', on: false }]);
assert.deepStrictEqual(mem.replay('Z'), []);
mem.replay('C')[0].on = 'changed';
assert.strictEqual(mem.replay('C')[0].on, true, 'copies');
gone('C');
assert.deepStrictEqual(mem.replay('C'), [], 'forgotten when it goes');

const bye = new Goodbyes();
bye.note('B', { t: 'screen.policy', accept: true, width: 1920 });
bye.note('B', { t: 'cam.policy', share: true });
bye.note('B', { t: 'mic.policy', accept: false });
bye.note('B', { t: 'papp.windows', windows: [] });
bye.note('B', { t: 'rtc2.offer', accept: true }); // not a policy
assert.deepStrictEqual(bye.take('C'), [], 'not its device');
assert.deepStrictEqual(bye.take('B'), [{ t: 'screen.policy', accept: false }, { t: 'cam.policy', share: false }], 'what it turned on, off');
assert.deepStrictEqual(bye.take('B'), [], 'once');
bye.note('B', { t: 'screen.policy', accept: true });
bye.note('B', { t: 'screen.policy', accept: false });
assert.deepStrictEqual(bye.take('B'), [], 'turned off already: nothing to say');
bye.note('B', { t: 'audio.policy', accept: true });
bye.note('C', { t: 'audio.policy', accept: true }); // moved to C: B's are no longer its to switch off
assert.deepStrictEqual(bye.take('B'), []);
bye.forget('C');
assert.deepStrictEqual(bye.take('C'), [], 'its device went');
console.log('link-memory: ok');

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// clipWatch (#257): polls the phone's clipboard only once scrcpy missed a copy the app sent.
'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const timers = [];
global.setTimeout = (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; };
global.setInterval = (fn, ms) => { const t = { fn, ms, interval: true, unref() {} }; timers.push(t); return t; };
global.clearInterval = (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
const { clipWatch } = require('../clippoll.js');
console.log = () => {};

function bridge() {
  const control = { closed: false, reads: 0, getClipboard() { this.reads++; } };
  return { server: new EventEmitter(), control, lastPhoneClip: null };
}
const fire = (kind) => { for (const t of timers.filter((x) => !!x.interval === (kind === 'interval'))) { if (kind !== 'interval') timers.splice(timers.indexOf(t), 1); t.fn(); } };

// scrcpy reports the copy just after the app: no polling.
let b = bridge(); let w = clipWatch(b);
b.server.emit('t:clip', { text: 'hello' });
b.lastPhoneClip = 'hello'; // scrcpy's listener, a moment later
fire('timeout');
assert.strictEqual(w.polling, false);

// scrcpy never reports it: polling starts and reads the clipboard.
timers.length = 0;
b = bridge(); w = clipWatch(b);
b.server.emit('t:clip', { text: 'missed' });
fire('timeout');
assert.strictEqual(w.polling, true);
assert.strictEqual(b.lastPhoneClip, 'missed');
fire('interval'); fire('interval');
assert.strictEqual(b.control.reads, 2);
w.stop();
assert.strictEqual(w.polling, false);

// No control session: nothing.
timers.length = 0;
b = bridge(); b.control = null; w = clipWatch(b);
b.server.emit('t:clip', { text: 'x' });
assert.strictEqual(timers.length, 0);
process.stdout.write('clippoll: ok\n');

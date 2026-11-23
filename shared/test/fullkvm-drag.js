// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Full KVM on Windows (shared/fullkvm/route.js): file drags past the edge. Explorer can't drop onto the
// service's (SYSTEM's) strip, so ours shows it: it hears what the service's capture does (dragStrip),
// and the drag it catches goes to the service (dragCross, dragHold), never to the app.
'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');
process.env.TWINDESK_KVM_SOCK = path.join(__dirname, 'no-such-kvm.sock');
Object.defineProperty(process, 'platform', { value: 'win32' }); // the strip is Windows' (DropEdge.cs)

class Base extends EventEmitter {
  constructor() { super(); this.own = []; this.proc = {}; }
  send(cmd, args) { this.own.push([cmd, args]); return true; }
  request() { return Promise.resolve({}); }
}
const Helper = require('../fullkvm/route.js')(Base);

const h = new Helper();
h.svc.stop();
const svc = Object.assign(new EventEmitter(), { connected: true, sent: [], send(cmd, args) { this.sent.push([cmd, args]); return true; } });
// The route's own handlers, on our fake service link.
for (const ev of ['ready', 'event', 'exit']) for (const fn of h.svc.listeners(ev)) svc.on(ev, fn);
h.svc.removeAllListeners();
h.svc = svc;
const strip = () => { const s = h.own.filter(([c]) => c === 'dragStrip').pop(); return s && s[1]; };
const app = [];
h.on('event', (name, msg) => app.push([name, msg]));

// The service comes: ours lets go of the mouse and keyboard, and its strip follows the service.
svc.emit('ready');
assert.ok(h.own.some(([c, a]) => c === 'capture' && a.on === false), 'ours quiet');
assert.strictEqual(strip().on, true);

// kvm.js's config goes to the service, and our strip hears the sides and the drag switch.
h.send('kvmConfig', { side: 'left', sides: ['left', 'top'], driveOther: true, dragFiles: true });
assert.deepStrictEqual(svc.sent.pop(), ['kvmConfig', { side: 'left', sides: ['left', 'top'], driveOther: true, dragFiles: true }]);
assert.deepStrictEqual([strip().sides, strip().driveOther, strip().dragFiles], [['left', 'top'], true, true]);
h.send('armReturn', { on: true, side: 'right', sides: ['right'] });
assert.deepStrictEqual(strip().back, ['right'], 'driven: the way back');
h.send('armReturn', { on: false });
assert.deepStrictEqual(strip().back, []);

// Our strip caught a drag: it goes to the service, not to the app.
svc.sent.length = 0;
h._fromOwn = true;
h.emit('event', 'dragCross', { event: 'dragCross', x: 0, y: 500, side: 'left', back: false, paths: ['C:\\a.txt'] });
h.emit('event', 'dragHold', { event: 'dragHold', on: true });
h._fromOwn = false;
assert.deepStrictEqual(svc.sent.map(([c]) => c), ['dragCross', 'dragHold']);
assert.deepStrictEqual(svc.sent[0][1].paths, ['C:\\a.txt']);
assert.deepStrictEqual(app, [], 'the app never hears them');

// The service's capture crosses (with the drag): its edge goes to the app, our strip knows it captures.
const cross = strip().cross;
svc.emit('event', 'edge', { event: 'edge', offset: 0.5, side: 'left', drag: { paths: ['C:\\a.txt'] } });
assert.strictEqual(app.pop()[1].drag.paths[0], 'C:\\a.txt');
assert.deepStrictEqual([strip().capturing, strip().cross], [true, cross + 1]);
svc.emit('event', 'captureEnded', { event: 'captureEnded' });
assert.strictEqual(strip().capturing, false);
h.send('place', { side: 'left', offset: 0.5 });
assert.strictEqual(strip().cross, cross + 2, 'arrived: the strip waits until the pointer leaves the edge');

// Ours started again while the service has them: quiet again, and its strip told again.
const before = h.own.length;
h._fromOwn = true;
h.emit('ready');
h._fromOwn = false;
const again = h.own.slice(before).map(([c]) => c);
assert.ok(again.includes('capture') && again.includes('dragStrip'));

// The service goes: the strip is our own capture's again.
svc.connected = false;
svc.emit('exit');
const sentBefore = svc.sent.length;
assert.strictEqual(strip().on, false);
h._fromOwn = true;
h.emit('event', 'dragCross', { paths: ['x'] });
h._fromOwn = false;
assert.strictEqual(svc.sent.length, sentBefore, 'no service: nothing sent on');

console.log('fullkvm-drag: ok');

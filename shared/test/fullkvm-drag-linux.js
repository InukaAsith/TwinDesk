// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Full KVM on Linux (shared/fullkvm/route.js), Wayland: the service's helper (root, no X display of
// ours) says where the drag strip goes (dragStrip events); ours shows it (linux-helper/src/wlstrip.c,
// XWayland), and the drag it catches goes to the service (dragCross, with its paths as text).
'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const path = require('path');
process.env.TWINDESK_KVM_SOCK = path.join(__dirname, 'no-such-kvm.sock');
Object.defineProperty(process, 'platform', { value: 'linux' });

class Base extends EventEmitter {
  constructor() { super(); this.own = []; this.proc = {}; }
  send(cmd, args) { this.own.push([cmd, args]); return true; }
  request() { return Promise.resolve({}); }
}
const Helper = require('../fullkvm/route.js')(Base);

(async () => {
  const h = new Helper();
  h.svc.stop();
  const svc = Object.assign(new EventEmitter(), { connected: true, sent: [], send(cmd, args) { this.sent.push([cmd, args]); return true; }, request(cmd, args) { this.sent.push([cmd, args]); return Promise.resolve({ ok: true }); } });
  for (const ev of ['ready', 'event', 'exit']) for (const fn of h.svc.listeners(ev)) svc.on(ev, fn);
  h.svc.removeAllListeners();
  h.svc = svc;
  const app = [];
  h.on('event', (name, msg) => app.push(name));
  svc.emit('ready');
  assert.ok(!h.own.some(([c]) => c === 'dragStrip'), 'no Windows strip state on Linux');

  // The service's helper wants the strip on the right edge: ours shows it, the app doesn't hear it.
  const want = { event: 'dragStrip', on: true, x: 1078, y: 0, w: 2, h: 1920, side: 'right', back: false };
  svc.emit('event', 'dragStrip', want);
  assert.deepStrictEqual(h.own.pop(), ['dragStrip', want]);
  assert.deepStrictEqual(app, []);
  svc.emit('event', 'dragStrip', { event: 'dragStrip', on: false });
  assert.deepStrictEqual(h.own.pop()[1].on, false);

  // Ours caught a drag there: to the service, its paths as text (the helper's JSON reader skips arrays).
  h._fromOwn = true;
  h.emit('event', 'dragCross', { event: 'dragCross', side: 'right', back: false, pathsText: '/home/me/a.txt\n/home/me/b c.pdf' });
  h._fromOwn = false;
  assert.deepStrictEqual(svc.sent.pop(), ['dragCross', { side: 'right', back: false, pathsText: '/home/me/a.txt\n/home/me/b c.pdf' }]);
  assert.deepStrictEqual(app, [], 'the app never hears it');

  // Its edge with the drag reaches the app as any edge.
  svc.emit('event', 'edge', { event: 'edge', side: 'right', offset: 0.5, drag: { paths: ['/home/me/a.txt'] } });
  assert.deepStrictEqual(app, ['edge']);
  console.log('fullkvm-drag-linux: ok');
})().catch((e) => { console.error(e); process.exit(1); });

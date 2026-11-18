// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Remote › Real gamepad (shared/phone-remote.js): remote.pad as the feed's 12 bytes; the driver is
// loaded only when it's turned on, installs when it isn't yet, and its feed runs only while the
// phone is connected; what's held is let go (zeros) when the page closes or the phone goes.
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { PhoneRemote, padBytes } = require('../phone-remote.js');

// The bytes.
const b = padBytes({ b: 1 | (1 << 13), lx: -1, ly: 1, rx: 0.5, ry: 2, lt: 1, rt: 0.5 });
assert.strictEqual(b.length, 12);
assert.strictEqual(b.readUInt16LE(0), 0x2001);
assert.strictEqual(b.readInt16LE(2), -32767);
assert.strictEqual(b.readInt16LE(4), 32767);
assert.strictEqual(b.readInt16LE(6), 16384);
assert.strictEqual(b.readInt16LE(8), 32767); // kept in range
assert.deepStrictEqual([b[10], b[11]], [255, 128]);
assert.strictEqual(padBytes({ b: 0xffff }).readUInt16LE(0), 0x3fff); // 14 buttons only
assert.ok(padBytes({ lx: 'x' }).equals(Buffer.alloc(12)));

(async () => {
  const sent = [];
  const server = Object.assign(new EventEmitter(), { current: { os: 'android' }, sendToClient: (m) => sent.push(m) });
  const settings = { remote: { allow: true } };
  const written = [];
  let loads = 0, installs = 0, installed = false, ended = 0;
  const feeds = []; // the controller kind each feed was started with
  const driver = {
    name: 'Xbox 360 controller',
    kinds: ['xbox', 'ds4'],
    check: async () => ({ supported: true, installed }),
    install: async () => { installs++; installed = true; },
    feed: (_onExit, kind) => {
      feeds.push(kind);
      const p = new EventEmitter();
      p.stdin = { write: (buf) => written.push(Buffer.from(buf)), end: () => ended++ };
      p.kill = () => {};
      return p;
    },
  };
  const r = new PhoneRemote({ server, helper: { send: () => {} }, getSettings: () => settings, atHome: () => true, loadPad: () => { loads++; return driver; } });
  const tick = () => new Promise((res) => setImmediate(res));

  server.emit('t:remote.hello', {});
  await tick();
  assert.strictEqual(loads, 0, 'not loaded while off');
  assert.strictEqual(sent.pop().pad, false);

  r.setPad(true);
  await tick(); await tick(); await tick();
  assert.strictEqual(loads, 1);
  assert.strictEqual(installs, 1, 'installed the first time');
  assert.ok(r.padProc, 'feeding');
  assert.strictEqual(sent.pop().pad, true);
  assert.deepStrictEqual(r.view.pad, { on: true, supported: true, live: true, busy: '', message: '', name: 'Xbox 360 controller', kind: 'xbox', kinds: ['xbox', 'ds4'] });
  // A PlayStation controller instead (#266): plugged in again as one.
  r.setPadKind('ds4');
  assert.strictEqual(settings.remote.padKind, 'ds4');
  await new Promise((res) => setTimeout(res, 350)); await tick(); await tick(); await tick();
  assert.deepStrictEqual(feeds, ['xbox', 'ds4']);
  assert.strictEqual(r.view.pad.name, 'DualShock 4');
  assert.ok(r.padProc, 'feeding again');
  written.length = 0; ended = 0; // the first one's release, before the second

  server.emit('t:remote.pad', { b: 1, lx: 1 });
  assert.strictEqual(written.length, 1);
  assert.strictEqual(written[0].readUInt16LE(0), 1);

  // Not taken while this computer's mouse is elsewhere.
  r.atHome = () => false;
  server.emit('t:remote.pad', { b: 2 });
  assert.strictEqual(written.length, 1);
  r.atHome = () => true;

  // The page closed: everything let go.
  server.emit('t:remote.release', {});
  assert.ok(written.pop().equals(Buffer.alloc(12)));

  // The phone went: the controller unplugged.
  server.emit('closed');
  assert.strictEqual(r.padProc, null);
  assert.strictEqual(ended, 1);

  // Off: not started again when the phone comes back.
  r.setPad(false);
  server.emit('t:remote.hello', {});
  await tick(); await tick();
  assert.strictEqual(r.padProc, null);
  assert.strictEqual(settings.remote.pad, false);

  // An install that fails: off again, and why.
  installed = false;
  driver.install = async () => { throw new Error('The administrator prompt was declined'); };
  r.setPad(true);
  await tick(); await tick(); await tick();
  assert.strictEqual(settings.remote.pad, false);
  assert.strictEqual(r.view.pad.message, 'The administrator prompt was declined');
  assert.strictEqual(r.padProc, null);

  // The Mac: none, and why.
  const mac = new PhoneRemote({ server, helper: { send: () => {} }, getSettings: () => ({}), atHome: () => true, padNote: 'not on a Mac' });
  assert.deepStrictEqual([mac.view.pad.supported, mac.view.pad.message], [false, 'not on a Mac']);

  console.log('phone-remote-pad: passed');
})().catch((e) => { console.error(e); process.exit(1); });

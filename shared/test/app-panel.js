// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { once } = require('node:events');
const { PassThrough } = require('node:stream');
const { AppPanel } = require('../../mac/app-panel.js');
const { Session, TYPE } = require('../../mac/scrcpy.js');
const { ANDROID } = require('../../mac/android-keys.js');

function fixture() {
  let awake = false;
  let locked = true;
  const writes = [];
  const socket = { readyState: 1 };
  const server = {
    get current() { return { deviceId: 'phone', os: 'android', authed: true, conn: this.socket }; },
    socket,
  };
  const control = {
    serial: 'first',
    tap(code) { writes.push(code); awake = true; },
    setDisplayPower(on) { writes.push(on); },
    adb: {
      async shell(_serial, command) {
        const out = command === 'dumpsys power' ? `mWakefulness=${awake ? 'Awake' : 'Dozing'}`
          : command === 'dumpsys window policy' ? `KeyguardServiceDelegate\n  showing=${locked}`
          : command === 'dumpsys trust' ? `User "Owner" (id=0, flags=0x4c13) (current): deviceLocked=${locked ? 1 : 0}`
          : 'Display #5 (activities from top to bottom):\n  ActivityRecord{123 u0 com.example.app/.Main t6}';
        return { code: 0, out };
      },
    },
  };
  const bridge = { serial: 'first', control };
  return { server, bridge, panel: new AppPanel(bridge, server), writes, unlock: () => { locked = false; } };
}

test('wake once, blank after an app frame, and keep the panel off until the last window closes', async () => {
  const f = fixture();
  const first = {}, second = {};
  const lease = f.panel.begin(first);
  assert.ok(lease);
  assert.equal(await f.panel.waitUnlocked(lease, () => true, f.unlock), true);
  assert.deepEqual(f.writes, [ANDROID.WAKEUP]);
  const capture = { log: ['[server] INFO: New display: 832x1664/320 (id=5)'], ...lease.control };
  assert.equal(await f.panel.waitForApp(capture, 'com.example.app', () => true), true);
  assert.equal(f.panel.blank(lease, first), true);

  assert.equal(f.panel.begin(second), lease);
  assert.equal(await f.panel.waitUnlocked(lease, () => true, () => assert.fail('already unlocked')), true);
  assert.equal(f.panel.blank(lease, second), false);
  f.panel.remove(first);
  assert.deepEqual(f.writes, [ANDROID.WAKEUP, false]);
  f.panel.remove(second);
  assert.deepEqual(f.writes, [ANDROID.WAKEUP, false, true]);
});

test('a replaced socket cannot wake, blank, or send display commands to a replacement controller', async () => {
  const f = fixture();
  const view = {};
  const lease = f.panel.begin(view);
  const ready = f.panel.waitUnlocked(lease, () => true, () => assert.fail('retired'));
  f.server.socket = { readyState: 1 }; // mesh and direct can both reconnect as the same paired phone
  assert.equal(await ready, false);
  assert.equal(f.panel.blank(lease, view), false);
  assert.deepEqual(f.writes, []);

  const next = f.panel.begin(view);
  assert.equal(f.panel.blank(next, view), true);
  f.bridge.control = { serial: 'first', setDisplayPower: () => assert.fail('restore targeted replacement') };
  f.panel.release();
  assert.deepEqual(f.writes, [false]);
});

test('flex resizes wait for actual video and flush only the last pre-frame size', async () => {
  const session = new Session({}, 'phone', { newDisplay: '800x1600/320', flex: true });
  session.video = new PassThrough();
  session.sockets.push(session.video);
  const commands = [];
  session._send = (b) => commands.push([b[0], b.readUInt16BE(1), b.readUInt16BE(3)]);
  session._readStreams('video');
  const header = Buffer.alloc(68);
  header.writeUInt32BE(0x68323634, 64);
  session.video.write(header);
  session.resizeDisplay(640, 1200);
  session.resizeDisplay(720, 1280);
  const packet = (flags) => {
    const b = Buffer.alloc(13);
    b.writeBigUInt64BE(flags);
    b.writeUInt32BE(1, 8);
    return b;
  };
  let received = once(session, 'video');
  session.video.write(packet(1n << 62n));
  await received;
  assert.deepEqual(commands, []);
  received = once(session, 'video');
  session.video.write(packet(1n << 61n));
  await received;
  assert.deepEqual(commands, [[TYPE.RESIZE_DISPLAY, 720, 1280]]);
  session.stop();
});

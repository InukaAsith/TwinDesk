// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const vm = require('node:vm');
const P = require('../protocol.js');
const { ProximityLock } = require('../proximity-lock.js');

const phone = (deviceId = 'phone') => ({ deviceId, os: P.OS.ANDROID, authed: true });
const fresh = (f, ctx = phone()) => { f.lock.connected(ctx); return ctx; };
const drop = (f, ctx = fresh(f)) => f.lock.disconnected(ctx, true);

function fixture(options = {}) {
  const f = { enabled: true, available: true, opens: 0, hides: 0, locks: [], ticks: [] };
  let now = 0, timer = null;
  f.lock = new ProximityLock({
    ...(options.defaultOff ? {} : { enabled: () => f.enabled }),
    canLock: () => f.available,
    now: () => now,
    setTimer(fn, ms) { return timer = { at: now + ms, fn }; },
    clearTimer(t) { if (timer === t) timer = null; },
    prompt: {
      show(prompt) {
        assert.equal(prompt.seconds, 15);
        f.opens++;
        f.prompt = prompt;
        if (!options.deferPrompt) prompt.ready();
      },
      update(seconds) { f.ticks.push(seconds); },
      hide() { f.hides++; },
    },
    lock: () => f.locks.push(now),
  });
  f.advance = (ms) => {
    const until = now + ms;
    while (timer && timer.at <= until) {
      const { at, fn } = timer;
      timer = null;
      now = at;
      fn();
    }
    now = until;
  };
  return f;
}

test('an unexpected authenticated loss gives the visible prompt 15 seconds and locks once', () => {
  const f = fixture({ deferPrompt: true });
  const old = fresh(f);
  drop(f, old);
  assert.equal(f.opens, 1);
  f.advance(5000);
  assert.deepEqual(f.ticks, [], 'a slow renderer cannot run down the countdown');
  f.prompt.ready();
  f.advance(14999);
  assert.deepEqual(f.ticks, Array.from({ length: 15 }, (_, i) => 15 - i));
  assert.deepEqual(f.locks, []);
  f.advance(1);
  assert.deepEqual(f.locks, [20000]);
  assert.equal(f.hides, 1);
  drop(f, old);
  f.advance(30000);
  assert.deepEqual(f.locks, [20000], 'repeated closes cannot lock again');
});

test('cancellation consumes the attempt and only a fresh authenticated phone can rearm', async (t) => {
  await t.test('opt-in defaults off and enabling cannot act on the previous drop', () => {
    const f = fixture({ defaultOff: true });
    drop(f);
    f.advance(15000);
    assert.equal(f.opens, 0);

    const g = fixture();
    g.enabled = false;
    const ctx = fresh(g);
    drop(g, ctx);
    g.enabled = true;
    drop(g, ctx);
    assert.equal(g.opens, 0);
  });

  for (const [name, cancel] of [
    ['Cancel or Escape', (f) => f.prompt.cancel()],
    ['paired phone reconnects', (f) => fresh(f)],
    ['Forget', (f) => f.lock.forget('phone')],
    ['manual disconnect', (f) => f.lock.cancel()],
    ['setting switched off', (f) => { f.enabled = false; f.lock.cancel(); }],
    ['suspend', (f) => f.lock.reset()],
    ['lock-screen', (f) => f.lock.reset()],
    ['unlock-screen', (f) => f.lock.reset()],
    ['quit or mode switch', (f) => f.lock.shutdown()],
  ]) {
    await t.test(name, () => {
      const f = fixture();
      const old = fresh(f);
      drop(f, old);
      f.advance(8000);
      cancel(f);
      assert.equal(f.hides, 1, 'prompt is dismissed immediately');
      drop(f, old);
      f.advance(30000);
      assert.equal(f.opens, 1);
      assert.deepEqual(f.locks, []);
    });
  }

  await t.test('stale prompts, connections and closes cannot cancel or rearm a fresh attempt', () => {
    const f = fixture({ deferPrompt: true });
    const old = fresh(f);
    drop(f, old);
    const oldPrompt = f.prompt;
    oldPrompt.cancel();
    const replacement = fresh(f);
    drop(f, old);
    assert.equal(f.opens, 1);
    drop(f, replacement);
    oldPrompt.ready();
    oldPrompt.cancel();
    f.advance(20000);
    assert.deepEqual(f.locks, []);
    f.prompt.ready();
    f.advance(15000);
    assert.deepEqual(f.locks, [35000]);
  });

  await t.test('only unreleased phone sessions qualify and a second phone prevents a prompt', () => {
    const f = fixture();
    for (const ctx of [{ ...phone(), authed: false }, { ...phone(), authed: undefined }, { ...phone(), os: P.OS.WIN }, { ...phone(), os: P.OS.MAC }]) {
      fresh(f, ctx);
      drop(f, ctx);
    }
    const released = fresh(f);
    released.released = true;
    drop(f, released);
    const expected = fresh(f);
    f.lock.disconnected(expected, false);
    const stale = fresh(f);
    f.lock.reset();
    drop(f, stale); // a close delivered after a suspend, lock or unlock
    const forgot = fresh(f);
    f.lock.forget(forgot.deviceId);
    drop(f, forgot);
    const preReplacement = fresh(f);
    const replacement = fresh(f);
    drop(f, preReplacement);
    const other = fresh(f, { ...phone('second'), os: P.OS.IOS });
    drop(f, replacement);
    assert.equal(f.opens, 0);
    drop(f, other);
    assert.equal(f.opens, 1);
  });

  await t.test('guards are checked at start and again at expiry', () => {
    const f = fixture();
    f.available = false; // locked/asleep or another session already present
    drop(f);
    assert.equal(f.opens, 0);
    f.available = true;
    drop(f);
    f.advance(14999);
    f.available = false;
    f.advance(1);
    assert.equal(f.hides, 1);
    assert.deepEqual(f.locks, []);
  });
});

function hostFixture(platform, mesh) {
  const { Server } = require(`../../${platform}/${mesh ? 'mesh/' : ''}server.js`);
  const server = Object.setPrototypeOf(new EventEmitter(), Server.prototype);
  Object.assign(server, {
    sockets: new Set(), blePorts: new Map(), _arm() {}, _now: Date.now, _phoneGrace() {},
    wss: { close() {} }, https: { close() {} },
    ...(mesh ? { clients: new Map(), authSeq: 0, ilPool: { drop() {}, close() {} } } : { current: null }),
  });
  const socket = (remoteAddress = '127.0.0.1', remotePort = 0) => {
    const ws = Object.assign(new EventEmitter(), {
      OPEN: 1, readyState: 1, send() {}, close() { this.readyState = 3; }, terminate() { this.close(); },
    });
    server._onConnection(ws, { socket: { remoteAddress, remotePort } });
    return ws;
  };
  const authenticate = (ws) => server.authenticate(ws.ctx, { deviceId: 'phone', os: P.OS.ANDROID, name: 'Phone' }, {});
  const hello = (...args) => { const ws = socket(...args); authenticate(ws); return ws; };
  const close = (ws, code = 1006) => { ws.close(); ws.emit('close', code); };
  return { server, socket, authenticate, hello, close };
}

for (const platform of ['mac', 'windows', 'linux']) for (const mesh of [false, true]) {
  test(`${platform} ${mesh ? 'Multi-device' : 'one-to-one'} server classifies close events`, () => {
    const { server, socket, hello, close } = hostFixture(platform, mesh);
    const f = fixture();
    const classified = [];
    server.on('client', (ctx) => f.lock.connected(ctx));
    server.on('closed', (ctx, unexpected) => { classified.push(unexpected); f.lock.disconnected(ctx, unexpected); });
    server.on('forget', (id) => f.lock.forget(id));

    close(socket()); // unauthenticated
    close(hello(), 1000); // graceful closure without BYE
    const bye = hello();
    bye.emit('message', Buffer.from('{"t":"bye"}'), false);
    close(bye); // ungraceful close after a deliberate BYE
    const released = hello();
    server.release();
    close(released);
    if (mesh) {
      const phoneReleased = hello();
      server.releasePhone(phoneReleased.ctx);
      close(phoneReleased);
    }
    const refused = hello();
    server.fail(refused.ctx, P.E.BAD_MESSAGE, 'protocol failure');
    close(refused);
    const forgotten = hello();
    server.closeDevice('phone', P.E.BAD_TOKEN, 'forgotten');
    close(forgotten);
    const previous = hello();
    server.blePorts.set(12345, 'phone');
    const attached = hello();
    close(previous);
    const moved = socket('127.0.0.1', 12345);
    server._resume(moved.ctx, { id: 'phone', resume: attached.ctx.resumeKey });
    assert.equal(moved.ctx.transport, 'ble');
    const beforeFallback = classified.length;
    close(moved); // the current Bluetooth path goes, but its IP fallback is alive
    assert.equal(classified.length, beforeFallback, 'a transport fallback is not a session close');
    assert.equal(attached.ctx.transport, 'ip');
    assert.ok(classified.every((unexpected) => unexpected === false));
    assert.equal(f.opens, 0);
    close(attached); // genuine loss of the very same authenticated session
    assert.equal(classified.at(-1), true);
    assert.equal(f.opens, 1);
    server.closeDevice('phone', P.E.BAD_TOKEN, 'forgotten while disconnected');
    assert.equal(f.hides, 1);
    f.advance(15000);
    assert.deepEqual(f.locks, []);
    const shuttingDown = hello();
    server.close();
    close(shuttingDown);
    assert.equal(classified.at(-1), false);
    assert.equal(f.opens, 1);
  });
}

function loadShared(file, stubs) {
  const filename = require.resolve(`../${file}.js`);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(filename, 'utf8'), {
    module, process, console, require: (name) => stubs[name] || localRequire(name),
  }, { filename });
  return module.exports;
}

test('desktop guard suppresses deferred replacements, intentional network stops and stale sessions after wake', async () => {
  for (const platform of ['windows', 'linux']) for (const mesh of [false, true]) {
    const host = hostFixture(platform, mesh);
    const { server, hello, close } = host;
    const powerMonitor = Object.assign(new EventEmitter(), { getSystemIdleState: () => 'active' });
    let prompt, tick;
    let now = 0;
    const locks = [];
    let locked = false;
    const sessionPath = '/org/freedesktop/login1/session/_31';
    const monitor = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill() { this.stdout.end(); } });
    const { watchLinuxSession } = loadShared('proximity-lock-linux', {
      child_process: {
        execFileSync: (_, args) => args.includes('org.freedesktop.login1.Manager.GetSession')
          ? `(objectpath '${sessionPath}',)`
          : `({'Id': <'1'>, 'Type': <'wayland'>, 'Active': <true>, 'LockedHint': <${locked}>},)`,
        spawn: () => monitor,
      },
    });
    const { installProximityLock } = loadShared('proximity-lock-desktop', {
      electron: { powerMonitor },
      './proximity-lock.js': {
        ...require('../proximity-lock.js'),
        ProximityLock: class extends ProximityLock {
          constructor(options) {
            super({ ...options, now: () => now, setTimer: (fn) => { tick = fn; return fn; }, clearTimer: () => { tick = null; } });
          }
        },
      },
      './proximity-lock-prompt.js': { countdownPrompt: () => ({ show: (p) => { prompt = p; }, update() {}, hide: () => { prompt = null; } }) },
      './proximity-lock-linux.js': { watchLinuxSession },
    });
    let bleQuiet = false;
    const occupiedSeen = [];
    const service = installProximityLock({ server, pairing: { list: () => [{ id: 'phone', os: P.OS.ANDROID }] },
      settings: { app: { proximityLock: true } }, i18n: {},
      occupied: (ctx) => {
        assert.ok(ctx && typeof ctx.transport === 'string', 'occupied receives the closing session ctx');
        occupiedSeen.push(ctx.transport);
        return bleQuiet && ctx.transport === 'ble';
      },
      onChange() {},
      local: { os: platform === 'windows' ? 'win32' : 'linux', can: () => ({ lock: true }), async do(command) { locks.push(command.do); } },
    });
    if (platform === 'linux') {
      assert.equal(service.supported, false, 'the monitor must first subscribe to logind');
      monitor.stdout.write('The name org.freedesktop.login1 is owned by :1.1\n');
    }
    assert.equal(service.supported, true);
    try {
      const existing = hello();
      const replacement = host.socket();
      replacement.ctx.fxWanted = replacement.ctx.fx2Wanted = server.fxOn = true;
      let complete;
      server.fx2Wait = () => new Promise((resolve) => { complete = resolve; });
      host.authenticate(replacement);
      assert.equal(replacement.ctx.pendingId, 'phone');
      assert.equal(replacement.ctx.authed, false);
      close(existing);
      assert.equal(prompt, undefined);
      complete();
      await Promise.resolve();
      assert.equal(replacement.ctx.authed, true);

      powerMonitor.emit('suspend');
      powerMonitor.emit('resume');
      close(replacement);
      assert.equal(prompt, undefined, 'a pre-sleep session is disarmed');
      const beforeLock = hello();
      if (platform === 'linux') {
        for (const value of [true, false]) {
          locked = value;
          monitor.stdout.write(`${sessionPath}: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'LockedHint': <${value}>}, @as [])\n`);
        }
      } else {
        powerMonitor.emit('lock-screen');
        powerMonitor.emit('unlock-screen');
      }
      close(beforeLock);
      assert.equal(prompt, undefined, 'a session from before the screen locked is disarmed');

      const group = hello('192.168.43.1');
      service.wifiDown();
      close(group);
      server.blePorts.set(12345, 'phone');
      const bluetooth = hello('127.0.0.1', 12345);
      service.bluetoothOff();
      close(bluetooth);
      assert.equal(prompt, undefined, 'intentional Wi-Fi and Bluetooth shutdowns are disarmed');

      server.blePorts.set(12346, 'phone');
      const quietBle = hello('127.0.0.1', 12346);
      bleQuiet = true;
      close(quietBle);
      bleQuiet = false;
      assert.equal(prompt, undefined, 'BLE drop during BLE quiet/handoff is suppressed via occupied(ctx)');
      assert.ok(occupiedSeen.includes('ble'), 'occupied inspected the BLE ctx transport');

      close(hello());
      assert.equal(prompt.seconds, 15, 'a fresh authenticated session can arm again');
      const reconnected = hello();
      assert.equal(prompt, null, 'reconnecting cancels the pending lock');
      assert.deepEqual(locks, []);
      close(reconnected);
      prompt.ready();
      now += 15000;
      tick();
      assert.deepEqual(locks, ['lock']);
    } finally {
      service.shutdown();
    }
  }
});

test('Linux without native locking cannot show a prompt or attempt a lock', () => {
  const { server, hello, close } = hostFixture('linux', false);
  const powerMonitor = Object.assign(new EventEmitter(), { getSystemIdleState: () => 'active' });
  const { installProximityLock } = loadShared('proximity-lock-desktop', {
    electron: { powerMonitor },
    './proximity-lock-prompt.js': { countdownPrompt: () => ({ show: () => assert.fail('unsupported lock showed a prompt') }) },
    './proximity-lock-linux.js': { watchLinuxSession: () => assert.fail('unsupported lock began monitoring') },
  });
  const service = installProximityLock({ server, pairing: { list: () => [{ id: 'phone', os: P.OS.ANDROID }] },
    settings: { app: { proximityLock: true } }, i18n: {}, occupied: () => false,
    local: { os: 'linux', can: () => ({ lock: false }), do: () => assert.fail('unsupported native lock was attempted') },
  });
  try {
    assert.equal(service.supported, false);
    close(hello());
  } finally {
    service.shutdown();
  }
});

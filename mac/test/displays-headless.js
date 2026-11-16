// TwinDesk — Copyright (C) 2026. GPL-3.0, see LICENSE.
// Run with: node --test mac/test/displays-headless.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const Module = require('module');
const screen = new EventEmitter();
let all = [], sources = [], permission = 'granted';
screen.getAllDisplays = () => all;
screen.getPrimaryDisplay = () => all[0] || { id: -1 };
const ipcMain = new EventEmitter();
ipcMain.handle = () => {};
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { screen, ipcMain, BrowserWindow: class {}, webContents: {},
    session: { defaultSession: { setDisplayMediaRequestHandler() {} } },
    desktopCapturer: { getSources: async () => sources },
    systemPreferences: { getMediaAccessStatus: () => permission } };
  if (request.endsWith('audiohub.js')) return { loopback: () => true };
  return originalLoad.apply(this, arguments);
};
const { Displays } = require('../displays');
const streams = [require('../stream').Stream, require('../mesh/stream').Stream];
Module._load = originalLoad;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const display = id => ({ id, label: 'Display', size: { width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 });
function setup(request) {
  const helper = new EventEmitter();
  helper.request = request;
  const settings = { sharing: { on: true, displayId: 1 }, virtual: { enabled: false, width: 1920, height: 1080 }, streamMaxHeight: 1080 };
  return { settings, displays: new Displays(helper, () => settings) };
}
function makeStream(Type, displays, settings) {
  const server = new EventEmitter(); server.current = { os: 'android', transport: 'ip' }; server.sendToClient = () => {};
  const stream = new Type(server, displays, () => settings, { release() {}, loopback() {} });
  const sent = [];
  stream._ensureWindow = async () => { stream.win = { isDestroyed: () => false, webContents: { send: (channel, msg) => sent.push({ channel, msg }) } }; };
  return { stream, sent };
}
function cleanup(displays) { clearTimeout(displays.changeTimer); clearTimeout(displays.sourceProbeTimer); clearTimeout(displays.fallbackStableTimer); screen.removeAllListeners(); }

test('last monitor removal creates a temporary exact capture target and restores the saved display', async () => {
  for (const Type of streams) {
    all = [display(1)]; sources = [{ id: 'screen:1', display_id: '1' }]; permission = 'granted';
    let creates = 0, destroys = 0;
    const { settings, displays } = setup(async command => {
      if (command === 'createDisplay') { creates++; all = [display(2)]; sources = [{ id: 'screen:2', display_id: '2' }]; screen.emit('display-added', {}, all[0]); return { displayId: 2 }; }
      destroys++; all = all.filter(d => d.id !== 2);
    });
    const snapshot = JSON.stringify(settings);
    const { stream, sent } = makeStream(Type, displays, settings);
    await stream.restart('initial');
    all = [{ id: -1, size: { width: 0, height: 0 } }, { id: 0, size: { width: 0, height: 0 } }]; sources = [];
    await stream.restart('last removed');
    assert.equal(stream.active, null);
    assert.equal(displays.list().length, 0, 'placeholder never becomes input/capture target');
    await wait(700);
    assert.equal(creates, 1);
    assert.equal(stream.active.displayId, 2, 'late display recovers an inactive stream');
    assert.equal(sent.filter(m => m.channel === 'start').at(-1).msg.sourceId, 'screen:2');
    all.unshift(display(1)); sources.unshift({ id: 'screen:1', display_id: '1' }); screen.emit('display-added', {}, all[0]);
    await wait(700);
    assert.equal(destroys, 1);
    assert.equal(stream.active.displayId, 1);
    assert.equal(JSON.stringify(settings), snapshot);
    stream.stop(); clearTimeout(stream.dropTimer); cleanup(displays);
  }
  // A usable display can briefly disappear only from capture enumeration. It must recover
  // without unplugging it, and probing must not repeatedly destroy the temporary display.
  all = [display(1)]; sources = [];
  let destroyed = 0;
  const { settings, displays } = setup(async command => {
    if (command === 'createDisplay') { all.push(display(2)); sources = [{ id: 'screen:2', display_id: '2' }]; return { displayId: 2 }; }
    destroyed++; all = all.filter(d => d.id !== 2);
  });
  const before = JSON.stringify(settings);
  displays.captureWanted('viewer', true);
  displays.uncapturable(1);
  await wait(500);
  assert.equal(displays.target().id, 2);
  assert.equal(displays.fallbackOnly(), true);
  displays.holds.add('apps'); assert.equal(displays.fallbackOnly(), false); displays.holds.clear();
  sources.push({ id: 'screen:1', display_id: '1' });
  await wait(2100);
  assert.equal(displays.target().id, 1);
  assert.equal(destroyed, 1);
  assert.equal(JSON.stringify(settings), before);
  displays.captureWanted('viewer', false); cleanup(displays);

});

test('fallback failure is bounded and Stop during creation releases it without starting capture', async () => {
  all = []; sources = []; permission = 'granted';
  let cycles = 0;
  const cycle = setup(async command => {
    if (command === 'createDisplay') { cycles++; all = [display(2)]; return { displayId: 2 }; }
    all = [];
  });
  for (let i = 0; i < 4; i++) {
    cycle.displays.captureWanted('viewer', true);
    await wait(400);
    assert.equal(cycle.displays.virtualId, 2, 'each new viewer session can create a fallback');
    cycle.displays.captureWanted('viewer', false);
    await wait(400);
  }
  assert.equal(cycles, 4);
  cleanup(cycle.displays);
  all = [display(1)]; sources = [];
  const metrics = setup(async command => {
    if (command === 'createDisplay') { all.push(display(2)); return { displayId: 2 }; }
    all = all.filter(d => d.id !== 2);
  });
  metrics.displays.captureWanted('viewer', true);
  metrics.displays.uncapturable(1);
  await wait(500);
  screen.emit('display-metrics-changed', {}, display(1));
  await wait(500);
  assert.equal(metrics.displays.dead.has(1), true, 'metrics changes do not revive an uncapturable display');
  metrics.displays.sourceProbes = 3;
  metrics.displays.captureWanted('viewer', false);
  assert.equal(metrics.displays.dead.has(1), false, 'closing the last viewer permits a fresh source check');
  assert.equal(metrics.displays.sourceProbes, 0);
  cleanup(metrics.displays);
  all = []; sources = []; permission = 'granted';
  let creates = 0;
  let f = setup(async () => { creates++; throw new Error('unavailable'); });
  f.displays.captureWanted('viewer', true);
  await wait(1300);
  assert.equal(creates, 3);
  await wait(400); assert.equal(creates, 3);
  f.displays.captureWanted('viewer', false); cleanup(f.displays);
  permission = 'denied'; creates = 0;
  f = setup(async () => { creates++; }); f.displays.captureWanted('viewer', true);
  await wait(50); assert.equal(creates, 0); cleanup(f.displays);
  permission = 'granted';
  for (const Type of streams) {
    all = [display(1)]; sources = [{ id: 'wrong-screen', display_id: '99' }];
    const d = new EventEmitter(); d.target = () => ({ id: 1, pixelWidth: 1920, pixelHeight: 1080 });
    d.list = () => [{ id: 1 }];
    const { stream, sent } = makeStream(Type, d, { sharing: { on: true } });
    await stream.restart('missing source');
    assert.equal(sent.some(m => m.channel === 'start'), false, 'never capture another display');
    assert.equal(stream.awaitingDisplay, true);
    assert.equal(stream.retryTimer == null || stream.retryTimer._destroyed, true, 'wait for display change instead of retrying');
    stream.stop(); clearTimeout(stream.dropTimer);
  }
  for (const Type of streams) {
    all = []; sources = [];
    let complete, destroys = 0;
    const { displays, settings } = setup(command => {
      if (command === 'createDisplay') return new Promise(resolve => { complete = () => { all = [display(2)]; resolve({ displayId: 2 }); }; });
      destroys++; all = []; return Promise.resolve();
    });
    const { stream, sent } = makeStream(Type, displays, settings);
    await stream.restart('headless'); await wait(10);
    settings.sharing.on = false; stream.stop(); complete();
    await wait(700);
    assert.equal(destroys, 1); assert.equal(displays.virtualId, null);
    assert.equal(sent.some(m => m.channel === 'start'), false);
    assert.equal(stream.active, null);
    clearTimeout(stream.dropTimer); cleanup(displays);
  }
});

// TwinDesk — Copyright (C) 2026. GPL-3.0, see LICENSE.
// Run with: node --test mac/test/stream-capture.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const Module = require('module');

const originalLoad = Module._load;
const ipcMain = new EventEmitter();
ipcMain.handle = () => {};
let captureSources = [{ id: 'screen:2:0', display_id: '2' }];
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return {
    BrowserWindow: class {}, ipcMain,
    session: { defaultSession: { setDisplayMediaRequestHandler() {} } },
    desktopCapturer: { getSources: async () => captureSources },
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
  };
  if (request === './audiohub.js' || request === '../audiohub.js') return { loopback: () => true };
  return originalLoad.apply(this, arguments);
};
const { Stream } = require('../stream.js');
const { Stream: MeshStream } = require('../mesh/stream.js');

Module._load = originalLoad;

test('passes selected display, bounded dimensions and audio to the capture window', async () => {
  for (const Class of [Stream, MeshStream]) {
    const server = new EventEmitter();
    const socket = {};
    server.current = { os: 'android', transport: 'ip', conn: socket };
    server.sendToClient = () => {};
    server.outbound = (ctx) => ctx === server.current ? socket : null;
    const displays = new EventEmitter();
    displays.target = () => ({ id: 2, label: 'Display', pixelWidth: 5120, pixelHeight: 2880, hz: 60 });
    const settings = { bitrateMbps: 12, streamMaxHeight: 1080, sharing: { on: true, audio: true } };
    const stream = new Class(server, displays, () => settings, { release() {}, loopback() {} });
    const sent = [];
    stream._ensureWindow = async () => { stream.win = { isDestroyed: () => false, webContents: { send: (channel, msg) => sent.push({ channel, msg }) } }; };
    await stream.restart('test');
    const start = sent.find((entry) => entry.channel === 'start');
    assert.ok(start, 'capture window receives a start message');
    assert.equal(start.msg.sourceId, 'screen:2:0');
    assert.equal(start.msg.width, 1920);
    assert.equal(start.msg.height, 1080);
    assert.equal(start.msg.audio, 'loopback');
    assert.deepEqual(start.msg.detailSource, { width: 5120, height: 2880 });

    const detail = { t: 'rtc.detail', session: start.msg.session, height: 1440 };
    const from = (ws) => server.emit('t:rtc.detail', detail, Class === Stream ? server.current : { source: () => ws }, ws);
    from({});
    assert.equal(sent.length, 1, 'another socket cannot adjust this stream');
    from(socket);
    assert.deepEqual(sent.slice(1), [{ channel: 'remote', msg: detail }]);
    assert.equal(settings.streamMaxHeight, 1080, 'zoom does not change the saved baseline');
  }
});

test('refuses a capture source for a different selected display', async () => {
  const server = new EventEmitter();
  const displays = new EventEmitter();
  displays.target = () => ({ id: 3 });
  const stream = new Stream(server, displays, () => ({}), { release() {}, loopback() {} });
  // A selected display that is not in the capture list is refused. Headless recovery
  // reports NO_DISPLAY and waits, instead of the older "no screens" permission error.
  await assert.rejects(stream._source(), (err) => err && err.code === 'NO_DISPLAY' && /no display to share/.test(err.message));
});

test('does not use an unnamed source for a different remaining display', async () => {
  const server = new EventEmitter();
  const displays = new EventEmitter();
  displays.target = () => ({ id: 3 });
  displays.list = () => [{ id: 2 }];
  const stream = new Stream(server, displays, () => ({}), { release() {}, loopback() {} });
  captureSources = [{ id: 'screen:2:0', display_id: '' }];
  try {
    await assert.rejects(stream._source(), (err) => err && err.code === 'NO_DISPLAY');
  } finally {
    captureSources = [{ id: 'screen:2:0', display_id: '2' }];
  }
});

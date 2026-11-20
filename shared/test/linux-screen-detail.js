// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const codec = require('../screencodec.js');
const P = require('../protocol.js');
const originalLoad = Module._load;
Module._load = function (name) {
  if (name === 'electron') return { BrowserWindow: class {}, ipcMain: new EventEmitter() };
  return originalLoad.apply(this, arguments);
};
const Sender = require('../../linux/sender.js');
Module._load = originalLoad;
const tick = () => new Promise(resolve => setImmediate(resolve));

function renderer() {
  let on;
  const sent = [], sizes = [];
  const track = { applyConstraints: async value => sizes.push(value), stop() {} };
  const stream = { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] };
  class Peer {
    constructor() { this.localDescription = { sdp: '' }; }
    addTransceiver() {
      return { setCodecPreferences() {}, sender: {
        getParameters: () => ({ encodings: [{}] }), setParameters: async () => {},
      } };
    }
    async createOffer() { return { sdp: '' }; }
    async setLocalDescription() {}
    close() {}
  }
  const context = vm.createContext({
    window: { MacShareProtocol: P, TwinDeskScreenCodec: codec, sender: {
      on: fn => { on = fn; }, ready() {}, state() {}, send: msg => sent.push(msg),
    } },
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    RTCPeerConnection: Peer, RTCRtpSender: { getCapabilities: () => ({ codecs: [] }) },
    console, setInterval: () => 1, clearInterval() {}, performance,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../linux/sender-renderer.js'), 'utf8'), context);
  return { context, on: m => on(m), sent, sizes };
}

test('Linux screen advertises source-bound detail and resizes the current capture back to baseline', async () => {
  const f = renderer();
  f.on({ t: 'start', session: 9, width: 1920, height: 1080, fps: 60, mbps: 20,
    detailSource: { width: 3840, height: 2160 }, offer: { kind: 'screen' } });
  await tick();
  assert.deepEqual(f.sent[0].detail, { baseline: 1080, fps: 60, sizes: [
    { width: 2560, height: 1440 }, { width: 3840, height: 2160 },
  ] });
  f.on({ t: 'rtc.detail', session: 9, height: 1440 });
  await tick();
  assert.equal(f.sizes[0].height.max, 1440);
  f.on({ t: 'rtc.detail', session: 9, height: 0 });
  await tick();
  assert.equal(f.sizes[1].height.max, 1080);
  assert.equal(f.sent.length, 1, 'resize retains the offer');
});

test('Linux detail refuses another physical connection, stopped capture and app-window sessions', async () => {
  const link = new EventEmitter(), sent = [];
  let socket = { readyState: 1 };
  link.current = { os: 'android' };
  link.screenSocket = () => socket;
  link.status = { state: 'connected' };
  link.send = () => {};
  const sender = new Sender(link);
  sender._toWin = msg => sent.push(msg);
  const session = sender.start({ width: 1920, height: 1080, offer: { kind: 'screen' },
    detailSource: { width: 3840, height: 2160 } });
  const first = socket, command = { t: 'rtc.detail', session, height: 1440 };
  link.emit('rtc.detail', command, {});
  assert.equal(sent.length, 1);
  link.emit('rtc.detail', command, first);
  assert.equal(sent.length, 2);
  socket = { readyState: 1 };
  link.emit('rtc.detail', command, first);
  assert.equal(sent.length, 2, 'a replacement connection retires quality control');
  sender.stop(session);
  const count = sent.length;
  link.emit('rtc.detail', command, first);
  assert.equal(sent.length, count);
  sender.start({ offer: { kind: 'window' }, detailSource: { width: 3840, height: 2160 } });
  assert.equal(sent.at(-1).detailSource, null);

  const f = renderer();
  f.on({ t: 'start', session: 9, width: 1920, height: 1080, fps: 60, mbps: 20,
    detailSource: { width: 3840, height: 2160 }, offer: { kind: 'screen' } });
  await tick();
  f.on({ t: 'rtc.detail', session: 9, height: 1234 });
  f.on({ t: 'stop', session: 9 });
  f.on({ t: 'rtc.detail', session: 9, height: 1440 });
  await tick();
  assert.equal(f.sizes.length, 0, 'unknown tier and stopped capture cannot resize');
});

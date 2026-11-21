// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const events = new Map(), documentEvents = new Map(), videoEvents = new Map();
  const timers = new Map(), frames = [], peers = [], metrics = [];
  let now = 5000, timerId = 0;
  const video = { videoWidth: 1920, videoHeight: 1080, style: {}, currentTime: 0,
    play: async () => {}, requestVideoFrameCallback: callback => frames.push(callback),
    addEventListener: (event, callback) => videoEvents.set(event, callback) };
  const elements = { video, audio: {}, overlay: { classList: { toggle() {} } },
    kbd: { addEventListener() {}, blur() {}, focus() {} } };
  const window = { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    addEventListener: (event, callback) => events.set(event, callback),
    TD: { send() {}, ready() {}, playing() {}, videoState() {},
      videoMetrics: (generation, session, width, height, fps, kbps, dropped) =>
        metrics.push({ generation, session, width, height, fps, kbps, dropped }) } };
  const document = { hidden: false, getElementById: id => elements[id],
    addEventListener: (event, callback) => documentEvents.set(event, callback),
    documentElement: { addEventListener() {} }, body: { appendChild() {}, classList: { toggle() {} } },
    createElement: () => ({ style: {}, getContext: () => ({ setTransform() {}, clearRect() {} }) }) };
  class Peer {
    constructor() { peers.push(this); this.connectionState = 'connected'; this.localDescription = { sdp: '' }; }
    close() { this.connectionState = 'closed'; }
    async setRemoteDescription() {}
    async addIceCandidate() {}
    async createAnswer() { return {}; }
    async setLocalDescription() {}
    getReceivers() { return []; }
    async getStats() { return this.stats(); }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../android/app/src/main/assets/web/viewer.js'), 'utf8'), {
    window, document, RTCPeerConnection: Peer, MediaStream: class {}, console: { log() {} },
    performance: { now: () => now },
    setTimeout: (callback, wait = 0) => { timers.set(++timerId, { callback, at: now + wait }); return timerId; },
    clearTimeout: id => timers.delete(id), requestAnimationFrame: callback => frames.push(callback),
  });
  const receive = message => window.tdRecv(message);
  const advance = ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.callback();
  };
  const decodedFrame = () => { for (const callback of frames.splice(0)) callback(); };
  const connect = async (session = 1) => {
    receive({ t: 'rtc.offer', session, viewerGeneration: session + 100, sdp: '' });
    await new Promise(resolve => setImmediate(resolve));
    peers.at(-1).ontrack({ track: { kind: 'video' }, receiver: {} });
    videoEvents.get('playing')();
    decodedFrame();
  };
  return { peers, metrics, receive, advance, decodedFrame, connect, document, documentEvents };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

async function measuredRates() {
  const f = fixture();
  await f.connect();
  let count = 0;
  f.peers[0].stats = async () => {
    count++;
    return new Map([['in', { id: 'video', type: 'inbound-rtp', kind: 'video',
      timestamp: count * 2000, framesDecoded: count * 120, bytesReceived: count * 250000, framesDropped: count }]]);
  };
  f.advance(2000); await tick();
  assert.deepEqual(f.metrics[0], { generation: 101, session: 1, width: 1920, height: 1080, fps: -1, kbps: -1, dropped: 1 });
  f.advance(2000); await tick();
  assert.deepEqual(f.metrics[1], { generation: 101, session: 1, width: 1920, height: 1080, fps: 60, kbps: 1000, dropped: 2 });
  f.receive({ t: 'stream.stop' });
  f.advance(10000); await tick();
  assert.equal(count, 2, 'stopped viewers no longer sample');
}
async function retiredReports() {
  const f = fixture();
  await f.connect();
  let finish;
  f.peers[0].stats = () => new Promise(resolve => { finish = resolve; });
  f.advance(2000);
  await f.connect(2);
  finish(new Map([['in', { type: 'inbound-rtp', kind: 'video', timestamp: 1000, framesDecoded: 60, bytesReceived: 1000 }]]));
  await tick();
  assert.deepEqual(f.metrics, [], 'an old offer cannot report under the replacement');
  f.peers[1].stats = () => new Promise(resolve => { finish = resolve; });
  f.advance(2000);
  f.document.hidden = true;
  f.documentEvents.get('visibilitychange')();
  finish(new Map([['in', { type: 'inbound-rtp', kind: 'video', timestamp: 2000 }]]));
  await tick();
  assert.deepEqual(f.metrics, [], 'backgrounding rejects an in-flight report');
}
async function transientDisconnectRecovers() {
  const f = fixture();
  await f.connect();
  let finish;
  f.peers[0].stats = () => new Promise(resolve => { finish = resolve; });
  f.advance(2000);
  f.peers[0].connectionState = 'connecting';
  finish(new Map([['in', { id: 'video', type: 'inbound-rtp', kind: 'video', timestamp: 1000, framesDecoded: 10, bytesReceived: 1000 }]]));
  await tick();
  assert.deepEqual(f.metrics, []);
  f.peers[0].connectionState = 'connected';
  f.peers[0].stats = async () => new Map([['in', { id: 'video', type: 'inbound-rtp', kind: 'video', timestamp: 3000, framesDecoded: 130, bytesReceived: 251000, framesDropped: 1 }]]);
  f.peers[0].onconnectionstatechange();
  f.decodedFrame();
  f.advance(2000); await tick();
  assert.equal(f.metrics.length, 1, 'polling resumes after transient non-connected getStats');
}
measuredRates().then(retiredReports).then(transientDisconnectRecovers).then(() => {
  console.log('viewer metrics: decoded frame rates, capture retirement and foreground ownership passed');
}).catch(error => { console.error(error); process.exitCode = 1; });

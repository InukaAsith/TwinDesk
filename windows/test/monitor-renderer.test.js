'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../../shared/protocol');
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const tick = () => new Promise(r => setImmediate(r));
function inputFixture() {
  const events = {}, sent = [], frames = [];
  let enable;
  const video = { videoWidth: 100, videoHeight: 100, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../monitor-input.js'), 'utf8'), {
    window: { PlayerI18n: require('./support/player-i18n.js'), MacShareProtocol: P, TDViewerPen: { attach() {}, recent: () => false }, monitor: { send: m => sent.push(m), onInputEnabled: fn => { enable = fn; } }, addEventListener: (n, fn) => { events[n] = fn; } },
    document: { getElementById: () => video, body: { classList: { toggle() {} } } }, location: { search: '' }, URLSearchParams,
    requestAnimationFrame: fn => frames.push(fn),
  });
  return { events, sent, video, frames, enable, event: (extra = {}) => ({ clientX: 25, clientY: 50, button: 0, preventDefault() {}, ...extra }) };
}
test('mouse release still goes out if the video loses its geometry during a drag', () => {
  const f = inputFixture(); f.events.mousedown(f.event()); f.video.videoWidth = 0; f.events.mouseup(f.event());
  assert.equal(f.sent.at(-1).t, P.T.IN_UP);
  assert.equal(f.sent.at(-1).x, .25);
});
test('clicking outside the video does not prevent toolbar controls from receiving focus', () => {
  const f = inputFixture(); let prevented = false;
  f.events.mousedown(f.event({ clientY: 150, preventDefault: () => { prevented = true; } }));
  assert.equal(prevented, false); assert.equal(f.sent.length, 0);
});
function rtcFixture(file) {
  const elements = new Map(), callbacks = {}, sent = [], states = [], connections = [], timers = [];
  const element = () => { const events = {}; return { events, srcObject: null, classList: { toggle() {} }, addEventListener(n, fn) { events[n] = fn; }, play: async () => {} }; };
  for (const name of ['video', 'overlay', 'stats', 'audio', 'framegen']) elements.set(name, element());
  class Peer {
    constructor() { connections.push(this); this.remote = deferred(); this.localDescription = { sdp: '' }; }
    close() { this.closed = true; }
    setRemoteDescription() { return this.remote.promise; }
    addIceCandidate() { return Promise.resolve(); }
    createAnswer() { if (this.closed) throw new Error('closed'); return Promise.resolve({ type: 'answer', sdp: '' }); }
    setLocalDescription(d) { this.localDescription = d; return Promise.resolve(); }
    getStats() { return this.stats.promise; }
  }
  const api = { send: m => sent.push(m), stats: s => sent.push(s), state: s => states.push(s), ready() {} };
  for (const name of ['onRtc', 'onRemote', 'onPacing', 'onAudio', 'onToggleStats', 'on']) api[name] = fn => { callbacks[name] = fn; };
  const context = vm.createContext({ window: { PlayerI18n: require('./support/player-i18n.js'), MacShareProtocol: P, monitor: api, sender: api }, document: { getElementById: n => elements.get(n), body: { classList: { toggle() {} } } },
    navigator: { mediaDevices: {} }, RTCPeerConnection: Peer, MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
    location: { search: '' }, URLSearchParams, console, performance, setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../' + file), 'utf8'), context);
  return { context, callbacks, sent, states, connections, elements, timers };
}
test('a late track from the old receive connection cannot replace the new picture', async () => {
  const f = rtcFixture('monitor.js');
  f.callbacks.onRtc({ t: P.T.RTC_OFFER, session: 1, sdp: '' });
  const old = f.connections[0];
  f.callbacks.onRtc({ t: P.T.RTC_OFFER, session: 2, sdp: '' });
  old.ontrack({ track: { kind: 'video' }, receiver: {} });
  assert.equal(f.elements.get('video').srcObject, null);
});
test('statistics from a stopped receive connection are discarded', async () => {
  const f = rtcFixture('monitor.js');
  f.callbacks.onRtc({ t: P.T.RTC_OFFER, session: 1, sdp: '' });
  const old = f.connections[0]; old.stats = deferred();
  const stats = vm.runInContext('reportStats()', f.context);
  f.callbacks.onRtc({ t: P.T.STREAM_STOP });
  old.stats.resolve(new Map([['video', { id: 'video', type: 'inbound-rtp', kind: 'video', bytesReceived: 100 }]])); await stats;
  assert.equal(f.sent.length, 0);
});
test('a rejected answer for a stopped sender cannot report failure on that old session', async () => {
  const f = rtcFixture('sender-renderer.js');
  vm.runInContext('globalThis.testPeer = new RTCPeerConnection(); sessions.set(1, {session: 1, pc: testPeer, pending: [], mbps: 20})', f.context);
  const answer = vm.runInContext('onAnswer({session: 1, sdp: ""})', f.context);
  vm.runInContext('stop(1)', f.context);
  f.connections[0].remote.reject(new Error('closed')); await answer;
  assert.equal(f.states.length, 0);
});
test('ICE arriving during answer processing is added instead of being discarded', async () => {
  const f = rtcFixture('sender-renderer.js'), adding = deferred();
  vm.runInContext('globalThis.testPeer = new RTCPeerConnection(); sessions.set(1, {session: 1, pc: testPeer, pending: [{candidate: "first"}], mbps: 20})', f.context);
  const candidates = []; f.connections[0].addIceCandidate = c => { candidates.push(c.candidate); return c.candidate === 'first' ? adding.promise : Promise.resolve(); };
  const answer = vm.runInContext('onAnswer({session: 1, sdp: ""})', f.context);
  f.connections[0].remote.resolve(); await tick();
  f.callbacks.on({ t: P.T.RTC2_ICE, session: 1, candidate: { candidate: 'second' } });
  adding.resolve(); await answer;
  assert.deepEqual(candidates, ['first', 'second']);
});

function frameGenFixture() {
  const f = rtcFixture('monitor.js'), generators = [];
  f.context.window.FrameGen = class {
    constructor() { generators.push(this); this.starts = 0; this.stops = 0; }
    start() { this.on = true; this.starts++; }
    stop() { this.on = false; this.stops++; }
  };
  return { ...f, generators };
}
test('frame generation waits for a picture instead of starting idle GPU loops', () => {
  const f = frameGenFixture(); f.callbacks.onPacing({ framegen: true });
  assert.equal(f.generators.length, 0);
});
test('stopping receive video stops frame generation and reconnect resumes it once', () => {
  const f = frameGenFixture(); f.elements.get('video').srcObject = {};
  f.callbacks.onPacing({ framegen: true }); const fg = f.generators[0];
  f.callbacks.onRtc({ t: P.T.STREAM_STOP }); assert.equal(fg.on, false); assert.equal(fg.stops, 1);
  f.elements.get('video').srcObject = {}; f.elements.get('video').events.playing();
  f.elements.get('video').events.playing(); assert.equal(fg.on, true); assert.equal(fg.starts, 2);
});
test('turning frame generation off prevents a later picture from restarting it', () => {
  const f = frameGenFixture(); f.elements.get('video').srcObject = {};
  f.callbacks.onPacing({ framegen: true }); f.callbacks.onPacing({ framegen: false });
  f.elements.get('video').events.playing(); assert.equal(f.generators[0].on, false); assert.equal(f.generators[0].starts, 1);
});

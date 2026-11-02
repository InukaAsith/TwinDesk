'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../../shared/protocol');
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
function fixture(file, processor = false) {
  const sent = [], states = [], peers = [], elements = new Map(), readers = [], timers = new Set();
  let handler;
  class Peer {
    constructor() { peers.push(this); this.remote = deferred(); this.offer = deferred(); this.localDescription = { sdp: '' }; }
    close() { this.closed = true; }
    setRemoteDescription() { return this.remote.promise; }
    createOffer() { return this.offer.promise; }
    createAnswer() { this.answers = (this.answers || 0) + 1; return Promise.resolve({ sdp: '' }); }
    setLocalDescription(d) { this.localDescription = d; return Promise.resolve(); }
    addIceCandidate() { return Promise.resolve(); }
    addTransceiver() { return { sender: { getParameters: () => ({}), setParameters: async () => {} } }; }
  }
  const api = { on: fn => { handler = fn; }, send: m => sent.push(m), state: m => states.push(m), ready() {} };
  const capture = deferred();
  const context = vm.createContext({
    window: { PlayerI18n: require('./support/player-i18n.js'), sound: api, cam: api, MacShareProtocol: P, CamOut: () => ({ onRotate() {}, push() {} }) },
    document: { querySelector: () => ({}), getElementById: n => { if (!elements.has(n)) elements.set(n, { style: {}, srcObject: null, play: async () => {}, classList: { contains() {} } }); return elements.get(n); }, body: { classList: { contains() {} } } },
    location: { search: '' }, URLSearchParams, addEventListener() {}, console,
    navigator: { mediaDevices: { getDisplayMedia: () => capture.promise, getUserMedia: () => capture.promise, addEventListener() {}, enumerateDevices: async () => [] } },
    RTCPeerConnection: Peer, MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
    setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn),
    ...(processor ? { MediaStreamTrackProcessor: class {
      constructor() { const wait = deferred(); const reader = { read: () => wait.promise, cancel: async () => { reader.cancelled = true; wait.resolve({ done: true }); }, releaseLock: () => { reader.released = true; } }; readers.push(reader); this.readable = { getReader: () => reader }; }
    } } : {}),
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, file), 'utf8'), context);
  return { context, sent, states, peers, elements, readers, timers, capture, message: m => handler(m) };
}
test('audio stop during offer creation never sends a stale offer', async () => {
  const f = fixture('../sound-renderer.js');
  f.message({ t: 'start-send', session: 1 });
  let stopped = 0;
  const track = { stop: () => stopped++ };
  f.capture.resolve({ getVideoTracks: () => [], getAudioTracks: () => [track], getTracks: () => [track] });
  await tick(); f.message({ t: 'stop-send' });
  f.peers[0].offer.resolve({ sdp: 'old' }); await tick();
  assert.equal(f.sent.length, 0); assert.equal(stopped, 1);
});
test('audio capture arriving after stop releases its tracks', async () => {
  const f = fixture('../sound-renderer.js'); f.message({ t: 'start-send', session: 1 }); f.message({ t: 'stop-send' });
  let stopped = 0; const track = { stop: () => stopped++ };
  f.capture.resolve({ getVideoTracks: () => [], getAudioTracks: () => [track], getTracks: () => [track] }); await tick();
  assert.equal(stopped, 1); assert.equal(f.peers.length, 0);
});
test('stale audio tracks and negotiation errors do not change the active player', async () => {
  const f = fixture('../sound-renderer.js');
  f.message({ t: P.T.AUDIO_OFFER, session: 1 }); const old = f.peers[0];
  f.message({ t: P.T.AUDIO_OFFER, session: 2 }); const count = f.states.length;
  old.ontrack({ track: {}, receiver: {} }); old.remote.reject(new Error('old failure')); await tick();
  assert.equal(f.elements.get('play').srcObject, null); assert.equal(f.states.length, count);
});
test('audio receive negotiation failure closes its peer', async () => {
  const f = fixture('../sound-renderer.js'); f.message({ t: P.T.AUDIO_OFFER, session: 1 });
  f.peers[0].remote.reject(new Error('bad sdp')); await tick();
  assert.equal(f.peers[0].closed, true); assert.match(f.states.at(-1).error, /bad sdp/);
});
for (const processor of [false, true]) test(`camera reset stops the ${processor ? 'frame reader' : 'fallback timer'}`, async () => {
  const f = fixture('../../shared/camera-view.js', processor);
  f.message({ t: 'offer', sdp: '' });
  f.peers[0].ontrack({ track: { kind: 'video', readyState: 'live' }, streams: [] });
  f.message({ t: 'reset' }); await tick();
  if (processor) { assert.equal(f.readers[0].cancelled, true); assert.equal(f.readers[0].released, true); }
  else assert.equal(f.timers.size, 0);
});
test('camera reconnect ignores tracks and descriptions from the previous peer', async () => {
  const f = fixture('../../shared/camera-view.js'); f.message({ t: 'offer', sdp: 'old' }); const old = f.peers[0];
  f.message({ t: 'offer', sdp: 'new' }); old.ontrack({ track: { kind: 'video' }, streams: [] }); old.remote.resolve(); await tick();
  assert.equal(f.elements.get('video').srcObject, null); assert.equal(old.answers, undefined); assert.equal(f.sent.filter(m => m.t === 'answer').length, 0);
  f.peers[1].remote.resolve(); await tick(); assert.equal(f.sent.filter(m => m.t === 'answer').length, 1);
});
test('camera sender releases capture when the camera track ends', async () => {
  const f = fixture('../../shared/camera-send.js'); f.message({ t: 'start' }); let stopped = 0;
  const track = { stop: () => stopped++ };
  f.capture.resolve({ getVideoTracks: () => [track], getTracks: () => [track] }); await tick();
  track.onended(); assert.equal(stopped, 1); assert.equal(f.peers[0].closed, true);
  f.peers[0].offer.resolve({ sdp: '' }); await tick(); assert.equal(f.sent.filter(m => m.t === 'offer').length, 0);
});

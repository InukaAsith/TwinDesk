// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
function fixture(touch = 'direct') {
  const events = new Map(), docEvents = new Map(), videoEvents = new Map(), sent = [], timers = new Map(), frames = [], videoFrames = [], videoStates = [], peers = [], detailRequests = [];
  let now = 10000, timerId = 0;
  const video = { videoWidth: 1920, videoHeight: 1080, style: {}, play: async () => {}, requestVideoFrameCallback: fn => videoFrames.push(fn), addEventListener(k, fn) { videoEvents.set(k, fn); } };
  const ctx = { setTransform() {}, clearRect() {} };
  const nodes = { video, audio: {}, overlay: { classList: { toggle() {} } }, kbd: { value: '', addEventListener() {}, blur() {}, focus() {} } };
  const window = { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    addEventListener(k, fn) { events.set(k, fn); },
    TD: { send: (m) => sent.push(JSON.parse(m)), ready() {}, playing() {}, videoState: (generation, session, playing, w, h) => videoStates.push({ generation, session, playing, w, h }), haptic() {},
      canDecodeVideo: (_codec, width, height, _fps) => width <= 3840 && height <= 2160,
      detail: (generation, session, height) => detailRequests.push({ generation, session, height }) } };
  const document = { hidden: false, getElementById: (id) => nodes[id], addEventListener(k, fn) { docEvents.set(k, fn); },
    documentElement: { addEventListener() {} }, body: { appendChild() {}, classList: { toggle() {} } },
    createElement: () => ({ style: {}, getContext: () => ctx }) };
  class Peer {
    constructor() { peers.push(this); this.connectionState = 'connected'; this.localDescription = { sdp: 'fixture' }; }
    close() { this.connectionState = 'closed'; }
    async setRemoteDescription() {} async addIceCandidate() {} async createAnswer() { return {}; } async setLocalDescription() {}
    getReceivers() { return []; }
    async getStats() {
      return new Map([['in', { type: 'inbound-rtp', kind: 'video', codecId: 'codec' }],
        ['codec', { mimeType: 'video/H264' }]]);
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../android/app/src/main/assets/web/viewer.js'), 'utf8'), {
    RTCPeerConnection: Peer, MediaStream: class { constructor(tracks) { this.tracks = tracks; } }, window, document, console: { log() {} }, performance: { now: () => now },
    setTimeout: (fn, delay = 0) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout: (id) => timers.delete(id), requestAnimationFrame: fn => frames.push(fn),
  });
  const pointer = (type, id, x, y, extra = {}) => events.get(type)({ pointerId: id, pointerType: 'touch', button: 0,
    clientX: x, clientY: y, preventDefault() {}, ...extra });
  const recv = (m) => window.tdRecv(m);
  recv({ t: 'opts', touch, tap: true });
  const advance = ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
  };
  return { window, video, peers, videoStates, detailRequests, videoFrame() { for (const fn of videoFrames.splice(0)) fn(); }, overlay: nodes.overlay, sent, pointer, events, recv, document, docEvents, videoEvents,
    frame() { for (const fn of frames.splice(0)) fn(); },
    advance, hold() { advance(600); } };
}

const zoomDetail = { baseline: 1080, fps: 60, sizes: [null, { width: 2560, height: 1440 }, { width: 3840, height: 2160 }] };
async function connect(f, session = 40, detail = zoomDetail) {
  f.recv({ t: 'rtc.offer', session, viewerGeneration: session + 100, sdp: 'fixture', detail });
  await new Promise(resolve => setImmediate(resolve));
  f.peers.at(-1).ontrack({ track: { kind: 'video' }, receiver: {} });
  f.videoEvents.get('playing')();
  f.videoFrame();
}
function pinch(f, span = 400) {
  f.pointer('pointerdown', 1, 400, 400); f.pointer('pointerdown', 2, 600, 400);
  f.pointer('pointermove', 2, 400 + span, 400); f.frame();
  f.pointer('pointerup', 1, 400, 400); f.pointer('pointerup', 2, 400 + span, 400);
}
async function sharperPictureAndRestore() {
  const f = fixture();
  await connect(f);
  pinch(f);
  f.advance(200);
  f.pointer('pointerdown', 3, 500, 400); f.pointer('pointerup', 3, 500, 400);
  f.advance(399);
  assert.deepStrictEqual(f.detailRequests, [], 'a tap delays the request until gestures settle');
  f.advance(1); await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(f.detailRequests, [{ generation: 140, session: 40, height: 1440 }]);
  const transform = f.video.style.transform;
  f.video.videoWidth = 2560; f.video.videoHeight = 1440;
  f.videoEvents.get('resize')(); f.videoFrame(); f.advance(400);
  assert.strictEqual(f.video.style.transform, transform, 'same-aspect frames retain zoom and pan');
  assert.strictEqual(f.detailRequests.length, 1, 'the same tier is coalesced');
  pinch(f, 100); f.advance(400);
  assert.deepStrictEqual(f.detailRequests.at(-1), { generation: 140, session: 40, height: 0 }, 'zooming out restores the baseline');
  pinch(f);
  f.advance(400);
  assert.strictEqual(f.detailRequests.at(-1).height, 1440);
  f.recv({ t: 'screen.state', on: true, touch: true });
  f.advance(400);
  assert.strictEqual(f.video.style.transform, 'translate(0px, 0px) scale(1)', 'native Direct touch restores the local view');
  assert.strictEqual(f.detailRequests.at(-1).height, 0);
  f.recv({ t: 'screen.state', on: true, touch: false });
  pinch(f); f.advance(400);
  assert.strictEqual(f.detailRequests.at(-1).height, 1440);
  f.recv({ t: 'viewer.scale', mode: 'fit' }); f.advance(400);
  assert.strictEqual(f.detailRequests.at(-1).height, 0, 'Fit restores this stream baseline');
  pinch(f); f.advance(400);
  assert.strictEqual(f.detailRequests.at(-1).height, 1440);
  const requests = f.detailRequests.length;
  f.recv({ t: 'viewer.scale', mode: 'fit' });
  await connect(f, 41);
  f.advance(400);
  assert.strictEqual(f.detailRequests.length, requests, 'replacement cancels a pending baseline restore');
}
async function unsupportedAndRetiredFrames() {
  const f = fixture();
  await connect(f);
  f.window.TD.canDecodeVideo = () => false;
  pinch(f); f.advance(400); await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(f.detailRequests, [], 'an unsupported decoder keeps the baseline');
  f.window.TD.canDecodeVideo = () => true;
  pinch(f); f.document.hidden = true; f.docEvents.get('visibilitychange')(); f.advance(400);
  assert.deepStrictEqual(f.detailRequests, [], 'hidden viewers cancel pending work');
  f.document.hidden = false; f.docEvents.get('visibilitychange')(); f.videoFrame();
  f.recv({ t: 'rtc.offer', session: 41, viewerGeneration: 141, sdp: 'fixture', detail: zoomDetail });
  f.advance(400); await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(f.detailRequests, [], 'a replacement offer rejects the prior picture');
  f.peers.at(-1).ontrack({ track: { kind: 'video' }, receiver: {} });
  f.videoEvents.get('playing')(); f.videoFrame(); pinch(f);
  f.recv({ t: 'stream.stop' }); f.advance(400);
  assert.deepStrictEqual(f.detailRequests, [], 'Stop cancels pending work');
  const legacy = fixture();
  await connect(legacy, 3, null);
  legacy.pointer('pointerdown', 1, 400, 400); legacy.pointer('pointerdown', 2, 600, 400);
  legacy.sent.length = 0;
  legacy.pointer('pointermove', 2, 800, 400); legacy.frame();
  assert.ok(legacy.sent.some(m => m.t === 'in.wh'), 'hosts without detail keep two-finger scroll');
}
sharperPictureAndRestore().then(unsupportedAndRetiredFrames).then(() => {
  console.log('viewer-zoom-detail: sharper owned frames, restore, cancellation, and legacy gestures passed');
}).catch(error => { console.error(error); process.exitCode = 1; });

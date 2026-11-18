// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
function fixture(local = true, touch = 'direct') {
  const events = new Map(), docEvents = new Map(), videoEvents = new Map(), sent = [], timers = new Map(), frames = [], videoFrames = [], videoStates = [], peers = [];
  let now = 10000, timerId = 0;
  const video = { videoWidth: 1920, videoHeight: 1080, style: {}, play: async () => {}, requestVideoFrameCallback: fn => videoFrames.push(fn), addEventListener(k, fn) { videoEvents.set(k, fn); } };
  const ctx = { setTransform() {}, clearRect() {} };
  const nodes = { video, audio: {}, overlay: { classList: { toggle() {} } }, kbd: { value: '', addEventListener() {}, blur() {}, focus() {} } };
  const window = { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    addEventListener(k, fn) { events.set(k, fn); },
    TD: { send: (m) => sent.push(JSON.parse(m)), ready() {}, playing() {}, videoState: (generation, session, playing, w, h) => videoStates.push({ generation, session, playing, w, h }), haptic() {} } };
  const document = { hidden: false, getElementById: (id) => nodes[id], addEventListener(k, fn) { docEvents.set(k, fn); },
    documentElement: { addEventListener() {} }, body: { appendChild() {}, classList: { toggle() {} } },
    createElement: () => ({ style: {}, getContext: () => ctx }) };
  class Peer {
    constructor() { peers.push(this); this.connectionState = 'connected'; this.localDescription = { sdp: 'fixture' }; }
    close() { this.connectionState = 'closed'; }
    async setRemoteDescription() {} async addIceCandidate() {} async createAnswer() { return {}; } async setLocalDescription() {}
    getReceivers() { return []; }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../android/app/src/main/assets/web/viewer.js'), 'utf8'), {
    RTCPeerConnection: Peer, MediaStream: class { constructor(tracks) { this.tracks = tracks; } }, window, document, console: { log() {} }, performance: { now: () => now },
    setTimeout: (fn, delay = 0) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout: (id) => timers.delete(id), requestAnimationFrame: fn => frames.push(fn),
  });
  const pointer = (type, id, x, y, extra = {}) => events.get(type)({ pointerId: id, pointerType: 'touch', button: 0,
    clientX: x, clientY: y, preventDefault() {}, ...extra });
  const recv = (m) => window.tdRecv(m);
  recv({ t: 'opts', viewGestures: local, touch, tap: true });
  const advance = ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
  };
  return { window, video, peers, videoStates, videoFrame() { for (const fn of videoFrames.splice(0)) fn(); }, overlay: nodes.overlay, sent, pointer, events, recv, document, docEvents, videoEvents,
    frame() { for (const fn of frames.splice(0)) fn(); },
    advance, hold() { advance(600); } };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
async function pinchPanAndControl() {
  const playback = fixture();
  playback.recv({ t: 'rtc.offer', session: 1, viewerGeneration: 10, sdp: 'fixture' });
  await new Promise(resolve => setImmediate(resolve));
  playback.peers[0].ontrack({ track: { kind: 'video' }, receiver: {} });
  playback.videoEvents.get('resize')();
  assert.deepStrictEqual(playback.videoStates, [], 'dimensions alone do not permit handoff');
  playback.videoEvents.get('playing')();
  playback.recv({ t: 'rtc.offer', session: 2, viewerGeneration: 11, sdp: 'fixture' });
  await new Promise(resolve => setImmediate(resolve));
  playback.videoFrame();
  assert.ok(!playback.videoStates.some(s => s.playing), 'old offer frame cannot permit handoff');
  playback.peers[1].ontrack({ track: { kind: 'video' }, receiver: {} });
  playback.videoEvents.get('playing')(); playback.videoFrame();
  assert.deepStrictEqual(playback.videoStates.at(-1), { generation: 11, session: 2, playing: true, w: 1920, h: 1080 });
  playback.videoEvents.get('playing')();
  playback.recv({ t: 'viewer.probe', session: 2, viewerGeneration: 12, accept: false });
  playback.videoEvents.get('resize')(); playback.videoFrame();
  assert.ok(!playback.videoStates.some(s => s.generation === 12 && s.playing), 'locked state cancels queued playback');
  playback.recv({ t: 'viewer.probe', session: 2, viewerGeneration: 13, accept: true });
  assert.ok(!playback.videoStates.some(s => s.generation === 13 && s.playing), 'unlock waits for a fresh frame');
  playback.videoFrame();
  assert.deepStrictEqual(playback.videoStates.at(-1), { generation: 13, session: 2, playing: true, w: 1920, h: 1080 });
  playback.video.videoWidth = 2560; playback.video.videoHeight = 1440;
  playback.videoEvents.get('resize')();
  assert.strictEqual(playback.videoStates.at(-1).w, 1920, 'new dimensions wait for an owned frame');
  playback.videoFrame();
  assert.deepStrictEqual(playback.videoStates.at(-1), { generation: 13, session: 2, playing: true, w: 2560, h: 1440 });
  playback.peers[1].connectionState = 'disconnected'; playback.peers[1].onconnectionstatechange();
  assert.strictEqual(playback.videoStates.at(-1).playing, false);
  playback.peers[1].connectionState = 'connected'; playback.peers[1].onconnectionstatechange(); playback.videoFrame();
  assert.strictEqual(playback.videoStates.at(-1).playing, true, 'transport recovery observes a frame without another playing event');
  playback.recv({ t: 'stream.stop' }); playback.videoEvents.get('playing')(); playback.videoFrame();
  assert.strictEqual(playback.videoStates.at(-1).playing, false, 'stop revokes playback readiness');
  const f = fixture();
  f.pointer('pointerdown', 1, 400, 400); f.pointer('pointerdown', 2, 600, 400); f.sent.length = 0;
  f.pointer('pointermove', 2, 800, 400);
  f.frame();
  assert.strictEqual(f.video.style.transform, 'translate(100px, 0px) scale(2)');
  f.pointer('pointermove', 1, 450, 450); f.pointer('pointermove', 2, 850, 450);
  f.frame();
  assert.strictEqual(f.video.style.transform, 'translate(150px, 50px) scale(2)');
  assert.deepStrictEqual(f.sent, [], 'pinch only changes the local view');
  f.pointer('pointerup', 1, 450, 450); f.pointer('pointerup', 2, 850, 450);
  f.pointer('pointerdown', 3, 500, 400); f.pointer('pointerup', 3, 500, 400);
  const click = f.sent.find((m) => m.t === 'in.md'); near(click.x, .425); near(click.y, 512.5 / 1125);
  f.sent.length = 0;
  f.pointer('pointerdown', 1, 400, 400); f.pointer('pointerdown', 2, 500, 400); f.pointer('pointerdown', 3, 600, 400); f.sent.length = 0;
  f.pointer('pointermove', 1, 400, 460);
  f.frame();
  assert.deepStrictEqual(f.sent, [], 'three-finger pan sends no input to the Mac');
  assert.strictEqual(f.video.style.transform, 'translate(150px, 70px) scale(2)');
  const scroll = fixture();
  scroll.pointer('pointerdown', 1, 400, 400); scroll.pointer('pointerdown', 2, 600, 400); scroll.sent.length = 0;
  scroll.pointer('pointermove', 1, 400, 450); scroll.pointer('pointermove', 2, 600, 450); scroll.frame();
  assert.deepStrictEqual(scroll.sent, [], 'scroll waits briefly for a staggered third finger');
  scroll.advance(150);
  assert.deepStrictEqual(scroll.sent.map(m => m.t), ['in.wh']); near(scroll.sent[0].dy, -100);
  assert.strictEqual(scroll.video.style.transform, 'translate(0px, 0px) scale(1)', 'parallel fingers scroll without zooming');
  scroll.pointer('pointermove', 2, 650, 450); scroll.frame();
  assert.strictEqual(scroll.video.style.transform, 'translate(0px, 0px) scale(1)', 'finger spacing changes do not turn an active scroll into a pinch');
  const legacy = fixture(false);
  legacy.pointer('pointerdown', 1, 400, 400); legacy.pointer('pointerdown', 2, 600, 400); legacy.sent.length = 0;
  legacy.pointer('pointermove', 2, 620, 400);
  assert.strictEqual(legacy.sent[0].t, 'in.wh', 'non-target viewer retains two-finger scroll');
  const pad = fixture(true, 'pad');
  pad.pointer('pointerdown', 1, 400, 400); pad.pointer('pointerdown', 2, 600, 400); pad.pointer('pointermove', 2, 1200, 400);
  pad.pointer('pointerup', 1, 400, 400); pad.pointer('pointerup', 2, 1200, 400);
  pad.pointer('pointerdown', 1, 500, 400); pad.pointer('pointermove', 1, 950, 400);
  assert.ok(pad.video.style.transform.includes('scale(4)'), 'pinch clamps at 4x');
  const m = pad.sent.at(-1), pan = Number(/^translate\(([^p]+)/.exec(pad.video.style.transform)[1]);
  const cursorX = (1000 - 4000) / 2 + pan + m.x * 4000;
  assert.ok(cursorX >= 32 && cursorX <= 968, 'zoomed touchpad follows its cursor');
  const staggered = fixture();
  staggered.pointer('pointerdown', 1, 300, 400); staggered.pointer('pointerdown', 2, 500, 400);
  staggered.sent.length = 0;
  staggered.pointer('pointermove', 1, 300, 440); staggered.pointer('pointermove', 2, 500, 440); staggered.frame();
  staggered.advance(100); staggered.pointer('pointerdown', 3, 700, 440);
  staggered.pointer('pointermove', 3, 700, 460); staggered.frame();
  staggered.advance(100);
  assert.deepStrictEqual(staggered.sent, [], 'a slightly staggered three-finger swipe never scrolls the Mac');
  const flick = fixture();
  flick.pointer('pointerdown', 1, 300, 400); flick.pointer('pointerdown', 2, 500, 400); flick.sent.length = 0;
  flick.pointer('pointermove', 1, 300, 440); flick.pointer('pointermove', 2, 500, 440); flick.frame();
  flick.pointer('pointerup', 1, 300, 440); flick.pointer('pointerup', 2, 500, 440); flick.advance(200);
  assert.deepStrictEqual(flick.sent.map(m => m.t), ['in.wh'], 'a short two-finger flick commits once on lift');
}
function cancellationAndBounds() {
  const capture = fixture();
  capture.recv({ t: 'stream.stop', reason: 'capture-unavailable' });
  assert.match(capture.overlay.textContent, /Screen capture is unavailable/);
  capture.recv({ t: 'stream.info' });
  capture.recv({ t: 'screen.state', on: true });
  assert.match(capture.overlay.textContent, /Retrying/,'retry state preserves the actionable failure');
  capture.videoEvents.get('playing')();
  assert.strictEqual(capture.overlay.textContent, '', 'a recovered stream clears its failure');
  capture.recv({ t: 'stream.stop', reason: 'capture-unavailable' });
  capture.recv({ t: 'screen.state', on: false });
  assert.doesNotMatch(capture.overlay.textContent, /Retrying/, 'explicit stop clears retry guidance');
  capture.recv({ t: 'stream.stop' });
  assert.match(capture.overlay.textContent, /isn’t sharing/, 'legacy stop behavior remains available');
  const f = fixture();
  f.pointer('pointerdown', 1, 400, 400); f.pointer('pointermove', 1, 440, 400);
  f.pointer('pointerdown', 2, 600, 400);
  assert.strictEqual(f.sent.filter((m) => m.t === 'in.mu').length, 1, 'second finger releases direct drag');
  f.sent.length = 0; f.pointer('pointermove', 2, 900, 400); f.pointer('pointerup', 2, 900, 400);
  f.frame();
  f.pointer('pointermove', 1, 800, 600); f.hold(); f.pointer('pointerup', 1, 800, 600);
  assert.deepStrictEqual(f.sent, [], 'remaining finger cannot become a click or pointer');
  for (let id = 1; id <= 4; id++) f.pointer('pointerdown', id, 400 + id * 30, 400);
  f.sent.length = 0; f.pointer('pointermove', 1, 1000, 1000);
  f.frame();
  for (let id = 1; id <= 4; id++) f.pointer('pointerup', id, 500, 400);
  assert.deepStrictEqual(f.sent, [], 'four-finger gesture is ignored');
  f.pointer('pointerdown', 1, 500, 400); f.pointer('pointercancel', 1, 500, 400); f.sent.length = 0; f.hold();
  assert.deepStrictEqual(f.sent, [], 'cancel does not click or fire hold');
  f.pointer('pointerdown', 1, 500, 400); f.pointer('pointerup', 1, 500, 400);
  assert.deepStrictEqual(f.sent.slice(-2).map((m) => m.t), ['in.md', 'in.mu'], 'next tap works');
  f.pointer('pointerdown', 1, 400, 400); f.pointer('pointerdown', 2, 600, 400); f.pointer('pointermove', 2, 1600, 400);
  f.window.innerWidth = 400; f.window.innerHeight = 1000; f.events.get('resize')();
  assert.ok(!f.video.style.transform.includes('NaN'), 'rotation clamps transform');
  f.video.videoWidth = 0; f.videoEvents.get('resize')();
  f.pointer('pointerdown', 1, 100, 400); f.pointer('pointerdown', 2, 300, 400); f.sent.length = 0; f.pointer('pointermove', 2, 390, 400);
  f.frame();
  assert.deepStrictEqual(f.sent, []); assert.ok(!f.video.style.transform.includes('NaN'));
  const presets = fixture();
  presets.recv({ t: 'viewer.scale', mode: 'fill' });
  near(Number(/scale\(([^)]+)/.exec(presets.video.style.transform)[1]), 800 / 562.5);
  assert.deepStrictEqual(presets.sent, [], 'Fill changes the local view only');
  presets.pointer('pointerdown', 1, 750, 200);
  presets.pointer('pointerup', 1, 750, 200);
  const filled = presets.sent.find(m => m.t === 'in.md');
  near(filled.x, .5 + 250 / (800 * 16 / 9)); near(filled.y, .25);
  presets.pointer('pointerdown', 1, 600, 300);
  presets.pointer('pointermove', 1, 630, 300);
  presets.sent.length = 0;
  presets.window.devicePixelRatio = 2;
  presets.recv({ t: 'viewer.scale', mode: 'actual' });
  near(Number(/scale\(([^)]+)/.exec(presets.video.style.transform)[1]) * 1000 * 2, 1920);
  presets.pointer('pointerup', 1, 630, 300);
  assert.deepStrictEqual(presets.sent.map(m => m.t), ['in.mu'], 'scaling releases the drag once without replaying it');
  presets.recv({ t: 'viewer.scale', mode: 'fit' });
  assert.strictEqual(presets.video.style.transform, 'translate(0px, 0px) scale(1)');
  const real = fixture(); real.recv({ t: 'screen.state', touch: true });
  real.pointer('pointerdown', 1, 500, 400); real.pointer('pointerup', 1, 500, 400);
  assert.deepStrictEqual(real.sent.map((m) => m.t), ['in.tc', 'in.tc'], 'real touch remains unchanged');
  const pen = fixture();
  pen.pointer('pointerdown', 1, 400, 400); pen.pointer('pointerdown', 2, 600, 400);
  pen.pointer('pointermove', 2, 800, 400);
  pen.pointer('pointermove', 9, 500, 400, { pointerType: 'pen', buttons: 0, pressure: 0 });
  pen.sent.length = 0;
  pen.pointer('pointermove', 1, 800, 600); pen.pointer('pointerup', 1, 800, 600); pen.pointer('pointerup', 2, 800, 400);
  pen.frame();
  assert.deepStrictEqual(pen.sent, [], 'pen proximity drops the prior finger gesture');
  const resize = fixture();
  resize.videoEvents.get('resize')();
  resize.pointer('pointerdown', 9, 500, 400, { pointerType: 'mouse' });
  resize.events.get('keydown')({ code: 'ShiftLeft', preventDefault() {} });
  resize.sent.length = 0; resize.video.videoWidth = 1280; resize.video.videoHeight = 720;
  resize.videoEvents.get('resize')();
  assert.deepStrictEqual(resize.sent, [], 'same-aspect video resize preserves held input');
  const offscreen = fixture(true, 'pad');
  offscreen.pointer('pointerdown', 1, 400, 400); offscreen.pointer('pointerdown', 2, 600, 400);
  offscreen.pointer('pointermove', 2, 1200, 400); offscreen.pointer('pointerup', 1, 400, 400); offscreen.pointer('pointerup', 2, 1200, 400);
  offscreen.pointer('pointerdown', 3, 500, 400); offscreen.pointer('pointerup', 3, 500, 400);
  const pos = Number(/^translate\(([^p]+)/.exec(offscreen.video.style.transform)[1]);
  assert.ok((-1500 + pos + 2000) >= 32 && (-1500 + pos + 2000) <= 968, 'tap brings the touchpad cursor into view');
}
pinchPanAndControl().then(() => { cancellationAndBounds(); console.log('viewer-viewport: gestures, input mapping, legacy behavior and cancellation passed'); }).catch(e => { console.error(e); process.exitCode = 1; });

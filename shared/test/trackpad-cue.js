// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../android/app/src/main/assets/web/viewer.js'), 'utf8');

function fixture() {
  const events = new Map(), frames = new Map(), timers = new Map();
  const sent = [], peers = [], decoded = [], videoEvents = new Map();
  const cue = { hidden: true, style: {} };
  const video = { style: {}, videoWidth: 1600, videoHeight: 900, paused: false, readyState: 2, HAVE_CURRENT_DATA: 2,
    play: async () => {}, requestVideoFrameCallback: fn => decoded.push(fn),
    addEventListener: (event, fn) => videoEvents.set(event, fn) };
  const nodes = { video, 'pointer-cue': cue, audio: {}, overlay: { classList: { toggle() {} } },
    kbd: { addEventListener() {}, blur() {} } };
  let now = 5000, id = 0;
  const window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1,
    addEventListener: (name, fn) => events.set(name, fn),
    TD: { send: json => sent.push(JSON.parse(json)), ready() {}, playing() {}, videoState() {} } };
  const document = { hidden: false, getElementById: name => nodes[name], addEventListener() {},
    documentElement: { addEventListener() {} }, body: { appendChild() {}, classList: { toggle() {} } },
    createElement: () => ({ style: {}, getContext: () => ({ setTransform() {}, clearRect() {} }) }) };
  class Peer {
    constructor() { this.connectionState = 'connected'; peers.push(this); }
    close() { this.connectionState = 'closed'; }
    async setRemoteDescription() {}
    async createAnswer() { return {}; }
    async setLocalDescription() { this.localDescription = { sdp: '' }; }
  }
  vm.runInNewContext(source, {
    window, document, RTCPeerConnection: Peer, MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
    console: { log() {} }, performance: { now: () => now },
    requestAnimationFrame: (fn) => { frames.set(++id, fn); return id; }, cancelAnimationFrame: (ref) => frames.delete(ref),
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; }, clearTimeout: (ref) => timers.delete(ref),
  });
  const recv = m => window.tdRecv(m);
  const finger = (type, x, y = 300, pointerId = 1) => events.get(type)({ pointerType: 'touch', pointerId, clientX: x, clientY: y, preventDefault() {} });
  const frame = () => { for (const [id, fn] of [...frames]) if (frames.delete(id)) fn(); };
  const advance = (ms) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn();
  };
  const offer = (session, detail, decodedFrame = true) => {
    recv({ t: 'rtc.offer', session, viewerGeneration: session, sdp: '', detail });
    peers.at(-1).ontrack({ track: { kind: 'video' }, receiver: {} });
    if (decodedFrame) videoEvents.get('playing')?.();
    for (const fn of decoded.splice(0)) fn();
  };
  recv({ t: 'opts', inputOn: false, touch: 'pad', tap: true });
  offer(1);
  return { cue, video, recv, finger, frame, advance, offer, peers, sent };
}

function ringFollowsTrackpad() {
  const f = fixture();
  f.recv({ t: 'viewer.input', on: true });
  f.recv({ t: 'screen.state', on: true, remote: false, input: true, touch: true });
  f.finger('pointerdown', 400);
  f.finger('pointermove', 430);
  f.frame();
  assert.equal(f.cue.hidden, false);
  const [x, y] = f.cue.style.transform.match(/-?[0-9.]+/g).map(Number);
  assert.ok(Math.abs(x - 460) < 1e-6);
  assert.equal(y, 300);
  assert.deepEqual(f.sent, [{ t: 'in.mm', x: 0.575, y: 0.5 }]);
  f.advance(160);
  assert.equal(f.cue.hidden, true);
  f.finger('pointermove', 460);
  f.frame();
  assert.equal(f.cue.hidden, false);
  f.finger('pointerup', 460);
  assert.equal(f.cue.hidden, true);
}

function revokedOrRetiredViewerStaysHidden() {
  const f = fixture();
  f.recv({ t: 'screen.state', on: true, remote: true, touch: true });
  f.finger('pointerdown', 400);
  f.finger('pointermove', 430);
  f.frame();
  assert.ok(f.cue.hidden, 'start/switch permission alone does not allow a cue');

  f.recv({ t: 'viewer.input', on: true });
  f.recv({ t: 'screen.state', on: true, input: true });
  f.finger('pointermove', 460);
  f.recv({ t: 'viewer.input', on: false });
  f.frame();
  assert.ok(f.cue.hidden, 'a queued cue cannot appear after revocation');

  f.recv({ t: 'viewer.input', on: true });
  f.recv({ t: 'screen.state', on: true, input: true });
  f.finger('pointermove', 490);
  f.offer(2, undefined, false);
  const current = f.video.srcObject;
  f.peers[0].ontrack({ track: { kind: 'video' }, receiver: {} });
  f.frame();
  assert.equal(f.video.srcObject, current, 'a late track cannot replace the current picture');
  assert.ok(f.cue.hidden);
  f.video.readyState = 1;
  f.finger('pointermove', 520);
  f.frame();
  assert.ok(f.cue.hidden, 'the new viewer needs picture data');
}

function ringFollowsZoomedPicture() {
  const f = fixture();
  f.offer(2, { baseline: 900, fps: 60, sizes: [null, { width: 2560, height: 1440 }, { width: 3840, height: 2160 }] });
  f.recv({ t: 'viewer.input', on: true });
  f.recv({ t: 'screen.state', on: true, remote: true });
  f.finger('pointerdown', 300, 300, 1);
  f.finger('pointerdown', 500, 300, 2);
  f.finger('pointermove', 700, 300, 2);
  f.frame();
  f.finger('pointerup', 300, 300, 1);
  f.finger('pointerup', 700, 300, 2);
  f.sent.length = 0;
  f.finger('pointerdown', 400, 300, 3);
  f.finger('pointermove', 430, 330, 3);
  f.frame();
  assert.equal(f.cue.hidden, false);
  assert.deepEqual(f.sent.map(m => m.t), ['in.mm']);
  const [panX, panY, scale] = f.video.style.transform.match(/-?[0-9.]+/g).map(Number);
  const [x, y] = f.cue.style.transform.match(/-?[0-9.]+/g).map(Number);
  assert.ok(scale > 1, 'the picture actually zoomed');
  assert.ok(Math.abs(x - ((800 - 800 * scale) / 2 + panX + f.sent[0].x * 800 * scale)) < 1e-6);
  assert.ok(Math.abs(y - ((600 - 450 * scale) / 2 + panY + f.sent[0].y * 450 * scale)) < 1e-6);
  f.advance(160);
  assert.equal(f.cue.hidden, true);
}

ringFollowsTrackpad();
ringFollowsZoomedPicture();
revokedOrRetiredViewerStaysHidden();
console.log('trackpad cue: letterbox, idle/lift cleanup, permission and connection ownership passed');

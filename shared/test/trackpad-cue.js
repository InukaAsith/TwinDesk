// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../android/app/src/main/assets/web/viewer.js'), 'utf8');

function fixture() {
  const events = new Map(), frames = new Map(), timers = new Map();
  const sent = [], peers = [];
  const cue = { hidden: true, style: {} };
  const video = { videoWidth: 1600, videoHeight: 900, paused: false, readyState: 2, HAVE_CURRENT_DATA: 2,
    play: async () => {}, addEventListener() {} };
  const nodes = { video, 'pointer-cue': cue, audio: {}, overlay: { classList: { toggle() {} } },
    kbd: { addEventListener() {}, blur() {} } };
  let now = 5000, id = 0;
  const window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1,
    addEventListener: (name, fn) => events.set(name, fn),
    TD: { send: json => sent.push(JSON.parse(json)), ready() {}, playing() {} } };
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
  const finger = (type, x) => events.get(type)({ pointerType: 'touch', pointerId: 1, clientX: x, clientY: 300, preventDefault() {} });
  const frame = () => { for (const [id, fn] of [...frames]) if (frames.delete(id)) fn(); };
  const advance = (ms) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn();
  };
  const offer = (session) => {
    recv({ t: 'rtc.offer', session, sdp: '' });
    peers.at(-1).ontrack({ track: { kind: 'video' }, receiver: {} });
  };
  recv({ t: 'opts', pointerCue: true, touch: 'pad', tap: true });
  offer(1);
  return { cue, video, recv, finger, frame, advance, offer, peers, sent };
}

function ringFollowsTrackpad() {
  const f = fixture();
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

  f.recv({ t: 'screen.state', on: true, input: true });
  f.finger('pointermove', 460);
  f.recv({ t: 'viewer.input', on: false });
  f.frame();
  assert.ok(f.cue.hidden, 'a queued cue cannot appear after revocation');

  f.recv({ t: 'screen.state', on: true, input: true });
  f.finger('pointermove', 490);
  f.offer(2);
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

ringFollowsTrackpad();
revokedOrRetiredViewerStaysHidden();
console.log('trackpad cue: letterbox, idle/lift cleanup, permission and connection ownership passed');

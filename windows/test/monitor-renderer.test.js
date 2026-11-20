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

test('pointer mapping accounts for a scaled video, letterboxing and CSS coordinates on a HiDPI display', () => {
  const f = inputFixture();
  f.video.videoWidth = 1920; f.video.videoHeight = 1200;
  f.video.getBoundingClientRect = () => ({ left: 100, top: 50, width: 960, height: 720 });
  f.events.mousedown(f.event({ clientX: 340, clientY: 560 }));
  const down = f.sent.find(m => m.t === P.T.IN_DOWN);
  assert.equal(down.x, .25); assert.equal(down.y, .75);
  const count = f.sent.length;
  f.events.mousedown(f.event({ clientX: 340, clientY: 60 }));
  assert.equal(f.sent.length, count, 'letterbox margins do not generate input');
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
  const windowEvents = {};
  const context = vm.createContext({ window: { addEventListener: (name, fn) => { windowEvents[name] = fn; }, PlayerI18n: require('./support/player-i18n.js'), MacShareProtocol: P, monitor: api, sender: api }, document: { getElementById: n => elements.get(n), body: { classList: { toggle() {} } } },
    navigator: { mediaDevices: {} }, RTCPeerConnection: Peer, MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
    location: { search: '' }, URLSearchParams, console, performance, setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../' + file), 'utf8'), context);
  return { context, callbacks, sent, states, connections, elements, timers, windowEvents };
}

test('screen encoder scales the whole native frame once; app-window capture retains its existing behavior', async () => {
  for (const native of [true, false]) {
    const f = rtcFixture('sender-renderer.js'), parameters = [];
    let constraints;
    const track = { getSettings: () => ({ width: 2560, height: 1440 }), stop() {} };
    f.context.navigator.mediaDevices.getUserMedia = async c => {
      constraints = c;
      return { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] };
    };
    f.context.RTCRtpSender = { getCapabilities: () => ({ codecs: [] }) };
    f.context.window.TwinDeskScreenCodec = { ...require('../../shared/screencodec'), order: c => c, RTPMAP: /H264/ };
    f.context.RTCPeerConnection.prototype.createOffer = async () => ({ sdp: '' });
    f.context.RTCPeerConnection.prototype.addTransceiver = () => ({ setCodecPreferences() {}, sender: {
      getParameters: () => ({ encodings: [{}] }), setParameters: async p => parameters.push(p),
    } });
    const command = { session: 1, sourceId: 'screen:1', width: 1920, height: 1080, mbps: 20, offer: { kind: native ? 'screen' : 'window' },
      ...(native ? { captureWidth: 2560, captureHeight: 1440, detailSource: {width:2560,height:1440} } : { follow: true }) };
    f.context.command = command;
    await vm.runInContext('start(command)', f.context);
    assert.equal(f.states.some(s => s.status === 'failed'), false);
    assert.equal(constraints.video.mandatory.maxWidth, native ? 2560 : 1920);
    assert.equal(constraints.video.mandatory.minWidth, native ? 2560 : 2);
    assert.equal(parameters[0].encodings[0].scaleResolutionDownBy, native ? 4 / 3 : 1);
    assert.equal(parameters[0].encodings[0].maxBitrate, 20e6);
    if (native) {
      assert.equal(f.sent.find(m => m.t === P.T.RTC2_OFFER).detail.sizes[0].height, 1440);
      f.callbacks.on({ t: 'rtc.detail', session: 1, height: 1440 }); await tick();
      assert.equal(parameters.at(-1).encodings[0].scaleResolutionDownBy, 1);
      f.callbacks.on({ t: 'rtc.detail', session: 1, height: 0 }); await tick();
      assert.equal(parameters.at(-1).encodings[0].scaleResolutionDownBy, 4 / 3);
      const count = parameters.length;
      f.callbacks.on({ t: 'stop', session: 1 });
      f.callbacks.on({ t: 'rtc.detail', session: 1, height: 1440 }); await tick();
      assert.equal(parameters.length, count, 'a stopped sender cannot change resolution');
    } else assert.equal(f.sent.find(m => m.t === P.T.RTC2_OFFER).detail, undefined);
  }
});
test('native cursor frames reach the same encoder without recapturing or changing resolution and bitrate', async () => {
  for (const audio of [false, true]) {
  const f = rtcFixture('sender-renderer.js'), parameters = [], frames = [];
  let closed = 0, stopped = 0, oldCapture = 0, audioStopped = 0, temporaryStopped = 0, writeHook = null;
  f.context.MediaStreamTrackGenerator = class {
    constructor() { this.kind = 'video'; this.writable = { getWriter: () => ({ write: async frame => (writeHook ? writeHook(frame) : frames.push(frame)), abort: async () => {}, close: async () => {} }) }; }
    stop() { stopped++; }
  };
  f.context.MediaStream = class {
    constructor(tracks) { this.tracks = tracks; }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    getTracks() { return this.tracks; }
  };
  f.context.window.sender.nativeStart = async () => ({ available: true });
  f.context.navigator.mediaDevices.getUserMedia = async () => {
    oldCapture++;
    const video = { stop: () => temporaryStopped++ }, sound = { kind: 'audio', stop: () => audioStopped++ };
    return { getVideoTracks: () => [video], getAudioTracks: () => [sound], getTracks: () => [video, sound] };
  };
  f.context.RTCRtpSender = { getCapabilities: () => ({ codecs: [] }) };
  f.context.window.TwinDeskScreenCodec = { order: c => c, RTPMAP: /H264/ };
  f.context.RTCPeerConnection.prototype.createOffer = async () => ({ sdp: '' });
  f.context.RTCPeerConnection.prototype.addTransceiver = () => ({ setCodecPreferences() {}, sender: {
    getParameters: () => ({ encodings: [{}] }), setParameters: async p => parameters.push(p),
  } });
  f.context.command = { session: 1, width: 1920, height: 1080, captureWidth: 2560, captureHeight: 1440,
    captureRect: { x: -2560, y: 0, width: 2560, height: 1440 }, fps: 60, mbps: 20, audio, offer: { kind: 'screen' } };
  await vm.runInContext('start(command)', f.context);
  assert.equal(oldCapture, audio ? 1 : 0); assert.equal(f.states.some(s => s.status === 'failed'), false);
  assert.equal(temporaryStopped, audio ? 1 : 0);
  assert.equal(parameters[0].encodings[0].scaleResolutionDownBy, 4 / 3);
  assert.equal(parameters[0].encodings[0].maxBitrate, 20e6);
  assert.equal(parameters[0].encodings[0].maxFramerate, 60);
  const frame = { close: () => closed++ };
  await f.windowEvents.message({ source: f.context.window, data: { type: 'twindesk-native-frame', session: 1, frame } });
  assert.deepEqual(frames, [frame]); assert.equal(closed, 1);
  // A frame while one is being written is closed at once (its slot goes back to the capture exe), and
  // the write going on keeps the lock: the dropped one used to clear it, so writes piled up and held
  // all three slots.
  const slow = [];
  let finish;
  writeHook = (fr) => { slow.push(fr); return new Promise((r) => { finish = r; }); };
  const count = () => ({ closed: 0, close() { this.closed++; } });
  const busy = count(), late = count(), after = count();
  const first = f.windowEvents.message({ source: f.context.window, data: { type: 'twindesk-native-frame', session: 1, frame: busy } });
  await f.windowEvents.message({ source: f.context.window, data: { type: 'twindesk-native-frame', session: 1, frame: late } });
  assert.equal(late.closed, 1, 'the frame that came during a write is dropped');
  await f.windowEvents.message({ source: f.context.window, data: { type: 'twindesk-native-frame', session: 1, frame: after } });
  assert.equal(slow.length, 1, 'one write at a time, even after a dropped frame');
  assert.equal(after.closed, 1);
  finish(); await first;
  assert.equal(busy.closed, 1);
  writeHook = null;
  vm.runInContext('stop(1)', f.context);
  await f.windowEvents.message({ source: f.context.window, data: { type: 'twindesk-native-frame', session: 1, frame } });
  assert.equal(frames.length, 1); assert.equal(closed, 2); assert.equal(stopped, 1);
  assert.equal(audioStopped, audio ? 1 : 0);
  }
});
test('unavailable native capture releases its generator and uses the original capture constraints', async () => {
  const f = rtcFixture('sender-renderer.js');
  let closed = 0, stopped = 0, constraints;
  f.context.MediaStreamTrackGenerator = class {
    constructor() { this.writable = { getWriter: () => ({ close: async () => closed++ }) }; }
    stop() { stopped++; }
  };
  f.context.window.sender.nativeStart = async () => ({ available: false });
  f.context.navigator.mediaDevices.getUserMedia = async c => { constraints = c; throw new Error('fallback reached'); };
  f.context.command = { session: 1, width: 1920, height: 1080, captureWidth: 2560, captureHeight: 1440,
    captureRect: { x: 0, y: 0, width: 2560, height: 1440 }, mbps: 20, fps: 60, offer: { kind: 'screen' } };
  await vm.runInContext('start(command)', f.context);
  assert.equal(constraints.video.mandatory.minWidth, 2560);
  assert.equal(constraints.video.mandatory.maxFrameRate, 60);
  assert.equal(closed, 1); assert.equal(stopped, 1);
  assert.match(f.states[0].error, /fallback reached/);
});
test('stopping during native startup releases the track and cannot start a late capture', async () => {
  const f = rtcFixture('sender-renderer.js'), ready = deferred();
  let aborted = 0, stopped = 0, oldCapture = 0;
  f.context.MediaStreamTrackGenerator = class {
    constructor() { this.writable = { getWriter: () => ({ abort: async () => aborted++ }) }; }
    stop() { stopped++; }
  };
  f.context.window.sender.nativeStart = () => ready.promise;
  f.context.navigator.mediaDevices.getUserMedia = async () => { oldCapture++; };
  f.context.command = { session: 1, captureRect: {}, offer: { kind: 'screen' } };
  const starting = vm.runInContext('start(command)', f.context);
  vm.runInContext('stop(1)', f.context);
  ready.resolve({ available: true }); await starting;
  assert.equal(aborted, 1); assert.equal(stopped, 1);
  assert.equal(oldCapture, 0); assert.equal(f.connections.length, 0); assert.equal(f.states.length, 0);
});
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

test('the picture keeps to the session network: candidates on another one are not taken', () => {
  const f = rtcFixture('sender-renderer.js'), logged = [];
  f.context.window.sender.log = (text) => logged.push(text);
  vm.runInContext('globalThis.testPeer = new RTCPeerConnection(); sessions.set(1, {session: 1, pc: testPeer, pending: null, mbps: 20, net: {address: "192.168.50.3", netmask: "255.255.255.0"}})', f.context);
  const candidates = []; f.connections[0].addIceCandidate = c => { candidates.push(c.candidate.split(' ')[4]); return Promise.resolve(); };
  const c = (address) => ({ candidate: `candidate:1 1 udp 2122260223 ${address} 50000 typ host generation 0` });
  for (const a of ['192.168.50.4', '10.6.0.4', 'abc.local', 'fe80::1']) f.callbacks.on({ t: P.T.RTC2_ICE, session: 1, candidate: c(a) });
  assert.deepEqual(candidates, ['192.168.50.4', 'abc.local', 'fe80::1']); // names and IPv6: no network to tell
  assert.equal(logged.length, 1);
  vm.runInContext('sessions.get(1).net = null', f.context); // no session network (Bluetooth, a router between): every one
  f.callbacks.on({ t: P.T.RTC2_ICE, session: 1, candidate: c('10.6.0.4') });
  assert.equal(candidates.at(-1), '10.6.0.4');
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

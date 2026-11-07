// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Monitor 2 renderer: answers the Mac's WebRTC offer and plays the video, paced as the Receive tab
// says ('smooth' = about a frame of buffer, even motion; 'fast' = lowest latency).
// With ?test=1 it plays a local moving test pattern instead (dev only, no Mac needed).
const P = window.MacShareProtocol;
const T = P.T;
const api = window.monitor;
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const statsBox = document.getElementById('stats');
const playerI18n = window.PlayerI18n;
const audio = document.getElementById('audio');
let audioCfg = { on: true, volume: 1 };
let streamAudio = false; // stream.info.audio: the Mac shares sound with the screen

let pc = null;
let session = null;
let pending = null; // remote candidates queued until the remote description is set
let streamName = '';
let pacing = 'fast';
const fgCanvas = document.getElementById('framegen');
let fg = null; // FrameGen, made the first time frame generation is switched on
let fgOn = false;

// smooth: a 16 ms jitter buffer target and no playout delay hint (WebRTC paces frames evenly);
// fast: both 0, every frame shown the moment it is decoded (may judder on Wi-Fi). Both are
// nullable in Chromium, so smooth clears a hint that fast left behind.
// steady: neither, and the answer leaves out the playout-delay extension (steadySdp), so the
// sender's "show it now" on every frame (main.js field trial) never arrives: WebRTC's own pacing,
// as a web browser plays it. It takes a new session: the sender starts one when Playback changes.
function pace(receiver) {
  const fast = pacing === 'fast';
  const steady = pacing === 'steady';
  if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = fast ? 0 : steady ? null : 16;
  if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = fast ? 0 : null;
}
const steadySdp = (sdp) => (pacing === 'steady' ? sdp.replace(/^a=extmap:[^\r\n]*\/playout-delay\r?\n/gm, '') : sdp);
// The peer's screen.state: while we wait for its picture, say what is happening.
api.onRemote((r) => {
  if (pc || !r) return;
  if (r.on) setOverlay(streamName ? 'Waiting for {name}…' : 'Waiting for the picture…', { name: streamName });
  else setOverlay(r.remote ? 'Starting the screen over there…' : 'Not sharing. Turn on sharing over there.');
});
api.onPacing((p) => {
  const was = pacing;
  pacing = p && ['smooth', 'steady'].includes(p.pacing) ? p.pacing : 'fast';
  if (pacing !== was && pc) for (const r of pc.getReceivers()) if (r.track.kind === 'video') pace(r);
  frameGen(!!(p && p.framegen));
});

// Frame generation (optional, off by default): in-between frames when the stream is slower than
// this screen, about one refresh of extra delay. Without WebGL2 it stays off.
function frameGen(on) {
  if (on && !fgOn) {
    try {
      if (!fg) fg = new window.FrameGen(video, fgCanvas);
      fg.start();
      fgOn = true;
    } catch (err) {
      console.warn('[monitor] frame generation unavailable:', err.message);
    }
  } else if (!on && fgOn) {
    fg.stop();
    fgOn = false;
  }
  showFrameGen();
}

// The canvas keeps its last picture, so it shows only while there is video.
function showFrameGen() {
  const show = fgOn && !!video.srcObject;
  fgCanvas.classList.toggle('hidden', !show);
  document.body.classList.toggle('framegen', show);
}

function setOverlay(key, vars) {
  playerI18n.text(overlay, key, vars);
  overlay.classList.toggle('hidden', !key);
}

function closePc() {
  if (pc) pc.close();
  pc = null;
  session = null;
  pending = null;
  video.srcObject = null;
  audio.srcObject = null;
  showFrameGen();
}

function applyAudio() {
  audio.muted = !audioCfg.on || !streamAudio;
  audio.volume = audioCfg.volume;
  if (audio.srcObject && audioCfg.on) audio.play().catch(() => {});
}
api.onAudio((a) => { audioCfg = a; applyAudio(); });

async function onOffer(msg) {
  closePc();
  const my = (pc = new RTCPeerConnection({ iceServers: [] }));
  session = msg.session;
  const queue = (pending = []);
  setOverlay(streamName ? 'Connecting to {name}…' : 'Connecting to the other computer…', { name: streamName });

  my.ontrack = (e) => {
    if (e.track.kind === 'video') pace(e.receiver);
    else if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 0; // sound: lowest latency
    if (e.track.kind === 'audio') { // the Mac's sound, played next to the muted video
      audio.srcObject = new MediaStream([e.track]);
      applyAudio();
      return;
    }
    video.srcObject = new MediaStream([e.track]);
    video.play().catch(() => {});
  };
  my.onicecandidate = (e) => {
    if (e.candidate && my === pc) api.send({ t: T.RTC_ICE, session: msg.session, candidate: e.candidate.toJSON() });
  };
  my.onconnectionstatechange = () => {
    if (my !== pc) return;
    if (my.connectionState === 'failed') setOverlay('Reconnecting…');
    else if (my.connectionState === 'disconnected') setOverlay('The video connection was interrupted…');
    else if (my.connectionState === 'connected' && video.readyState >= 2) setOverlay('');
  };

  try {
    await my.setRemoteDescription({ type: 'offer', sdp: steadySdp(msg.sdp) });
    for (const c of queue) await my.addIceCandidate(c).catch((err) => console.warn('ice', err.message));
    if (my !== pc) return;
    pending = null;
    await my.setLocalDescription(await my.createAnswer());
    if (my !== pc) return;
    api.send({ t: T.RTC_ANSWER, session: msg.session, sdp: my.localDescription.sdp });
  } catch (err) {
    console.error('[monitor] offer failed', err);
    if (my === pc) setOverlay('Could not start the video: {error}', { error: err.message });
  }
}

function onIce(msg) {
  if (!pc || msg.session !== session || !msg.candidate) return;
  if (pending) pending.push(msg.candidate);
  else pc.addIceCandidate(msg.candidate).catch((err) => console.warn('ice', err.message));
}

video.addEventListener('playing', () => { setOverlay(''); showFrameGen(); });

// ---- stats overlay (F9) ----

let statsTimer = null;
let lastIn = null;
let statsSnapshot = null;

function renderStats() {
  if (!statsSnapshot) return;
  const { vars, hardware } = statsSnapshot;
  statsBox.textContent = [
    playerI18n.t('{width}×{height}  {fps} fps  {mbps} Mbps', vars),
    playerI18n.t('{codec}  decoder {decoder}{hardware}', { ...vars, hardware: hardware ? playerI18n.t(' (hw)') : '' }),
    playerI18n.t('jitter buffer {buffer} ms  decode {decode} ms  rx→decoded {processing} ms', vars),
    playerI18n.t('network RTT {rtt} ms  lost {lost}  nack {nack}  pli {pli}', vars),
    playerI18n.t('dropped {dropped}  freezes {freezes}  keyframes {keyframes}', vars),
  ].join('\n');
}
playerI18n.onChange(renderStats);

async function updateStats() {
  if (!pc) { statsSnapshot = null; playerI18n.text(statsBox, 'no video session'); return; }
  const rep = await pc.getStats();
  let inb = null, pair = null;
  const byId = new Map();
  rep.forEach((r) => {
    byId.set(r.id, r);
    if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r;
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
  });
  if (!inb) { statsSnapshot = null; playerI18n.text(statsBox, 'waiting for video…'); return; }
  const now = performance.now();
  const d = (k) => (lastIn ? inb[k] - (lastIn[k] || 0) : 0);
  const mbps = lastIn ? (d('bytesReceived') * 8) / ((now - lastIn.at) * 1000) : 0;
  const per = (num, den) => { const n = d(num), dn = d(den); return dn > 0 ? (n / dn) * 1000 : 0; };
  const codec = byId.get(inb.codecId);
  statsSnapshot = {
    hardware: inb.powerEfficientDecoder,
    vars: {
      width: inb.frameWidth || 0, height: inb.frameHeight || 0,
      fps: Math.round(inb.framesPerSecond || 0), mbps: mbps.toFixed(1),
      codec: codec ? codec.mimeType.replace('video/', '') : '?', decoder: inb.decoderImplementation || '?',
      buffer: per('jitterBufferDelay', 'jitterBufferEmittedCount').toFixed(0),
      decode: per('totalDecodeTime', 'framesDecoded').toFixed(1),
      processing: per('totalProcessingDelay', 'framesDecoded').toFixed(0),
      rtt: pair && pair.currentRoundTripTime != null ? (pair.currentRoundTripTime * 1000).toFixed(0) : '?',
      lost: inb.packetsLost || 0, nack: inb.nackCount || 0, pli: inb.pliCount || 0,
      dropped: inb.framesDropped || 0, freezes: inb.freezeCount || 0, keyframes: inb.keyFramesDecoded || 0,
    },
  };
  lastIn = Object.assign({ at: now }, inb);
  playerI18n.literal(statsBox, '');
  renderStats();
}

function toggleStats() {
  const on = statsBox.classList.toggle('hidden') === false;
  clearInterval(statsTimer);
  statsTimer = null;
  lastIn = null;
  if (on) { updateStats(); statsTimer = setInterval(() => updateStats().catch(() => {}), 1000); }
}
api.onToggleStats(toggleStats);

// ---- Details for the Display tab: a summary once a second while a session runs ----

let lastSum = null;
async function reportStats() {
  if (!pc) { lastSum = null; return; }
  const rep = await pc.getStats();
  let inb = null, pair = null;
  const byId = new Map();
  rep.forEach((r) => {
    byId.set(r.id, r);
    if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r;
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
  });
  if (!inb) return;
  const now = performance.now();
  const d = (k) => (lastSum ? (inb[k] || 0) - (lastSum[k] || 0) : 0);
  const per = (num, den) => { const dn = d(den); return dn > 0 ? (d(num) / dn) * 1000 : 0; };
  const codec = byId.get(inb.codecId);
  api.stats({
    width: inb.frameWidth || 0,
    height: inb.frameHeight || 0,
    fps: Math.round(inb.framesPerSecond || 0),
    mbps: lastSum ? Math.round((d('bytesReceived') * 8) / ((now - lastSum.at) * 1000) * 10) / 10 : 0,
    codec: codec ? codec.mimeType.replace('video/', '') : '',
    decoder: inb.decoderImplementation || '',
    hw: inb.powerEfficientDecoder === true,
    rttMs: pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
    delayMs: Math.round(per('jitterBufferDelay', 'jitterBufferEmittedCount') + per('totalDecodeTime', 'framesDecoded')),
    dropped: inb.framesDropped || 0,
    freezes: inb.freezeCount || 0,
  });
  lastSum = Object.assign({ at: now }, inb);
}
setInterval(() => reportStats().catch(() => {}), 1000);

// ---- dev test source ----

function startTestPattern() {
  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  const g = canvas.getContext('2d');
  let frame = 0;
  function draw() {
    const w = canvas.width, h = canvas.height;
    g.fillStyle = '#202830';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#3a4654';
    for (let x = 0; x <= w; x += 120) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y <= h; y += 120) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    g.strokeStyle = '#e04848';
    g.lineWidth = 6;
    g.strokeRect(3, 3, w - 6, h - 6); // the full frame edge must be visible
    g.lineWidth = 1;
    const x = (frame * 8) % (w + 200) - 200;
    g.fillStyle = '#2f6fe4';
    g.fillRect(x, h / 2 - 100, 200, 200);
    g.fillStyle = '#ffffff';
    g.font = '48px system-ui, Ubuntu, Cantarell, sans-serif';
    g.fillText(playerI18n.t('TwinDesk test pattern, 1920×1080, frame {frame}', { frame }), 60, 100);
    g.font = '20px Consolas, monospace';
    g.fillText(playerI18n.t('The quick brown fox jumps over the lazy dog 0123456789'), 60, 150);
    frame++;
    requestAnimationFrame(draw);
  }
  draw();
  video.srcObject = canvas.captureStream(30);
  video.play().catch(() => {});
}

if (new URLSearchParams(location.search).get('test') === '1') {
  startTestPattern();
} else {
  api.onRtc((msg) => {
    switch (msg.t) {
      case T.STREAM_INFO:
        streamName = msg.name;
        streamAudio = msg.audio === true;
        applyAudio();
        if (!pc) setOverlay(streamName ? 'Waiting for {name}…' : 'Waiting for the other computer…', { name: streamName });
        break;
      case T.RTC_OFFER: onOffer(msg); break;
      case T.RTC_ICE: onIce(msg); break;
      case T.STREAM_STOP:
        closePc();
        setOverlay(streamName ? '{name} stopped sharing' : 'The other computer stopped sharing', { name: streamName }); // not "Mac": a PC or Linux too (#81)
        break;
    }
  });
  api.ready();
}

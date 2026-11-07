// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// PC-screen viewer: answers the PC's rtc2 offer (recvonly) and plays it at the lowest
// latency (jitter buffer target 0, H.264 decoded by VideoToolbox); sends mouse input over the drawn
// picture as in.* (normalized 0–1, semantics). Keys are sent by main.
// Pacing 'smooth' (≈ one frame of buffer, even motion) or 'fast' (shown the moment it
// is decoded); optional frame generation (shared/framegen.js) on a canvas over the video; a
// toolbar at the top edge to switch the other computer's Extend/Mirror, frame generation, full
// screen, and stop.
'use strict';

const P = window.MacShareProtocol;
const T = P.T;
const api = window.pcview;
const I = window.PlayerI18n;
I.translate();
function setTitle(title, key) {
  const element = document.querySelector('title');
  if (key === 'PC' || key === 'PC app') I.text(element, key);
  else if (title) I.literal(element, title);
  else I.text(element, 'PC');
}
const query = new URLSearchParams(location.search);
setTitle(query.get('title'), query.get('titleKey'));
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');

const BUTTONS = { 0: P.BUTTON.LEFT, 1: P.BUTTON.MIDDLE, 2: P.BUTTON.RIGHT, 3: P.BUTTON.BACK, 4: P.BUTTON.FORWARD };
const LINE_PX = 40;

let pc = null;
let session = null;
let pending = null; // remote candidates until the remote description is set
let inputOn = true;
let statsTimer = null;
let last = null;
const heldButtons = new Set();
let lastPos = { x: 0.5, y: 0.5 };
let pacing = 'fast';
let receivers = [];
let fg = null; // FrameGen while frame generation is on
const bar = document.getElementById('bar');
const btn = (id) => document.getElementById(id);

// steady: no hints, and the answer leaves out the playout-delay extension (steadySdp), so the PC's
// "show it now" on every frame (its main.js field trial) never arrives: WebRTC's own pacing, as a
// web browser plays it. It takes a new session: the PC starts one when Playback changes.
const steadySdp = (sdp) => (pacing === 'steady' ? sdp.replace(/^a=extmap:[^\r\n]*\/playout-delay\r?\n/gm, '') : sdp);
const paceOf = (p) => (['smooth', 'steady'].includes(p) ? p : 'fast');

function applyPacing() {
  for (const r of receivers) {
    if (r.track.kind !== 'video') continue;
    if ('jitterBufferTarget' in r) r.jitterBufferTarget = pacing === 'fast' ? 0 : pacing === 'steady' ? null : 16;
    if ('playoutDelayHint' in r) r.playoutDelayHint = pacing === 'fast' ? 0 : null;
  }
}

function setFrameGen(on) {
  btn('b-fg').classList.toggle('on', !!on);
  if (on && !fg && window.FrameGen && 'requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    try {
      fg = new window.FrameGen(video, document.getElementById('fg'));
      fg.start();
      document.body.classList.add('fg');
    } catch (e) {
      console.error('frame generation unavailable: ' + e.message);
      fg = null;
    }
  } else if (!on && fg) {
    fg.stop();
    fg = null;
    document.body.classList.remove('fg');
  }
}

// Toolbar: the other computer's screen.state decides what it shows.
let remote = null;
function showRemote(r) {
  remote = r;
  bar.classList.toggle('hidden', !r);
  if (!r) return;
  const can = r.remote && r.on;
  for (const m of ['extend', 'mirror']) {
    const b = btn(`b-${m}`);
    b.hidden = !(r.modes || []).includes(m);
    b.disabled = !can;
    b.classList.toggle('on', r.on && r.mode === m);
  }
  btn('b-stop').disabled = !can;
  btn('b-stop').hidden = !r.on;
}
btn('b-extend').onclick = () => api.ctl({ mode: 'extend' });
btn('b-mirror').onclick = () => api.ctl({ mode: 'mirror' });
btn('b-stop').onclick = () => api.ctl({ share: false });
btn('b-fg').onclick = () => api.ctl({ framegen: !btn('b-fg').classList.contains('on') });
btn('b-full').onclick = () => api.ctl({ fullScreen: true });
let barTimer = null;
function pokeBar(y) {
  if (y > 48 && !bar.matches(':hover')) return;
  bar.classList.add('show');
  clearTimeout(barTimer);
  barTimer = setTimeout(() => !bar.matches(':hover') && bar.classList.remove('show'), 2000);
}
bar.addEventListener('mouseleave', () => pokeBar(0));
// Clicks on the toolbar stay here (never sent to the other computer).
for (const ev of ['mousedown', 'mouseup', 'wheel']) bar.addEventListener(ev, (e) => e.stopPropagation());

function setOverlay(key, vars) {
  I.text(overlay, key, vars);
  overlay.classList.toggle('hidden', !key);
}

function report(status, extra) {
  api.state({ session, status, ...extra });
}

function closePc() {
  if (pc) pc.close();
  pc = null;
  pending = null;
  video.srcObject = null;
  clearInterval(statsTimer);
  last = null;
}

async function onOffer(m) {
  closePc();
  session = m.session;
  inputOn = m.input;
  pacing = paceOf(m.pacing);
  receivers = [];
  setFrameGen(!!m.framegen);
  document.body.classList.toggle('input-off', !inputOn);
  video.muted = !m.audio;
  video.volume = Math.max(0, Math.min(1, Number(m.volume)));
  const my = (pc = new RTCPeerConnection({ iceServers: [] }));
  const queue = (pending = []);
  const ms = new MediaStream();
  setOverlay('Connecting…');

  my.ontrack = (e) => {
    receivers.push(e.receiver);
    applyPacing();
    ms.addTrack(e.track);
    if (video.srcObject !== ms) video.srcObject = ms;
    video.play().catch(() => {});
  };
  my.onicecandidate = (e) => e.candidate && my === pc && api.send({ t: T.RTC2_ICE, session: m.session, candidate: e.candidate.toJSON() });
  my.onconnectionstatechange = () => {
    if (my !== pc) return;
    const st = my.connectionState;
    report(st === 'connected' ? 'live' : st);
    if (st === 'failed') setOverlay('Reconnecting…');
    else if (st === 'disconnected') setOverlay('Reconnecting…');
  };

  try {
    await my.setRemoteDescription({ type: 'offer', sdp: steadySdp(m.sdp) });
    // H.265 when both have it, else H.264 first (hardware decode), as the PC offers it.
    for (const tr of my.getTransceivers()) {
      tr.direction = 'recvonly';
      if (tr.receiver.track.kind !== 'video' || !RTCRtpReceiver.getCapabilities) continue;
      const codecs = RTCRtpReceiver.getCapabilities('video').codecs;
      tr.setCodecPreferences(window.TwinDeskScreenCodec.order(codecs)); // H.265 when listed, then H.264 (shared/screencodec.js)
    }
    await my.setLocalDescription(await my.createAnswer());
    if (my !== pc) return;
    api.send({ t: T.RTC2_ANSWER, session: m.session, sdp: my.localDescription.sdp });
    for (const c of queue) await my.addIceCandidate(c).catch(() => {});
    if (my === pc) pending = null;
    statsTimer = setInterval(() => stats(my).catch(() => {}), 1000);
  } catch (e) {
    if (my === pc) {
      setOverlay('Could not show the screen: {error}', { error: e.message });
      report('failed');
    }
  }
}

function onIce(m) {
  if (!pc || m.session !== session || !m.candidate) return;
  if (pending) pending.push(m.candidate);
  else pc.addIceCandidate(m.candidate).catch(() => {});
}

video.addEventListener('playing', () => setOverlay(''));
video.addEventListener('resize', () => report(undefined, { size: { width: video.videoWidth, height: video.videoHeight } }));

async function stats(my) {
  if (my !== pc) return;
  const rep = await my.getStats();
  let inb = null;
  const byId = new Map();
  rep.forEach((r) => {
    byId.set(r.id, r);
    if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r;
  });
  if (!inb) return;
  const now = performance.now();
  const d = (k) => (last ? (inb[k] || 0) - (last[k] || 0) : 0);
  const per = (a, b) => (d(b) > 0 ? (d(a) / d(b)) * 1000 : 0);
  const codec = byId.get(inb.codecId);
  const s = {
    width: inb.frameWidth || 0,
    height: inb.frameHeight || 0,
    fps: Math.round(inb.framesPerSecond || 0),
    mbps: last ? Number(((d('bytesReceived') * 8) / ((now - last.at) * 1000)).toFixed(1)) : 0,
    codec: codec ? codec.mimeType.replace('video/', '') : '',
    decoder: (inb.decoderImplementation || '') + (inb.powerEfficientDecoder ? ' (hw)' : ''),
    bufferMs: Math.round(per('jitterBufferDelay', 'jitterBufferEmittedCount')),
    dropped: inb.framesDropped || 0,
    freezes: inb.freezeCount || 0,
    framegen: !!(fg && fg.active),
    decodeMs: Number(per('totalDecodeTime', 'framesDecoded').toFixed(1)),
  };
  last = { at: now, ...inb };
  report(undefined, { stats: s });
}

// ---- mouse over the drawn picture (object-fit: contain letterboxes it) ----

function drawnRect() {
  const r = video.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || !r.width || !r.height) return null;
  const k = Math.min(r.width / vw, r.height / vh);
  const w = vw * k, h = vh * k;
  return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
}

function norm(e, clamp) {
  const r = drawnRect();
  if (!r) return null;
  let x = (e.clientX - r.x) / r.w;
  let y = (e.clientY - r.y) / r.h;
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1) && !clamp) return null;
  x = Math.min(1, Math.max(0, x));
  y = Math.min(1, Math.max(0, y));
  return { x, y };
}

const send = (m) => inputOn && session !== null && api.send(m);

// pointerrawupdate fires as soon as the OS delivers the move (not aligned to frames): lowest latency.
function onMove(e) {
  pokeBar(e.clientY);
  if (e.target && bar.contains(e.target)) return;
  if (!inputOn) return;
  const p = norm(e, heldButtons.size > 0);
  if (!p) return;
  lastPos = p;
  send({ t: T.IN_MOVE, x: p.x, y: p.y });
}
window.addEventListener('onpointerrawupdate' in window ? 'pointerrawupdate' : 'mousemove', onMove);

window.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const b = BUTTONS[e.button];
  const p = norm(e, false);
  if (!inputOn || b === undefined || !p) return;
  heldButtons.add(b);
  lastPos = p;
  send({ t: T.IN_DOWN, x: p.x, y: p.y, b });
});

window.addEventListener('mouseup', (e) => {
  e.preventDefault();
  const b = BUTTONS[e.button];
  if (!inputOn || b === undefined || !heldButtons.has(b)) return;
  const p = norm(e, true) || lastPos;
  heldButtons.delete(b);
  lastPos = p;
  send({ t: T.IN_UP, x: p.x, y: p.y, b });
});

window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('auxclick', (e) => e.preventDefault());

window.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!inputOn || !norm(e, false)) return;
  const k = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? window.innerHeight : 1;
  const dx = e.deltaX * k, dy = e.deltaY * k;
  if (dx || dy) send({ t: T.IN_WHEEL, dx, dy });
}, { passive: false });

function releaseButtons() {
  for (const b of heldButtons) send({ t: T.IN_UP, x: lastPos.x, y: lastPos.y, b });
  heldButtons.clear();
}
window.addEventListener('blur', releaseButtons);

api.on((m) => {
  switch (m.t) {
    case 'title': setTitle(m.title, m.titleKey); break;
    case 'offer': onOffer(m); break;
    case T.RTC2_ICE: onIce(m); break;
    case 'blur': releaseButtons(); break;
    case 'stop':
      releaseButtons();
      closePc();
      session = null;
      if (m.whyKey) setOverlay(m.whyKey, m.whyVars);
      else {
        I.literal(overlay, m.why || '');
        overlay.classList.toggle('hidden', !m.why);
      }
      break;
    case 'input':
      if (!m.on) releaseButtons();
      inputOn = m.on;
      document.body.classList.toggle('input-off', !inputOn);
      break;
    case 'cursor': document.body.classList.toggle('own-cursor', !!m.own); break;
    case 'volume': video.volume = Math.max(0, Math.min(1, Number(m.volume))); break;
    case 'pacing':
      pacing = paceOf(m.pacing);
      applyPacing();
      setFrameGen(!!m.framegen);
      break;
    case 'remote': showRemote(m); break;
  }
});
api.ready();

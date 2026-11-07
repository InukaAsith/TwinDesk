// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// One app window of the other PC (peerapps.js): answers its rtc2 offer (kind 'window', recvonly)
// and plays it at the lowest latency; mouse input over the drawn picture goes out as in.*
// (normalized 0–1 over this window's picture, main adds the `wid`). Keys are sent by main.
// Copy of mac/pcview-renderer.js without the screen toolbar, sound, stats and frame generation.
'use strict';

const P = window.MacShareProtocol;
const T = P.T;
const api = window.appview;
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const playerI18n = window.PlayerI18n;
const title = document.querySelector('title');
const query = new URLSearchParams(location.search);

function setTitle(value, key) {
  if (key === 'App' || !value) playerI18n.text(title, 'App');
  else playerI18n.literal(title, value);
}
setTitle(query.get('title'), query.get('titleKey'));

const BUTTONS = { 0: P.BUTTON.LEFT, 1: P.BUTTON.MIDDLE, 2: P.BUTTON.RIGHT, 3: P.BUTTON.BACK, 4: P.BUTTON.FORWARD };
const LINE_PX = 40;

let pc = null;
let session = null;
let pending = null; // remote candidates until the remote description is set
const heldButtons = new Set();
let lastPos = { x: 0.5, y: 0.5 };
let pacing = 'fast';

function setOverlay(key, vars) {
  playerI18n.text(overlay, key, vars);
  overlay.classList.toggle('hidden', !key);
}

function closePc() {
  if (pc) pc.close();
  pc = null;
  pending = null;
  video.srcObject = null;
}

async function onOffer(m) {
  closePc();
  session = m.session;
  pacing = ['smooth', 'steady'].includes(m.pacing) ? m.pacing : 'fast'; // steady: as monitor.js
  const my = (pc = new RTCPeerConnection({ iceServers: [] }));
  const queue = (pending = []);
  const ms = new MediaStream();
  setOverlay('Connecting…');

  my.ontrack = (e) => {
    const r = e.receiver;
    if ('jitterBufferTarget' in r) r.jitterBufferTarget = pacing === 'fast' ? 0 : pacing === 'steady' ? null : 16;
    if ('playoutDelayHint' in r) r.playoutDelayHint = pacing === 'fast' ? 0 : null;
    ms.addTrack(e.track);
    if (video.srcObject !== ms) video.srcObject = ms;
    video.play().catch(() => {});
  };
  my.onicecandidate = (e) => e.candidate && my === pc && api.send({ t: T.RTC2_ICE, session: m.session, candidate: e.candidate.toJSON() });
  my.onconnectionstatechange = () => {
    if (my === pc && (my.connectionState === 'failed' || my.connectionState === 'disconnected')) setOverlay('Reconnecting…');
  };

  try {
    await my.setRemoteDescription({ type: 'offer', sdp: pacing === 'steady' ? m.sdp.replace(/^a=extmap:[^\r\n]*\/playout-delay\r?\n/gm, '') : m.sdp });
    // H.265 when both have it, else H.264 first (hardware decode), as the sender offers it.
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
  } catch (e) {
    if (my === pc) setOverlay('Could not show the window: {error}', { error: e.message });
  }
}

function onIce(m) {
  if (!pc || m.session !== session || !m.candidate) return;
  if (pending) pending.push(m.candidate);
  else pc.addIceCandidate(m.candidate).catch(() => {});
}

video.addEventListener('playing', () => setOverlay(''));

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

const send = (m) => session !== null && api.send(m);

// pointerrawupdate fires as soon as the OS delivers the move (not aligned to frames): lowest latency.
function onMove(e) {
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
  if (b === undefined || !p) return;
  heldButtons.add(b);
  lastPos = p;
  send({ t: T.IN_DOWN, x: p.x, y: p.y, b });
});

window.addEventListener('mouseup', (e) => {
  e.preventDefault();
  const b = BUTTONS[e.button];
  if (b === undefined || !heldButtons.has(b)) return;
  const p = norm(e, true) || lastPos;
  heldButtons.delete(b);
  lastPos = p;
  send({ t: T.IN_UP, x: p.x, y: p.y, b });
});

window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('auxclick', (e) => e.preventDefault());

window.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!norm(e, false)) return;
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
      playerI18n.literal(overlay, m.why || '');
      overlay.classList.toggle('hidden', !m.why);
      break;
  }
});
api.ready();

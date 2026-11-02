// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The viewer (camera-view.html): the other computer's camera, answered recvonly to its offer.
// It opens hidden: its picture goes to the Camera tab, and to the virtual camera while that's on
// (shared/vcam-feed.js); Camera › Window shows it. Camera › Rotate turns it here too.
'use strict';

const api = window.cam;
const I = window.PlayerI18n;
I.translate();
const video = document.getElementById('video');
const status = document.getElementById('status');
const again = document.getElementById('again');
const mirror = document.getElementById('mirror');
const name = new URLSearchParams(location.search).get('name');
I.text(document.querySelector('title'), name ? '{name}’s camera' : 'Camera', { name });
const feed = window.CamOut ? window.CamOut() : null;
let pc = null;
let pending = [];

// Turned: the video sideways is as tall as the window is wide.
let turn = 0;
function place() {
  const side = turn % 180 !== 0;
  const w = innerWidth, h = innerHeight;
  Object.assign(video.style, {
    position: 'absolute', left: '50%', top: '50%',
    width: `${side ? h : w}px`, height: `${side ? w : h}px`,
    transform: `translate(-50%, -50%) rotate(${turn}deg)${document.body.classList.contains('mirror') ? ' scaleX(-1)' : ''}`,
  });
}
if (feed) feed.onRotate((deg) => { turn = deg; place(); });
addEventListener('resize', place);

// Each frame of the track onward, as it comes (a hidden window paints none).
async function feedTrack(track) {
  if (!feed) return;
  if (typeof MediaStreamTrackProcessor === 'function') {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      feed.push(value, value.displayWidth, value.displayHeight);
      value.close();
    }
  }
  const timer = setInterval(() => {
    if (track.readyState === 'ended') return clearInterval(timer);
    if (video.readyState >= 2) feed.push(video, video.videoWidth, video.videoHeight);
  }, 1000 / 30);
}

let message = null;
function renderMessage() {
  if (!message) return;
  const vars = message.vars || {};
  I.text(status, message.key, {
    ...vars,
    name: vars.name || I.t('the other computer'),
    error: vars.error || I.t('unknown'),
  });
}
I.onChange(renderMessage);

function say(key, retry = false, vars) {
  message = { key, vars };
  renderMessage();
  status.hidden = !key;
  again.hidden = !retry;
}

function reset() {
  if (pc) pc.close();
  pc = null;
  pending = [];
  video.srcObject = null;
}

// Candidates that came before the offer (the sender gathers as it sends it) are kept for it.
async function offer(sdp) {
  if (pc) pc.close();
  if (!pending) pending = [];
  const me = (pc = new RTCPeerConnection({ iceServers: [] }));
  me.ontrack = (e) => {
    video.srcObject = e.streams[0] || new MediaStream([e.track]);
    video.play().catch(() => {});
    if (e.track.kind === 'video') feedTrack(e.track).catch((err) => console.warn('vcam', err.message));
  };
  me.onicecandidate = (e) => e.candidate && pc === me && api.send({ t: 'ice', candidate: e.candidate.toJSON() });
  me.onconnectionstatechange = () => {
    if (pc !== me) return;
    if (me.connectionState === 'connected') { say(''); api.send({ t: 'live' }); }
    else if (me.connectionState === 'failed') say('The picture can’t get through from {name}: are both on the same network?', true, { name });
  };
  try {
    await me.setRemoteDescription({ type: 'offer', sdp });
    await me.setLocalDescription(await me.createAnswer());
    api.send({ t: 'answer', sdp: me.localDescription.sdp });
    for (const c of pending.splice(0)) await me.addIceCandidate(c).catch(() => {});
    pending = null;
  } catch (e) {
    say('The camera didn’t start: {error}', true, { error: e.message });
  }
}

api.on((m) => {
  if (!m) return;
  if (m.t === 'offer') offer(m.sdp);
  else if (m.t === 'ice') {
    if (!pc || pending) (pending || (pending = [])).push(m.candidate);
    else pc.addIceCandidate(m.candidate).catch(() => {});
  } else if (m.t === 'reset') {
    reset();
  } else if (m.t === 'status') {
    const n = m.name || name;
    if (m.status === 'starting') say('Asking {name} for its camera…', false, { name: n });
    else if (m.status === 'refused') { reset(); say('{name} doesn’t share its camera: turn on Camera › “Let this computer see the camera” there.', true, { name: n }); }
    else if (m.status === 'failed') { reset(); say('{name}’s camera didn’t start: {error}', true, { name: n, error: m.error }); }
    else if (m.status === 'ended') { reset(); say('{name} stopped its camera.', true, { name: n }); }
  }
});
again.onclick = () => api.send({ t: 'again' });
mirror.onclick = () => { mirror.classList.toggle('on', document.body.classList.toggle('mirror')); place(); };
api.send({ t: 'ready' });

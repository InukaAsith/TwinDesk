// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A web device's camera and microphone here: the page offers (cam.offer / mic.offer), we answer.
// The camera goes where every camera TwinDesk receives goes (shared/vcam-feed.js: the Camera tab's
// picture and, with Virtual camera on, TwinDesk Camera); the microphone plays into a virtual audio
// cable when one is installed (apps take it as a microphone there), else the speakers.
'use strict';

const api = window.webrecv;
const video = document.getElementById('v');
const audio = document.getElementById('a');
const feed = window.CamOut ? window.CamOut() : null;
const CABLE = /CABLE Input|VB-Audio|BlackHole|Loopback Audio|Soundflower|Virtual Cable|TwinDesk Microphone/i;
const conns = { cam: null, mic: null };
let stopFeed = () => {};

function feedTrack(track) {
  stopFeed();
  if (!feed) return;
  let active = true;
  if (typeof MediaStreamTrackProcessor === 'function') {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    stopFeed = () => { active = false; reader.cancel().catch(() => {}); };
    (async () => {
      while (active) {
        const { value, done } = await reader.read();
        if (done) return;
        try { if (active) feed.push(value, value.displayWidth, value.displayHeight); } finally { value.close(); }
      }
    })().catch(() => {});
    return;
  }
  const timer = setInterval(() => {
    if (track.readyState === 'ended') return clearInterval(timer);
    if (video.readyState >= 2) feed.push(video, video.videoWidth, video.videoHeight);
  }, 1000 / 30);
  stopFeed = () => { active = false; clearInterval(timer); };
}

async function cableOut() {
  try {
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    const d = outs.find((o) => CABLE.test(o.label));
    if (d && typeof audio.setSinkId === 'function') await audio.setSinkId(d.deviceId);
    return d ? d.label : '';
  } catch (_) {
    return '';
  }
}

function stop(kind) {
  const c = conns[kind];
  if (!c) return;
  conns[kind] = null;
  try { c.pc.close(); } catch (_) {}
  if (kind === 'cam') { stopFeed(); stopFeed = () => {}; video.srcObject = null; }
  else audio.srcObject = null;
  api.send({ t: 'state', kind, dev: c.dev, status: 'off' });
}

async function offer(kind, m) {
  stop(kind);
  const pc = new RTCPeerConnection({ iceServers: [] });
  const c = { pc, dev: m.dev, remoteSet: false, pending: [] };
  conns[kind] = c;
  pc.onicecandidate = (e) => e.candidate && conns[kind] === c && api.send({ t: `${kind}.ice`, dev: m.dev, candidate: e.candidate.toJSON() });
  pc.onconnectionstatechange = () => conns[kind] === c && api.send({ t: 'state', kind, dev: m.dev, status: pc.connectionState === 'connected' ? 'live' : pc.connectionState });
  pc.ontrack = async (e) => {
    if (conns[kind] !== c) return;
    if (kind === 'cam' && e.track.kind === 'video') {
      video.srcObject = new MediaStream([e.track]);
      video.play().catch(() => {});
      feedTrack(e.track);
    } else if (kind === 'mic' && e.track.kind === 'audio') {
      const out = await cableOut();
      audio.srcObject = new MediaStream([e.track]);
      audio.play().catch(() => {});
      api.send({ t: 'state', kind, dev: m.dev, status: 'live', out });
    }
  };
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
    c.remoteSet = true;
    for (const x of c.pending.splice(0)) await pc.addIceCandidate(x);
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    api.send({ t: `${kind}.answer`, dev: m.dev, sdp: pc.localDescription.sdp });
  } catch (e) {
    api.send({ t: 'state', kind, dev: m.dev, status: `error: ${e.message}` });
    stop(kind);
  }
}

api.on(async (m) => {
  const [kind, what] = String(m.t).split('.');
  if (kind !== 'cam' && kind !== 'mic') return;
  if (what === 'offer') return offer(kind, m);
  if (what === 'stop') return stop(kind);
  if (what === 'ice' && m.candidate) {
    const c = conns[kind];
    if (!c) return;
    if (c.remoteSet) c.pc.addIceCandidate(m.candidate).catch(() => {});
    else c.pending.push(m.candidate);
  }
});
if (feed && window.camout) window.camout.hello();

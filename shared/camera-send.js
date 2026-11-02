// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The hidden sender (camera-send.html): this computer's camera, while the other computer's
// window is open, as one WebRTC video track (we offer, the viewer answers recvonly). 1280 × 720 at
// 30 fps when the camera has it, up to 4 Mb/s. The camera goes off with 'stop' or when the window
// closes (camshare.js).
'use strict';

const api = window.cam;
const MBPS = 4;
let me = null; // {pc, stream, pending}

const status = (s, error = '') => api.send({ t: 'status', status: s, error });

async function start(deviceId) {
  stop();
  const cur = (me = { pc: null, stream: null, pending: [] });
  const alive = () => me === cur;
  try {
    const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      if (!deviceId || e.name !== 'OverconstrainedError') throw e;
      delete video.deviceId; // the chosen camera is gone: the default one
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    }
    if (!alive()) return stream.getTracks().forEach((t) => t.stop());
    cur.stream = stream;
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'motion';
    track.onended = () => { if (alive()) { status('failed', 'the camera went away'); stop(); } };
    const pc = (cur.pc = new RTCPeerConnection({ iceServers: [] }));
    const tr = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    pc.onicecandidate = (e) => e.candidate && alive() && api.send({ t: 'ice', candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => {
      if (!alive()) return;
      if (pc.connectionState === 'connected') status('live');
      else if (pc.connectionState === 'failed') status('failed', 'no network path to the other computer');
    };
    const offer = await pc.createOffer();
    if (!alive()) return;
    await pc.setLocalDescription(offer);
    if (!alive()) return;
    api.send({ t: 'offer', sdp: pc.localDescription.sdp }); // before its candidates
    const p = tr.sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    Object.assign(p.encodings[0], { maxBitrate: MBPS * 1e6, maxFramerate: 30 });
    p.degradationPreference = 'balanced';
    await tr.sender.setParameters(p).catch(() => {});
    devices(); // with the camera allowed, its names are known now
  } catch (e) {
    if (!alive()) return;
    const why = e.name === 'NotAllowedError' ? 'the camera isn’t allowed for TwinDesk'
      : e.name === 'NotFoundError' ? 'this computer has no camera'
        : e.name === 'NotReadableError' ? 'another app is using the camera' : e.message;
    status('failed', why);
    stop();
  }
}

async function answer(sdp) {
  const cur = me;
  if (!cur || !cur.pc) return;
  try {
    await cur.pc.setRemoteDescription({ type: 'answer', sdp });
    if (me !== cur || !cur.pending) return;
    const queue = cur.pending;
    cur.pending = null;
    for (const c of queue) {
      if (me !== cur) return;
      await cur.pc.addIceCandidate(c).catch(() => {});
    }
  } catch (e) {
    if (me === cur) status('failed', e.message);
  }
}

function ice(c) {
  if (!me) return;
  if (me.pending) me.pending.push(c);
  else if (me.pc) me.pc.addIceCandidate(c).catch(() => {});
}

function stop() {
  const cur = me;
  me = null;
  if (!cur) return;
  if (cur.pc) cur.pc.close();
  if (cur.stream) cur.stream.getTracks().forEach((t) => t.stop());
}

async function devices() {
  try {
    const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    api.send({ t: 'devices', list: list.map((d) => ({ id: d.deviceId, label: d.label })) });
  } catch (_) { /* none */ }
}

api.on((m) => {
  if (!m) return;
  if (m.t === 'start') start(m.deviceId || '');
  else if (m.t === 'answer') answer(m.sdp);
  else if (m.t === 'ice') ice(m.candidate);
  else if (m.t === 'stop') stop();
  else if (m.t === 'devices') devices();
});
navigator.mediaDevices.addEventListener('devicechange', devices);
api.send({ t: 'ready' });

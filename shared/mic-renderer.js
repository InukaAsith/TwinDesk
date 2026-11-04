// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Hidden microphone window (shared/mic.js): sends this computer's microphone (offers `mic.offer`),
// and plays the other computer's into the output apps take as a microphone (the TwinDesk
// Microphone on Linux, a virtual cable elsewhere, else the speakers). Opus mono, voice settings on.
'use strict';

const T = window.MacShareProtocol.T;
const api = window.mic;
const player = document.getElementById('play');
const CABLE = /CABLE Input|VB-Audio|BlackHole|Loopback Audio|Soundflower|Virtual Cable/i;

let recv = null; // {pc, session, pending, playing}
let send = null; // {pc, session, stream, pending, connected}
let error = '';
let want = { input: '', output: '', virtual: '' }; // devices picked (ids), the Linux microphone's name
let into = '';
let devices = { inputs: [], outputs: [] };

function report() {
  api.state({ sending: !!(send && send.connected), receiving: !!(recv && recv.playing), error, into, ...devices });
}

async function listDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const pick = (kind) => all.filter((d) => d.kind === kind && d.deviceId !== 'communications').map((d) => ({ id: d.deviceId, label: d.label || (kind === 'audioinput' ? 'Microphone' : 'Speaker') }));
    devices = { inputs: pick('audioinput'), outputs: pick('audiooutput') };
  } catch (_) { /* keep the last */ }
  return devices;
}

// Where the other computer's microphone plays: the output picked, else the TwinDesk Microphone's
// sink (Linux), else a virtual cable, else the default output.
async function routeOutput() {
  const { outputs } = await listDevices();
  let d = want.output && outputs.find((o) => o.id === want.output);
  if (!d && want.virtual) d = outputs.find((o) => /TwinDesk.Microphone.output/i.test(o.label));
  if (!d) d = outputs.find((o) => CABLE.test(o.label));
  into = d ? d.label : '';
  if (typeof player.setSinkId === 'function') await player.setSinkId(d ? d.id : '').catch((e) => { error = 'Output: ' + e.message; });
  report();
}

function lowLatency(receiver) {
  if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
  else receiver.playoutDelayHint = 0;
}

// ---- the other computer's microphone, here ----

async function onOffer(m) {
  closeRecv();
  const pc = new RTCPeerConnection(m.ice || { iceServers: [] });
  const me = (recv = { pc, session: m.session, pending: [], playing: false });
  pc.ontrack = (e) => {
    if (recv !== me) return;
    lowLatency(e.receiver);
    player.srcObject = new MediaStream([e.track]);
    routeOutput().then(() => player.play().catch(() => {}));
    me.playing = true;
    report();
  };
  pc.onicecandidate = (e) => e.candidate && recv === me && api.send({ t: T.MIC_ICE, session: m.session, to: 'send', candidate: e.candidate.toJSON() });
  pc.onconnectionstatechange = () => { if (recv === me && /failed|closed/.test(pc.connectionState)) { me.playing = false; report(); } };
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
    if (recv !== me) return;
    const queue = me.pending;
    me.pending = null;
    for (const c of queue) {
      if (recv !== me) return;
      await pc.addIceCandidate(c).catch(() => {});
    }
    const answer = await pc.createAnswer();
    if (recv !== me) return;
    await pc.setLocalDescription(answer);
    if (recv === me) api.send({ t: T.MIC_ANSWER, session: m.session, sdp: pc.localDescription.sdp });
    error = '';
  } catch (e) {
    if (recv !== me) return;
    closeRecv();
    error = 'The other microphone: ' + e.message;
  }
  report();
}

function closeRecv() {
  if (recv) recv.pc.close();
  recv = null;
  player.srcObject = null;
  report();
}

// ---- this computer's microphone, there ----

async function startSend(session, device, ice) {
  stopSend();
  const me = (send = { session, pending: [], connected: false });
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(device ? { deviceId: { exact: device } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    if (send !== me) return stream.getTracks().forEach((t) => t.stop());
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('no microphone');
    me.stream = stream;
    await listDevices(); // with the permission, the names show
    const pc = (me.pc = new RTCPeerConnection(ice || { iceServers: [] }));
    pc.addTransceiver(track, { direction: 'sendonly' });
    pc.onicecandidate = (e) => e.candidate && send === me && api.send({ t: T.MIC_ICE, session, to: 'recv', candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => { if (send === me) { me.connected = pc.connectionState === 'connected'; report(); } };
    const offer = await pc.createOffer();
    if (send !== me) return;
    await pc.setLocalDescription(offer);
    if (send !== me) return;
    api.send({ t: T.MIC_OFFER, session, sdp: pc.localDescription.sdp });
    error = '';
  } catch (e) {
    if (send !== me) return;
    stopSend();
    error = 'This microphone: ' + (e.name === 'NotAllowedError' ? 'not allowed' : e.message);
  }
  report();
}

async function onAnswer(m) {
  const me = send;
  if (!me || !me.pc || m.session !== me.session) return;
  try {
    await me.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
    if (send !== me || !me.pending) return;
    const queue = me.pending;
    me.pending = null;
    for (const c of queue) {
      if (send !== me) return;
      await me.pc.addIceCandidate(c).catch(() => {});
    }
  } catch (e) {
    if (send !== me) return;
    error = 'This microphone: ' + e.message;
    report();
  }
}

function stopSend() {
  if (send) {
    if (send.pc) send.pc.close();
    if (send.stream) send.stream.getTracks().forEach((t) => t.stop());
  }
  send = null;
  report();
}

// A candidate names the side it is for: `to: 'recv'` from a sender, `to: 'send'` from a receiver.
function onIce(m) {
  const s = m.to === 'recv' ? recv : send;
  if (!s || m.session !== s.session || !m.candidate) return;
  if (s.pending) s.pending.push(m.candidate);
  else if (s.pc) s.pc.addIceCandidate(m.candidate).catch(() => {});
}

navigator.mediaDevices.addEventListener('devicechange', () => { if (recv) routeOutput(); else listDevices().then(report); });

api.on((m) => {
  switch (m.t) {
    case T.MIC_OFFER: onOffer(m); break;
    case T.MIC_ANSWER: onAnswer(m); break;
    case T.MIC_ICE: onIce(m); break;
    case 'stop-recv': closeRecv(); break;
    case 'start-send': startSend(m.session, m.device, m.ice); break;
    case 'stop-send': stopSend(); break;
    case 'devices':
      want = { input: m.input || '', output: m.output || '', virtual: m.virtual || '' };
      if (recv) routeOutput(); else listDevices().then(report);
      break;
  }
});
api.ready();

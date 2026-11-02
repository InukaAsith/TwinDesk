// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Hidden sound window: the Mac → PC receiver (answers dir 'm2w') and the PC → Mac sender
// (offers dir 'w2m' with the system sound from WASAPI loopback). Audio-only, Opus stereo.
'use strict';

const T = window.MacShareProtocol.T;
const api = window.sound;
const player = document.getElementById('play');

let recv = null; // {pc, session, pending}
let send = null; // {pc, session, stream, pending}
let error = '';

function report() {
  api.state({ receiving: !!(recv && recv.playing), sending: !!(send && send.connected), error });
}

// Opus at 128 kbps stereo, in an SDP we set as the remote description (the encoder reads it there).
function opusStereo(sdp) {
  const m = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
  if (!m) return sdp;
  const pt = m[1];
  const re = new RegExp('a=fmtp:' + pt + ' ([^\\r\\n]*)');
  const extra = 'stereo=1;sprop-stereo=1;maxaveragebitrate=128000';
  return re.test(sdp) ? sdp.replace(re, (all, p) => 'a=fmtp:' + pt + ' ' + p.split(';').filter((x) => !/^(stereo|sprop-stereo|maxaveragebitrate)=/.test(x)).concat(extra).join(';'))
    : sdp.replace(m[0], m[0] + '\r\na=fmtp:' + pt + ' ' + extra);
}

function lowLatency(receiver) {
  if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
  else receiver.playoutDelayHint = 0;
}

// ---- Mac → PC ----

async function onOffer(m) {
  closeRecv();
  const pc = new RTCPeerConnection(m.ice || { iceServers: [] });
  const me = (recv = { pc, session: m.session, pending: [], playing: false });
  pc.ontrack = (e) => {
    if (recv !== me) return;
    lowLatency(e.receiver);
    player.srcObject = new MediaStream([e.track]);
    player.play().catch(() => {});
    me.playing = true;
    report();
  };
  pc.onicecandidate = (e) => e.candidate && recv === me && api.send({ t: T.AUDIO_ICE, dir: 'm2w', session: m.session, candidate: e.candidate.toJSON() });
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
    if (recv !== me) return;
    const answer = await pc.createAnswer();
    if (recv !== me) return;
    await pc.setLocalDescription(answer);
    if (recv === me) api.send({ t: T.AUDIO_ANSWER, dir: 'm2w', session: m.session, sdp: pc.localDescription.sdp });
  } catch (e) {
    if (recv !== me) return;
    closeRecv();
    error = 'Mac sound: ' + e.message;
    report();
  }
}

function closeRecv() {
  if (recv) recv.pc.close();
  recv = null;
  player.srcObject = null;
  report();
}

// ---- PC → Mac ----

async function startSend(session, ice) {
  stopSend();
  const me = (send = { session, pending: [], connected: false });
  try {
    // Electron answers this with the screen + WASAPI loopback; only the sound is kept.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
    });
    stream.getVideoTracks().forEach((t) => t.stop());
    const track = stream.getAudioTracks()[0];
    if (send !== me) return stream.getTracks().forEach((t) => t.stop());
    if (!track) throw new Error('Windows gave no system sound');
    me.stream = stream;
    const pc = (me.pc = new RTCPeerConnection(ice || { iceServers: [] }));
    pc.addTransceiver(track, { direction: 'sendonly' });
    pc.onicecandidate = (e) => e.candidate && send === me && api.send({ t: T.AUDIO_ICE, dir: 'w2m', session, candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => { if (send === me) { me.connected = pc.connectionState === 'connected'; report(); } };
    const offer = await pc.createOffer();
    if (send !== me) return;
    await pc.setLocalDescription(offer);
    if (send !== me) return;
    api.send({ t: T.AUDIO_OFFER, dir: 'w2m', session, sdp: pc.localDescription.sdp });
    error = '';
  } catch (e) {
    if (send !== me) return;
    stopSend();
    error = 'Sending this PC’s sound: ' + e.message;
  }
  report();
}

async function onAnswer(m) {
  const me = send;
  if (!me || !me.pc || m.session !== me.session) return;
  try {
    await me.pc.setRemoteDescription({ type: 'answer', sdp: opusStereo(m.sdp) });
    if (send !== me || !me.pending) return;
    const queue = me.pending;
    me.pending = null;
    for (const c of queue) {
      if (send !== me) return;
      await me.pc.addIceCandidate(c).catch(() => {});
    }
  } catch (e) {
    if (send !== me) return;
    error = 'Sending this PC’s sound: ' + e.message;
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

function onIce(m) {
  const s = m.dir === 'm2w' ? recv : send;
  if (!s || m.session !== s.session || !m.candidate) return;
  if (s.pending) s.pending.push(m.candidate);
  else if (s.pc) s.pc.addIceCandidate(m.candidate).catch(() => {});
}

api.on((m) => {
  switch (m.t) {
    case T.AUDIO_OFFER: onOffer(m); break;
    case T.AUDIO_ANSWER: onAnswer(m); break;
    case T.AUDIO_ICE: onIce(m); break;
    case T.AUDIO_STOP: closeRecv(); break;
    case 'start-send': startSend(m.session, m.ice); break;
    case 'stop-send': stopSend(); break;
    case 'stop-all': closeRecv(); stopSend(); break;
    case 'volume': player.volume = Math.min(1, Math.max(0, Number(m.volume) || 0)); break;
  }
});
api.ready();

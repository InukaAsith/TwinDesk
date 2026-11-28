// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Hidden sound window: the other computer → here receiver (answers dir 'm2w') and the here → other
// sender (offers dir 'w2m' with this computer's sound: the PulseAudio/PipeWire loopback source
// loopback.js loads, picked by its label). Audio-only, Opus stereo. Copy of windows/sound-renderer.js.
'use strict';

const T = window.MacShareProtocol.T;
const api = window.sound;
// Another computer's sound: on the speakers its route names, each at its volume (shared/sound-outs.js).
const outs = window.SoundOuts.create(() => report());

let recv = null; // {pc, session, pending}
let send = null; // {pc, session, stream, pending}
let error = '';

function report() {
  api.state({ receiving: !!(recv && recv.playing), sending: !!(send && send.connected), error, info: outs.info() });
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

// ---- the other computer → here ----

async function onOffer(m) {
  closeRecv();
  const pc = new RTCPeerConnection(m.ice || { iceServers: [] });
  const me = (recv = { pc, session: m.session, pending: [], playing: false });
  pc.ontrack = (e) => {
    outs.play(new MediaStream([e.track]), e.receiver, pc); // the jitter buffer: as small as it can, or Keep speakers in sync's
    me.playing = true;
    report();
  };
  pc.onicecandidate = (e) => e.candidate && recv === me && api.send({ t: T.AUDIO_ICE, dir: 'm2w', session: m.session, candidate: e.candidate.toJSON() });
  pc.onconnectionstatechange = () => { if (recv === me && /failed|closed/.test(pc.connectionState)) { me.playing = false; report(); } };
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
    for (const c of me.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    me.pending = null;
    await pc.setLocalDescription(await pc.createAnswer());
    if (recv === me) api.send({ t: T.AUDIO_ANSWER, dir: 'm2w', session: m.session, sdp: pc.localDescription.sdp });
  } catch (e) {
    error = '{Name}’s sound: ' + e.message;
    report();
  }
}

function closeRecv() {
  if (recv) recv.pc.close();
  recv = null;
  outs.stop(true);
  report();
}

// ---- here → the other computer ----

// The loopback source by its label (labels are there: Electron grants media access).
async function systemSound(label) {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const d = devs.find((x) => x.kind === 'audioinput' && x.label.includes(label));
  if (!d) throw new Error('the sound loopback device didn’t show up');
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: d.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
    video: false,
  });
}

async function startSend(session, label, ice) {
  stopSend();
  const me = (send = { session, pending: [], connected: false });
  try {
    const stream = await systemSound(label);
    const track = stream.getAudioTracks()[0];
    if (send !== me) return stream.getTracks().forEach((t) => t.stop());
    if (!track) throw new Error('no sound track');
    me.stream = stream;
    const pc = (me.pc = new RTCPeerConnection(ice || { iceServers: [] }));
    pc.addTransceiver(track, { direction: 'sendonly' });
    pc.onicecandidate = (e) => e.candidate && send === me && api.send({ t: T.AUDIO_ICE, dir: 'w2m', session, candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => { if (send === me) { me.connected = pc.connectionState === 'connected'; report(); } };
    await pc.setLocalDescription(await pc.createOffer());
    api.send({ t: T.AUDIO_OFFER, dir: 'w2m', session, sdp: pc.localDescription.sdp });
    error = '';
  } catch (e) {
    error = 'Sending this computer’s sound: ' + e.message;
  }
  report();
}

async function onAnswer(m) {
  const me = send;
  if (!me || !me.pc || m.session !== me.session) return;
  try {
    await me.pc.setRemoteDescription({ type: 'answer', sdp: opusStereo(m.sdp) });
    for (const c of me.pending.splice(0)) await me.pc.addIceCandidate(c).catch(() => {});
    me.pending = null;
  } catch (e) {
    error = 'Sending this computer’s sound: ' + e.message;
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
    case 'start-send': startSend(m.session, m.label, m.ice); break;
    case 'stop-send': stopSend(); break;
    case 'stop-all': closeRecv(); stopSend(); break;
    case 'volume': outs.volume(m.volume); break;
    case 'route': outs.route(m); break; // its speakers and sync (shared/sound-route.js)
  }
});
api.ready();

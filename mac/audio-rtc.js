// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Standalone sound: one audio-only peer connection per
// direction. m2w: this Mac sends (offerer, PCM from the helper via an AudioWorklet).
// w2m: the PC sends; this window answers and plays it.
'use strict';

const P = window.MacShareProtocol;
const api = window.audioApi;
// The PC's sound: on the speakers its route names, each at its volume (shared/sound-outs.js).
const outs = window.SoundOuts.create((info) => api.state({ info }));
let send = null; // {session, pc, actx, player, pendingIce, remoteSet}
let recv = null; // {session, pc, pendingIce}

// Opus: stereo, music-grade bitrate (system sound, not a voice call).
function withOpus(sdp) {
  const pt = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
  if (!pt) return sdp;
  return sdp.split('\r\n').map((l) => {
    if (!l.startsWith(`a=fmtp:${pt[1]} `)) return l;
    const keep = l.slice(`a=fmtp:${pt[1]} `.length).split(';').filter((x) => x && !/^(stereo|sprop-stereo|maxaveragebitrate)=/.test(x));
    return `a=fmtp:${pt[1]} ${[...keep, 'stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=128000'].join(';')}`;
  }).join('\r\n');
}

function close(s) {
  if (!s) return;
  if (s.pc) s.pc.close();
  if (s.actx) s.actx.close();
}

async function startSend({ session, ice }) {
  close(send);
  const me = { session, pendingIce: [], remoteSet: false };
  send = me;
  try {
    me.actx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await me.actx.audioWorklet.addModule('pcm-worklet.js');
    me.player = new AudioWorkletNode(me.actx, 'pcm-player', { outputChannelCount: [2] });
    const dest = me.actx.createMediaStreamDestination();
    dest.channelCount = 2;
    me.player.connect(dest);
    await me.actx.resume();
    const pc = new RTCPeerConnection(ice || { iceServers: [] });
    me.pc = pc;
    pc.addTransceiver(dest.stream.getAudioTracks()[0], { direction: 'sendonly' });
    pc.onicecandidate = (e) => e.candidate && send === me && api.send({ t: P.T.AUDIO_ICE, dir: 'm2w', session, candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => send === me && api.state({ dir: 'm2w', session, status: pc.connectionState });
    const offer = await pc.createOffer();
    await pc.setLocalDescription({ type: 'offer', sdp: withOpus(offer.sdp) });
    if (send === me) api.send({ t: P.T.AUDIO_OFFER, dir: 'm2w', session, sdp: pc.localDescription.sdp });
  } catch (e) {
    if (send === me) api.state({ dir: 'm2w', session, status: `error: ${e.message}` });
  }
}

async function onRecvOffer({ session, sdp, ice }) {
  close(recv);
  const me = { session, pendingIce: [] };
  recv = me;
  const pc = new RTCPeerConnection(ice || { iceServers: [] });
  me.pc = pc;
  pc.ontrack = (e) => {
    if (recv === me) outs.play(new MediaStream([e.track]), e.receiver, pc); // the jitter buffer: as small as it can, or Keep speakers in sync's
  };
  pc.onicecandidate = (e) => e.candidate && recv === me && api.send({ t: P.T.AUDIO_ICE, dir: 'w2m', session, candidate: e.candidate.toJSON() });
  pc.onconnectionstatechange = () => recv === me && api.state({ dir: 'w2m', session, status: pc.connectionState });
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: withOpus(sdp) });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription({ type: 'answer', sdp: withOpus(answer.sdp) });
    if (recv !== me) return;
    api.send({ t: P.T.AUDIO_ANSWER, dir: 'w2m', session, sdp: pc.localDescription.sdp });
    for (const c of me.pendingIce.splice(0)) await pc.addIceCandidate(c);
    me.remoteSet = true;
  } catch (e) {
    api.state({ dir: 'w2m', session, status: `error: ${e.message}` });
  }
}

async function onRemote(m) {
  const s = m.dir === 'm2w' ? send : recv;
  if (!s || !s.pc || m.session !== s.session) return;
  try {
    if (m.t === P.T.AUDIO_ANSWER && m.dir === 'm2w') {
      await s.pc.setRemoteDescription({ type: 'answer', sdp: withOpus(m.sdp) });
      s.remoteSet = true;
      for (const c of s.pendingIce.splice(0)) await s.pc.addIceCandidate(c);
    } else if (m.t === P.T.AUDIO_ICE && m.candidate) {
      if (s.remoteSet) await s.pc.addIceCandidate(m.candidate);
      else s.pendingIce.push(m.candidate);
    }
  } catch (e) {
    console.error(`audio ${m.t}:`, e);
  }
}

api.on('send-start', startSend);
api.on('send-stop', () => { close(send); send = null; });
api.on('recv', onRecvOffer);
api.on('recv-stop', () => { close(recv); recv = null; outs.stop(); });
api.on('remote', onRemote);
api.on('volume', (v) => outs.volume(v));
api.on('route', (m) => outs.route(m)); // its speakers and sync (shared/sound-route.js)
api.on('pcm', (buf) => {
  if (!send || !send.player) return;
  const copy = new Float32Array(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2));
  send.player.port.postMessage(copy, [copy.buffer]);
});

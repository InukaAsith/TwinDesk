// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Web's capture window: this computer's screen and/or sound to one web device over WebRTC
// (we offer; the page answers). As the TwinDesk session's capture (capture.js) does it, with what a
// phone's browser plays: H.264 first (Safari decodes it in hardware), Opus stereo.
// start {session, video, audio: 'loopback'|'helper'|false, maxH, fps, mbps, worklet}
'use strict';

const api = window.webcap;
let cur = null;

function close() {
  if (!cur) return;
  clearInterval(cur.timer);
  if (cur.stream) cur.stream.getTracks().forEach((t) => t.stop());
  if (cur.pc) cur.pc.close();
  if (cur.actx) cur.actx.close();
  cur = null;
}

function tune(sdp, mbps) {
  const max = Math.round(mbps * 1000);
  const extra = `x-google-start-bitrate=${Math.round(max * 0.6)};x-google-min-bitrate=${Math.round(max * 0.15)};x-google-max-bitrate=${max}`;
  const video = new Set();
  let inVideo = false;
  const lines = sdp.split('\r\n');
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    const m = inVideo && window.TwinDeskScreenCodec.RTPMAP.exec(l);
    if (m) video.add(m[1]);
  }
  const opus = (/a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp) || [])[1];
  return lines.map((l) => {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (!m) return l;
    if (video.has(m[1])) return `a=fmtp:${m[1]} ${[...m[2].split(';').filter((x) => x && !x.startsWith('x-google-')), extra].join(';')}`;
    if (m[1] === opus) return `a=fmtp:${m[1]} ${[...m[2].split(';').filter((x) => x && !/^(stereo|sprop-stereo|maxaveragebitrate)=/.test(x)), 'stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=128000'].join(';')}`;
    return l;
  }).join('\r\n');
}

async function helperTrack(me, worklet) {
  me.actx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  await me.actx.audioWorklet.addModule(worklet);
  me.player = new AudioWorkletNode(me.actx, 'pcm-player', { outputChannelCount: [2] });
  const dest = me.actx.createMediaStreamDestination();
  dest.channelCount = 2;
  me.player.connect(dest);
  await me.actx.resume();
  return dest.stream.getAudioTracks()[0];
}

const LOOPBACK = { channelCount: 2, sampleRate: 48000, echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false };

async function start(o) {
  close();
  const me = { session: o.session, pending: [], remoteSet: false };
  cur = me;
  const say = (status) => cur === me && api.state({ session: o.session, status });
  try {
    const wantLoop = o.audio === 'loopback';
    // Sound only still asks for a picture (getDisplayMedia needs one): a tiny one, never sent.
    const video = o.video ? { frameRate: { ideal: o.fps, max: o.fps }, height: { max: o.maxH } } : { frameRate: { max: 1 }, width: { max: 64 }, height: { max: 64 } };
    if (o.video || wantLoop) {
      try {
        me.stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: wantLoop ? LOOPBACK : false });
      } catch (e) {
        if (!wantLoop) throw e;
        me.stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
      }
    }
    if (cur !== me) return me.stream && me.stream.getTracks().forEach((t) => t.stop());
    const pc = new RTCPeerConnection({ iceServers: [] });
    me.pc = pc;
    const vt = o.video && me.stream ? me.stream.getVideoTracks()[0] : null;
    let tr = null;
    if (vt) {
      vt.contentHint = 'motion';
      vt.onended = () => say('error: capture ended');
      tr = pc.addTransceiver(vt, { direction: 'sendonly', streams: [me.stream] });
      try { tr.setCodecPreferences(window.TwinDeskScreenCodec.order(RTCRtpSender.getCapabilities('video').codecs, 'h264')); } catch (_) {}
    }
    let at = me.stream ? me.stream.getAudioTracks()[0] : null;
    if (!at && o.audio) at = await helperTrack(me, o.worklet);
    if (cur !== me) return;
    if (at) pc.addTransceiver(at, { direction: 'sendonly', streams: [me.stream || new MediaStream([at])] });
    if (!vt && !at) throw new Error('nothing to send');
    pc.onicecandidate = (e) => e.candidate && cur === me && api.send({ t: 'rtc.ice', session: o.session, candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      say(s === 'connected' ? 'live' : s);
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription({ type: 'offer', sdp: tune(offer.sdp, o.mbps) });
    if (tr) {
      const p = tr.sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      Object.assign(p.encodings[0], { maxBitrate: o.mbps * 1e6, maxFramerate: o.fps, priority: 'high', networkPriority: 'high' });
      p.degradationPreference = 'maintain-framerate';
      await tr.sender.setParameters(p).catch(() => {});
    }
    me.mbps = o.mbps;
    api.send({ t: 'rtc.offer', session: o.session, sdp: pc.localDescription.sdp });
    say('waiting for answer');
  } catch (e) {
    console.error('webcap:', e);
    say(`error: ${e.message}`);
  }
}

async function remote(m) {
  const me = cur;
  if (!me || !me.pc) return;
  try {
    if (m.t === 'rtc.answer' && typeof m.sdp === 'string') {
      await me.pc.setRemoteDescription({ type: 'answer', sdp: tune(m.sdp, me.mbps) });
      me.remoteSet = true;
      for (const c of me.pending.splice(0)) await me.pc.addIceCandidate(c);
    } else if (m.t === 'rtc.ice' && m.candidate) {
      if (me.remoteSet) await me.pc.addIceCandidate(m.candidate);
      else me.pending.push(m.candidate);
    }
  } catch (e) {
    console.warn('webcap remote', m.t, e.message);
  }
}

api.onPcm((buf) => {
  if (!cur || !cur.player) return;
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
  const copy = new Float32Array(f);
  cur.player.port.postMessage(copy, [copy.buffer]);
});
api.onStart(start);
api.onStop(close);
api.onRemote(remote);

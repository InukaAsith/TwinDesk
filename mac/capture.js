// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Hidden capture window: one WebRTC session at a time (we are the offerer; video, and sound if asked).
'use strict';

const P = window.MacShareProtocol;
const api = window.capture;

let cur = null; // {session, stream, pc, remoteSet, pendingIce, statsTimer, last, actx, player}

function close() {
  if (!cur) return;
  clearInterval(cur.statsTimer);
  if (cur.stream) cur.stream.getTracks().forEach((t) => t.stop());
  if (cur.pc) cur.pc.close();
  if (cur.actx) cur.actx.close();
  cur = null;
}

// Chromium starts video at ~300 kbps and ramps up slowly (blurry, laggy first ~20 s). These
// codec parameters make it start high and never fall below a floor. The sender reads them from
// the remote description, so they go into the answer as well as our offer (replacing any hints
// the PC sent). Values in kbps.
function withBitrate(sdp, mbps) {
  const max = Math.round(mbps * 1000);
  const extra = `x-google-start-bitrate=${Math.round(max * 0.6)};x-google-min-bitrate=${Math.round(max * 0.2)};x-google-max-bitrate=${max}`;
  const videoPts = new Set();
  const lines = sdp.split('\r\n');
  let inVideo = false;
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    const m = inVideo && window.TwinDeskScreenCodec.RTPMAP.exec(l);
    if (m) videoPts.add(m[1]);
  }
  return lines.map((l) => {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (!m || !videoPts.has(m[1])) return l;
    // The Mac's setting wins over any hints the PC put in its answer.
    const params = m[2].split(';').filter((x) => x && !x.startsWith('x-google-'));
    return `a=fmtp:${m[1]} ${[...params, extra].join(';')}`;
  }).join('\r\n');
}

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

// System audio from the helper (via main) -> AudioWorklet -> a MediaStreamTrack.
async function audioTrack(me) {
  me.actx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  await me.actx.audioWorklet.addModule('pcm-worklet.js');
  me.player = new AudioWorkletNode(me.actx, 'pcm-player', { outputChannelCount: [2] });
  const dest = me.actx.createMediaStreamDestination();
  dest.channelCount = 2;
  me.player.connect(dest);
  await me.actx.resume();
  return dest.stream.getAudioTracks()[0];
}

// Chromium's loopback (audio 'loopback', stream.js): stereo as it is, no voice processing, and
// TwinDesk's own playback left out (restrictOwnAudio), so the other computer's sound doesn't echo back.
const LOOPBACK = { channelCount: 2, sampleRate: 48000, echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true, suppressLocalAudioPlayback: false };

async function getStream(sourceId, width, height, fps, audio) {
  const video = { frameRate: { ideal: fps, max: fps }, width: { max: width }, height: { max: height } };
  if (audio === 'loopback') {
    try {
      return await navigator.mediaDevices.getDisplayMedia({ video, audio: LOOPBACK });
    } catch (e) {
      console.warn('getDisplayMedia with sound failed, without it:', e.message);
    }
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
  } catch (e) {
    console.warn('getDisplayMedia failed, falling back to getUserMedia:', e.message);
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: fps, maxWidth: width, maxHeight: height } },
    });
  }
}

// Every frame matters more than the last bit of sharpness: under pressure the encoder lowers
// quality, never the frame rate (dropped frames are what feels jagged and what adds lag).
async function start({ session, bitrateMbps, sourceId, width, height, audio, fps = 60, ice, codec, steady }) {
  close();
  const me = { session, pendingIce: [], remoteSet: false, last: null };
  cur = me;
  try {
    me.stream = await getStream(sourceId, width, height, fps, audio);
    if (cur !== me) return me.stream.getTracks().forEach((t) => t.stop());
    const track = me.stream.getVideoTracks()[0];
    track.contentHint = 'motion';
    track.onended = () => cur === me && api.state({ session, status: 'error: capture ended' });

    const pc = new RTCPeerConnection(ice || { iceServers: [] });
    me.pc = pc;
    const tr = pc.addTransceiver(track, { direction: 'sendonly', streams: [me.stream] });
    let sound = audio === 'loopback' ? me.stream.getAudioTracks()[0] : null;
    if (audio === 'loopback') console.log(`sound: ${sound ? "Chromium's loopback" : "the helper's (no loopback)"}`);
    if (audio && !sound && (audio !== 'loopback' || await api.helperAudio())) sound = await audioTrack(me);
    if (cur !== me) return void (me.actx && me.actx.close());
    if (sound) pc.addTransceiver(sound, { direction: 'sendonly', streams: [me.stream] });
    // H.265 when both have it (shared/screencodec.js), then H.264 High, Main, Baseline: better quality per
    // bit, in hardware. Everything else stays as a fallback.
    tr.setCodecPreferences(window.TwinDeskScreenCodec.order(RTCRtpSender.getCapabilities('video').codecs, codec)); // the Encoder setting

    pc.onicecandidate = (e) => {
      if (e.candidate && cur === me) api.send({ t: P.T.RTC_ICE, session, candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (cur !== me) return;
      const s = pc.connectionState; // new, connecting, connected, disconnected, failed, closed
      api.state({ session, status: s === 'connected' ? 'live' : s });
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription({ type: 'offer', sdp: withOpus(withBitrate(offer.sdp, bitrateMbps)) });
    me.bitrateMbps = bitrateMbps;
    me.codec = codec;
    const p = tr.sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    Object.assign(p.encodings[0], {
      maxBitrate: bitrateMbps * 1e6, maxFramerate: fps, scaleResolutionDownBy: 1,
      priority: 'high', networkPriority: 'high', // DSCP: Wi-Fi puts it in the video queue
    });
    p.degradationPreference = 'maintain-framerate';
    await tr.sender.setParameters(p);
    if (cur !== me) return;
    // Playback › Steady: no "show it now" on the frames (shared/screencodec.js steady()).
    const sdp = steady ? window.TwinDeskScreenCodec.steady(pc.localDescription.sdp) : pc.localDescription.sdp;
    api.send({ t: P.T.RTC_OFFER, session, sdp });
    const pl = /a=fmtp:\d+ .*profile-level-id=([0-9a-f]{6})/i.exec(pc.localDescription.sdp);
    console.log(`offer: first H.264 profile-level-id ${pl ? pl[1] : 'none'}`);
    api.state({ session, status: 'waiting for answer' });
    me.statsTimer = setInterval(() => stats(me), 1000);
  } catch (e) {
    console.error('capture start failed:', e);
    if (cur === me) api.state({ session, status: `error: ${e.message}` });
  }
}

async function onRemote(msg) {
  const me = cur;
  if (!me || !me.pc || msg.session !== me.session) return;
  try {
    if (msg.t === P.T.RTC_ANSWER) {
      await me.pc.setRemoteDescription({ type: 'answer', sdp: withOpus(withBitrate(msg.sdp, me.bitrateMbps)) });
      if (window.TwinDeskScreenCodec) console.log(`sending ${window.TwinDeskScreenCodec.negotiated(msg.sdp) || 'no video'} (Encoder: ${me.codec || 'h264'})`);
      me.remoteSet = true;
      for (const c of me.pendingIce.splice(0)) await me.pc.addIceCandidate(c);
    } else if (msg.t === P.T.RTC_ICE && msg.candidate) {
      if (me.remoteSet) await me.pc.addIceCandidate(msg.candidate);
      else me.pendingIce.push(msg.candidate);
    }
  } catch (e) {
    console.error(`remote ${msg.t} failed:`, e);
  }
}

async function stats(me) {
  if (cur !== me || !me.pc) return;
  const report = await me.pc.getStats(me.pc.getSenders()[0].track);
  let out = null;
  let pair = null;
  const byId = new Map();
  report.forEach((r) => {
    byId.set(r.id, r);
    if (r.type === 'outbound-rtp' && r.kind === 'video') out = r;
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
  });
  if (!out || cur !== me) return;
  const now = performance.now();
  let mbps = 0;
  let qp = 0;
  let encodeMs = 0;
  if (me.last) {
    mbps = ((out.bytesSent - me.last.bytes) * 8) / ((now - me.last.at) * 1000);
    const frames = out.framesEncoded - me.last.frames;
    if (frames > 0) {
      qp = Math.round((out.qpSum - me.last.qpSum) / frames);
      encodeMs = Math.round(((out.totalEncodeTime - me.last.encodeTime) * 1000 * 10) / frames) / 10;
    }
  }
  me.last = { bytes: out.bytesSent, at: now, frames: out.framesEncoded, qpSum: out.qpSum || 0, encodeTime: out.totalEncodeTime || 0 };
  const codec = byId.get(out.codecId);
  api.stats({
    session: me.session,
    fps: Math.round(out.framesPerSecond || 0),
    width: out.frameWidth || 0,
    height: out.frameHeight || 0,
    mbps: Math.round(mbps * 10) / 10,
    encoder: out.encoderImplementation || '',
    codec: codec ? codec.mimeType.replace(/^video\//, '') : '',
    qp,
    encodeMs,
    limit: out.qualityLimitationReason || 'none',
    targetMbps: pair && pair.availableOutgoingBitrate ? Math.round(pair.availableOutgoingBitrate / 1e5) / 10 : 0,
    rttMs: pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
  });
}

api.onPcm((buf) => {
  if (!cur || !cur.player) return;
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
  const copy = new Float32Array(f); // own buffer, transferable
  cur.player.port.postMessage(copy, [copy.buffer]);
});
api.onStart(start);
api.onStop(close);
api.onRemote(onRemote);

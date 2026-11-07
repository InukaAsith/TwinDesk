// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Hidden sender window: each `rtc2` session captures one monitor of this PC (phase
// 11, optionally with its sound) or one app window and sends it to the Mac (we offer, the
// Mac answers recvonly). Low-latency settings as mac/capture.js.
'use strict';

const T = window.MacShareProtocol.T;
const api = window.sender;

const sessions = new Map(); // session → {session, pc, stream, pending, mbps, statsTimer, last}
const alive = (me) => sessions.get(me.session) === me;

function report(me, status, error) {
  api.state({ session: me.session, status, error: error || '' });
}

// Bitrate hints in the video fmtp lines (start high, keep a floor). Values in kbps.
function withBitrate(sdp, mbps) {
  const max = Math.round(mbps * 1000);
  const extra = `x-google-start-bitrate=${Math.round(max * 0.6)};x-google-min-bitrate=${Math.round(max * 0.2)};x-google-max-bitrate=${max}`;
  const pts = new Set();
  const lines = sdp.split('\r\n');
  let inVideo = false;
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    const m = inVideo && window.TwinDeskScreenCodec.RTPMAP.exec(l);
    if (m) pts.add(m[1]);
  }
  return lines.map((l) => {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (!m || !pts.has(m[1])) return l;
    return `a=fmtp:${m[1]} ${[...m[2].split(';').filter((x) => x && !x.startsWith('x-google-')), extra].join(';')}`;
  }).join('\r\n');
}

// Opus stereo at 128 kbps for the screen's sound.
function withOpus(sdp) {
  const m = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
  if (!m) return sdp;
  const re = new RegExp('a=fmtp:' + m[1] + ' ([^\\r\\n]*)');
  const extra = 'stereo=1;sprop-stereo=1;maxaveragebitrate=128000';
  return re.test(sdp) ? sdp.replace(re, (all, p) => 'a=fmtp:' + m[1] + ' ' + p.split(';').filter((x) => !/^(stereo|sprop-stereo|maxaveragebitrate)=/.test(x)).concat(extra).join(';'))
    : sdp.replace(m[0], m[0] + '\r\na=fmtp:' + m[1] + ' ' + extra);
}

// m: {session, sourceId, width, height, follow?, mbps, fps?, audio, offer: {kind, wid?}}
// follow: the picture follows the source's size (an app window), up to width × height.
// Every frame matters more than the last bit of sharpness: under pressure the encoder
// lowers quality, never the frame rate (dropped frames are what feels jagged and adds lag).
async function start(m) {
  stop(m.session);
  const me = { session: m.session, pending: [], mbps: m.mbps, codec: m.codec };
  const fps = m.fps || 60;
  sessions.set(me.session, me);
  try {
    const video = { chromeMediaSource: 'desktop', chromeMediaSourceId: m.sourceId, maxWidth: m.width, maxHeight: m.height, maxFrameRate: fps };
    if (m.follow) Object.assign(video, { minWidth: 2, minHeight: 2 }); // min ≠ max: any size within the limit, no scaling
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: m.audio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
      video: { mandatory: video },
    });
    if (!alive(me)) return stream.getTracks().forEach((t) => t.stop());
    me.stream = stream;
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'motion';
    track.onended = () => alive(me) && report(me, 'ended', 'The captured ' + (m.offer.kind === 'window' ? 'window' : 'monitor') + ' went away');
    const pc = (me.pc = new RTCPeerConnection(m.ice || { iceServers: [] }));
    const tr = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    const audio = stream.getAudioTracks()[0];
    if (audio) pc.addTransceiver(audio, { direction: 'sendonly', streams: [stream] });
    // H.265 when both have it (shared/screencodec.js), then H.264 High, Main, Baseline: better quality per
    // bit, in hardware. Everything else stays as a fallback.
    tr.setCodecPreferences(window.TwinDeskScreenCodec.order(RTCRtpSender.getCapabilities('video').codecs, m.codec)); // the Encoder setting
    pc.onicecandidate = (e) => e.candidate && alive(me) && api.send({ t: T.RTC2_ICE, session: me.session, candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => alive(me) && report(me, pc.connectionState === 'connected' ? 'live' : pc.connectionState);

    const offer = await pc.createOffer();
    if (!alive(me)) return;
    await pc.setLocalDescription({ type: 'offer', sdp: withOpus(withBitrate(offer.sdp, m.mbps)) });
    if (!alive(me)) return;
    const p = tr.sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    Object.assign(p.encodings[0], {
      maxBitrate: m.mbps * 1e6, maxFramerate: fps, scaleResolutionDownBy: 1,
      priority: 'high', networkPriority: 'high', // DSCP: Wi-Fi puts it in the video queue
    });
    p.degradationPreference = 'maintain-framerate';
    await tr.sender.setParameters(p);
    if (!alive(me)) return;
    const kind = m.offer.kind === 'screen' && audio ? 'screen+audio' : m.offer.kind;
    // Playback › Steady: no "show it now" on the frames (shared/screencodec.js steady()).
    const sdp = m.steady ? window.TwinDeskScreenCodec.steady(pc.localDescription.sdp) : pc.localDescription.sdp;
    api.send({ ...m.offer, t: T.RTC2_OFFER, session: me.session, sdp, kind });
    report(me, 'connecting');
    me.statsTimer = setInterval(() => stats(me).catch(() => {}), 1000);
  } catch (e) {
    if (alive(me)) {
      report(me, 'failed', 'Capturing: ' + e.message);
      stop(me.session);
    }
  }
}

// Once a second, as on the Mac: picture, fps, bitrate (and what the network allows), encoder.
async function stats(me) {
  if (!alive(me) || !me.pc) return;
  const report = await me.pc.getStats();
  let out = null, pair = null, src = null;
  const byId = new Map();
  report.forEach((r) => {
    byId.set(r.id, r);
    if (r.type === 'outbound-rtp' && r.kind === 'video') out = r;
    if (r.type === 'media-source' && r.kind === 'video') src = r;
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
  });
  if (!out || !alive(me)) return;
  const now = performance.now();
  let mbps = 0, qp = 0, encodeMs = 0;
  if (me.last) {
    mbps = ((out.bytesSent - me.last.bytes) * 8) / ((now - me.last.at) * 1000);
    const frames = out.framesEncoded - me.last.frames;
    if (frames > 0) {
      qp = Math.round(((out.qpSum || 0) - me.last.qpSum) / frames);
      encodeMs = Math.round((((out.totalEncodeTime || 0) - me.last.encodeTime) * 1000 * 10) / frames) / 10;
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
    targetMbps: pair && pair.availableOutgoingBitrate ? Math.round(pair.availableOutgoingBitrate / 1e5) / 10 : 0,
    encoder: out.encoderImplementation || '',
    codec: codec ? codec.mimeType.replace(/^video\//, '') : '',
    qp,
    encodeMs,
    limit: out.qualityLimitationReason || 'none',
    hw: out.powerEfficientEncoder === true,
    dropped: src && src.frames ? Math.max(0, src.frames - (out.framesEncoded || 0)) : 0, // captured, never encoded
    rttMs: pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
  });
}

async function onAnswer(m) {
  const me = sessions.get(m.session);
  if (!me || !me.pc || m.session !== me.session) return;
  try {
    await me.pc.setRemoteDescription({ type: 'answer', sdp: withOpus(withBitrate(m.sdp, me.mbps)) });
    if (window.TwinDeskScreenCodec) console.log(`[sender] sending ${window.TwinDeskScreenCodec.negotiated(m.sdp) || 'no video'} (Encoder: ${me.codec || 'h264'})`);
    if (!alive(me) || !me.pending) return;
    const pending = me.pending;
    me.pending = null;
    for (const c of pending) {
      if (!alive(me)) return;
      await me.pc.addIceCandidate(c).catch(() => {});
    }
  } catch (e) {
    if (alive(me)) report(me, 'failed', '{Name}’s answer: ' + e.message);
  }
}

function onIce(m) {
  const me = sessions.get(m.session);
  if (!me || !m.candidate) return;
  if (me.pending) me.pending.push(m.candidate);
  else if (me.pc) me.pc.addIceCandidate(m.candidate).catch(() => {});
}

function stop(session) {
  const me = sessions.get(session);
  if (!me) return;
  sessions.delete(session);
  clearInterval(me.statsTimer);
  if (me.pc) me.pc.close();
  if (me.stream) me.stream.getTracks().forEach((t) => t.stop());
}

api.on((m) => {
  switch (m.t) {
    case 'start': start(m); break;
    case 'stop': stop(m.session); break;
    case T.RTC2_ANSWER: onAnswer(m); break;
    case T.RTC2_ICE: onIce(m); break;
  }
});
api.ready();

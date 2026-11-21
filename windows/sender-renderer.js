// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Hidden sender window: each `rtc2` session captures one monitor of this PC (phase
// 11, optionally with its sound) or one app window and sends it to the Mac (we offer, the
// Mac answers recvonly). Low-latency settings as mac/capture.js.
'use strict';

const T = window.MacShareProtocol.T;
const api = window.sender;

const sessions = new Map(); // session → {session, pc, stream, pending, mbps, statsTimer, last}
const alive = (me) => sessions.get(me.session) === me;

window.addEventListener('message', async (event) => {
  const m = event.data;
  if (event.source !== window || !m || m.type !== 'twindesk-native-frame') return;
  const frame = m.frame, me = sessions.get(m.session);
  if (!frame) return;
  // One write at a time; a frame that comes meanwhile is dropped (closed: its slot goes back to the
  // capture exe). Dropping one must not clear `writing` for the write still going: then a second and
  // third write went in, each holding its frame, and with all three slots held the capture stopped.
  if (!me || !me.writer || me.writing) { frame.close(); return; }
  me.writing = true;
  try {
    await me.writer.write(frame);
  } catch (e) {
    if (alive(me)) { report(me, 'failed', 'Native screen frame: ' + e.message); stop(me.session); }
  } finally { frame.close(); me.writing = false; }
});

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

// m.net: our adapter on the session's network {address, netmask} (sender.js _net()). Candidates on any
// other network are neither sent nor taken, so the picture can't move to a second network mid-share
// (a Remote Desktop adapter beside the cable did: parts of the picture behind, the bitrate up and down).
// Names (mDNS) and IPv6 are kept: no way to tell their network here.
const ip4 = (s) => (/^(\d{1,3})(\.\d{1,3}){3}$/.test(s) ? s.split('.').reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0) : null);
function onNet(net, candidate) {
  if (!net || !candidate) return true;
  const text = typeof candidate === 'string' ? candidate : candidate.candidate || '';
  const address = text.split(' ')[4] || '';
  const a = ip4(address), mine = ip4(net.address), mask = ip4(net.netmask);
  if (a == null || mine == null || mask == null) return true;
  return ((a ^ mine) & mask) >>> 0 === 0;
}
function keep(me, candidate, side) {
  if (onNet(me.net, candidate)) return true;
  me.skipped = (me.skipped || 0) + 1;
  if (me.skipped <= 4) api.log(`session ${me.session}: ${side} candidate off ${me.net.address} left out: ${String(candidate.candidate || candidate).split(' ').slice(4, 8).join(' ')}`);
  return false;
}

// m: {session, sourceId, width, height, captureWidth?, captureHeight?, follow?, mbps, fps?, audio, offer: {kind, wid?}, net?}
// follow: the picture follows the source's size (an app window), up to width × height.
// Every frame matters more than the last bit of sharpness: under pressure the encoder
// lowers quality, never the frame rate (dropped frames are what feels jagged and adds lag).
async function start(m) {
  stop(m.session);
  const me = { session: m.session, pending: [], mbps: m.mbps, codec: m.codec, net: m.ice ? null : m.net || null };
  const fps = m.fps || 60;
  sessions.set(me.session, me);
  try {
    const video = { chromeMediaSource: 'desktop', chromeMediaSourceId: m.sourceId, maxWidth: m.captureWidth || m.width, maxHeight: m.captureHeight || m.height, maxFrameRate: fps };
    // Capture the screen at native pixels; downscale the composed frame, including its pointer, once.
    if (m.captureWidth && m.captureHeight) Object.assign(video, { minWidth: m.captureWidth, minHeight: m.captureHeight });
    if (m.follow) Object.assign(video, { minWidth: 2, minHeight: 2 }); // min ≠ max: any size within the limit, no scaling
    let stream, native = false;
    if (m.captureRect && api.nativeStart && typeof MediaStreamTrackGenerator !== 'undefined') {
      me.generated = new MediaStreamTrackGenerator({ kind: 'video' });
      me.writer = me.generated.writable.getWriter();
      const reply = await api.nativeStart(me.session);
      native = reply.available;
      if (native && reply.width && reply.height) me.nativeSize = { width: reply.width, height: reply.height };
      if (!alive(me)) return;
      if (!native) { me.writer.close().catch(() => {}); me.generated.stop(); me.writer = null; me.generated = null; }
    }
    if (native) {
      // Keep the existing loopback audio source; only its temporary video track is discarded.
      const sound = m.audio ? await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } }, video: { mandatory: video },
      }) : null;
      if (!alive(me)) { if (sound) sound.getTracks().forEach(t => t.stop()); return; }
      if (sound) sound.getVideoTracks().forEach(t => t.stop());
      stream = new MediaStream([me.generated, ...(sound ? sound.getAudioTracks() : [])]);
      me.native = true;
      console.log('[sender] native capture with the system pointer; original pixels and existing encoder settings');
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: m.audio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
        video: { mandatory: video },
      });
    }
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
    pc.onicecandidate = (e) => e.candidate && alive(me) && keep(me, e.candidate, 'our') && api.send({ t: T.RTC2_ICE, session: me.session, candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => alive(me) && report(me, pc.connectionState === 'connected' ? 'live' : pc.connectionState);
    pc.onicecandidateerror = (e) => alive(me) && api.log('ice candidate error ' + (e.address || '') + ':' + (e.port || '') + ' ' + e.errorCode + ' ' + (e.errorText || ''));

    const offer = await pc.createOffer();
    if (!alive(me)) return;
    await pc.setLocalDescription({ type: 'offer', sdp: withOpus(withBitrate(offer.sdp, m.mbps)) });
    if (!alive(me)) return;
    const p = tr.sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    const captured = native ? (me.nativeSize || { width: m.captureWidth, height: m.captureHeight }) : track.getSettings();
    // Electron's rect for a scaled monitor can be a few pixels off (2562 × 1601 for 2560 × 1600), and the
    // target was worked out from it: 2560 × 1600 came out as 2556 × 1598, every pixel resampled. Within
    // 1% of the capture is the capture itself.
    let scale = m.captureWidth && m.captureHeight ? Math.max(1, captured.width / m.width, captured.height / m.height) : 1;
    if (scale < 1.01) scale = 1;
    Object.assign(p.encodings[0], {
      maxBitrate: m.mbps * 1e6, maxFramerate: fps, scaleResolutionDownBy: scale,
      priority: 'high', networkPriority: 'high', // DSCP: Wi-Fi puts it in the video queue
    });
    p.degradationPreference = 'maintain-framerate';
    await tr.sender.setParameters(p);
    if (!alive(me)) return;
    if (m.detailSource && m.offer.kind === 'screen') {
      me.detail = window.TwinDeskScreenCodec.detailSession(m.detailSource, {
        width: m.width, height: m.height, fps, alive: () => alive(me),
        apply: async (size) => {
          if (m.captureWidth && m.captureHeight) {
            const p = tr.sender.getParameters();
            if (!p.encodings?.length) return;
            let scale = Math.max(1, captured.width / size.width, captured.height / size.height);
            if (scale < 1.01) scale = 1;
            p.encodings[0].scaleResolutionDownBy = scale;
            await tr.sender.setParameters(p);
          } else {
            await track.applyConstraints({
              width: { ideal: size.width, max: size.width }, height: { ideal: size.height, max: size.height },
              frameRate: { ideal: fps, max: fps },
            });
          }
        },
        failed: (error) => api.log('Screen detail unavailable: ' + error.message),
      });
    }
    const kind = m.offer.kind === 'screen' && audio ? 'screen+audio' : m.offer.kind;
    // Playback › Steady: no "show it now" on the frames (shared/screencodec.js steady()).
    const sdp = m.steady ? window.TwinDeskScreenCodec.steady(pc.localDescription.sdp) : pc.localDescription.sdp;
    api.send({ ...m.offer, t: T.RTC2_OFFER, session: me.session, sdp, kind, ...(me.detail ? { detail: me.detail.offer } : {}) });
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
// "192.168.50.3:5000 -> 192.168.50.4:6000 udp host": the ICE pair in use, '' before there is one.
function pathOf(byId, pair) {
  if (!pair) return '';
  const l = byId.get(pair.localCandidateId), r = byId.get(pair.remoteCandidateId);
  if (!l || !r) return '';
  return `${l.address || l.ip}:${l.port} -> ${r.address || r.ip}:${r.port} ${l.protocol || ''} ${l.candidateType || ''}`.trim();
}

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
    path: pathOf(byId, pair), // the network the picture goes over (logged by sender.js when it changes)
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
  if (!me || !m.candidate || !keep(me, m.candidate, 'their')) return;
  if (me.pending) me.pending.push(m.candidate);
  else if (me.pc) me.pc.addIceCandidate(m.candidate).catch(() => {});
}

function stop(session) {
  const me = sessions.get(session);
  if (!me) return;
  sessions.delete(session);
  clearInterval(me.statsTimer);
  if (me.pc) me.pc.close();
  if (me.writer) me.writer.abort().catch(() => {});
  if (me.stream) me.stream.getTracks().forEach((t) => t.stop());
  else if (me.generated) me.generated.stop();
}

api.on((m) => {
  switch (m.t) {
    case 'start': start(m); break;
    case 'stop': stop(m.session); break;
    case T.RTC2_ANSWER: onAnswer(m); break;
    case T.RTC2_ICE: onIce(m); break;
    case T.RTC_DETAIL: sessions.get(m.session)?.detail?.set(m.height); break;
    case 'native-error':
      if (sessions.has(m.session)) { report(sessions.get(m.session), 'ended', m.error); stop(m.session); }
      break;
  }
});
api.ready();

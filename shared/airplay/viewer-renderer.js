// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The AAC-ELD config as UxPlay (https://github.com/FDH2/UxPlay, GPL-3.0) decodes mirror sound with.
// The AirPlay window: H.264 from the sender (AVCC, with its avcC record) through WebCodecs onto a
// canvas. A new record (the device turned, or a new stream) configures the decoder again; after
// that, or an error, frames wait for the next key frame.
// The sound: AAC-ELD access units through WebCodecs' AAC decoder (Chromium's FFmpeg decodes ELD
// from its AudioSpecificConfig, though the mp4a.40.39 name is refused), played a little ahead
// (LEAD) on an AudioContext, at the sender's volume.
'use strict';

const LEAD = 0.06; // seconds of sound queued before it plays: covers network jitter
const MAX_AHEAD = 0.25; // further behind than this: start again at LEAD
const snd = { ctx: null, gain: null, dec: null, spf: 0, next: 0, seq: -1, broken: false };

function audioDecoder(spf) {
  if (snd.dec) { try { snd.dec.close(); } catch (_) {} }
  snd.spf = spf;
  snd.dec = new AudioDecoder({
    output: (a) => {
      try { play(a); } finally { a.close(); }
    },
    error: (e) => { console.warn('[airplay] audio', e && e.message); snd.dec = null; },
  });
  // ER AAC ELD (39), 44.1 kHz, stereo; frameLengthFlag set for 480 samples a frame (AirPlay's).
  const asc = spf === 512 ? [0xf8, 0xe8, 0x40, 0x00] : [0xf8, 0xe8, 0x50, 0x00];
  snd.dec.configure({ codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, description: new Uint8Array(asc) });
}

function play(a) {
  if (!snd.ctx) {
    snd.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: a.sampleRate });
    snd.gain = snd.ctx.createGain();
    snd.gain.connect(snd.ctx.destination);
  }
  const c = snd.ctx;
  const n = a.numberOfFrames;
  const ch = Math.min(a.numberOfChannels, 2);
  const buf = c.createBuffer(ch, n, a.sampleRate);
  for (let i = 0; i < ch; i++) {
    const plane = new Float32Array(n);
    a.copyTo(plane, { planeIndex: i, format: 'f32-planar' });
    buf.copyToChannel(plane, i);
  }
  const now = c.currentTime;
  if (snd.next < now || snd.next > now + MAX_AHEAD) snd.next = now + LEAD;
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(snd.gain);
  src.start(snd.next);
  snd.next += buf.duration;
}

function audio(m) {
  if (snd.broken) return;
  // Late (UDP reordered it) or repeated: skip; a gap is just a moment of silence.
  if (snd.seq >= 0) {
    const d = (m.seq - snd.seq) & 0xffff;
    if (d === 0 || d > 0x8000) return;
  }
  snd.seq = m.seq;
  try {
    if (!snd.dec || snd.dec.state === 'closed' || snd.spf !== (m.spf || 480)) audioDecoder(m.spf || 480);
    snd.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: 0, data: m.data }));
  } catch (e) {
    console.warn('[airplay] no sound:', e.message);
    snd.broken = true;
  }
}

// AirPlay volume: dB from -30 (quietest) to 0, -144 muted.
function volume(db) {
  const v = !(db > -144) ? 0 : db >= 0 ? 1 : Math.pow(10, Math.max(db, -30) / 20);
  if (snd.gain) snd.gain.gain.value = v;
  snd.vol = v;
}

const canvas = document.getElementById('c');
const wait = document.getElementById('wait');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
let dec = null;
let cfg = null;
let needKey = true;
let n = 0;

function make() {
  if (dec) { try { dec.close(); } catch (_) {} }
  dec = new VideoDecoder({
    output: (f) => {
      if (canvas.width !== f.displayWidth || canvas.height !== f.displayHeight) {
        canvas.width = f.displayWidth;
        canvas.height = f.displayHeight;
        window.airplay.size(f.displayWidth, f.displayHeight);
      }
      ctx.drawImage(f, 0, 0);
      f.close();
      wait.hidden = true;
    },
    error: (e) => { console.warn('[airplay] decoder', e && e.message); dec = null; needKey = true; },
  });
  dec.configure({ codec: cfg.codec, description: cfg.avcC, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
  needKey = true;
}

window.airplay.on((m) => {
  if (m.t === 'config') {
    cfg = { codec: m.codec, avcC: new Uint8Array(m.avcC) };
    try { make(); } catch (e) { console.warn('[airplay] configure', e.message); dec = null; }
  } else if (m.t === 'frame') {
    if (!cfg) return;
    if (!dec || dec.state === 'closed') { try { make(); } catch (_) { return; } }
    if (needKey && !m.key) return;
    needKey = false;
    // Behind: drop until the next key frame rather than fall further back.
    if (dec.decodeQueueSize > 8 && !m.key) { needKey = true; return; }
    try { dec.decode(new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: (n++) * 16667, data: m.data })); } catch (e) { needKey = true; }
  } else if (m.t === 'audio') {
    audio(m);
    if (snd.gain && snd.vol != null) snd.gain.gain.value = snd.vol;
  } else if (m.t === 'volume') {
    volume(m.db);
  } else if (m.t === 'end') {
    wait.hidden = false;
    wait.textContent = m.text || 'Stopped';
  }
});
window.airplay.ready();

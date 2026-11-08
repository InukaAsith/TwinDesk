// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The AAC-ELD config as UxPlay (https://github.com/FDH2/UxPlay, GPL-3.0) decodes mirror sound with.
// The AirPlay window: H.264 from the sender (AVCC, with its avcC record) through WebCodecs onto a
// canvas. A new record (the device turned, or a new stream) configures the decoder again; after
// that, or an error, frames wait for the next key frame.
// The sound: AAC-ELD (mirroring) and AAC-LC access units through WebCodecs' AAC decoder (Chromium's
// FFmpeg decodes ELD from its AudioSpecificConfig, though the mp4a.40.39 name is refused); ALAC
// (music from an app) with alac.js, Apple's decoder ported. Played a little ahead (LEAD) on an
// AudioContext, at the sender's volume; music, with no picture to keep up with, further ahead.
'use strict';

const LEAD = 0.06; // seconds of sound queued before it plays (mirroring): covers network jitter
const MUSIC_LEAD = 0.3; // music: more jitter room, nothing to stay in step with
const snd = { ctx: null, gain: null, dec: null, alac: null, key: '', next: 0, seq: -1, broken: false, music: false };

function audioDecoder(ct, spf) {
  if (snd.dec) { try { snd.dec.close(); } catch (_) {} }
  snd.dec = null;
  snd.key = `${ct}/${spf}`;
  if (ct === 2) { snd.alac = new window.Alac.AlacDecoder({ frameLength: spf || 352 }); return; }
  snd.dec = new AudioDecoder({
    output: (a) => {
      try {
        const n = a.numberOfFrames;
        const planes = [];
        for (let i = 0; i < Math.min(a.numberOfChannels, 2); i++) {
          const p = new Float32Array(n);
          a.copyTo(p, { planeIndex: i, format: 'f32-planar' });
          planes.push(p);
        }
        play(planes, a.sampleRate);
      } finally { a.close(); }
    },
    error: (e) => { console.warn('[airplay] audio', e && e.message); snd.dec = null; },
  });
  // ER AAC ELD (39), 44.1 kHz, stereo; frameLengthFlag set for 480 samples a frame (AirPlay's).
  // AAC-LC (2), 44.1 kHz, stereo: 0x12 0x10.
  const asc = ct === 4 ? [0x12, 0x10] : spf === 512 ? [0xf8, 0xe8, 0x40, 0x00] : [0xf8, 0xe8, 0x50, 0x00];
  snd.dec.configure({ codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, description: new Uint8Array(asc) });
}

function play(planes, rate) {
  if (!snd.ctx) {
    snd.ctx = new AudioContext({ latencyHint: snd.music ? 'playback' : 'interactive', sampleRate: rate });
    snd.gain = snd.ctx.createGain();
    snd.gain.connect(snd.ctx.destination);
    applyGain();
  }
  const c = snd.ctx;
  const n = planes[0].length;
  const buf = c.createBuffer(planes.length, n, rate);
  planes.forEach((p, i) => buf.copyToChannel(p, i));
  const lead = snd.music ? MUSIC_LEAD : LEAD;
  const now = c.currentTime;
  if (snd.next < now || snd.next > now + lead * 4) snd.next = now + lead;
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
    // A little behind: a resend or a redundant copy. Far behind: the sender started over (a pause,
    // a seek, FLUSH), so follow it.
    if (d === 0 || (d > 0x8000 && 0x10000 - d < 64)) return;
  }
  snd.seq = m.seq;
  const ct = m.ct || 8;
  const spf = m.spf || (ct === 2 ? 352 : ct === 4 ? 1024 : 480);
  try {
    if (snd.key !== `${ct}/${spf}` || (ct !== 2 && (!snd.dec || snd.dec.state === 'closed'))) audioDecoder(ct, spf);
    if (ct === 2) {
      // A packet that doesn't decode (lost bits): a moment of silence, not the end of the sound.
      try { play(snd.alac.decode(m.data), 44100); } catch (e) { if (++snd.bad === 1) console.warn('[airplay] alac:', e.message); }
    } else {
      snd.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: 0, data: m.data }));
    }
  } catch (e) {
    console.warn('[airplay] no sound:', e.message);
    snd.broken = true;
  }
}
snd.bad = 0;

// AirPlay volume: dB from -30 (quietest) to 0, -144 muted. The window's Sound button mutes on top.
function volume(db) {
  snd.vol = !(db > -144) ? 0 : db >= 0 ? 1 : Math.pow(10, Math.max(db, -30) / 20);
  applyGain();
}
function applyGain() { if (snd.gain) snd.gain.gain.value = snd.muted || snd.off ? 0 : (snd.vol != null ? snd.vol : 1); }

// The controls: full screen (also double-click, F11), sound on/off, stop. Over the picture they
// show while the mouse moves; the music window always shows them.
const bar = { full: document.getElementById('full'), mute: document.getElementById('mute'), stop: document.getElementById('stop') };
let idleTimer = 0;
function awake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!document.getElementById('bar').matches(':hover')) document.body.classList.add('idle'); else awake(); }, 2500);
}
document.addEventListener('mousemove', awake);
document.addEventListener('keydown', awake);
awake();
bar.full.addEventListener('click', () => window.airplay.control('full'));
document.getElementById('c').addEventListener('dblclick', () => window.airplay.control('full'));
bar.mute.addEventListener('click', () => {
  snd.muted = !snd.muted;
  bar.mute.classList.toggle('is', snd.muted);
  bar.mute.title = snd.muted ? 'Sound off' : 'Sound';
  applyGain();
});
bar.stop.addEventListener('click', () => window.airplay.control('stop'));

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
  if (m.t === 'mode') {
    snd.music = !m.mirroring;
    document.body.classList.toggle('music', snd.music);
    wait.hidden = false;
    wait.textContent = m.text || '';
  } else if (m.t === 'mute') {
    snd.off = !!m.on; // AirPlay & SMB › Mirroring sound
    applyGain();
  } else if (m.t === 'full') {
    bar.full.classList.toggle('is', !!m.on);
    bar.full.title = m.on ? 'Leave full screen (Esc)' : 'Full screen (F11)';
  } else if (m.t === 'config') {
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

  } else if (m.t === 'volume') {
    volume(m.db);
  } else if (m.t === 'end') {
    wait.hidden = false;
    wait.textContent = m.text || 'Stopped';
  }
});
window.airplay.ready();

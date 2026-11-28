// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This PC's sound without TwinDesk's own, for every sound window that sends it (sound.js, one per
// device in Multi-device): the helper's process loopback (windows-helper/src/SoundCapture.cs) leaves
// TwinDesk's process tree out, so the sound another computer plays here never goes back to it (two
// computers sharing sound both ways looped). One capture, fanned out like the Mac's audiohub.js:
// 48 kHz stereo float32 frames, 'pcm' to each window.
//
// Windows older than 10 build 20348 can't: acquire() resolves false and sound.js keeps Chromium's
// capture (getDisplayMedia loopback), which still has the loop there.
'use strict';

const net = require('net');

let helper = null;
let sock = null;
let starting = null;
let unsupported = ''; // why the helper can't (asked once per run)
let rest = null;
let mutedByUs = false;
let wantMute = false;
const consumers = new Map(); // name -> webContents

function useHelper(h) {
  helper = h;
}

// Start feeding `wc` ('pcm' messages); true when the helper's capture runs, false: use Chromium's.
async function acquire(name, wc) {
  consumers.set(name, wc);
  if (sock) return true;
  if (unsupported || !helper) return false;
  if (!starting) starting = start().finally(() => { starting = null; });
  const ok = await starting;
  if (!ok) consumers.delete(name);
  return ok;
}

async function start() {
  try {
    const r = await helper.request('soundCapture', { on: true, pid: process.pid }, 8000);
    if (!r || !r.ok || typeof r.pipe !== 'string') throw new Error((r && r.error) || 'no capture');
    if (!consumers.size) { stopHelper(); return false; } // released while it started
    sock = await new Promise((resolve, reject) => {
      const s = net.connect(r.pipe, () => resolve(s));
      s.once('error', reject);
    });
    rest = null;
    sock.on('data', forward);
    sock.on('error', () => {});
    sock.on('close', () => {
      sock = null;
      if (consumers.size) console.log('[sound] capture ended');
    });
    applyMute();
    return true;
  } catch (e) {
    unsupported = e.message || String(e);
    console.log('[sound] process loopback unavailable, using Chromium capture:', unsupported);
    return false;
  }
}

function forward(buf) {
  if (!consumers.size) return;
  if (rest) buf = Buffer.concat([rest, buf]);
  const whole = buf.length - (buf.length % 8); // whole stereo float32 frames
  rest = whole < buf.length ? Buffer.from(buf.subarray(whole)) : null;
  if (!whole) return;
  const frames = buf.subarray(0, whole);
  for (const [name, wc] of consumers) {
    if (wc.isDestroyed()) consumers.delete(name);
    else wc.send('pcm', frames);
  }
}

function release(name) {
  if (!consumers.delete(name) || consumers.size) return;
  if (sock) { sock.destroy(); sock = null; }
  stopHelper();
  applyMute();
}

function stopHelper() {
  if (helper) helper.request('soundCapture', { on: false }, 3000).catch(() => {});
}

// "Mute this PC while sending": the speakers muted while the capture runs (it taps the apps' streams
// before the endpoint's mute, so the sound still goes out); given back when it stops.
function setMute(on) {
  wantMute = !!on;
  applyMute();
}

function applyMute() {
  const on = !!(sock && wantMute);
  if (on === mutedByUs || !helper) return;
  mutedByUs = on;
  helper.request('deckVolume', { input: false, mute: on }, 5000).catch(() => {});
}

function active() {
  return !!sock;
}

// App quitting: the speakers back.
function shutdown() {
  if (mutedByUs && helper) helper.send && helper.send('deckVolume', { input: false, mute: false });
  mutedByUs = false;
  consumers.clear();
  if (sock) sock.destroy();
  sock = null;
}

module.exports = { useHelper, acquire, release, setMute, active, shutdown };

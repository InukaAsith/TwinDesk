// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This computer's sound as a capture device, without TwinDesk's own playback. Used by sound.js
// (Send sound), pcscreen.js (the screen's sound) and web.js, counted: loaded while one of them sends.
//
// Capturing the speakers' monitor took everything they play, the sound another computer plays here
// through TwinDesk too, and sent it back: two computers sharing sound both ways looped. So while
// something sends, the other apps play into a sink of ours instead:
//
//   apps ──► twindesk_cap (null sink, the default while sending) ──► module-loopback ──► the speakers
//                 └─ monitor ──► twindesk_sound (remap source, what Chromium captures)
//   TwinDesk's own streams ───────────────────────────────────────────────────────────► the speakers
//
// TwinDesk's streams are told apart by their process (application.process.id, TwinDesk's processes);
// `pactl subscribe` moves each new stream the right way while it runs (nothing runs while nothing
// sends). "Mute this computer while sending" is the loopback module left out: the speakers go quiet,
// the capture doesn't. A new default output picked meanwhile becomes the speakers the loopback plays
// on. All of it is undone at release; a crash's leftovers at the next start (unloadStale).
// PulseAudio and PipeWire (pipewire-pulse) alike; Chromium lists no monitors, hence the remap source.
'use strict';

const { execFile, spawn } = require('child_process');

const NAME = 'twindesk_sound';
const LABEL = 'TwinDesk-Sound';
const CAP = 'twindesk_cap';

const pactl = (args) => new Promise((resolve, reject) => {
  execFile('pactl', args, { timeout: 8000 }, (err, out, stderr) => {
    if (err) return reject(new Error(err.code === 'ENOENT' ? 'PulseAudio or PipeWire (pactl) is not installed' : String(stderr || err.message).trim()));
    resolve(String(out).trim());
  });
});

let users = 0;
let mods = null; // {cap, remap, play} module indexes while loaded
let real = ''; // the speakers (the default output before ours)
let loading = null;
let mute = false;
let sub = null; // pactl subscribe
let ours = () => new Set([process.pid]); // TwinDesk's process ids

async function defaultSink() {
  try {
    const s = await pactl(['get-default-sink']); // pactl 15+
    if (s) return s;
  } catch (_) { /* older pactl */ }
  const m = /^Default Sink:\s*(.+)$/m.exec(await pactl(['info']));
  if (!m) throw new Error('No sound output found');
  return m[1].trim();
}

// Modules left behind by a crash (ours by their names).
async function unloadStale() {
  const list = await pactl(['list', 'short', 'modules']).catch(() => '');
  const lines = list.split('\n');
  // The remap and the loopback first, then the sink they hang off.
  for (const pass of [(l) => l.includes('source_name=' + NAME) || l.includes('source=' + CAP + '.monitor'), (l) => l.includes('sink_name=' + CAP)]) {
    for (const line of lines) if (pass(line)) await pactl(['unload-module', line.split('\t')[0]]).catch(() => {});
  }
}

// `pactl list sink-inputs` → [{id, pid, module, loop}]; loop: a loopback's own stream (by its names),
// never moved: in our sink it would feed itself.
function parseInputs(text) {
  return String(text || '').split(/\n(?=Sink Input #)/).map((b) => {
    const id = (/^Sink Input #(\d+)/m.exec(b) || [])[1];
    if (!id) return null;
    return {
      id,
      module: (/^\s*Owner Module:\s*(\d+)/m.exec(b) || [])[1] || '',
      pid: Number((/application\.process\.id = "(\d+)"/.exec(b) || [])[1]) || 0,
      loop: /(?:node\.name|media\.name|application\.name|module-stream-restore\.id) = "[^"\n]*loopback/i.test(b),
    };
  }).filter(Boolean);
}

// Where a stream goes: TwinDesk's to the speakers, our loopback's stays, every other app's into ours.
function whereTo(input, m, pids, speakers) {
  if (input.loop || (m && input.module && (input.module === m.play || input.module === m.remap))) return null;
  if (!input.pid) return null; // no process: a module's or the sound server's own, left where it is
  return pids.has(input.pid) ? speakers : CAP;
}

async function sortInputs(only) {
  const m = mods;
  if (!m) return;
  const pids = ours();
  const list = parseInputs(await pactl(['list', 'sink-inputs']).catch(() => ''));
  for (const i of list) {
    if (only && i.id !== only) continue;
    const to = whereTo(i, m, pids, real);
    if (to && mods === m) await pactl(['move-sink-input', i.id, to]).catch(() => {});
  }
}

async function loadPlay() {
  if (!mods || mute || mods.play) return;
  mods.play = await pactl(['load-module', 'module-loopback', 'source=' + CAP + '.monitor', 'sink=' + real, 'latency_msec=20',
    'source_dont_move=true', 'sink_dont_move=true']).catch((e) => { console.log('[sound] speakers loopback:', e.message); return ''; });
}

async function unloadPlay() {
  if (!mods || !mods.play) return;
  const idx = mods.play;
  mods.play = '';
  await pactl(['unload-module', idx]).catch(() => {});
}

async function load() {
  await unloadStale();
  real = await defaultSink();
  if (real === CAP) real = await defaultSink(); // a stale default, gone with its module
  mods = { cap: '', remap: '', play: '' };
  mods.cap = await pactl(['load-module', 'module-null-sink', 'sink_name=' + CAP, 'sink_properties=device.description=TwinDesk-Capture']);
  mods.remap = await pactl(['load-module', 'module-remap-source', 'master=' + CAP + '.monitor', 'source_name=' + NAME,
    'source_properties=device.description=' + LABEL]);
  // WirePlumber restores a mute it remembers for this source (muted once in the volume applet, where it
  // shows like a microphone): it would send silence to every device, with nothing to say why.
  await pactl(['set-source-mute', NAME, '0']).catch(() => {});
  await loadPlay();
  await pactl(['set-default-sink', CAP]);
  await sortInputs();
  watch();
  return LABEL;
}

// New streams the right way; a new default output picked by the person becomes the speakers.
function watch() {
  let p;
  try {
    p = spawn('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_) { return; }
  sub = p;
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      const n = /Event 'new' on sink-input #(\d+)/.exec(l);
      if (n) sortInputs(n[1]);
      else if (/Event 'change' on server/.test(l)) followDefault();
    }
  });
  p.on('error', () => {});
  p.on('exit', () => { if (sub === p) sub = null; });
}

async function followDefault() {
  if (!mods) return;
  const d = await defaultSink().catch(() => '');
  if (!d || d === CAP || !mods) return;
  real = d; // picked in the desktop's sound settings: those are the speakers now
  await unloadPlay();
  await loadPlay();
  await pactl(['set-default-sink', CAP]).catch(() => {});
  await sortInputs();
}

// → the device label to capture; throws with a readable message.
async function acquire() {
  users++;
  if (mods && !loading) return LABEL;
  if (!loading) loading = load().finally(() => { loading = null; });
  try {
    return await loading;
  } catch (e) {
    users = Math.max(0, users - 1);
    if (!users) unload();
    throw e;
  }
}

function release() {
  if (users === 0) return;
  users--;
  if (!users) unload();
}

async function unload() {
  const m = mods;
  if (!m) return;
  mods = null;
  if (sub) { sub.kill(); sub = null; }
  const speakers = real;
  await pactl(['set-default-sink', speakers]).catch(() => {});
  // Every app's stream back on the speakers before ours go.
  for (const i of parseInputs(await pactl(['list', 'sink-inputs']).catch(() => ''))) {
    if (!i.loop && i.module !== m.play && i.module !== m.remap) await pactl(['move-sink-input', i.id, speakers]).catch(() => {});
  }
  for (const idx of [m.play, m.remap, m.cap]) if (idx) await pactl(['unload-module', idx]).catch(() => {});
}

// "Mute this computer while sending" (sound.js): the speakers quiet, the capture goes on.
function setMute(on) {
  mute = !!on;
  if (!mods || loading) return;
  if (mute) unloadPlay();
  else loadPlay();
}

// TwinDesk's processes (main.js: Electron's app metrics), told apart from the other apps' streams.
function usePids(fn) {
  ours = () => {
    const s = new Set([process.pid]);
    try { for (const p of fn()) s.add(p); } catch (_) {}
    return s;
  };
}

// At quit: synchronous enough (pactl is quick); stale ones are cleaned on the next start too.
function shutdown() {
  users = 0;
  const m = mods;
  mods = null;
  if (sub) { sub.kill(); sub = null; }
  if (!m) return;
  if (real) execFile('pactl', ['set-default-sink', real], () => {});
  for (const idx of [m.play, m.remap, m.cap]) if (idx) execFile('pactl', ['unload-module', idx], () => {});
}

module.exports = { acquire, release, shutdown, setMute, usePids, LABEL, _test: { parseInputs, whereTo, CAP } };

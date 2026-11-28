// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This computer's sound as a capture device. Chromium lists no "Monitor of …" sources
// (it hides them), so while something sends our sound we load a PulseAudio remap source over the
// default output's monitor; PipeWire's pipewire-pulse does the same. The renderer picks it by its
// name (LABEL). Used by sound.js (Send sound) and pcscreen.js (the screen's sound), counted.
'use strict';

const { execFile } = require('child_process');

const NAME = 'twindesk_sound';
const LABEL = 'TwinDesk-Sound';

const pactl = (args) => new Promise((resolve, reject) => {
  execFile('pactl', args, { timeout: 8000 }, (err, out, stderr) => {
    if (err) return reject(new Error(err.code === 'ENOENT' ? 'PulseAudio or PipeWire (pactl) is not installed' : String(stderr || err.message).trim()));
    resolve(String(out).trim());
  });
});

let users = 0;
let modIdx = null; // the loaded module index
let loading = null;

async function defaultSink() {
  try {
    const s = await pactl(['get-default-sink']); // pactl 15+
    if (s) return s;
  } catch (_) { /* older pactl */ }
  const m = /^Default Sink:\s*(.+)$/m.exec(await pactl(['info']));
  if (!m) throw new Error('No sound output found');
  return m[1].trim();
}

// Modules left behind by a crash.
async function unloadStale() {
  const list = await pactl(['list', 'short', 'modules']).catch(() => '');
  for (const line of list.split('\n')) {
    if (line.includes('source_name=' + NAME)) await pactl(['unload-module', line.split('\t')[0]]).catch(() => {});
  }
}

async function load() {
  await unloadStale();
  const sink = await defaultSink();
  const idx = await pactl(['load-module', 'module-remap-source', 'master=' + sink + '.monitor', 'source_name=' + NAME,
    'source_properties=device.description=' + LABEL]);
  modIdx = idx;
  // WirePlumber restores a mute it remembers for this source (muted once in the volume applet, where it
  // shows like a microphone): it would send silence to every device, with nothing to say why.
  await pactl(['set-source-mute', NAME, '0']).catch(() => {});
  return LABEL;
}

// → the device label to capture; throws with a readable message.
async function acquire() {
  users++;
  if (modIdx) return LABEL;
  if (!loading) loading = load().finally(() => { loading = null; });
  try {
    return await loading;
  } catch (e) {
    users = Math.max(0, users - 1);
    throw e;
  }
}

function release() {
  if (users === 0) return;
  users--;
  if (users || !modIdx) return;
  const idx = modIdx;
  modIdx = null;
  pactl(['unload-module', idx]).catch(() => {});
}

// At quit: synchronous enough (pactl is quick); stale ones are cleaned on the next start too.
function shutdown() {
  users = 0;
  if (modIdx) execFile('pactl', ['unload-module', modIdx], () => {});
  modIdx = null;
}

module.exports = { acquire, release, shutdown, LABEL };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Linux's media players (MPRIS) over the session D-Bus through gdbus (glib's, on every desktop), so
// nothing needs playerctl, which many systems don't have (#242: the phone's Media page showed
// "Nothing playing" on Ubuntu 26.04). playerctl is still used when gdbus isn't there.
// Which player: one that plays (a browser's own first only among equals), else the one that paused
// last seen playing, else the first paused one; a stopped one never.
//   now() → Promise<{app, title, artist, album, playing, position, name} | null>
//   act(cmd) → Promise<bool>  cmd: toggle | play | pause | next | previous
'use strict';

const { execFile } = require('child_process');

const run = (args, timeout = 3000) => new Promise((resolve) => {
  execFile('gdbus', args, { timeout }, (err, out) => resolve(err ? null : String(out || '')));
});
const call = (dest, method, ...args) => run(['call', '--session', '--dest', dest, '--object-path', '/org/mpris/MediaPlayer2', '--method', method, ...args]);

// A GVariant string ('…' or "…", as gdbus prints it) back to text.
function unquote(s) {
  const q = s[0];
  return s.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c)).replace(q === '"' ? /\\"/g : /\\'/g, q);
}
const STR = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
function field(text, key) {
  const m = new RegExp(String.raw`'${key}': <(?:@?[a-z0-9]+ )?${STR}>`).exec(text);
  return m ? unquote(m[1]) : '';
}
function list(text, key) {
  const m = new RegExp(String.raw`'${key}': <(?:@as )?\[([^\]]*)\]>`).exec(text);
  if (!m) return [];
  return (m[1].match(new RegExp(STR, 'g')) || []).map(unquote);
}
function num(text, key) {
  const m = new RegExp(String.raw`'${key}': <(?:@?[a-z0-9]+ )?(-?\d+)>`).exec(text);
  return m ? Number(m[1]) : null;
}

async function players() {
  const out = await run(['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.ListNames']);
  if (out === null) return null; // no gdbus or no session bus
  return (out.match(/'org\.mpris\.MediaPlayer2\.[^']+'/g) || []).map((s) => s.slice(1, -1));
}

const lastPlaying = new Map(); // bus name -> when it was last seen playing

async function read(name) {
  const out = await call(name, 'org.freedesktop.DBus.Properties.GetAll', 'org.mpris.MediaPlayer2.Player');
  if (!out) return null;
  const status = field(out, 'PlaybackStatus');
  const title = field(out, 'xesam:title');
  if (!title || !status || status === 'Stopped') return null;
  if (status === 'Playing') lastPlaying.set(name, Date.now());
  const pos = num(out, 'Position');
  // The app: the bus name's own part ("firefox.instance_1_128" → firefox, "vlc" → vlc).
  const app = name.slice('org.mpris.MediaPlayer2.'.length).split('.')[0];
  return { name, app, title, artist: list(out, 'xesam:artist').join(', '), album: field(out, 'xesam:album'), playing: status === 'Playing', position: pos === null ? null : Math.floor(pos / 1e6) };
}

// The one to show and control.
async function pick(prefer) {
  const names = await players();
  if (names === null) return undefined;
  const all = (await Promise.all(names.map(read))).filter(Boolean);
  if (!all.length) return null;
  const rank = (p) => (p.playing ? 2 : 0) + (prefer && prefer.test(p.app) ? 1 : 0);
  all.sort((a, b) => rank(b) - rank(a) || (lastPlaying.get(b.name) || 0) - (lastPlaying.get(a.name) || 0));
  return all[0];
}

async function now(prefer) {
  return pick(prefer);
}

async function act(cmd) {
  const method = { toggle: 'PlayPause', play: 'Play', pause: 'Pause', next: 'Next', previous: 'Previous' }[cmd];
  if (!method) return false;
  const p = await pick();
  if (!p) return false;
  return (await call(p.name, `org.mpris.MediaPlayer2.Player.${method}`)) !== null;
}

module.exports = { now, act, players, _parse: { field, list, num } };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Settings › General › Advanced › Engines in use, while connected: which of the fast paths and their
// fallbacks this session uses right now, and why a fallback (state.engines, shared/ui-engines.js).
//   link:   'ip' (Wi-Fi or Ethernet: lan) | 'direct' (a Wi-Fi Direct group or an access point made
//           here) | 'hotspot' | 'ble', and the address
//   input:  'tdv2' (the UDP lane: native = the helper's tdfast, else JS; up, rttMs) | 'tdv1' (TCP),
//           why: 'setting' (General › Advanced) | 'bluetooth' | 'peer' (the other app didn't agree)
//   files:  shared/fastfile.js describe(): next 'fx2' | 'fx' | 'chunk', why, plain, last
//   engine: the files engine (shared/fx2.js): 'running' | 'in-process' | 'starting' | 'stopped' |
//           'failed' | 'off'
//   screen: what we share now: {codec, encoder}, else null
// Reads only what the parts already know: nothing runs for it.
'use strict';

const { laneOff } = require('./inputlane.js');

// o: current {transport, address} | null; il (InputLane | null); lane (the lane carrying input now,
// or null); fx (FastFiles); fx2 (Fx2 | null); net (netlink view | null); lan ('Wi-Fi' | 'Ethernet' |
// ''); screen {codec, encoder} | null.
function snapshot(o) {
  const c = o.current;
  if (!c) return null;
  const ble = c.transport === 'ble' || String(c.address || '').startsWith('ble:');
  const net = o.net || {};
  const link = ble ? 'ble' : net.onGroup ? (net.kind === 'hotspot' ? 'hotspot' : 'direct') : 'ip';
  let input;
  if (o.lane) {
    input = { proto: 'tdv2', native: !!o.lane.native, up: !!o.lane.up, rttMs: typeof o.lane.rttMs === 'number' ? Math.round(o.lane.rttMs) : null, why: '' };
  } else {
    const why = laneOff() ? 'setting' : ble ? 'bluetooth' : 'peer';
    input = { proto: 'tdv1', native: false, up: false, rttMs: null, why };
  }
  const files = o.fx ? o.fx.describe() : { next: 'chunk', why: 'off', plain: false, last: null };
  const engine = o.fx2 ? o.fx2.state : 'off';
  const engineWhy = o.fx2 && o.fx2.crashed && engine === 'in-process' ? String(o.fx2.crashed) : ''; // its process stopped: in the app's now
  const screen = o.screen && (o.screen.codec || o.screen.encoder) ? { codec: String(o.screen.codec || ''), encoder: String(o.screen.encoder || '') } : null;
  return { link: { kind: link, address: ble ? '' : String(c.address || '').replace(/^::ffff:/, ''), lan: o.lan || '' }, input, files, engine, engineWhy, screen };
}

module.exports = { snapshot };

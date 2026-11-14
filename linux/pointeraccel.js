// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The desktop's mouse acceleration, for the Wayland helper (linux-helper/src/wl.c): no app may
// read where the pointer is there, so the helper follows it from the mouse's moves with libinput's
// acceleration, and it has to be the one the desktop set, or a quick flick puts the helper's pointer
// at the edge while the real one is still on the screen (and crosses there). Read from GNOME
// (gsettings), KDE (kcminputrc), Hyprland (hyprctl) and Sway (swaymsg); elsewhere libinput's
// default. On X11 the helper reads the real pointer and doesn't need it.
// Also the touchpad's tap to click and natural scrolling: while a Wayland helper drives another
// device it grabs the touchpad, so it makes the taps and scrolling itself, the desktop's way (#222).
// Niri's are read from its config.kdl.
//   get()            -> {accelProfile: 'adaptive' | 'flat', accelSpeed: -1..1, padTap, padNatural}
//   watch(onChange)  reads it now and every 30 s; onChange() when it differs (on Wayland only)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PAD = { padTap: true, padNatural: false }; // a desktop we can't read: taps on, as most set them
const DEFAULT = { accelProfile: 'adaptive', accelSpeed: 0, ...PAD };
const on = (v, def) => (v === null || v === undefined ? def : /^(true|1|enabled|yes)$/i.test(String(v).replace(/['"]/g, '').trim()));

const speedOf = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
};
const profileOf = (v) => (/flat/i.test(String(v)) ? 'flat' : 'adaptive');

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000 }, (err, out) => resolve(err ? null : String(out).trim()));
  });
}

// gsettings prints 'flat' (quoted) and 0.25.
async function gnome() {
  const schema = 'org.gnome.desktop.peripherals.mouse';
  const pad = 'org.gnome.desktop.peripherals.touchpad';
  const [p, s, tap, nat] = await Promise.all([run('gsettings', ['get', schema, 'accel-profile']), run('gsettings', ['get', schema, 'speed']),
    run('gsettings', ['get', pad, 'tap-to-click']), run('gsettings', ['get', pad, 'natural-scroll'])]);
  if (p === null && s === null) return null;
  return { accelProfile: profileOf(p), accelSpeed: speedOf(s), padTap: on(tap, PAD.padTap), padNatural: on(nat, PAD.padNatural) };
}

// kcminputrc: a [Libinput][vendor][product][name] group per device, PointerAccelerationProfile
// (libinput's: 1 flat, 2 adaptive) and PointerAcceleration (-1..1). The first that sets either and
// isn't a touchpad: the mouse.
function parseKde(text) {
  let group = '';
  const devs = new Map();
  const pad = { ...PAD };
  for (const line of String(text).split('\n')) {
    const g = line.match(/^\s*\[(.*)\]\s*$/);
    if (g) { group = g[1]; continue; }
    const t = line.match(/^\s*(TapToClick|NaturalScroll)\s*=\s*(\S+)/);
    if (t && /^Libinput\]/.test(group) && /touchpad/i.test(group)) pad[t[1] === 'TapToClick' ? 'padTap' : 'padNatural'] = on(t[2]);
    const kv = line.match(/^\s*(PointerAccelerationProfile|PointerAcceleration)\s*=\s*(\S+)/);
    if (!kv || !/^Libinput\]/.test(group) || /touchpad/i.test(group)) continue;
    const d = devs.get(group) || { ...DEFAULT };
    if (kv[1] === 'PointerAccelerationProfile') d.accelProfile = Number(kv[2]) === 1 ? 'flat' : 'adaptive';
    else d.accelSpeed = speedOf(kv[2]);
    devs.set(group, d);
  }
  return { ...(devs.size ? devs.values().next().value : { accelProfile: DEFAULT.accelProfile, accelSpeed: DEFAULT.accelSpeed }), ...pad };
}

function kde() {
  const dir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  try {
    return parseKde(fs.readFileSync(path.join(dir, 'kcminputrc'), 'utf8')) || { ...DEFAULT };
  } catch (_) {
    return { ...DEFAULT }; // never changed: libinput's default
  }
}

// hyprctl getoption … -j: {"str": "flat"} and {"float": 0.25}.
async function hyprland() {
  const opt = (k) => run('hyprctl', ['getoption', k, '-j']);
  const [p, s, tap, nat] = await Promise.all([opt('input:accel_profile'), opt('input:sensitivity'), opt('input:touchpad:tap-to-click'), opt('input:touchpad:natural_scroll')]);
  const j = (t) => { try { return JSON.parse(t) || {}; } catch (_) { return {}; } };
  if (p === null && s === null) return null;
  const int = (t, def) => (Number.isInteger(j(t).int) ? j(t).int !== 0 : def);
  return { accelProfile: profileOf(j(p).str), accelSpeed: speedOf(j(s).float), padTap: int(tap, PAD.padTap), padNatural: int(nat, PAD.padNatural) };
}

// swaymsg -t get_inputs -r: the first pointer's libinput {accel_profile, accel_speed}.
function parseSway(text) {
  let list;
  try { list = JSON.parse(text); } catch (_) { return null; }
  if (!Array.isArray(list)) return null;
  const d = list.find((i) => i && i.type === 'pointer' && i.libinput);
  const t = list.find((i) => i && i.type === 'touchpad' && i.libinput);
  const pad = t ? { padTap: on(t.libinput.tap, PAD.padTap), padNatural: on(t.libinput.natural_scroll, PAD.padNatural) } : { ...PAD };
  return d ? { accelProfile: profileOf(d.libinput.accel_profile), accelSpeed: speedOf(d.libinput.accel_speed), ...pad } : t ? { ...DEFAULT, ...pad } : null;
}

async function sway() {
  const out = await run('swaymsg', ['-t', 'get_inputs', '-r']);
  return out === null ? null : parseSway(out);
}

// niri's config.kdl: `input { touchpad { tap; natural-scroll; accel-speed 0.2; accel-profile "flat" } }`,
// each a line of its own (// comments out). Its default config has tap and natural-scroll on.
function parseNiri(text) {
  const lines = String(text).split('\n').map((l) => l.replace(/\/\/.*$/, '').trim());
  const at = lines.findIndex((l) => /^touchpad\s*\{/.test(l));
  if (at < 0) return { ...DEFAULT, padNatural: false };
  const out = { ...DEFAULT, padTap: false, padNatural: false };
  let depth = 0;
  for (let i = at; i < lines.length; i++) {
    const l = lines[i];
    if (i > at && depth === 1) {
      if (/^tap\b(?!-)/.test(l)) out.padTap = true;
      else if (/^natural-scroll\b/.test(l)) out.padNatural = true;
      else if (/^accel-speed\s/.test(l)) out.accelSpeed = speedOf(l.split(/\s+/)[1]);
      else if (/^accel-profile\s/.test(l)) out.accelProfile = profileOf(l);
    }
    depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
    if (depth <= 0 && i > at) break;
  }
  return out;
}

function niri(env) {
  const dir = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  try {
    return parseNiri(fs.readFileSync(path.join(dir, 'niri', 'config.kdl'), 'utf8'));
  } catch (_) {
    return { ...DEFAULT, padNatural: true }; // no config: niri's default one, tap and natural-scroll on
  }
}

async function read(env = process.env) {
  const desk = String(env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  let r = null;
  if (env.NIRI_SOCKET || /niri/.test(desk)) r = niri(env);
  else if (env.HYPRLAND_INSTANCE_SIGNATURE) r = await hyprland();
  else if (env.SWAYSOCK) r = await sway();
  else if (/kde/.test(desk)) r = kde();
  else if (/gnome|unity|budgie|pantheon/.test(desk)) r = await gnome();
  return r || { ...DEFAULT };
}

let cur = { ...DEFAULT };
const get = () => cur;

async function refresh(onChange) {
  const r = await read().catch(() => null);
  if (!r || JSON.stringify(r) === JSON.stringify(cur)) return;
  cur = r;
  onChange();
}

const watchers = [];
function watch(onChange) {
  if (!process.env.WAYLAND_DISPLAY) return;
  watchers.push(onChange);
  const all = () => watchers.forEach((fn) => fn());
  if (watchers.length > 1) return;
  refresh(all);
  setInterval(() => refresh(all), 30000).unref(); // the desktop's mouse settings changed meanwhile
}

module.exports = { get, watch, read, parseKde, parseSway, parseNiri };

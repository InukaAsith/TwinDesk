// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ADB or Native, for each thing a computer does with a phone (phone-bridge.js on Mac, PC and Linux):
//   input   the mouse and keyboard: scrcpy's control (ADB) or TwinDesk's Accessibility service there
//           (Native). Kept as settings.phone.input 'adb' | 'phone' + inputPicked, as before.
//   mirror  the phone's screen in a window: scrcpy (ADB) or the phone's own screen capture
//           (Native, shared/nativescreen.js). settings.phone.mirror.
//   sound   the phone's sound here: scrcpy's (ADB, which takes it off the phone) or the phone's own
//           playback capture (Native, which leaves it playing there too). settings.phone.soundVia.
// Each is 'auto' until picked: ADB once wireless debugging is ready, else Native. A phone app too
// old for Native mirroring (no 'mirror.native' in phone.info caps) mirrors through ADB.
//
// Wireless debugging is needed (adb.bridge need: the phone switches it on and asks for it) while
// something here would use it: an ADB pick, a phone whose wireless debugging this computer has
// reached before (it worked, so it carries on as it did), setting it up on purpose (Connection's
// Set Up or a pairing code), or what only ADB does (phone apps in windows, the camera, the phone's
// microphone, installing the full app).
'use strict';

const MODES = ['auto', 'adb', 'native'];

// settings.phone.mirror / soundVia: 'auto' | 'adb' | 'native'.
function picked(ph, key) {
  const v = ph && ph[key];
  return v === 'adb' || v === 'native' ? v : 'auto';
}

// The input choice as the other two: 'phone' is Native.
function inputPicked(ph) {
  ph = ph || {};
  return ph.input === 'phone' ? 'native' : ph.input === 'adb' && ph.inputPicked ? 'adb' : 'auto';
}

// What a choice goes through now: 'adb' | 'native'.
function resolve(mode, { adbReady, nativeOk = true }) {
  if (mode === 'adb') return 'adb';
  if (mode === 'native') return 'native';
  return adbReady || !nativeOk ? 'adb' : 'native';
}

// The phone's caps (phone.info), as a Set. An app from before them sends none.
function caps(info) {
  return new Set(info && Array.isArray(info.caps) ? info.caps.filter((c) => typeof c === 'string').slice(0, 50) : []);
}

// Whether wireless debugging is needed now (see the top). o: {ph, known, setup, adbOnly}.
function need({ ph, known, setup, adbOnly }) {
  const modes = [inputPicked(ph), picked(ph, 'mirror'), picked(ph, 'soundVia')];
  if (modes.includes('adb')) return true;
  if (setup || adbOnly) return true;
  return !!known && modes.includes('auto');
}

module.exports = { MODES, picked, inputPicked, resolve, caps, need };

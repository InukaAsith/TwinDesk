// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// JSON files in Electron's userData, written atomically (temp file + rename).
'use strict';

const fs = require('fs');
const path = require('path');

let baseDir = null;

function init(dir) {
  baseDir = dir;
  fs.mkdirSync(baseDir, { recursive: true });
}

function filePath(name) {
  return path.join(baseDir, name);
}

function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[store] ${name} unreadable, using defaults:`, e.message);
    return fallback;
  }
}

function write(name, data) {
  const target = filePath(name);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

// Settings with defaults; missing keys are filled in. Every feature is off until it's turned on (a
// fresh install); settings saved before keep theirs, and features off here were on for them (WAS_ON).
// The features that defaulted to on before they all started off: a settings file saved then has
// them on where it doesn't say.
const WAS_ON = {
  kvm: ['mouse', 'keyboard'], clipboard: ['enabled'], audio: ['phoneMedia'], remote: ['allow'],
  files: ['acceptDrops', 'dragEdge', 'shortcuts'], notifs: ['receive'], apps: ['offer'], papps: ['on'], receive: ['on'], smb: ['connectPc'],
};

const DEFAULT_SETTINGS = {
  macId: null,
  macName: null,
  rev: 9, // settings revision: older files are upgraded once in loadSettings
  // `on` is reset to false at every start. remote: the other computer may start/stop
  // sharing and switch Extend/Mirror (screen.ctl). pace: playback of shared screens, both
  // directions, the same on both computers (pair.sync): 'fast' (shown the moment it arrives) |
  // 'smooth' (about one frame of buffer, even motion).
  sharing: { on: false, displayId: null, audio: false, remote: true, pace: 'fast', codec: 'h264' }, // codec: Share screen › Encoder (shared/screencodec.js)
  virtual: { enabled: true, width: 1920, height: 1080, hiDPI: false, hz: 60 },
  bitrateMbps: 30,
  streamInput: true, // accept mouse/keyboard from Monitor 2
  streamMaxHeight: 1080, // 0 = capture at the display's pixel size; else scale down (GPU) to this height
  kvm: {
    pcSide: 'right',
    along: null, // the other computer's place along that side, points (shared/kvm-geom.js); null: centred
    mouse: false, // Cursor tab
    keyboard: false, // Keyboard tab
    driveOther: true,
    beDriven: true,
    resistancePx: 120,
    speed: 1.0,
    reverseScroll: false,
    linked: true, // mouse and keyboard sharing on (the hotkey's double-tap switches it); synced with the peer
    linkedBy: {}, // The last `linked` per paired device id, restored on connect
    gestures: true, // Trackpad gestures work on the other computer (synced per pair)
    shakeHome: true, // shake this Mac's mouse while driving: the pointer comes home (the helper's Shake.swift)
    syncPads: false, // every mouse and trackpad moves the one pointer; off: a computer's own takes it back (synced per pair)
    ble: true, // cursor sharing while the session runs through Bluetooth (synced per pair)
    hotkeySwitch: false, // keyboard only (mouse off): double-tap the hotkey to move the keyboard over and back
  },
  // swap: keys from the PC, Ctrl -> Cmd, Win -> Control. hotkey: double-tap = everything home. lockKeys: cursor lock
  // on/off (shared/cursorlock.js): F14, where a PC keyboard's Scroll Lock lands on a Mac
  keys: { swapCtrlCmd: true, hotkey: 'AltRight', lockKeys: 'F14' },
  clipboard: {
    enabled: false,
    send: true, // this Mac -> PC
    receive: true, // PC -> this Mac
    mode: 'instant', // 'instant' (whenever you copy, the default) | 'switch' (Monitor 2 focus, crossing)
    skipConcealed: true, // passwords from password managers
    maxKB: 256,
    historySize: 20, // memory only
    images: false, // pictures too, up to 10 MB (shared/clipimage.js); screenshots put on the clipboard among them
  },
  // setupSkipped: the missing items when Setup was skipped; setupDone: Setup has been through once
  // (everything allowed, or skipped), so it never takes over the window again (General shows the rest).
  ui: { tab: 'overview', setupSkipped: '', setupDone: false, language: '', theme: 'system', accent: '' }, // theme/accent: General › Appearance
  app: { openAtLogin: false, keepAwake: true, hud: true, inputProtocol: 'udp' }, // inputProtocol: udp = tdv2 input lane, tcp = tdv1 // hud = popup when switching computers
  updates: { auto: true, notified: '', skipped: '' }, // check GitHub for new releases; notified = last version announced, skipped = version ignored
  audio: { send: false, receive: false, muteLocal: false, volume: 1, phoneMedia: false, micSend: false, micReceive: false, micDevice: '', micOut: '' }, // Independent, both ways; phoneMedia: a phone's media controls on Overview
  rezume: require('../shared/rezume.js').DEFAULTS, // ReZume tab (shared/rezume.js): off until turned on; what goes, which ways, where it shows
  web: { enabled: false, portal: true, airplay: true, port: 47802 },
  remote: { allow: false }, // Remote tab (shared/phone-remote.js): the phone's Remote page moves the pointer and types here
  camera: { on: false, share: false, device: '', virtual: false, rotate: 0, target: 'obs' }, // Camera tab (shared/camshare.js): this Mac's camera to the other computer, off until turned on; virtual: the running camera's picture also goes to the virtual camera (shared/vcam.js); rotate: its picture turned clockwise; target: the virtual camera it feeds, 'obs' (OBS Virtual Camera, the default) or 'twindesk'
  terminal: { allowPc: false, connectPc: false }, // the other computer -> this Mac shell; this Mac -> the other one (`ssh twindesk`)
  files: { acceptDrops: false, folder: '', reveal: true, dragEdge: false, // '' = Downloads; dragEdge = drag.policy
    plain: false, // Encrypt file transfers off: plain HTTP for file bytes where both allow it (shared/fastfile.js fxPlain)
    shortcuts: false, copyKeys: 'Control+Alt+C', pasteKeys: 'Control+Alt+V' }, // Copy/paste files
  notifs: { send: false, receive: false, hideText: false, muted: [] },
  apps: { offer: false, onVirtual: false, moveWindows: false, moveKey: 'MetaRight' }, // The PC can list and open this Mac's apps; onVirtual: they open on the virtual display, in Mirror mode too (off: on the shared display, as always); moveWindows: a window dragged past the edge with moveKey held moves there (movewin.js)
  papps: { on: false }, // PC apps on this Mac, each window here with its own Dock icon
  // A phone as the peer: its screen window, apps and setup.
  phone: { sound: false, bitrateMbps: 8, maxSize: 0, wallpaper: true, input: 'adb', inputPicked: false, mirror: 'auto', soundVia: 'auto', enterSends: true, arrowSwipe: false }, // mirror, soundVia: 'auto' | 'adb' | 'native' (shared/phonemodes.js) // input: 'adb' | 'phone' (phone-bridge.js ctl), automatic until picked (inputMode)
  mount: { on: false }, // the phone in Finder (phonedrive.js), only when Mount is clicked
  // Calls, Messages, Photos and Files from a phone (shared/phonehub.js), each off until switched on.
  // callAudio: the calls' sound on this Mac over Bluetooth (btDevices: which paired device each phone is).
  hub: { calls: false, messages: false, media: false, files: false, callAudio: true, shareMount: false, shareServe: false, shareFolder: '' }, // share*: shared folders (foldershare.js)
  // Not on one network: Bluetooth for the session (blepipe.js), Wi-Fi for files and screens
  // (netlink.js). hotspots: {deviceId: {ssid, pass (safeStorage)}}, a phone's hotspot as typed once.
  net: { ble: true, blePc: false, bleWifiOff: true, hotspots: {} }, // ble: with phones, blePc: with computers; bleWifiOff: none on the same Wi-Fi (blepolicy.js wifiQuiet)

  // The other computer's screen in a window here; framegen: shared/framegen.js.
  receive: { on: false, fullScreen: false, input: true, framegen: false },
  wake: { peers: {} }, // {deviceId: {name, macs, address, at}} from wol.info, for Wake
  pairSync: {}, // {deviceId: {feature: {out, in}}} two-way switches per pair (pairsync.js)
  smb: { connectPc: false, sharing: false, folder: '', secret: '' }, // secret = safeStorage
};

function loadSettings() {
  const s = read('settings.json', {});
  if (s.sharing) s.sharing.on = false; // screen sharing never starts by itself
  const out = { ...DEFAULT_SETTINGS, ...s };
  for (const k of ['wake', 'sharing', 'virtual', 'kvm', 'keys', 'clipboard', 'ui', 'app', 'audio', 'terminal', 'files', 'smb', 'apps', 'receive', 'papps', 'notifs', 'updates', 'phone', 'mount', 'hub', 'camera', 'remote', 'web']) out[k] = { ...DEFAULT_SETTINGS[k], ...(s[k] || {}) };
  out.rezume = require('../shared/rezume.js').normalize(s.rezume);
  out.ui.language = require('../shared/i18n.js').savedLanguage(out.ui.language);
  { const Look = require('../shared/look.js'); out.ui.theme = Look.theme(out.ui.theme); out.ui.accent = Look.accent(out.ui.accent); }
  if (Object.keys(s).length) {
    for (const [k, keys] of Object.entries(WAS_ON)) for (const f of keys) if (!s[k] || s[k][f] === undefined) out[k][f] = true;
  }
  if (s.ui && s.ui.setupSkipped && s.ui.setupDone === undefined) out.ui.setupDone = true;
  if ((s.rev || 0) < 7) { // Clipboard instant by default
    out.clipboard.mode = 'instant';
    out.rev = 7;
  }
  // Camera is never turned on by an upgrade: once, off unless this Mac's camera is shared.
  if ((s.rev || 0) < 8) {
    if (!out.camera.share) out.camera.on = false;
    out.rev = 8;
  }
  // Move windows: Right Command, not Right Control (most Mac keyboards have no Right Control).
  if ((s.rev || 0) < 9) {
    if (out.apps.moveKey === 'ControlRight') out.apps.moveKey = 'MetaRight';
    out.rev = 9;
  }
  return out;
}

function saveSettings(s) {
  write('settings.json', s);
}

module.exports = { init, filePath, read, write, loadSettings, saveSettings };

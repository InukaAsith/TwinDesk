// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// settings.json: defaults and validation. Every value from
// disk or from the UI goes through normalize(), so main never stores anything out of range.
const P = require('../shared/protocol.js');

const TABS = ['phone', 'overview', 'calls', 'messages', 'media', 'pfiles', 'mac-pc', 'pc-mac', 'cursor', 'keyboard', 'clipboard', 'notifications', 'files', 'mount', 'terminal', 'audio', 'apps', 'general', 'about'];

const OLD_TABS = { display: 'mac-pc', receive: 'mac-pc', share: 'pc-mac' }; // older names

const bool = (v, d) => (typeof v === 'boolean' ? v : d);
// Which Bluetooth device each phone is (shared/phonehub.js): {phone's id: device id}, a few.
const btDevices = (v) => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {})
  .filter(([k, id]) => typeof k === 'string' && k.length <= 100 && typeof id === 'string' && id).slice(-20).map(([k, id]) => [k, id.slice(0, 400)])); // Windows' device ids are long
// A phone's hotspot as typed once, per phone: {deviceId: {ssid, pass (safeStorage, base64)}}.
const hotspots = (v) => {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const [id, h] of Object.entries(v).slice(0, 20)) {
    if (h && typeof h.ssid === 'string' && typeof h.pass === 'string') out[id.slice(0, 64)] = { ssid: h.ssid.slice(0, 32), pass: h.pass.slice(0, 2000) };
  }
  return out;
};
// A global shortcut (Electron accelerator): Ctrl, Alt or the Windows key, plus one key.
const KEY = /^(?:(?:Control|Alt|Shift|Super)\+){1,4}(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Enter|Up|Down|Left|Right)$/;
const accel = (v, d) => (typeof v === 'string' && KEY.test(v) && /Control|Alt|Super/.test(v) ? v : d);
const num = (v, d, min, max) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.min(max, Math.max(min, Number(v))) : d);

function normalize(s) {
  s = s || {};
  const kvm = s.kvm || {};
  const keys = s.keys || {};
  const c = s.clipboard || {};
  const ui = s.ui || {};
  const mon = s.monitor || {};
  const audio = s.audio || {};
  const term = s.terminal || {};
  const files = s.files || {};
  const pcs = s.pcScreen || {};
  const pca = s.pcApps || {};
  const mca = s.macApps || {};
  const setup = s.setup || {};
  const appS = s.app || {};
  const up = s.updates || {};
  const nf = s.notifs || {};
  const wk = s.wake || {};
  const ph = s.phone || {};
  const mt = s.mount || {};
  const hub = s.hub || {};
  const nt = s.net || {};
  return {
    rev: 8, // settings revision (upgrades in normalize, like the Mac's store.js)
    kvm: {
      mouse: bool(kvm.mouse, true),
      keyboard: bool(kvm.keyboard, true),
      driveOther: bool(kvm.driveOther, true),
      beDriven: bool(kvm.beDriven, true),
      resistancePx: Math.round(num(kvm.resistancePx, P.RESISTANCE_PX, 0, 400)),
      pcSide: P.SIDES.includes(kvm.pcSide) ? kvm.pcSide : null, // where this PC is, seen from the other computer (kvm.layout)
      edges: kvm.edges && typeof kvm.edges === 'object'
        ? {
            left: typeof kvm.edges.left === 'string' ? kvm.edges.left : null,
            right: typeof kvm.edges.right === 'string' ? kvm.edges.right : null,
            top: typeof kvm.edges.top === 'string' ? kvm.edges.top : null,
            bottom: typeof kvm.edges.bottom === 'string' ? kvm.edges.bottom : null,
          }
        : null,
      speed: Math.round(num(kvm.speed, 1.0, 0.25, 3) * 100) / 100,
      reverseScroll: bool(kvm.reverseScroll, false),
      linked: bool(kvm.linked, true), // cursor sharing on (the hotkey's double-tap switches it, kvm.link)
      // The last `linked` per paired device id, restored on connect
      linkedBy: kvm.linkedBy && typeof kvm.linkedBy === 'object'
        ? Object.fromEntries(Object.entries(kvm.linkedBy).filter(([, v]) => typeof v === 'boolean').slice(0, 50)) : {},
      gestures: bool(kvm.gestures, true), // Trackpad gestures work on the other computer (pair.sync 'gestures')
      ble: bool(kvm.ble, true), // cursor sharing while the session runs through Bluetooth (pair.sync 'ble')
      hotkeySwitch: bool(kvm.hotkeySwitch, false), // keyboard only (Cursor off): double-tap moves the keyboard over and back
    },
    // hotkey: double-tap = mouse and keyboard home
    keys: { swapCtrlCmd: bool(keys.swapCtrlCmd, true), hotkey: P.HOTKEYS.includes(keys.hotkey) ? keys.hotkey : P.HOTKEY_WIN },
    app: { hud: bool(appS.hud, true) }, // popup when switching computers
    // New releases on GitHub (shared/updates.js); notified = the last version announced
    updates: { auto: bool(up.auto, true), notified: typeof up.notified === 'string' ? up.notified.slice(0, 40) : '' },
    clipboard: {
      enabled: bool(c.enabled, true),
      send: bool(c.send, true),
      receive: bool(c.receive, true),
      // Instant by default; files from before it (no rev) are upgraded once
      mode: c.mode === 'switch' && (s.rev || 0) >= 7 ? 'switch' : 'instant',
      skipConcealed: bool(c.skipConcealed, true),
      maxKB: Math.round(num(c.maxKB, 256, 1, P.CLIP_MAX_BYTES / 1024)),
      historySize: Math.round(num(c.historySize, 20, 0, 100)),
    },
    monitor: {
      volume: Math.round(num(mon.volume, 1, 0, 1) * 100) / 100,
      mute: bool(mon.mute, false),
      // Playback of shared screens, both directions, the same on both computers (pair.sync
      // 'pace'): 'fast' (default, shown the moment it is decoded) | 'smooth' (about a frame of buffer)
      pacing: mon.pacing === 'smooth' && (s.rev || 0) >= 8 ? 'smooth' : 'fast', // rev 8: back to Fastest once
      framegen: bool(mon.framegen, false), // in-between frames on the GPU (shared/framegen.js), off by default
    },
    audio: {
      receive: bool(audio.receive, true), // play the Mac's sound here (audio.policy W→M)
      volume: Math.round(num(audio.volume, 1, 0, 1) * 100) / 100,
      send: bool(audio.send, false), // send this PC's sound to the Mac (dir w2m)
      muteLocal: bool(audio.muteLocal, false), // silence this PC while sending
    },
    terminal: {
      enabled: bool(term.enabled, false), // shell on the Mac from this PC
      allowMac: bool(term.allowMac, false), // let the Mac open a shell here (needs OpenSSH Server)
      installedKey: typeof term.installedKey === 'string' ? term.installedKey : '', // digest of the Mac key line we installed
    },
    files: {
      dropToMac: bool(files.dropToMac, true),
      shareOn: bool(files.shareOn, false), // set only by a successful share setup (smb.js)
      shareFolder: typeof files.shareFolder === 'string' ? files.shareFolder : '',
      mountMac: bool(files.mountMac, true),
      acceptFromMac: bool(files.acceptFromMac, true), // files dragged from the Mac across the edge
      edgeDrag: bool(files.edgeDrag, true), // drag files/folders across the screen edge, both ways (drag.policy)
      // Copy and paste files with two global shortcuts (fclip.js)
      shortcuts: bool(files.shortcuts, true),
      copyKeys: accel(files.copyKeys, 'Control+Alt+C'),
      pasteKeys: accel(files.pasteKeys, 'Control+Alt+V'),
    },
    notifs: { // (notifs.js): muted = apps never sent
      send: bool(nf.send, false),
      receive: bool(nf.receive, true),
      hideText: bool(nf.hideText, false),
      muted: Array.isArray(nf.muted) ? nf.muted.filter((x) => typeof x === 'string').map((x) => x.slice(0, 300)).slice(0, 500) : [],
    },
    pcScreen: { // Display › PC → Mac; Off/Mirror/Extend itself is never saved
      monitor: typeof pcs.monitor === 'string' ? pcs.monitor : '', // Electron display id for Mirror ('' = main)
      mbps: [10, 20, 30, 50].includes(pcs.mbps) ? pcs.mbps : 30, // same presets as the Mac
      maxHeight: [0, 1080, 1440].includes(pcs.maxHeight) ? pcs.maxHeight : 1080, // stream size (0 = full pixels)
      extendSize: ['mac', '1920x1080', '2560x1440', '3840x2160'].includes(pcs.extendSize) ? pcs.extendSize : 'mac', // the virtual monitor
      sound: bool(pcs.sound, false), // the screen's sound in the same session
      input: bool(pcs.input, true), // the Mac's mouse and keyboard drive this PC
      remote: bool(pcs.remote, true), // The viewer may start/stop and switch it (screen.ctl)
    },
    pairSync: pairSync(s.pairSync), // {deviceId: {feature: {out, in}}} (pairsync.js)
    wake: { peers: wakePeers(wk.peers) }, // {deviceId: {name, os, macs, address, at}} from wol.info
    pcApps: { allow: bool(pca.allow, true) },
    // A phone as the peer: its screen window, apps and setup
    phone: {
      sound: bool(ph.sound, false),
      bitrateMbps: Math.round(num(ph.bitrateMbps, 8, 2, 40)),
      maxSize: [0, 1920, 1600, 1280, 1024].includes(ph.maxSize) ? ph.maxSize : 0,
      wallpaper: bool(ph.wallpaper, true),
      input: ph.input === 'phone' ? 'phone' : 'adb', // the mouse and keyboard through adb, or the phone's Accessibility service
      inputPicked: bool(ph.inputPicked, false), // not picked: automatic (phone-bridge.js inputMode)
    },
    // Bluetooth for devices not on this network (blepipe.js, netlink.js): with phones (ble), with computers (blePc);
    // bleWifiOff: none at all while the session is on the same Wi-Fi (blepolicy.js wifiQuiet)
    net: { ble: bool(nt.ble, true), blePc: bool(nt.blePc, false), bleWifiOff: bool(nt.bleWifiOff, true), hotspots: hotspots(nt.hotspots) },
    mount: { on: bool(mt.on, false) }, // the phone as a drive (phonedrive.js), only when Mount is clicked
    // Calls, Messages, Photos and Files from a phone (shared/phonehub.js), each off until switched on.
    // callAudio: the calls' sound here over Bluetooth; btDevices: which paired Bluetooth device each
    // phone is (its device id -> the Bluetooth device's id), found by its name or picked.
    hub: {
      calls: bool(hub.calls, false), messages: bool(hub.messages, false), media: bool(hub.media, false), files: bool(hub.files, false),
      callAudio: bool(hub.callAudio, true), btDevices: btDevices(hub.btDevices),
      // Shared folders (shared/foldershare.js), both ways, off until switched on.
      shareMount: bool(hub.shareMount, false), shareServe: bool(hub.shareServe, false), shareFolder: typeof hub.shareFolder === 'string' ? hub.shareFolder.slice(0, 1000) : '',
    },
    macApps: { on: bool(mca.on, true) }, // The other computer's apps open here (pair.sync 'apps' in) // The Mac may open this PC's apps (it shows them only if it accepts)
    // Setup screen: shown once. done: everything was ready, or 'Skip for now' was pressed; after that
    // General and Display show what's missing (a firewall that changes with the network, a helper
    // that restarts, a phone connecting don't bring the screen back).
    setup: { skipped: Array.isArray(setup.skipped) ? setup.skipped.filter((x) => typeof x === 'string').slice(0, 10) : [], done: bool(setup.done, Array.isArray(setup.skipped) && setup.skipped.length > 0) },
    ui: { tab: OLD_TABS[ui.tab] || (TABS.includes(ui.tab) ? ui.tab : 'overview') },
    windows: s.windows && typeof s.windows === 'object' ? s.windows : {},
  };
}

// pair.sync values per paired device: booleans only, at most 20 devices.
function pairSync(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const [id, feats] of Object.entries(v).slice(0, 20)) {
    if (!feats || typeof feats !== 'object') continue;
    out[id] = {};
    for (const [f, d] of Object.entries(feats).slice(0, 10)) {
      if (f === 'values') {
        out[id].values = {};
        if (d && ['fast', 'smooth'].includes(d.pace)) out[id].values.pace = d.pace;
        if (d && typeof d.gestures === 'boolean') out[id].values.gestures = d.gestures;
        if (d && typeof d.keyboard === 'boolean') out[id].values.keyboard = d.keyboard; // with a phone
        if (d && typeof d.reverseScroll === 'boolean') out[id].values.reverseScroll = d.reverseScroll;
        if (d && Number.isFinite(d.speed)) out[id].values.speed = Math.min(3, Math.max(0.25, d.speed));
      }
      else if (d && typeof d === 'object') out[id][f] = { out: d.out === true, in: d.in === true };
    }
  }
  return out;
}

// wol.info per paired device, as wake.js stored it (at most 20, MAC addresses checked).
function wakePeers(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const [id, p] of Object.entries(v).slice(0, 20)) {
    const macs = p && Array.isArray(p.macs) ? p.macs.filter((m) => typeof m === 'string' && /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(m)).slice(0, 8) : [];
    if (!macs.length) continue;
    out[id] = { name: String(p.name || '').slice(0, 200), os: String(p.os || ''), macs, address: typeof p.address === 'string' ? p.address.slice(0, 64) : '', at: Number(p.at) || 0 };
  }
  return out;
}

// Merge a partial change from the UI into one section and re-validate.
function apply(settings, section, partial) {
  if (!partial || typeof partial !== 'object' || !(section in settings)) return false;
  const next = normalize({ ...settings, [section]: { ...settings[section], ...partial } });
  const changed = JSON.stringify(next[section]) !== JSON.stringify(settings[section]);
  settings[section] = next[section];
  return changed;
}

module.exports = { normalize, apply };

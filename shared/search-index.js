// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Search (⌘K, and the search button): the settings, shortcuts and features, found by what they do
// — "share pc audio to phone", "phone audio on pc", "send a file", "dark mode". One list for every
// app: the computers read it here (shared/ui-search.js); the phones get it generated
// (android/tools/gen-search.js → SearchIndex.kt, ios/tools/gen-search.js → SearchIndex.swift), and
// each has the same matcher (match() here, Search.kt, SearchView.swift).
//
// An entry: t, what it's called (translated where shown); k, the words people use for it; page,
// where it is (PAGES: that page on each app; an app without it doesn't list the entry); dir, which
// way it goes, 'c2p' (the computer's thing on the phone) or 'p2c', so "pc audio to phone" and
// "phone audio on pc" each find their own; on, only these apps ('desk', 'android', 'ios').
'use strict';

(function () {
// Each page on each app: the computers' tab ids (a Windows or Linux one where it differs), the
// Android app's Tab names, the iPhone app's Page cases.
const PAGES = {
  overview: { desk: 'overview', android: 'Overview', ios: 'overview' },
  connection: { desk: 'connection', android: 'Connection', ios: 'connection' },
  calls: { desk: 'calls', android: 'Calls' },
  messages: { desk: 'messages', android: 'Messages', ios: 'messages' },
  photos: { desk: 'media', android: 'Photos', ios: 'photos' },
  phonefiles: { desk: 'pfiles', android: 'FileAccess' },
  mount: { desk: 'mount' },
  mirror: { desk: 'mirror', android: 'Screen', ios: 'share' }, // the phone's screen on the computer
  phoneapps: { desk: 'papps' },
  viewpc: { android: 'Screen', ios: 'receive' }, // the computer's screen on the phone
  sharescreen: { mac: 'share', win: 'pc-mac' }, // this computer's screen on the other one
  receivescreen: { mac: 'receive', win: 'mac-pc' },
  apps: { desk: 'apps' },
  cursor: { desk: 'cursor', android: 'Cursor', ios: 'remote' },
  keyboard: { desk: 'keyboard', android: 'Keyboard', ios: 'remote' },
  remote: { desk: 'remote', android: 'Remote', ios: 'remote' },
  deck: { desk: 'deck', android: 'Deck', ios: 'deck' },
  clipboard: { desk: 'clipboard', android: 'Clipboard', ios: 'clipboard' },
  notifications: { desk: 'notifications', android: 'Notifications', ios: 'notifications' },
  files: { desk: 'files', android: 'Files', ios: 'files' },
  rezume: { desk: 'rezume', android: 'Rezume' },
  audio: { desk: 'audio', android: 'Sound', ios: 'audio' },
  camera: { desk: 'camera', android: 'Camera', ios: 'camera' },
  nowplaying: { android: 'Media', ios: 'media' },
  terminal: { desk: 'terminal' },
  multi: { desk: 'multi' },
  web: { desk: 'web' },
  airplay: { desk: 'airplay', ios: 'airplay' },
  shortcuts: { ios: 'shortcuts' },
  general: { desk: 'general', android: 'General', ios: 'general' },
  about: { desk: 'about', android: 'About', ios: 'about' },
};

const ENTRIES = [
  // Sound
  { t: 'Play the computer’s sound on the phone', page: 'audio', dir: 'c2p', k: 'share pc audio to phone, computer sound on phone, listen to laptop on mobile, speaker, music, stream audio, headphones' },
  { t: 'Play the phone’s sound on the computer', page: 'audio', dir: 'p2c', k: 'phone audio on pc, mobile sound on computer, share phone audio, music from phone, speakers' },
  { t: 'Hear one computer on the other', page: 'audio', on: 'desk', k: 'share audio, computer sound, other computer, pc to mac, mac to pc' },
  { t: 'Use the phone as a microphone', page: 'audio', dir: 'p2c', k: 'phone mic on pc, share mic, microphone, voice, talk, call' },
  { t: 'Switch the computer’s sound output', page: 'deck', k: 'audio output, speakers, headphones, change output, default device' },
  // Screens
  { t: 'See the phone’s screen on the computer', page: 'mirror', dir: 'p2c', k: 'mirror phone, phone screen on pc, cast phone, share phone screen, scrcpy, control phone' },
  { t: 'Open phone apps on the computer', page: 'phoneapps', dir: 'p2c', k: 'phone apps on pc, android apps, run app, window' },
  { t: 'See the computer’s screen on the phone', page: 'viewpc', dir: 'c2p', k: 'view pc, remote desktop, computer screen on phone, control computer, vnc, share screen' },
  { t: 'Use this computer as a second screen', page: 'sharescreen', on: 'desk', k: 'share screen, extend display, second monitor, extra display, see my screen on other computer' },
  { t: 'See the other computer’s screen here', page: 'receivescreen', on: 'desk', k: 'receive screen, view other computer, remote desktop, window' },
  { t: 'Apps from the other computer', page: 'apps', on: 'desk', k: 'open app, other computer apps, window, run app remotely' },
  // Input
  { t: 'One mouse and keyboard for both computers', page: 'cursor', on: 'desk', k: 'share mouse, cursor, pointer, move between computers, edges, kvm, synergy, barrier' },
  { t: 'Type on the other computer', page: 'keyboard', k: 'keyboard, type, typing, keys, layout' },
  { t: 'Use the phone as a touchpad', page: 'remote', dir: 'p2c', k: 'phone as mouse, trackpad, touchpad, remote control, pointer, air mouse' },
  { t: 'Air mouse', page: 'remote', dir: 'p2c', k: 'gyro, point phone, motion, wave, laser, pointer' },
  { t: 'Present slides', page: 'remote', dir: 'p2c', k: 'presentation, slides, powerpoint, keynote, clicker, laser pointer, next slide' },
  { t: 'Gamepad', page: 'remote', dir: 'p2c', k: 'game controller, joystick, play games, xbox' },
  { t: 'Deck: buttons on the phone for the computer', page: 'deck', dir: 'p2c', k: 'stream deck, macro, shortcuts, buttons, tiles, launcher, hotkeys' },
  { t: 'Open the Deck', page: 'deck', on: 'android ios', k: 'deck full screen, stream deck, buttons' },
  { t: 'Snap windows from the phone', page: 'deck', dir: 'p2c', k: 'window layout, tile windows, arrange windows, split screen, snap' },
  // Sharing
  { t: 'Shared clipboard', page: 'clipboard', k: 'copy paste, copy on phone paste on pc, universal clipboard, clipboard sync' },
  { t: 'Clipboard history', page: 'clipboard', k: 'copied before, recent copies, paste history, past clips' },
  { t: 'Keep history, encrypted', page: 'clipboard', k: 'save clipboard history, save notifications history, remember, keep, encrypted, restart' },
  { t: 'Phone notifications on the computer', page: 'notifications', dir: 'p2c', k: 'notifications on pc, alerts, mirror notifications, messages on computer' },
  { t: 'Computer notifications on the phone', page: 'notifications', dir: 'c2p', k: 'pc notifications on phone, alerts' },
  { t: 'Notification history', page: 'notifications', k: 'past notifications, missed, old alerts, history' },
  { t: 'Send files', page: 'files', k: 'send file, transfer, share file, airdrop, drag and drop, upload, photos to pc' },
  { t: 'Received files', page: 'files', k: 'downloads, where are files, received folder, save to' },
  { t: 'Browse the phone’s storage', page: 'phonefiles', dir: 'p2c', k: 'phone files, file manager, storage, copy from phone, sd card' },
  { t: 'The phone as a drive', page: 'mount', dir: 'p2c', k: 'mount phone, finder, explorer, drive, disk' },
  { t: 'Phone photos on the computer', page: 'photos', dir: 'p2c', k: 'gallery, pictures, videos, copy photos' },
  { t: 'Use the phone as a webcam', page: 'camera', dir: 'p2c', k: 'phone camera on pc, webcam, video call, zoom, share camera, virtual camera' },
  { t: 'Use the computer’s camera on the phone', page: 'camera', dir: 'c2p', k: 'pc camera on phone, webcam' },
  { t: 'Calls on the computer', page: 'calls', dir: 'p2c', k: 'answer calls on pc, phone calls, dial, ringing' },
  { t: 'Text messages on the computer', page: 'messages', dir: 'p2c', k: 'sms, texts, whatsapp, chat, send message' },
  { t: 'What’s playing on the computer', page: 'nowplaying', dir: 'c2p', k: 'media controls, play pause, music, spotify, volume, next track' },
  { t: 'Pick up where you left off', page: 'rezume', k: 'rezume, continue, handoff, resume, tabs, documents' },
  { t: 'A shell on the other computer', page: 'terminal', on: 'desk', k: 'terminal, ssh, command line, shell, console' },
  { t: 'Several devices at once', page: 'multi', on: 'desk', k: 'multi device, mesh, three computers, many phones' },
  { t: 'TwinDesk Web for any browser', page: 'web', on: 'desk', k: 'iphone browser, ipad, web client, no app' },
  { t: 'AirPlay to this computer', page: 'airplay', k: 'airplay receiver, cast, smb, files app, iphone' },
  { t: 'Shortcuts on the Overview', page: 'overview', k: 'quick actions, tiles, home buttons, add shortcut, rows' },
  { t: 'Shortcuts app actions', page: 'shortcuts', on: 'ios', k: 'siri, automation, shortcuts app' },
  // Connection
  { t: 'Pair a device', page: 'connection', k: 'pair, connect, add phone, add computer, qr code, link, setup' },
  { t: 'Connect over Bluetooth or Wi-Fi Direct', page: 'connection', k: 'no wifi, offline, bluetooth, wifi direct, hotspot, cable, usb' },
  { t: 'Wake the other computer', page: 'overview', k: 'wake on lan, turn on, sleep, power' },
  { t: 'Ring the phone', page: 'overview', on: 'desk', k: 'find my phone, lost phone, ring, locate' },
  { t: 'Lock or sleep the computer', page: 'overview', k: 'lock screen, sleep, shut down, restart, power' },
  // General
  { t: 'Language', page: 'general', k: 'language, translate, english, russian, turkish, chinese, portuguese' },
  { t: 'Dark mode', page: 'general', k: 'theme, appearance, light, dark, look' },
  { t: 'Accent colour', page: 'general', k: 'color, accent, tint, look, appearance' },
  { t: 'Glass or simple look', page: 'general', on: 'desk', k: 'style, glass, transparency, blur, appearance' },
  { t: 'Arrange the pages', page: 'general', k: 'sidebar order, bottom bar, reorder, customize tabs, arrange, move tabs' },
  { t: 'Modules: turn pages off', page: 'general', k: 'modules, hide pages, disable features, lighter' },
  { t: 'Tour of TwinDesk', page: 'general', on: 'desk', k: 'tutorial, tour, guide, help, getting started, introduction, how to use, what is new, whats new, new features, changelog' },
  { t: 'Open at login', page: 'general', on: 'desk', k: 'startup, launch at login, autostart, boot' },
  { t: 'Run in the background', page: 'general', on: 'android', k: 'background, battery, stay connected, keep running' },
  { t: 'Battery and performance', page: 'general', k: 'battery saver, power, prioritize performance, ping, idle' },
  { t: 'Permissions', page: 'general', k: 'allow, access, privacy, accessibility, screen recording, permission' },
  { t: 'Device name', page: 'general', k: 'rename, name, computer name, phone name' },
  { t: 'Software update', page: 'about', k: 'update, new version, upgrade, release, download' },
  { t: 'Help and feedback', page: 'about', k: 'report bug, support, github, issue, contact, version' },
];

// Words that mean the same here, to one word each.
const SYN = {
  pc: 'computer', laptop: 'computer', desktop: 'computer', mac: 'computer', macbook: 'computer', linux: 'computer', computers: 'computer',
  mobile: 'phone', android: 'phone', iphone: 'phone', cell: 'phone', smartphone: 'phone', tablet: 'phone', ipad: 'phone', phones: 'phone',
  sound: 'audio', music: 'audio', speaker: 'audio', speakers: 'audio', volume: 'audio', hear: 'audio', listen: 'audio',
  mic: 'microphone', microphones: 'microphone',
  cam: 'camera', webcam: 'camera',
  display: 'screen', monitor: 'screen', screens: 'screen',
  mirror: 'mirror', mirroring: 'mirror', cast: 'mirror', casting: 'mirror',
  send: 'share', sharing: 'share', stream: 'share', streaming: 'share', transfer: 'share', sync: 'share', shared: 'share',
  copy: 'clipboard', paste: 'clipboard', copied: 'clipboard', clip: 'clipboard', clips: 'clipboard',
  notification: 'notifications', notif: 'notifications', notifs: 'notifications', alert: 'notifications', alerts: 'notifications',
  file: 'files', document: 'files', documents: 'files', folder: 'files',
  mouse: 'pointer', cursor: 'pointer', trackpad: 'pointer', touchpad: 'pointer',
  sms: 'messages', text: 'messages', texts: 'messages', message: 'messages',
  photo: 'photos', picture: 'photos', pictures: 'photos', image: 'photos', images: 'photos', gallery: 'photos',
  colour: 'color', theme: 'look', appearance: 'look',
  settings: 'setting', options: 'setting', preferences: 'setting',
};
const STOP = new Set('the a an to on onto my this that of for from in into with and or how i me do can want is it its use using make set turn get my your here there what where which be at as by'.split(' '));
const TO = new Set(['to', 'on', 'onto', 'into', 'at']);
const DEV = { computer: 'c', phone: 'p' };
// Words nearly every entry has: they count for less.
const LIGHT = new Set(['share', 'computer', 'phone', 'see', 'open', 'play', 'other']);

// Words: lower case, letters and digits (any script), one word for synonyms, a plural's s gone.
// tokens: [{raw, w}], the word as written and as matched.
function tokens(s, keepStop = false) {
  const out = [];
  for (const raw of String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    if (!keepStop && STOP.has(raw)) continue;
    let w = SYN[raw] || raw;
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    out.push({ raw, w: SYN[w] || w });
  }
  return out;
}
const words = (s, keepStop = false) => tokens(s, keepStop).map((x) => x.w);

// Which way the query goes: 'c2p' "pc audio to phone", 'p2c' "phone audio on pc", or ''.
function direction(q) {
  const ws = words(q, true);
  const devs = [];
  ws.forEach((w, i) => { if (DEV[w]) devs.push({ d: DEV[w], to: i > 0 && TO.has(ws[i - 1]) }); });
  if (!devs.length) return '';
  if (devs.length === 1) return devs[0].to ? (devs[0].d === 'p' ? 'c2p' : 'p2c') : (devs[0].d === 'p' ? 'p2c' : 'c2p');
  const a = devs[0].d, b = devs.find((x) => x.d !== a);
  if (!b) return '';
  return a === 'c' ? 'c2p' : 'p2c';
}

// The entries for a query, best first: each word found (a word that starts one, less), all words
// needed but one in a long query; the way it goes counts too.
function match(q, entries, title = (e) => e.t) {
  const qt = tokens(q).filter((x, i, a) => a.findIndex((y) => y.w === x.w) === i);
  const qs = qt.map((x) => x.w);
  if (!qs.length) return [];
  const dir = direction(q);
  const out = [];
  entries.forEach((e, i) => {
    const tk = [...tokens(e.t), ...tokens(e.k), ...tokens(title(e)), ...tokens(e.pageTitle || '')];
    const bag = new Set(tk.map((x) => x.w));
    const all = [...bag, ...tk.map((x) => x.raw)];
    let s = 0;
    let most = 0;
    for (const { w, raw } of qt) {
      const wt = LIGHT.has(w) ? 0.4 : 1;
      most += wt;
      if (bag.has(w)) s += wt;
      else if (raw.length >= 2 && all.some((x) => x.startsWith(raw) || x.startsWith(w))) s += 0.7 * wt;
      else if (w.length >= 4 && all.some((x) => x.length >= 4 && w.startsWith(x))) s += 0.5 * wt;
    }
    let score = s / most;
    if (score < (qs.length >= 3 ? 0.6 : 0.5)) return;
    if (dir && e.dir) score += e.dir === dir ? 0.3 : -0.3;
    if (words(title(e)).join(' ').startsWith(qs.join(' '))) score += 0.2;
    out.push({ e, score, i });
  });
  return out.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.e);
}

// The entries for one app: 'mac', 'windows', 'linux', 'android', 'ios', each with its page id.
function forApp(app) {
  const desk = ['mac', 'windows', 'linux'].includes(app);
  const key = desk ? 'desk' : app;
  return ENTRIES.flatMap((e) => {
    if (e.on && !e.on.split(' ').includes(key)) return [];
    const p = PAGES[e.page] || {};
    const id = desk ? (app === 'mac' ? p.mac : p.win) || p.desk : p[app];
    return id ? [{ ...e, id }] : [];
  });
}

const API = { tokens, PAGES, ENTRIES, SYN, STOP: [...STOP], TO: [...TO], LIGHT: [...LIGHT], words, direction, match, forApp };
if (typeof module === 'object' && module.exports) module.exports = API;
else window.TDSearch = API;
})();

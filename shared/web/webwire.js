// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Web on a computer (Mac, Windows, Linux): makes the hub (shared/web/webhub.js) with this
// computer's pieces, starts and stops it with settings.web.on, and gives the window its actions
// (the TwinDesk Web tab, AirPlay & SMB, and each web device's own pages in the sidebar).
//
// startWeb(o): o.dir (userData), o.root (the app's folder: web/, shared/, android assets), o.settings(),
//   o.save(), o.pushState(), o.self() → {id, name, os, version}, o.receivedDir(), o.say(title, body, onClick),
//   o.reveal(path), o.open(path), o.capture {audio, hub, source, worklet} for shared/web/webcap.js,
//   o.extend → {can(), display(dev) → Promise<Display|null>, release()} (a screen of its own: Extend) or null,
//   o.input(bus, target) (the viewer's in.* onto this computer, aimed at target() → {bounds}),
//   o.remote(bus, cfg) → shared/phone-remote.js (the Remote page's touchpad, keyboard and gamepad),
//   o.notifs (want(on), 'notif'), o.devLocal (shared/devlocal.js), o.smbInfo() → {on, host, share, user,
//   password, path} | null, o.key(code) (a media key), o.vcam() (the virtual camera loaded: the web
//   camera's picture shows), o.fileClip {offerLocal(paths, from)} (the file-paste shortcut), o.t (i18n),
//   o.share → {view() → {on, busy, error, folder, name, user}, set(on), choose(folder)} (AirPlay & SMB's
//   shared folder; pcShare(smb) makes it, and smbInfo, from windows/smb.js or linux/smb.js).
// Returns {hub, view(), actions}: actions are the window's ipc calls (all named web*).
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { WebHub } = require('./webhub.js');
const { WebCap } = require('./webcap.js');
const { WebRecv } = require('./webrecv.js');
const { PcMedia } = require('./pcmedia.js');

const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const WEB_KEYS = { on: 'bool', screen: 'bool', control: 'bool', camera: 'bool', mic: 'bool', port: 'port' };

function firstThere(list) {
  return list.find((p) => p && fs.existsSync(p)) || list[0];
}

function startWeb(o) {
  const cfg = () => o.settings().web;
  const t = o.t || ((s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (v && k in v ? String(v[k]) : m)));
  // The page (web/) and the phone app's viewer and remote (android/…/assets/web): beside shared/ in a
  // checkout; in a build, copied next to it (build scripts).
  const webRoot = firstThere([path.join(o.root, 'web')]);
  const tdRoot = firstThere([path.join(o.root, 'android-web'), path.join(o.root, 'android', 'app', 'src', 'main', 'assets', 'web')]);

  const displaysList = () => {
    try {
      const { screen } = require('electron');
      const main = screen.getPrimaryDisplay().id;
      return screen.getAllDisplays().map((d, i) => ({ id: String(d.id), label: d.label || (d.id === main ? t('Main display') : t('Display {n}', { n: i + 1 })), w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor), main: d.id === main }));
    } catch (_) { return []; }
  };
  let target = null; // the display the web device watches: its input lands there
  const capture = new WebCap({
    audio: o.capture.audio, hub: o.capture.hub || null, source: o.capture.source || null, worklet: o.capture.worklet ? pathToFileURL(o.capture.worklet).href : '',
    display: async (mode, dev) => {
      const { screen } = require('electron');
      let d = null;
      if (mode === 'extend' && o.extend) d = await o.extend.display(dev);
      // Mirror: the display picked for it on its Share screen page, else the main one.
      const pick = dev && dev.id && hub.devices.find((x) => x.id === dev.id);
      const want = pick && hub.allow(pick).display;
      if (!d && want) d = screen.getAllDisplays().find((x) => String(x.id) === want) || null;
      d = d || screen.getPrimaryDisplay();
      target = d;
      return d;
    },
    release: (mode) => {
      target = null;
      if (mode === 'extend' && o.extend) o.extend.release();
    },
  });
  const camRecv = new WebRecv({
    allowed: (kind) => {
      if (kind === 'cam' && cfg().camera === false) return t('Camera is off for web devices on {name}', { name: o.self().name });
      if (kind === 'mic' && cfg().mic === false) return t('Microphone is off for web devices on {name}', { name: o.self().name });
      if (kind === 'cam' && o.vcam) { try { o.vcam(); } catch (_) {} }
      return '';
    },
  });
  const media = o.key ? new PcMedia({ key: o.key }) : null;

  let lastFiles = null; // the last batch from a web device, for the notification's click
  const hub = new WebHub({
    dir: path.join(o.dir, 'web'), webRoot, tdRoot, self: o.self, getCfg: cfg,
    clipboard: { readText: () => require('electron').clipboard.readText(), writeText: (x) => require('electron').clipboard.writeText(x) },
    receivedDir: o.receivedDir,
    onReceived: (paths, dev) => {
      lastFiles = paths;
      if (o.fileClip) { try { o.fileClip.offerLocal(paths, dev.name); } catch (e) { console.warn('[web] paste:', e.message); } }
      const name = path.basename(paths[0]);
      o.say(t('From {name}', { name: dev.name }), o.fileClip ? t('{file} · paste it with the Paste Files shortcut', { file: name }) : name, () => lastFiles && o.reveal(lastFiles[0]));
    },
    say: (title, body) => o.say(title, body),
    capture, camRecv, notifSource: o.notifs || null, devLocal: o.devLocal || null,
    smbInfo: o.smbInfo || null, media, extendable: () => !!(o.extend && o.extend.can()),
  });
  fs.mkdirSync(hub.dir, { recursive: true });

  // The viewer's mouse, keyboard and pen; the Remote page's touchpad, keyboard and gamepad.
  if (o.input) o.input(hub.inBus, () => target);
  let remote = null;
  if (o.remote) {
    const rcfg = {
      get remote() { return { allow: cfg().control !== false, pad: cfg().pad === true }; },
      set remote(v) { cfg().control = v.allow !== false; cfg().pad = v.pad === true; o.save(); },
    };
    remote = o.remote(hub.remoteBus, () => rcfg);
  }

  let pushed = 0;
  hub.on('change', () => {
    if (media) media.active(hub.running && hub.socks.size > 0);
    // A device's chat or clipboard changes often: the window hears at most 5 times a second.
    const now = Date.now();
    if (now - pushed > 200) { pushed = now; o.pushState(); } else setTimeout(o.pushState, 220);
  });

  const apply = () => (cfg().on ? hub.start() : hub.stop());
  apply();

  const dev = (id) => hub.devices.find((d) => d.id === id);
  const actions = {
    webSet(partial) {
      const c = cfg();
      const was = { on: !!c.on, port: c.port };
      for (const [k, v] of Object.entries(partial || {})) {
        if (WEB_KEYS[k] === 'bool') c[k] = !!v;
        else if (WEB_KEYS[k] === 'port') { const p = Math.round(Number(v)); if (p >= 1024 && p < 65000) c.port = p; }
      }
      o.save();
      if (was.port !== c.port && hub.running) hub.stop();
      if (was.on !== !!c.on || !hub.running) apply();
      o.pushState();
    },
    webNewCode() { hub.newCode(); },
    webAllow(a) { if (a && dev(a.id)) { const { id, ...rest } = a; hub.setAllow(id, rest); } },
    async webChooseFolder(id) {
      if (!dev(id)) return;
      const { dialog } = require('electron');
      const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], buttonLabel: t('Choose') });
      if (!r.canceled && r.filePaths[0]) hub.setAllow(id, { folder: r.filePaths[0] });
    },
    webForget(id) { hub.forget(str(id, 64)); },
    webDisconnect(id) { if (dev(id)) hub.disconnect(id); },
    webRename(a) { if (a && dev(a.id)) hub.rename(a.id, a.name); },
    webSendText(a) { if (a && dev(a.id) && str(a.text, 20000).trim()) hub.sendText(a.id, str(a.text, 20000)); },
    webSendFiles(a) {
      if (!a || !dev(a.id) || !Array.isArray(a.paths)) return;
      const paths = a.paths.filter((p) => typeof p === 'string' && fs.existsSync(p) && fs.statSync(p).isFile()).slice(0, 100);
      if (paths.length) hub.sendFiles(a.id, paths, a.kind === 'drop' ? 'drop' : 'files');
    },
    // id, or {id, kind: 'drop'|'files'}
    async webChooseFiles(a) {
      const id = typeof a === 'string' ? a : a && a.id;
      if (!dev(id)) return;
      const { dialog } = require('electron');
      const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], buttonLabel: t('Send') });
      if (!r.canceled && r.filePaths.length) actions.webSendFiles({ id, paths: r.filePaths, kind: a && a.kind });
    },
    // A Drop file kept by TwinDesk, saved where the user picks.
    async webSaveItem(a) {
      const item = a && dev(a.id) && hub._chat(a.id).find((x) => x.id === a.item && x.file);
      if (!item || !item.file.path || !fs.existsSync(item.file.path)) return false;
      const { dialog } = require('electron');
      const r = await dialog.showSaveDialog({ defaultPath: path.join(o.receivedDir(), item.file.name), buttonLabel: t('Save') });
      if (r.canceled || !r.filePath) return false;
      try { await fs.promises.copyFile(item.file.path, r.filePath); } catch (_) { return false; }
      o.reveal(r.filePath);
      return true;
    },
    webDeleteItem(a) { if (a && dev(a.id)) hub.deleteItem(a.id, str(a.item, 64)); },
    webClearChat(id) { if (dev(id)) hub.clearChat(id); },
    webStopScreen(id) { hub.stopScreen(str(id, 64) || null); },
    webStopCam(a) {
      if (!a) return;
      if (['cam', 'mic', 'scr'].includes(a.kind)) { if (camRecv.state[a.kind].dev === a.id) camRecv._stop(a.kind); } else camRecv.stopDevice(a.id);
      hub._send(a.id, { t: `${a.kind || 'cam'}.state`, status: 'off', why: t('Stopped on {name}', { name: o.self().name }) });
    },
    webOpenItem(a) {
      const item = a && dev(a.id) && hub._chat(a.id).find((x) => x.id === a.item && x.file);
      if (!item || !item.file.path || !fs.existsSync(item.file.path)) return;
      if (a.reveal) o.reveal(item.file.path);
      else o.open(item.file.path);
    },
    webShareSet(on) { if (o.share) o.share.set(on === true); },
    async webShareFolder() {
      if (!o.share) return;
      const { dialog } = require('electron');
      const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], buttonLabel: t('Share This Folder') });
      if (!r.canceled && r.filePaths[0]) await o.share.choose(r.filePaths[0]);
    },
    webCopy(text) { if (typeof text === 'string') require('electron').clipboard.writeText(text.slice(0, 1 << 20)); },
  };

  return {
    hub, actions, camRecv, capture,
    view() {
      const v = hub.view();
      const c = cfg();
      return { ...v, cfg: { on: !!c.on, port: hub.port, screen: c.screen !== false, control: c.control !== false, camera: c.camera !== false, mic: c.mic !== false }, extend: !!(o.extend && o.extend.can()), displays: displaysList(), media: media ? media.state() : null, remote: remote ? remote.view : null, share: o.share ? o.share.view() : null };
    },
    shutdown() { try { hub.stop(); } catch (_) {} },
  };
}

// AirPlay & SMB on a PC or Linux computer: its shared folder (windows/smb.js, linux/smb.js, the same
// one the other computer connects to), and the sign-in a web device's Mount page shows.
function pcShare(smb, host) {
  const share = {
    view() {
      const v = smb.view();
      return { on: !!v.sharing, busy: v.busy === 'setup' || v.busy === 'remove' ? v.busy : '', error: v.message || '', folder: v.folder, name: 'MacShare', user: 'macshare' };
    },
    set: (on) => smb.setShareOn(on),
    choose: (folder) => smb.chooseFolder(folder),
  };
  const smbInfo = () => {
    const c = smb.cfg.shareOn && smb._creds();
    if (!c || !c.password) return { on: false };
    const h = host();
    return { on: true, host: h, share: 'MacShare', user: c.user || 'macshare', password: c.password, path: smb.view().folder, url: `smb://${h}/MacShare` };
  };
  return { share, smbInfo };
}

module.exports = { startWeb, pcShare };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Main-window actions (preload-app.js → here; copy of windows/ipc.js). Every value is validated by
// settings.apply().
const { app, ipcMain, dialog, shell, BrowserWindow, clipboard } = require('electron');
const path = require('path');
const P = require('../shared/protocol.js');
const { LINKS } = require('../shared/about.js');
const { apply } = require('./settings');

// ctx: link, discovery, screen, clip, kvm, fileDrop, smb, fileClip, vdd, sound, pcScreen, notifs, wake, terminal,
//      sshd, apps, pcApps, peerApps, phone, phoneViews, connectPhoneDev(d), settings, save(), push(), buildState(), checkFirewall(), fixFirewall(), setStartup(on)
function setupIpc(ctx) {
  const { link, discovery, screen, clip, kvm, fileDrop, smb, fileClip, sound, pcScreen, notifs, wake, terminal, sshd, apps, pcApps, peerApps, settings } = ctx;

  const handle = (name, fn) => ipcMain.handle(name, (_e, ...args) => fn(...args));
  const change = (section, partial, after) => {
    if (!apply(settings, section, partial)) return;
    ctx.save();
    if (after) after();
    ctx.push();
  };

  handle('getState', () => ctx.buildState());

  const pairWith = (d) => {
    discovery.clearInvite(d.id);
    if (d.os === P.OS.ANDROID) return ctx.connectPhoneDev(d); // a phone has no server to pair with
    link.startPairing({ address: d.address, port: d.port, macName: d.name });
  };
  handle('pair', (target) => {
    if (typeof target !== 'string' || !target.trim()) return;
    const found = discovery.get(target);
    if (found) return pairWith(found);
    const m = /^\s*([^\s:]+)(?::(\d{1,5}))?\s*$/.exec(target);
    if (!m) return;
    const port = m[2] ? Number(m[2]) : P.PORT;
    if (port < 1 || port > 65535) return;
    link.startPairing({ address: m[1], port, macName: m[1] });
  });
  // Connect by address: ask who is there (unicast probe works where broadcast is blocked); no
  // answer in PROBE_REPLY_MS → try WSS on that address directly ("No TwinDesk at …" if nothing).
  handle('connectAddress', async (text) => {
    const m = typeof text === 'string' && /^\s*([^\s:]+)(?::(\d{1,5}))?\s*$/.exec(text);
    if (!m) return;
    const d = m[2] ? null : await discovery.ask(m[1]);
    if (d) return pairWith(d);
    const port = m[2] ? Number(m[2]) : P.PORT;
    if (port >= 1 && port <= 65535) link.startPairing({ address: m[1], port, macName: m[1] });
  });
  handle('refreshFound', () => discovery.probe());
  handle('copyText', (text) => typeof text === 'string' && text.length < 1000 && clipboard.writeText(text));
  handle('confirmCode', () => link.confirmCode());
  handle('cancelPair', () => link.cancelPair());
  handle('forget', () => link.forget());
  handle('respondPair', (allow) => link.respondPair(allow === true)); // host: Allow / Deny
  handle('forgetGuest', (id) => typeof id === 'string' && link.forgetGuest(id));
  handle('wakePeer', (id) => typeof id === 'string' && wake.wake(id));
  handle('setWake', (on) => wake.set(on === true)); // A switch
  handle('checkWake', () => wake.check());
  handle('openMonitor', () => screen.open(false));
  handle('remoteScreen', (arg) => arg && typeof arg === 'object' && screen.control({ share: arg.share, mode: arg.mode })); // screen.ctl

  handle('setKvm', (partial) => {
    if (partial && typeof partial.linked === 'boolean') kvm.setLinked(partial.linked); // home first, tells the other side
    const { linked, ...rest } = partial && typeof partial === 'object' ? partial : {};
    change('kvm', rest, () => kvm.applyConfig());
  });
  handle('setLayout', (side) => kvm.setLayout(side));
  handle('setKeys', (partial) => change('keys', partial, () => kvm.applyConfig())); // the hotkey lives in the helper
  handle('setApp', (partial) => change('app', partial, () => ctx.onApp && ctx.onApp()));
  handle('setUpdates', (partial) => {
    const p = partial && typeof partial === 'object' ? partial : {};
    const next = {};
    if ('auto' in p) next.auto = !!p.auto;
    if (p.channel === 'beta' || p.channel === 'stable') next.channel = p.channel;
    if (p.install === 'auto' || p.install === 'ask') next.install = p.install;
    change('updates', next, () => { ctx.updates.start(); if ('channel' in next) ctx.updates.check(true); });
  });
  handle('installUpdate', () => ctx.updates.install().catch(() => {}));
  handle('checkUpdates', () => ctx.updates.check(true));
  handle('openUpdate', () => ctx.updates.open());
  handle('openLink', (key) => Object.hasOwn(LINKS, key) && shell.openExternal(LINKS[key])); // About page: only its own links
  handle('setMonitor', (partial) => change('monitor', partial, () => screen.applyAudio()));
  handle('setClipboard', (partial) => change('clipboard', partial, () => clip.applySettings()));
  handle('copyHistory', (index) => clip.copyHistory(Number(index)));
  handle('clearHistory', () => clip.clearHistory());
  handle('setTab', (tab) => change('ui', { tab })); // invalid names fall back in normalize()
  handle('setAudio', (partial) => change('audio', partial, () => sound.apply()));
  handle('setTerminal', (partial) => {
    const p = partial && typeof partial === 'object' ? { enabled: partial.enabled, allowMac: partial.allowMac } : {};
    Object.keys(p).forEach((k) => p[k] === undefined && delete p[k]);
    change('terminal', p, () => { terminal.apply(); sshd.apply(); });
  });
  handle('setupSshd', () => sshd.setup());
  handle('openTerminal', () => terminal.open());
  // Apps: a Mac sends its own (apps.js, through its screen stream); a PC or Linux computer through peerapps.js.
  const macPeer = () => link.peerOs === P.OS.MAC;
  handle('listApps', () => (macPeer() ? apps.refresh() : peerApps.refresh()));
  handle('launchApp', (id) => { if (!macPeer()) peerApps.launch(id); else { apps.launch(id); screen.ensureHidden(); } });
  handle('pinApp', (id) => typeof id === 'string' && macPeer() && apps.pin(id, true)); // a launcher in the app menu
  handle('setMacApps', (partial) => change('macApps', partial, () => peerApps.apply()));
  handle('setPcApps', (partial) => change('pcApps', partial, () => { pcApps.apply(); pcApps.input.release(); }));
  handle('setFiles', (partial) => {
    // shareOn/shareFolder only change through share()/unshare()
    const p = partial && typeof partial === 'object' ? { dropToMac: partial.dropToMac, mountMac: partial.mountMac, acceptFromMac: partial.acceptFromMac, edgeDrag: partial.edgeDrag,
      shortcuts: partial.shortcuts, copyKeys: partial.copyKeys, pasteKeys: partial.pasteKeys } : {};
    Object.keys(p).forEach((k) => p[k] === undefined && delete p[k]);
    change('files', p, () => { smb.applyMount(); kvm.applyConfig(); fileClip.apply(); });
  });
  handle('setShareOn', (on) => smb.setShareOn(on === true));
  handle('chooseShareFolder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const r = await dialog.showOpenDialog(win, { title: 'Folder to share with the other computer', properties: ['openDirectory', 'createDirectory'] });
    if (!r.canceled && r.filePaths[0]) await smb.chooseFolder(r.filePaths[0]);
  });
  handle('removeShare', () => smb.unshare());
  handle('openMacDrive', () => smb.open());
  // Send files (paths from the drop zone or Choose…), notifications.
  const sendFiles = (paths) => {
    const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && path.isAbsolute(p)).slice(0, 1000);
    if (list.length) fileDrop.sendBatch(list, 'send');
  };
  handle('sendFiles', sendFiles);
  handle('chooseSendFiles', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const r = await dialog.showOpenDialog(win, { title: 'Send files', buttonLabel: 'Send', properties: ['openFile', 'multiSelections'] });
    if (!r.canceled) sendFiles(r.filePaths);
  });
  handle('setNotifs', (partial) => {
    const p = partial && typeof partial === 'object' ? { send: partial.send, receive: partial.receive, hideText: partial.hideText } : {};
    Object.keys(p).forEach((k) => p[k] === undefined && delete p[k]);
    change('notifs', p, () => notifs.applySettings());
  });
  handle('muteNotifApp', (arg) => arg && typeof arg.app === 'string' && notifs.setMuted(arg.app.slice(0, 300), arg.muted === true));
  handle('cancelDrop', () => fileDrop.cancel());
  handle('setPcScreen', (partial) => {
    const size = settings.pcScreen.extendSize;
    change('pcScreen', partial, () => { pcScreen.applyInput(); if (!settings.pcScreen.input) pcApps.input.release(); if (settings.pcScreen.extendSize !== size) pcScreen.sizeExtend(); else pcScreen.apply(); });
  });
  handle('setPcScreenMode', (mode) => pcScreen.setMode(mode));
  // A phone as the peer (phone.js, phone-bridge.js, phoneview.js; there once our server runs)
  const phone = (name, fn) => handle(name, (...args) => (ctx.phone ? fn(...args) : undefined));
  phone('connectPhone', (id) => ctx.phone.connect(String(id)));
  phone('disconnectPhone', () => ctx.phone.disconnect());
  handle('setPhone', (partial) => change('phone', partial));
  phone('phonePair', (arg) => arg && typeof arg === 'object' && ctx.phone.bridge.pair(arg.code, arg.where));
  phone('phoneScreen', (open) => {
    if (open === false) {
      for (const v of ctx.phoneViews.list()) if (v.kind === 'screen') ctx.phoneViews.close(v.id);
    } else ctx.phoneViews.openScreen();
  });
  phone('phoneOpenApp', (arg) => arg && typeof arg.id === 'string' && ctx.phoneViews.openApp(arg.id.slice(0, 200), String(arg.name || '').slice(0, 100)));
  phone('phoneCloseView', (id) => ctx.phoneViews.close(Number(id)));
  phone('phoneRetry', () => ctx.phone.bridge._kick());
  handle('phoneAssets', () => (ctx.phone ? ctx.phone.assetsView() : { wallpaper: '', apps: [] }));
  handle('skipSetup', () => change('setup', { skipped: ctx.buildState().setup.missing, done: true }));
  handle('checkFirewall', () => ctx.checkFirewall());
  handle('fixFirewall', () => ctx.fixFirewall());
  handle('fixInput', () => ctx.fixInput()); // Wayland: uinput rule + input group (L6)
  handle('installVdd', () => ctx.vdd.install()); // X11 Extend: the connector helper (vdd.js)
  handle('removeVdd', () => ctx.vdd.remove());
  handle('setStartup', (on) => ctx.setStartup(on === true));
  handle('quit', () => app.quit()); // General › Quit (some desktops have no tray)

  // pairsync.js applies a value the other computer changed, with the same side effects.
  const AFTER = {
    clipboard: () => clip.applySettings(),
    monitor: () => screen.applyAudio(), // pacing (pair.sync 'pace')
    notifs: () => notifs.applySettings(),
    audio: () => sound.apply(),
    kvm: () => kvm.applyConfig(),
    pcApps: () => { pcApps.apply(); pcApps.input.release(); },
    macApps: () => peerApps.apply(),
  };
  return { set: (section, partial) => change(section, partial, AFTER[section]) };
}

module.exports = setupIpc;

// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Creates the helper-backed services and wires them together: display, stream, Monitor 2 input,
// clipboard, shared cursor/keyboard. Restarts the helper if it dies and keeps the display
// awake while a device is connected. The pooled features (clipboard, notifications) talk to the
// mesh through the hub's bus (docs/mesh.md); the one-to-one features get `server` (peer.js).
'use strict';

const { powerSaveBlocker } = require('electron');
const { Helper } = require('./helper'); // Multi-device's helper (several watched edges), else the one-to-one one
const { Displays } = require('./displays');
const { Stream } = require('./stream');
const { StreamSet } = require('./streams');
const { Input } = require('../input');
const { SpaceSwitch, SpaceLook, DesktopRefresh } = require('../space-switch');
const Spaces = require('../../shared/mac-spaces.js');
const { Clip } = require('./clipboard');
const { Kvm } = require('./kvm');
const { Terminal } = require('../terminal');
const { Drop } = require('../drop');
const { Smb } = require('../smb');
const { SmbSet } = require('./smbset');
const { Apps } = require('../apps');
const { SshClient } = require('../ssh-client');
const { AudioHub } = require('../audiohub');
const { Audio } = require('../audio');
const { FileSend } = require('../filesend');
const { PcView } = require('../pcview');
const { PcApps } = require('../pcapps');
const { Notifs } = require('./notifs');
const { FileClip } = require('../fclip');
const MeshFileClip = require('../../shared/fclip-mesh.js').meshFileClip(FileClip, { mac: true });
const { DropSet } = require('./dropset');
const { SendSet } = require('./sendset');
const { Wake } = require('../wake');
const { AppSend } = require('../appsend');
const { Peer } = require('./peer');
const { AudioSet } = require('./audioset');
const store = require('./store');
const P = require('../../shared/protocol.js');

// hub: the mesh hub (hub.js) for the pooled features; mesh: the shared/mesh.js registry; selfName():
// this Mac's name, sent with its notifications; consent: shared/consent.js, each device's own two-way switches.
function startServices({ server, getSettings, pushState, onHelperReady, hub: meshHub, mesh, layoutSync, selfName = () => '', consent = null }) {
  const s = getSettings;
  server.setMaxListeners(50); // one 'client'/'closed' listener per feature
  const helper = new Helper();
  const displays = new Displays(helper, s);
  const hub = new AudioHub(helper, s);
  const stream = new StreamSet({ hub: meshHub, server, displays, make: (peer) => new Stream(peer, displays, s, hub) }); // one Stream per connected device
  let kvm = null;
  // Stream input only when "Receive input" is on and shared input is home.
  const input = new Input(server, helper, displays, {
    enabled: () => s().streamInput !== false && (!kvm || kvm.mode === 'home'),
    // Every device watching this Mac's stream (its own Stream has a session), each with its own key swap.
    bus: meshHub.bus, takes: (id) => stream.watching(id),
    swapKeys: (id) => { const x = id && meshHub.sessions.get(id); return s().keys.swapCtrlCmd !== false && P.keySwapNeeded(P.OS.MAC, x && x.peerOs); }, // never between two Macs
  });
  // The pair a device's queued copies belong to (While away): the one its session authenticated now.
  const guestPair = (id) => meshHub.pairing?.paired.find((pair) => pair.id === id);
  const hostPair = (id) => meshHub.links.get(id)?.pairing;
  const clipboard = new Clip({
    bus: meshHub.bus, mesh, getSettings: s, helper, consent, session: (id) => meshHub.sessions.get(id),
    activePair: (id) => meshHub.sessions.get(id)?.linkUp ? hostPair(id) : guestPair(id),
    knownPair: (id, pair) => pair === guestPair(id) || pair === hostPair(id),
  });
  // Files from every device, each on its own peer: the computer driving this Mac isn't selected here (dropset.js).
  // A phone's Send to another computer of the mesh: taken here and passed on (shared/files-relay.js).
  let fileSend = null;
  const filesRelay = require('../../shared/files-relay.js').filesRelay({
    selfId: () => meshHub.device.id,
    isPhone: (pid) => { const x = meshHub.sessions.get(pid); return !!x && P.isPhoneOs(x.peerOs); },
    connected: (pid) => { const x = meshHub.sessions.get(pid); return !!x && x.connected; },
    sendTo: (pid, paths) => { const u = fileSend && fileSend.unit(pid); if (!u) return false; u.send(paths); return true; },
    nameOf: (pid) => { const x = meshHub.sessions.get(pid); return x ? x.displayName() : pid; },
  });
  const drop = new DropSet({
    hub: meshHub, server, make: (peer, id) => new Drop({ server: peer, helper, displays, getSettings: s, accepts: consent ? () => consent.get(id, 'files', 'in') : null, relayDir: (to, batch) => filesRelay.dir(id, to, batch) }),
    partner: () => (kvm && kvm.mode === 'driven' ? kvm.partner : null),
  });
  // Sending: a FileSend per device (sendset.js), so a crossing mid-send doesn't stop it.
  fileSend = new SendSet({
    hub: meshHub, server, FileSend, getSettings: s, outboxFile: require('path').join(require('electron').app.getPath('userData'), 'outbox.json'),
    partner: () => (kvm && kvm.mode === 'driving' ? kvm.partner : null),
  });
  // Each viewer's own picture, including one that is not the shared pointer's display.
  // The bus hears every device; a phone that is not the selected computer can still switch
  // the desktop on the display it is being shown.
  const spaces = new SpaceSwitch({
    listen: (fn) => meshHub.bus.on(P.T.SCREEN_SPACE, (msg, id, source) => fn(msg, { id, source })),
    helper,
    enabled: () => s().streamInput !== false && (!kvm || kvm.mode === 'home'),
    authorize: (ctx) => Spaces.meshGate(() => meshHub.sessions.get(ctx && ctx.id), Spaces.meshSource(meshHub.sessions.get(ctx && ctx.id), ctx && ctx.source)),
    targetFor: (ctx) => {
      const st = ctx && stream.byId.get(ctx.id);
      return st ? st.viewedDisplay() : null;
    },
    reply: (ctx, msg) => meshHub.bus.send(ctx.id, msg),
    names: () => Spaces.catalogOffer(displays.list(), { remote: s().sharing.remote !== false, held: displays.holds.has('apps-open'), mesh: true }).named,
    offerDisplays: () => false,
  });
  const spaceLook = new SpaceLook(helper, pushState);
  const desktopRefresh = new DesktopRefresh({
    listen: (fn) => meshHub.bus.on(P.T.SCREEN_DESKTOPS, (msg, id, source) => fn(msg, { id, source })),
    authorize: (ctx) => Spaces.meshGate(() => meshHub.sessions.get(ctx && ctx.id), Spaces.meshSource(meshHub.sessions.get(ctx && ctx.id), ctx && ctx.source)),
    viewFor: (ctx) => {
      const st = ctx && stream.byId.get(ctx.id);
      return st ? st.viewedDisplay() : null;
    },
    spaceLook,
    reply: (ctx, msg) => meshHub.bus.send(ctx.id, msg),
  });
  kvm = new Kvm({ hub: meshHub, layoutSync, helper, getSettings: s, clipboard, input, drop, fileSend });
  require('../../shared/applog.js').linkStats(() => kvm.linkSample()); // the link's line in the log every 30 s
  const terminal = new Terminal(server, s, { bus: meshHub.bus, consent }); // every device's key, by its own pair
  const smb = new SmbSet({ Smb, hub: meshHub, helper, getSettings: s, saveSettings: () => store.saveSettings(s()) }); // a folder per device, this Mac's to all (smbset.js)

  // This Mac's apps on another computer: their own route (as the camera's, shared/cam-mesh.js). While apps
  // are open for a computer it stays with it, so a crossing no longer gives back ReZume's windows, lets
  // the virtual display go and turns sharing off (the facade's 'closed'); a computer that isn't selected
  // can list and open them while they're free (its asks were dropped), and one that asks while they're in
  // use with another is told so; free again, it follows the selection.
  let appsRef = null;
  let appsFor = null; // the computer the apps were last asked for
  let appsAt = 0; // … when (its list is looked at before an app is opened)
  const APPS_ASKED_MS = 120000;
  const appsBusy = () => !!(appsRef && appsRef.launched.size);
  const appsServeRoute = meshHub.route((h) => {
    const at = appsFor ? h.sessions.get(appsFor) : null;
    if (at && at.connected && (appsBusy() || Date.now() - appsAt < APPS_ASKED_MS)) return appsFor;
    appsFor = null;
    return h.selectedId;
  });
  const nameOf = (pid) => { const x = pid && meshHub.sessions.get(pid); return x ? x.displayName() : 'another device'; };
  for (const t of [P.T.APPS_LIST, P.T.APP_LAUNCH]) meshHub.bus.on(t, (m, from) => { // before the route hears it
    if (from === appsServeRoute.targetId) { appsFor = from; appsAt = Date.now(); return; }
    if (appsBusy()) {
      const why = `in use with ${nameOf(appsServeRoute.targetId)}`;
      meshHub.bus.send(from, t === P.T.APPS_LIST ? { t: P.T.APPS_RESULT, apps: [], why } : { t: P.T.APP_LAUNCHED, id: String(m.id || ''), ok: false, why });
      return console.log(`[apps] ${nameOf(from)} asked for this Mac's apps: ${why}`);
    }
    appsFor = from;
    appsAt = Date.now();
    appsServeRoute.refresh();
  });
  const apps = new Apps({ server: new Peer(appsServeRoute, meshHub.server), helper, displays, stream, getSettings: s,
    allows: consent ? () => consent.get(appsServeRoute.targetId, 'apps', 'out') : null }); // the pair of the computer it serves
  appsRef = apps;
  apps.on('change', () => setImmediate(() => { if (!appsBusy()) appsServeRoute.refresh(); })); // free again: the selection (never inside a move)
  // Terminal, this Mac to another computer: one per computer (shared/papps-mesh.js), each with its own
  // alias, `ssh twindesk-<name>`, and its own pair's switch; `ssh twindesk` is the selected device's (#313).
  const SshConfig = require('../../shared/sshconfig.js');
  const sshClient = require('../../shared/papps-mesh.js').appsSet({
    selectedId: () => meshHub.selectedId, viewAs: 'getter', empty: { ready: false, why: null, user: null, alias: SshConfig.ALIAS },
    all: ['applySettings'], selected: ['openShell'],
  });
  const sshUnit = (pid) => {
    const x = meshHub.sessions.get(pid);
    if (!x || P.isPhoneOs(x.peerOs)) return;
    sshClient.ensure(pid, () => {
      const p = new (require('./phones').ScopedPhonePeer)(meshHub, meshHub.server, null);
      const u = new SshClient(p, s, {
        alias: SshConfig.aliasFor(x.displayName(), pid), isDefault: () => meshHub.selectedId === pid,
        enabled: () => (consent ? consent.get(pid, 'terminal', 'in') : !!s().terminal.connectPc),
      });
      p.bind(pid); // after it listens: its 'client' now
      return u;
    });
  };
  meshHub.bus.onPeer('welcome', sshUnit);
  for (const x of meshHub.sessions.list()) if (x.connected) sshUnit(x.id);
  meshHub.on('selected', (pid) => { // `ssh twindesk`: the selected device's, or none
    const u = sshClient.byId.get(pid);
    if (u) u.takeDefault();
    else try { SshConfig.setHost(null); } catch { /* config not writable */ }
  });
  const audioPeer = new Peer(meshHub.audioRoute(), meshHub.server);
  // Sound: an Audio per device, both ways at once (audioset.js); the audio route stays the microphone's.
  const audio = new AudioSet({ Audio, Peer, hub: meshHub, audioHub: hub, stream, getSettings: s, saveSettings: () => store.saveSettings(s()) });
  // Monitor 2 (another computer's screen here): its own route, as on Windows and Linux (hub.sticky). While
  // its window is open it stays with the device it shows, so a crossing that changes the selection doesn't
  // end the picture; open and showing nothing, it follows a device that starts sharing (#256); closed, it
  // follows the selection again.
  let pcViewRef = null;
  let viewTo = null;
  const viewRoute = meshHub.route((h) => {
    const at = viewTo ? h.sessions.get(viewTo) : null;
    const keep = !!(pcViewRef && pcViewRef.isOpen && at && at.connected);
    viewTo = keep ? viewTo : h.selectedId;
    return viewTo;
  }, { remember: ['screen.state'] }); // whether that device shares its screen
  const pcView = new PcView({ server: new Peer(viewRoute, meshHub.server), getSettings: s, saveSettings: () => store.saveSettings(s()) });
  pcViewRef = pcView;
  pcView.on('change', () => setImmediate(() => viewRoute.refresh())); // closed: it follows the selection again (later: never inside a move)
  meshHub.bus.on(P.T.SCREEN_STATE, (m, from) => {
    if (m.on !== true || from === viewRoute.targetId || !pcView.isOpen || pcView.session) return;
    const x = meshHub.sessions.get(from);
    if (!x || !x.connected || P.isPhoneOs(x.peerOs)) return;
    console.log(`[screen] Monitor 2 follows ${x.displayName()}: it shares its screen`);
    meshHub.select(from);
    viewTo = from; // open, it doesn't follow the selection by itself
    viewRoute.refresh();
  });
  // Another computer's apps here: a PcApps per device, each on its own peer (shared/papps-mesh.js), so
  // windows from several computers stay open and a crossing closes none of them (#313).
  const { ScopedPhonePeer } = require('./phones');
  const pcApps = require('../../shared/papps-mesh.js').appsSet({
    selectedId: () => meshHub.selectedId, viewAs: 'getter',
    empty: { apps: [], listing: false, launch: {}, windows: [] },
    merge: (v, all) => ({ ...v, windows: all.flatMap((x) => x.windows || []) }), // the Apps tab: the selected device's list, every window
    all: ['acceptReZume', 'applySettings', 'shutdown', 'setDriven'], selected: ['list', 'open', 'openFromLink', 'keepInDock'],
    any: ['returnWindow'], anyGet: ['focused'],
  });
  const appsUnit = (pid) => pcApps.ensure(pid, () => {
    const p = new ScopedPhonePeer(meshHub, meshHub.server, null);
    const u = new PcApps({ server: p, getSettings: s, allowed: consent ? () => consent.get(pid, 'apps', 'in') : null }); // its own pair's switch
    p.bind(pid); // after it listens: its 'client' now
    return u;
  });
  meshHub.bus.onPeer('welcome', appsUnit);
  for (const x of meshHub.sessions.list()) if (x.connected) appsUnit(x.id);
  const notifs = new Notifs({ bus: meshHub.bus, mesh, helper, getSettings: s, consent, saveSettings: () => store.saveSettings(s()), selfName });
  // History › Keep history: the clipboard's and notifications' history kept, encrypted (shared/histkeeper.js).
  const history = new (require('../../shared/histkeeper.js').HistoryKeeper)({ dir: require('electron').app.getPath('userData'), clip: clipboard, notifs, changed: pushState });
  // Copy and paste files with the shortcuts, with every device (shared/fclip-mesh.js): a paste another
  // device asks for goes to it through a FileSend on its own peer.
  const fileClip = new MeshFileClip({
    hub: meshHub, files: drop, helper, fileSend, getSettings: s,
    makeSender: (id) => fileSend.unit(id),
  });
  kvm.fileClip = fileClip;
  fileClip.kvm = kvm; // the shortcut while the pointer is over there (keyboard not shared)
  // This Mac's apps on another Mac, and Move windows: an AppSend per device, each on its own peer
  // (shared/papps-mesh.js), so windows go to several devices at once (one device's windows had to come back
  // before another could take any). moveOut goes to the unit of the device the pointer went to (unit(id)).
  const appSend = require('../../shared/papps-mesh.js').appsSet({
    selectedId: () => meshHub.selectedId, viewAs: 'getter', empty: { moved: 0 },
    merge: (v, all) => ({ ...v, moved: all.reduce((n, x) => n + (x.moved || 0), 0) }),
    all: ['applySettings', 'shutdown'],
  });
  Object.defineProperty(appSend, 'moved', { get: () => ({ size: appSend.units.reduce((n, u) => n + u.moved.size, 0) }) });
  appSend.unit = (pid) => (pid && appSend.byId.get(pid)) || null;
  const sendUnit = (pid) => appSend.ensure(pid, () => {
    const p = new ScopedPhonePeer(meshHub, meshHub.server, null);
    const u = new AppSend({ server: p, helper, getSettings: s, allows: consent ? () => consent.get(pid, 'apps', 'out') : null }); // its pair's switch
    p.bind(pid); // after it listens: its 'client' now
    return u;
  });
  meshHub.bus.onPeer('welcome', sendUnit);
  for (const x of meshHub.sessions.list()) if (x.connected) sendUnit(x.id);
  const wake = new Wake({ server, getSettings: s, saveSettings: () => store.saveSettings(s()), bus: meshHub.bus, // every device, not only the selected one
    peer: (pid) => { const x = meshHub.sessions.get(pid); return x ? { name: x.displayName(), os: x.peerOs, address: x.ctx ? x.ctx.address : '' } : null; } });
  kvm.blockEdge = () => pcView.focused || pcApps.focused; // moving inside the PC window never crosses to the PC

  for (const x of [stream, clipboard, kvm, terminal, drop, fileSend, smb, apps, sshClient, audio, pcView, pcApps, notifs, fileClip, wake, appSend]) x.on('change', pushState);
  displays.on('change', () => {
    input.releaseAll(); // the shared display moved or changed size mid-press
    pushState();
  });

  // Helper lifecycle: (re)create the virtual display and restart the stream after every start.
  helper.on('ready', () => {
    displays.applyVirtual().then(() => stream.restart('helper started'));
    onHelperReady();
    pushState();
  });
  const exits = [];
  helper.on('exit', () => {
    pushState();
    if (helper.stopping) return;
    const now = Date.now();
    exits.push(now);
    while (exits.length && now - exits[0] > 30000) exits.shift();
    const delay = exits.length <= 2 ? 1000 : exits.length <= 5 ? 3000 : 10000;
    console.log(`[services] helper exited — restarting in ${delay / 1000} s`);
    setTimeout(() => helper.start(), delay);
  });

  // Keep the display awake while a computer is connected (any device, not only the selected one).
  let blocker = null;
  function updateAwake() {
    const want = s().app.keepAwake !== false && meshHub.bus.connectedIds().length > 0;
    if (want && blocker === null) blocker = powerSaveBlocker.start('prevent-display-sleep');
    if (!want && blocker !== null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  }
  meshHub.bus.onPeer('welcome', updateAwake);
  meshHub.bus.onPeer('closed', updateAwake);

  helper.start();

  return {
    helper, displays, stream, input, spaces, spaceLook, desktopRefresh, clipboard, kvm, terminal, drop, filesRelay, smb, apps, sshClient, audio, audioPeer, pcView, pcApps, hub, fileSend, notifs, history, fileClip, wake, appSend, updateAwake,
    shutdown() {
      pcView.shutdown();
      pcApps.shutdown();
      appSend.shutdown();
      kvm.shutdown();
      hub.shutdown(); // unmute this Mac if we muted it while sending
      stream.stop('off');
      helper.stop(); // closes stdin: the helper exits and the virtual display goes away
    },
  };
}

module.exports = { startServices };

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
const P = require('../../shared/protocol.js');
const Spaces = require('../../shared/mac-spaces.js');
const { Clip } = require('./clipboard');
const { Kvm } = require('./kvm');
const { Terminal } = require('../terminal');
const { Drop } = require('../drop');
const { Smb } = require('../smb');
const { Apps } = require('../apps');
const { SshClient } = require('../ssh-client');
const { AudioHub } = require('../audiohub');
const { Audio } = require('../audio');
const { FileSend } = require('../filesend');
const { PcView } = require('../pcview');
const { PcApps } = require('../pcapps');
const { Notifs } = require('./notifs');
const { FileClip } = require('../fclip');
const { Wake } = require('../wake');
const { AppSend } = require('../appsend');
const { Peer } = require('./peer');
const store = require('./store');

// hub: the mesh hub (hub.js) for the pooled features; mesh: the shared/mesh.js registry; selfName():
// this Mac's name, sent with its notifications.
function startServices({ server, getSettings, pushState, onHelperReady, hub: meshHub, mesh, layoutSync, selfName = () => '' }) {
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
    swapKeys: () => server.keySwap(s()), // never between two Macs
  });
  // Each viewer's own picture, including one that is not the shared pointer's display.
  // The bus hears every device; a phone that is not the selected computer can still switch
  // the desktop on the display it is being shown.
  const spaces = new SpaceSwitch({
    listen: (fn) => meshHub.bus.on(P.T.SCREEN_SPACE, (msg, id) => fn(msg, { id })),
    helper,
    enabled: () => s().streamInput !== false && (!kvm || kvm.mode === 'home'),
    authorize: (ctx) => Spaces.meshGate(() => meshHub.sessions.get(ctx && ctx.id)),
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
    listen: (fn) => meshHub.bus.on(P.T.SCREEN_DESKTOPS, (msg, id) => fn(msg, { id })),
    authorize: (ctx) => Spaces.meshGate(() => meshHub.sessions.get(ctx && ctx.id)),
    viewFor: (ctx) => {
      const st = ctx && stream.byId.get(ctx.id);
      return st ? st.viewedDisplay() : null;
    },
    spaceLook,
    reply: (ctx, msg) => meshHub.bus.send(ctx.id, msg),
  });
  const clipboard = new Clip({ bus: meshHub.bus, mesh, getSettings: s, helper, session: (id) => meshHub.sessions.get(id) });
  const drop = new Drop({ server, helper, displays, getSettings: s });
  const fileSend = new FileSend(server, s, { outboxFile: require('path').join(require('electron').app.getPath('userData'), 'outbox.json') });
  kvm = new Kvm({ hub: meshHub, layoutSync, helper, getSettings: s, clipboard, input, drop, fileSend });
  require('../../shared/applog.js').linkStats(() => kvm.linkSample()); // the link's line in the log every 30 s
  const terminal = new Terminal(server, s);
  const smb = new Smb({ server, helper, getSettings: s, saveSettings: () => store.saveSettings(s()) });

  const apps = new Apps({ server, helper, displays, stream, getSettings: s });
  const sshClient = new SshClient(server, s);
  const audioPeer = new Peer(meshHub.audioRoute(), meshHub.server);
  const audio = new Audio({ server: audioPeer, hub, stream, getSettings: s, meshHub });
  const pcView = new PcView({ server, getSettings: s, saveSettings: () => store.saveSettings(s()) });
  const pcApps = new PcApps({ server, getSettings: s });
  const notifs = new Notifs({ bus: meshHub.bus, mesh, helper, getSettings: s, saveSettings: () => store.saveSettings(s()), selfName });
  // History › Keep history: the clipboard's and notifications' history kept, encrypted (shared/histkeeper.js).
  const history = new (require('../../shared/histkeeper.js').HistoryKeeper)({ dir: require('electron').app.getPath('userData'), clip: clipboard, notifs, changed: pushState });
  const fileClip = new FileClip({ server, helper, fileSend, drop, getSettings: s });
  kvm.fileClip = fileClip;
  fileClip.kvm = kvm; // the shortcut while the pointer is over there (keyboard not shared)
  const appSend = new AppSend({ server, helper, getSettings: s }); // This Mac's apps on another Mac
  const wake = new Wake({ server, getSettings: s, saveSettings: () => store.saveSettings(s()) });
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

  // Keep the display awake while a PC is connected.
  let blocker = null;
  function updateAwake() {
    const want = s().app.keepAwake !== false && !!server.current;
    if (want && blocker === null) blocker = powerSaveBlocker.start('prevent-display-sleep');
    if (!want && blocker !== null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  }
  server.on('client', updateAwake);
  server.on('closed', updateAwake);

  helper.start();

  return {
    helper, displays, stream, input, spaces, spaceLook, desktopRefresh, clipboard, kvm, terminal, drop, smb, apps, sshClient, audio, audioPeer, pcView, pcApps, hub, fileSend, notifs, history, fileClip, wake, appSend, updateAwake,
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

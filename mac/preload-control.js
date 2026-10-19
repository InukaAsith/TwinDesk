// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Small API for the control window: getState/onState plus one call per action in ipc.js.
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const ACTIONS = [
  'setSharing', 'setStreamInput', 'selectDisplay', 'setDisplayMode', 'setVirtual', 'setStreamMaxHeight',
  'setBitrate', 'setKvm', 'setApp', 'setAudio', 'setTerminal', 'openSharingSettings', 'setFiles', 'pickDropFolder', 'resetDropFolder', 'revealDrop', 'setSmb', 'setShareMac', 'chooseShareFolder', 'stopSharingFolder', 'openPcShare', 'setApps', 'setReceive', 'showPcView', 'closePcView', 'setPcApps', 'listPcApps', 'openPcApp', 'openPcShell', 'setScreenSound', 'setKeys', 'setClipboard', 'copyHistory', 'clearHistory', 'setTab', 'setSharingOpts', 'remoteScreen', 'wakePeer', 'setWakeOnLan',
  'pairRespond', 'forget', 'openSettings', 'relaunch',
  'keepPcAppInDock', 'sendFiles', 'chooseSendFiles', 'setNotifs', 'muteNotifApp', 'allowFullDisk',
  'connectAddress', 'pairWith', 'selectPeer', 'forgetPeer', 'confirmGuestCode', 'cancelGuestPair', 'forgetHost', 'refreshDiscovery', 'copyText', 'allowPermission', 'skipSetup',
  'connectPhone', 'disconnectPhone', 'setPhone', 'phonePair', 'phoneScreen', 'phoneOpenApp', 'phoneCloseView', 'phoneRetry', 'phoneInstallFull', 'phoneMount', 'phoneUnmount', 'setMount', 'phoneAppMenu',
  'setUpdates', 'checkUpdates', 'openUpdate', 'openLink',
];

const api = {
  getState: () => ipcRenderer.invoke('getState'),
  phoneAssets: () => ipcRenderer.invoke('phoneAssets'),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  pathsOf: (files) => [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean), // dropped files -> paths
};
for (const name of ACTIONS) api[name] = (arg) => ipcRenderer.send(name, arg);

contextBridge.exposeInMainWorld('macshare', api);

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Small API for the control window: getState/onState plus one call per action in ipc.js.
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const ACTIONS = [
  'setSharing', 'setStreamInput', 'selectDisplay', 'setDisplayMode', 'setVirtual', 'setStreamMaxHeight',
  'setBitrate', 'setKvm', 'moveKvm', 'identifyDisplays', 'setApp', 'setAudio', 'camera', 'phoneMedia', 'phoneBtPick', 'setTerminal', 'setRemote', 'setRezume', 'rezumeDo', 'openSharingSettings', 'setFiles', 'pickDropFolder', 'resetDropFolder', 'revealDrop', 'setSmb', 'setShareMac', 'chooseShareFolder', 'stopSharingFolder', 'openPcShare', 'setApps', 'setReceive', 'showPcView', 'closePcView', 'setPcApps', 'listPcApps', 'openPcApp', 'openPcShell', 'setScreenSound', 'setKeys', 'setClipboard', 'copyHistory', 'clearHistory', 'setTab', 'setLanguage', 'setLook', 'setSharingOpts', 'remoteScreen', 'wakePeer', 'setWakeOnLan',
  'pairRespond', 'forget', 'openSettings', 'relaunch', 'setMulti',
  'keepPcAppInDock', 'sendFiles', 'chooseSendFiles', 'setNotifs', 'muteNotifApp', 'allowFullDisk',
  'connectAddress', 'pairWith', 'confirmGuestCode', 'cancelGuestPair', 'forgetHost', 'refreshDiscovery', 'copyText', 'allowPermission', 'skipSetup',
  'connectPhone', 'disconnectPhone', 'disconnect', 'connectAgain', 'setPhone', 'phonePair', 'phoneScreen', 'phoneCamera', 'phoneListCameras', 'phoneOpenApp', 'phoneCloseView', 'phoneScreenAct', 'phoneRetry', 'phoneInstallFull', 'phoneInstallApps', 'phoneMount', 'phoneUnmount', 'setMount', 'phoneAppMenu',
  'deviceDo', 'setOverview', 'setChats', 'notifReply', 'adbQr', 'setWeb', 'selectWebDevice', 'disconnectWebClient', 'sendWebChat', // the redesign: Overview, General › Overview, Messages, QR codes
  'setUpdates', 'skipUpdate', 'unskipUpdate', 'checkUpdates', 'openUpdate', 'openLink', 'setNet', 'netJoinHotspot', 'netCancel', 'netWifi', 'hub',
];

const api = {
  getState: () => ipcRenderer.invoke('getState'),
  phoneAssets: () => ipcRenderer.invoke('phoneAssets'),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onShowUpdate: (fn) => ipcRenderer.on('show-update', () => fn()),
  onHub: (fn) => ipcRenderer.on('hub', (_e, m) => fn(m)), // the phone's answers for Calls, Messages and Photos
  onCamPreview: (fn) => ipcRenderer.on('vcam:preview', (_e, buf) => fn(buf)), // Camera › the picture (a JPEG)
  onGo: (fn) => ipcRenderer.on('go', (_e, tab) => fn(tab)), // show a page (the call window's Calls)
  pathsOf: (files) => [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean), // dropped files -> paths
};
for (const name of ACTIONS) api[name] = (arg) => ipcRenderer.send(name, arg);
api.qrPair = () => ipcRenderer.invoke('qrPair'); // Connection: pair a phone with a QR code (its link)
api.setReZume = api.setRezume; // the shared ReZume page (shared/ui-rezume.js) says it the PC's way
// The one action with two arguments (Camera › Start and Window: {facing, show}): sent as one.
api.phoneCamera = (open, opts) => ipcRenderer.send('phoneCamera', { open, opts });

contextBridge.exposeInMainWorld('macshare', api);

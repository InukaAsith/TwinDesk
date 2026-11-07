// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Small API for the control window: getState/onState plus one call per action in ipc.js.
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const ACTIONS = [
  'setSharing', 'setStreamTarget', 'setStreamInput', 'selectDisplay', 'setDisplayMode', 'setVirtual', 'setStreamMaxHeight',
  'setBitrate', 'setKvm', 'setApp', 'setAudio', 'setTerminal', 'openSharingSettings', 'setFiles', 'pickDropFolder', 'resetDropFolder', 'revealDrop', 'setSmb', 'setShareMac', 'chooseShareFolder', 'stopSharingFolder', 'openPcShare', 'setApps', 'setReceive', 'showPcView', 'closePcView', 'setPcApps', 'listPcApps', 'openPcApp', 'openPcShell', 'setScreenSound', 'setKeys', 'setClipboard', 'copyHistory', 'clearHistory', 'setTab', 'setLanguage', 'setLook', 'setSharingOpts', 'remoteScreen', 'wakePeer', 'setWakeOnLan',
  'pairRespond', 'forget', 'openSettings', 'relaunch', 'setMulti',
  'keepPcAppInDock', 'sendFiles', 'chooseSendFiles', 'setNotifs', 'muteNotifApp', 'allowFullDisk',
  'connectAddress', 'pairWith', 'selectPeer', 'forgetPeer', 'confirmGuestCode', 'cancelGuestPair', 'forgetHost',
  'refreshDiscovery', 'copyText', 'allowPermission', 'skipSetup', 'connectPhone', 'disconnectPhone', 'setPhone',
  'phonePair', 'phoneScreen', 'phoneOpenApp', 'phoneCloseView', 'phoneScreenAct', 'phoneRetry', 'phoneInstallFull', 'phoneInstallApps', 'phoneMount',
  'phoneUnmount', 'setMount', 'phoneAppMenu', 'deviceDo', 'setOverview', 'setChats', 'notifReply', 'setUpdates', 'skipUpdate', 'unskipUpdate', 'checkUpdates', 'openUpdate',
  'openLink', 'setLayoutCell', 'removeFromLayout', 'disconnect', 'connectAgain', 'setNet', 'netJoinHotspot',
  'netCancel', 'netWifi', 'hub',
  // TwinDesk Web (shared/web/webwire.js)
  'webSet', 'webNewCode', 'webAllow', 'webChooseFolder', 'webForget', 'webDisconnect', 'webRename', 'webSendText', 'webSendFiles', 'webChooseFiles',
  'webDeleteItem', 'webClearChat', 'webStopScreen', 'webStopCam', 'webOpenItem', 'webSaveItem', 'webCopy', 'webShareSet', 'webShareFolder',
];

const api = {
  getState: () => ipcRenderer.invoke('getState'),
  phoneAssets: () => ipcRenderer.invoke('phoneAssets'),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onShowUpdate: (fn) => ipcRenderer.on('show-update', () => fn()),
  onHub: (fn) => ipcRenderer.on('hub', (_e, m) => fn(m)), // the phone's answers for Calls, Messages and Photos
  onGo: (fn) => ipcRenderer.on('go', (_e, tab) => fn(tab)), // show a page (the call window's Calls)
  pathsOf: (files) => [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean), // dropped files -> paths
};
for (const name of ACTIONS) api[name] = (arg) => ipcRenderer.send(name, arg);

contextBridge.exposeInMainWorld('macshare', api);

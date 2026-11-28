// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Small API for the control window: getState/onState plus one call per action in ipc.js.
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const ACTIONS = [
  'setSharing', 'setStreamTarget', 'setStreamInput', 'selectDisplay', 'setDisplayMode', 'setVirtual', 'setStreamMaxHeight',
  'setBitrate', 'setKvm', 'setPortals', 'setApp', 'setAudio', 'camera', 'setRemote', 'deckSave', 'deckTry', 'iosSign', 'iosSignIpa', 'setRezume', 'rezumeDo', 'phoneMedia', 'phoneBtPick', 'setTerminal', 'openSharingSettings', 'setFiles', 'setDrive', 'pickDriveFolder', 'resetDriveFolder', 'openDriveFolder', 'folderShare', 'folderSheet', 'folderAdd', 'folderRemove', 'folderDevices', 'folderAccept', 'folderDecline', 'folderOpen', 'pickDropFolder', 'resetDropFolder', 'revealDrop', 'clearFiles', 'pauseSend', 'resumeSend', 'forgetSend', 'setSmb', 'setShareMac', 'chooseShareFolder', 'stopSharingFolder', 'openPcShare', 'openDrive', 'setApps', 'setReceive', 'showPcView', 'closePcView', 'setPcApps', 'listPcApps', 'openPcApp', 'openPcShell', 'setScreenSound', 'setKeys', 'setClipboard', 'copyHistory', 'openClip', 'clearHistory', 'history', 'setTab', 'setLanguage', 'setLook', 'setSharingOpts', 'remoteScreen', 'wakePeer', 'setWakeOnLan',
  'pairRespond', 'forget', 'openSettings', 'relaunch', 'setModules', 'setMulti',
  'keepPcAppInDock', 'sendFiles', 'chooseSendFiles', 'setNotifs', 'muteNotifApp', 'allowFullDisk',
  'connectAddress', 'pairWith', 'selectPeer', 'forgetPeer', 'confirmGuestCode', 'cancelGuestPair', 'forgetHost',
  'refreshDiscovery', 'copyText', 'allowPermission', 'skipSetup', 'connectPhone', 'disconnectPhone', 'setPhone',
  'phonePair', 'phonePick', 'phoneScreen', 'phoneCamera', 'phoneOpenApp', 'phoneCloseView', 'phoneScreenAct', 'phoneRetry', 'phoneInstallFull', 'phoneInstallApps', 'phoneMount',
  'phoneUnmount', 'setMount', 'phoneAppMenu', 'deviceDo', 'setOverview', 'setChats', 'notifReply', 'adbQr', 'setUpdates', 'skipUpdate', 'unskipUpdate', 'checkUpdates', 'openUpdate',
  'openLink', 'setLayoutCell', 'moveOnMap', 'resetMap', 'setMapSkip', 'removeFromLayout', 'disconnect', 'connectAgain', 'setNet', 'netJoinHotspot',
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
  onCamPreview: (fn) => ipcRenderer.on('vcam:preview', (_e, buf) => fn(buf)), // Camera › the picture (a JPEG)
  onGo: (fn) => ipcRenderer.on('go', (_e, tab) => fn(tab)), // show a page (the call window's Calls)
  pathsOf: (files) => [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean), // dropped files -> paths
};
for (const name of ACTIONS) api[name] = (arg) => ipcRenderer.send(name, arg);
api.phoneCamera = (open, opts) => ipcRenderer.send('phoneCamera', { open, opts }); // Camera › Start and Window: {facing, show}, sent as one
api.setStreamTarget = (id, choice) => ipcRenderer.send('setStreamTarget', { id, choice }); // two values, sent as one (the loop above sends one)
api.setReZume = api.setRezume; // the shared ReZume page (shared/ui-rezume.js) says it the PC's way
api.setCell = (from, to, feature, on) => ipcRenderer.send('setCell', { from, to, feature, on }); // Notifications › Across devices: any cell
api.setConsent = (id, feature, dir, on) => ipcRenderer.send('setConsent', { id, feature, dir, on }); // the matrix: one of this Mac's own cells
api.setManage = (o) => ipcRenderer.send('setManage', o); // Multi-device › Phones (shared/mesh-manage.js)
api.deckApps = () => ipcRenderer.invoke('deckApps'); // the Deck page's app picker
api.deckState = () => ipcRenderer.invoke('deckState');
api.drop = (o) => ipcRenderer.invoke('drop', o); // Drop (shared/drop-host.js)
api.soundRoute = (o) => ipcRenderer.invoke('soundRoute', o); // Audio › the mixer
api.soundVolume = (level) => ipcRenderer.invoke('soundVolume', level); // its sound, Bluetooth and display pickers
api.deckPick = (o) => ipcRenderer.invoke('deckPick', o); // a file, folder or script for a tile
api.deckRun = (action) => ipcRenderer.invoke('deckRun', action); // Try: {ok, why}
api.debugAsk = (to, op, args) => ipcRenderer.invoke('debugAsk', to, op, args); // Debug: ask a device of the mesh (or 'self')
api.setDebug = (o) => ipcRenderer.invoke('setDebug', o); // Debug › This computer: who may debug it, Allow any command
api.debugShow = (p) => ipcRenderer.invoke('debugShow', p); // Debug: show a kept log or screenshot in its folder
api.qrPair = () => ipcRenderer.invoke('qrPair'); // Connection: pair a phone with a QR code (its link)
api.phoneListCameras = () => ipcRenderer.invoke('phoneListCameras');

contextBridge.exposeInMainWorld('macshare', api);

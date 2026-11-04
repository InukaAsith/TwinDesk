// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Phone › Apps › Install Apps (Mac, PC and Linux): .apk files from this computer installed on the
// phone over ADB (wireless debugging or USB), one after another. The bridge's `appInstall` is what
// the page shows ({state: 'installing'|'done'|'failed', name, done, total}); a popup says how it
// went; the phone's app list is asked for again, so a new app shows up there.
// bridge: the platform's PhoneBridge (adb, serial, state, server, emit).
'use strict';

const fs = require('fs');
const path = require('path');
const P = require('./protocol.js');

const MAX_FILES = 20;
const TIMEOUT_MS = 300000; // a big game over Wi-Fi

// adb's reason, in words.
const REASONS = [
  [/INSTALL_FAILED_USER_RESTRICTED/, 'The phone refused: allow “Install via USB” in Developer options (Xiaomi), then try again.'],
  [/INSTALL_FAILED_UPDATE_INCOMPATIBLE|INCONSISTENT_CERTIFICATES/, 'A different build of this app is installed. Uninstall it on the phone first.'],
  [/INSTALL_FAILED_VERSION_DOWNGRADE/, 'A newer version is already installed.'],
  [/INSTALL_FAILED_OLDER_SDK/, 'This app needs a newer Android.'],
  [/INSTALL_FAILED_NO_MATCHING_ABIS/, 'This app isn’t made for this phone’s processor.'],
  [/INSTALL_FAILED_INSUFFICIENT_STORAGE/, 'The phone is out of space.'],
  [/INSTALL_PARSE_FAILED|INSTALL_FAILED_INVALID_APK/, 'This file isn’t a whole Android app.'],
  [/INSTALL_FAILED_ABORTED|Install canceled by user/i, 'Cancelled on the phone.'],
];

function reason(text) {
  for (const [re, why] of REASONS) if (re.test(text)) return { key: why };
  const fail = /Failure \[([^\]]+)\]/.exec(text);
  return fail ? fail[1] : (text.split('\n').pop() || { key: 'no answer' });
}

function set(bridge, s) {
  bridge.appInstall = s;
  bridge.emit('change');
}

// Install these files (.apk) on the phone, in order.
async function install(bridge, paths) {
  if (bridge.appInstall && bridge.appInstall.state === 'installing') return;
  const serial = bridge.serial;
  if (!serial || bridge.state !== 'ready') {
    bridge.emit('popup', 'home', { key: 'Set up wireless debugging first.' });
    return;
  }
  const files = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && /\.apk$/i.test(p) && path.isAbsolute(p))
    .filter((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }).slice(0, MAX_FILES);
  if (!files.length) return;
  const failed = [];
  for (let i = 0; i < files.length; i++) {
    const name = path.basename(files[i]).replace(/\.apk$/i, '');
    set(bridge, { state: 'installing', name, done: i, total: files.length });
    const r = await bridge.adb.run(['-s', serial, 'install', '-r', files[i]], { timeout: TIMEOUT_MS }).catch((e) => ({ out: '', err: String(e && e.message) }));
    const text = `${r.out || ''}${r.err || ''}`.trim();
    if (!/\bSuccess\b/.test(text)) failed.push({ name, why: reason(text) });
  }
  const ok = files.length - failed.length;
  set(bridge, { state: failed.length ? 'failed' : 'done', name: '', done: files.length, total: files.length });
  if (ok) setTimeout(() => bridge.server.sendToClient({ t: P.T.PHONE_APPS_LIST }), 1000); // the new apps on the Apps page
  if (!failed.length) bridge.emit('popup', 'driven', files.length === 1 ? { key: 'Installed {app} on the phone', vars: { app: path.basename(files[0]).replace(/\.apk$/i, '') } } : { key: 'Installed {count} apps on the phone', vars: { count: ok } });
  else if (failed.length === 1) bridge.emit('popup', 'home', { key: 'Couldn’t install {app} ({error})', vars: { app: failed[0].name, error: failed[0].why } });
  else bridge.emit('popup', 'home', { key: 'Couldn’t install {count} of {total} apps', vars: { count: failed.length, total: files.length } });
}

// The Install Apps button: pick .apk files, then install them. t: the main process's translator.
async function choose(bridge, t = (s) => s) {
  if (!bridge || (bridge.appInstall && bridge.appInstall.state === 'installing')) return;
  const { dialog, BrowserWindow } = require('electron');
  const win = BrowserWindow.getFocusedWindow();
  const opts = { title: t('Install Apps on the Phone'), buttonLabel: t('Install'), properties: ['openFile', 'multiSelections'], filters: [{ name: t('Android apps'), extensions: ['apk'] }] };
  const r = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
  if (!r.canceled && r.filePaths.length) await install(bridge, r.filePaths);
}

module.exports = { install, choose, reason };

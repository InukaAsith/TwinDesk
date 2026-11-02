// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The menu bar / tray menu, laid out the same on every platform (each main.js gives the model).
// Connected: the status, the way home, Cursor Sharing, then the switches by kind (Mouse and
// Keyboard, Screen, Clipboard and Sound, Files, Connection) and the app. Not connected: only
// connecting, the window, Quit.
//   template(m) -> an Electron menu template
//   m: {status, connected, home?(), shared: {checked, set(on)}, lock?: {label, checked, set},
//       keyboard: {checked, set}, drive: {label, checked, set}, driven?: {label, checked, set},
//       popup: {checked, set}, screen: [{label, checked, set}], clipboard: {checked, set},
//       sound: {checked, set}, drag: {checked, set}, shortcuts: {label, checked, set},
//       found: [{label, click}], byAddress(), lookAgain(), again?: {label, click},
//       disconnect?: {label, click}, update?: {label, click}, windowsBack?: {label, click}, open(), quit(),
//       rezume?: [{label, click}] (Continue …, Send … to: shared/rezume.js)}
'use strict';

const check = (label, o) => ({ label, type: 'checkbox', checked: !!o.checked, click: (i) => o.set(i.checked) });
const sep = { type: 'separator' };

function connectTo(m, t) {
  return {
    label: t('Connect To'),
    submenu: [
      ...(m.found.length ? m.found : [{ label: t('Nobody nearby'), enabled: false }]),
      sep,
      { label: t('Connect by Address…'), click: m.byAddress },
      { label: t('Look Again'), click: m.lookAgain },
    ],
  };
}

// The menus by kind, the same in the tray and the Mac's own menu bar (appMenu).
// short: the Mac's menu bar, where the names sit side by side ("Mouse & Keyboard").
function kinds(m, t, short = false) {
  return [
    {
      label: t(short ? 'Mouse & Keyboard' : 'Mouse and Keyboard'),
      submenu: [
        check(t('Share Keyboard'), m.keyboard),
        ...(m.lock ? [check(m.lock.label, m.lock)] : []),
        sep,
        check(m.drive.label, m.drive),
        ...(m.driven ? [check(m.driven.label, m.driven)] : []),
        sep,
        check(t('Show a Popup When Switching'), m.popup),
      ],
    },
    { label: t('Screen'), submenu: m.screen.map((x) => check(x.label, x)) },
    { label: t(short ? 'Clipboard & Sound' : 'Clipboard and Sound'), submenu: [check(t('Share Clipboard'), m.clipboard), check(t('Send Sound'), m.sound)] },
    { label: t('Files'), submenu: [check(t('Drag Files Across the Screen Edge'), m.drag), check(m.shortcuts.label, m.shortcuts)] },
    { label: t('Connection'), submenu: [...(m.disconnect ? [m.disconnect, sep] : []), connectTo(m, t)] },
  ];
}

function template(m) {
  const t = m.t || ((text) => text); // platforms opt in without changing their existing menus
  const status = { label: m.status, enabled: false };
  if (!m.connected) {
    return [status, ...(m.again ? [m.again] : []), connectTo(m, t), sep, { label: t('Open TwinDesk…'), click: m.open }, { label: t('Quit TwinDesk'), click: m.quit }];
  }
  return [
    status,
    ...(m.home ? [{ label: t('Bring Mouse and Keyboard Back'), click: m.home }] : []),
    ...(m.windowsBack ? [m.windowsBack] : []), // windows moved to the other computer (Apps › Move windows)
    ...(m.rezume && m.rezume.length ? [...m.rezume, sep] : []),
    check(t('Cursor Sharing'), m.shared),
    sep,
    ...kinds(m, t),
    sep,
    ...(m.update ? [m.update] : []),
    { label: t('Open TwinDesk…'), click: m.open },
    { label: t('Quit TwinDesk'), click: m.quit },
  ];
}

// The Mac's menu bar while TwinDesk's window is in front: the app menu, the tray's menus by kind
// with short names (only Connection while nothing is connected) and Window. No Edit menu: its
// shortcuts (copy, paste, undo, select all…) are hidden items of the app menu, which still work.
function appMenu(m) {
  const t = m.t || ((text) => text);
  const app = {
    label: 'TwinDesk',
    submenu: [
      { label: m.status, enabled: false },
      ...(m.again ? [m.again] : []),
      ...(m.home ? [{ label: t('Bring Mouse and Keyboard Back'), click: m.home }] : []),
      ...(m.connected ? [check(t('Cursor Sharing'), m.shared)] : []),
      sep,
      ...(m.update ? [m.update] : []),
      { label: t('Settings…'), accelerator: 'CmdOrCtrl+,', click: m.open },
      sep,
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      sep,
      { label: t('Quit TwinDesk'), accelerator: 'CmdOrCtrl+Q', click: m.quit },
      ...['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll'].map((role) => ({ role, visible: false, acceleratorWorksWhenHidden: true })),
    ],
  };
  const menus = m.connected ? kinds(m, t, true) : [{ label: t('Connection'), submenu: [connectTo(m, t)] }];
  const rezume = m.connected && m.rezume && m.rezume.length ? [{ label: 'ReZume', submenu: m.rezume }] : [];
  return [app, ...menus, ...rezume, { role: 'windowMenu' }];
}

module.exports = { template, appMenu };

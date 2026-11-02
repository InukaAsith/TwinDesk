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
//       disconnect?: {label, click}, update?: {label, click}, open(), log(), quit(),
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

function template(m) {
  const t = m.t || ((text) => text); // platforms opt in without changing their existing menus
  const status = { label: m.status, enabled: false };
  if (!m.connected) {
    return [status, ...(m.again ? [m.again] : []), connectTo(m, t), sep, { label: t('Open TwinDesk…'), click: m.open }, { label: t('Quit TwinDesk'), click: m.quit }];
  }
  return [
    status,
    ...(m.home ? [{ label: t('Bring Mouse and Keyboard Back'), click: m.home }] : []),
    ...(m.rezume && m.rezume.length ? [...m.rezume, sep] : []),
    check(t('Cursor Sharing'), m.shared),
    sep,
    {
      label: t('Mouse and Keyboard'),
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
    { label: t('Clipboard and Sound'), submenu: [check(t('Share Clipboard'), m.clipboard), check(t('Send Sound'), m.sound)] },
    { label: t('Files'), submenu: [check(t('Drag Files Across the Screen Edge'), m.drag), check(m.shortcuts.label, m.shortcuts)] },
    { label: t('Connection'), submenu: [...(m.disconnect ? [m.disconnect, sep] : []), connectTo(m, t)] },
    sep,
    ...(m.update ? [m.update] : []),
    { label: t('Open TwinDesk…'), click: m.open },
    { label: t('Open Log Folder'), click: m.log },
    { label: t('Quit TwinDesk'), click: m.quit },
  ];
}

module.exports = { template };

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Mount tab: the phone's storage as a drive in the file manager (phonedrive.js). Off, TwinDesk doesn't look
// for the phone or touch its files at all; on, only Mount does, and only while it's mounted.
// Port of mac/ui-mount.js.
'use strict';

UI.tab({
  id: 'mount',
  for: ['android'], // its storage through ADB (shared/ui-kinds.js)
  wifiOnly: true, // over Bluetooth it can't work and doesn't move the session onto Wi-Fi: says so, with Connect with Wi-Fi Direct
  order: 55,
  title: I18n.t('Mount'),
  icon: 'drive',
  color: 'linear-gradient(#ffd60a, #ff9f0a)',
  desc: I18n.t('The phone’s storage as a drive in the file manager, through ADB: the cable (USB debugging) or wireless debugging.'),
  master: { get: (s) => !!(s.mount && s.mount.on), set: (v) => UI.api.setMount({ on: v }) },
  badge: (s) => (s.mount && s.mount.mounted ? 'on' : ''),
  build(body) {
    const { api } = UI;
    const mountBtn = UI.button(I18n.t('Mount'), () => api.phoneMount(), 'small primary');
    const showBtn = UI.button(I18n.t('Show'), () => api.phoneMount(), 'small');
    const unmountBtn = UI.button(I18n.t('Unmount'), () => api.phoneUnmount(), 'small');
    const driveRow = UI.row(I18n.t('Show the phone in the file manager'), '', [mountBtn, showBtn, unmountBtn]);
    const offRow = UI.row(I18n.t('Off'), I18n.t('Switch it on to mount the phone'));
    // Mount is ADB: with the phone's debugging off it can't, and says so (Phone Files needs none).
    const adbText = UI.el('div', { class: 'hub-top-text' });
    const adbNote = UI.el('div', { class: 'note warn hub-top', hidden: true }, [UI.el('div', { class: 'hub-top-body' }, [adbText]),
      UI.el('div', { class: 'hub-top-actions' }, [UI.button(I18n.t('Wireless Debugging'), () => UI.go('connection'), 'small'), UI.button(I18n.t('Phone Files'), () => UI.go('pfiles'), 'small primary')])]);
    body.append(adbNote);
    body.append(UI.card(I18n.t('Drive'), [offRow, driveRow]));

    return (s) => {
      const d = s.mount || {};
      const ph = s.phone || {};
      const adb = ph.adb || {};
      const adbOff = !!ph.connected && !ph.connected.usb && !d.mounted && (adb.wifi === false || (ph.bridge && ph.bridge.state === 'waitingWifi'));
      adbNote.hidden = !d.on || !adbOff;
      adbText.textContent = adb.devOptions === false
        ? I18n.t('Mount works through ADB, and Developer options are off on the phone. Switch on Developer options and Wireless debugging (Connection), or plug the phone in with USB debugging on. Phone Files works without it.')
        : I18n.t('Mount works through ADB, and wireless debugging is off on the phone. Switch it on (Connection), or plug the phone in with USB debugging on. Phone Files works without it.');
      offRow.hidden = !!d.on;
      driveRow.hidden = !d.on;
      mountBtn.hidden = !!d.mounted;
      mountBtn.textContent = d.busy === 'mounting' ? I18n.t('Mounting…') : I18n.t('Mount');
      mountBtn.disabled = !!d.busy;
      showBtn.hidden = unmountBtn.hidden = !d.mounted;
      unmountBtn.disabled = !!d.busy;
      driveRow.setHint(d.message ? I18n.t(d.message) : (d.mounted ? I18n.t('In the file manager’s sidebar, {connection}.', { connection: d.via === 'usb' ? I18n.t('through the cable') : I18n.t('over wireless debugging') })
        : I18n.t('Plug the phone in with USB debugging on, or connect it with wireless debugging, then Mount.')));
    };
  },
});

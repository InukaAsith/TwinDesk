// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Mount tab: the phone's storage as a drive in the file manager (phonedrive.js). Off, TwinDesk doesn't look
// for the phone or touch its files at all; on, only Mount does, and only while it's mounted.
// Port of mac/ui-mount.js.
'use strict';

UI.tab({
  id: 'mount',
  hidden: (s) => !UI.isPhone(s), // only while a phone is connected
  wifiOnly: true, // over Bluetooth it can't work and doesn't move the session onto Wi-Fi: says so, with Connect with Wi-Fi Direct
  order: 55,
  title: 'Mount',
  icon: 'drive',
  color: 'linear-gradient(#ffd60a, #ff9f0a)',
  desc: 'The phone’s storage as a drive in the file manager, through ADB: the cable (USB debugging) or wireless debugging.',
  master: { get: (s) => !!(s.mount && s.mount.on), set: (v) => UI.api.setMount({ on: v }) },
  badge: (s) => (s.mount && s.mount.mounted ? 'on' : ''),
  build(body) {
    const { api } = UI;
    const mountBtn = UI.button('Mount', () => api.phoneMount(), 'small primary');
    const showBtn = UI.button('Show', () => api.phoneMount(), 'small');
    const unmountBtn = UI.button('Unmount', () => api.phoneUnmount(), 'small');
    const driveRow = UI.row('Show the phone in the file manager', '', [mountBtn, showBtn, unmountBtn]);
    const offRow = UI.row('Off', 'Switch it on to mount the phone');
    // Mount is ADB: with the phone's debugging off it can't, and says so (Phone Files needs none).
    const adbText = UI.el('div', { class: 'hub-top-text' });
    const adbNote = UI.el('div', { class: 'note warn hub-top', hidden: true }, [UI.el('div', { class: 'hub-top-body' }, [adbText]),
      UI.el('div', { class: 'hub-top-actions' }, [UI.button('Phone Page', () => UI.go('phone'), 'small'), UI.button('Phone Files', () => UI.go('pfiles'), 'small primary')])]);
    body.append(adbNote);
    body.append(UI.card('Drive', [offRow, driveRow]));

    return (s) => {
      const d = s.mount || {};
      const ph = s.phone || {};
      const adb = ph.adb || {};
      const adbOff = !!ph.connected && !ph.connected.usb && !d.mounted && (adb.wifi === false || (ph.bridge && ph.bridge.state === 'waitingWifi'));
      adbNote.hidden = !d.on || !adbOff;
      adbText.textContent = adb.devOptions === false
        ? 'Mount works through ADB, and Developer options are off on the phone. Switch on Developer options and Wireless debugging (Phone page), or plug the phone in with USB debugging on. Phone Files works without ADB.'
        : 'Mount works through ADB, and wireless debugging is off on the phone. Switch it on (Phone page), or plug the phone in with USB debugging on. Phone Files works without ADB.';
      offRow.hidden = !!d.on;
      driveRow.hidden = !d.on;
      mountBtn.hidden = !!d.mounted;
      mountBtn.textContent = d.busy === 'mounting' ? 'Mounting…' : 'Mount';
      mountBtn.disabled = !!d.busy;
      showBtn.hidden = unmountBtn.hidden = !d.mounted;
      unmountBtn.disabled = !!d.busy;
      driveRow.setHint(d.message || (d.mounted ? `In the file manager’s sidebar, ${d.via === 'usb' ? 'through the cable' : 'over wireless debugging'}.`
        : 'Plug the phone in with USB debugging on, or connect it with wireless debugging, then Mount.'));
    };
  },
});

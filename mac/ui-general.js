// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General tab: permissions, app behaviour.
'use strict';

UI.tab({
  id: 'general',
  order: 100,
  title: 'General',
  desc: '',
  color: 'linear-gradient(#aeaeb2, #636366)',
  bottom: true,
  badge: (s) => {
    const p = s.permissions;
    if (p && (p.screen !== 'granted' || !p.accessibility || p.inputMonitoring === false)) return '!';
    return '';
  },
  build(body) {
    const { el, api } = UI;
    const PERMS = [
      { kind: 'screen', label: 'Screen Recording', note: 'To share your screen' },
      { kind: 'accessibility', label: 'Accessibility', note: 'So the other computer can control this one' },
      { kind: 'inputMonitoring', label: 'Input Monitoring', note: 'To use this keyboard on the other computer' },
      // Every other permission a feature uses, in one place (each is asked for when the feature is used).
      { kind: 'localNetwork', label: 'Local Network', note: 'To find your other computers and phones', state: (s) => (s.discovery ? s.discovery.localNetwork !== false : null) },
      { kind: 'bluetooth', label: 'Bluetooth', note: 'For a phone or computer that isn’t on this network', state: (s) => (s.net && s.net.radio ? s.net.radio !== 'denied' && s.net.radio !== 'unauthorized' : null) },
      { kind: 'location', label: 'Location', note: 'To join a phone’s or PC’s Wi-Fi Direct (macOS shows Wi-Fi networks only with it)', state: () => null },
      { kind: 'fullDisk', label: 'Full Disk Access', note: 'Optional: to share any folder with the other computer', state: () => null },
    ];
    const perms = PERMS.map((p) => {
      const pill = el('span', { class: 'pill' });
      const row = UI.row(p.label, p.note, [pill, UI.button('Open', () => api.openSettings(p.kind), 'small')]);
      return { p, pill, row };
    });
    const helperRow = UI.row('Background helper', '');
    const helperVal = el('span', { class: 'value' });
    helperRow.querySelector('.controls').append(helperVal);
    const deviceName = el('span', { class: 'value' });
    const deviceRow = UI.row('Computer name', 'How other computers see this one', [deviceName]);
    const loginSw = UI.switch((v) => api.setApp({ openAtLogin: v }), { label: 'Open at login' });
    const lockScreenSw = UI.switch((v) => api.setKvm({ lockScreen: v }), { label: 'Control on lock screen & login window' });
    const awakeSw = UI.switch((v) => api.setApp({ keepAwake: v }), { label: 'Keep the display awake' });
    const hudSw = UI.switch((v) => api.setApp({ hud: v }), { label: 'Show a popup when switching' });
    // Wake this Mac from the other computer; the Share menu entry.
    const wakeSw = UI.switch((v) => api.setWakeOnLan(v), { label: 'Wake from the network' });
    const wakeRow = UI.row('Let {name} wake {me}', '', [wakeSw]);
    // Bluetooth when not on the same network: with phones (on unless switched off), with computers (off unless switched on).
    const bleSw = UI.switch((v) => api.setNet({ ble: v }), { label: 'Bluetooth with phones' });
    const bleRow = UI.row('Bluetooth with phones', '', [bleSw]);
    const blePcSw = UI.switch((v) => api.setNet({ blePc: v }), { label: 'Bluetooth with computers' });
    const blePcRow = UI.row('Bluetooth with computers', '', [blePcSw]);
    // Bluetooth off altogether while the session is on the same Wi-Fi (blepolicy.js wifiQuiet).
    const bleWifiSw = UI.switch((v) => api.setNet({ bleWifiOff: v }), { label: 'Turn off Bluetooth on Wi-Fi connections' });
    const bleWifiRow = UI.row('Turn off Bluetooth on Wi-Fi connections', '', [bleWifiSw]);
    const shareRow = UI.row('TwinDesk in the Share menu', 'Share › TwinDesk sends files to the other computer',
      [UI.button('Extensions…', () => api.openSettings('extensions'), 'small')]);

    body.append(
      UI.card('Permissions', [
        ...perms.map((x) => x.row),
        UI.row('Changed a permission?', 'Restart to apply it', [UI.button('Restart', () => api.relaunch(), 'small')]),
      ]),
      UI.card('App', [
        UI.row('Open at login', '', [loginSw]),
        UI.row('Control on lock screen & login window', 'Allow mouse and keyboard control on the macOS login window and lock screen', [lockScreenSw]),
        UI.row('Keep the display awake', 'While connected', [awakeSw]),
        UI.row('Show a popup when switching', 'When the mouse and keyboard move between computers', [hudSw]),
      ]),
      UI.card('Network and sharing', [bleRow, blePcRow, bleWifiRow, wakeRow, shareRow]),
      UI.card('This computer', [deviceRow, helperRow]),
    );

    return (s) => {
      for (const { p, pill } of perms) {
        const v = p.state ? p.state(s) : s.permissions[p.kind];
        const ok = p.kind === 'screen' ? v === 'granted' : v === true;
        const unknown = v === null || v === undefined || v === 'unknown';
        pill.className = `pill ${unknown ? 'muted' : ok ? 'good' : 'bad'}`;
        // macOS counts Accessibility as enough for TwinDesk's keyboard tap: Input Monitoring reads
        // as allowed then, with its own switch in System Settings still off (that's fine).
        const viaAx = p.kind === 'inputMonitoring' && ok && s.permissions.accessibility === true;
        pill.hidden = unknown && !!p.state; // macOS doesn't tell: Open shows it
        pill.textContent = unknown ? 'Unknown' : viaAx ? 'Allowed by Accessibility' : ok ? 'Allowed' : 'Not allowed';
      }
      if (s.app) {
        loginSw.set(s.app.openAtLogin);
        lockScreenSw.set(s.kvm && s.kvm.lockScreen !== false);
        awakeSw.set(s.app.keepAwake);
        hudSw.set(s.app.hud !== false);
      }
      const w = s.wake || {};
      wakeSw.set(w.womp === true);
      wakeSw.disable(w.womp == null);
      wakeRow.setHint(w.womp == null ? 'Checking…' : 'Wake for network access. Asks for your password to change it');
      if (s.net) {
        bleSw.set(s.net.ble);
        blePcSw.set(s.net.blePc === true);
        bleWifiSw.set(s.net.bleWifiOff !== false);
        bleWifiRow.setHint(s.net.bleWifiOff === false ? 'Bluetooth stays on beside the Wi-Fi, the way back if it drops'
          : s.net.bleOff ? 'Off now: the session is on the same Wi-Fi. Bluetooth comes back when it ends'
            : 'On the same Wi-Fi network (not Wi-Fi Direct), Bluetooth goes off until the session ends. With a computer, phones can’t find this one meanwhile');
        const RADIO = { off: 'Bluetooth is off', unauthorized: 'Allow TwinDesk in System Settings › Privacy & Security › Bluetooth', unsupported: 'This Mac can’t advertise over Bluetooth' };
        bleRow.setHint(!s.net.ble ? 'Only phones on this network or a USB cable connect'
          : RADIO[s.net.radio] || 'Phones nearby connect over Bluetooth. Files and screens move to a direct Wi-Fi link for a while');
        blePcRow.setHint(s.net.blePc !== true ? 'Only computers on this network connect'
          : RADIO[s.net.radio] || 'PCs nearby connect over Bluetooth. Files and screens move to a direct Wi-Fi link for a while');
      }
      helperVal.textContent = s.helper && s.helper.running ? 'Running' : 'Not running';
      deviceName.textContent = s.macName || '';
    };
  },
});

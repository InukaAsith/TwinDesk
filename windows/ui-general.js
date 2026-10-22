// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General tab: start with Windows, the switching popup, firewall self-check (+ Fix), wake from the
// network, Bluetooth for devices not on this network, helper, the virtual display driver (Extend), this PC.
'use strict';

UI.tab({
  id: 'general',
  order: 100,
  title: 'General',
  color: 'linear-gradient(#aeaeb2, #636366)',
  desc: '',
  bottom: true,
  badge: (s) => (s.firewall && s.firewall.ok === false && !s.firewall.checking ? 'warn' : ''),
  build(body) {
    const { el, api } = UI;
    const startup = UI.switch((v) => api.setStartup(v), { label: 'Start with Windows' });
    const hudSw = UI.switch((v) => api.setApp({ hud: v }), { label: 'Show a popup when switching' });
    const fwPill = el('span', { class: 'pill' });
    const fwCheck = UI.button('Check again', () => api.checkFirewall(), 'small');
    const fwFix = UI.button('Fix', () => api.fixFirewall(), 'small primary');
    const fwRow = UI.row('Firewall', '', [fwPill, fwCheck, fwFix]);
    // (as the Mac): wake is a switch; Send to sends files from Explorer.
    const wakeSw = UI.switch((v) => api.setWake(v), { label: 'Wake from the network' });
    const wakeRow = UI.row('Let the other computer wake {me}', '', [wakeSw]);
    const sendToRow = UI.row('TwinDesk Mesh in Send to', '');
    const helperPill = el('span', { class: 'pill' });
    const helperRow = UI.row('Mouse and keyboard helper', '', [helperPill]);
    const vddPill = el('span', { class: 'pill' });
    const vddInstall = UI.button('Install', () => api.installVdd(), 'small primary');
    const vddRow = UI.row('Virtual display driver', '', [vddPill, vddInstall]); // Share screen › Extend (vdd.js)
    // Bluetooth when not on the same network: with phones (on unless switched off), with computers (off unless switched on).
    const bleSw = UI.switch((v) => api.setNet({ ble: v }), { label: 'Bluetooth with phones' });
    const bleRow = UI.row('Bluetooth with phones', '', [bleSw]);
    const blePcSw = UI.switch((v) => api.setNet({ blePc: v }), { label: 'Bluetooth with computers' });
    const blePcRow = UI.row('Bluetooth with computers', '', [blePcSw]);
    // Bluetooth off altogether while the session is on the same Wi-Fi (blepolicy.js wifiQuiet).
    const bleWifiSw = UI.switch((v) => api.setNet({ bleWifiOff: v }), { label: 'Turn off Bluetooth on Wi-Fi connections' });
    const bleWifiRow = UI.row('Turn off Bluetooth on Wi-Fi connections', '', [bleWifiSw]);
    // The mesh: introduce devices to each other and accept introductions (docs/mesh.md "Joining everyone").
    const joinSw = UI.switch((v) => api.setMesh({ autoJoin: v }), { label: 'Join every device automatically' });
    const joinRow = UI.row('Join every device automatically', '', [joinSw]);
    // What Windows has to allow, in one place (each is also asked for where a feature needs it).
    const btPill = el('span', { class: 'pill' });
    const btRow = UI.row('Bluetooth', 'For a phone or computer that isn’t on this network', [btPill, UI.button('Open', () => api.openBluetoothSettings(), 'small')]);
    const locRow = UI.row('Location', 'To join a phone’s or computer’s Wi-Fi Direct (Windows shows Wi-Fi networks only with it)', [UI.button('Open', () => api.netLocation(), 'small')]);
    const deviceName = el('span', { class: 'value' });
    const deviceRow = UI.row('Computer name', 'How other computers see this one', [deviceName]);

    body.append(
      UI.card('App', [
        UI.row('Start with Windows', '', [startup]),
        UI.row('Show a popup when switching', 'When the mouse and keyboard move between computers', [hudSw]),
      ]),
      UI.card('Permissions', [fwRow, btRow, locRow]),
      UI.card('Network and sharing', [wakeRow, sendToRow, joinRow, bleRow, blePcRow, bleWifiRow]),
      UI.card('This computer', [deviceRow, helperRow, vddRow]),
    );

    return (s) => {
      startup.set(s.startup);
      hudSw.set(s.app.hud);
      const fw = s.firewall || {};
      fwPill.textContent = fw.checking ? 'Checking…' : fw.ok ? 'OK' : fw.ok === false ? 'Needs a fix' : '';
      fwPill.className = 'pill ' + (fw.checking ? 'muted' : fw.ok ? 'good' : 'bad');
      fwRow.setHint(fw.ok === false ? fw.message || '' : '');
      fwCheck.disabled = !!fw.checking;
      fwFix.hidden = fw.checking || fw.ok !== false || !!fw.error;
      const w = s.wake || {};
      wakeSw.set(w.on === true);
      wakeSw.disable(!w.checked || w.on == null || !!w.busy);
      wakeRow.setHint(w.error ? w.error : w.busy ? 'Changing…' : !w.checked ? 'Checking…'
        : w.on == null ? 'No network adapter here can wake {me}'
          : 'Its network adapter wakes {me} on a magic packet. Asks for administrator rights to change it');
      sendToRow.setHint(s.peer ? 'Right-click files › Send to › ' + s.peer.name + ' (TwinDesk Mesh)' : 'Shows up once a computer is paired');
      const h = s.kvmState.helper;
      helperPill.textContent = h ? (h === 'starting' ? 'Starting…' : 'Not running') : 'Running';
      helperPill.className = 'pill ' + (h ? (h === 'starting' ? 'muted' : 'bad') : 'good');
      helperRow.setHint(h && h !== 'starting' ? h : '');
      const v = s.pcScreen.vdd;
      vddPill.textContent = !v.checked ? 'Checking…' : v.busy === 'install' ? 'Installing…' : v.busy === 'remove' ? 'Removing…' : v.installed ? 'Installed' : 'Not installed';
      vddPill.className = 'pill ' + (!v.checked || v.busy ? 'muted' : v.installed ? 'good' : 'bad');
      vddInstall.hidden = !v.checked || v.installed;
      vddInstall.disabled = !!v.busy;
      vddRow.setHint(v.message ? v.message : v.installed ? 'Adds the extra screen for Share screen › Extend'
        : 'Needed for Share screen › Extend. Asks for administrator rights once');
      const jn = (s.mesh || {}).autoJoin !== false;
      joinSw.set(jn);
      joinRow.setHint(jn ? 'Pair with one device and the rest of the mesh connects to this one by itself. Devices you pair with can introduce others'
        : 'Off: this PC neither introduces devices to each other nor accepts an introduction');
      const n = s.net || {};
      const radio = n.radio === 'off' ? 'Bluetooth is off in Windows settings'
        : n.radio === 'unsupported' ? 'This PC’s Bluetooth can’t do it (needs Bluetooth LE)' : '';
      bleSw.set(n.ble !== false);
      bleRow.setHint(n.ble === false ? 'Only phones on this network or a USB cable connect'
        : radio || 'A phone nearby connects through Bluetooth; files and screens switch to Wi-Fi Direct for a moment');
      blePcSw.set(n.blePc === true);
      bleWifiSw.set(n.bleWifiOff !== false);
      bleWifiRow.setHint(n.bleWifiOff === false ? 'Bluetooth stays on beside the Wi-Fi, the way back if it drops'
        : n.bleOff ? 'Off now: the session is on the same Wi-Fi. Bluetooth comes back when it ends'
          : 'On the same Wi-Fi network (not Wi-Fi Direct), Bluetooth goes off until the session ends. With a computer, phones can’t find this one meanwhile');
      blePcRow.setHint(n.blePc !== true ? 'Only computers on this network connect'
        : radio || 'A computer nearby connects through Bluetooth; files and screens switch to Wi-Fi Direct for a moment');
      btPill.textContent = n.radio === 'off' ? 'Off' : n.radio === 'unsupported' ? 'Not supported' : n.radio ? 'On' : 'Unknown';
      btPill.className = 'pill ' + (n.radio === 'off' || n.radio === 'unsupported' ? 'bad' : n.radio ? 'good' : 'muted');
      deviceName.textContent = s.device.name;
    };
  },
});

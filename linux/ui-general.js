// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General tab (same cards as the PC's): open at login, the switching popup, firewall self-check
// (+ Fix), wake from the network, the desktop session and input access (Wayland), the
// helper, Bluetooth for devices not on this network, this computer and Quit (some desktops have
// no tray to quit from).
'use strict';

UI.tab({
  id: 'general',
  order: 100,
  title: 'General',
  color: 'linear-gradient(#aeaeb2, #636366)',
  desc: '',
  bottom: true,
  badge: (s) => ((s.firewall && s.firewall.ok === false && !s.firewall.checking) || s.setup.missing.includes('input') ? 'warn' : ''),
  build(body) {
    const { el, api } = UI;
    const startup = UI.switch((v) => api.setStartup(v), { label: 'Open at login' });
    const lockScreenSw = UI.switch((v) => api.setKvm({ lockScreen: v }), { label: 'Control on display manager & lock screen' });
    const hudSw = UI.switch((v) => api.setApp({ hud: v }), { label: 'Show a popup when switching' });
    const fwPill = el('span', { class: 'pill' });
    const fwCheck = UI.button('Check again', () => api.checkFirewall(), 'small');
    const fwFix = UI.button('Fix', () => api.fixFirewall(), 'small primary');
    const fwRow = UI.row('Firewall', '', [fwPill, fwCheck, fwFix]);
    const wakeSw = UI.switch((v) => api.setWake(v), { label: 'Wake from the network' });
    const wakeRow = UI.row('Let the other computer wake {me}', '', [wakeSw]);
    const sessPill = el('span', { class: 'pill' });
    const sessRow = UI.row('Desktop session', '', [sessPill]);
    const inPill = el('span', { class: 'pill' });
    const inFix = UI.button('Fix', () => api.fixInput(), 'small primary');
    const inRow = UI.row('Input access', '', [inPill, inFix]);
    const helperPill = el('span', { class: 'pill' });
    const helperRow = UI.row('Mouse and keyboard helper', '', [helperPill]);
    const deviceName = el('span', { class: 'value' });
    const deviceRow = UI.row('Computer name', 'How other computers see this one', [deviceName]);
    // Bluetooth when not on the same network: with phones (on unless switched off), with computers (off unless switched on).
    const bleSw = UI.switch((v) => api.setNet({ ble: v }), { label: 'Bluetooth with phones' });
    const bleRow = UI.row('Bluetooth with phones', '', [bleSw]);
    const blePcSw = UI.switch((v) => api.setNet({ blePc: v }), { label: 'Bluetooth with computers' });
    const blePcRow = UI.row('Bluetooth with computers', '', [blePcSw]);
    // Bluetooth off altogether while the session is on the same Wi-Fi (blepolicy.js wifiQuiet).
    const bleWifiSw = UI.switch((v) => api.setNet({ bleWifiOff: v }), { label: 'Turn off Bluetooth on Wi-Fi connections' });
    const bleWifiRow = UI.row('Turn off Bluetooth on Wi-Fi connections', '', [bleWifiSw]);
    // Hosting Wi-Fi Direct beside this computer's own Wi-Fi network (wifi.js: a second interface, set up as root once).
    const keepSw = UI.switch((v) => api.setNet({ keepWifi: v }), { label: 'Keep Wi-Fi while hosting Wi-Fi Direct' });
    const keepSetup = UI.button('Set up', () => api.wifiSetup(), 'small');
    const keepRow = UI.row('Keep Wi-Fi while hosting Wi-Fi Direct', '', [keepSetup, keepSw]);
    // The same setup also keeps Bluetooth links this computer opens up through a second of silence (wifi.js bleTimeout).
    const steadySetup = UI.button('Set up', () => api.wifiSetup(), 'small');
    const steadyRow = UI.row('Steadier Bluetooth links', '', [steadySetup]);
    const btPill = el('span', { class: 'pill' });
    const btRow = UI.row('Bluetooth', 'For a phone or computer that isn’t on this network', [btPill, UI.button('Open', () => api.openBluetoothSettings(), 'small')]);

    body.append(
      UI.card('App', [
        UI.row('Open at login', 'Starts in the tray', [startup]),
        UI.row('Control on display manager & lock screen', 'Allow mouse and keyboard control on GDM/SDDM/LightDM and lock screen', [lockScreenSw]),
        UI.row('Show a popup when switching', 'When the mouse and keyboard move between computers', [hudSw]),
      ]),
      UI.card('Permissions', [fwRow, btRow, steadyRow]),
      UI.card('Network and sharing', [wakeRow, bleRow, blePcRow, bleWifiRow, keepRow]),
      UI.card('This computer', [deviceRow, sessRow, inRow, helperRow]),
      UI.card('Quit', [
        UI.row('Quit TwinDesk', 'Stops sharing until you open it again', [UI.button('Quit', () => api.quit(), 'small')]),
      ], { cls: 'keep-on' }),
    );

    return (s) => {
      startup.set(s.startup);
      lockScreenSw.set(s.kvm && s.kvm.lockScreen !== false);
      hudSw.set(s.app.hud);
      const fw = s.firewall || {};
      fwPill.textContent = fw.checking ? 'Checking…' : fw.ok ? 'OK' : fw.ok === false ? 'Needs a fix' : '';
      fwPill.className = 'pill ' + (fw.checking ? 'muted' : fw.ok ? 'good' : 'bad');
      fwRow.setHint(fw.checking ? '' : fw.message || '');
      fwCheck.disabled = !!fw.checking;
      fwFix.hidden = fw.checking || fw.ok !== false;
      const w = s.wake || {};
      wakeSw.set(w.on === true);
      wakeSw.disable(!w.checked || w.on == null || !!w.busy);
      wakeRow.setHint(w.error ? w.error : w.busy ? 'Changing…' : !w.checked ? 'Checking…'
        : w.on == null ? 'No wired network adapter here can wake {me}'
          : 'Its wired network adapter wakes {me} on a magic packet. Asks for your password to change it');

      const ss = s.session || {};
      const x11 = ss.type === 'x11';
      const wl = ss.type === 'wayland';
      sessPill.textContent = x11 ? 'X11' : wl ? 'Wayland' : 'Unknown';
      sessPill.className = 'pill ' + (x11 || wl ? 'good' : 'muted');
      sessRow.setHint([ss.desktop, ss.wsl ? 'WSL' : '', ss.input ? 'input through ' + (ss.input === 'uinput' ? 'uinput (Wayland)' : 'XInput2 and XTest') : ''].filter(Boolean).join(' · '));
      inRow.hidden = !wl;
      const a = ss.access || {};
      const ok = a.uinput && a.read;
      inPill.textContent = ok ? 'OK' : a.uinput ? 'Partly' : 'Needs a fix';
      inPill.className = 'pill ' + (ok ? 'good' : 'bad');
      inFix.hidden = ok;
      inRow.setHint(ss.inputNote || (ok ? 'Reads the mouse and keyboard for crossing; injects through uinput'
        : a.uinput ? 'Can be controlled, but can’t read the mouse and keyboard to cross over (log out and back in after Fix)'
          : 'Needed to share the mouse and keyboard on Wayland. Asks for your password once'));
      const h = s.kvmState.helper;
      helperPill.textContent = h ? (h === 'starting' ? 'Starting…' : 'Not running') : 'Running';
      helperPill.className = 'pill ' + (h ? (h === 'starting' ? 'muted' : 'bad') : 'good');
      helperRow.setHint(h && h !== 'starting' ? h : '');
      const n = s.net || {};
      const radio = h && h !== 'starting' ? 'Needs the helper running'
        : n.radio === 'off' ? 'Bluetooth is off in this computer’s settings'
          : n.radio === 'unsupported' ? 'This computer’s Bluetooth can’t do it (needs Bluetooth LE and BlueZ)' : '';
      bleSw.set(n.ble !== false);
      bleRow.setHint(n.ble === false ? 'Only phones on this network or a USB cable connect'
        : radio || 'A phone nearby connects through Bluetooth; files and screens switch to Wi-Fi for a moment');
      blePcSw.set(n.blePc === true);
      bleWifiSw.set(n.bleWifiOff !== false);
      bleWifiRow.setHint(n.bleWifiOff === false ? 'Bluetooth stays on beside the Wi-Fi, the way back if it drops'
        : n.bleOff ? 'Off now: the session is on the same Wi-Fi. Bluetooth comes back when it ends'
          : 'On the same Wi-Fi network (not Wi-Fi Direct), Bluetooth goes off until the session ends. With a computer, phones can’t find this one meanwhile');
      blePcRow.setHint(n.blePc !== true ? 'Only computers on this network connect'
        : radio || 'A computer nearby connects through Bluetooth; files and screens switch to Wi-Fi for a moment');
      const sd = n.side || {};
      steadyRow.hidden = !!sd.current || (n.ble === false && n.blePc !== true) || n.radio === 'unsupported';
      steadySetup.disabled = sd.setup === 'asking';
      steadyRow.setHint(sd.setup === 'asking' ? 'Waiting for your password…'
        : sd.setup && sd.setup !== 'declined' ? `Setup didn’t work: ${sd.setup}`
          : 'A phone or Mac busy with Wi-Fi for a moment stays connected (5 s before a Bluetooth link counts as lost, not 0.4 s). Asks for your password once');
      keepRow.hidden = !sd.possible;
      keepSw.set(sd.keep !== false);
      keepSetup.hidden = !!sd.ready || sd.keep === false;
      keepSetup.disabled = sd.setup === 'asking';
      keepRow.setHint(sd.keep === false ? 'Hosting Wi-Fi Direct takes this computer off its Wi-Fi network until it ends'
        : sd.setup === 'asking' ? 'Waiting for your password…'
          : sd.ready ? 'Wi-Fi Direct runs on a second interface beside this computer’s Wi-Fi network, which stays connected'
            : sd.setup === 'declined' ? 'Not set up: the password prompt was cancelled. Until it is, hosting takes this computer off its Wi-Fi network'
              : sd.setup ? `Setup didn’t work: ${sd.setup}`
                : 'This Wi-Fi adapter can host beside its network. Asks for your password once (the first time it’s needed, or Set up)');
      btPill.textContent = n.radio === 'off' ? 'Off' : n.radio === 'unsupported' ? 'Not supported' : n.radio === 'idle' ? 'Idle' : n.radio ? 'On' : 'Unknown';
      btPill.className = 'pill ' + (n.radio === 'off' || n.radio === 'unsupported' ? 'bad' : n.radio === 'idle' ? 'muted' : n.radio ? 'good' : 'muted');
      deviceName.textContent = s.device.name;
    };
  },
});

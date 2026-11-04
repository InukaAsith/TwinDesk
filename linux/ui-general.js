// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General tab (same cards as the PC's): open at login, the switching popup, firewall self-check
// (+ Fix), wake from the network, the desktop session and input access (Wayland), the
// helper, Bluetooth for devices not on this network, this computer and Quit (some desktops have
// no tray to quit from).
'use strict';

UI.tab({
  id: 'general',
  order: 100,
  title: I18n.t('General'),
  color: 'linear-gradient(#aeaeb2, #636366)',
  desc: '',
  bottom: true,
  badge: (s) => ((s.firewall && s.firewall.ok === false && !s.firewall.checking) || s.setup.missing.includes('input') ? 'warn' : ''),
  build(body) {
    const { el, api } = UI;
    const t = (...args) => I18n.t(...args);
    const language = UI.select([
      { value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' }, { value: 'ru', label: 'Русский' }, { value: 'tr', label: 'Türkçe' },
    ], (v) => api.setLanguage(v));
    language.set(I18n.locale);
    const startup = UI.switch((v) => api.setStartup(v), { label: t('Open at login') });
    // Received files (shared/received.js): where files sent here and saved from a phone go.
    const recvChange = UI.button(t('Change…'), () => api.chooseReceivedFolder(), 'small');
    const recvReset = UI.button(t('Downloads'), () => api.resetReceivedFolder(), 'small');
    const recvOpen = UI.button(t('Open'), () => api.openReceivedFolder(), 'small');
    const recvRow = UI.row(t('Received files'), '', [recvOpen, recvReset, recvChange], { literal: true });
    const hudSw = UI.switch((v) => api.setApp({ hud: v }), { label: t('Show a popup when switching') });
    const fwPill = el('span', { class: 'pill' });
    const fwCheck = UI.button(t('Check again'), () => api.checkFirewall(), 'small');
    const fwFix = UI.button(t('Fix'), () => api.fixFirewall(), 'small primary');
    const fwRow = UI.row(t('Firewall'), '', [fwPill, fwCheck, fwFix], { literal: true });
    const wakeSw = UI.switch((v) => api.setWake(v), { label: t('Wake from the network') });
    const wakeRow = UI.row(t('Let the other computer wake {me}'), '', [wakeSw]);
    const sessPill = el('span', { class: 'pill' });
    const sessRow = UI.row(t('Desktop session'), '', [sessPill], { literal: true });
    const inPill = el('span', { class: 'pill' });
    const inFix = UI.button(t('Fix'), () => api.fixInput(), 'small primary');
    const inRow = UI.row(t('Input access'), '', [inPill, inFix], { literal: true });
    const helperPill = el('span', { class: 'pill' });
    const helperRow = UI.row(t('Mouse and keyboard helper'), '', [helperPill]);
    const deviceName = el('span', { class: 'value', attrs: { 'data-literal': '' } });
    const deviceRow = UI.row(t('Computer name'), t('How other computers see this one'), [deviceName]);
    // Bluetooth when not on the same network: with phones (on unless switched off), with computers (off unless switched on).
    const bleSw = UI.switch((v) => api.setNet({ ble: v }), { label: t('Bluetooth with phones') });
    const bleRow = UI.row(t('Bluetooth with phones'), '', [bleSw]);
    const blePcSw = UI.switch((v) => api.setNet({ blePc: v }), { label: t('Bluetooth with computers') });
    const blePcRow = UI.row(t('Bluetooth with computers'), '', [blePcSw]);
    // Bluetooth off altogether while the session is on the same Wi-Fi (blepolicy.js wifiQuiet).
    const bleWifiSw = UI.switch((v) => api.setNet({ bleWifiOff: v }), { label: t('Turn off Bluetooth on Wi-Fi connections') });
    const bleWifiRow = UI.row(t('Turn off Bluetooth on Wi-Fi connections'), '', [bleWifiSw]);
    // Hosting Wi-Fi Direct beside this computer's own Wi-Fi network (wifi.js: a second interface, set up as root once).
    const keepSw = UI.switch((v) => api.setNet({ keepWifi: v }), { label: t('Keep Wi-Fi while hosting Wi-Fi Direct') });
    const keepSetup = UI.button(t('Set up'), () => api.wifiSetup(), 'small');
    const keepRow = UI.row(t('Keep Wi-Fi while hosting Wi-Fi Direct'), '', [keepSetup, keepSw]);
    // The same setup also keeps Bluetooth links this computer opens up through a second of silence (wifi.js bleTimeout).
    const steadySetup = UI.button(t('Set up'), () => api.wifiSetup(), 'small');
    const steadyRow = UI.row(t('Steadier Bluetooth links'), '', [steadySetup], { literal: true });
    const btPill = el('span', { class: 'pill' });
    const btRow = UI.row(t('Bluetooth'), t('For a phone or computer that isn’t on this network'), [btPill, UI.button(t('Open'), () => api.openBluetoothSettings(), 'small')]);

    const media = UI.mediaControlsRow(); // a phone's media controls on the Phone page (shared/ui-nowplaying.js)
    // Appearance: the phone's wallpaper (settings.phone.wallpaper, was on the Phone page).
    const wallSw = UI.switch((v) => api.setPhone({ wallpaper: v }), { label: t('Show the phone’s wallpaper') });
    const wallRow = UI.row(t('Show the phone’s wallpaper'), t('On its tile and Overview. TwinDesk on the phone reads it once wireless debugging is set up'), [wallSw]);
    // Overview: what it shows (settings.ui.overview).
    const parts = [['media', t('Now playing'), t('What plays on the phone, with its controls')], ['qs', t('Quick actions'), t('Wi-Fi, Bluetooth, torch, Do not disturb and more, with volume and ringer')],
      ['notifs', t('Latest notifications'), t('The newest few, with Copy for one-time codes')], ['apps', t('Most used apps'), t('The phone’s most used apps this week')],
      ['clipboard', t('Clipboard'), t('Its recent items, while Clipboard is on')], ['files', t('Send files'), t('A drop zone that sends files to the device')]];
    const partSw = {};
    const partRows = parts.map(([k, label, hint]) => {
      partSw[k] = UI.switch((v) => api.setOverview && api.setOverview({ [k]: v }), { label });
      return UI.row(label, hint, [partSw[k]]);
    });
    // Theme and accent colour (shared/look.js, shared/ui-look.js).
    const themeRow = UI.themeRow((v) => api.setLook({ theme: v }));
    const accentRow = UI.accentRow((v) => api.setLook({ accent: v }));
    // One page that scrolls, its sections listed beside it; Permissions first.
    // Advanced: how input travels (shared/inputlane.js). UDP (tdv2, the default): moves on their own
    // lane beside the session. TCP (tdv1): everything on the session. Read at startup, so Restart shows.
    let protoStart = null; // the protocol this run started with
    const protoRestart = UI.button(t('Restart'), () => api.relaunch(), 'small');
    protoRestart.hidden = true;
    const protoSel = UI.select([
      { value: 'udp', label: t('UDP (tdv2)') }, { value: 'tcp', label: t('TCP (tdv1)') },
    ], (v) => { api.setApp({ inputProtocol: v }); protoRestart.hidden = v === protoStart; });
    const protoRow = UI.row(t('Input protocol'), t('UDP moves the pointer faster. TCP works on networks that block UDP. Applies after a restart'), [protoSel, protoRestart]);
    const sections = UI.sections([
      UI.card(t('Permissions'), [fwRow, btRow, steadyRow]),
      UI.card(t('Startup'), [
        UI.row(t('Open at login'), t('Starts in the tray'), [startup]),
        recvRow,
      ]),
      UI.card(t('Appearance'), [
        themeRow,
        accentRow,
        UI.row(t('Show a popup when switching'), t('When the mouse and keyboard move between devices'), [hudSw]),
        wallRow,
        media.el,
      ]),
      UI.card(t('Language'), [
        UI.row(t('Language'), t('Some pages are still in English. Changing the language reloads this window.'), [language]),
      ]),
      UI.card(t('Overview'), partRows),
      UI.card(t('Network and Bluetooth'), [bleRow, blePcRow, bleWifiRow, wakeRow, keepRow]),
      UI.card(t('This computer'), [deviceRow, sessRow, inRow, helperRow]),
      UI.card(t('Advanced'), [protoRow]),
      UI.card(t('Quit'), [
        UI.row(t('Quit TwinDesk'), t('Stops sharing until you open it again'), [UI.button(t('Quit'), () => api.quit(), 'small')]),
      ], { cls: 'keep-on' }),
    ]);
    body.append(sections);

    return (s) => {
      if (s.app) {
        const proto = s.app.inputProtocol === 'tcp' ? 'tcp' : 'udp';
        if (protoStart === null) protoStart = proto;
        protoSel.set(proto);
        protoRestart.hidden = proto === protoStart;
      }
      themeRow.render(s.look && s.look.theme);
      accentRow.render(s.look);
      sections.spy();
      media.update(s);
      wallSw.set(!s.phone || !s.phone.settings || s.phone.settings.wallpaper !== false);
      const ov = (s.ui && s.ui.overview) || {};
      for (const k of Object.keys(partSw)) partSw[k].set(ov[k] !== false);
      startup.set(s.startup);
      hudSw.set(s.app.hud);
      const f = s.files || {};
      recvReset.hidden = !f.receivedFolder;
      const receivedDescription = t('Files sent to {me} from another computer or a phone, and what’s saved from a phone’s Files and Photos', { me: s.device.name });
      recvRow.setHint(f.receivedFolder && f.received !== f.receivedFolder
        ? t('{folder} isn’t there now: Downloads meanwhile. {description}', { folder: f.receivedFolder, description: receivedDescription })
        : t('{folder} · {description}', { folder: f.received || t('Downloads'), description: receivedDescription }));
      const fw = s.firewall || {};
      fwPill.textContent = fw.checking ? t('Checking…') : fw.ok ? t('OK') : fw.ok === false ? t('Needs a fix') : '';
      fwPill.className = 'pill ' + (fw.checking ? 'muted' : fw.ok ? 'good' : 'bad');
      fwRow.setHint(fw.checking ? '' : fw.message ? t(fw.message) : '');
      fwCheck.disabled = !!fw.checking;
      fwFix.hidden = fw.checking || fw.ok !== false;
      const w = s.wake || {};
      wakeSw.set(w.on === true);
      wakeSw.disable(!w.checked || w.on == null || !!w.busy);
      wakeRow.setHint(w.error ? t(w.error) : w.busy ? t('Changing…') : !w.checked ? t('Checking…')
        : w.on == null ? t('No wired network adapter here can wake {me}')
          : t('Its wired network adapter wakes {me} on a magic packet. Asks for your password to change it'));

      const ss = s.session || {};
      const x11 = ss.type === 'x11';
      const wl = ss.type === 'wayland';
      sessPill.textContent = x11 ? 'X11' : wl ? 'Wayland' : t('Unknown');
      sessPill.className = 'pill ' + (x11 || wl ? 'good' : 'muted');
      sessRow.setHint([ss.desktop, ss.wsl ? 'WSL' : '', ss.input ? t('input through {how}', { how: ss.input === 'uinput' ? t('uinput (Wayland)') : t('XInput2 and XTest') }) : ''].filter(Boolean).join(' · '));
      inRow.hidden = !wl;
      const a = ss.access || {};
      const ok = a.uinput && a.read;
      inPill.textContent = ok ? t('OK') : a.uinput ? t('Partly') : t('Needs a fix');
      inPill.className = 'pill ' + (ok ? 'good' : 'bad');
      inFix.hidden = ok;
      inRow.setHint(ss.inputNote ? t(ss.inputNote) : ok ? t('Reads the mouse and keyboard for crossing; injects through uinput')
        : a.uinput ? t('Can be controlled, but can’t read the mouse and keyboard to cross over (log out and back in after Fix)')
          : t('Needed to share the mouse and keyboard on Wayland. Asks for your password once'));
      const h = s.kvmState.helper;
      helperPill.textContent = h ? (h === 'starting' ? t('Starting…') : t('Not running')) : t('Running');
      helperPill.className = 'pill ' + (h ? (h === 'starting' ? 'muted' : 'bad') : 'good');
      helperRow.setHint(h && h !== 'starting' ? t(h) : '');
      const n = s.net || {};
      const radio = h && h !== 'starting' ? t('Needs the helper running')
        : n.radio === 'off' ? t('Bluetooth is off in this computer’s settings')
          : n.radio === 'unsupported' ? t('This computer’s Bluetooth can’t do it (needs Bluetooth LE and BlueZ)') : '';
      bleSw.set(n.ble !== false);
      bleRow.setHint(n.ble === false ? t('Only phones on this network or a USB cable connect')
        : radio || t('A phone nearby connects through Bluetooth; files and screens switch to Wi-Fi for a moment'));
      blePcSw.set(n.blePc === true);
      bleWifiSw.set(n.bleWifiOff !== false);
      bleWifiRow.setHint(n.bleWifiOff === false ? t('Bluetooth stays on beside the Wi-Fi, the way back if it drops')
        : n.bleOff ? t('Off now: the session is on the same Wi-Fi. Bluetooth comes back when it ends')
          : t('On the same Wi-Fi network (not Wi-Fi Direct), Bluetooth goes off until the session ends. With a computer, phones can’t find this one meanwhile'));
      blePcRow.setHint(n.blePc !== true ? t('Only computers on this network connect')
        : radio || t('A computer nearby connects through Bluetooth; files and screens switch to Wi-Fi for a moment'));
      const sd = n.side || {};
      steadyRow.hidden = !!sd.current || (n.ble === false && n.blePc !== true) || n.radio === 'unsupported';
      steadySetup.disabled = sd.setup === 'asking';
      steadyRow.setHint(sd.setup === 'asking' ? t('Waiting for your password…')
        : sd.setup && sd.setup !== 'declined' ? t('Setup didn’t work: {error}', { error: sd.setup })
          : t('A phone or Mac busy with Wi-Fi for a moment stays connected (5 s before a Bluetooth link counts as lost, not 0.4 s). Asks for your password once'));
      keepRow.hidden = !sd.possible;
      keepSw.set(sd.keep !== false);
      keepSetup.hidden = !!sd.ready || sd.keep === false;
      keepSetup.disabled = sd.setup === 'asking';
      keepRow.setHint(sd.keep === false ? t('Hosting Wi-Fi Direct takes this computer off its Wi-Fi network until it ends')
        : sd.setup === 'asking' ? t('Waiting for your password…')
          : sd.ready ? t('Wi-Fi Direct runs on a second interface beside this computer’s Wi-Fi network, which stays connected')
            : sd.setup === 'declined' ? t('Not set up: the password prompt was cancelled. Until it is, hosting takes this computer off its Wi-Fi network')
              : sd.setup ? t('Setup didn’t work: {error}', { error: sd.setup })
                : t('This Wi-Fi adapter can host beside its network. Asks for your password once (the first time it’s needed, or Set up)'));
      btPill.textContent = n.radio === 'off' ? t('Off') : n.radio === 'unsupported' ? t('Not supported') : n.radio === 'idle' ? t('Idle') : n.radio ? t('On') : t('Unknown');
      btPill.className = 'pill ' + (n.radio === 'off' || n.radio === 'unsupported' ? 'bad' : n.radio === 'idle' ? 'muted' : n.radio ? 'good' : 'muted');
      deviceName.textContent = s.device.name;
    };
  },
});

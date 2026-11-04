// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General tab, in sections: Startup (start with Windows, received files), Appearance (the switching
// popup, the phone's wallpaper, media controls), Overview (what it shows), Network and Bluetooth,
// Permissions (firewall self-check + Fix, Bluetooth, Location) and This computer (its name, the
// helper, the virtual display driver for Extend).
'use strict';

UI.tab({
  id: 'general',
  order: 100,
  title: I18n.t('General'),
  color: 'linear-gradient(#aeaeb2, #636366)',
  desc: '',
  bottom: true,
  badge: (s) => (s.firewall && s.firewall.ok === false && !s.firewall.checking ? 'warn' : ''),
  build(body) {
    const { el, api } = UI;
    const t = (...args) => I18n.t(...args);
    const language = UI.select([
      { value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' }, { value: 'ru', label: 'Русский' }, { value: 'tr', label: 'Türkçe' },
    ], (v) => api.setLanguage(v));
    language.set(I18n.locale);
    const startup = UI.switch((v) => api.setStartup(v), { label: t('Start with Windows') });
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
    // (as the Mac): wake is a switch; Send to sends files from Explorer.
    const wakeSw = UI.switch((v) => api.setWake(v), { label: t('Wake from the network') });
    const wakeRow = UI.row(t('Let the other computer wake {me}'), '', [wakeSw]);
    const sendToRow = UI.row(t('TwinDesk in Send to'), '', [], { literal: true });
    const helperPill = el('span', { class: 'pill' });
    const helperRow = UI.row(t('Mouse and keyboard helper'), '', [helperPill]);
    const vddPill = el('span', { class: 'pill' });
    const vddInstall = UI.button(t('Install'), () => api.installVdd(), 'small primary');
    const vddRow = UI.row(t('Virtual display driver'), '', [vddPill, vddInstall]); // Share screen › Extend (vdd.js)
    // Bluetooth when not on the same network: with phones (on unless switched off), with computers (off unless switched on).
    const bleSw = UI.switch((v) => api.setNet({ ble: v }), { label: t('Bluetooth with phones') });
    const bleRow = UI.row(t('Bluetooth with phones'), '', [bleSw]);
    const blePcSw = UI.switch((v) => api.setNet({ blePc: v }), { label: t('Bluetooth with computers') });
    const blePcRow = UI.row(t('Bluetooth with computers'), '', [blePcSw]);
    // Bluetooth off altogether while the session is on the same Wi-Fi (blepolicy.js wifiQuiet).
    const bleWifiSw = UI.switch((v) => api.setNet({ bleWifiOff: v }), { label: t('Turn off Bluetooth on Wi-Fi connections') });
    const bleWifiRow = UI.row(t('Turn off Bluetooth on Wi-Fi connections'), '', [bleWifiSw]);
    // What Windows has to allow, in one place (each is also asked for where a feature needs it).
    const btPill = el('span', { class: 'pill' });
    const btRow = UI.row(t('Bluetooth'), t('For a phone or computer that isn’t on this network'), [btPill, UI.button(t('Open'), () => api.openBluetoothSettings(), 'small')]);
    const locRow = UI.row(t('Location'), t('To join a phone’s or computer’s Wi-Fi Direct (Windows shows Wi-Fi networks only with it)'), [UI.button(t('Open'), () => api.netLocation(), 'small')]);
    const media = UI.mediaControlsRow(); // a phone's media controls on the Phone page (shared/ui-nowplaying.js)
    const deviceName = el('span', { class: 'value', attrs: { 'data-literal': '' } });
    const deviceRow = UI.row(t('Computer name'), t('How other computers see this one'), [deviceName]);

    // Appearance: the phone's wallpaper behind it here (settings.phone.wallpaper, was on the Phone page).
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
    // Hardware encoder (windows/encoder.js, #133): the GPU's, or OpenH264 in software. Read at startup too.
    const encRestart = UI.button(t('Restart'), () => api.relaunch(), 'small');
    encRestart.hidden = true;
    const encSw = UI.switch((v) => api.setEncoder(v), { label: t('Hardware encoder') });
    const encRow = UI.row(t('Hardware encoder'), t('Shares the screen and app windows with the graphics card. Off: in software (OpenH264), for a picture that stalls or goes black. Applies after a restart'), [encSw, encRestart]);
    const sections = UI.sections([
      UI.card(t('Permissions'), [fwRow, btRow, locRow]),
      UI.card(t('Startup'), [
        UI.row(t('Start with Windows'), t('TwinDesk waits in the tray'), [startup]),
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
      UI.card(t('Network and Bluetooth'), [bleRow, blePcRow, bleWifiRow, wakeRow, sendToRow]),
      UI.card(t('This computer'), [deviceRow, helperRow, vddRow]),
      UI.card(t('Advanced'), [protoRow, ...(api.setEncoder ? [encRow] : [])]),
    ]);
    body.append(sections);

    return (s) => {
      if (s.app) {
        const proto = s.app.inputProtocol === 'tcp' ? 'tcp' : 'udp';
        if (protoStart === null) protoStart = proto;
        protoSel.set(proto);
        protoRestart.hidden = proto === protoStart;
      }
      if (s.encoder) {
        encSw.set(s.encoder.hw !== false);
        encRestart.hidden = !s.encoder.restart;
        if (s.encoder.auto && !s.encoder.restart) encRow.setHint(t('Turned off by itself: the hardware encoder stopped sending. Software encoding (OpenH264) is in use'));
        else if (s.encoder.auto) encRow.setHint(t('Turned off by itself: the hardware encoder stopped sending. Restart to use the software encoder (OpenH264)'));
        else encRow.setHint(t('Shares the screen and app windows with the graphics card. Off: in software (OpenH264), for a picture that stalls or goes black. Applies after a restart'));
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
      fwRow.setHint(fw.ok === false ? UI.firewallHint(fw) : '');
      fwCheck.disabled = !!fw.checking;
      fwFix.hidden = fw.checking || fw.ok !== false || !!fw.error;
      const w = s.wake || {};
      wakeSw.set(w.on === true);
      wakeSw.disable(!w.checked || w.on == null || !!w.busy);
      wakeRow.setHint(w.error ? t(w.error) : w.busy ? t('Changing…') : !w.checked ? t('Checking…')
        : w.on == null ? t('No network adapter here can wake {me}')
          : t('Its network adapter wakes {me} on a magic packet. Asks for administrator rights to change it'));
      sendToRow.setHint(s.peer ? t('Right-click files › Send to › {device} (TwinDesk)', { device: s.peer.name }) : t('Shows up once a computer is paired'));
      const h = s.kvmState.helper;
      helperPill.textContent = h ? (h === 'starting' ? t('Starting…') : t('Not running')) : t('Running');
      helperPill.className = 'pill ' + (h ? (h === 'starting' ? 'muted' : 'bad') : 'good');
      helperRow.setHint(h && h !== 'starting' ? t(h) : '');
      const v = s.pcScreen.vdd;
      vddPill.textContent = !v.checked ? t('Checking…') : v.busy === 'install' ? t('Installing…') : v.busy === 'remove' ? t('Removing…') : v.installed ? t('Installed') : t('Not installed');
      vddPill.className = 'pill ' + (!v.checked || v.busy ? 'muted' : v.installed ? 'good' : 'bad');
      vddInstall.hidden = !v.checked || v.installed;
      vddInstall.disabled = !!v.busy;
      vddRow.setHint(v.message ? t(v.message) : v.installed ? t('Adds the extra screen for Share screen › Extend')
        : t('Needed for Share screen › Extend. Asks for administrator rights once'));
      const n = s.net || {};
      const radio = n.radio === 'off' ? t('Bluetooth is off in Windows settings')
        : n.radio === 'unsupported' ? t('This PC’s Bluetooth can’t do it (needs Bluetooth LE)') : '';
      bleSw.set(n.ble !== false);
      bleRow.setHint(n.ble === false ? t('Only phones on this network or a USB cable connect')
        : radio || t('A phone nearby connects through Bluetooth; files and screens switch to Wi-Fi Direct for a moment'));
      blePcSw.set(n.blePc === true);
      bleWifiSw.set(n.bleWifiOff !== false);
      bleWifiRow.setHint(n.bleWifiOff === false ? t('Bluetooth stays on beside the Wi-Fi, the way back if it drops')
        : n.bleOff ? t('Off now: the session is on the same Wi-Fi. Bluetooth comes back when it ends')
          : t('On the same Wi-Fi network (not Wi-Fi Direct), Bluetooth goes off until the session ends. With a computer, phones can’t find this one meanwhile'));
      blePcRow.setHint(n.blePc !== true ? t('Only computers on this network connect')
        : radio || t('A computer nearby connects through Bluetooth; files and screens switch to Wi-Fi Direct for a moment'));
      btPill.textContent = n.radio === 'off' ? t('Off') : n.radio === 'unsupported' ? t('Not supported') : n.radio ? t('On') : t('Unknown');
      btPill.className = 'pill ' + (n.radio === 'off' || n.radio === 'unsupported' ? 'bad' : n.radio ? 'good' : 'muted');
      deviceName.textContent = s.device.name;
    };
  },
});

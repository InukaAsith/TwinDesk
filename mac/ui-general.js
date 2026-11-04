// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// General tab: permissions, app behaviour.
'use strict';

UI.tab({
  id: 'general',
  order: 100,
  title: I18n.t('General'),
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
    const t = (...args) => I18n.t(...args);
    const language = UI.select([
      { value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' }, { value: 'ru', label: 'Русский' }, { value: 'tr', label: 'Türkçe' },
    ], (v) => api.setLanguage(v));
    language.set(I18n.locale);
    const PERMS = [
      { kind: 'screen', label: t('Screen Recording'), note: t('To share your screen') },
      { kind: 'accessibility', label: t('mac.accessibility'), note: t('So the other computer can control this one') },
      { kind: 'inputMonitoring', label: t('Input Monitoring'), note: t('To use this keyboard on the other computer') },
      // Every other permission a feature uses, in one place (each is asked for when the feature is used).
      { kind: 'localNetwork', label: t('Local Network'), note: t('To find your other computers and phones'), state: (s) => (s.discovery ? s.discovery.localNetwork !== false : null) },
      { kind: 'bluetooth', label: t('Bluetooth'), note: t('For a phone or computer that isn’t on this network'), state: (s) => (s.net && s.net.radio ? s.net.radio !== 'denied' && s.net.radio !== 'unauthorized' : null) },
      { kind: 'location', label: t('Location'), note: t('To join a phone’s or PC’s Wi-Fi Direct (macOS shows Wi-Fi networks only with it)'), state: () => null },
      { kind: 'fullDisk', label: t('Full Disk Access'), note: t('Optional: to share any folder with the other computer'), state: () => null },
    ];
    const perms = PERMS.map((p) => {
      const pill = el('span', { class: 'pill' });
      const row = UI.row(p.label, p.note, [pill, UI.button(t('Open'), () => api.openSettings(p.kind), 'small')]);
      return { p, pill, row };
    });
    const helperRow = UI.row(t('Background helper'), '');
    const helperVal = el('span', { class: 'value' });
    helperRow.querySelector('.controls').append(helperVal);
    const deviceName = el('span', { class: 'value', attrs: { 'data-literal': '' } });
    const deviceRow = UI.row(t('Computer name'), t('How other computers see this one'), [deviceName]);
    const loginSw = UI.switch((v) => api.setApp({ openAtLogin: v }), { label: t('Open at login') });
    const awakeSw = UI.switch((v) => api.setApp({ keepAwake: v }), { label: t('Keep the display awake') });
    const hudSw = UI.switch((v) => api.setApp({ hud: v }), { label: t('Show a popup when switching') });
    // Wake this Mac from the other computer; the Share menu entry.
    const wakeSw = UI.switch((v) => api.setWakeOnLan(v), { label: t('Wake from the network') });
    const wakeRow = UI.row(t('Let {name} wake {me}'), '', [wakeSw]);
    // Bluetooth when not on the same network: with phones (on unless switched off), with computers (off unless switched on).
    const bleSw = UI.switch((v) => api.setNet({ ble: v }), { label: t('Bluetooth with phones') });
    const bleRow = UI.row(t('Bluetooth with phones'), '', [bleSw]);
    const blePcSw = UI.switch((v) => api.setNet({ blePc: v }), { label: t('Bluetooth with computers') });
    const blePcRow = UI.row(t('Bluetooth with computers'), '', [blePcSw]);
    // Bluetooth off altogether while the session is on the same Wi-Fi (blepolicy.js wifiQuiet).
    const bleWifiSw = UI.switch((v) => api.setNet({ bleWifiOff: v }), { label: t('Turn off Bluetooth on Wi-Fi connections') });
    const bleWifiRow = UI.row(t('Turn off Bluetooth on Wi-Fi connections'), '', [bleWifiSw]);
    const shareRow = UI.row(t('TwinDesk in the Share menu'), t('Share › TwinDesk sends files to the other computer'),
      [UI.button(t('Extensions…'), () => api.openSettings('extensions'), 'small')]);

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
      partSw[k] = UI.switch((v) => api.setOverview({ [k]: v }), { label });
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
      UI.card(t('Permissions'), [
        ...perms.map((x) => x.row),
        UI.row(t('Changed a permission?'), t('Restart to apply it'), [UI.button(t('Restart'), () => api.relaunch(), 'small')]),
      ]),
      UI.card(t('Startup'), [
        UI.row(t('Open at login'), '', [loginSw]),
        UI.row(t('Keep the display awake'), t('While connected'), [awakeSw]),
      ]),
      UI.card(t('Appearance'), [
        themeRow,
        accentRow,
        UI.row(t('Show a popup when switching'), t('When the mouse and keyboard move between devices'), [hudSw]),
        wallRow,
        media.el,
      ]),
      UI.card(t('Language'), [
        UI.row(t('Language'), t('Changing the language reloads this window.'), [language]),
      ]),
      UI.card(t('Overview'), partRows),
      UI.card(t('Network and Bluetooth'), [bleRow, blePcRow, bleWifiRow, wakeRow, shareRow]),
      UI.card(t('This computer'), [deviceRow, helperRow]),
      UI.card(t('Advanced'), [protoRow]),
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
      for (const { p, pill } of perms) {
        const v = p.state ? p.state(s) : s.permissions[p.kind];
        const ok = p.kind === 'screen' ? v === 'granted' : v === true;
        const unknown = v === null || v === undefined || v === 'unknown';
        pill.className = `pill ${unknown ? 'muted' : ok ? 'good' : 'bad'}`;
        // macOS counts Accessibility as enough for TwinDesk's keyboard tap: Input Monitoring reads
        // as allowed then, with its own switch in System Settings still off (that's fine).
        const viaAx = p.kind === 'inputMonitoring' && ok && s.permissions.accessibility === true;
        pill.hidden = unknown && !!p.state; // macOS doesn't tell: Open shows it
        pill.textContent = unknown ? t('Unknown') : viaAx ? t('Allowed by Accessibility') : ok ? t('Allowed') : t('Not allowed');
      }
      if (s.app) {
        loginSw.set(s.app.openAtLogin);
        awakeSw.set(s.app.keepAwake);
        hudSw.set(s.app.hud !== false);
      }
      const w = s.wake || {};
      wakeSw.set(w.womp === true);
      wakeSw.disable(w.womp == null);
      wakeRow.setHint(w.womp == null ? t('Checking…') : t('Wake for network access. Asks for your password to change it'));
      if (s.net) {
        bleSw.set(s.net.ble);
        blePcSw.set(s.net.blePc === true);
        bleWifiSw.set(s.net.bleWifiOff !== false);
        bleWifiRow.setHint(s.net.bleWifiOff === false ? t('Bluetooth stays on beside the Wi-Fi, the way back if it drops')
          : s.net.bleOff ? t('Off now: the session is on the same Wi-Fi. Bluetooth comes back when it ends')
            : t('On the same Wi-Fi network (not Wi-Fi Direct), Bluetooth goes off until the session ends. With a computer, phones can’t find this one meanwhile'));
        const RADIO = { off: t('Bluetooth is off'), unauthorized: t('Allow TwinDesk in System Settings › Privacy & Security › Bluetooth'), unsupported: t('This Mac can’t advertise over Bluetooth') };
        bleRow.setHint(!s.net.ble ? t('Only phones on this network or a USB cable connect')
          : RADIO[s.net.radio] || t('Phones nearby connect over Bluetooth. Files and screens move to a direct Wi-Fi link for a while'));
        blePcRow.setHint(s.net.blePc !== true ? t('Only computers on this network connect')
          : RADIO[s.net.radio] || t('PCs nearby connect over Bluetooth. Files and screens move to a direct Wi-Fi link for a while'));
      }
      helperVal.textContent = s.helper && s.helper.running ? t('Running') : t('Not running');
      deviceName.textContent = s.macName || '';
    };
  },
});

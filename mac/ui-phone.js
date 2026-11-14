// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Phone page (opened from the phone tile above Overview): the connected phone, its screen in a
// window, its apps in windows of their own, wireless debugging setup, and Disconnect.
'use strict';

UI.tab({
  id: 'phone',
  order: -1,
  navHidden: true, // the phone tile in the sidebar opens it
  title: I18n.t('Phone'),
  heading: I18n.t('Phone'),
  desc: '',
  color: 'linear-gradient(#34c759, #248a3d)',
  build(body, page) {
    const { el, api } = UI;
    const messageText = UI.adbMessage;
    const h1 = page.querySelector('h1 span');
    const desc = page.querySelector('.page-head p');

    // ---- hero ----
    const dev = el('div', { class: 'device phone big' });
    const name = el('div', { class: 'hero-name' });
    const sub = el('div', { class: 'hero-status' });
    const showBtn = UI.button(I18n.t('Show Phone Screen'), () => api.phoneScreen(true), 'primary');
    const discBtn = UI.button(I18n.t('Disconnect'), () => api.disconnectPhone());
    // On Bluetooth: onto a direct Wi-Fi link on request, until Back to Bluetooth (netlink.js 'user').
    let wifiOn = false;
    const wifiBtn = UI.button(I18n.t('Connect with Wi-Fi Direct'), () => api.netWifi(!wifiOn));
    const hotspotBtn = UI.button(I18n.t('Connect with hotspot'), () => api.netWifi('hotspot')); // its hotspot, this Mac joins
    // How the mouse and keyboard reach the phone (settings.phone.input; the phone's own toggle too).
    const via = UI.segmented([
      { value: 'adb', label: 'ADB', title: I18n.t('Wireless debugging: full control') },
      { value: 'phone', label: I18n.t('Accessibility'), title: I18n.t('TwinDesk on the phone taps and types itself, over Wi-Fi, Wi-Fi Direct or Bluetooth. No developer options') },
    ], (v) => api.setPhone({ input: v, inputPicked: true })); // picked: no longer automatic
    // What plays on the phone, on the card's right, while it plays (shared/ui-nowplaying.js).
    const media = UI.nowPlaying();
    const hero = el('div', { class: 'card hero phone-hero' }, [
      dev,
      el('div', { class: 'phone-hero-text' }, [
        name, sub,
        el('div', { class: 'phone-hero-actions' }, [showBtn, wifiBtn, hotspotBtn, discBtn]),
      ]),
      media.el,
    ]);

    // ---- wireless debugging ----
    const adbRow = UI.row(I18n.t('Wireless debugging'), '', [], { literalHint: true });
    const adbPill = el('span', { class: 'pill muted' });
    adbRow.querySelector('.controls').append(adbPill, UI.button(I18n.t('Try Again'), () => api.phoneRetry(), 'small'));
    const code = el('input', { type: 'text', placeholder: '123456', maxLength: 6, inputMode: 'numeric', autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': I18n.t('Pairing code') } });
    const where = el('input', { type: 'text', placeholder: I18n.t('Address:port (optional)'), autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': I18n.t('Pairing address') } });
    const pairBtn = UI.button(I18n.t('Pair'), () => api.phonePair({ code: code.value, where: where.value }), 'small primary');
    code.onkeydown = where.onkeydown = (e) => { if (e.key === 'Enter') pairBtn.click(); };
    const pairRow = UI.row(I18n.t('Pairing code'), I18n.t('Or type it on the phone, in TwinDesk’s notification'), [code, where, pairBtn]);
    const steps = UI.note('info', '');
    // Wireless debugging off: one line, the steps behind Show me how.
    let howOpen = false;
    const howBtn = UI.button(I18n.t('Show me how'), () => { howOpen = !howOpen; render(UI.state); }, 'small');
    adbRow.querySelector('.controls').prepend(howBtn);
    const how = el('ol', { class: 'how-steps' }, [
      I18n.t('On the phone: Settings › About phone › Software information › tap Build number 7 times. Developer options appear.'),
      I18n.t('Settings › Developer options: turn on USB debugging.'),
      I18n.t('On the same page, turn on Wireless debugging. The phone has to be on a Wi-Fi network (a direct Wi-Fi link alone isn’t enough).'),
      I18n.t('Tap Wireless debugging › Pair device with pairing code, and type the code here, or in TwinDesk’s notification on the phone.'),
      I18n.t('That’s all: after pairing once, TwinDesk turns wireless debugging on by itself.'),
    ].map((t) => el('li', { text: t })));
    // The phone runs the standard build (no notification access): install the full one over it.
    const fullBtn = UI.button(I18n.t('Install'), () => api.phoneInstallFull(), 'small primary');
    const fullRow = UI.row(I18n.t('Notifications from the phone'), '', [fullBtn], { literalHint: true });
    const adbCard = UI.card(I18n.t('Screen, mouse and keyboard'), [adbRow, how, pairRow, steps, fullRow]);

    // ---- apps ----
    const search = el('input', { type: 'search', placeholder: I18n.t('Search apps'), autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': I18n.t('Search apps') } });
    const grid = el('div', { class: 'app-grid' });
    const appsNote = UI.note('info', '');
    search.oninput = () => { appsKey = ''; render(UI.state); };
    const appsCard = UI.card(I18n.t('Apps'), [el('div', { class: 'row' }, [search]), appsNote, grid]);

    // ---- open windows ----
    const winList = el('div');
    const winCard = UI.card(I18n.t('Open on this Mac'), [winList]);

    // ---- settings ----
    const sound = UI.switch((v) => api.setPhone({ sound: v }), { label: I18n.t('Phone sound') });
    const quality = UI.select([
      { value: '4', label: I18n.t('Data saver (4 Mb/s)') }, { value: '8', label: I18n.t('Balanced (8 Mb/s)') },
      { value: '16', label: I18n.t('Sharp (16 Mb/s)') }, { value: '24', label: I18n.t('Sharpest (24 Mb/s)') },
    ], (v) => api.setPhone({ bitrateMbps: Number(v) }));
    const wall = UI.switch((v) => api.setPhone({ wallpaper: v }), { label: I18n.t('Wallpaper') });
    const enterSends = UI.switch((v) => api.setPhone({ enterSends: v }), { label: I18n.t('Return sends messages') });
    const arrowSwipe = UI.switch((v) => api.setPhone({ arrowSwipe: v }), { label: I18n.t('Arrow keys swipe') });
    // #123: keys as a real USB keyboard on the phone (shared/uhidkbd.js), in the phone's own layout.
    const uhid = UI.switch((v) => api.setPhone({ uhid: v }), { label: I18n.t('Type as a hardware keyboard') });
    const optsCard = UI.card(I18n.t('Settings'), [
      UI.row(I18n.t('Phone sound in the screen window'), I18n.t('Android 11 or later'), [sound]),
      UI.row(I18n.t('Picture'), I18n.t('For the screen window and app windows'), [quality]),
      UI.row(I18n.t('Return sends messages'), I18n.t('In WhatsApp, Instagram and Telegram, in a phone window or with this keyboard on the phone. ⇧Return: a new line'), [enterSends]),
      UI.row(I18n.t('Arrow keys swipe'), I18n.t('In a phone window: up and down through feeds, Reels and Shorts, left and right through pages. Off: they move the cursor'), [arrowSwipe]),
      UI.row(I18n.t('Type as a hardware keyboard'), I18n.t('Keys reach the phone as from a USB keyboard, in the layout set on the phone (Settings › System › Keyboard › Physical keyboard), so every symbol and accented letter comes out as it does there. Needs wireless debugging. Off: keys go as Android key codes in the US layout'), [uhid]),
      UI.row(I18n.t('Show the phone’s wallpaper here'), I18n.t('Lets TwinDesk on the phone read it (set up over wireless debugging)'), [wall]),
      UI.row(I18n.t('Mouse and keyboard'), I18n.t('Push the pointer off the edge of the screen to use the phone. Double-tap the hotkey to come back.'), [UI.button(I18n.t('Cursor Settings'), () => UI.go('cursor'), 'small')]),
    ]);


    const notConnected = UI.note('info', '');
    // Below the phone's card: how the mouse and keyboard reach it (automatic until one is picked).
    const viaRow = UI.row(I18n.t('Mouse and keyboard'), '', [via.el]);
    const viaCard = UI.card('', [viaRow]);
    const rezume = UI.rezumeCard ? UI.rezumeCard() : { el: UI.el('div', { hidden: true }), update() {} }; // the phone's ReZume (shared/ui-rezume.js; not in Multi-device)
    body.append(notConnected, hero, rezume.el, viaCard, adbCard, appsCard, winCard, optsCard);

    let appsKey = '';
    let winKey = '';
    const STATES = {
      ready: ['good', I18n.t('Ready')], connecting: ['muted', I18n.t('Connecting…')], needsPair: ['bad', I18n.t('Pair once')],
      waitingWifi: ['bad', I18n.t('Off')], missing: ['bad', I18n.t('Missing')], error: ['bad', I18n.t('Problem')], off: ['muted', '—'],
    };

    function render(s) {
      rezume.update(s);
      media.update(s);
      const ph = s.phone || {};
      const c = ph.connected;
      const info = ph.info || {};
      const br = ph.bridge || { state: 'off' };
      for (const x of [hero, viaCard, adbCard, appsCard, winCard, optsCard]) x.hidden = !c;
      // An iPhone: its card (name, battery, Disconnect) only; no adb, screen, apps or input from iOS.
      const ios = !!(c && c.os === 'ios');
      if (ios) for (const x of [viaCard, adbCard, appsCard, winCard, optsCard, rezume.el]) x.hidden = true;
      showBtn.hidden = false; // an iPhone too: it asks the phone to share (Share Screen there)
      if (ios) showBtn.disabled = false;
      notConnected.set(c ? '' : ph.nearby && ph.nearby.length ? I18n.t('Click the phone above Overview to connect it.') : I18n.t('No phone connected. Open TwinDesk on the phone and pair it from Overview › Nearby.'));

      if (!c) return;

      h1.textContent = c.name;
      desc.textContent = [info.maker && info.model ? `${info.maker} ${info.model}` : info.model, info.release && `${ios ? (info.platform === 'ipados' ? 'iPadOS' : 'iOS') : 'Android'} ${info.release}`].filter(Boolean).join(' · ');
      name.textContent = c.name;
      sub.textContent = [c.usb ? I18n.t('USB cable') : '', UI.state.client && UI.state.client.transport === 'ble' ? I18n.t('Bluetooth') : '', c.rttMs != null ? `${c.rttMs} ms` : I18n.t('Connected'), info.battery != null ? I18n.t(info.charging ? 'Battery {percent}%, charging' : 'Battery {percent}%', { percent: info.battery }) : ''].filter(Boolean).join(' · ');
      if (UI.phoneWall) dev.style.setProperty('--phone-wall', UI.phoneWall);
      else if (info.colors && info.colors.length) dev.style.setProperty('--phone-wall', `linear-gradient(160deg, ${info.colors.join(', ')}${info.colors.length === 1 ? `, ${info.colors[0]}` : ''})`);
      else dev.style.removeProperty('--phone-wall');

      if (ios) return;
      const ready = br.state === 'ready';
      showBtn.disabled = !ready;
      const n = s.net || {};
      wifiOn = (n.why || []).includes('user') || !!n.linked; // made for the screen or files too
      wifiBtn.textContent = wifiOn ? I18n.t('Back to Bluetooth') : I18n.t('Connect with Wi-Fi Direct');
      wifiBtn.hidden = !(wifiOn || !!(s.client && s.client.transport === 'ble'));
      hotspotBtn.hidden = wifiOn || n.state === 'hotspot' || !(s.client && s.client.transport === 'ble');
      const off = br.state === 'waitingWifi';
      howBtn.hidden = !off;
      howBtn.textContent = howOpen ? I18n.t('Hide') : I18n.t('Show me how');
      how.hidden = !off || !howOpen;
      const [cls, label] = STATES[br.state] || STATES.off;
      adbPill.className = `pill ${ready && br.inputBlocked ? 'bad' : cls}`;
      adbPill.textContent = ready && br.inputBlocked ? I18n.t('Touch blocked') : label;
      adbRow.setHint(off ? (/direct Wi-Fi/.test(br.message) ? messageText(br.message) : I18n.t('Wireless debugging is off on the phone. The screen and ADB control need it; Accessibility doesn’t.')) : ready && br.inputBlocked ? I18n.t('The screen works, but Xiaomi refuses touch, mouse and keyboard from here. On the phone: Settings › Developer options › USB debugging (Security settings): on (it asks for a Mi account).')
        : ready ? I18n.t('The phone’s screen, touch, mouse and keyboard, and its clipboard in the background') : messageText(br.message));
      pairRow.hidden = br.state !== 'needsPair' && !br.canPair;
      steps.set(br.state === 'needsPair' ? I18n.t('TwinDesk pairs with the phone’s wireless debugging once. After that the phone’s screen, apps, mouse and keyboard work without this step.') : '');
      if (UI.adbBle(s, adbCard, adbRow, adbPill)) { pairRow.hidden = how.hidden = howBtn.hidden = true; steps.set(''); }

      // The standard build can't read notifications (Play Protect blocks downloaded apps that do).
      const full = !ph.adb || ph.adb.full !== false;
      const inst = br.install;
      fullRow.hidden = full && !(inst && inst.state === 'done');
      fullBtn.hidden = full;
      fullBtn.disabled = !ready || !br.fullApk || (inst && inst.state === 'installing');
      fullRow.setHint(inst && inst.state !== 'failed' && inst.message ? messageText(inst.message, c.name)
        : !br.fullApk ? I18n.t('This build of TwinDesk doesn’t carry the Android app.')
          : [inst && inst.state === 'failed' ? messageText(inst.message, c.name) : '', I18n.t('The TwinDesk you downloaded can’t read the phone’s notifications (Play Protect blocks downloaded apps that can). Install the full app over it: its settings and pairing stay.'), ready ? '' : I18n.t('Needs wireless debugging.')].filter(Boolean).join(' '));

      const settings = ph.settings || {};
      sound.set(!!settings.sound);
      quality.set(String(settings.bitrateMbps || 8));
      wall.set(settings.wallpaper !== false);
      enterSends.set(settings.enterSends !== false);
      uhid.set(settings.uhid === true);
      arrowSwipe.set(settings.arrowSwipe === true);
      via.set(br.input || (settings.input === 'phone' ? 'phone' : 'adb'));
      viaRow.setHint(br.inputMode === 'auto' ? (br.state === 'ready' ? I18n.t('Automatic: ADB, wireless debugging is ready') : I18n.t('Automatic: Accessibility until wireless debugging is ready'))
        : br.input === 'phone' ? I18n.t('TwinDesk on the phone taps and types itself. The phone asks once to allow it in Accessibility') : I18n.t('Wireless debugging: full control'));

      // apps (icons come with UI.phoneAssets)
      const apps = (UI.phoneAssets && UI.phoneAssets.apps) || [];
      const term = search.value.trim().toLowerCase();
      const shown = term ? apps.filter((a) => a.name.toLowerCase().includes(term)) : apps;
      appsNote.set(!ready ? I18n.t('Apps open in their own windows once wireless debugging is set up.') : !apps.length ? I18n.t('Loading the phone’s apps…') : '');
      const ak = JSON.stringify([shown.length, term, ph.assets, ready]);
      if (ak !== appsKey) {
        appsKey = ak;
        grid.replaceChildren(...shown.slice(0, 400).map((a) => {
          const img = UI.appIcon(a.icon);
          const b = el('button', { class: 'app-tile', title: I18n.t('Open {app} in a window (right-click to add it to the Dock)', { app: a.name }), disabled: !ready }, [img, el('span', { text: a.name })]);
          b.onclick = () => api.phoneOpenApp({ id: a.id, name: a.name });
          b.oncontextmenu = (e) => { e.preventDefault(); api.phoneAppMenu({ id: a.id, name: a.name }); }; // Add to Dock
          return b;
        }));
      }

      const wins = br.windows || [];
      winCard.hidden = !wins.length;
      const wk = JSON.stringify(wins);
      if (wk !== winKey) {
        winKey = wk;
        winList.replaceChildren(...wins.map((w) => UI.row(w.kind === 'screen' ? I18n.t('Phone screen') : w.title, w.kind === 'screen' ? I18n.t('Mirror') : w.app, [UI.button(I18n.t('Close'), () => api.phoneCloseView(w.id), 'small')], { literal: true })));
      }
    }
    return render;
  },
});

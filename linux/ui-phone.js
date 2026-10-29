// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Phone page (opened from the phone tile above Overview): the connected phone, its screen in a
// window, its apps in windows of their own, wireless debugging setup, and Disconnect. Copy of
// windows/ui-phone.js.
'use strict';

UI.tab({
  id: 'phone',
  order: -1,
  navHidden: true, // the phone tile in the sidebar opens it
  title: 'Phone',
  heading: 'Phone',
  desc: '',
  color: 'linear-gradient(#34c759, #248a3d)',
  build(body, page) {
    const { el, api } = UI;
    const h1 = page.querySelector('h1 span');
    const desc = page.querySelector('.page-head p');

    // ---- hero ----
    const dev = el('div', { class: 'device phone big' });
    const name = el('div', { class: 'hero-name' });
    const sub = el('div', { class: 'hero-status' });
    const showBtn = UI.button('Show Phone Screen', () => api.phoneScreen(true), 'primary');
    const discBtn = UI.button('Disconnect', () => api.disconnectPhone());
    // On Bluetooth: onto a direct Wi-Fi link on request, until Back to Bluetooth (netlink.js 'user').
    let wifiOn = false;
    const wifiBtn = UI.button('Connect with Wi-Fi Direct', () => api.netWifi(!wifiOn));
    const hotspotBtn = UI.button('Connect with hotspot', () => { api.netWifi('hotspot'); UI.go('overview'); }); // its name and password there
    // How the mouse and keyboard reach the phone (settings.phone.input; the phone's own toggle too).
    const via = UI.segmented([
      { value: 'adb', label: 'ADB', title: 'Wireless debugging: full control' },
      { value: 'phone', label: 'Accessibility', title: 'TwinDesk on the phone taps and types itself, over Wi-Fi, Wi-Fi Direct or Bluetooth. No developer options' },
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
    const adbRow = UI.row('Wireless debugging', '', []);
    const adbPill = el('span', { class: 'pill muted' });
    adbRow.querySelector('.controls').append(adbPill, UI.button('Try Again', () => api.phoneRetry(), 'small'));
    const code = el('input', { type: 'text', placeholder: '123456', maxLength: 6, inputMode: 'numeric', autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': 'Pairing code' } });
    const where = el('input', { type: 'text', placeholder: 'Address:port (optional)', autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': 'Pairing address' } });
    const pairBtn = UI.button('Pair', () => api.phonePair({ code: code.value, where: where.value }), 'small primary');
    code.onkeydown = where.onkeydown = (e) => { if (e.key === 'Enter') pairBtn.click(); };
    const pairRow = UI.row('Pairing code', 'Or type it on the phone, in TwinDesk’s notification', [code, where, pairBtn]);
    const steps = UI.note('info', '');
    // Wireless debugging off: one line, the steps behind Show me how.
    let howOpen = false;
    const howBtn = UI.button('Show me how', () => { howOpen = !howOpen; render(UI.state); }, 'small');
    adbRow.querySelector('.controls').prepend(howBtn);
    const how = el('ol', { class: 'how-steps' }, [
      'On the phone: Settings › About phone › Software information › tap Build number 7 times. Developer options appear.',
      'Settings › Developer options: turn on USB debugging.',
      'On the same page, turn on Wireless debugging. The phone has to be on a Wi-Fi network (a direct Wi-Fi link alone isn’t enough).',
      'Tap Wireless debugging › Pair device with pairing code, and type the code here, or in TwinDesk’s notification on the phone.',
      'That’s all: after pairing once, TwinDesk turns wireless debugging on by itself.',
    ].map((t) => el('li', { text: t })));
    // The phone runs the standard build (no notification access): install the full one over it.
    const fullBtn = UI.button('Install', () => api.phoneInstallFull(), 'small primary');
    const fullRow = UI.row('Notifications from the phone', '', [fullBtn]);
    const adbCard = UI.card('Screen, mouse and keyboard', [adbRow, how, pairRow, steps, fullRow]);

    // ---- apps ----
    const search = el('input', { type: 'search', placeholder: 'Search apps', autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': 'Search apps' } });
    const grid = el('div', { class: 'app-grid' });
    const appsNote = UI.note('info', '');
    search.oninput = () => { appsKey = ''; render(UI.state); };
    const appsCard = UI.card('Apps', [el('div', { class: 'row' }, [search]), appsNote, grid]);

    // ---- open windows ----
    const winList = el('div');
    const winCard = UI.card('Open on this computer', [winList]);

    // ---- settings ----
    const sound = UI.switch((v) => api.setPhone({ sound: v }), { label: 'Phone sound' });
    const quality = UI.select([
      { value: '4', label: 'Data saver (4 Mb/s)' }, { value: '8', label: 'Balanced (8 Mb/s)' },
      { value: '16', label: 'Sharp (16 Mb/s)' }, { value: '24', label: 'Sharpest (24 Mb/s)' },
    ], (v) => api.setPhone({ bitrateMbps: Number(v) }));
    const wall = UI.switch((v) => api.setPhone({ wallpaper: v }), { label: 'Wallpaper' });
    const enterSends = UI.switch((v) => api.setPhone({ enterSends: v }), { label: 'Enter sends messages' });
    const arrowSwipe = UI.switch((v) => api.setPhone({ arrowSwipe: v }), { label: 'Arrow keys swipe' });
    const optsCard = UI.card('Settings', [
      UI.row('Phone sound in the screen window', 'Android 11 or later', [sound]),
      UI.row('Picture', 'For the screen window and app windows', [quality]),
      UI.row('Enter sends messages', 'In WhatsApp, Instagram and Telegram, in a phone window or with this keyboard on the phone. Shift+Enter: a new line', [enterSends]),
      UI.row('Arrow keys swipe', 'In a phone window: up and down through feeds, Reels and Shorts, left and right through pages. Off: they move the cursor', [arrowSwipe]),
      UI.row('Show the phone’s wallpaper here', 'Lets TwinDesk on the phone read it (set up over wireless debugging)', [wall]),
      UI.row('Mouse and keyboard', 'Push the pointer off the edge of the screen to use the phone. Double-tap the hotkey to come back.', [UI.button('Cursor Settings', () => UI.go('cursor'), 'small')]),
    ]);

    const notConnected = UI.note('info', '');
    // Below the phone's card: how the mouse and keyboard reach it (automatic until one is picked).
    const viaRow = UI.row('Mouse and keyboard', '', [via.el]);
    const viaCard = UI.card('', [viaRow]);
    body.append(notConnected, hero, viaCard, adbCard, appsCard, winCard, optsCard);

    let appsKey = '';
    let winKey = '';
    const STATES = {
      ready: ['good', 'Ready'], connecting: ['muted', 'Connecting…'], needsPair: ['bad', 'Pair once'],
      waitingWifi: ['bad', 'Off'], missing: ['bad', 'Missing'], error: ['bad', 'Problem'], off: ['muted', '—'],
    };

    function render(s) {
      media.update(s);
      const ph = s.phone || {};
      const c = ph.connected;
      const info = ph.info || {};
      const br = ph.bridge || { state: 'off' };
      for (const x of [hero, viaCard, adbCard, appsCard, winCard, optsCard]) x.hidden = !c;
      notConnected.set(c ? '' : ph.nearby && ph.nearby.length ? 'Click the phone above Overview to connect it.' : 'No phone connected. Open TwinDesk on the phone and pair it from Overview › Nearby.');
      if (!c) return;

      h1.textContent = c.name;
      desc.textContent = [info.maker && info.model ? `${info.maker} ${info.model}` : info.model, info.release && `Android ${info.release}`].filter(Boolean).join(' · ');
      name.textContent = c.name;
      sub.textContent = [c.usb ? 'USB cable' : '', c.rttMs != null ? `${c.rttMs} ms` : 'Connected', info.battery != null ? `Battery ${info.battery}%${info.charging ? ', charging' : ''}` : ''].filter(Boolean).join(' · ');
      if (UI.phoneWall) dev.style.setProperty('--phone-wall', UI.phoneWall);
      else if (info.colors && info.colors.length) dev.style.setProperty('--phone-wall', `linear-gradient(160deg, ${info.colors.join(', ')}${info.colors.length === 1 ? `, ${info.colors[0]}` : ''})`);
      else dev.style.removeProperty('--phone-wall');

      const ready = br.state === 'ready';
      showBtn.disabled = !ready;
      const n = s.net || {};
      wifiOn = (n.why || []).includes('user') || !!n.linked; // made for the screen or files too
      wifiBtn.textContent = wifiOn ? 'Back to Bluetooth' : 'Connect with Wi-Fi Direct';
      wifiBtn.hidden = !(wifiOn || !!(s.net && s.net.transport === 'ble'));
      hotspotBtn.hidden = wifiOn || n.state === 'hotspot' || !(s.net && s.net.transport === 'ble');
      const off = br.state === 'waitingWifi';
      howBtn.hidden = !off;
      howBtn.textContent = howOpen ? 'Hide' : 'Show me how';
      how.hidden = !off || !howOpen;
      const [cls, label] = STATES[br.state] || STATES.off;
      adbPill.className = `pill ${ready && br.inputBlocked ? 'bad' : cls}`;
      adbPill.textContent = ready && br.inputBlocked ? 'Touch blocked' : label;
      adbRow.setHint(off ? (/direct Wi-Fi/.test(br.message) ? br.message : 'Wireless debugging is off on the phone. The screen and ADB control need it; Accessibility doesn’t.') : ready && br.inputBlocked ? 'The screen works, but Xiaomi refuses touch, mouse and keyboard from here. On the phone: Settings › Developer options › USB debugging (Security settings): on (it asks for a Mi account).'
        : ready ? 'The phone’s screen, touch, mouse and keyboard, and its clipboard in the background' : br.message);
      pairRow.hidden = br.state !== 'needsPair' && !br.canPair;
      steps.set(br.state === 'needsPair' ? 'TwinDesk pairs with the phone’s wireless debugging once. After that the phone’s screen, apps, mouse and keyboard work without this step.' : '');
      if (UI.adbBle(s, adbCard, adbRow, adbPill)) { pairRow.hidden = how.hidden = howBtn.hidden = true; steps.set(''); }

      // The standard build can't read notifications (Play Protect blocks downloaded apps that do).
      const full = !ph.adb || ph.adb.full !== false;
      const inst = br.install;
      fullRow.hidden = full && !(inst && inst.state === 'done');
      fullBtn.hidden = full;
      fullBtn.disabled = !ready || !br.fullApk || (inst && inst.state === 'installing');
      fullRow.setHint(inst && inst.state !== 'failed' && inst.message ? inst.message
        : !br.fullApk ? 'This build of TwinDesk doesn’t carry the Android app.'
          : `${inst && inst.state === 'failed' ? `${inst.message} ` : ''}The TwinDesk you downloaded can’t read the phone’s notifications (Play Protect blocks downloaded apps that can). Install the full app over it: its settings and pairing stay.${ready ? '' : ' Needs wireless debugging.'}`);

      const settings = ph.settings || {};
      sound.set(!!settings.sound);
      quality.set(String(settings.bitrateMbps || 8));
      wall.set(settings.wallpaper !== false);
      enterSends.set(settings.enterSends !== false);
      arrowSwipe.set(settings.arrowSwipe === true);
      via.set(br.input || (settings.input === 'phone' ? 'phone' : 'adb'));
      viaRow.setHint(br.inputMode === 'auto' ? (br.state === 'ready' ? 'Automatic: ADB, wireless debugging is ready' : 'Automatic: Accessibility until wireless debugging is ready')
        : br.input === 'phone' ? 'TwinDesk on the phone taps and types itself. The phone asks once to allow it in Accessibility' : 'Wireless debugging: full control');

      // apps (icons come with UI.phoneAssets)
      const apps = (UI.phoneAssets && UI.phoneAssets.apps) || [];
      const term = search.value.trim().toLowerCase();
      const shown = term ? apps.filter((a) => a.name.toLowerCase().includes(term)) : apps;
      appsNote.set(!ready ? 'Apps open in their own windows once wireless debugging is set up.' : !apps.length ? 'Loading the phone’s apps…' : '');
      const ak = JSON.stringify([shown.length, term, ph.assets, ready]);
      if (ak !== appsKey) {
        appsKey = ak;
        grid.replaceChildren(...shown.slice(0, 400).map((a) => {
          const img = UI.appIcon(a.icon);
          const b = el('button', { class: 'app-tile', title: `Open ${a.name} in a window`, disabled: !ready }, [img, el('span', { text: a.name })]);
          b.onclick = () => api.phoneOpenApp({ id: a.id, name: a.name });
          return b;
        }));
      }

      const wins = br.windows || [];
      winCard.hidden = !wins.length;
      const wk = JSON.stringify(wins);
      if (wk !== winKey) {
        winKey = wk;
        winList.replaceChildren(...wins.map((w) => UI.row(w.kind === 'screen' ? 'Phone screen' : w.title, w.kind === 'screen' ? 'Mirror' : w.app, [UI.button('Close', () => api.phoneCloseView(w.id), 'small')])));
      }
    }
    return render;
  },
});

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Overview of an Android phone (Mac, PC and Linux), in Overview's place while one is connected; its
// tile at the top of the sidebar opens it too.
//   Its picture, battery and link; Show screen, Ring, Lock, Wi-Fi Direct, hotspot, Disconnect; its
//   storage, network, control (wireless debugging or Accessibility) and signal; what plays there;
//   its quick settings (Wi-Fi, Bluetooth, data, hotspot, torch, Do not disturb, rotation, battery
//   saver), its volume and ringer; ReZume's offer; the latest notifications (a one-time code gets
//   Copy), the clipboard, its most used apps and Send files (shared/ui-device-parts.js).
'use strict';

(function () {
  const D = UI.deviceParts;
  const { t, glyph } = D;
  const PHONE_QS = [
    // id, label, icon (20×20 strokes)
    ['wifi', t('Wi-Fi'), 'M2.5 7.5a11 11 0 0 1 15 0 M5 10.3a7.3 7.3 0 0 1 10 0 M7.6 13a3.5 3.5 0 0 1 4.8 0 M10 15.8v.1'],
    ['bluetooth', t('Bluetooth'), 'M6 6.5l8 7-4 3.5V3l4 3.5-8 7'],
    ['data', t('Mobile data'), 'M6.5 16V5 M4 7.5l2.5-2.5L9 7.5 M13.5 4v11 M11 12.5l2.5 2.5 2.5-2.5'],
    ['hotspot', t('Hotspot'), 'M10 10.5v.1 M7.3 13a3.8 3.8 0 0 1 0-5.2 M12.7 7.8a3.8 3.8 0 0 1 0 5.2 M4.8 15.4a7.3 7.3 0 0 1 0-10.2 M15.2 5.2a7.3 7.3 0 0 1 0 10.2'],
    ['torch', t('Torch'), 'M7 2.5h6v4l-1.5 2.5V17.5h-3V9L7 6.5z'],
    ['dnd', t('Do not disturb'), 'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z M6 10h8'],
    ['rotate', t('Auto-rotate'), 'M3.5 10a6.5 6.5 0 0 1 11.3-4.4L16.5 7 M16.5 3v4h-4 M16.5 10a6.5 6.5 0 0 1-11.3 4.4L3.5 13 M3.5 17v-4h4'],
    ['saver', t('Battery saver'), 'M3.5 6.5h11v7h-11z M14.5 8.5h2v3h-2 M9 8v4 M7 10h4'],
  ];
  const RINGER = [{ value: 'ring', label: t('Ring') }, { value: 'vibrate', label: t('Vibrate') }, { value: 'silent', label: t('Silent') }];

  UI.tab({
    id: 'android-overview',
    variantOf: 'overview',
    for: ['android'],
    order: 0,
    title: 'Overview',
    heading: 'Overview',
    icon: 'overview',
    color: 'linear-gradient(#8e8e93, #636366)',
    desc: '',
    hidden: (s) => !D.linked(s),
    build(body, page) {
      const { el, api } = UI;
      const { h1, desc, row, doIt } = D.setup(body, page);

      const showBtn = D.button(t('Show screen'), 'show', () => api.phoneScreen(true));
      showBtn.classList.add('primary');
      const ring = D.ring(doIt);
      const lockBtn = D.button(t('Lock'), 'lock', () => doIt({ do: 'lock' }));
      const wifi = D.wifi();
      const hotspotBtn = D.button(t('Use hotspot'), 'hotspot', () => { api.netWifi('hotspot'); UI.go('connection'); });
      const discBtn = D.button(t('Disconnect'), 'disconnect', () => (api.disconnectPhone ? api.disconnectPhone() : api.disconnect()));
      const hero = D.hero([showBtn, ring.btn, lockBtn, wifi.btn, hotspotBtn, discBtn], ring.note);
      const notConnected = UI.note('info', '');
      const media = D.media();

      // ---- quick settings ----
      const tiles = {};
      const grid = el('div', { class: 'dv-qs' });
      for (const [id, label, icon] of PHONE_QS) {
        const state = el('span', { class: 'dv-qs-state' });
        const b = el('button', { class: 'dv-qs-tile', attrs: { 'aria-pressed': 'false' } }, [glyph(icon), el('span', { class: 'dv-qs-label' }, [el('span', { text: label }), state])]);
        b.onclick = () => {
          const qs = (UI.state && UI.state.phone && UI.state.phone.qs) || {};
          doIt({ do: 'qs', id, on: !qs[id] });
        };
        tiles[id] = { b, state, label };
        grid.append(b);
      }
      // Even rows: every tile in one row when each gets 110 px, else half of them per row.
      const cols = () => {
        const n = [...grid.children].filter((b) => !b.hidden).length || 1;
        const w = grid.clientWidth - 28;
        grid.style.setProperty('--cols', String(w >= n * 110 ? n : Math.ceil(n / 2)));
      };
      new ResizeObserver(cols).observe(grid);
      const vol = UI.slider({ min: 0, max: 100, step: 1, format: (v) => v + '%' }, (v) => doIt({ do: 'volume', stream: 'media', level: v / 100 }));
      const ringer = UI.segmented(RINGER, (v) => doIt({ do: 'ringer', mode: v }));
      const soundRow = row(t('Media volume'), '', [vol, ringer]);
      const qsCard = UI.card(t('Quick actions'), [grid, soundRow], { actions: [UI.button(t('Customize'), () => UI.go('general'), 'small link')] });

      const rezume = D.rezume();
      const lower = D.lower(row, { withApps: true });
      const airplay = D.airplay();
      body.append(notConnected, hero.el, ...(airplay ? [airplay.el] : []), media.el, qsCard, ...(rezume ? [rezume.el] : []), lower.el);

      return (s) => {
        if (airplay) airplay.update(s);
        const ph = s.phone || {};
        const c = ph.connected;
        const on = D.linked(s);
        notConnected.set(on ? '' : t('Nothing is connected. Connect a phone or computer on the Connection page.'));
        for (const x of [hero.el, media.el, qsCard, lower.el]) x.hidden = !on;
        if (!on) return;
        const p = UI.peer(s);
        const info = ph.info || {};
        const ctl = ph.ctl || null; // what the phone can do (deviceDo), null: an older TwinDesk
        const can = (k) => !!(ctl && ctl.can && ctl.can[k]);
        const ov = (s.ui && s.ui.overview) || {}; // General › Overview: what's left out

        // hero
        const devName = c ? c.name : (s.peer && s.peer.name) || (s.client && s.client.name) || p.name;
        h1.textContent = devName;
        hero.name.textContent = devName;
        D.phonePic(hero.pic, info);
        const rtt = c && c.rttMs;
        const via = c && c.usb ? 'USB' : D.viaOf(s);
        desc.textContent = [info.maker && info.model ? `${info.maker} ${info.model}` : info.model, info.release && `Android ${info.release}`].filter(Boolean).join(' · ');
        hero.sub.textContent = [t('Connected'), via, rtt != null ? t('{value} ms', { value: rtt }) : ''].filter(Boolean).join(' · ');
        hero.battery(info.battery, info.charging);
        const br = ph.bridge || {};
        const ready = br.state === 'ready';
        showBtn.disabled = !ready;
        showBtn.title = ready ? '' : t('Needs wireless debugging (Connection)');
        ring.update(ctl);
        lockBtn.hidden = !can('lock');
        const { on: wifiOn, ble, n } = wifi.update(s);
        hotspotBtn.hidden = wifiOn || n.state === 'hotspot' || !ble;

        const pi = (ctl && ctl.info) || {};
        const control = br.input === 'phone' ? t('Accessibility')
          : br.state === 'ready' ? t('ADB · ready') : br.state === 'connecting' ? t('ADB · connecting') : br.state === 'needsPair' ? t('ADB · not paired') : br.state === 'waitingWifi' ? t('ADB · off') : t('Not set up');
        hero.setFacts([
          [t('Storage'), pi.storageTotal ? t('{used} of {total} GB', { used: pi.storageUsed, total: pi.storageTotal }) : info.storage ? t('{used} of {total} GB', { used: info.storage.used, total: info.storage.total }) : ''],
          [t('Network'), [pi.wifi, pi.cell].filter(Boolean).join(' · ')],
          [t('Control'), control],
          [t('Signal'), pi.signal],
          [t('Link'), via],
          ['TwinDesk', D.version(ctl)],
        ]);

        media.update(s, ov);

        // quick settings: only what the phone reports
        const qs = ph.qs;
        qsCard.hidden = !qs || ov.qs === false;
        if (qs) {
          for (const [id] of PHONE_QS) {
            const tile = tiles[id];
            const has = id in qs;
            tile.b.hidden = !has;
            if (!has) continue;
            tile.b.classList.toggle('on', !!qs[id]);
            tile.b.setAttribute('aria-pressed', String(!!qs[id]));
            const detail = qs.detail && qs.detail[id];
            tile.state.textContent = qs[id] ? detail || t('On') : t('Off');
            tile.b.title = qs.panel && qs.panel[id] ? t('Opens the setting on the phone') : '';
          }
          cols();
          soundRow.hidden = qs.volume == null;
          if (qs.volume != null) vol.set(Math.round(qs.volume * 100));
          ringer.el.hidden = !qs.ringer;
          if (qs.ringer) ringer.set(qs.ringer);
        }

        lower.update(s, { phone: true, devName, top: ph.top || [], ready });
        if (rezume) rezume.update(s, devName);
      };
    },
  });
})();

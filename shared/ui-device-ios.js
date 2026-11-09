// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Overview of an iPhone or iPad (Mac, PC and Linux), in Overview's place while one is connected;
// its tile at the top of the sidebar opens it too.
//   Its picture, battery and link (Wi-Fi, Bluetooth or the USB cable); Show screen (it asks the
//   iPhone to share it: Start Broadcast there), Ring (find it), Disconnect; its storage and link;
//   what plays there; ReZume's offer; the latest notifications (a one-time code gets Copy), the
//   clipboard and Send files (shared/ui-device-parts.js).
// iOS lets no app give its quick settings, its apps, Wi-Fi Direct or a hotspot, so they aren't here.
'use strict';

(function () {
  const D = UI.deviceParts;
  const { t } = D;

  UI.tab({
    id: 'ios-overview',
    variantOf: 'overview',
    for: ['ios'],
    order: 0,
    title: 'Overview',
    heading: 'Overview',
    icon: 'overview',
    color: 'linear-gradient(#8e8e93, #636366)',
    desc: '',
    hidden: (s) => !D.linked(s),
    build(body, page) {
      const { api } = UI;
      const { h1, desc, row, doIt } = D.setup(body, page);

      const showBtn = D.button(t('Show screen'), 'show', () => api.phoneScreen(true));
      showBtn.classList.add('primary');
      const ring = D.ring(doIt);
      const discBtn = D.button(t('Disconnect'), 'disconnect', () => (api.disconnectPhone ? api.disconnectPhone() : api.disconnect()));
      const hero = D.hero([showBtn, ring.btn, discBtn], ring.note);
      const notConnected = UI.note('info', '');
      const media = D.media();
      const rezume = D.rezume();
      const lower = D.lower(row);
      const airplay = D.airplay();
      body.append(notConnected, hero.el, ...(airplay ? [airplay.el] : []), media.el, ...(rezume ? [rezume.el] : []), lower.el);

      return (s) => {
        if (airplay) airplay.update(s);
        const ph = s.phone || {};
        const c = ph.connected;
        const on = D.linked(s);
        notConnected.set(on ? '' : t('Nothing is connected. Connect a phone or computer on the Connection page.'));
        for (const x of [hero.el, media.el, lower.el]) x.hidden = !on;
        if (!on) return;
        const p = UI.peer(s);
        const info = ph.info || {};
        const ctl = ph.ctl || null; // what it can do (deviceDo: Ring), null: an older TwinDesk
        const ov = (s.ui && s.ui.overview) || {}; // General › Overview: what's left out

        // hero
        const devName = c ? c.name : (s.peer && s.peer.name) || (s.client && s.client.name) || p.name;
        h1.textContent = devName;
        hero.name.textContent = devName;
        D.phonePic(hero.pic, info);
        const rtt = c && c.rttMs;
        const via = c && c.usb ? 'USB' : D.viaOf(s);
        desc.textContent = [info.maker && info.model ? `${info.maker} ${info.model}` : info.model, info.release && `${info.platform === 'ipados' ? 'iPadOS' : 'iOS'} ${info.release}`].filter(Boolean).join(' · ');
        hero.sub.textContent = [t('Connected'), via, rtt != null ? t('{value} ms', { value: rtt }) : ''].filter(Boolean).join(' · ');
        hero.battery(info.battery, info.charging);
        const ble = !!(UI.onBle && UI.onBle(s));
        showBtn.disabled = ble; // its Share Screen needs Wi-Fi or the cable
        showBtn.title = ble ? t('Screens need Wi-Fi: {phone} is connected through Bluetooth', { phone: devName }) : '';
        ring.update(ctl);

        const pi = (ctl && ctl.info) || {};
        hero.setFacts([
          [t('Storage'), pi.storageTotal ? t('{used} of {total} GB', { used: pi.storageUsed, total: pi.storageTotal }) : info.storage ? t('{used} of {total} GB', { used: info.storage.used, total: info.storage.total }) : ''],
          [t('Network'), [pi.wifi, pi.cell].filter(Boolean).join(' · ')],
          [t('Link'), via],
          ['TwinDesk', D.version(ctl)],
        ]);

        media.update(s, ov);
        lower.update(s, { phone: true, devName });
        if (rezume) rezume.update(s, devName);
      };
    },
  });
})();

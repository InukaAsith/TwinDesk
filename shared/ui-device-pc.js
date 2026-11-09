// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Overview of another computer (Mac, PC and Linux), shown once one is connected; its tile at the
// top of the sidebar opens it too. Before that, Connection is the start.
//   Both computers and the link; Ring, Lock, Sleep, Wi-Fi Direct and Disconnect; its Bluetooth, Do
//   not disturb and volume; what plays there; ReZume's offer; then what each feature that's on has
//   (shared/ui-device-parts.js). The switches themselves are on each feature's page.
// A phone's Overview: shared/ui-device-android.js, an iPhone's or iPad's: shared/ui-device-ios.js.
'use strict';

(function () {
  const D = UI.deviceParts;
  const { t } = D;

  UI.tab({
    id: 'overview',
    for: ['computer'],
    order: 0,
    title: 'Overview',
    heading: 'Overview',
    icon: 'overview',
    color: 'linear-gradient(#8e8e93, #636366)',
    desc: '',
    hidden: (s) => !D.linked(s), // Connection until something is connected
    build(body, page) {
      const { api } = UI;
      const { h1, desc, row, doIt } = D.setup(body, page);

      const ring = D.ring(doIt);
      const lockBtn = D.button(t('Lock'), 'lock', () => doIt({ do: 'lock' }));
      const sleepBtn = D.button(t('Sleep'), 'sleep', () => doIt({ do: 'sleep' }));
      const wifi = D.wifi();
      const discBtn = D.button(t('Disconnect'), 'disconnect', () => api.disconnect());
      const hero = D.hero([ring.btn, lockBtn, sleepBtn, wifi.btn, discBtn], ring.note);
      const notConnected = UI.note('info', '');
      const media = D.media();

      // ---- its controls ----
      const pcBt = UI.switch((v) => doIt({ do: 'bluetooth', on: v }), { label: t('Bluetooth') });
      const pcDnd = UI.switch((v) => doIt({ do: 'dnd', on: v }), { label: t('Do not disturb') });
      const pcBtRow = row(t('Bluetooth'), '', [pcBt]);
      const pcDndRow = row(t('Do not disturb'), '', [pcDnd]);
      const pcVol = UI.slider({ min: 0, max: 100, step: 1, format: (v) => v + '%' }, (v) => doIt({ do: 'volume', level: v / 100 }));
      const pcVolRow = row(t('Volume'), '', [pcVol]);
      const pcCard = UI.card(t('Controls'), [pcBtRow, pcDndRow, pcVolRow]);

      const rezume = D.rezume();
      const lower = D.lower(row);
      const airplay = D.airplay();
      body.append(notConnected, hero.el, ...(airplay ? [airplay.el] : []), media.el, pcCard, ...(rezume ? [rezume.el] : []), lower.el);

      return (s) => {
        if (airplay) airplay.update(s);
        const on = D.linked(s);
        notConnected.set(on ? '' : t('Nothing is connected. Connect a phone or computer on the Connection page.'));
        for (const x of [hero.el, media.el, pcCard, lower.el]) x.hidden = !on;
        if (!on) return;
        const p = UI.peer(s);
        const ctl = s.peerCtl || null; // what the other side can do (deviceDo), null: an older TwinDesk
        const can = (k) => !!(ctl && ctl.can && ctl.can[k]);
        const ov = (s.ui && s.ui.overview) || {}; // General › Overview: what's left out

        // hero
        const devName = (s.peer && s.peer.name) || (s.client && s.client.name) || p.name;
        h1.textContent = devName;
        hero.name.textContent = devName;
        hero.pic.className = 'device big ' + UI.osClass(p.os);
        hero.pic.style.removeProperty('--phone-wall');
        const rtt = s.link ? s.link.rtt : s.client && s.client.rttMs;
        const via = D.viaOf(s);
        desc.textContent = { mac: 'Mac', win: t('Windows PC'), linux: t('Linux computer') }[p.os] || '';
        hero.sub.textContent = [t('Connected'), via, rtt != null ? t('{value} ms', { value: rtt }) : ''].filter(Boolean).join(' · ');
        hero.battery(s.peerInfo && s.peerInfo.battery, s.peerInfo && s.peerInfo.charging);
        ring.update(ctl);
        lockBtn.hidden = !can('lock');
        sleepBtn.hidden = !can('sleep');
        wifi.update(s);
        hero.setFacts([
          [t('System'), s.peer && s.peer.osVersion],
          [t('Address'), (s.paired && s.paired.address) || (s.client && s.client.address)],
          [t('Link'), via],
          ['TwinDesk', D.version(ctl)],
        ]);

        media.update(s, ov);

        // its controls
        pcCard.hidden = !(can('bluetooth') || can('dnd') || can('volume'));
        if (!pcCard.hidden) {
          pcBtRow.hidden = !can('bluetooth');
          pcBt.set(!!ctl.bluetooth);
          pcDndRow.hidden = !can('dnd');
          pcDnd.set(!!ctl.dnd);
          pcVolRow.hidden = !can('volume');
          if (ctl.volume != null) pcVol.set(Math.round(ctl.volume * 100));
        }

        lower.update(s, { phone: false, devName });
        if (rezume) rezume.update(s, devName);
      };
    },
  });
})();

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Mirroring of an iPhone or iPad (Mac, PC and Linux), in Mirroring's place while one is connected.
// iOS lets no app give its screen or take input, so the iPhone shares it itself: Show asks it
// (phone.mirror.want), Start Broadcast there starts its Share Screen (a broadcast extension), and
// the picture opens here in a window (shared/nativescreen.js; the Mac takes it over the USB cable
// when one is plugged in), at the picture quality picked here. Its sound comes here over AirPlay
// (AirPlay & SMB). What's open here, with Close. An Android phone's: shared/ui-mirror.js.
'use strict';

(function () {
  const tr = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
  const mac = /Mac/.test(navigator.platform);
  const linux = /Linux/.test(navigator.platform);
  const here = mac ? tr('this Mac') : linux ? tr('this computer') : tr('this PC');

  UI.tab({
    id: 'ios-mirror',
    variantOf: 'mirror',
    for: ['ios'],
    order: 9,
    title: tr('Mirroring'),
    icon: 'phone',
    color: 'linear-gradient(#64d2ff, #0a84ff)',
    desc: tr('Its screen in a window here, shared from the iPhone or iPad itself.'),
    hidden: (s) => !(s && s.phone && s.phone.connected),
    build(body) {
      const { el, api } = UI;
      const showBtn = UI.button(tr('Show screen'), () => api.phoneScreen(true), 'primary');
      const showRow = UI.row(tr('Phone screen'), '', [showBtn], { literal: true }); // its name: as it is
      const winList = el('div');
      const winCard = UI.card(tr('Open on {computer}', { computer: here }), [winList]);
      // Its broadcast's bitrate (phone.mirror.want, from the same setting as an Android phone's screen).
      const quality = UI.select([
        { value: '4', label: tr('Data saver · 4 Mb/s') }, { value: '8', label: tr('Balanced · 8 Mb/s') },
        { value: '16', label: tr('Sharp · 16 Mb/s') }, { value: '24', label: tr('Sharpest · 24 Mb/s') },
      ], (v) => api.setPhone({ bitrateMbps: Number(v) }));
      const qualityRow = UI.row(tr('Picture quality'), '', [quality]);
      const soundRow = UI.row(tr('Sound'), '', [UI.button(tr('AirPlay & SMB'), () => UI.go('airplay'), 'small')]);
      body.append(UI.card('', [showRow]), winCard, UI.card('', [qualityRow, soundRow]));

      let winKey = '';
      return (s) => {
        const ph = s.phone || {};
        const br = ph.bridge || {};
        const name = (ph.connected && ph.connected.name) || tr('the phone');
        const ble = !!(UI.onBle && UI.onBle(s));
        showRow.label.textContent = name;
        showBtn.disabled = ble;
        showRow.setHint(ble ? tr('Screens need Wi-Fi: {phone} is connected through Bluetooth', { phone: name })
          : tr('Asks {phone} to share its screen: Start Broadcast there, or Screen Mirroring to {computer} (its AirPlay receiver is turned on for it).', { phone: name, computer: here }));
        soundRow.setHint(tr('Its sound plays here over AirPlay: Control Center on {phone}, Screen Mirroring or the AirPlay button, then {computer}.', { phone: name, computer: here }));
        quality.set(String((ph.settings || {}).bitrateMbps || 8));
        const wins = br.windows || [];
        winCard.hidden = !wins.length;
        const wk = JSON.stringify(wins);
        if (wk !== winKey) {
          winKey = wk;
          winList.replaceChildren(...wins.map((w) => UI.row(w.kind === 'screen' ? name : w.title, w.kind === 'screen' ? tr('Mirror') : w.app, [UI.button(tr('Close'), () => api.phoneCloseView(w.id), 'small')], { literal: true })));
        }
      };
    },
  });
})();

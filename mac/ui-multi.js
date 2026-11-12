// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device tab, one-to-one app: what it is and the button that turns it on (multi.js). TwinDesk
// restarts into mesh/main.js, whose own page (mesh/ui-multi.js) has the settings for several devices.
'use strict';

UI.tab({
  id: 'multi',
  order: 95,
  title: I18n.t('Multi-device'),
  desc: I18n.t('Several computers and phones connected at once'),
  color: 'linear-gradient(#5e5ce6, #3634a3)',
  bottom: true,
  build(body) {
    const { api } = UI;
    // The popup (shared/mesh-intro.js) says before it restarts that with two devices the normal mode is the one to use.
    const turnOn = UI.button(I18n.t('Turn on'), () => MeshIntro.confirm(() => {
      turnOn.disabled = true;
      turnOn.textContent = I18n.t('Restarting…');
      api.setMulti(true);
    }), 'small primary');

    body.append(
      UI.card(I18n.t('Mesh mode'), [
        UI.row(I18n.t('Use several devices at once'),
          I18n.t('Computers and phones connected at the same time: one clipboard and one set of notifications for all, each screen edge leading to another device, a phone and a computer together'),
          [turnOn]),
      ]),
      UI.note('info', I18n.t('TwinDesk restarts when you turn it on or off.')),
      MeshIntro.art(),
    );

    return () => {};
  },
});

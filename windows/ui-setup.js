// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Setup screen: a full page before the
// tabs while something isn't ready: firewall and network profile (Fix, one UAC prompt), the
// mouse and keyboard helper, and the display driver for Extend (optional). "Skip for now" is
// remembered until something new is missing. No sidebar while it shows.
'use strict';

UI.setup = (() => {
  const { el, api } = UI;
  const done = () => el('span', { class: 'pill good', text: 'Done' });

  const fwFix = UI.button('Fix', () => api.fixFirewall(), 'small primary');
  const fwDone = done();
  const fwRow = UI.row('Firewall and network', '', [fwFix, fwDone]);
  const helperPill = el('span', { class: 'pill bad', text: 'Not running' });
  const helperDone = done();
  const helperRow = UI.row('Mouse and keyboard helper', '', [helperPill, helperDone]);
  const drvBtn = UI.button('Install', () => api.installVdd(), 'small');
  const drvDone = done();
  const drvRow = UI.row('TwinDesk virtual display', '', [drvBtn, drvDone]);

  const page = el('section', { class: 'setup-page', hidden: true }, [
    el('div', { class: 'app-mark', attrs: { 'aria-hidden': 'true' } }),
    el('h1', { text: 'Set up TwinDesk' }),
    el('p', { text: 'A few things before {me} can share with the other computer.' }),
    UI.card('', [fwRow, helperRow, drvRow]),
    el('div', { class: 'setup-foot' }, [
      el('span', { class: 'hint', text: 'You can change these later in General and Display.' }),
      UI.button('Skip for now', () => api.skipSetup(), ''),
    ]),
  ]);

  // Rows stay once shown (with Done when fixed), so the page doesn't jump while you work through it.
  const shown = new Set();

  function render(s) {
    page.hidden = !s.setup.show;
    document.body.classList.toggle('setup', !page.hidden);
    if (page.hidden) return;
    for (const m of s.setup.missing) shown.add(m);

    const fw = s.firewall || {};
    const fwBad = s.setup.missing.includes('firewall');
    fwRow.hidden = !shown.has('firewall');
    fwRow.setHint(fw.checking ? 'Checking…' : fwBad ? (fw.message || '') + ' Fix asks for administrator rights once.' : '');
    fwFix.hidden = !fwBad || fw.checking;
    fwDone.hidden = fwBad || fw.checking;

    const h = s.kvmState.helper;
    const helperBad = s.setup.missing.includes('helper');
    helperRow.hidden = !shown.has('helper');
    helperRow.setHint(helperBad ? h + '. Restart TwinDesk if it stays like this.' : '');
    helperPill.hidden = !helperBad;
    helperDone.hidden = helperBad;

    const v = s.pcScreen.vdd;
    const drvBad = s.setup.missing.includes('driver');
    drvRow.hidden = !shown.has('driver');
    drvRow.setHint(v.busy === 'install' ? 'Installing…' : drvBad ? 'Optional. Adds an extra screen for the other computer (Extend). Installs a display driver and asks for administrator rights once.' : '');
    drvBtn.hidden = !drvBad;
    drvBtn.disabled = !!v.busy;
    drvDone.hidden = drvBad;
  }

  return { page, render };
})();

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Setup screen (same page as the PC's):
// a full page before the tabs while something isn't ready: the desktop session, input access on
// Wayland (Fix = uinput rule + the input group, one password prompt), the firewall (Fix
// through pkexec), the mouse and keyboard helper. "Skip for now" is remembered until something new
// is missing. No sidebar while it shows.
'use strict';

UI.setup = (() => {
  const { el, api } = UI;
  const done = () => el('span', { class: 'pill good', text: 'Done' });

  const sessPill = el('span', { class: 'pill muted' });
  const sessRow = UI.row('Desktop session', '', [sessPill]);
  const inFix = UI.button('Fix', () => api.fixInput(), 'small primary');
  const inDone = done();
  const inRow = UI.row('Input access', '', [inFix, inDone]);
  const fwFix = UI.button('Fix', () => api.fixFirewall(), 'small primary');
  const fwDone = done();
  const fwRow = UI.row('Firewall', '', [fwFix, fwDone]);
  const helperPill = el('span', { class: 'pill bad', text: 'Not running' });
  const helperDone = done();
  const helperRow = UI.row('Mouse and keyboard helper', '', [helperPill, helperDone]);

  const page = el('section', { class: 'setup-page', hidden: true }, [
    el('div', { class: 'app-mark', attrs: { 'aria-hidden': 'true' } }),
    el('h1', { text: 'Set up TwinDesk' }),
    el('p', { text: 'A few things before {me} can share with the other computer.' }),
    UI.card('', [sessRow, inRow, fwRow, helperRow]),
    el('div', { class: 'setup-foot' }, [
      el('span', { class: 'hint', text: 'You can change these later in General.' }),
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

    const ss = s.session || {};
    sessRow.hidden = !shown.has('session');
    sessPill.textContent = 'No desktop';
    sessRow.setHint('No X11 or Wayland display found. Start TwinDesk from your desktop.');

    const inBad = s.setup.missing.includes('input');
    inRow.hidden = !shown.has('input');
    inRow.setHint(ss.inputNote || (inBad ? 'Wayland lets TwinDesk share the mouse and keyboard through /dev/uinput and /dev/input. Fix sets that up once (asks for your password); then log out and back in.' : ''));
    inFix.hidden = !inBad;
    inDone.hidden = inBad;

    const fw = s.firewall || {};
    const fwBad = s.setup.missing.includes('firewall');
    fwRow.hidden = !shown.has('firewall');
    fwRow.setHint(fw.checking ? 'Checking…' : fwBad ? (fw.message || '') + ' Fix lets ports ' + UI.P.PORT + ' and ' + UI.P.DISCOVERY_PORT + ' in (asks for your password).' : '');
    fwFix.hidden = !fwBad || fw.checking;
    fwDone.hidden = fwBad || fw.checking;

    const h = s.kvmState.helper;
    const helperBad = s.setup.missing.includes('helper');
    helperRow.hidden = !shown.has('helper');
    helperRow.setHint(helperBad ? h + '. Restart TwinDesk if it stays like this.' : '');
    helperPill.hidden = !helperBad;
    helperDone.hidden = helperBad;
  }

  return { page, render };
})();

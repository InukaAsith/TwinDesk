// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Setup screen (same page as the PC's):
// a full page before the tabs while something isn't ready: the desktop session, input access on
// Wayland (Fix = the helper's own setgid input copy + a uinput rule, one password prompt; never the
// user in the input group, #144), the firewall (Fix
// through pkexec), the mouse and keyboard helper. "Skip for now" is remembered until something new
// is missing. No sidebar while it shows.
'use strict';

UI.setup = (() => {
  const { el, api } = UI;
  const t = (...args) => I18n.t(...args);
  const language = UI.select([
    { value: 'en', label: '🇬🇧 English' }, { value: 'zh-CN', label: '🇨🇳 简体中文' }, { value: 'ru', label: '🇷🇺 Русский' }, { value: 'tr', label: '🇹🇷 Türkçe' }, { value: 'pt-BR', label: '🇧🇷 Português (Brasil)' },
  ], (v) => api.setLanguage(v));
  language.set(I18n.locale);
  const done = () => el('span', { class: 'pill good', text: t('Done') });

  const sessPill = el('span', { class: 'pill muted' });
  const sessRow = UI.row(t('Desktop session'), '', [sessPill]);
  const inFix = UI.button(t('Fix'), () => api.fixInput(), 'small primary');
  const inDone = done();
  const inRow = UI.row(t('Input access'), '', [inFix, inDone]);
  const fwFix = UI.button(t('Fix'), () => api.fixFirewall(), 'small primary');
  const fwDone = done();
  const fwRow = UI.row(t('Firewall'), '', [fwFix, fwDone]);
  const helperPill = el('span', { class: 'pill bad', text: t('Not running') });
  const helperDone = done();
  const helperRow = UI.row(t('Mouse and keyboard helper'), '', [helperPill, helperDone]);

  const page = el('section', { class: 'setup-page', hidden: true }, [
    el('div', { class: 'app-mark', attrs: { 'aria-hidden': 'true' } }),
    el('h1', { text: t('Set up TwinDesk') }),
    el('p', { text: t('A few things before {me} can share with the other computer.') }),
    UI.card('', [UI.row(t('Language'), t('Some pages are still in English. Changing the language restarts TwinDesk.'), [language])]),
    UI.card('', [sessRow, inRow, fwRow, helperRow]),
    el('div', { class: 'setup-foot' }, [
      el('span', { class: 'hint', text: t('You can change these later in General.') }),
      UI.button(t('Skip for now'), () => api.skipSetup(), ''),
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
    inRow.setHint(ss.inputNote || (!inBad ? '' : (ss.access || {}).stale ? 'TwinDesk was updated: Fix once more for its new helper (asks for your password).'
      : 'On Wayland, TwinDesk’s helper reads the mouse and keyboard (/dev/input) to see them cross to the other computer, and injects through /dev/uinput. Fix gives that to the helper alone, not to your account, so other programs still can’t read your keyboard (asks for your password once). General › Input access › Remove undoes it.'));
    inFix.hidden = !inBad;
    inDone.hidden = inBad;

    const fw = s.firewall || {};
    const fwBad = s.setup.missing.includes('firewall');
    fwRow.hidden = !shown.has('firewall');
    fwRow.setHint(fw.checking ? t('Checking…') : fwBad ? t('{message} Fix lets ports {port} and {discovery} in (asks for your password).', { message: fw.message || '', port: UI.P.PORT, discovery: UI.P.DISCOVERY_PORT }) : '');
    fwFix.hidden = !fwBad || fw.checking;
    fwDone.hidden = fwBad || fw.checking;

    const h = s.kvmState.helper;
    const helperBad = s.setup.missing.includes('helper');
    helperRow.hidden = !shown.has('helper');
    helperRow.setHint(helperBad ? t('{message}. Restart TwinDesk if it stays like this.', { message: t(h) }) : '');
    helperPill.hidden = !helperBad;
    helperDone.hidden = helperBad;
  }

  return { page, render };
})();

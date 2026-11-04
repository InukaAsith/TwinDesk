// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Setup screen: a full page before the
// tabs while something isn't ready: firewall and network profile (Fix, one UAC prompt), the
// mouse and keyboard helper, and the display driver for Extend (optional). "Skip for now" is
// remembered until something new is missing. No sidebar while it shows.
'use strict';

UI.setup = (() => {
  const { el, api } = UI;
  const t = (...args) => I18n.t(...args);
  const language = UI.select([
    { value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' }, { value: 'ru', label: 'Русский' }, { value: 'tr', label: 'Türkçe' },
  ], (v) => api.setLanguage(v));
  language.set(I18n.locale);
  const done = () => el('span', { class: 'pill good', text: t('Done') });

  const fwFix = UI.button(t('Fix'), () => api.fixFirewall(), 'small primary');
  const fwDone = done();
  const fwRow = UI.row(t('Firewall and network'), '', [fwFix, fwDone], { literal: true });
  const helperPill = el('span', { class: 'pill bad', text: t('Not running') });
  const helperDone = done();
  const helperRow = UI.row(t('Mouse and keyboard helper'), '', [helperPill, helperDone]);
  const drvBtn = UI.button(t('Install'), () => api.installVdd(), 'small');
  const drvDone = done();
  const drvRow = UI.row(t('TwinDesk virtual display'), '', [drvBtn, drvDone]);

  const page = el('section', { class: 'setup-page', hidden: true }, [
    el('div', { class: 'app-mark', attrs: { 'aria-hidden': 'true' } }),
    el('h1', { text: t('Set up TwinDesk') }),
    el('p', { text: t('A few things before {me} can share with the other computer.') }),
    UI.card('', [UI.row(t('Language'), t('Some pages are still in English. Changing the language reloads this window.'), [language])]),
    UI.card('', [fwRow, helperRow, drvRow]),
    el('div', { class: 'setup-foot' }, [
      el('span', { class: 'hint', text: t('You can change these later in General and Display.') }),
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

    const fw = s.firewall || {};
    const fwBad = s.setup.missing.includes('firewall');
    fwRow.hidden = !shown.has('firewall');
    fwRow.setHint(fw.checking ? t('Checking…') : fwBad ? t('{message} Fix asks for administrator rights once.', { message: UI.firewallHint(fw) }) : '');
    fwFix.hidden = !fwBad || fw.checking;
    fwDone.hidden = fwBad || fw.checking;

    const h = s.kvmState.helper;
    const helperBad = s.setup.missing.includes('helper');
    helperRow.hidden = !shown.has('helper');
    helperRow.setHint(helperBad ? t('{message}. Restart TwinDesk if it stays like this.', { message: t(h) }) : '');
    helperPill.hidden = !helperBad;
    helperDone.hidden = helperBad;

    const v = s.pcScreen.vdd;
    const drvBad = s.setup.missing.includes('driver');
    drvRow.hidden = !shown.has('driver');
    drvRow.setHint(v.busy === 'install' ? t('Installing…') : drvBad ? t('Optional. Adds an extra screen for the other computer (Extend). Installs a display driver and asks for administrator rights once.') : '');
    drvBtn.hidden = !drvBad;
    drvBtn.disabled = !!v.busy;
    drvDone.hidden = drvBad;
  }

  return { page, render };
})();

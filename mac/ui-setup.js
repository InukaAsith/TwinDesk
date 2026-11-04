// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Setup: shown instead of the tabs while something TwinDesk needs
// isn't allowed yet, once: after everything is allowed or it's skipped, General shows what's missing. "Allow" asks macOS first, which puts TwinDesk in the System Settings list, so
// it's one switch there (no + and file browser). Closes by itself when everything is allowed.
'use strict';

UI.setup = (() => {
  const { el, api } = UI;
  const t = (...args) => I18n.t(...args);
  const language = UI.select([
    { value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' }, { value: 'ru', label: 'Русский' }, { value: 'tr', label: 'Türkçe' },
  ], (v) => api.setLanguage(v));
  language.set(I18n.locale);
  const ITEMS = [
    { kind: 'screen', label: t('Screen Recording'), note: t('To share this Mac’s screen'), missing: (s) => s.permissions.screen !== 'granted' },
    { kind: 'accessibility', label: t('mac.accessibility'), note: t('So the other computer can control this Mac'), missing: (s) => !s.permissions.accessibility },
    { kind: 'inputMonitoring', label: t('Input Monitoring'), note: t('To use this keyboard on the other computer'), missing: (s) => s.permissions.inputMonitoring === false },
    { kind: 'localNetwork', label: t('Local Network'), note: t('To find your other computers'), missing: (s) => !!s.discovery && s.discovery.localNetwork === false },
  ];
  const rows = ITEMS.map((it) => {
    const pill = el('span', { class: 'pill good', text: t('Allowed') });
    const btn = UI.button(t('Allow'), () => api.allowPermission(it.kind), 'small primary');
    return { it, pill, btn, row: UI.row(it.label, it.note, [pill, btn]) };
  });
  let missingKey = '';
  const page = el('section', { class: 'setup-page', hidden: true }, [
    el('div', { class: 'app-mark', attrs: { 'aria-hidden': 'true' } }),
    el('h1', { text: t('Set up TwinDesk') }),
    el('p', { text: t('macOS needs your OK for a few things.') }),
    UI.card('', [UI.row(t('Language'), t('Changing the language reloads this window.'), [language])]),
    UI.card('', rows.map((r) => r.row)),
    el('div', { class: 'setup-foot' }, [
      UI.button(t('Restart TwinDesk'), () => api.relaunch(), ''),
      UI.button(t('Skip for now'), () => api.skipSetup(missingKey), ''),
    ]),
  ]);
  document.getElementById('content').prepend(page);

  const missing = (s) => (s && s.permissions ? ITEMS.filter((it) => it.missing(s)).map((it) => it.kind) : []);

  return {
    // Returns true while Setup is showing (the tabs are hidden then).
    render(s) {
      const m = missing(s);
      missingKey = m.join(',');
      const skipped = new Set(((s.ui && s.ui.setupSkipped) || '').split(',').filter(Boolean));
      const show = !(s.ui && s.ui.setupDone) && m.length > 0 && m.some((k) => !skipped.has(k));
      page.hidden = !show;
      document.body.classList.toggle('setup', show);
      document.getElementById('pages').hidden = show;
      for (const r of rows) {
        const miss = m.includes(r.it.kind);
        r.pill.hidden = miss;
        // Accessibility covers the keyboard tap, so macOS reads Input Monitoring as allowed with its switch off.
        if (r.it.kind === 'inputMonitoring') r.pill.textContent = s.permissions && s.permissions.accessibility ? t('Allowed by Accessibility') : t('Allowed');
        r.btn.hidden = !miss;
        // Local Network only matters when it's actually blocked.
        r.row.hidden = r.it.kind === 'localNetwork' && !miss;
      }
      return show;
    },
  };
})();

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Setup: shown instead of the tabs while something TwinDesk needs
// isn't allowed yet, once: after everything is allowed or it's skipped, General shows what's missing. "Allow" asks macOS first, which puts TwinDesk in the System Settings list, so
// it's one switch there (no + and file browser). Closes by itself when everything is allowed.
'use strict';

UI.setup = (() => {
  const { el, api } = UI;
  const ITEMS = [
    { kind: 'screen', label: 'Screen Recording', note: 'To share this Mac’s screen', missing: (s) => s.permissions.screen !== 'granted' },
    { kind: 'accessibility', label: 'Accessibility', note: 'So the other computer can control this Mac', missing: (s) => !s.permissions.accessibility },
    { kind: 'inputMonitoring', label: 'Input Monitoring', note: 'To use this keyboard on the other computer', missing: (s) => s.permissions.inputMonitoring === false },
    { kind: 'localNetwork', label: 'Local Network', note: 'To find your other computers', missing: (s) => !!s.discovery && s.discovery.localNetwork === false },
  ];
  const rows = ITEMS.map((it) => {
    const pill = el('span', { class: 'pill good', text: 'Allowed' });
    const btn = UI.button('Allow', () => api.allowPermission(it.kind), 'small primary');
    return { it, pill, btn, row: UI.row(it.label, it.note, [pill, btn]) };
  });
  let missingKey = '';
  const page = el('section', { class: 'setup-page', hidden: true }, [
    el('div', { class: 'app-mark', attrs: { 'aria-hidden': 'true' } }),
    el('h1', { text: 'Set up TwinDesk' }),
    el('p', { text: 'macOS needs your OK for a few things.' }),
    UI.card('', rows.map((r) => r.row)),
    el('div', { class: 'setup-foot' }, [
      UI.button('Restart TwinDesk', () => api.relaunch(), ''),
      UI.button('Skip for now', () => api.skipSetup(missingKey), ''),
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
        if (r.it.kind === 'inputMonitoring') r.pill.textContent = s.permissions && s.permissions.accessibility ? 'Allowed by Accessibility' : 'Allowed';
        r.btn.hidden = !miss;
        // Local Network only matters when it's actually blocked.
        r.row.hidden = r.it.kind === 'localNetwork' && !miss;
      }
      return show;
    },
  };
})();

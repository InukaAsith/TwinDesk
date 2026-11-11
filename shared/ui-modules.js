// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Settings › General › Modules (Mac, PC and Linux): a switch per module (shared/modules.js). Off:
// the page's own switch goes off first (so whatever it ran stops, through the page's usual path),
// then after a restart its scripts aren't loaded and its page is gone. On again: after the restart
// its page's switch comes back on if it was on when the module went off.
// UI.modulesCard() → {card, update(state)}.
'use strict';

UI.modulesCard = () => {
  const t = (...args) => (typeof I18n === 'undefined' ? args[0] : I18n.t(...args));
  const M = window.TdModules;
  // The modules this app has: a page registered, a page skipped, or a script skipped (off at start).
  const known = new Set([
    ...UI.tabs.map((d) => M.ofPage(d.id)).filter(Boolean),
    ...(M.skipped || []),
  ]);
  const defsOf = (id) => UI.tabs.filter((d) => M.ofPage(d.id) === id);
  const switchOf = (id) => { const d = defsOf(id).find((x) => x.master || x.moduleSwitch); return d ? d.master || d.moduleSwitch : null; };

  let cur = null;
  const rows = [];
  const sws = {};
  for (const m of M.LIST) {
    if (!known.has(m.id)) continue;
    const sw = UI.switch((on) => {
      const ctl = switchOf(m.id);
      const wasOn = !!(ctl && cur && ctl.get(cur));
      if (!on && wasOn) ctl.set(false); // stop it the way its page does
      UI.api.setModules({ id: m.id, on, wasOn });
    }, { label: t(m.label) });
    sws[m.id] = sw;
    rows.push(UI.row(t(m.label), '', [sw]));
  }
  const restartRow = UI.row(t('Restart to apply'), t('Modules load or unload when TwinDesk starts'), [UI.button(t('Restart'), () => UI.api.relaunch(), 'small primary')]);
  restartRow.hidden = true;
  const head = UI.row(t('Modules'), t('A module that’s off isn’t loaded at all: no page, no menu items, nothing running. General, About, Connection and Overview are always on.'), []);
  const card = UI.card(t('Modules'), [head, restartRow, ...rows]);

  return {
    card,
    update(s) {
      cur = s;
      const v = s && s.modules;
      if (!v) return;
      for (const [id, sw] of Object.entries(sws)) sw.set(!v.off.includes(id));
      restartRow.hidden = !v.restart;
    },
  };
};

// On again after a restart: its page's switch back as it was when the module went off. Once per
// window, whichever page is open.
window.addEventListener('load', () => {
  if (!UI.api || !UI.api.getState || !window.TdModules) return;
  Promise.resolve(UI.api.getState()).then((s) => {
    for (const id of (s && s.modules && s.modules.restore) || []) {
      const d = UI.tabs.find((x) => TdModules.ofPage(x.id) === id && (x.master || x.moduleSwitch));
      const ctl = d && (d.master || d.moduleSwitch);
      if (ctl && !ctl.get(s)) ctl.set(true);
      UI.api.setModules({ restored: id });
    }
  }).catch(() => {});
});

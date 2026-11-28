// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Multi-device › Phones: whether a phone may manage this computer from its mesh manager (wake, lock,
// sleep, restart, shut down, pairings, the layout: shared/mesh-manage.js), and each phone that did, with
// Revoke. state.manage = {on, phones: [{id, name, revoked}]}.
//   const pm = MeshPhones.create({ setOn(on), setRevoked(id, revoked) })
//   body.append(UI.card(I18n.t('Phones'), [pm.el])); pm.render(state.manage)
'use strict';

(function () {
  function create(opts) {
    const t = (k, v) => I18n.t(k, v);
    const el = UI.el('div', { class: 'mm-phones' });
    const sw = UI.switch((v) => opts.setOn(v), { label: t('Let phones manage this computer') });
    const row = UI.row(t('Let phones manage this computer'), t('From a phone’s Overview › Computers: wake, lock, sleep, restart or shut down this computer, answer a pairing, arrange the layout. Restart, shut down and pairings ask for the phone’s fingerprint'), [sw]);
    const list = UI.el('div', { class: 'mm-phone-list' });
    el.append(row, list);
    let lastKey = '';

    function render(m) {
      if (!m) { el.hidden = true; return; }
      el.hidden = false;
      sw.set(m.on !== false);
      const key = JSON.stringify(m);
      if (key === lastKey) return;
      lastKey = key;
      list.textContent = '';
      for (const p of m.phones || []) {
        const b = UI.button(p.revoked ? t('Allow') : t('Revoke'), () => opts.setRevoked(p.id, !p.revoked), 'small');
        const r = UI.row(p.name, p.revoked ? t('Revoked: it can’t manage this computer') : t('Has managed this computer'), [b]);
        const name = r.querySelector && r.querySelector('.row-label, .label');
        if (name) name.setAttribute('data-literal', '');
        list.append(r);
      }
    }

    return { el, render };
  }

  window.MeshPhones = { create };
})();

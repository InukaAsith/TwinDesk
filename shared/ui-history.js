// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// History on the Clipboard and Notifications pages (Mac, Windows, Linux): Keep history (off at
// first) and for how long, the kept items encrypted on this computer (shared/histkeeper.js).
// UI.historyCard(what, {list}) → {el, update(state)}; what: 'clip' | 'notifs'. The kept history is
// opened (the system's safe storage read, the one time a session) when this page is first shown
// with Keep history on — never when TwinDesk starts. list: the notifications themselves too (a
// page that has no list of its own).
'use strict';

(function () {
  const t = (s, v) => I18n.t(s, v);
  UI.historyCard = function (what, { list = false } = {}) {
    const { el } = UI;
    const keep = UI.switch((v) => UI.api.history({ do: 'set', save: v }), { label: t('Keep history') });
    const days = UI.select([
      { value: '1', label: t('A day') }, { value: '7', label: t('A week') },
      { value: '30', label: t('30 days') }, { value: '365', label: t('A year') },
    ], (v) => UI.api.history({ do: 'set', days: Number(v) }));
    const keepRow = UI.row(t('Keep history'), '', [keep.el]);
    const daysRow = UI.row(t('Keep for'), t('Older items are deleted'), [days.el]);
    const err = UI.note('warn', '', { literal: true });
    err.hidden = true;
    const items = list ? el('div', { class: 'history' }) : null;
    const card = UI.card(what === 'clip' ? t('History') : t('Notification history'), [keepRow, daysRow, err, items].filter(Boolean));
    let asked = false;
    let lastKey = '';
    return {
      el: card,
      update(s) {
        const h = s.history;
        card.hidden = !h;
        if (!h) return;
        keep.set(h.save);
        days.set(String(h.days));
        daysRow.hidden = !h.save;
        keepRow.setHint(h.save ? t('Encrypted on this computer, and opened only when you look at it') : t('Off: forgotten when TwinDesk quits'));
        err.set(h.error || '');
        // Looked at with Keep history on: the kept ones come back (once a session).
        if (h.save && h.open && !h.open[what] && !asked && card.isConnected && card.offsetParent !== null) {
          asked = true;
          UI.api.history({ do: 'unlock', what });
        }
        if (!h.save) asked = false;
        if (!items) return;
        const hist = (s.notifs && s.notifs.history) || [];
        const key = JSON.stringify(hist.map((x) => [x.id, x.at])) + Math.floor(Date.now() / 15000);
        if (key === lastKey) return;
        lastKey = key;
        items.replaceChildren(...(hist.length ? hist.slice(0, 200).map((x) => el('div', { class: 'hist-item' }, [
          el('div', { class: 'hist-text' }, [
            el('div', { class: 'hist-preview selectable', attrs: { 'data-literal': '' }, text: [x.title, x.body].filter(Boolean).join(' — ') }),
            el('div', { class: 'hint', attrs: { 'data-literal': '' }, text: `${x.appName || x.app || ''} · ${UI.ago ? UI.ago(x.at) : new Date(x.at).toLocaleString()}` }),
          ]),
        ])) : [UI.row(t('Nothing yet'), '')]));
      },
    };
  };
})();

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files waiting to go (shared/outbox.js) on the File Sharing page (Mac, Windows, Linux): what was
// sent while nothing was connected, paused or cut off, with Resume and Remove, and how long it's kept.
//   const box = UI.outboxCard(api); body.append(box.card); box.update(s.files);
// api: setFiles({outboxHours}), resumeSend(id), forgetSend(id). files.outbox: [{id, state, name, files,
// peerName, at}]; files.outboxHours.
'use strict';

(function () {
  UI.outboxCard = (api) => {
    const t = (k, v) => I18n.t(k, v);
    const { el } = UI;
    const keep = UI.select([
      { value: 0, label: t('Off') }, { value: 1, label: t('1 hour') }, { value: 24, label: t('1 day') }, { value: 168, label: t('1 week') },
    ], (v) => api.setFiles({ outboxHours: Number(v) }));
    const keepRow = UI.row(t('Keep files to send'), t('Sent while the other device isn’t connected, or cut off: they go when it’s back'), [keep.el || keep], { literalHint: true });
    const list = el('div', { class: 'history' });
    const card = UI.card(t('Waiting to send'), [list, keepRow], { cls: 'keep-on' });
    let key = '';

    const update = (f) => {
      if (!f) return;
      keep.set(f.outboxHours === undefined ? 24 : f.outboxHours);
      const box = Array.isArray(f.outbox) ? f.outbox : [];
      const k = JSON.stringify(box) + Math.floor(Date.now() / 60000);
      if (k === key) return;
      key = k;
      list.hidden = !box.length;
      list.replaceChildren(...box.map((e) => el('div', { class: 'hist-item' }, [
        el('span', { class: 'hist-dir out' }, [UI.icon('up')]),
        el('div', { class: 'hist-text' }, [
          el('div', { class: 'hist-preview', text: e.name || t(e.files === 1 ? '{count} file' : '{count} files', { count: e.files }) }),
          el('div', { class: 'hint', text: `${e.state === 'paused' ? t('Paused') : t('Waiting for {device}', { device: e.peerName || t('the other device') })}, ${UI.ago(e.at)}` }),
        ]),
        e.state === 'paused' ? UI.button(t('Resume'), () => api.resumeSend(e.id), 'small') : null,
        UI.button(t('Remove'), () => api.forgetSend(e.id), 'small'),
      ])));
    };
    return { card, update };
  };
})();

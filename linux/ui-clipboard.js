// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard tab: accept (Mac → PC) and send (PC → Mac) as two direction cards, then
// timing, privacy and the Recent list for both.
'use strict';

UI.tab({
  id: 'clipboard',
  order: 40,
  title: I18n.t('Clipboard'),
  color: 'linear-gradient(#64d2ff, #30b0c7)',
  desc: I18n.t('Copy on one computer, paste on the other.'),
  master: { get: (s) => s.clipboard.enabled, set: (v) => UI.api.setClipboard({ enabled: v }) },
  badge: (s) => (!s.clipboard.enabled ? '' : s.link.state === 'connected' && !s.clipboard.peerAccepts ? 'warn' : 'on'),
  build(body) {
    const { el, api } = UI;
    const set = (partial) => api.setClipboard(partial);

    const peerRow = UI.row('', '', [], { literal: true });
    const skipNote = UI.note('info', '', { literal: true });
    const mode = UI.segmented([
      { value: 'instant', label: I18n.t('Instantly') }, // the default
      { value: 'switch', label: I18n.t('When you switch') },
    ], (v) => set({ mode: v }));
    const modeRow = UI.row(I18n.t('Sync'), '', [mode]);
    const concealed = UI.switch((v) => set({ skipConcealed: v }), { label: I18n.t('Skip passwords') });
    const maxKB = UI.select([
      { value: 16, label: '16 KB' }, { value: 64, label: '64 KB' }, { value: 256, label: '256 KB' },
    ], (v) => set({ maxKB: Number(v) }));
    // Pictures (clipimage.js): screenshots put on the clipboard among them. Not in Multi-device yet.
    const pictures = UI.switch((v) => set({ images: v }), { label: I18n.t('Pictures') });
    const picturesRow = UI.row(I18n.t('Pictures'), '', [pictures]);
    // Text only: pictures have their own limit (10 MB).
    const maxKBRow = UI.row(I18n.t('Largest text'), '', [maxKB]);
    const historySize = UI.select([
      { value: 0, label: I18n.t('Off') }, { value: 10, label: I18n.t('10 items') }, { value: 20, label: I18n.t('20 items') },
      { value: 50, label: I18n.t('50 items') }, { value: 100, label: I18n.t('100 items') },
    ], (v) => set({ historySize: Number(v) }));
    const pair = UI.dirCards(
      { on: { get: (s) => s.clipboard.receive, set: (v) => set({ receive: v }) }, label: I18n.t('Copy on {name}, paste on {me}'), rows: [] },
      { on: { get: (s) => s.clipboard.send, set: (v) => set({ send: v }) }, label: I18n.t('Copy on {me}, paste on {name}'), rows: [peerRow] },
    );

    const list = el('div', { class: 'history' });
    const clearBtn = UI.button(I18n.t('Clear'), () => api.clearHistory(), 'small');

    const recentRow = UI.row(I18n.t('Recent items'), I18n.t('Never saved to disk'), [historySize]);
    const hist = UI.historyCard('clip');

    body.append(
      pair.el,
      UI.card('', [modeRow, picturesRow]),
      UI.card(I18n.t('Privacy'), [
        UI.row(I18n.t('Skip passwords'), I18n.t('From password managers'), [concealed]),
        maxKBRow,
        recentRow,
      ]),
      skipNote,
      UI.card(I18n.t('Recent'), [list], { actions: [clearBtn] }),
      hist.el,
    );

    let lastKey = '';
    return (s) => {
      const c = s.clipboard;
      hist.update(s);
      recentRow.setHint(s.history && s.history.save ? I18n.t('Kept encrypted, as History says') : I18n.t('Never saved to disk'));
      pair.update(s);
      mode.set(c.mode);
      modeRow.setHint(c.mode === 'instant' ? I18n.t('As soon as you copy') : I18n.t('When you move to the other computer'));
      picturesRow.hidden = !c.imageSupport;
      pictures.set(!!c.images);
      picturesRow.setHint(!c.images ? I18n.t('Pictures and screenshots you copy, up to 10 MB, both ways')
        : s.link.state === 'connected' && !c.peerImages ? I18n.t('Turn on Pictures on {device} too (TwinDesk 2.3 or later there)', { device: UI.peer(s).name })
          : I18n.t('Pictures and screenshots you copy, up to 10 MB, both ways. Not over Bluetooth'));
      concealed.set(c.skipConcealed);
      maxKB.set(c.maxKB);
      maxKBRow.setHint(c.imageSupport ? I18n.t('Longer text isn’t sent. Pictures: up to 10 MB') : I18n.t('Longer text isn’t sent'));
      historySize.set(c.historySize);
      const refused = s.link.state === 'connected' && !c.peerAccepts;
      peerRow.hidden = !refused;
      peerRow.label.textContent = I18n.t('Turned off on {device}', { device: UI.peer(s).name });
      peerRow.setHint('');
      skipNote.set(c.enabled && c.lastSkip ? I18n.t('Last item not sent: {reason}.', { reason: I18n.t(c.lastSkip, UI.peer(s)) }) : '');
      clearBtn.disabled = !c.history.length;

      const key = JSON.stringify(c.history.map((h) => [h.at, h.dir, !!(h.image && h.image.copy)])) + c.historySize + Math.floor(Date.now() / 15000);
      if (key === lastKey) return;
      lastKey = key;
      list.replaceChildren(...(c.history.length
        ? c.history.map((h, i) => el('div', { class: 'hist-item' }, [
          el('span', { class: 'hist-dir ' + h.dir, title: h.dir === 'out' ? I18n.t('Sent to {name}') : I18n.t('From {name}') }, [UI.icon(h.dir === 'out' ? 'up' : 'down')]),
          h.image && h.image.thumb ? el('img', { class: 'hist-thumb', src: h.image.thumb, alt: '' }) : null,
          el('div', { class: 'hist-text' }, [
            h.image
              ? el('div', { class: 'hist-preview', text: I18n.t('{kind} · {width} × {height}', { kind: h.image.shot ? I18n.t('Screenshot') : I18n.t('Picture'), width: h.image.w, height: h.image.h }) })
              : el('div', { class: 'hist-preview selectable', attrs: { 'data-literal': '' }, text: h.text.replace(/\s+/g, ' ').trim() || I18n.t('(whitespace)') }),
            el('div', { class: 'hint', text: (h.dir === 'out' ? I18n.t('To {name}') : I18n.t('From {name}')) + ' · ' + UI.ago(h.at) + ' · ' + UI.bytes(h.size) }),
          ]),
          !h.image || h.image.copy ? UI.button(I18n.t('Copy'), () => api.copyHistory(i), 'small') : null,
        ]))
        : [UI.row(c.historySize ? I18n.t('Nothing yet') : I18n.t('Recent items are off'), '')]));
    };
  },
});

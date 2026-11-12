// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard tab: directions, when to sync, privacy and limits, Recent list.
'use strict';

UI.tab({
  id: 'clipboard',
  group: 'Share',
  order: 40,
  title: I18n.t('Clipboard'),
  desc: I18n.t('Copy on one computer, paste on the other.'),
  color: 'linear-gradient(#64d2ff, #30b0c7)',
  master: { get: (s) => s.clipboard && s.clipboard.enabled, set: (v) => UI.api.setClipboard({ enabled: v }) },
  badge: (s) => (s.clipboard && s.clipboard.enabled ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const set = (partial) => api.setClipboard(partial);

    const peerNote = UI.note('warn', '', { literal: true });
    const skipNote = UI.note('info', '', { literal: true });
    const send = UI.switch((v) => set({ send: v }), { label: I18n.t('Send') });
    const receive = UI.switch((v) => set({ receive: v }), { label: I18n.t('Receive') });
    const mode = UI.segmented([
      { value: 'switch', label: I18n.t('When you switch') },
      { value: 'instant', label: I18n.t('Instantly') },
    ], (v) => set({ mode: v }));
    const modeRow = UI.row(I18n.t('Sync'), '', [mode]);
    const concealed = UI.switch((v) => set({ skipConcealed: v }), { label: I18n.t('Skip passwords') });
    const maxKB = UI.select([
      { value: 16, label: '16 KB' }, { value: 64, label: '64 KB' }, { value: 256, label: '256 KB' },
    ], (v) => set({ maxKB: Number(v) }));
    // Pictures (clipimage.js): screenshots put on the clipboard among them. Not in Multi-device yet.
    const pictures = UI.switch((v) => set({ images: v }), { label: I18n.t('Pictures') });
    const picturesRow = UI.row(I18n.t('Pictures'), '', [pictures], { literalHint: true });
    // Text only: pictures have their own limit (10 MB).
    const maxKBRow = UI.row(I18n.t('Largest text'), '', [maxKB]);
    const historySize = UI.select([
      { value: 0, label: I18n.t('Off') }, { value: 10, label: I18n.t('10 items') }, { value: 20, label: I18n.t('20 items') },
      { value: 50, label: I18n.t('50 items') }, { value: 100, label: I18n.t('100 items') },
    ], (v) => set({ historySize: Number(v) }));

    const peerRow = (label, hint, controls) => {
      const r = UI.row(label, hint, controls);
      r.label.dataset.peer = label;
      return r;
    };
    const list = el('div', { class: 'history' });
    const clearBtn = UI.button(I18n.t('Clear'), () => api.clearHistory(), 'small');

    const recentRow = UI.row(I18n.t('Recent items'), I18n.t('Never saved to disk'), [historySize]);
    const hist = UI.historyCard('clip');

    body.append(
      peerNote,
      UI.pair(
        UI.dir('m2w', [peerRow(I18n.t('Copy on {me}, paste on {name}'), '', [send])]),
        UI.dir('w2m', [peerRow(I18n.t('Copy on {name}, paste on {me}'), '', [receive])]),
      ),
      UI.card(I18n.t('Options'), [
        modeRow,
        picturesRow,
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
      if (!c) return;
      send.set(c.send);
      receive.set(c.receive);
      mode.set(c.mode);
      modeRow.setHint(c.mode === 'instant' ? I18n.t('As soon as you copy') : I18n.t('When you move to the other computer'));
      picturesRow.hidden = !c.imageSupport;
      pictures.set(!!c.images);
      // ⇧⌘4 saves a screenshot to a file; with ⌃ it goes on the clipboard, and over.
      picturesRow.setHint(!c.images ? I18n.t('Pictures you copy and screenshots taken with ⌃⇧⌘4, up to 10 MB, both ways')
        : s.client && !c.peerImages ? I18n.t('Turn on Pictures on {device} too (TwinDesk 2.3 or later there)', { device: s.client.name })
          : I18n.t('Pictures you copy and screenshots taken with ⌃⇧⌘4, up to 10 MB, both ways. Not over Bluetooth'));
      concealed.set(c.skipConcealed);
      maxKB.set(c.maxKB);
      maxKBRow.setHint(c.imageSupport ? I18n.t('Longer text isn’t sent. Pictures: up to 10 MB') : I18n.t('Longer text isn’t sent'));
      historySize.set(c.historySize);
      peerNote.set(s.client && !c.peerAccepts ? I18n.t('Turned off on {device}.', { device: s.client.name }) : '');
      const sizeSkip = /^skipped (\d+) KB \(over (\d+) KB\)$/.exec(c.lastSkip || '');
      const fileSkip = /^files aren’t sent by ⌘C: copy them with (.+), paste with (.+)$/.exec(c.lastSkip || '');
      const reason = sizeSkip ? I18n.t('skipped {size} KB (over {limit} KB)', { size: sizeSkip[1], limit: sizeSkip[2] })
        : fileSkip ? I18n.t('files aren’t sent by ⌘C: copy them with {copy}, paste with {paste}', { copy: fileSkip[1], paste: fileSkip[2] })
          : s.client && c.lastSkip === `${s.client.name} doesn’t take the clipboard` ? I18n.t('{device} doesn’t take the clipboard', { device: s.client.name }) : I18n.t(c.lastSkip || '');
      skipNote.set(c.enabled && c.lastSkip ? I18n.t('Last copy not sent: {reason}.', { reason }) : '');
      clearBtn.disabled = !c.history.length;

      // Rebuild the list only when it changed (or every 15 s for the relative times).
      const key = JSON.stringify(c.history.map((h) => [h.at, h.dir, !!(h.image && h.image.copy)])) + Math.floor(Date.now() / 15000);
      if (key === lastKey) return;
      lastKey = key;
      list.replaceChildren(...(c.history.length
        ? c.history.map((h, i) => el('div', { class: 'hist-item' }, [
          el('span', { class: `hist-dir ${h.dir}`, title: UI.fill(h.dir === 'out' ? I18n.t('Sent to {name}') : I18n.t('From {name}')) }, [UI.icon(h.dir === 'out' ? 'up' : 'down')]),
          h.image && h.image.thumb ? el('img', { class: 'hist-thumb', src: h.image.thumb, alt: '' }) : null,
          el('div', { class: 'hist-text' }, [
            h.image
              ? el('div', { class: 'hist-preview', text: `${I18n.t(h.image.shot ? 'Screenshot' : 'Picture')} · ${h.image.w} × ${h.image.h}` })
              : el('div', { class: 'hist-preview selectable', attrs: { 'data-literal': '' }, text: h.text.replace(/\s+/g, ' ').trim() || I18n.t('(whitespace)') }),
            el('div', { class: 'hint', text: `${UI.fill(h.dir === 'out' ? I18n.t('To {name}') : I18n.t('From {name}'))} · ${UI.ago(h.at)} · ${UI.bytes(h.size)}` }),
          ]),
          !h.image || h.image.copy ? UI.button(I18n.t('Copy'), () => api.copyHistory(i), 'small') : null,
        ]))
        : [UI.row(c.historySize ? I18n.t('Nothing yet') : I18n.t('Recent items are off'), '')]));
    };
  },
});

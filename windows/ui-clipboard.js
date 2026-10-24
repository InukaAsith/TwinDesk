// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard tab: accept (Mac → PC) and send (PC → Mac) as two direction cards, then
// timing, privacy and the Recent list for both.
'use strict';

UI.tab({
  id: 'clipboard',
  order: 40,
  title: 'Clipboard',
  color: 'linear-gradient(#64d2ff, #30b0c7)',
  desc: 'Copy on one computer, paste on the other.',
  master: { get: (s) => s.clipboard.enabled, set: (v) => UI.api.setClipboard({ enabled: v }) },
  badge: (s) => (!s.clipboard.enabled ? '' : s.link.state === 'connected' && !s.clipboard.peerAccepts ? 'warn' : 'on'),
  build(body) {
    const { el, api } = UI;
    const set = (partial) => api.setClipboard(partial);

    const peerRow = UI.row('', '');
    const skipNote = UI.note('info', '');
    const mode = UI.segmented([
      { value: 'instant', label: 'Instantly' }, // the default
      { value: 'switch', label: 'When you switch' },
    ], (v) => set({ mode: v }));
    const modeRow = UI.row('Sync', '', [mode]);
    const concealed = UI.switch((v) => set({ skipConcealed: v }), { label: 'Skip passwords' });
    const maxKB = UI.select([
      { value: 16, label: '16 KB' }, { value: 64, label: '64 KB' }, { value: 256, label: '256 KB' },
    ], (v) => set({ maxKB: Number(v) }));
    const historySize = UI.select([
      { value: 0, label: 'Off' }, { value: 10, label: '10 items' }, { value: 20, label: '20 items' },
      { value: 50, label: '50 items' }, { value: 100, label: '100 items' },
    ], (v) => set({ historySize: Number(v) }));
    // A phone as the peer: screenshots both ways, onto the other clipboard (phone-shots.js).
    const saveShots = UI.switch((v) => set({ saveScreenshots: v }), { label: 'Also save its screenshots' });
    const saveShotsRow = UI.row('Also save {name}’s screenshots', 'Each screenshot taken on {name} lands on this clipboard; this also saves it in Pictures › TwinDesk', [saveShots]);
    const sendShots = UI.switch((v) => set({ screenshots: v }), { label: 'Screenshots go to the phone' });
    const sendShotsRow = UI.row('Screenshots go to {name}', 'Win+Shift+S, PrtScn and the Snipping Tool save in Pictures › Screenshots: each new one lands on {name}’s clipboard. Not over Bluetooth', [sendShots]);
    const pair = UI.dirCards(
      { on: { get: (s) => s.clipboard.receive, set: (v) => set({ receive: v }) }, label: 'Copy on {name}, paste on {me}', rows: [saveShotsRow] },
      { on: { get: (s) => s.clipboard.send, set: (v) => set({ send: v }) }, label: 'Copy on {me}, paste on {name}', rows: [peerRow, sendShotsRow] },
    );

    const list = el('div', { class: 'history' });
    const clearBtn = UI.button('Clear', () => api.clearHistory(), 'small');

    body.append(
      pair.el,
      UI.card('', [modeRow]),
      UI.card('Privacy', [
        UI.row('Skip passwords', 'From password managers', [concealed]),
        UI.row('Largest item', '', [maxKB]),
        UI.row('Recent items', 'Never saved to disk', [historySize]),
      ]),
      skipNote,
      UI.card('Recent', [list], { actions: [clearBtn] }),
    );

    let lastKey = '';
    return (s) => {
      const c = s.clipboard;
      pair.update(s);
      const phone = !!(c.phoneShots && s.phone && s.phone.connected);
      saveShotsRow.hidden = sendShotsRow.hidden = !phone;
      saveShots.set(!!c.saveScreenshots);
      sendShots.set(c.screenshots !== false);
      mode.set(c.mode);
      modeRow.setHint(c.mode === 'instant' ? 'As soon as you copy' : 'When you move to the other computer');
      concealed.set(c.skipConcealed);
      maxKB.set(c.maxKB);
      historySize.set(c.historySize);
      const refused = s.link.state === 'connected' && !c.peerAccepts;
      peerRow.hidden = !refused;
      peerRow.label.textContent = 'Turned off on ' + UI.peer(s).name;
      peerRow.setHint('');
      skipNote.set(c.enabled && c.lastSkip ? 'Last item not sent: ' + c.lastSkip + '.' : '');
      clearBtn.disabled = !c.history.length;

      const key = JSON.stringify(c.history.map((h) => [h.at, h.dir])) + c.historySize + Math.floor(Date.now() / 15000);
      if (key === lastKey) return;
      lastKey = key;
      list.replaceChildren(...(c.history.length
        ? c.history.map((h, i) => el('div', { class: 'hist-item' }, [
          el('span', { class: 'hist-dir ' + h.dir, title: h.dir === 'out' ? 'Sent to {name}' : 'From {name}' }, [UI.icon(h.dir === 'out' ? 'up' : 'down')]),
          el('div', { class: 'hist-text' }, [
            el('div', { class: 'hist-preview selectable', text: h.text.replace(/\s+/g, ' ').trim() || '(whitespace)' }),
            el('div', { class: 'hint', text: (h.dir === 'out' ? 'To {name}' : 'From {name}') + ' · ' + UI.ago(h.at) + ' · ' + UI.bytes(h.size) }),
          ]),
          UI.button('Copy', () => api.copyHistory(i), 'small'),
        ]))
        : [UI.row(c.historySize ? 'Nothing yet' : 'Recent items are off', '')]));
    };
  },
});

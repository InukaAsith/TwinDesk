// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Connection › Pair a phone with a QR code (Mac, PC and Linux): an extra way next to Found nearby
// and the code, which stay as they are. Show QR Code draws this computer's pairing link
// (twindesk://pair, main's qrPair: its addresses, port and a nonce that asks only for Allow here),
// scanned with the phone's camera or TwinDesk's Scan QR code (QrActivity.kt). Only where the app
// has it (api.qrPair) and Qr (shared/qr.js) is loaded. UI.qrPairCard() → {el, update(state)}
'use strict';

UI.qrPairCard = () => {
  const { el, api } = UI;
  const t = (text, vars) => window.I18n ? window.I18n.t(text, vars) : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
  if (!api.qrPair || !window.Qr) return null;
  let open = false;
  let url = '';
  let until = 0;
  const showBtn = UI.button(t('Show QR Code'), () => { open = !open; refresh(); }, 'small');
  const row = UI.row(t('Pair a phone with a QR code'), t('Scan it with the phone’s camera, or with Scan QR code in TwinDesk on the phone'), [showBtn]);
  const img = el('div', { class: 'qr-img', attrs: { role: 'img', 'aria-label': t('Pairing QR code') } });
  const note = el('div', { class: 'hint', attrs: { 'data-literal': '' } });
  const box = el('div', { class: 'qr-box' }, [img, el('div', { class: 'qr-text' }, [
    el('strong', { text: t('Scan with your phone') }),
    el('ol', {}, [t('Open the camera, or TwinDesk › Scan QR code.'), t('Point it at this code and open the link.'), t('Click Allow here when it asks.')].map((t) => el('li', { text: t }))),
    note,
  ])]);
  box.hidden = true;
  const card = UI.card('', [row, box]);

  async function refresh() {
    showBtn.textContent = open ? t('Hide') : t('Show QR Code');
    box.hidden = !open;
    if (!open) return;
    const v = await api.qrPair();
    if (!v || !v.url) {
      img.replaceChildren();
      note.textContent = t((v && v.why) || 'Not ready yet');
      return;
    }
    if (v.url !== url) {
      url = v.url;
      const c = window.Qr.canvas(url, 4);
      c.className = 'qr-canvas';
      img.replaceChildren(c);
    }
    until = v.until || 0;
    note.textContent = t('A new code comes every 10 minutes. Only someone who sees this screen can use it.');
  }
  // A code that ran out is drawn again while it's shown.
  setInterval(() => { if (open && until && Date.now() > until) refresh(); }, 15000);

  return {
    el: card,
    update(s) {
      // Hidden while a phone is connected (nothing to pair); Nearby's own rows stay either way.
      card.hidden = !!(s.phone && s.phone.connected);
      if (card.hidden && open) { open = false; refresh(); }
    },
  };
};

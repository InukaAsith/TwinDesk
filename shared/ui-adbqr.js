// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Connection › Wireless debugging › Pair with a QR code (Mac, PC and Linux): next to the 6-digit
// code, which stays. Show QR Code starts it here (api.adbQr, shared/adbqr.js) and draws the code for
// the phone's Developer options › Wireless debugging › Pair device with QR code.
// Only where the app has it. UI.adbQr() → {el, update(state, pairable)}; used by shared/ui-adb.js.
'use strict';

UI.adbQr = () => {
  const { el, api } = UI;
  const t = (text, vars) => window.I18n ? window.I18n.t(text, vars) : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
  if (!api.adbQr || !window.Qr) return null;
  let open = false;
  let drawn = '';
  const btn = UI.button(t('Show QR Code'), () => { open = !open; api.adbQr(open); paint(UI.state); }, 'small');
  const row = UI.row(t('Pair with a QR code'), t('On the phone: Wireless debugging › Pair device with QR code'), [btn], { literal: true });
  const img = el('div', { class: 'qr-img', attrs: { role: 'img', 'aria-label': t('Wireless debugging QR code') } });
  const note = el('div', { class: 'hint', attrs: { 'data-literal': '' } });
  const box = el('div', { class: 'qr-box' }, [img, el('div', { class: 'qr-text' }, [
    el('strong', { text: t('Scan with the phone') }),
    el('ol', {}, [t('Settings › Developer options › Wireless debugging.'), t('Tap Pair device with QR code.'), t('Scan this code. TwinDesk connects by itself.')].map((t) => el('li', { text: t }))),
    note,
  ])]);
  box.hidden = true;
  const wrap = el('div', {}, [row, box]);

  function paint(s) {
    const q = s && s.adbQr;
    btn.textContent = open ? t('Hide') : t('Show QR Code');
    box.hidden = !open;
    if (!open) return;
    if (q && q.text && q.text !== drawn) {
      drawn = q.text;
      img.replaceChildren(window.Qr.canvas(q.text, 4));
    }
    if (q && q.done) {
      open = false;
      drawn = '';
      box.hidden = true;
      btn.textContent = t('Show QR Code');
      row.setHint(q.done === 'paired' ? t('Paired. Connecting…') : q.done === 'timeout' ? t('The QR code timed out. Show it again to retry.') : q.done.startsWith('failed: ') ? t('Didn’t pair: {error}', { error: t(q.done.slice(8)) }) : t(q.done));
      return;
    }
    note.textContent = q && q.text ? t('Waiting for the phone…') : t('Wireless debugging isn’t available here.');
  }

  return {
    el: wrap,
    update(s, pairable) {
      wrap.hidden = !pairable;
      if (!pairable && open) { open = false; api.adbQr(false); }
      paint(s);
    },
  };
};

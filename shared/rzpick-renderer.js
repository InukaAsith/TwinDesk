// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume's chooser (rzpick.js): "How would you like to open …?" with one large button per way,
// side by side. Keys: 1, 2, 3 pick; arrows move; Enter picks; Escape cancels.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const i18n = window.PlayerI18n;
  const SVG = 'http://www.w3.org/2000/svg';
  // 64×64 line drawings: a page with an eye (Preview), a page with a pencil (Edit), a window (Window).
  const ART = {
    copy: ['M14 6h24l12 12v40H14z', 'M38 6v12h12', 'M20 40c3.5-5 7.5-7.5 12-7.5S40.5 35 44 40c-3.5 5-7.5 7.5-12 7.5S23.5 45 20 40z', 'M32 37a3 3 0 1 1 0 6 3 3 0 0 1 0-6z'],
    live: ['M14 6h24l12 12v40H14z', 'M38 6v12h12', 'M22 30h14', 'M22 38h8', 'M40 52l-8 2 2-8 14-14 6 6z', 'M44 36l6 6'],
    window: ['M6 12h52v40H6z', 'M6 22h52', 'M12 17h2', 'M17 17h2', 'M22 17h2', 'M14 30h18v14H14z', 'M38 30h12', 'M38 37h12', 'M38 44h8'],
  };
  const LABEL = { copy: 'Preview', live: 'Edit', window: 'Window' };
  const HINT = { copy: 'Open a copy on this device', live: 'Edit the file on {peer}', window: 'Use the app from {peer}' };

  const art = (how) => {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 64 64');
    s.setAttribute('aria-hidden', 'true');
    for (const d of ART[how]) {
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('d', d);
      s.append(p);
    }
    return s;
  };

  window.rzpick.ask().then((q) => {
    if (!q) return window.rzpick.answer(null);
    i18n.text($('question'), 'How would you like to open this?');
    i18n.literal($('item'), q.appName && q.appName !== q.name ? q.name + ' · ' + q.appName : q.name);
    if (q.icon) { $('icon').src = q.icon; $('icon').hidden = false; }
    const buttons = q.ways.map((how, k) => {
      const b = document.createElement('button');
      b.className = 'rp-way';
      b.dataset.how = how;
      const name = document.createElement('span');
      name.className = 'rp-name';
      const hint = document.createElement('span');
      hint.className = 'rp-hint';
      const key = document.createElement('kbd');
      key.textContent = String(k + 1);
      i18n.text(name, LABEL[how]);
      i18n.text(hint, HINT[how], { peer: q.peer || i18n.t('the other device') });
      b.append(art(how), name, hint, key);
      b.addEventListener('click', () => window.rzpick.answer(how));
      $('ways').append(b);
      return b;
    });
    buttons[0].focus();
    document.addEventListener('keydown', (e) => {
      const at = buttons.indexOf(document.activeElement);
      if (e.key === 'Escape') window.rzpick.answer(null);
      else if (/^[1-3]$/.test(e.key) && buttons[Number(e.key) - 1]) window.rzpick.answer(q.ways[Number(e.key) - 1]);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        buttons[(Math.max(0, at) + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length].focus();
      }
    });
  });
  $('close').addEventListener('click', () => window.rzpick.answer(null));
})();

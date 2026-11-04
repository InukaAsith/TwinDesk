// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The control window's look, in the renderer of each app (after its UI kit):
//   UI.look(state.look): the accent colour into --accent (and --accent-soft, from it in the CSS).
//   UI.themeRow / UI.accentRow: General › Appearance's pickers.
//   UI.sections(cards): a long page in sections, a sticky list of the card titles beside it. A click
//     scrolls to that card, and the list follows where the page is as it scrolls (one page still).
'use strict';

(function () {
  const t = (s) => (window.I18n ? window.I18n.t(s) : s);
  let applied = '';

  UI.look = (look) => {
    const c = look && look.color;
    if (!c || c === applied) return;
    applied = c;
    document.documentElement.style.setProperty('--accent', c);
  };

  UI.themeRow = (onChange) => {
    const seg = UI.segmented([
      { value: 'system', label: t('System') }, { value: 'light', label: t('look.light') }, { value: 'dark', label: t('look.dark') },
    ], onChange);
    const row = UI.row(t('Theme'), t('System follows this computer’s light or dark setting'), [seg.el]);
    row.render = (v) => seg.set(v || 'system');
    return row;
  };

  // Swatches: "System" (the system's accent colour) first, then the fixed colours.
  UI.accentRow = (onChange) => {
    const box = UI.el('div', { class: 'swatches', attrs: { role: 'radiogroup', 'aria-label': t('Accent colour') } });
    const row = UI.row(t('Accent colour'), t('System uses this computer’s accent colour'), [box]);
    let built = '';
    const buttons = [];
    const make = (value, color, label) => {
      const b = UI.el('button', { class: 'swatch' + (value ? '' : ' sys'), attrs: { title: label, 'aria-label': label, role: 'radio' } });
      b.style.setProperty('--sw', color);
      b.onclick = () => onChange(value);
      b.value = value;
      buttons.push(b);
      box.append(b);
    };
    row.render = (look) => {
      if (!look) return;
      const key = look.os + (look.accents || []).join();
      if (key !== built) {
        built = key;
        box.textContent = '';
        buttons.length = 0;
        make('', look.os, t('System'));
        for (const c of look.accents || []) make(c, c, c);
      }
      for (const b of buttons) {
        const on = b.value === (look.accent || '');
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    };
    return row;
  };

  // Paired computers nearby, under the phones at the top of the sidebar (as the phone app shows
  // them): its kind, its name and the link. Click: connect it; the connected one opens Overview.
  // list: [{id, name, os, connected, sub, go()}]; open(): show Overview; active: the connected one is lit (blue) on every page.
  let pcKey = '';
  UI.renderPcs = (box, list, { open, active }) => {
    const key = JSON.stringify([list.map((d) => [d.id, d.name, d.os, d.connected, d.sub]), active]);
    if (!box || key === pcKey) return;
    pcKey = key;
    box.replaceChildren(...list.map((d) => {
      const b = UI.el('button', { class: 'phone-tile pc-tile' + (d.connected ? ' connected' : ''), title: d.connected ? d.name : t('Connect to {name}', { name: d.name }) }, [
        UI.el('span', { class: 'pc-wall' }, [UI.osIcon(d.os)]),
        UI.el('span', { class: 'phone-text' }, [UI.el('span', { class: 'phone-name', text: d.name, attrs: { 'data-literal': '' } }),
          UI.el('span', { class: 'phone-sub', text: d.sub, attrs: { 'data-literal': '' } })]),
        d.connected ? UI.el('span', { class: 'dot good' }) : null,
      ]);
      b.classList.toggle('active', !!(d.connected && active));
      b.onclick = () => (d.connected ? open() : d.go());
      return b;
    }));
  };

  UI.sections = (cards) => {
    const list = UI.el('div', { class: 'sec-nav', attrs: { role: 'navigation' } });
    const col = UI.el('div', { class: 'sec-body' }, cards);
    const wrap = UI.el('div', { class: 'sections' }, [list, col]);
    const box = () => document.getElementById('content');
    const links = cards.map((c) => {
      const title = c.querySelector('.card-title span');
      const b = UI.el('button', { class: 'sec-link', text: title ? title.textContent : '' });
      b.onclick = () => {
        const s = box();
        if (s) s.scrollTo({ top: s.scrollTop + c.getBoundingClientRect().top - s.getBoundingClientRect().top - 14, behavior: 'smooth' });
      };
      list.append(b);
      return b;
    });
    let queued = false;
    const spy = () => {
      queued = false;
      const s = box();
      if (!s || !wrap.offsetParent) return;
      const top = s.getBoundingClientRect().top + 80;
      let at = 0;
      cards.forEach((c, i) => { if (c.getBoundingClientRect().top <= top) at = i; });
      if (s.scrollTop + s.clientHeight >= s.scrollHeight - 2) at = cards.length - 1; // the bottom: the last one, however short
      links.forEach((b, i) => b.classList.toggle('active', i === at));
    };
    const later = () => { if (!queued) { queued = true; requestAnimationFrame(spy); } };
    requestAnimationFrame(() => {
      const s = box();
      if (s) s.addEventListener('scroll', later, { passive: true });
      window.addEventListener('resize', later);
      spy();
    });
    wrap.spy = later;
    return wrap;
  };
})();

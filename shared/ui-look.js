// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The control window's look, in the renderer of each app (after its UI kit):
//   UI.look(state.look): the accent colour into --accent (and --accent-soft, from it in the CSS), and
//     Glass or Simple as html.glass (shared/ui-glass.css; shared/look-early.js set it before the first paint).
//   UI.styleRow / UI.themeRow / UI.accentRow: General › Appearance's pickers.
//   UI.sections(cards): a long page in sections, a sticky list of the card titles beside it. A click
//     scrolls to that card, and the list follows where the page is as it scrolls (one page still).
'use strict';

(function () {
  const t = (s) => (window.I18n ? window.I18n.t(s) : s);
  let applied = '';

  UI.look = (look) => {
    if (look && look.style) document.documentElement.classList.toggle('glass', look.style !== 'simple');
    const c = look && look.color;
    if (!c || c === applied) return;
    applied = c;
    document.documentElement.style.setProperty('--accent', c);
  };

  // Glass (the default: the iPad app's look) or Simple (flat, as before).
  UI.styleRow = (onChange) => {
    const seg = UI.segmented([{ value: 'glass', label: t('look.glass') }, { value: 'simple', label: t('look.simple') }], onChange);
    const row = UI.row(t('Style'), t('Glass: soft colours from the accent behind translucent cards'), [seg.el]);
    row.render = (v) => seg.set(v === 'simple' ? 'simple' : 'glass');
    return row;
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

  // A block that isn't a card (File Sharing's two direction cards) as a titled section for UI.sections.
  UI.titled = (title, block) => UI.el('div', { class: 'card-wrap' }, [UI.el('div', { class: 'card-title' }, [UI.el('span', { text: title })]), block]);

  // A page split into tabs listed beside it (File Sharing): only the chosen tab's cards show.
  // groups: [{id, title, cards: [card | null]}]. A tab whose cards are all hidden has no link.
  // The chosen tab is remembered on this computer (localStorage, page id + tab id).
  UI.subtabs = (page, groups) => {
    const key = `td.subtab.${page}`;
    let at = '';
    try { at = localStorage.getItem(key) || ''; } catch (_) { /* no storage: the first tab */ }
    const list = UI.el('div', { class: 'sec-nav sub-nav', attrs: { role: 'tablist' } });
    const col = UI.el('div', { class: 'sec-body' });
    const wrap = UI.el('div', { class: 'sections subtabs' }, [list, col]);
    const tabs = groups.map((g) => {
      const cards = g.cards.filter(Boolean);
      const box = UI.el('div', { attrs: { role: 'tabpanel' } }, cards);
      const b = UI.el('button', { class: 'sec-link', text: g.title, attrs: { role: 'tab' } });
      b.onclick = () => show(g.id);
      list.append(b);
      col.append(box);
      return { id: g.id, b, box, cards };
    });
    const visible = (tb) => tb.cards.some((c) => !c.hidden);
    function show(id) {
      const pick = tabs.find((tb) => tb.id === id && visible(tb)) || tabs.find(visible) || tabs[0];
      at = pick.id;
      try { localStorage.setItem(key, at); } catch (_) { /* not kept */ }
      for (const tb of tabs) {
        tb.b.hidden = !visible(tb);
        tb.b.classList.toggle('active', tb === pick);
        tb.b.setAttribute('aria-selected', String(tb === pick));
        tb.box.hidden = tb !== pick;
      }
    }
    for (const tb of tabs) for (const c of tb.cards) new MutationObserver(() => show(at)).observe(c, { attributes: true, attributeFilter: ['hidden'] });
    show(at);
    wrap.show = show;
    wrap.spy = () => {};
    return wrap;
  };

  UI.sections = (cards) => {
    // A card a page has only sometimes comes as null (General's relay card where ui-relay.js isn't
    // loaded: the Mac's Multi-device window, whose General then didn't build at all).
    cards = cards.filter(Boolean);
    const list = UI.el('div', { class: 'sec-nav', attrs: { role: 'navigation' } });
    const col = UI.el('div', { class: 'sec-body' }, cards);
    const wrap = UI.el('div', { class: 'sections' }, [list, col]);
    const box = () => document.getElementById('content');
    // Where the cards show from: under the page's title, which stays at the top while they scroll.
    const under = (s) => {
      const head = wrap.closest('.page') && wrap.closest('.page').querySelector('.page-head');
      const top = s.getBoundingClientRect().top;
      return head && getComputedStyle(head).position === 'sticky' ? Math.max(top, head.getBoundingClientRect().bottom) : top;
    };
    const links = cards.map((c) => {
      const title = c.querySelector('.card-title span');
      const b = UI.el('button', { class: 'sec-link', text: title ? title.textContent : '' });
      b.onclick = () => {
        const s = box();
        if (s) s.scrollTo({ top: s.scrollTop + c.getBoundingClientRect().top - under(s) - 14, behavior: 'smooth' });
      };
      list.append(b);
      // A card that's hidden (General's Portable in an installed app) has no link either, and gets it when shown.
      b.hidden = c.hidden;
      new MutationObserver(() => { b.hidden = c.hidden; later(); }).observe(c, { attributes: true, attributeFilter: ['hidden'] });
      return b;
    });
    let queued = false;
    const spy = () => {
      queued = false;
      const s = box();
      if (!s || !wrap.offsetParent) return;
      const top = under(s) + 40;
      let at = 0;
      cards.forEach((c, i) => { if (!c.hidden && c.getBoundingClientRect().top <= top) at = i; });
      if (s.scrollTop + s.clientHeight >= s.scrollHeight - 2) at = cards.map((c) => !c.hidden).lastIndexOf(true); // the bottom: the last one shown, however short
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

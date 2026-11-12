// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Search (Mac, Windows, Linux): ⌘K (Ctrl+K), or the magnifier at the window's top right. Finds the
// settings, shortcuts and features by what they do (shared/search-index.js) and the pages by
// name; Enter or a click opens that page. ↑ ↓ move, Esc closes.
'use strict';

(function () {
  const S = window.TDSearch;
  const t = (s, v) => I18n.t(s, v);
  if (!S) return;

  // The pages in the sidebar now (their names as shown), and the entries for this app.
  function entries() {
    const ids = new Set(UI.tabs.map((d) => d.id).concat(UI.tabs.map((d) => UI.baseOf(d))));
    const app = ids.has('pc-mac') ? 'windows' : 'mac';
    const names = {};
    const web = new Set(UI.tabs.filter((d) => d.web).map((d) => UI.baseOf(d))); // a web device's own pages
    for (const b of document.querySelectorAll('#nav .nav-item[data-base]')) {
      const l = b.querySelector('.label');
      if (l && !names[b.dataset.base] && !web.has(b.dataset.base)) names[b.dataset.base] = l.textContent;
    }
    const pages = Object.entries(names).map(([id, name]) => ({ t: name, k: id, id, isPage: true }));
    const feats = S.forApp(app).filter((e) => ids.has(e.id)).map((e) => ({ ...e, pageTitle: names[e.id] || '' }));
    return pages.concat(feats);
  }

  let open = null;
  function show() {
    if (open) { open.input.focus(); open.input.select(); return; }
    const { el } = UI;
    const all = entries();
    const input = el('input', { class: 'search-input', attrs: { type: 'search', placeholder: t('Search settings and features'), 'aria-label': t('Search'), spellcheck: 'false', autocomplete: 'off' } });
    const list = el('ul', { class: 'search-list', attrs: { role: 'listbox' } });
    const empty = el('p', { class: 'hint search-empty', text: t('Try “share pc audio to phone”, “dark mode” or “send a file”') });
    let found = [];
    let at = 0;
    const pick = (e) => { close(); UI.go(e.id); };
    const mark = () => [...list.children].forEach((li, i) => { li.classList.toggle('on', i === at); if (i === at) li.scrollIntoView({ block: 'nearest' }); });
    const draw = () => {
      const q = input.value.trim();
      found = q ? S.match(q, all, (e) => t(e.t)).slice(0, 12) : [];
      at = 0;
      list.replaceChildren(...found.map((e, i) => {
        const li = el('li', { class: 'search-item', attrs: { role: 'option' } }, [
          el('span', { class: 'search-title', text: e.isPage ? e.t : t(e.t), attrs: { 'data-literal': '' } }),
          el('span', { class: 'search-where', text: e.isPage ? t('Page') : e.pageTitle, attrs: { 'data-literal': '' } }),
        ]);
        li.onmousemove = () => { if (at !== i) { at = i; mark(); } };
        li.onclick = () => pick(e);
        return li;
      }));
      empty.hidden = !!found.length;
      empty.textContent = q ? t('Nothing found') : t('Try “share pc audio to phone”, “dark mode” or “send a file”');
      mark();
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (found.length) { at = (at + 1) % found.length; mark(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (found.length) { at = (at - 1 + found.length) % found.length; mark(); } }
      else if (e.key === 'Enter') { e.preventDefault(); if (found[at]) pick(found[at]); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    const pop = el('div', { class: 'search-pop', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Search') } }, [
      el('div', { class: 'search-bar' }, [UI.icon('search'), input]),
      list, empty,
    ]);
    const overlay = el('div', { class: 'arrange-overlay search-overlay' }, [pop]);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.body.append(overlay);
    open = { overlay, input };
    input.focus();
    draw();
  }
  function close() {
    if (!open) return;
    open.overlay.remove();
    open = null;
  }
  UI.search = show;

  // ⌘K / Ctrl+K anywhere in the window.
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (open) close(); else show();
    }
  }, true);

  // A glass pill in each page's header, level with its title: the magnifier and ⌘K (Ctrl K).
  const mac = /^Mac/.test(navigator.platform);
  function pill() {
    const b = UI.el('button', { class: 'search-pill', attrs: { 'aria-label': t('Search'), title: t('Search') } }, [
      UI.icon('search'),
      UI.el('span', { class: 'search-keys', attrs: { 'data-literal': '' } }, mac ? [UI.el('kbd', { text: '⌘' }), UI.el('kbd', { text: 'K' })] : [UI.el('kbd', { text: 'Ctrl' }), UI.el('kbd', { text: 'K' })]),
    ]);
    b.onclick = show;
    return b;
  }
  function place(head) {
    if (head.querySelector('.search-pill')) return;
    const titles = head.querySelector('.titles');
    if (titles) titles.after(pill()); else head.append(pill());
  }
  // A device's Overview hides its header (ui-device.css), its card first: the pill on a row of its
  // own at the top of the page.
  function above(hero) {
    const body = hero.closest('.device-page') && hero.parentElement;
    if (!body || body.querySelector(':scope > .search-row')) return;
    body.prepend(UI.el('div', { class: 'search-row' }, [pill()]));
  }
  function all(root) {
    root.querySelectorAll('.page-head').forEach(place);
    root.querySelectorAll('.dv-hero').forEach(above);
  }
  function start() {
    all(document);
    const pages = document.getElementById('pages');
    if (pages) new MutationObserver(() => all(pages)).observe(pages, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

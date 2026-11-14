// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Arrange: the sidebar's pages in the order the person likes (Mac, Windows, Linux). Opened from
// General › Look › Sidebar order, by holding the sidebar, or with a right click on it. General,
// About and Multi-device stay at the bottom. The order is this window's own (localStorage), a
// list of page ids; a page that's new since keeps its place after the one it follows by default.
//
// The shells (mac/ui-start.js, windows/app.js, linux/app.js) sort with UI.arrangeSort, mark each
// sidebar button with data-base, and call UI.arrangeHold(nav).
'use strict';

(function () {
  const KEY = 'twindesk.navOrder';
  const t = (s, v) => I18n.t(s, v);
  const read = () => {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || 'null');
      return Array.isArray(v) && v.length ? v.filter((x) => typeof x === 'string') : null;
    } catch (_) { return null; }
  };
  const write = (v) => {
    try { if (v && v.length) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch (_) { /* this time only */ }
  };

  UI.navCustom = () => !!read();

  // defs in their default order → in the saved one (bottom pages unmoved, at the end).
  UI.arrangeSort = (defs) => {
    const saved = read();
    if (!saved) return defs;
    const rank = new Map(saved.map((id, i) => [id, i]));
    const keyed = [];
    let last = -1;
    for (const d of defs) {
      if (d.bottom) continue;
      const b = UI.baseOf(d);
      const k = rank.has(b) ? rank.get(b) : last + 0.001;
      last = k;
      keyed.push([k, d]);
    }
    keyed.sort((a, b) => a[0] - b[0]);
    return [...keyed.map((x) => x[1]), ...defs.filter((d) => d.bottom)];
  };

  // The sidebar as it is now: one item per page (a page's versions once, the shown one's name).
  function current() {
    const nav = document.getElementById('nav');
    const items = new Map();
    if (!nav) return [];
    const web = new Set(UI.tabs.filter((d) => d.web).map((d) => UI.baseOf(d))); // a web device's own pages: not in the sidebar's list
    for (const b of nav.querySelectorAll('.nav-item[data-base]')) {
      if (b.dataset.bottom || web.has(b.dataset.base)) continue;
      const li = b.closest('li');
      const shown = !(li && li.hidden);
      const had = items.get(b.dataset.base);
      if (had && (had.shown || !shown)) continue;
      const label = b.querySelector('.label');
      const tile = b.querySelector('.tile');
      items.set(b.dataset.base, { id: b.dataset.base, shown, label: label ? label.textContent : b.dataset.base, tile: tile ? tile.cloneNode(true) : null });
    }
    return [...items.values()];
  }

  let open = null;
  UI.arrangeOpen = () => {
    if (open) return;
    const { el } = UI;
    const list = el('ul', { class: 'arrange-list', attrs: { role: 'listbox', 'aria-label': t('Sidebar order') } });
    const move = (li, by) => {
      const to = by < 0 ? li.previousElementSibling : li.nextElementSibling;
      if (!to) return;
      if (by < 0) list.insertBefore(li, to); else list.insertBefore(to, li);
      li.querySelector(by < 0 ? '.arrange-up' : '.arrange-down').focus();
    };
    let dragging = null;
    for (const it of current()) {
      const up = el('button', { class: 'arrange-btn arrange-up', text: '↑', attrs: { 'aria-label': t('Move up'), title: t('Move up') } });
      const down = el('button', { class: 'arrange-btn arrange-down', text: '↓', attrs: { 'aria-label': t('Move down'), title: t('Move down') } });
      const li = el('li', { class: 'arrange-item' + (it.shown ? '' : ' muted'), attrs: { draggable: 'true', 'data-id': it.id } }, [
        el('span', { class: 'arrange-grip', text: '⋮⋮', attrs: { 'aria-hidden': 'true' } }),
        it.tile,
        el('span', { class: 'arrange-label', text: it.label, attrs: { 'data-literal': '' } }),
        up, down,
      ]);
      up.onclick = () => move(li, -1);
      down.onclick = () => move(li, 1);
      li.addEventListener('dragstart', (e) => { dragging = li; li.classList.add('dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', it.id); } catch (_) { /* fine */ } });
      li.addEventListener('dragend', () => { li.classList.remove('dragging'); dragging = null; });
      list.append(li);
    }
    list.addEventListener('dragover', (e) => {
      if (!dragging) return;
      e.preventDefault();
      const over = e.target.closest && e.target.closest('.arrange-item');
      if (!over || over === dragging) return;
      const r = over.getBoundingClientRect();
      list.insertBefore(dragging, e.clientY > r.top + r.height / 2 ? over.nextElementSibling : over);
    });
    list.addEventListener('drop', (e) => e.preventDefault());

    const close = () => { if (!open) return; open.remove(); open = null; document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    const done = () => { write([...list.children].map((li) => li.dataset.id)); close(); location.reload(); };
    const reset = () => { write(null); close(); location.reload(); };
    const pop = el('div', { class: 'arrange-pop', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Arrange the sidebar') } }, [
      el('h2', { text: t('Arrange the sidebar') }),
      el('p', { class: 'hint', text: t('Drag the pages, or use the arrows. General and About stay at the bottom.') }),
      list,
      el('div', { class: 'arrange-actions' }, [
        UI.button(t('Reset'), reset, 'small'),
        el('span', { class: 'arrange-space' }),
        UI.button(t('Cancel'), close, 'small'),
        UI.button(t('Done'), done, 'small primary'),
      ]),
    ]);
    open = el('div', { class: 'arrange-overlay' }, [pop]);
    open.addEventListener('mousedown', (e) => { if (e.target === open) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(open);
    const first = list.querySelector('button');
    if (first) first.focus();
  };

  // Holding the sidebar (or a right click on it) opens Arrange.
  UI.arrangeHold = (nav) => {
    if (!nav) return;
    let timer = null;
    let at = null;
    let fired = false;
    const stop = () => { clearTimeout(timer); timer = null; };
    nav.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      fired = false;
      at = [e.clientX, e.clientY];
      stop();
      timer = setTimeout(() => { timer = null; fired = true; UI.arrangeOpen(); }, 650);
    });
    nav.addEventListener('pointermove', (e) => { if (timer && at && Math.hypot(e.clientX - at[0], e.clientY - at[1]) > 8) stop(); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) nav.addEventListener(ev, stop);
    nav.addEventListener('click', (e) => { if (fired) { fired = false; e.stopPropagation(); e.preventDefault(); } }, true);
    nav.addEventListener('contextmenu', (e) => { e.preventDefault(); UI.arrangeOpen(); });
  };

  // General › Look.
  UI.arrangeRow = () => UI.row(t('Sidebar order'), t('Put the pages in the order you like. Or hold the sidebar'), [UI.button(t('Arrange…'), () => UI.arrangeOpen(), 'small')]);
})();

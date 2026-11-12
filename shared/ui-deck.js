// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck page (Mac, PC and Linux windows): the tiles a phone or TwinDesk Web device shows for
// this computer (shared/deck.js), laid out and set up here.
//   Spaces along the top (tile spaces, and the window space on Mac and Windows); a tile space's
//   pages under them; the page as the phone shows it, its tiles any size up to 4 × 4: drag one to
//   move it (or onto a page's name), drag its corner to resize it, click an empty cell to add one.
//   Beside it, the selected tile: its look, its action (chosen in the action picker) and the
//   action's options. The window space: its layouts, each a set of zones drawn on a 12 × 12 grid.
// Shown only while a device with a Deck is connected (state.deck.surface). Loaded only while the
// Deck module is on (shared/modules.js), its stylesheet with it.
'use strict';

(function () {
  const t = (...a) => (typeof I18n === 'undefined' ? a[0].replace(/\{(\w+)\}/g, (m, k) => (a[1] && a[1][k] !== undefined ? a[1][k] : m)) : I18n.t(...a));
  const M = window.DeckModel;
  const C = window.DeckCatalog;
  const Icons = window.DeckIcons;
  const { el } = UI;

  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '../shared/ui-deck.css';
  document.head.append(css);

  // A recorded key, as KeyboardEvent.code names; the modifiers by name.
  const MOD_OF = { ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt', ShiftLeft: 'Shift', ShiftRight: 'Shift', MetaLeft: 'Meta', MetaRight: 'Meta' };
  const KEY_NAME = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Enter: '↩', Backspace: '⌫', Delete: '⌦', Space: 'Space', Tab: '⇥' };
  const comboText = (c, mac) => M.combo(c).split('+').filter(Boolean).map((p) => ({
    Mod: mac ? '⌘' : 'Ctrl', Meta: mac ? '⌘' : 'Win', Ctrl: mac ? '⌃' : 'Ctrl', Alt: mac ? '⌥' : 'Alt', Shift: mac ? '⇧' : 'Shift',
  }[p] || KEY_NAME[p] || p.replace(/^Key|^Digit/, ''))).join(mac ? '' : '+');
  const SIZES = [[1, 1], [2, 1], [1, 2], [2, 2], [3, 1], [4, 1], [3, 2], [4, 2]];
  const SIDES = [2, 3, 4]; // the short side: the long one is about 16/9 of it (up to 8)
  const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;

  UI.tab({
    id: 'deck',
    title: 'Deck',
    heading: 'Deck',
    icon: 'deck',
    color: 'linear-gradient(#bf5af2, #5e5ce6)',
    desc: 'Tiles on your phone that run shortcuts, media, sound, windows and more on this computer.',
    hidden: (s) => !(s.deck && s.deck.surface && s.deck.surface.length),
    badge: (s) => (s.deck && s.deck.surface && s.deck.surface.length ? 'on' : ''),
    build(body) {
      const api = UI.api;
      const mac = /Mac/.test(navigator.platform);
      let platform = mac ? 'mac' : /Win/.test(navigator.platform) ? 'win' : 'linux';
      let L = null; // the layout being edited
      let sent = ''; // the last layout saved from here (JSON), to tell our own echo from a device's edit
      let spaceId = '';
      let pageId = '';
      let selId = '';
      let layoutId = ''; // the window space's layout being edited
      let apps = null; // the app picker's list, asked for once
      let dev = null; // sound devices, Bluetooth devices, displays, levels (deckState)
      let can = [];
      let caps = {};
      let saveTimer = null;
      let tryNote = '';

      const where = el('p', { class: 'deck-where' });
      const spacesBar = el('div', { class: 'deck-spaces', attrs: { role: 'tablist', 'aria-label': t('Spaces') } });
      const pagesBar = el('div', { class: 'deck-pages', attrs: { role: 'tablist', 'aria-label': t('Pages') } });
      const stage = el('div', { class: 'deck-stage' });
      const side = el('div', { class: 'deck-side' });
      const gestures = el('div');
      body.append(where, spacesBar, el('div', { class: 'deck-work' }, [el('div', { class: 'deck-left' }, [pagesBar, stage]), side]), gestures);

      const space = () => L.spaces.find((s) => s.id === spaceId) || L.spaces[0];
      const page = () => { const s = space(); return s.kind === 'tiles' ? (s.pages.find((p) => p.id === pageId) || s.pages[0]) : null; };
      const sel = () => (page() && page().tiles.find((x) => x.id === selId)) || null;

      // An edit: applied, normalized, drawn and saved (a moment later, once per burst of typing).
      function change(fn, { side: redrawSide = true } = {}) {
        fn();
        L = M.normalize(L);
        if (!L.spaces.some((s) => s.id === spaceId)) spaceId = L.spaces[0].id;
        const s = space();
        if (s.kind === 'tiles' && !s.pages.some((p) => p.id === pageId)) pageId = s.pages[0].id;
        draw(redrawSide);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { saveTimer = null; sent = JSON.stringify(L); api.deckSave(L); }, 300);
      }

      function draw(withSide = true) {
        drawSpaces();
        if (space().kind === 'windows') drawWindowSpace(withSide);
        else { drawPages(); drawGrid(); if (withSide) drawSide(); }
        drawGestures();
      }

      // ---- spaces and pages ----
      function chip(content, on, onClick, extra = '') {
        const b = el('button', { class: `deck-chip${on ? ' on' : ''} ${extra}`.trim(), attrs: { role: 'tab', 'aria-selected': String(on) } });
        b.append(content);
        b.onclick = onClick;
        return b;
      }
      function drawSpaces() {
        spacesBar.replaceChildren(...L.spaces.map((s) => chip(el('span', { class: 'deck-chip-in' }, [Icons.svg(s.kind === 'windows' ? 'display' : 'grid', 15), el('span', { text: s.name })]),
          s.id === space().id, () => { spaceId = s.id; selId = ''; draw(); })), addMenu());
      }
      let closeMenus = null;
      function addMenu() {
        const wrap = el('div', { class: 'deck-add' });
        const b = el('button', { class: 'deck-chip deck-chip-add', attrs: { 'aria-haspopup': 'menu' } }, [el('span', { class: 'deck-chip-in' }, [el('span', { text: '+' }), el('span', { text: t('Add space') })])]);
        const menu = el('div', { class: 'deck-menu', attrs: { role: 'menu' } });
        const item = (label, hint, fn, disabled) => {
          const i = el('button', { class: 'deck-menu-item', disabled: !!disabled, attrs: { role: 'menuitem' } }, [el('strong', { text: label }), el('span', { text: hint })]);
          i.onclick = () => { menu.classList.remove('open'); fn(); };
          return i;
        };
        const hasWin = L.spaces.some((s) => s.kind === 'windows');
        menu.append(
          item(t('Tile space'), t('Pages of tiles of your own'), () => change(() => {
            const id = M.newId('s');
            L.spaces.push({ id, name: t('Space {n}', { n: L.spaces.length + 1 }), kind: 'tiles', pages: [{ id: M.newId('p'), name: t('Page 1'), ...M.fit(4, L.orient), fit: L.orient, tiles: [] }] });
            spaceId = id;
          })),
          item(t('Window space'), caps.windows === false ? t('Not on Wayland') : hasWin ? t('There is one already') : t('Running apps, your window layouts, your displays'), () => change(() => {
            const id = M.newId('s');
            L.spaces.push({ id, name: t('Windows'), kind: 'windows', layouts: M.starterLayouts() });
            spaceId = id;
          }), caps.windows === false || hasWin),
        );
        // The menu lives on <body> with fixed placement, so nothing on the page (the layout chips,
        // the zone canvas, glass cards) can paint over it.
        const place = () => {
          const r = b.getBoundingClientRect();
          menu.style.top = `${Math.round(r.bottom + 6)}px`;
          menu.style.left = `${Math.round(Math.min(r.left, window.innerWidth - 296))}px`;
        };
        b.onclick = (e) => {
          e.stopPropagation();
          if (menu.classList.contains('open')) { menu.classList.remove('open'); return; }
          place();
          menu.classList.add('open');
          menu.querySelector('.deck-menu-item:not(:disabled)')?.focus();
        };
        menu.onclick = (e) => e.stopPropagation();
        menu.onkeydown = (e) => { if (e.key === 'Escape') { menu.classList.remove('open'); b.focus(); } };
        if (closeMenus) closeMenus();
        const shut = () => menu.classList.remove('open');
        const onScroll = () => { if (menu.classList.contains('open')) place(); };
        document.addEventListener('click', shut);
        window.addEventListener('resize', shut);
        document.addEventListener('scroll', onScroll, true);
        closeMenus = () => {
          document.removeEventListener('click', shut);
          window.removeEventListener('resize', shut);
          document.removeEventListener('scroll', onScroll, true);
          menu.remove();
        };
        document.body.append(menu);
        wrap.append(b);
        return wrap;
      }
      function drawPages() {
        const s = space();
        const plus = chip('+', false, () => change(() => {
          const id = M.newId('p');
          const cur = page();
          s.pages.push({ id, name: t('Page {n}', { n: s.pages.length + 1 }), cols: cur.cols, rows: cur.rows, fit: L.orient, tiles: [] });
          pageId = id;
          selId = '';
        }), 'deck-chip-plus');
        plus.setAttribute('aria-label', t('Add a page'));
        pagesBar.replaceChildren(...s.pages.map((p) => {
          const b = chip(p.name, p.id === page().id, () => { pageId = p.id; selId = ''; draw(); });
          dropTarget(b, (id) => change(() => { L = M.move(L, id, p.id); }));
          return b;
        }), plus);
      }

      // ---- the page as the phone shows it ----
      function drawGrid() {
        const p = page();
        const grid = el('div', { class: 'deck-grid' });
        grid.style.setProperty('--cols', p.cols);
        grid.style.setProperty('--rows', p.rows);
        grid.style.aspectRatio = L.orient === 'portrait' ? '9 / 16' : '16 / 9'; // the phone's screen, held as the Deck is
        if (L.orient === 'portrait') { grid.style.width = 'min(100%, calc(70vh * 9 / 16))'; grid.style.margin = '0 auto'; }
        for (let y = 0; y < p.rows; y++) {
          for (let x = 0; x < p.cols; x++) {
            const cell = el('button', { class: 'deck-cell', attrs: { 'aria-label': t('Add a tile here') } });
            cell.style.gridArea = `${y + 1} / ${x + 1}`;
            cell.onclick = () => picker(null, (a, entry) => change(() => {
              const id = M.newId();
              const w = entry && entry.wide && M.fits(page(), x, y, 2, 1) ? 2 : 1;
              page().tiles.push({ id, x, y, w, h: 1, label: entry ? t(C.text(entry.name, platform)) : '', icon: '', color: M.COLORS[0], action: a });
              selId = id;
              tryNote = '';
            }));
            dropTarget(cell, (id) => change(() => { L = M.move(L, id, p.id, x, y); }));
            grid.append(cell);
          }
        }
        for (const tl of p.tiles) grid.append(tileEl(tl, grid));
        const frame = el('div', { class: 'deck-phone' }, [grid]);
        frame.style.setProperty('--ratio', L.orient === 'portrait' ? '9 / 16' : '16 / 9');
        stage.replaceChildren(frame, el('p', { class: 'deck-tip', text: t('Click an empty place to add a tile. Drag a tile to move it, or onto a page’s name; drag its corner to resize it.') }));
      }

      // A tile as the phone draws it: its symbol, name and what it shows now (a level, a state).
      function tileFace(tl, n) {
        const a = tl.action;
        const sym = tl.icon && !M.SYMBOLS.includes(tl.icon) ? null : Icons.svg(M.iconOf(tl), tl.w > 1 || tl.h > 1 ? 26 : 22);
        const parts = [
          el('span', { class: 'deck-tile-icon' }, [sym || el('span', { class: 'deck-emoji', text: tl.icon })]),
          el('span', { class: 'deck-tile-label', text: tl.label || t(C.name(a, platform)) || t('Tile') }),
        ];
        const sub = stateText(a);
        if (sub && (tl.w > 1 || tl.h > 1)) parts.push(el('span', { class: 'deck-tile-sub', text: sub }));
        if (a.k === 'slider') {
          const lvl = level(a);
          const bar = el('span', { class: 'deck-tile-bar' }, [el('span')]);
          bar.firstChild.style.width = `${Math.round((lvl == null ? 0.5 : lvl) * 100)}%`;
          parts.push(bar);
        }
        n.replaceChildren(...parts);
      }
      function tileEl(tl, grid) {
        const n = el('div', {
          class: `deck-tile${tl.id === selId ? ' selected' : ''}${tl.w > 1 || tl.h > 1 ? ' big' : ''}${tl.w >= tl.h * 2 ? ' wide' : ''}`,
          attrs: { tabindex: '0', role: 'button', 'aria-label': tl.label || t(C.name(tl.action, platform)) },
        });
        n.style.gridArea = `${tl.y + 1} / ${tl.x + 1} / span ${tl.h} / span ${tl.w}`;
        n.style.setProperty('--tile', tl.color);
        n.classList.toggle('light', luminance(tl.color) > 0.6);
        if (!runs(tl.action)) n.classList.add('cant');
        tileFace(tl, n);
        n.draggable = true;
        n.ondragstart = (e) => { e.dataTransfer.setData('text/x-deck', tl.id); e.dataTransfer.effectAllowed = 'move'; n.classList.add('dragging'); };
        n.ondragend = () => n.classList.remove('dragging');
        n.onclick = () => { if (selId !== tl.id) tryNote = ''; selId = tl.id; draw(); focusSel(); };
        n.onkeydown = (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); n.onclick(); }
          if ((e.key === 'Delete' || e.key === 'Backspace') && tl.id === selId) { e.preventDefault(); remove(tl.id); }
          const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
          if (d && tl.id === selId) { e.preventDefault(); change(() => { L = M.move(L, tl.id, page().id, tl.x + d[0], tl.y + d[1]); }); focusSel(); }
        };
        if (tl.id === selId) {
          const handle = el('span', { class: 'deck-resize', attrs: { 'aria-hidden': 'true', title: t('Drag to resize') } });
          handle.onpointerdown = (e) => resizeDrag(e, tl, grid);
          handle.ondragstart = (e) => e.preventDefault();
          n.append(handle);
        }
        return n;
      }
      const focusSel = () => setTimeout(() => { const s = stage.querySelector('.deck-tile.selected'); if (s) s.focus(); }, 0);
      // Drag the corner: the tile covers the cells up to the one under the pointer (where they're free).
      function resizeDrag(e, tl, grid) {
        e.preventDefault();
        e.stopPropagation();
        const p = page();
        const r = grid.getBoundingClientRect();
        const cw = r.width / p.cols, ch = r.height / p.rows;
        let last = `${tl.w}x${tl.h}`;
        const move = (ev) => {
          const w = Math.max(1, Math.min(M.SPAN, Math.floor((ev.clientX - r.left) / cw) - tl.x + 1));
          const h = Math.max(1, Math.min(M.SPAN, Math.floor((ev.clientY - r.top) / ch) - tl.y + 1));
          if (`${w}x${h}` === last) return;
          last = `${w}x${h}`;
          change(() => { L = M.resize(L, tl.id, w, h); }, { side: false });
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); drawSide(); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }
      function dropTarget(node, onDrop) {
        node.ondragover = (e) => { if ([...e.dataTransfer.types].includes('text/x-deck')) { e.preventDefault(); node.classList.add('over'); } };
        node.ondragleave = () => node.classList.remove('over');
        node.ondrop = (e) => { e.preventDefault(); node.classList.remove('over'); const id = e.dataTransfer.getData('text/x-deck'); if (id) onDrop(id); };
      }
      function luminance(hex) {
        const n = parseInt(hex.slice(1), 16);
        return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
      }
      const runs = (a) => {
        const x = C.entry(a);
        return M.DEVICE.includes(a.k) || (can.includes(a.k) && (!x || C.available(x, caps, platform).ok));
      };
      function level(a) {
        if (!dev) return null;
        if (a.what === 'volume') return dev.volume;
        if (a.what === 'mic') return dev.micVolume;
        const ds = (dev.displays || []).filter((d) => !a.display || d.id === a.display);
        return ds.length ? ds[0].level : null;
      }
      function stateText(a) {
        if (a.k === 'keys') return comboText(a.combo, mac);
        if (!dev) return '';
        if (a.k === 'slider') { const l = level(a); return l == null ? '' : pct(l); }
        if (a.k === 'volume' && /toggle|mute|unmute/.test(a.what)) return dev.muted ? t('Muted') : pct(dev.volume);
        if (a.k === 'mic') return dev.micMuted ? t('Muted') : t('Live');
        if (a.k === 'output' || a.k === 'input') { const d = (dev[a.k === 'output' ? 'outputs' : 'inputs'] || []).find((x) => (a.id ? x.id === a.id : x.on)); return d ? d.name : ''; }
        if (a.k === 'bt' && a.id) { const d = ((dev.bt && dev.bt.devices) || []).find((x) => x.id === a.id); return d ? (d.connected ? t('Connected') : t('Not connected')) : ''; }
        if (a.k === 'bt') return dev.bt ? (dev.bt.radio ? t('On') : t('Off')) : '';
        if (a.k === 'sys' && a.what === 'darkmode') return dev.dark ? t('Dark') : t('Light');
        return '';
      }

      // ---- the selected tile ----
      const input = (value, onInput, attrs = {}) => {
        const i = el('input', { type: 'text', value: value || '', attrs });
        i.oninput = () => onInput(i.value);
        return i;
      };
      const field = (label, control, hint) => el('div', { class: 'deck-field' }, [el('span', { class: 'deck-field-label', text: label }), control, hint ? el('span', { class: 'deck-field-hint', text: hint }) : null]);
      const pick = (opts, value, onPick) => {
        const s = UI.select(opts, onPick);
        s.set(value);
        return s.el;
      };
      const panel = (title, kids) => el('section', { class: 'deck-panel' }, [el('h3', { text: title }), ...kids]);
      function remove(id) { change(() => { const p = page(); p.tiles = p.tiles.filter((x) => x.id !== id); selId = ''; }); }

      function drawSide() {
        const tl = sel();
        const p = page();
        if (!p) return;
        if (!tl) {
          side.replaceChildren(
            panel(t('Page'), [
              field(t('Name'), input(p.name, (v) => change(() => { page().name = v; }, { side: false }), { maxlength: 30 })),
              // One side is chosen, the other follows the screen (16:9), so tiles stay about square.
              L.orient === 'portrait'
                ? field(t('Columns'), pick(SIDES.map((n) => ({ value: n, label: String(n) })), p.cols, (v) => change(() => { Object.assign(page(), M.fit(Number(v), 'portrait')); })))
                : field(t('Rows'), pick(SIDES.map((n) => ({ value: n, label: String(n) })), p.rows, (v) => change(() => { Object.assign(page(), M.fit(Number(v), 'landscape')); }))),
              el('p', { class: 'deck-field-hint', text: t('A smaller grid cuts tiles past its edge, and removes those that start past it.') }),
              el('div', { class: 'deck-actions' }, [
                UI.button(t('Move left'), () => change(() => { const ps = space().pages; const i = ps.indexOf(page()); if (i > 0) ps.splice(i - 1, 0, ps.splice(i, 1)[0]); }), 'small'),
                UI.button(t('Move right'), () => change(() => { const ps = space().pages; const i = ps.indexOf(page()); if (i < ps.length - 1) ps.splice(i + 1, 0, ps.splice(i, 1)[0]); }), 'small'),
                space().pages.length > 1 ? UI.button(t('Delete page'), () => change(() => { const s2 = space(); s2.pages = s2.pages.filter((x) => x.id !== p.id); pageId = s2.pages[0].id; }), 'small destructive') : null,
              ]),
            ]),
            spacePanel(space()),
          );
          return;
        }
        const set = (fn, o) => change(() => fn(sel()), o);
        const a = tl.action;
        const entry = C.entry(a);
        const actionRow = el('button', { class: 'deck-action-row' }, [
          el('span', { class: 'deck-action-icon' }, [Icons.svg(M.symbolOf(a) || 'none', 20)]),
          el('span', { class: 'deck-action-text' }, [
            el('strong', { text: entry ? t(C.text(entry.name, platform)) : t('Choose an action') }),
            el('span', { text: entry ? t(C.text(entry.desc, platform)) : '' }),
          ]),
          el('span', { class: 'deck-action-change', text: t('Change') }),
        ]);
        actionRow.onclick = () => picker(a, (na, ne) => set((x) => {
          const was = C.entry(x.action);
          if (!x.label || (was && x.label === t(C.text(was.name, platform)))) x.label = ne ? t(C.text(ne.name, platform)) : '';
          x.action = na;
          if (ne && ne.wide && x.w === 1 && M.fits(page(), x.x, x.y, 2, 1, x.id)) x.w = 2;
          tryNote = '';
        }));
        const sizes = el('div', { class: 'deck-sizes', attrs: { role: 'radiogroup', 'aria-label': t('Size') } }, SIZES.map(([w, h]) => {
          const on = tl.w === w && tl.h === h;
          const fits = M.fits(page(), tl.x, tl.y, w, h, tl.id);
          const b = el('button', { class: `deck-size${on ? ' on' : ''}`, disabled: !fits && !on, attrs: { role: 'radio', 'aria-checked': String(on), title: fits || on ? '' : t('No room for this size here') } });
          const shape = el('span', { class: 'deck-size-shape' });
          shape.style.width = `${w * 7 + (w - 1) * 2}px`;
          shape.style.height = `${h * 7 + (h - 1) * 2}px`;
          b.append(shape, el('span', { text: `${w}×${h}` }));
          b.onclick = () => change(() => { L = M.resize(L, tl.id, w, h); });
          return b;
        }));
        const rows = [
          actionRow,
          ...options(tl, set),
          field(t('Label'), input(tl.label, (v) => set((x) => { x.label = v; }, { side: false }), { maxlength: 40 })),
          field(t('Symbol'), iconPicker(tl, set)),
          field(t('Colour'), el('div', { class: 'deck-colors' }, M.COLORS.map((c) => {
            const sw = el('button', { class: `deck-color${c === tl.color ? ' on' : ''}`, attrs: { 'aria-label': c } });
            sw.style.background = c;
            sw.onclick = () => set((x) => { x.color = c; });
            return sw;
          }))),
          field(t('Size'), sizes),
        ];
        const note = el('span', { class: `deck-try-note${tryNote.startsWith('!') ? ' bad' : ''}`, text: tryNote.replace(/^!/, ''), attrs: { 'aria-live': 'polite' } });
        rows.push(el('div', { class: 'deck-actions' }, [
          UI.button(t('Try on this computer'), async () => {
            const k = sel().action.k;
            if (M.DEVICE.includes(k)) tryNote = t('This one works on the phone');
            else if (k === 'slider') tryNote = t('Drag it on the phone');
            else {
              const r = await api.deckRun(sel().action);
              tryNote = r && r.ok ? t('Done') : `!${(r && r.why) || t('It didn’t work')}`;
              if (r && r.ok) refresh();
            }
            drawSide();
          }, 'small'),
          note, el('span', { class: 'deck-spacer' }),
          UI.button(t('Duplicate'), () => change(() => {
            const p2 = page();
            const f = M.free(p2, tl.w, tl.h);
            const g = f || M.free(p2, 1, 1);
            if (!g) return;
            const id = M.newId();
            p2.tiles.push({ ...JSON.parse(JSON.stringify(tl)), id, x: g.x, y: g.y, ...(f ? {} : { w: 1, h: 1 }) });
            selId = id;
          }), 'small'),
          UI.button(t('Delete'), () => remove(tl.id), 'small destructive'),
        ]));
        side.replaceChildren(panel(t('Tile'), rows));
      }
      function spacePanel(s) {
        return panel(t('Space'), [
          field(t('Name'), input(s.name, (v) => change(() => { space().name = v; }, { side: false }), { maxlength: 30 })),
          L.spaces.length > 1 ? el('div', { class: 'deck-actions' }, [
            UI.button(t('Delete space'), () => change(() => { L.spaces = L.spaces.filter((x) => x.id !== s.id); spaceId = L.spaces[0].id; }), 'small destructive'),
          ]) : null,
        ]);
      }

      // Symbols as the phone draws them, or an emoji typed in.
      function iconPicker(tl, set) {
        const wrap = el('div', { class: 'deck-symbols' });
        const auto = el('button', { class: `deck-symbol auto${!tl.icon ? ' on' : ''}`, title: t('The action’s own'), attrs: { 'aria-label': t('The action’s own') } }, [Icons.svg(M.symbolOf(tl.action) || 'none', 18)]);
        auto.onclick = () => set((x) => { x.icon = ''; });
        wrap.append(auto);
        for (const s of M.SYMBOLS) {
          if (s === 'none') continue;
          const b = el('button', { class: `deck-symbol${tl.icon === s ? ' on' : ''}`, title: s, attrs: { 'aria-label': s } }, [Icons.svg(s, 18)]);
          b.onclick = () => set((x) => { x.icon = s; });
          wrap.append(b);
        }
        const emoji = input(tl.icon && !M.SYMBOLS.includes(tl.icon) ? tl.icon : '', (v) => set((x) => { x.icon = v.trim(); }, { side: false }), { maxlength: 16, placeholder: t('Or an emoji'), class: 'deck-emoji-input' });
        return el('div', {}, [wrap, emoji]);
      }

      // The options of the tile's action.
      function options(tl, set) {
        const a = tl.action;
        const act = (patch) => set((x) => { x.action = { ...x.action, ...patch }; });
        const out = [];
        switch (a.k) {
          case 'keys': out.push(recorder(tl, act)); break;
          case 'text': {
            const ta = el('textarea', { value: a.text || '', attrs: { rows: 4, maxlength: 4000, placeholder: t('Text to type') } });
            ta.oninput = () => set((x) => { x.action = { ...x.action, text: ta.value }; }, { side: false });
            const sw = UI.switch((v) => act({ enter: v }), { label: t('Press Return after it') });
            sw.set(a.enter);
            out.push(field(t('Text'), ta), el('label', { class: 'deck-check' }, [sw.el, el('span', { text: t('Press Return after it') })]));
            break;
          }
          case 'macro': out.push(macroEditor(tl, set)); break;
          case 'volume':
            if (a.what === 'up' || a.what === 'down') out.push(field(t('Step'), rangeInput(a.step, 1, 25, (v) => act({ step: v }), (v) => `${v}%`)));
            if (a.what === 'set') out.push(field(t('Level'), rangeInput(a.level, 0, 100, (v) => act({ level: v }), (v) => `${v}%`)));
            break;
          case 'output': case 'input': {
            const list = (dev && dev[a.k === 'output' ? 'outputs' : 'inputs']) || [];
            out.push(field(a.k === 'output' ? t('Output') : t('Input'), pick([
              ...(a.k === 'output' ? [{ value: '', label: t('The next one, in turn') }] : [{ value: '', label: t('Choose a microphone') }]),
              ...list.map((d) => ({ value: d.id, label: d.name })),
              ...(a.id && !list.some((d) => d.id === a.id) ? [{ value: a.id, label: `${a.name} (${t('not connected')})` }] : []),
            ], a.id, (id) => { const d = list.find((x) => x.id === id); act({ id, name: d ? d.name : '' }); })));
            break;
          }
          case 'bt':
            if (!['on', 'off', 'toggle'].includes(a.what)) {
              const list = (dev && dev.bt && dev.bt.devices) || [];
              out.push(field(t('Device'), pick([
                { value: '', label: dev ? t('Choose a paired device') : t('Loading…') },
                ...list.map((d) => ({ value: d.id, label: d.name + (d.connected ? ` · ${t('connected')}` : '') })),
                ...(a.id && !list.some((d) => d.id === a.id) ? [{ value: a.id, label: a.name }] : []),
              ], a.id, (id) => {
                const d = list.find((x) => x.id === id);
                set((x) => { const was = C.entry(x.action); if (d && (!x.label || (was && x.label === t(C.text(was.name, platform))))) x.label = d.name; x.action = { ...x.action, id, name: d ? d.name : '' }; });
              }), t('Pair it in the system’s Bluetooth settings first.')));
            }
            break;
          case 'bright': case 'slider':
            if (a.k === 'bright' || a.what === 'bright') {
              const ds = (dev && dev.displays) || [];
              out.push(field(t('Display'), pick([{ value: '', label: t('All displays') }, ...ds.map((d) => ({ value: d.id, label: d.name }))], a.display, (v) => act({ display: v })),
                dev && !ds.length ? t('No display here lets its brightness be changed: built-in screens do, and on Windows external monitors with DDC/CI on.') : ''));
            }
            if (a.k === 'bright' && a.what === 'set') out.push(field(t('Level'), rangeInput(a.level, 0, 100, (v) => act({ level: v }), (v) => `${v}%`)));
            break;
          case 'app': out.push(appField(a, set)); break;
          case 'url': {
            const u = input(a.url || '', () => {}, { placeholder: 'https://', spellcheck: false });
            u.onchange = () => act({ url: u.value });
            out.push(field(t('Address'), u, t('Only http and https addresses.')));
            break;
          }
          case 'open': case 'script': {
            const shown = el('code', { class: 'deck-path', text: a.path || t('None chosen') });
            const choose = UI.button(t('Choose…'), async () => {
              const p = await api.deckPick({ kind: a.k === 'script' ? 'script' : 'any' });
              if (p) set((x) => { const was = C.entry(x.action); if (!x.label || (was && x.label === t(C.text(was.name, platform)))) x.label = p.split(/[\\/]/).pop().replace(/\.(command|bat|cmd|sh)$/i, ''); x.action = { ...x.action, path: p }; });
            }, 'small');
            const hint = a.k === 'script' ? `${t(C.text(C.entry(a).desc, platform))} ${t('The phone never sees the path.')}` : t('The phone never sees the path.');
            out.push(field(a.k === 'script' ? t('Script') : t('File or folder'), el('div', { class: 'deck-path-row' }, [shown, choose]), hint));
            break;
          }
          case 'nav':
            if (a.what === 'page') out.push(field(t('Page'), pick(space().pages.map((x) => ({ value: x.id, label: x.name })), a.to, (to) => act({ to }))));
            if (a.what === 'space') out.push(field(t('Space'), pick(L.spaces.map((x) => ({ value: x.id, label: x.name })), a.to, (to) => act({ to }))));
            break;
          default:
        }
        return out;
      }
      function rangeInput(value, min, max, onSet, fmt) {
        const s = UI.slider({ min, max, step: 1, format: fmt }, (v) => onSet(v));
        s.set(value);
        return s.el;
      }

      // A shortcut: press it while recording (any keys, with or without modifiers), or type it.
      function recorder(tl, act) {
        const show = el('kbd', { class: 'deck-combo', text: comboText(tl.action.combo, mac) || t('None') });
        let rec = false;
        const btn = UI.button(t('Record'), () => {
          rec = !rec;
          btn.textContent = rec ? t('Press the keys…') : t('Record');
          btn.classList.toggle('primary', rec);
          if (rec) btn.focus();
        }, 'small');
        btn.onkeydown = (e) => {
          if (!rec) return;
          e.preventDefault();
          e.stopPropagation();
          if (MOD_OF[e.code]) return; // wait for the key itself
          const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean);
          rec = false;
          act({ combo: M.combo([...mods, e.code].join('+')) });
        };
        btn.onblur = () => { if (rec) { rec = false; btn.textContent = t('Record'); btn.classList.remove('primary'); } };
        const typed = input(tl.action.combo || '', () => {}, { placeholder: 'Mod+Shift+KeyS', class: 'deck-combo-input', spellcheck: false });
        typed.onchange = () => act({ combo: typed.value });
        return field(t('Shortcut'), el('div', { class: 'deck-path-row' }, [show, btn, typed]), t('Record it, or type it with key codes: Mod is ⌘ on a Mac and Ctrl elsewhere.'));
      }

      // Multi-action: its steps, each an action and a pause before it.
      function macroEditor(tl, set) {
        const steps = tl.action.steps || [];
        const list = el('ol', { class: 'deck-steps' }, steps.map((s, i) => {
          const name = t(C.name(s.action, platform)) || t('Nothing');
          const detail = s.action.k === 'keys' ? comboText(s.action.combo, mac) : s.action.k === 'text' ? `“${String(s.action.text).slice(0, 24)}”` : s.action.k === 'url' ? s.action.url : s.action.name || '';
          const wait = el('input', { type: 'number', min: 0, max: 10000, step: 50, value: s.wait, class: 'deck-wait', attrs: { 'aria-label': t('Pause before it, in milliseconds') } });
          wait.onchange = () => set((x) => { x.action.steps[i].wait = Number(wait.value) || 0; });
          const up = UI.button('↑', () => set((x) => { if (i > 0) x.action.steps.splice(i - 1, 0, x.action.steps.splice(i, 1)[0]); }), 'small');
          const rm = UI.button('✕', () => set((x) => { x.action.steps.splice(i, 1); }), 'small');
          up.disabled = i === 0;
          up.setAttribute('aria-label', t('Earlier'));
          rm.setAttribute('aria-label', t('Remove'));
          return el('li', {}, [el('span', { class: 'deck-step-name' }, [el('strong', { text: name }), detail ? el('span', { text: detail }) : null]),
            el('label', { class: 'deck-wait-label' }, [t('Wait'), wait, 'ms']), up, rm]);
        }));
        const add = UI.button(t('Add a step…'), () => picker(null, (a) => set((x) => { x.action.steps.push({ action: a, wait: 0 }); }), { forMacro: true }), 'small');
        add.disabled = steps.length >= 20;
        return field(t('Steps'), el('div', {}, [steps.length ? list : el('p', { class: 'deck-field-hint', text: t('No steps yet.') }), add]),
          t('Shortcut and text steps take the options of a tile of their own: set one up on a tile, then copy it with Duplicate and change its action to Multi-action.'));
      }

      function appField(a, set) {
        const s = UI.select([{ value: a.id || '', label: a.name || t('Loading apps…') }], (id) => {
          const x = (apps || []).find((v) => v.id === id);
          if (x) set((tl) => { const was = C.entry(tl.action); if (!tl.label || (was && tl.label === t(C.text(was.name, platform)))) tl.label = x.name; tl.action = { k: 'app', id: x.id, name: x.name }; });
        });
        s.set(a.id || '');
        const fill = () => { s.options([{ value: '', label: t('Choose an app') }, ...apps.map((x) => ({ value: x.id, label: x.name }))]); s.set(a.id || ''); };
        if (apps) fill();
        else Promise.resolve(api.deckApps()).then((list) => { apps = Array.isArray(list) ? list : []; fill(); });
        return field(t('App'), s.el);
      }

      // ---- the action picker ----
      // A sheet over the page: a search field, the groups, each action with what it does; what this
      // computer can't do is shown with the reason, not offered.
      function picker(current, onPick, { forMacro = false } = {}) {
        const prev = document.activeElement;
        let group = '';
        let q = '';
        const shade = el('div', { class: 'deck-sheet-shade' });
        const search = el('input', { type: 'search', class: 'deck-sheet-search', attrs: { placeholder: t('Search actions'), 'aria-label': t('Search actions') } });
        const groups = el('nav', { class: 'deck-sheet-groups', attrs: { 'aria-label': t('Groups') } });
        const list = el('div', { class: 'deck-sheet-list', attrs: { role: 'listbox', 'aria-label': t('Actions') } });
        const close = () => { shade.remove(); document.removeEventListener('keydown', key, true); if (prev && prev.focus) prev.focus(); };
        const sheet = el('div', { class: 'deck-sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Choose an action') } }, [
          el('header', {}, [el('h2', { text: forMacro ? t('Add a step') : current ? t('Change action') : t('New tile') }), search, UI.button(t('Cancel'), close, 'small')]),
          el('div', { class: 'deck-sheet-body' }, [groups, list]),
        ]);
        shade.append(sheet);
        shade.onclick = (e) => { if (e.target === shade) close(); };
        const entries = C.ENTRIES.filter((x) => !(forMacro && (x.device || x.action.k === 'slider' || x.action.k === 'macro')));
        const curId = current ? (C.entry(current) || {}).id : '';
        function drawList() {
          const words = q.toLowerCase().split(/\s+/).filter(Boolean);
          const shown = entries.filter((x) => (!group || x.group === group || words.length)
            && words.every((w) => `${t(C.text(x.name, platform))} ${t(C.text(x.desc, platform))} ${t(C.GROUPS.find((g) => g.id === x.group).name)}`.toLowerCase().includes(w)));
          const out = [];
          for (const g of C.GROUPS) {
            const items = shown.filter((x) => x.group === g.id);
            if (!items.length) continue;
            out.push(el('h4', { text: t(g.name) }));
            for (const x of items) {
              const av = C.available(x, caps, platform);
              const ok = av.ok && (x.device || can.includes(x.action.k));
              const b = el('button', { class: `deck-sheet-item${x.id === curId ? ' current' : ''}`, disabled: !ok, attrs: { role: 'option', 'aria-selected': String(x.id === curId) } }, [
                el('span', { class: 'deck-action-icon' }, [Icons.svg(M.symbolOf(x.action) || 'none', 20)]),
                el('span', { class: 'deck-action-text' }, [el('strong', { text: t(C.text(x.name, platform)) }), el('span', { text: ok ? t(C.text(x.desc, platform)) : t(av.why || 'Not on this computer') })]),
                x.local ? el('span', { class: 'deck-badge', text: t('Stays on this computer') }) : null,
              ]);
              b.onclick = () => { close(); onPick(M.action(JSON.parse(JSON.stringify(x.action))), x); };
              out.push(b);
            }
          }
          list.replaceChildren(...(out.length ? out : [el('p', { class: 'deck-empty', text: t('No action matches “{q}”.', { q }) })]));
        }
        function drawGroups() {
          groups.replaceChildren(...[{ id: '', name: 'All' }, ...C.GROUPS].filter((g) => !g.id || entries.some((x) => x.group === g.id)).map((g) => {
            const b = el('button', { class: `deck-sheet-group${group === g.id ? ' on' : ''}`, text: t(g.name) });
            b.onclick = () => { group = g.id; q = ''; search.value = ''; drawGroups(); drawList(); list.scrollTop = 0; };
            return b;
          }));
        }
        function key(e) {
          if (e.key === 'Escape') { e.preventDefault(); close(); return; }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const items = [...list.querySelectorAll('.deck-sheet-item:not(:disabled)')];
            if (!items.length) return;
            e.preventDefault();
            const i = items.indexOf(document.activeElement);
            items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
          }
        }
        search.oninput = () => { q = search.value; drawList(); };
        document.addEventListener('keydown', key, true);
        drawGroups();
        drawList();
        document.body.append(shade);
        search.focus();
        const cur = list.querySelector('.current');
        if (cur) cur.scrollIntoView({ block: 'center' });
      }

      // ---- the window space ----
      function drawWindowSpace(withSide) {
        const s = space();
        const plus = chip('+', false, () => change(() => { const id = M.newId('l'); space().layouts.push({ id, name: t('Layout {n}', { n: space().layouts.length + 1 }), zones: [{ x: 0, y: 0, w: 12, h: 12 }] }); layoutId = id; }), 'deck-chip-plus');
        plus.setAttribute('aria-label', t('Add a layout'));
        pagesBar.replaceChildren(...s.layouts.map((x) => chip(el('span', { class: 'deck-chip-in' }, [miniZones(x.zones), el('span', { text: x.name })]), x.id === layoutOf(s).id, () => { layoutId = x.id; draw(); })), plus);
        const lay = layoutOf(s);
        stage.replaceChildren(zoneCanvas(lay), el('p', { class: 'deck-tip', text: t('Drag across the display to draw a zone; click a zone to remove it. On the phone, drag an app onto a corner, a side or the middle of a display; pick a few apps and your layouts with as many zones show next to the ready-made ones.') }));
        if (!withSide) return;
        side.replaceChildren(
          panel(t('Layout'), [
            field(t('Name'), input(lay.name, (v) => change(() => { layoutOf(space()).name = v; }, { side: false }), { maxlength: 30 })),
            field(t('Start from'), el('div', { class: 'deck-presets' }, M.starterLayouts().map((pz) => {
              const b = el('button', { class: 'deck-preset', title: t(pz.name) }, [miniZones(pz.zones), el('span', { text: t(pz.name) })]);
              b.onclick = () => change(() => { layoutOf(space()).zones = JSON.parse(JSON.stringify(pz.zones)); });
              return b;
            }))),
            s.layouts.length > 1 ? el('div', { class: 'deck-actions' }, [
              UI.button(t('Delete layout'), () => change(() => { const sp = space(); sp.layouts = sp.layouts.filter((x) => x.id !== lay.id); }), 'small destructive'),
            ]) : null,
          ]),
          setsPanel(s),
          spacePanel(s),
        );
      }
      // The apps saved together on the phone (Save after arranging them): renamed or removed here.
      function setsPanel(s) {
        const sets = s.sets || [];
        return panel(t('Saved sets'), sets.length ? sets.map((x) => el('div', { class: 'deck-set' }, [
          miniZones(x.items.map((it) => it.zone)),
          input(x.name, (v) => change(() => { const y = (space().sets || []).find((q) => q.id === x.id); if (y) y.name = v; }, { side: false }), { maxlength: 60 }),
          UI.button(t('Remove'), () => change(() => { const sp = space(); sp.sets = (sp.sets || []).filter((q) => q.id !== x.id); }), 'small destructive'),
        ])) : [el('p', { class: 'deck-tip', text: t('On the phone, pick a few apps, tap how they should sit and Save: the set waits on the shelf at the display’s edge, and one tap arranges the apps again, opening the ones not running.') })]);
      }
      const layoutOf = (s) => s.layouts.find((x) => x.id === layoutId) || s.layouts[0];
      const place = (n, z) => Object.assign(n.style, { left: `${(z.x / 12) * 100}%`, top: `${(z.y / 12) * 100}%`, width: `${(z.w / 12) * 100}%`, height: `${(z.h / 12) * 100}%` });
      function miniZones(zones) {
        const m = el('span', { class: 'deck-mini', attrs: { 'aria-hidden': 'true' } });
        for (const z of zones) { const b = el('span'); place(b, z); m.append(b); }
        return m;
      }
      function zoneCanvas(lay) {
        const c = el('div', { class: 'deck-zones', attrs: { 'aria-label': t('Zones of {name}', { name: lay.name }) } });
        lay.zones.forEach((z, i) => {
          const b = el('button', { class: 'deck-zone', attrs: { 'aria-label': t('Remove zone {n}', { n: i + 1 }) } }, [el('span', { text: String(i + 1) })]);
          place(b, z);
          b.onclick = (e) => { e.stopPropagation(); if (lay.zones.length > 1) change(() => { layoutOf(space()).zones.splice(i, 1); }); };
          b.onpointerdown = (e) => e.stopPropagation();
          c.append(b);
        });
        const ghost = el('span', { class: 'deck-zone-ghost' });
        c.append(ghost);
        c.onpointerdown = (e) => {
          const r = c.getBoundingClientRect();
          const cell = (ev) => ({ x: Math.max(0, Math.min(11, Math.floor(((ev.clientX - r.left) / r.width) * 12))), y: Math.max(0, Math.min(11, Math.floor(((ev.clientY - r.top) / r.height) * 12))) });
          const a = cell(e);
          let z = { x: a.x, y: a.y, w: 1, h: 1 };
          const show = () => { ghost.style.display = 'block'; place(ghost, z); };
          show();
          const move = (ev) => { const b = cell(ev); z = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 }; show(); };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            ghost.style.display = 'none';
            if (z.w * z.h >= 2) change(() => { const l2 = layoutOf(space()); if (l2.zones.length < 12) l2.zones.push(z); });
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        };
        return el('div', { class: 'deck-display' }, [c]);
      }

      // ---- gestures ----
      function drawGestures() {
        const pg = UI.switch((v) => change(() => { L.swipe.pages = v; }), { label: t('Swipe between pages') });
        const sp = UI.switch((v) => change(() => { L.swipe.spaces = v; }), { label: t('Three-finger swipe between spaces') });
        pg.set(L.swipe.pages);
        sp.set(L.swipe.spaces);
        const or = UI.segmented([{ value: 'landscape', label: t('Landscape') }, { value: 'portrait', label: t('Portrait') }], (v) => change(() => { L.orient = v; }));
        or.set(L.orient || 'landscape');
        gestures.replaceChildren(UI.card(t('On the phone'), [
          UI.row(t('Hold the phone'), t('The Deck opens full screen this way up'), [or.el]),
          UI.row(t('Swipe between pages'), t('Off: switch pages with the page bar, or a Go to page tile'), [pg.el]),
          UI.row(t('Three-finger swipe between spaces'), t('Off: switch spaces with the space bar, or a Go to space tile'), [sp.el]),
          UI.row(t('Start over'), t('Replaces every space, page and tile with the first layout'), [UI.button(t('Reset'), () => {
            if (window.confirm(t('Replace the whole Deck with the first layout?'))) change(() => { L = M.starter(); spaceId = ''; pageId = ''; selId = ''; });
          }, 'small destructive')]),
        ]));
      }

      // Devices and levels for the pickers and the tiles' faces: once a visit, and after a Try.
      let asking = false;
      function refresh() {
        if (asking || !api.deckState) return;
        asking = true;
        Promise.resolve(api.deckState()).then((s) => { dev = s || {}; }).catch(() => {}).finally(() => {
          asking = false;
          const typing = body.contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
          if (L && !typing) draw();
        });
      }

      return (s) => {
        const d = s.deck;
        if (!d) return;
        can = d.can || [];
        caps = d.caps || {};
        if (d.platform) platform = d.platform;
        where.textContent = d.surface && d.surface.length ? t('On {names}. Changes show there at once.', { names: d.surface.join(', ') }) : '';
        const incoming = JSON.stringify(d.layout);
        const editing = body.contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
        if (!L || (incoming !== sent && incoming !== JSON.stringify(L) && !editing && !saveTimer)) {
          const first = !L;
          L = M.normalize(d.layout);
          sent = incoming;
          draw();
          if (first) refresh();
        }
      };
    },
  });
})();

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck page (Mac, PC and Linux windows): the buttons a phone or TwinDesk Web device shows for
// this computer (shared/deck.js), laid out and set up here. Drag a button to another place or onto
// a page's name; click one to set it up below the grid. Shown only while a device with a Deck is
// connected (state.deck.surface): with none, or with only computers and iPhones without TwinDesk's
// Deck, there's nothing to show it on. Loaded only while the Deck module is on (shared/modules.js),
// its stylesheet with it.
'use strict';

(function () {
  const t = (...a) => (typeof I18n === 'undefined' ? a[0] : I18n.t(...a));
  const M = window.DeckModel;
  const { el } = UI;

  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '../shared/ui-deck.css';
  document.head.append(css);

  const KIND_LABEL = {
    keys: 'Shortcut', text: 'Type text', media: 'Media', bright: 'Brightness', url: 'Open a website', app: 'Open an app',
    sys: 'Lock or sleep', clip: 'Clipboard', page: 'Go to page', none: 'Nothing (a label)',
  };
  const MEDIA_LABEL = { playpause: 'Play/Pause', next: 'Next', prev: 'Previous', volup: 'Volume up', voldown: 'Volume down', mute: 'Mute' };
  const SYS_LABEL = { lock: 'Lock', sleep: 'Sleep' };
  const CLIP_LABEL = { copy: 'Copy', cut: 'Cut', paste: 'Paste', send: 'Send to the phone' };
  // A recorded key, as KeyboardEvent.code names; the modifiers by name.
  const MOD_OF = { ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt', ShiftLeft: 'Shift', ShiftRight: 'Shift', MetaLeft: 'Meta', MetaRight: 'Meta' };
  const comboText = (c, mac) => M.combo(c).split('+').filter(Boolean).map((p) => ({
    Mod: mac ? '⌘' : 'Ctrl', Meta: mac ? '⌘' : 'Win', Ctrl: mac ? '⌃' : 'Ctrl', Alt: mac ? '⌥' : 'Alt', Shift: mac ? '⇧' : 'Shift',
  }[p] || p.replace(/^Key|^Digit/, ''))).join(mac ? '' : '+');

  UI.tab({
    id: 'deck',
    title: 'Deck',
    heading: 'Deck',
    icon: 'deck',
    color: 'linear-gradient(#bf5af2, #5e5ce6)',
    desc: 'Buttons on your phone that run shortcuts, media, apps and more on this computer.',
    hidden: (s) => !(s.deck && s.deck.surface && s.deck.surface.length),
    badge: (s) => (s.deck && s.deck.surface && s.deck.surface.length ? 'on' : ''),
    build(body) {
      const api = UI.api;
      const mac = /Mac/.test(navigator.platform);
      let L = null; // the layout being edited
      let sent = ''; // the last layout saved from here (JSON), to tell our own echo from a device's edit
      let pageId = '';
      let selId = '';
      let apps = null; // the app picker's list, asked for once
      let can = [];
      let saveTimer = null;

      const where = el('p', { class: 'deck-where' });
      const pagesBar = el('div', { class: 'deck-pages', attrs: { role: 'tablist' } });
      const grid = el('div', { class: 'deck-grid' });
      const sizeCols = UI.select([2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: n, label: String(n) })), (v) => change(() => { L.cols = Number(v); }));
      const sizeRows = UI.select([2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: n, label: String(n) })), (v) => change(() => { L.rows = Number(v); }));
      const inspector = el('div', { class: 'deck-inspector' });
      body.append(
        where,
        el('div', { class: 'deck-board' }, [pagesBar, grid]),
        UI.card(t('Grid'), [UI.row(t('Columns'), t('Buttons that don’t fit a smaller grid are removed'), [sizeCols.el]), UI.row(t('Rows'), '', [sizeRows.el])]),
        inspector,
      );

      const page = () => L.pages.find((p) => p.id === pageId) || L.pages[0];
      const sel = () => (page().buttons.find((b) => b.id === selId) || null);

      // An edit: applied, normalized, drawn and saved (a moment later, once per burst of typing).
      function change(fn, redrawInspector = true) {
        fn();
        L = M.normalize(L);
        if (!L.pages.some((p) => p.id === pageId)) pageId = L.pages[0].id;
        drawBoard();
        if (redrawInspector) drawInspector();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { saveTimer = null; sent = JSON.stringify(L); api.deckSave(L); }, 300);
      }

      function drawBoard() {
        pagesBar.replaceChildren(...L.pages.map((p) => {
          const b = el('button', { class: `deck-page${p.id === page().id ? ' active' : ''}`, text: p.name, attrs: { role: 'tab' } });
          b.onclick = () => { pageId = p.id; selId = ''; drawBoard(); drawInspector(); };
          dropTarget(b, (id) => change(() => {
            const free = [...Array(L.cols * L.rows).keys()].find((i) => !p.buttons.some((x) => x.slot === i));
            if (free !== undefined) L = M.move(L, page().id, id, p.id, free);
          }));
          return b;
        }), UI.button('+', () => change(() => {
          const id = M.newId('p');
          L.pages.push({ id, name: t('Page {n}', { n: L.pages.length + 1 }), buttons: [] });
          pageId = id;
        }), 'small deck-add-page'));
        grid.style.gridTemplateColumns = `repeat(${L.cols}, 1fr)`;
        const p = page();
        grid.replaceChildren(...[...Array(L.cols * L.rows).keys()].map((slot) => {
          const b = p.buttons.find((x) => x.slot === slot);
          const cell = el('div', { class: `deck-slot${b ? ' filled' : ''}${b && b.id === selId ? ' selected' : ''}` });
          if (b) {
            cell.style.background = b.color;
            cell.draggable = true;
            cell.append(el('span', { class: 'deck-icon', text: b.icon || '' }), el('span', { class: 'deck-label', text: b.label }));
            if (b.action.k !== 'none' && !can.includes(b.action.k)) cell.classList.add('cant');
            cell.ondragstart = (e) => { e.dataTransfer.setData('text/x-deck', b.id); cell.classList.add('dragging'); };
            cell.ondragend = () => cell.classList.remove('dragging');
            cell.onclick = () => { selId = b.id; drawBoard(); drawInspector(); };
          } else {
            cell.append(el('span', { class: 'deck-plus', text: '+' }));
            cell.onclick = () => change(() => {
              const id = M.newId();
              page().buttons.push({ id, slot, label: t('Button'), icon: '', color: M.COLORS[1], action: { k: 'none' } });
              selId = id;
            });
          }
          dropTarget(cell, (id) => change(() => { L = M.move(L, p.id, id, p.id, slot); }));
          return cell;
        }));
      }

      function dropTarget(node, onDrop) {
        node.ondragover = (e) => { if ([...e.dataTransfer.types].includes('text/x-deck')) { e.preventDefault(); node.classList.add('over'); } };
        node.ondragleave = () => node.classList.remove('over');
        node.ondrop = (e) => { e.preventDefault(); node.classList.remove('over'); const id = e.dataTransfer.getData('text/x-deck'); if (id) onDrop(id); };
      }

      const input = (value, onInput, attrs = {}) => {
        const i = el('input', { type: 'text', value: value || '', attrs });
        i.oninput = () => onInput(i.value);
        return i;
      };
      const pick = (opts, value, onPick) => {
        const s = UI.select(opts, onPick);
        s.set(value);
        return s.el;
      };

      function drawInspector() {
        const b = sel();
        const p = page();
        if (!b) {
          inspector.replaceChildren(UI.card(t('Page'), [
            UI.row(t('Name'), '', [input(p.name, (v) => change(() => { page().name = v; }, false))]),
            UI.row(t('Delete this page'), t('Its buttons go with it'), [UI.button(t('Delete'), () => change(() => {
              if (L.pages.length > 1) { L.pages = L.pages.filter((x) => x.id !== p.id); pageId = L.pages[0].id; }
            }), 'small destructive')]),
          ]), el('p', { class: 'deck-tip', text: t('Click a button to set it up, or an empty place to add one. Drag buttons to move them, or onto a page’s name.') }));
          return;
        }
        const set = (fn, redraw = false) => change(() => fn(sel()), redraw);
        const a = b.action;
        const rows = [
          UI.row(t('Label'), '', [input(b.label, (v) => set((x) => { x.label = v; }), { maxlength: 40 })]),
          UI.row(t('Icon'), t('An emoji or a symbol'), [input(b.icon, (v) => set((x) => { x.icon = v; }), { maxlength: 16, class: 'deck-icon-input' })]),
          UI.row(t('Color'), '', [el('div', { class: 'deck-colors' }, M.COLORS.map((c) => {
            const sw = el('button', { class: `deck-color${c === b.color ? ' on' : ''}`, attrs: { 'aria-label': c } });
            sw.style.background = c;
            sw.onclick = () => set((x) => { x.color = c; }, true);
            return sw;
          }))]),
          UI.row(t('Action'), '', [pick(M.KINDS.filter((k) => k === 'none' || k === a.k || can.includes(k)).map((k) => ({ value: k, label: t(KIND_LABEL[k]) })), a.k, (k) => set((x) => {
            x.action = { k, ...{ media: { what: 'playpause' }, bright: { what: 'up' }, sys: { what: 'lock' }, clip: { what: 'copy' }, page: { to: L.pages[0].id } }[k] };
          }, true))]),
        ];
        if (a.k === 'keys') rows.push(recorderRow(b));
        if (a.k === 'text') {
          const ta = el('textarea', { value: a.text || '', attrs: { rows: 3, maxlength: 4000 } });
          ta.oninput = () => set((x) => { x.action = { k: 'text', text: ta.value }; });
          rows.push(UI.row(t('Text'), t('Typed on this computer as it is'), [ta]));
        }
        if (a.k === 'media') rows.push(UI.row(t('Media'), '', [pick(Object.keys(M.MEDIA).map((w) => ({ value: w, label: t(MEDIA_LABEL[w]) })), a.what, (w) => set((x) => { x.action = { k: 'media', what: w }; }))]));
        if (a.k === 'bright') rows.push(UI.row(t('Brightness'), '', [pick([{ value: 'up', label: t('Brighter') }, { value: 'down', label: t('Dimmer') }], a.what, (w) => set((x) => { x.action = { k: 'bright', what: w }; }))]));
        if (a.k === 'sys') rows.push(UI.row(t('Lock or sleep'), '', [pick(M.SYS.map((w) => ({ value: w, label: t(SYS_LABEL[w]) })), a.what, (w) => set((x) => { x.action = { k: 'sys', what: w }; }))]));
        if (a.k === 'clip') rows.push(UI.row(t('Clipboard'), '', [pick(M.CLIP.map((w) => ({ value: w, label: t(CLIP_LABEL[w]) })), a.what, (w) => set((x) => { x.action = { k: 'clip', what: w }; }))]));
        if (a.k === 'page') rows.push(UI.row(t('Go to page'), '', [pick(L.pages.map((x) => ({ value: x.id, label: x.name })), a.to, (to) => set((x) => { x.action = { k: 'page', to }; }))]));
        if (a.k === 'url') {
          const u = input(a.url || '', () => {}, { placeholder: 'https://' });
          u.onchange = () => set((x) => { x.action = { k: 'url', url: u.value }; }, true);
          rows.push(UI.row(t('Website'), t('Opens in the default browser'), [u]));
        }
        if (a.k === 'app') rows.push(appRow(b));
        rows.push(UI.row(t('Try it'), t('Runs it on this computer now'), [
          UI.button(t('Try'), () => api.deckTry(sel().action), 'small'),
          UI.button(t('Delete button'), () => change(() => { page().buttons = page().buttons.filter((x) => x.id !== b.id); selId = ''; }), 'small destructive'),
        ]));
        inspector.replaceChildren(UI.card(b.label || t('Button'), rows));
      }

      // Shortcut: press it while Record is on (any keys, with or without modifiers).
      function recorderRow(b) {
        const show = el('code', { class: 'deck-combo', text: comboText(b.action.combo, mac) || t('None') });
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
          const combo = M.combo([...mods, e.code].join('+'));
          rec = false;
          change(() => { sel().action = { k: 'keys', combo }; });
        };
        btn.onblur = () => { if (rec) { rec = false; btn.textContent = t('Record'); btn.classList.remove('primary'); } };
        const typed = input(b.action.combo || '', () => {}, { placeholder: 'Mod+Shift+KeyS', class: 'deck-combo-input' });
        typed.onchange = () => change(() => { sel().action = { k: 'keys', combo: typed.value }; });
        return UI.row(t('Shortcut'), t('Record it, or type it: Mod is ⌘ on a Mac and Ctrl elsewhere'), [show, btn, typed]);
      }

      function appRow(b) {
        const s = UI.select([{ value: b.action.id || '', label: b.action.name || t('Loading apps…') }], (id) => {
          const a = (apps || []).find((x) => x.id === id);
          if (a) change(() => { sel().action = { k: 'app', id: a.id, name: a.name }; if (!sel().label || sel().label === t('Button')) sel().label = a.name; });
        });
        s.set(b.action.id || '');
        const fill = () => s.options([{ value: '', label: t('Choose an app') }, ...apps.map((a) => ({ value: a.id, label: a.name }))]);
        if (apps) fill();
        else Promise.resolve(api.deckApps()).then((list) => { apps = Array.isArray(list) ? list : []; fill(); s.set(sel() && sel().action.id || ''); });
        return UI.row(t('App'), '', [s.el]);
      }

      return (s) => {
        const d = s.deck;
        if (!d) return;
        can = d.can || [];
        where.textContent = d.surface && d.surface.length ? t('On {names}. Changes show there at once.', { names: d.surface.join(', ') }) : '';
        const incoming = JSON.stringify(d.layout);
        const editing = body.contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
        if (!L || (incoming !== sent && incoming !== JSON.stringify(L) && !editing && !saveTimer)) {
          L = M.normalize(d.layout);
          sent = incoming;
          drawBoard();
          drawInspector();
        }
        sizeCols.set(L.cols);
        sizeRows.set(L.rows);
      };
    },
  });
})();

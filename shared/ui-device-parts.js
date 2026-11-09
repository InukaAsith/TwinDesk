// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The pieces every device's Overview is made of (Mac, PC and Linux). Each kind of device has its
// own Overview page that puts them together:
//   shared/ui-device-pc.js       another computer
//   shared/ui-device-android.js  an Android phone
//   shared/ui-device-ios.js      an iPhone or iPad
// (TwinDesk Web devices: shared/ui-web.js.)
// The pieces: the page's setup, the hero (picture, name, link, battery, the actions, the facts),
// what plays there, ReZume's offer, and below: the notifications on the left, on the right the
// clipboard's recent items, the most used apps (a phone that says them) and a drop zone that sends
// files. A column with nothing in it gives the other the whole width; with nothing on, none of it
// shows. What the other side doesn't report (an older TwinDesk) is left out, not shown as off.
'use strict';

(function () {
  const t = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const glyph = (d) => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
    return svg;
  };
  const otpOf = (text) => (window.Otp ? window.Otp.otpOf(text) : '');
  // The PC and Linux say the session in s.link, the Mac in s.client.
  const linked = (s) => !!(s && ((s.link && s.link.state === 'connected') || s.client || (s.phone && s.phone.connected)));
  const viaOf = (s) => (UI.via ? UI.via(s) : s.client && s.client.transport === 'ble' ? t('Bluetooth') : t('Wi-Fi'));
  // Each action button with its icon (20×20 strokes, the colour of its text).
  const ICO = {
    show: 'M6.5 2.5h7a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z M9 15h2',
    ring: 'M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5h-12z M8.5 16.5a1.5 1.5 0 0 0 3 0',
    lock: 'M5 9h10v8H5z M7 9V6.5a3 3 0 0 1 6 0V9 M10 12v2',
    sleep: 'M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z',
    wifi: 'M2.5 7.5a11 11 0 0 1 15 0 M5 10.3a7.3 7.3 0 0 1 10 0 M7.6 13a3.5 3.5 0 0 1 4.8 0 M10 15.8v.1',
    hotspot: 'M10 10.5v.1 M7.3 13a3.8 3.8 0 0 1 0-5.2 M12.7 7.8a3.8 3.8 0 0 1 0 5.2 M4.8 15.4a7.3 7.3 0 0 1 0-10.2 M15.2 5.2a7.3 7.3 0 0 1 0 10.2',
    disconnect: 'M8.5 11.5l-1 1a3 3 0 0 1-4.2-4.2l2.2-2.2 M11.5 8.5l1-1a3 3 0 0 1 4.2 4.2l-2.2 2.2 M3 3l14 14',
  };
  // A button's words, its icon kept.
  const label = (b, text) => { const n = [...b.childNodes].find((x) => x.nodeType === 3); if (n) n.nodeValue = text; else b.append(text); };

  const P = {
    t, glyph, linked, viaOf,

    // The page's own setup: { h1, desc, row, doIt }. Device data is shown as it is (data-literal).
    setup(body, page) {
      page.classList.add('device-page');
      const h1 = page.querySelector('h1 span');
      const desc = page.querySelector('.page-head p');
      for (const node of [body, h1, desc]) node.setAttribute('data-literal', '');
      const row = (lbl, hint, controls = []) => UI.row(lbl, hint, controls, { literal: true });
      const doIt = (c) => (UI.api.deviceDo ? UI.api.deviceDo(c) : Promise.resolve());
      return { h1, desc, row, doIt };
    },

    // An action button with its icon: key one of ICO's.
    button(text, key, onclick) {
      const b = UI.button(text, onclick);
      b.prepend(glyph(ICO[key]));
      b.classList.add('ico');
      return b;
    },

    // Ring / Stop ringing, with its note under the buttons: { btn, note, update(ctl) }.
    ring(doIt) {
      let ringing = false;
      const note = UI.el('div', { class: 'hint dv-ring-note', text: '' });
      const paint = () => {
        label(btn, ringing ? t('Stop ringing') : t('Ring'));
        btn.classList.toggle('danger', ringing);
        note.textContent = ringing ? t('Rings at full volume, even on silent, until you stop it here or there.') : '';
        note.hidden = !ringing;
      };
      const btn = P.button(t('Ring'), 'ring', () => { ringing = !ringing; doIt({ do: ringing ? 'ring' : 'ringStop' }); paint(); });
      return {
        btn, note,
        update(ctl) {
          btn.hidden = !(ctl && ctl.can && ctl.can.ring);
          if (ctl && typeof ctl.ringing === 'boolean' && ctl.ringing !== ringing) ringing = ctl.ringing;
          paint();
        },
      };
    },

    // Use Wi-Fi Direct / Back to Bluetooth: { btn, update(s) }; shown on Bluetooth or while on it.
    wifi() {
      let on = false;
      const btn = P.button(t('Use Wi-Fi Direct'), 'wifi', () => UI.api.netWifi(!on));
      return {
        btn,
        update(s) {
          const n = s.net || {};
          on = (n.why || []).includes('user') || !!n.linked;
          label(btn, on ? t('Back to Bluetooth') : t('Use Wi-Fi Direct'));
          const ble = n.transport === 'ble' || !!(s.client && s.client.transport === 'ble'); // the Mac says it on s.client
          btn.hidden = !(on || ble);
          return { on, ble, n };
        },
      };
    },

    // The hero card: the picture, name, link line, battery, the actions given, and the facts.
    // Returns { el, pic, name, sub, facts, battery(level, charging), setFacts([[label, value]…]) }.
    hero(actions, note) {
      const { el } = UI;
      const pic = el('div', { class: 'device phone big' });
      const name = el('div', { class: 'hero-name' });
      const sub = el('div', { class: 'hero-status' });
      const batt = el('div', { class: 'dv-batt' }, [el('div', { class: 'dv-batt-fill' })]);
      const battText = el('span', { class: 'dv-batt-text' });
      const battRow = el('div', { class: 'dv-batt-row' }, [batt, battText]);
      const facts = el('dl', { class: 'dv-facts' });
      const card = el('div', { class: 'card dv-hero' }, [
        pic,
        el('div', { class: 'dv-hero-main' }, [name, sub, battRow, el('div', { class: 'dv-actions' }, actions), note || null]),
        facts,
      ]);
      return {
        el: card, pic, name, sub,
        battery(level, charging) {
          battRow.hidden = level == null;
          if (level == null) return;
          batt.firstChild.style.width = Math.max(2, Math.min(100, level)) + '%';
          batt.classList.toggle('low', level <= 20);
          battText.textContent = t('{level}%{charging}', { level, charging: charging ? ' · ' + t('Charging') : '' });
        },
        // [[label, value]…]: the ones with a value; dd: an element in place of a value.
        setFacts(list) {
          const out = [];
          for (const [k, v] of list) {
            if (!v) continue;
            out.push(el('dt', { text: k }), v instanceof Node ? v : el('dd', { text: v }));
          }
          facts.replaceChildren(...out);
          facts.hidden = !facts.childElementCount;
        },
      };
    },

    // A phone's picture: its wallpaper, else its colours.
    phonePic(pic, info) {
      pic.className = 'device big phone';
      if (UI.phoneWall) pic.style.setProperty('--phone-wall', UI.phoneWall);
      else if (info.colors && info.colors.length) pic.style.setProperty('--phone-wall', `linear-gradient(160deg, ${info.colors.join(', ')}${info.colors.length === 1 ? `, ${info.colors[0]}` : ''})`);
      else pic.style.removeProperty('--phone-wall');
    },

    // Which TwinDesk it runs (dev.state's app: shared/appinfo.js), red when older than this one.
    version(ctl) {
      const ac = ctl && ctl.appCheck;
      if (!ac) return null;
      const dd = UI.el('dd', { text: ac.version || t('Older') });
      dd.classList.toggle('dv-old', ac.older);
      dd.title = ac.older ? t('Older than this one. Update it there: some features need the same version on both') : '';
      return dd;
    },

    // What plays there (shared/ui-nowplaying.js): { el, update(s, ov) }.
    // The tiles' icons (20×20 strokes, white on each tile's colour).
    GLYPH: {
      show: 'M6.5 2.5h7a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z M9 15h2',
      screen: 'M3 4h14v9H3z M7 17h6 M10 13v4',
      ring: 'M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5h-12z M8.5 16.5a1.5 1.5 0 0 0 3 0',
      lock: 'M5 9h10v8H5z M7 9V6.5a3 3 0 0 1 6 0V9 M10 12v2',
      sleep: 'M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z',
      send: 'M3 5h5l1.5 2H17v9H3z M10 14.5v-5 M7.8 11.5 10 9.3l2.2 2.2',
      play: 'M6.5 4.5v11l9-5.5z',
      pause: 'M7 4.5v11 M13 4.5v11',
      next: 'M15.5 4.5v11 M4 4.5l8 5.5-8 5.5z',
      bluetooth: 'M6 6.5l8 7-4 3.5V3l4 3.5-8 7',
      dnd: 'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z M6.5 10h7',
      wifi: 'M2.5 7.5a11 11 0 0 1 15 0 M5 10.3a7.3 7.3 0 0 1 10 0 M7.6 13a3.5 3.5 0 0 1 4.8 0 M10 15.8v.1',
    },

    // A page as a tile, with its sidebar icon and colour (left out where there's no such page);
    // has: shown for this device now.
    // Every page in the sidebar for the device in session (Overview aside), as tiles: shortcuts to any of them.
    pageTiles(s) {
      return UI.tabs.filter((d) => UI.baseOf(d) !== 'overview' && !d.navHidden && !(d.hidden && d.hidden(s)))
        .sort((a, b) => (a.order ?? 50) - (b.order ?? 50)).map((d) => P.pageTile(d.id, s));
    },
    pageTile(id, s) {
      const def = UI.tabs.find((d) => d.id === id);
      return def ? { id: 'p.' + id, label: t(def.title), icon: UI.icon(def.icon), color: def.color, has: !(def.hidden && def.hidden(s)), run: () => UI.go(id) } : null;
    },

    // ---- tiles, the way Control Center has them (the phones' Overview has the same: Tiles.kt,
    // Tiles.swift) ----
    // One or two rows that scroll sideways; each tile small (one cell), wide (two across) or, with
    // two rows, large (two by two). Customize: add and remove them, size them, drag them (or ← →)
    // into place, one row or two. Kept in this window's storage under key, a view preference
    // of this computer's.
    //   key       where the layout is kept
    //   standard  {rows, items: [{id, s}]}: the layout until it's customized (and after Reset)
    // → {grid, editor, toggle(), editing(), render(defs)}; defs: [{id, label, icon: path | el,
    // color: a CSS gradient, has, on, state, title (its tooltip), run}], drawn again only when something in them changed.
    tiles({ key, standard, onDraw = () => {} }) {
      const { el } = UI;
      const store = 'twindesk.tiles.' + key;
      const load = () => {
        try {
          const o = JSON.parse(localStorage.getItem(store) || 'null');
          if (o && Array.isArray(o.items)) {
            const seen = new Set();
            return {
              rows: o.rows === 2 ? 2 : 1,
              items: o.items.filter((x) => x && typeof x.id === 'string' && !seen.has(x.id) && seen.add(x.id))
                .map((x) => ({ id: x.id, s: ['s', 'w', 'b'].includes(x.s) ? x.s : 's' })),
            };
          }
        } catch (_) { /* none kept, or storage closed */ }
        return JSON.parse(JSON.stringify(standard));
      };
      let layout = load();
      const save = () => { try { localStorage.setItem(store, JSON.stringify(layout)); } catch (_) { /* kept for this session */ } };
      let editing = false;
      let sel = null;
      let defs = [];
      let drawn = '';

      const grid = el('div', { class: 'dv-tiles' });
      const editor = el('div', { class: 'dv-tiles-edit' });
      editor.hidden = true;
      const rowsSeg = UI.segmented([{ value: 1, label: t('One row') }, { value: 2, label: t('Two rows') }], (v) => { layout.rows = v; save(); draw(); });
      const sizeSeg = UI.segmented([{ value: 's', label: t('Small') }, { value: 'w', label: t('Wide') }, { value: 'b', label: t('Large') }], (v) => {
        const it = layout.items.find((x) => x.id === sel);
        if (it) { it.s = v; save(); draw(); }
      });
      const selName = el('b', { class: 'dv-tiles-sel' });
      const moveBy = (d) => {
        const i = layout.items.findIndex((x) => x.id === sel);
        const j = i + d;
        if (i < 0 || j < 0 || j >= layout.items.length) return;
        layout.items.splice(j, 0, layout.items.splice(i, 1)[0]);
        save(); draw();
      };
      const earlier = UI.button('←', () => moveBy(-1), 'small');
      const later = UI.button('→', () => moveBy(1), 'small');
      earlier.title = t('Earlier'); later.title = t('Later');
      const selRow = el('div', { class: 'dv-tiles-row' }, [selName, earlier, later, el('span', { class: 'dv-tiles-gap' }), el('span', { class: 'hint', text: t('Size') }), sizeSeg.el]);
      const selHint = el('div', { class: 'hint', text: t('Click a tile to size it, drag it into place, or − to remove it.') });
      const addList = el('div', { class: 'dv-tiles-add' });
      const addHead = el('div', { class: 'hint', text: t('Add') });
      const reset = UI.button(t('Reset'), () => { try { localStorage.removeItem(store); } catch (_) { /* */ } layout = JSON.parse(JSON.stringify(standard)); sel = null; draw(); }, 'small');
      editor.append(
        el('div', { class: 'dv-tiles-row' }, [el('span', { text: t('Rows') }), rowsSeg.el, el('span', { class: 'dv-tiles-gap' }), reset]),
        selRow, selHint, addHead, addList,
      );

      // Column by column, each tile in the first place it fits, in order; a large one with one row is wide.
      const pack = (items, rows) => {
        const taken = new Set();
        return items.map((it) => {
          const w = it.s === 's' ? 1 : 2;
          const h = it.s === 'b' && rows === 2 ? 2 : 1;
          for (let col = 0; ; col++) {
            for (let r = 0; r + h <= rows; r++) {
              let free = true;
              for (let dx = 0; dx < w && free; dx++) for (let dy = 0; dy < h; dy++) if (taken.has(`${col + dx},${r + dy}`)) { free = false; break; }
              if (!free) continue;
              for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) taken.add(`${col + dx},${r + dy}`);
              return { it, col, row: r, w, h };
            }
          }
        });
      };

      const badge = (d) => {
        const b = el('span', { class: 'dv-tile-ico' });
        b.style.background = d.color || 'linear-gradient(#8e8e93, #636366)';
        b.append(typeof d.icon === 'string' ? glyph(d.icon) : d.icon ? d.icon.cloneNode(true) : glyph(''));
        return b;
      };

      let dragId = null;
      let lastCols = 1;
      function draw() {
        try { drawTiles(); } finally { onDraw(); }
      }
      function drawTiles() {
        const byId = new Map(defs.map((d) => [d.id, d]));
        const shown = layout.items.filter((x) => byId.has(x.id) && (editing || byId.get(x.id).has !== false));
        const placed = pack(shown, layout.rows);
        const cols = placed.reduce((m, p) => Math.max(m, p.col + p.w), 0);
        grid.classList.toggle('editing', editing);
        grid.style.setProperty('--rows', String(layout.rows));
        grid.style.setProperty('--cols', String(Math.max(cols, 1)));
        lastCols = Math.max(cols, 1);
        grid.replaceChildren(...(placed.length ? placed.map(({ it, col, row, w, h }) => {
          const d = byId.get(it.id);
          const size = w === 1 ? 'small' : h === 1 ? 'wide' : 'large';
          const b = el('button', { class: `dv-tile ${size}${d.on ? ' on' : ''}${sel === d.id ? ' sel' : ''}${d.has === false ? ' missing' : ''}`, attrs: { 'aria-pressed': d.on ? 'true' : 'false', 'aria-label': d.label } },
            [badge(d), el('span', { class: 'dv-tile-text' }, [el('span', { class: 'dv-tile-label', text: d.label }), d.state ? el('span', { class: 'dv-tile-state', text: d.state }) : null])]);
          b.style.gridColumn = `${col + 1} / span ${w}`;
          b.style.gridRow = `${row + 1} / span ${h}`;
          b.title = d.title || (d.state && size === 'small' ? d.state : '');
          b.onclick = () => {
            if (editing) { sel = sel === d.id ? null : d.id; draw(); } else if (d.has !== false) d.run();
          };
          if (editing) {
            const x = el('span', { class: 'dv-tile-x', attrs: { role: 'button', 'aria-label': t('Remove {name}', { name: d.label }) }, text: '−' });
            // on press: the wiggle could move it out from under the pointer before the click
            x.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); layout.items = layout.items.filter((y) => y.id !== d.id); if (sel === d.id) sel = null; save(); draw(); };
            x.onclick = (e) => e.stopPropagation();
            x.draggable = false;
            b.append(x);
            // Dragged onto another: in its place.
            b.draggable = true;
            b.ondragstart = (e) => { dragId = d.id; e.dataTransfer.effectAllowed = 'move'; b.classList.add('dragging'); };
            b.ondragend = () => { dragId = null; b.classList.remove('dragging'); };
            b.ondragover = (e) => { if (dragId && dragId !== d.id) { e.preventDefault(); b.classList.add('drop'); } };
            b.ondragleave = () => b.classList.remove('drop');
            b.ondrop = (e) => {
              e.preventDefault();
              const from = layout.items.findIndex((y) => y.id === dragId);
              const to = layout.items.findIndex((y) => y.id === d.id);
              if (from < 0 || to < 0) return;
              layout.items.splice(to, 0, layout.items.splice(from, 1)[0]);
              save(); draw();
            };
          }
          return b;
        }) : [el('div', { class: 'hint dv-tiles-empty', text: editing ? t('Add tiles below.') : t('Nothing here. Customize to add some.') })]));

        // the editor
        editor.hidden = !editing;
        if (!editing) return;
        rowsSeg.set(layout.rows);
        const it = layout.items.find((x) => x.id === sel);
        const d = it && byId.get(it.id);
        selRow.hidden = !d;
        selHint.hidden = !!d;
        if (d) {
          selName.textContent = d.label;
          const i = layout.items.indexOf(it);
          earlier.disabled = i <= 0;
          later.disabled = i >= layout.items.length - 1;
          // Large is two by two: with one row, small or wide.
          sizeSeg.el.querySelectorAll('button')[2].hidden = layout.rows === 1;
          sizeSeg.set(it.s === 'b' && layout.rows === 1 ? 'w' : it.s);
        }
        const rest = defs.filter((x) => x.has !== false && !layout.items.some((y) => y.id === x.id));
        addHead.hidden = !rest.length;
        addList.replaceChildren(...rest.map((x) => {
          const c = el('button', { class: 'dv-tiles-chip' }, [badge(x), el('span', { text: x.label }), el('span', { class: 'dv-tiles-plus', text: '+' })]);
          c.onclick = () => { layout.items.push({ id: x.id, s: 's' }); sel = x.id; save(); draw(); };
          return c;
        }));
      }

      return {
        grid, editor,
        editing: () => editing,
        cols: () => lastCols, // the columns drawn, for the width they need
        toggle() { editing = !editing; sel = null; drawn = ''; draw(); return editing; },
        render(next) {
          defs = next;
          const k = JSON.stringify([next.map((d) => [d.id, d.label, d.has !== false, !!d.on, d.state || '', d.title || '']), editing]);
          if (k === drawn) return;
          drawn = k;
          draw();
        },
      };
    },

    // A card whose tiles are customized in place: Customize (Done while editing) in its header.
    // → {el, render(defs)}; more: what goes under the tiles (the Quick actions' volume row).
    // → {el, render(defs), need(): the width its tiles take at full size, editing(), onDraw}.
    tilesCard(title, { key, standard, more = [] }) {
      const out = { onDraw: () => {} };
      const tiles = P.tiles({ key, standard, onDraw: () => out.onDraw() });
      const btn = UI.button(t('Customize'), () => { btn.textContent = tiles.toggle() ? t('Done') : t('Customize'); }, 'small link');
      const card = UI.card(title, [tiles.grid, tiles.editor, ...more], { actions: [btn] });
      return Object.assign(out, {
        el: card,
        render: (defs) => tiles.render(defs),
        editing: () => tiles.editing(),
        // a row under them (volume) wraps, but wants ~400 across all the same
        need: () => Math.max(tiles.cols() * 100 + (tiles.cols() - 1) * 8 + 24, more.some((m) => !m.hidden) ? 400 : 0),
      });
    },

    // Two tile cards side by side when the page is wide enough for both at full size, else one
    // under the other (and while either is being customized: its editor gets the width).
    // → {el, update()}; update() after the cards are shown or hidden.
    tilePair(a, b) {
      const el = UI.el('div', { class: 'dv-pair' }, [a.el, b.el]);
      const update = () => {
        const both = !a.el.hidden && !b.el.hidden;
        const na = a.need(), nb = b.need();
        const two = both && el.clientWidth >= na + nb + 14 && !a.editing() && !b.editing();
        el.classList.toggle('two', two);
        // each as wide as its tiles want, the room left shared alike: a card of few tiles isn't stretched
        el.style.gridTemplateColumns = two ? `minmax(0, ${na}fr) minmax(0, ${nb}fr)` : '';
      };
      a.onDraw = update;
      b.onDraw = update;
      new ResizeObserver(update).observe(el);
      return { el, update };
    },

    media() {
      const media = UI.nowPlaying ? UI.nowPlaying() : null;
      const card = UI.el('div', { class: 'card dv-media' }, media ? [media.el] : []);
      return {
        el: card,
        update(s, ov) {
          if (media) media.update(s);
          card.hidden = !media || media.el.hidden || (s.audio || {}).phoneMedia === false || ov.media === false;
        },
      };
    },

    // Music an iPhone, iPad or Mac plays here (AirPlay): { el, update(s) } or null.
    airplay() {
      return UI.airplayPlaying ? UI.airplayPlaying() : null;
    },

    // ReZume's offer from the device: { el, update(s, devName) } or null.
    rezume() {
      const rz = UI.rezumeCard ? UI.rezumeCard() : null;
      if (!rz) return null;
      const title = rz.el.querySelector('[data-peer]');
      return {
        el: rz.el,
        update(s, devName) {
          if (title) title.textContent = t('Continue from {name}', { name: devName });
          rz.update(s, true);
        },
      };
    },

    // Below the rest: notifications on the left; clipboard, most used apps (withApps) and send
    // files on the right. Returns { el, update(s, { phone, devName, top, ready }) }.
    lower(row, { withApps = false } = {}) {
      const { el, api } = UI;
      const notifList = el('div');
      const notifCard = UI.card(t('Latest notifications'), [notifList], { actions: [UI.button(t('See all'), () => UI.go('notifications'), 'small link')] });
      const clipList = el('div', { class: 'history' });
      const clipCard = UI.card(t('Clipboard'), [clipList], { actions: [UI.button(t('See all'), () => UI.go('clipboard'), 'small link')] });
      const appsGrid = el('div', { class: 'app-grid dv-apps' });
      const appsCard = withApps ? UI.card(t('Most used'), [appsGrid], { actions: [UI.button(t('All apps'), () => UI.go('papps'), 'small link')] }) : null;
      const dropHint = el('div', { class: 'hint' });
      const zone = el('div', { class: 'dropzone dv-drop' }, [el('div', {}, [el('div', { class: 'big', text: t('Drop files here') }), dropHint])]);
      const dropCard = UI.card(t('Send files'), [zone], { actions: [UI.button(t('Choose…'), () => api.chooseSendFiles(), 'small link')] });
      let canSend = false;
      zone.ondragover = (e) => { e.preventDefault(); if (canSend) zone.classList.add('over'); };
      zone.ondragleave = () => zone.classList.remove('over');
      zone.ondrop = (e) => {
        e.preventDefault();
        zone.classList.remove('over');
        // As an array: a FileList reaches the preload as a plain object, which can't be iterated.
        if (canSend) api.sendFiles(api.pathsOf([...e.dataTransfer.files]));
      };
      const cards = [notifCard, clipCard, ...(appsCard ? [appsCard] : []), dropCard];
      const left = el('div', { class: 'dv-col' }, [notifCard]);
      const right = el('div', { class: 'dv-col' }, cards.slice(1));
      const lower = el('div', { class: 'dv-two' }, [left, right]);
      // The cards that are on fill the two columns with no gaps: notifications first on the left, then each
      // card in whichever column is shorter (a tie: the left). One card, or a narrow window: one column.
      // Nodes move only when a card's column changes (moving one mid-drag would drop the drag).
      const narrow = window.matchMedia('(max-width: 860px)');
      const flow = () => {
        const shown = cards.filter((c) => !c.hidden);
        lower.hidden = !shown.length;
        if (lower.hidden) return;
        left.hidden = right.hidden = false; // a card in a hidden column measures 0
        const one = shown.length < 2 || narrow.matches;
        let hl = 0;
        let hr = 0;
        const plan = shown.map((c) => {
          const col = one || hl <= hr ? left : right;
          if (col === left) hl += c.offsetHeight; else hr += c.offsetHeight; // the columns are the same width
          return [c, col];
        });
        for (const col of [left, right]) {
          const want = plan.filter(([, x]) => x === col).map(([c]) => c);
          const have = [...col.children].filter((c) => !c.hidden);
          if (want.length !== have.length || want.some((c, i) => c !== have[i])) col.append(...want);
        }
        left.hidden = !plan.some(([, x]) => x === left);
        right.hidden = !plan.some(([, x]) => x === right);
        lower.classList.toggle('one', left.hidden || right.hidden);
      };
      narrow.addEventListener('change', flow);

      let notifKey = '';
      let clipKey = '';
      let appsKey = '';
      return {
        el: lower,
        update(s, { phone, devName, top = [], ready = false }) {
          const ov = (s.ui && s.ui.overview) || {}; // General › Overview: what's left out

          // latest notifications: while Notifications is on
          const nf = s.notifs || {};
          const history = (nf.history || []).slice(0, 6);
          notifCard.hidden = !nf.receive || ov.notifs === false;
          const nk = JSON.stringify([history.map((h) => [h.id, h.at, h.actions]), Object.keys(nf.historyIcons || {}).length, devName, phone]);
          if (nk !== notifKey) {
            notifKey = nk;
            notifList.replaceChildren(...(history.length ? history.map((item) => {
              const text = [item.subtitle, item.body].filter(Boolean).join(' · ');
              const code = otpOf([item.title, item.body].join(' '));
              const copy = code ? UI.button(t('Copy {code}', { code }), () => api.copyText(code), 'small') : null;
              // A phone's: its own buttons (Mark as read…), and × dismisses it there too (shared/notifacts.js).
              const acts = phone && api.notifReply ? (item.actions || []).map((a, i) => UI.button(a, () => api.notifReply({ id: item.id, act: i }), 'small')) : [];
              const x = phone && api.notifReply ? UI.button('×', () => api.notifReply({ id: item.id, dismiss: true }), 'small') : null;
              if (x) { x.title = t('Dismiss'); x.setAttribute('aria-label', t('Dismiss')); }
              const r = row([item.appName || item.app, item.title].filter(Boolean).join(' · '), (text || t('Notification')) + ' · ' + UI.ago(item.at), [copy, ...acts, x]);
              // Its buttons on a line of their own under the words, which keep the row's width.
              if (copy || acts.length || x) r.classList.add('dv-notif');
              const icon = (nf.historyIcons || {})[item.app];
              if (icon) {
                r.querySelector('.text').prepend(el('img', { class: 'dv-nicon', src: icon, alt: '' }));
                r.classList.add('with-ico');
              }
              return r;
            }) : [row(t('Nothing yet'), t('New notifications from {name} show here', { name: devName }))]));
          }

          // the clipboard's recent items: while Clipboard is on
          const cb = s.clipboard || {};
          const recent = (cb.history || []).slice(0, 4);
          clipCard.hidden = !cb.enabled || ov.clipboard === false;
          const ck = JSON.stringify([recent.map((h) => [h.at, h.dir, !!(h.image && h.image.copy)]), cb.historySize, devName, Math.floor(Date.now() / 15000)]);
          if (!clipCard.hidden && ck !== clipKey) {
            clipKey = ck;
            clipList.replaceChildren(...(recent.length ? recent.map((h, i) => el('div', { class: 'hist-item' }, [
              el('span', { class: 'hist-dir ' + h.dir, title: t(h.dir === 'out' ? 'Sent to {name}' : 'From {name}', { name: devName }) }, [UI.icon(h.dir === 'out' ? 'up' : 'down')]),
              h.image && h.image.thumb ? el('img', { class: 'hist-thumb', src: h.image.thumb, alt: '' }) : null,
              el('div', { class: 'hist-text' }, [
                el('div', { class: 'hist-preview', text: h.image ? (h.image.shot ? t('Screenshot') : t('Picture')) + ' · ' + h.image.w + ' × ' + h.image.h : String(h.text || '').replace(/\s+/g, ' ').trim() || t('(whitespace)') }),
                el('div', { class: 'hint', text: t(h.dir === 'out' ? 'To {name}' : 'From {name}', { name: devName }) + ' · ' + UI.ago(h.at) }),
              ]),
              !h.image || h.image.copy ? UI.button(t('Copy'), () => api.copyHistory(i), 'small') : null,
            ])) : [row(cb.historySize === 0 ? t('Recent items are off') : t('Nothing yet'), cb.historySize === 0 ? t('Turn them on in Clipboard') : t('What’s copied on either side shows here'))]));
          }

          // send files: while sending files is on (the Mac has no switch for it: always)
          const fl = s.files || {};
          canSend = fl.dropToMac !== false;
          dropCard.hidden = !canSend || ov.files === false;
          dropHint.textContent = t('They go to {name}’s Downloads', { name: devName });

          // most used apps: the phone's own order (Usage access), else what was opened from here
          if (appsCard) {
            const apps = (UI.phoneAssets && UI.phoneAssets.apps) || [];
            const list = top.map((id) => apps.find((a) => a.id === id)).filter(Boolean).slice(0, 8);
            appsCard.hidden = !list.length || ov.apps === false;
            const ak = JSON.stringify([list.map((a) => a.id), ready]);
            if (ak !== appsKey) {
              appsKey = ak;
              appsGrid.replaceChildren(...list.map((a) => {
                const b = el('button', { class: 'app-tile', title: t('Open {app}', { app: a.name }), disabled: !ready }, [UI.appIcon(a.icon), el('span', { text: a.name })]);
                b.onclick = () => api.phoneOpenApp({ id: a.id, name: a.name });
                return b;
              }));
            }
          }
          flow();
        },
      };
    },
  };

  UI.deviceParts = P;
})();

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Control window: a tiny UI kit (window.UI) and the shell (sidebar, tabs, pairing banner).
// Tabs live in ui-*.js and call UI.tab({...}); ui-start.js boots the window.
// Controls are built once per tab; render(state) only updates values, so a state push never
// interrupts a drag, an open menu or keyboard focus.
'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  overview: 'M3 9.5 10 4l7 5.5V17H3z M8 17v-4h4v4',
  display: 'M3 4h14v9H3z M7 17h6 M10 13v4',
  receive: 'M3 4h14v9H3z M7 17h6 M10 13v4 M10 6v4.5 M7.8 8.5 10 10.7l2.2-2.2',
  cursor: 'M5 3l10 6-4.5 1.2L8.5 15z',
  keyboard: 'M2.5 6h15v8h-15z M5.5 9h1 M8.5 9h1 M11.5 9h1 M14.5 9h0 M6.5 11.5h7',
  clipboard: 'M6 4h8v13H6z M8 3h4v2.5H8z M8 9h4 M8 12h4',
  files: 'M3 5h5l1.5 2H17v9H3z',
  mount: 'M3 12h14v4H3z M14 14h.5 M10 3v6 M7 6l3 3 3-3',
  terminal: 'M3 4h14v12H3z M6 8l2.5 2L6 12 M10 12h4',
  audio: 'M4 8h3l4-3v10l-4-3H4z M14 7.5c1 .8 1 4.2 0 5 M16 5.5c2.2 1.8 2.2 7.2 0 9',
  apps: 'M4 4h5v5H4z M11 4h5v5h-5z M4 11h5v5H4z M11 11h5v5h-5z',
  general: 'M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M10 2.5v2 M10 15.5v2 M2.5 10h2 M15.5 10h2 M4.7 4.7l1.4 1.4 M13.9 13.9l1.4 1.4 M4.7 15.3l1.4-1.4 M13.9 6.1l1.4-1.4',
  about: 'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z M10 9v5 M10 6.2v.1',
  bell: 'M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5h-12z M8.5 16.5a1.5 1.5 0 0 0 3 0',
  pin: 'M10 4v8 M6 8h8 M4 16h12',
  up: 'M10 16V4 M5 9l5-5 5 5',
  down: 'M10 4v12 M5 11l5 5 5-5',
  phone: 'M6.5 2.5h7a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z M9 15h2',
  call: 'M6 3h2.5l1.2 3.2-1.7 1.3a9 9 0 0 0 4.5 4.5l1.3-1.7 3.2 1.2V16a1 1 0 0 1-1 1A13 13 0 0 1 3 4a1 1 0 0 1 1-1z',
  message: 'M3 4.5h14v9H8.5L5 16.5v-3H3z',
  photo: 'M3 4.5h14v11H3z M3 13l4-4 3.5 3.5 2-2L17 14.5 M12.5 7.5h.1',
  doc: 'M5 2.5h6.5L15 6v11.5H5z M11.5 2.5V6H15',
  folder: 'M2.5 5h5.5l1.5 2h8v9.5h-15z',
  camera: 'M2.5 6h10v8h-10z M12.5 8.5l5-2.5v8l-5-2.5', // a video camera: Camera
  rezume: 'M2 4.5h8v6H2z M1 12.5h10 M13.5 6.5h4.5v10h-4.5z M15.2 14.5h1.1 M3.5 16h6 M8 14.4l1.6 1.6L8 17.6', // a computer and a phone, something going across: ReZume
  remote: 'M7 2.5h6v15H7z M10 5.2v.1 M8.6 8.5h2.8 M8.6 11h2.8 M8.6 13.5h2.8', // a remote control: Remote
  globe: 'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z M2.5 10h15 M10 2.5c-2.2 2.3-2.2 12.7 0 15 M10 2.5c2.2 2.3 2.2 12.7 0 15', // Sharing
  link: 'M8.5 11.5a3.2 3.2 0 0 0 4.5 0l2.5-2.5a3.2 3.2 0 0 0-4.5-4.5l-.8.8 M11.5 8.5a3.2 3.2 0 0 0-4.5 0L4.5 11a3.2 3.2 0 0 0 4.5 4.5l.8-.8', // two chain links: Connection
  multi: 'M2 5h9v6.5H2z M5 14h3 M6.5 11.5V14 M13 4h5v12h-5z M15 13.5h1', // a computer and a phone: Multi-device
};

const UI = {
  api: window.macshare,
  P: window.MacShareProtocol,
  tabs: [],
  state: null,

  el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'attrs') for (const [a, av] of Object.entries(v)) e.setAttribute(a, av);
      else e[k] = v;
    }
    for (const c of [].concat(children)) if (c != null && c !== false) e.append(c);
    return e;
  },

  icon(name, cls = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    if (cls) svg.setAttribute('class', cls);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name] || '');
    svg.append(path);
    return svg;
  },

  // ---- controls: each returns { el, set(value), ... } ----
  switch(onChange, { disabled = false, label = '' } = {}) {
    const el = UI.el('input', { type: 'checkbox', class: 'switch', disabled, attrs: { role: 'switch', 'aria-label': label } });
    el.onchange = () => onChange(el.checked);
    return { el, set: (v) => { el.checked = !!v; }, disable: (d) => { el.disabled = !!d; } };
  },

  segmented(options, onChange) {
    const el = UI.el('div', { class: 'seg', attrs: { role: 'radiogroup' } });
    const btns = options.map((o) => {
      const b = UI.el('button', { text: o.label, title: o.title || '', attrs: { role: 'radio' } });
      b.onclick = () => onChange(o.value);
      el.append(b);
      return [o.value, b];
    });
    return {
      el,
      set(v) {
        for (const [val, b] of btns) {
          b.classList.toggle('on', val === v);
          b.setAttribute('aria-checked', String(val === v));
        }
      },
      disable: (d) => { for (const [, b] of btns) b.disabled = !!d; },
    };
  },

  select(options, onChange) {
    const el = UI.el('select');
    let key = '';
    const fill = (opts) => {
      const k = JSON.stringify(opts);
      if (k === key || document.activeElement === el) return; // unchanged, or the user is in it
      key = k;
      const v = el.value;
      el.replaceChildren(...opts.map((o) => UI.el('option', { value: String(o.value), text: o.label })));
      if (v) el.value = v;
    };
    fill(options);
    el.onchange = () => onChange(el.value);
    return {
      el,
      options: fill,
      set(v) {
        if (document.activeElement === el) return;
        const s = String(v);
        if (![...el.options].some((o) => o.value === s)) el.append(UI.el('option', { value: s, text: s }));
        el.value = s;
      },
    };
  },

  slider({ min, max, step, format = (v) => v }, onChange) {
    const input = UI.el('input', { type: 'range', min, max, step });
    const out = UI.el('output');
    let dragging = false;
    input.onpointerdown = () => { dragging = true; };
    input.oninput = () => { out.textContent = format(Number(input.value)); };
    input.onchange = () => { dragging = false; onChange(Number(input.value)); };
    return {
      el: UI.el('div', { class: 'slider' }, [input, out]),
      set(v) {
        if (dragging) return;
        input.value = v;
        out.textContent = format(Number(v));
      },
    };
  },

  button(label, onClick, cls = '') {
    const b = UI.el('button', { class: `btn ${cls}`.trim(), text: label });
    b.onclick = onClick;
    return b;
  },

  // A row: label (+ hint) on the left, controls on the right. Returns the row with .hint/.label.
  // Labels and hints may name the computers: {me} (this computer's name), {name} / {Name} (the
  // other one's, or "the other computer"). UI.names fills them in again on every render.
  row(label, hint, controls = [], { onClick, literal = false, literalHint = literal } = {}) {
    const fill = (text) => literal ? text || '' : UI.fill(text);
    const lab = UI.el('span', { class: 'label', text: fill(label) });
    if (!literal && String(label).includes('{')) lab.dataset.peer = label;
    const hintEl = UI.el('span', { class: 'hint', text: literalHint ? hint || '' : UI.fill(hint || '') });
    if (!literalHint && String(hint || '').includes('{')) hintEl.dataset.peer = hint;
    if (!hint) hintEl.hidden = true;
    const row = UI.el('div', { class: 'row' }, [
      UI.el('div', { class: 'text' }, [lab, hintEl]),
      UI.el('div', { class: 'controls' }, [].concat(controls).map((c) => (c && c.el) || c)),
    ]);
    if (literal) row.dataset.literal = '';
    if (literalHint) hintEl.dataset.literal = '';
    row.label = lab;
    row.hint = hintEl;
    row.setHint = (t) => {
      if (!literalHint && String(t || '').includes('{')) hintEl.dataset.peer = t;
      else delete hintEl.dataset.peer;
      hintEl.textContent = literalHint ? t || '' : UI.fill(t || '');
      hintEl.hidden = !t;
    };
    if (onClick) {
      row.classList.add('clickable');
      row.onclick = (e) => { if (!e.target.closest('input,button,select')) onClick(); };
    }
    return row;
  },

  card(title, rows, { actions, cls = '' } = {}) {
    const wrap = UI.el('div', { class: 'card-wrap' });
    const tEl = title ? UI.el('span', { text: UI.fill(title) }) : null;
    if (title && title.includes('{')) tEl.dataset.peer = title;
    if (title) wrap.append(UI.el('div', { class: 'card-title' }, [tEl, actions ? UI.el('span', { class: 'actions' }, actions) : null]));
    const card = UI.el('div', { class: `card ${cls}`.trim() }, rows);
    wrap.append(card);
    wrap.card = card;
    return wrap;
  },

  codecImpl(name, hw) {
    return I18n.t(hw ? 'Hardware' : 'Software') + (name ? ' (' + name + ')' : '');
  },


  monitorLabel(value) {
    const raw = String(value || '');
    const main = raw.endsWith(' (main)');
    const label = main ? raw.slice(0, -7) : raw;
    const parts = /^(.*?)(, \d+ × \d+)?$/.exec(label);
    const name = parts[1];
    const monitor = /^(Monitor|Display) (\d+)$/.exec(name);
    const text = (name === 'Built-in screen' || name === 'Built-in display' ? I18n.t(name)
      : monitor ? I18n.t(monitor[1] + ' {number}', { number: monitor[2] }) : name) + (parts[2] || '');
    return main ? I18n.t('{display} (main)', { display: text }) : text;
  },


  // Who the other computer is: the session's peer, else the most recent
  // pairing. Mac ↔ PC keeps "Mac" / "PC"; two Macs are "Mac1" (this one) / "Mac2".
  peer(s) {
    const c = s && s.client;
    let os = c && c.os, name = c && c.name;
    if (!os && s) {
      const all = [...(s.paired || []), ...((s.guest && s.guest.hosts) || [])].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      if (all[0]) ({ os, name } = all[0]);
    }
    os = os || 'win';
    const same = os === 'mac';
    const kind = os === 'linux' ? 'Linux' : same ? 'Mac' : os === 'android' ? I18n.t('Phone') : 'PC';
    // Computers are called by their names everywhere — this one by its own name, the
    // other by its name (or "the other computer" before anything was paired).
    const me = (s && s.macName) || I18n.t('This Mac');
    name = name || I18n.t('the other computer');
    const Name = name.charAt(0).toUpperCase() + name.slice(1);
    return {
      os, same, kind, me, name, Name, phone: os === 'android',
      there: name, here: me, meName: me, // older templates
      out: `${me} → ${name}`,
      in: `${name} → ${me}`,
      thereScreen: I18n.t('{name}’s screen', { name }),
    };
  },

  // Playback of shared screens (both directions, the same on both computers via pair.sync):
  // one row used by Share and Receive. Returns the row with .render(state).
  paceRow() {
    const seg = UI.segmented([
      { value: 'fast', label: I18n.t('Fastest') },
      { value: 'smooth', label: I18n.t('Smooth') },
      { value: 'steady', label: I18n.t('Steady') },
    ], (v) => UI.api.setSharingOpts({ pace: v }));
    const row = UI.row(I18n.t('Playback'), '', [seg]);
    row.render = (s) => {
      const pace = (s.sharing && s.sharing.pace) || 'fast';
      seg.set(pace);
      row.setHint(pace === 'steady' ? I18n.t('The steadiest motion, paced as a web browser plays it, a few frames later. The same on {name}')
        : pace === 'smooth' ? I18n.t('Even motion, about one frame later. The same on {name}')
          : I18n.t('Each frame the moment it arrives. The same on {name}'));
    };
    return row;
  },

  // The encoder this computer shares its screen with (shared/screencodec.js): set(v) saves it, for the
  // next share. Returns the row with .render(value).
  codecRow(set) {
    const sel = UI.select([
      { value: 'h264', label: 'H.264' },
      { value: 'h265', label: 'H.265' },
    ], (v) => set(v));
    const row = UI.row(I18n.t('Codec'), '', [sel]);
    row.render = (v) => {
      v = v === 'h265' ? v : 'h264';
      sel.set(v);
      row.setHint(v === 'h265' ? I18n.t('H.265 only: {name} must decode it too, else nothing shows. From the next share')
          : I18n.t('Works with every computer and phone'));
    };
    return row;
  },

  // A template with {me}, {name}, {Name}, … filled from the current state.
  fill(t) {
    if (!t || !String(t).includes('{')) return t || '';
    const p = UI.peer(UI.state);
    return String(t).replace(/\{(\w+)\}/g, (m, k) => (k in p ? p[k] : m));
  },

  // A direction card for the symmetric layout. dir: 'm2w' | 'w2m'
  // (m2w = from this Mac). The names follow the peer (UI.peer) on every render.
  // The head is a route — device icon + real name, a line with an arrowhead, the
  // other device — so which way things go is clear without reading.
  dir(dir, rows, { role = '', soon = '' } = {}) {
    const node = (me) => {
      const ico = UI.el('span', { class: `os-ico ${me ? 'mac' : 'pc'}` });
      if (!me) ico.dataset.os = 'there';
      const nm = UI.el('span', { class: 'nm' });
      nm.dataset.side = me ? 'meName' : 'name';
      return UI.el('span', { class: `node${me ? ' here' : ''}` }, [ico, nm]);
    };
    const from = dir === 'm2w';
    const head = UI.el('div', { class: 'dir-head' }, [
      UI.el('span', { class: 'route', attrs: { role: 'img' } }, [node(from), UI.el('span', { class: 'flow' }), node(!from)]),
      soon || role ? UI.el('span', { class: 'dir-role', text: soon ? I18n.t('Coming in phase {phase}', { phase: soon }) : I18n.t(role) }) : null,
    ]);
    const card = UI.el('div', { class: `card dir-card${soon ? ' soon-card' : ''}` }, [head, ...rows]);
    UI.names(UI.state);
    return card;
  },

  // Fill every peer-dependent name: [data-side] chips and [data-peer] text templates.
  names(s) {
    const p = UI.peer(s);
    for (const e of document.querySelectorAll('[data-side]')) e.textContent = p[e.dataset.side];
    for (const e of document.querySelectorAll('[data-os]')) e.className = `os-ico ${UI.osClass(p.os)}`;
    for (const e of document.querySelectorAll('.route')) e.setAttribute('aria-label', I18n.t('From {from} to {to}', { from: e.firstChild.textContent, to: e.lastChild.textContent }));
    for (const e of document.querySelectorAll('[data-peer]')) {
      if (e.closest('[data-literal]')) continue;
      e.textContent = e.dataset.peer.replace(/\{(\w+)\}/g, (m, k) => (k in p ? p[k] : m));
    }
    return p;
  },

  isPhone: (s) => !!(s && s.client && s.client.os === 'android'),

  // A small device glyph for lists: 'mac' | 'win' | 'linux' | 'android'.
  osClass: (os) => (os === 'mac' ? 'mac' : os === 'android' ? 'phone' : 'pc'),
  // An app's icon in a grid: its own, else (none, or it doesn't load) TwinDesk's, light or dark as the appearance.
  appIcon(src) {
    const fallback = matchMedia('(prefers-color-scheme: dark)').matches ? 'assets/sidebar-icon@2x.png' : 'assets/sidebar-icon-light@2x.png';
    const img = UI.el('img', { src: src || fallback, alt: '' });
    img.onerror = () => { img.onerror = null; img.src = fallback; };
    return img;
  },
  osIcon(os) {
    return UI.el('span', { class: `os-ico ${UI.osClass(os)}`, attrs: { 'aria-label': os === 'mac' ? 'Mac' : os === 'linux' ? 'Linux' : os === 'android' ? 'Phone' : 'PC' } });
  },

  // Two equal direction cards side by side (stacked when narrow), always Mac → PC first.
  pair(m2w, w2m) {
    return UI.el('div', { class: 'pair' }, [m2w, w2m]);
  },

  note(kind, text, { literal = false } = {}) {
    const fill = (value) => literal ? value || '' : UI.fill(value);
    const n = UI.el('div', { class: `note ${kind}`, text: fill(text) });
    if (literal) n.dataset.literal = '';
    n.set = (t) => { n.textContent = fill(t || ''); n.hidden = !t; };
    return n;
  },


  // "Control+Alt+C" -> "⌃⌥C".
  keysLabel(acc) {
    const sym = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘', Scrolllock: 'Scroll Lock' };
    return String(acc || '').split('+').map((p) => sym[p] || p).join('');
  },

  // A shortcut recorder: click, press the keys (with ⌃, ⌥ or ⌘), Esc cancels. onChange(accelerator).
  // opts.bare: F13–F24 also count on their own (a PC keyboard's Scroll Lock is F14 here).
  keyRecorder(onChange, opts = {}) {
    const b = UI.el('button', { class: 'btn small keyrec' });
    let value = '', recording = false;
    const show = () => { b.textContent = recording ? I18n.t('Press keys…') : UI.keysLabel(value) || I18n.t('None'); b.classList.toggle('on', recording); };
    const keyOf = (e) => {
      if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
      if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
      if (/^F\d{1,2}$/.test(e.code)) return e.code;
      return { Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Enter: 'Enter', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }[e.code] || '';
    };
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return stop();
      const key = keyOf(e);
      const bare = opts.bare && /^F(?:1[3-9]|2[0-4])$/.test(key);
      if (!key || !(e.ctrlKey || e.altKey || e.metaKey || bare)) return; // wait for a real combination
      const acc = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Command', key].filter(Boolean).join('+');
      value = acc;
      stop();
      onChange(acc);
    };
    const stop = () => { recording = false; window.removeEventListener('keydown', onKey, true); show(); };
    b.onclick = () => {
      if (recording) return stop();
      recording = true;
      window.addEventListener('keydown', onKey, true);
      show();
    };
    b.onblur = stop;
    show();
    return { el: b, set(v) { if (!recording) { value = v || ''; show(); } } };
  },

  // Cursor tab › Cursor lock (shared/cursorlock.js): the switch is not a setting, it lasts until the
  // pointer is moved some other way; the lock key is (settings.keys.lockKeys).
  cursorLock() {
    const lock = UI.switch((v) => UI.api.setKvm({ locked: v }), { label: I18n.t('Lock the cursor') });
    const lockRow = UI.row(I18n.t('Lock the cursor'), '', [lock], { literal: true });
    const key = UI.keyRecorder((v) => UI.api.setKeys({ lockKeys: v }), { bare: true });
    const keyRow = UI.row(I18n.t('Lock key'), I18n.t('F13–F24 on its own (a PC keyboard’s Scroll Lock is F14), or a combination with ⌃, ⌥ or ⌘'), [key.el]);
    return {
      el: UI.card(I18n.t('Cursor lock'), [lockRow, keyRow]),
      update(s) {
        const i = s.input || {};
        const keys = (s.keys && s.keys.lockKeys) || '';
        const p = UI.peer(s);
        lock.set(i.locked);
        lock.disable(!s.client);
        key.set(keys);
        const where = i.where === 'driving' ? p.name : p.me;
        const press = keys ? I18n.t(' While the pointer is on {me}, {keys} on either keyboard locks or unlocks it (each computer has its own key).', { me: p.me, keys: UI.keysLabel(keys) }) : '';
        lockRow.setHint(i.lockError ? i.lockError : !s.client ? I18n.t('Keeps the pointer on one computer, even when the mouse is plugged into another.') + press
          : i.locked ? I18n.t('The pointer stays on {where}: the screen edges don’t cross.', { where }) + press
            : I18n.t('Keeps the pointer on {where}, where it is now, even when the mouse is plugged into another computer.', { where }) + press);
      },
    };
  },

  // The hotkey choices (settings.keys.hotkey), all right-hand modifiers.
  HOTKEYS: Object.fromEntries(window.MacShareProtocol.HOTKEYS.map((c) => [c,
    `${I18n.t(window.MacShareProtocol.hotkeyName(c))} ${{ Alt: '⌥', Control: '⌃', Shift: '⇧', Meta: '⌘' }[c.replace(/Left|Right/, '')]}`])),
  hotkeyName: (s) => I18n.t(window.MacShareProtocol.hotkeyName((s && s.keys && s.keys.hotkey) || 'AltRight')),

  // Live shared-input status (Cursor / Keyboard tabs): where input is, last message, tap problems.
  kvmStatus(s) {
    const i = s.input || { where: 'home' };
    if (i.tapError) return ['bad', I18n.t('macOS is blocking the mouse and keyboard. Allow Accessibility and Input Monitoring in General, then restart.')];
    if (s.kvm && s.kvm.linked === false) return ['warn', I18n.t('Cursor sharing is off. Double-tap {key} to turn it on.', { key: UI.hotkeyName(s) })];
    if (i.paused) return ['warn', I18n.t('Cursor sharing is off over Bluetooth. It comes back on Wi-Fi, or double-tap {key} to turn it on.', { key: UI.hotkeyName(s) })];
    if (!s.client) return ['info', I18n.t('Waiting for {name}.', { name: UI.peer(s).name })];
    const hk = UI.hotkeyName(s);
    if (i.where === 'driving') return ['info', I18n.t('You’re using {name}. Double-tap {key} to come back and turn cursor sharing off.', { name: s.client.name, key: hk })];
    if (i.where === 'driven') return ['info', I18n.t('{name} is using {me}. Double-tap {key} to take it back.', { name: s.client.name, me: UI.peer(s).me, key: hk })];
    return [i.message ? 'warn' : 'info', i.message ? `${i.message}.` : I18n.t('Connected to {name}. Double-tap {key} to turn cursor sharing off.', { name: s.client.name, key: hk })];
  },

  ago(ts) {
    if (!ts) return I18n.t('never');
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 10) return I18n.t('just now');
    if (s < 60) return I18n.t('{count} s ago', { count: s });
    if (s < 3600) return I18n.t('{count} min ago', { count: Math.round(s / 60) });
    if (s < 86400) return I18n.t('{count} h ago', { count: Math.round(s / 3600) });
    return new Date(ts).toLocaleDateString(I18n.locale);
  },

  bytes(n) {
    return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  },

  // Register a tab: { id, order, title, heading?, group?, icon?, desc, color, phase?, bottom?,
  //   master?: {get(s), set(v)},
  //   badge?(s) -> 'on' | text | '', build(body, page) -> render(state) }
  tab(def) {
    UI.tabs.push(def);
  },

  go(id) {
    window.dispatchEvent(new CustomEvent('macshare-go', { detail: id }));
  },
};

window.UI = UI;

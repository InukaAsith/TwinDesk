// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Main window UI kit (window.UI): same API as the Mac's mac/control.js so the tab scripts match;
// app.js boots the shell. Controls are built once per tab; render(state) only updates values,
// so a state push never interrupts a drag, an open menu or keyboard focus.
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
  terminal: 'M3 4h14v12H3z M6 8l2.5 2L6 12 M10 12h4',
  audio: 'M4 8h3l4-3v10l-4-3H4z M14 7.5c1 .8 1 4.2 0 5 M16 5.5c2.2 1.8 2.2 7.2 0 9',
  apps: 'M4 4h5v5H4z M11 4h5v5h-5z M4 11h5v5H4z M11 11h5v5h-5z',
  general: 'M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M10 2.5v2 M10 15.5v2 M2.5 10h2 M15.5 10h2 M4.7 4.7l1.4 1.4 M13.9 13.9l1.4 1.4 M4.7 15.3l1.4-1.4 M13.9 6.1l1.4-1.4',
  about: 'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z M10 9v5 M10 6.2v.1',
  drive: 'M3 12h14v4H3z M14 14h.5 M10 3v6 M7 6l3 3 3-3',
  bell: 'M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5h-12z M8.5 16.5a1.5 1.5 0 0 0 3 0',
  pin: 'M10 4v9 M5.5 8.5 10 13l4.5-4.5 M5 16h10',
  up: 'M10 16V4 M5 9l5-5 5 5',
  down: 'M10 4v12 M5 11l5 5 5-5',
  phone: 'M6.5 2.5h7a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z M9 15h2',
  call: 'M6 3h2.5l1.2 3.2-1.7 1.3a9 9 0 0 0 4.5 4.5l1.3-1.7 3.2 1.2V16a1 1 0 0 1-1 1A13 13 0 0 1 3 4a1 1 0 0 1 1-1z',
  message: 'M3 4.5h14v9H8.5L5 16.5v-3H3z',
  photo: 'M3 4.5h14v11H3z M3 13l4-4 3.5 3.5 2-2L17 14.5 M12.5 7.5h.1',
  doc: 'M5 2.5h6.5L15 6v11.5H5z M11.5 2.5V6H15',
  folder: 'M2.5 5h5.5l1.5 2h8v9.5h-15z',
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
  // Labels and hints may name the computers: {me} (this computer's name), {name} / {Name} (the other
  // one's, or "the other computer"); app.js fills them in again whenever a name changes.
  row(label, hint, controls = [], { onClick } = {}) {
    const lab = UI.el('span', { class: 'label', text: UI.fill(label) });
    if (String(label).includes('{')) lab.dataset.peer = label;
    const hintEl = UI.el('span', { class: 'hint', text: UI.fill(hint || '') });
    if (String(hint || '').includes('{')) hintEl.dataset.peer = hint;
    if (!hint) hintEl.hidden = true;
    const row = UI.el('div', { class: 'row' }, [
      UI.el('div', { class: 'text' }, [lab, hintEl]),
      UI.el('div', { class: 'controls' }, [].concat(controls).map((c) => (c && c.el) || c)),
    ]);
    row.label = lab;
    row.hint = hintEl;
    row.setHint = (t) => {
      if (String(t || '').includes('{')) hintEl.dataset.peer = t;
      else delete hintEl.dataset.peer;
      hintEl.textContent = UI.fill(t || '');
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

  note(kind, text) {
    const n = UI.el('div', { class: `note ${kind}`, text: UI.fill(text) });
    n.set = (t) => { n.textContent = UI.fill(t || ''); n.hidden = !t; };
    return n;
  },

  ago(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ts).toLocaleDateString();
  },

  bytes(n) {
    return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  },

  // Register a tab: { id, title, desc, color, phase?, bottom?, master?: {get(s), set(v), disabled?: bool | (s) => bool},
  //   badge?(s) -> 'on' | text | '', build(body, page) -> render(state) }
  tab(def) {
    UI.tabs.push(def);
  },

  // Register a tab: { id, order, title, heading?, group?, icon?, desc, color, phase?, bottom?,
  //   master?, badge?, build } — sorted by order (both apps use the same numbers).
  // A feature that isn't built yet: what it will do, how, its phase, and
  // the switches it will have (disabled). r: { id, title, desc, color, phase, what: [[t, d]], how, settings: [label] }
  comingTab(r) {
    UI.tab({
      id: r.id,
      order: r.order,
      group: r.group,
      heading: r.heading,
      title: r.title,
      desc: r.desc,
      color: r.color,
      icon: r.icon,
      phase: r.phase,
      master: { get: () => false, set: () => {}, disabled: true },
      build(body) {
        const { el } = UI;
        body.append(
          el('div', { class: 'card soon keep-on' }, [
            el('div', { class: 'soon-head' }, [el('span', { class: 'pill', text: 'Coming in phase ' + r.phase })]),
            ...r.what.map(([t, d]) => el('div', { class: 'soon-item' }, [el('strong', { text: t }), el('div', { class: 'hint', text: d })])),
          ]),
          UI.card('How it will work', [UI.row(r.how, '')], { cls: 'keep-on' }),
          UI.card('Settings it will have', r.settings.map((label) => UI.row(label, '', [UI.switch(() => {}, { disabled: true, label })]))),
        );
      },
    });
  },

  // Live Details card: labels → value cells. set({label: text}) fills
  // them; rows without a value are hidden.
  details(labels) {
    const vals = {};
    const rows = labels.map((label) => {
      const r = UI.row(label, '');
      vals[label] = UI.el('span', { class: 'value' });
      r.querySelector('.controls').append(vals[label]);
      return r;
    });
    const card = UI.card('Details', rows);
    card.set = (map) => labels.forEach((label, i) => {
      const t = map[label];
      vals[label].textContent = t == null ? '' : String(t);
      rows[i].hidden = t == null || t === '';
    });
    return card;
  },

  // "Hardware" / "Software" from getStats' powerEfficient flag, with the implementation name.
  codecImpl(name, hw) {
    return (hw ? 'Hardware' : 'Software') + (name ? ' (' + name + ')' : '');
  },

  // Who the other computer is: titles name what is connected. With a
  // Mac (or Linux): "Mac → PC" / "PC → Mac". With another PC, or nothing paired yet, this PC is
  // "PC1" and the other "PC2"; real names show in the
  // overview and the paired list. toMe = the peer's things here, fromMe = this PC's things there.
  peer(s) {
    const p = s && s.peer;
    const os = p ? p.os : 'linux';
    const KIND = { mac: 'Mac', win: 'PC', linux: 'Linux', android: 'Phone' };
    const same = os === 'linux';
    // Device names everywhere: this PC by its own name,
    // the other computer by its name (or "the other computer" before anything was paired).
    const me = (s && s.device && s.device.name) || 'This computer';
    const name = (p && p.name) || 'the other computer';
    const Name = name.charAt(0).toUpperCase() + name.slice(1);
    return {
      os, same, me, name, Name, phone: os === 'android',
      kind: KIND[os],
      them: name, us: me, the: name, there: name, There: Name, // older templates
      toMe: name + ' → ' + me,
      fromMe: me + ' → ' + name,
      limited: '', // every tab works with every computer now
    };
  },

  // After a render: any {me} / {name} / … still in text or a title under root gets filled. A text
  // node that is its element's only child keeps its template (data-peer), so a new name refills it.
  fillTree(root) {
    if (!root) return;
    const re = /\{(me|name|Name|there|There)\}/;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) if (re.test(n.nodeValue)) nodes.push(n);
    for (const n of nodes) {
      const el = n.parentElement;
      if (el && el.childNodes.length === 1 && !el.dataset.peer) el.dataset.peer = n.nodeValue;
      n.nodeValue = UI.fill(n.nodeValue);
    }
    for (const el of root.querySelectorAll('[title*="{"], [aria-label*="{"]')) {
      for (const a of ['title', 'aria-label']) if (el.hasAttribute(a)) el.setAttribute(a, UI.fill(el.getAttribute(a)));
    }
  },

  // Playback of shared screens (both directions, the same on both computers via
  // pair.sync): one row used by Share and Receive. Returns the row with .render(state).
  paceRow() {
    const seg = UI.segmented([
      { value: 'fast', label: 'Fastest' },
      { value: 'smooth', label: 'Smooth' },
    ], (v) => UI.api.setMonitor({ pacing: v }));
    const row = UI.row('Playback', '', [seg]);
    row.render = (s) => {
      const pace = (s.monitor && s.monitor.pacing) || 'fast';
      seg.set(pace);
      row.setHint(pace === 'smooth' ? 'Even motion, about one frame later. The same on {name}'
        : 'Each frame the moment it arrives. The same on {name}');
    };
    return row;
  },

  // A template with {me}, {name}, {Name}, … filled from the current state.
  fill(t) {
    if (!t || !String(t).includes('{')) return t || '';
    const p = UI.peer(UI.state);
    return String(t).replace(/\{(\w+)\}/g, (m, k) => (k in p ? p[k] : m));
  },

  isPhone: (s) => !!(s && s.peerSession && s.peerSession.os === 'android'), // s.session is the desktop's here

  // Small device glyph by OS: 'mac' | 'win' | 'linux' | 'android'.
  osClass: (os) => (os === 'mac' ? 'mac' : os === 'android' ? 'phone' : os === 'linux' ? 'pc linux' : 'pc'),
  // An app's icon in a grid: its own, else (none, or it doesn't load) TwinDesk's.
  appIcon(src) {
    const fallback = 'assets/sidebar-icon@2x.png';
    const img = UI.el('img', { src: src || fallback, alt: '' });
    img.onerror = () => { img.onerror = null; img.src = fallback; };
    return img;
  },
  osIcon(os) {
    return UI.el('span', { class: `os-ico ${UI.osClass(os)}`, attrs: { 'aria-label': os === 'mac' ? 'Mac' : os === 'linux' ? 'Linux' : os === 'android' ? 'Phone' : 'PC' } });
  },

  // Two equal direction cards, always Mac → PC then PC → Mac.
  // Each def: { on?: {get(s), set(v), disabled?}, label?, hint?, rows: [], soon?: 'phase N' }.
  // (as the Mac): the head is a route — device icon + real name, a line with an
  // arrowhead, the other device; this PC's side tinted. The switch sits in the first row, whose
  // label is a sentence with real names ({name} = the other computer, filled in by app.js).
  // Returns { el, update(s) }; each card has .main (that first row, when there is a switch).
  dirCards(m2p, p2m) {
    const node = (me) => {
      const ico = UI.el('span', { class: 'os-ico ' + (me ? 'pc' : 'mac') });
      if (!me) ico.dataset.os = 'peer';
      const nm = UI.el('span', { class: 'nm', text: UI.fill(me ? '{me}' : '{name}') });
      nm.dataset.peer = me ? '{me}' : '{name}';
      return UI.el('span', { class: 'node' + (me ? ' here' : '') }, [ico, nm]);
    };
    const make = (dir, def) => {
      const toMe = dir === 'm2p';
      const route = UI.el('span', { class: 'route', attrs: { role: 'img' } }, [node(!toMe), UI.el('span', { class: 'flow' }), node(toMe)]);
      const head = UI.el('div', { class: 'dir-head' }, [route, def.soon ? UI.el('span', { class: 'pill muted', text: 'Coming in phase ' + def.soon }) : null]);
      let sw = null, main = null;
      if (def.on) {
        const label = def.label || (toMe ? '{name} on {me}' : '{me} on {name}');
        sw = UI.switch((v) => def.on.set(v), { label: UI.fill(label), disabled: !!def.on.disabled || !!def.soon });
        main = UI.row(label, def.hint || '', [sw.el]);
        main.classList.add('dir-main');
      }
      const card = UI.el('div', { class: 'dir-card' + (def.soon ? ' soon-card' : '') }, [head].concat(main ? [main] : [], def.rows || []));
      card.main = main;
      card.update = (s) => {
        if (!sw) return;
        const on = !def.soon && !!def.on.get(s);
        sw.set(on);
        card.classList.toggle('off', !on);
      };
      return card;
    };
    const a = make('m2p', m2p), b = make('p2m', p2m);
    return { el: UI.el('div', { class: 'dir-pair' }, [a, b]), a, b, update: (s) => { a.update(s); b.update(s); } };
  },

  // "Control+Alt+C" → "Ctrl+Alt+C" (Electron accelerator → how Linux desktops write it).
  keysLabel(acc) {
    return String(acc || '').split('+').map((p) => ({ Control: 'Ctrl', Super: 'Super' }[p] || p)).join('+');
  },

  // A shortcut recorder: click, press the keys (with Ctrl, Alt or Win), Esc cancels.
  // onChange(accelerator).
  keyRecorder(onChange) {
    const b = UI.el('button', { class: 'btn small keyrec' });
    let value = '', recording = false;
    const show = () => { b.textContent = recording ? 'Press keys…' : UI.keysLabel(value) || 'None'; b.classList.toggle('on', recording); };
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
      if (!key || !(e.ctrlKey || e.altKey || e.metaKey)) return; // wait for a real combination
      value = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super', key].filter(Boolean).join('+');
      stop();
      onChange(value);
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

  // The hotkey choices (P.HOTKEYS) in Linux words
  // ("Right Alt", "Ctrl (either side)", "Left Super").
  HOTKEYS: Object.fromEntries(window.MacShareProtocol.HOTKEYS.map((c) => [c, window.MacShareProtocol.hotkeyName(c, 'win').replace('Windows key', 'Super')])),
  hotkeyName(s) {
    return UI.P.hotkeyName((s && s.keys && s.keys.hotkey) || 'AltRight', 'win').replace('Windows key', 'Super');
  },

  // "Right now" row for the Cursor/Keyboard tabs: where input is + the last KVM event.
  inputStatus() {
    const pill = UI.el('span', { class: 'pill' });
    const row = UI.row('Keyboard and mouse', '', [pill]);
    row.update = (s) => {
      const k = s.kvmState;
      const p = UI.peer(s);
      const WHERE = { home: 'On ' + p.me, driving: 'On ' + p.name, driven: p.Name + ' is using ' + p.me };
      const off = k.linked === false || k.paused;
      pill.textContent = off ? 'Sharing off' : WHERE[k.mode] || WHERE.home;
      pill.className = 'pill ' + (off ? 'bad' : k.mode === 'home' ? 'muted' : 'good');
      row.setHint(k.helper && k.helper !== 'starting' ? k.helper
        : k.linked === false ? 'Cursor sharing is off. Double-tap ' + UI.hotkeyName(s) + ' to turn it on.'
        : k.paused ? 'Cursor sharing is off over Bluetooth. It comes back on Wi-Fi, or double-tap ' + UI.hotkeyName(s) + ' to turn it on.'
        : s.link.state !== 'connected' ? 'Waiting for ' + p.the
          : k.mode === 'home' && !k.message ? 'Connected to ' + p.name + '. Double-tap ' + UI.hotkeyName(s) + ' to turn cursor sharing off.'
          : k.message || 'Double-tap ' + UI.hotkeyName(s) + ({ home: ' to turn cursor sharing off', driving: ' to come back and turn cursor sharing off', driven: ' to take it back' }[k.mode] || ''));
    };
    return row;
  },

  go(id) {
    window.dispatchEvent(new CustomEvent('macshare-go', { detail: id }));
  },
};

window.UI = UI;

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Web: the page a computer running TwinDesk serves to a phone, a tablet or another computer's
// browser (shared/web/webhub.js), drawn like the TwinDesk phone app: a floating tab bar when narrow, a
// sidebar with the page centred beside it when wide.
// The screen viewer and the remote are the phone app's own pages (/td/viewer.html, /td/remote.html,
// through web/td-bridge.js), full screen over this one, as the app opens them.
//
// Not paired yet: what TwinDesk is, where to get it, and the pairing code.
// Paired: the device id and key are kept in this page's storage and in its address (#d=…&k=…), so an
// app added to the Home Screen (which has storage of its own) opens paired too.
//
// In the background (the Background page): a silent sound keeps an iPhone's page running (and its
// lock screen shows what plays on the computer, with its controls); Web Push (web/sw.js) brings the
// computer's alerts with the page closed; the app icon shows how many.
'use strict';

(() => {
  // ---------------------------------------------------------------- the language
  // As in the apps: the English text is the key; web/lang/<language>.js (written in by web/lang/pick.js
  // before this script) gives another language's; anything missing stays English. {name} parts are
  // filled once, so braces in a computer's name stay as they are. What goes to the computer stays English.
  const LANGUAGES = [['en', 'English', '🇬🇧'], ['zh-CN', '简体中文', '🇨🇳'], ['ru', 'Русский', '🇷🇺'], ['tr', 'Türkçe', '🇹🇷'], ['pt-BR', 'Português (Brasil)', '🇧🇷']];
  const LANG = (window.TwinDeskWeb && window.TwinDeskWeb.lang) || 'en';
  const MESSAGES = (window.TwinDeskWeb && window.TwinDeskWeb.messages) || {};
  document.documentElement.lang = LANG;
  function tr(text, vars) {
    const s = MESSAGES[text] || text.replace(/^[^|]*\|/, '');
    return vars ? s.replace(/\{(\w+)\}/g, (x, k) => (k in vars ? String(vars[k]) : x)) : s;
  }
  // A sentence with elements in it (a link, a name in bold): its parts, in this language's order.
  function trNodes(text, nodes) {
    return tr(text).split(/(\{\w+\})/).map((p) => { const k = /^\{(\w+)\}$/.exec(p); return k && k[1] in nodes ? nodes[k[1]] : p; }).filter((p) => p !== '');
  }

  // ---------------------------------------------------------------- the kit
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  function el(tag, props = {}, kids = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e[k] = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k in e && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const c of [].concat(kids)) if (c != null && c !== false) e.append(c);
    return e;
  }
  // The Mac's line icons (mac/control.js ICONS), 20×20.
  const ICONS = {
    overview: 'M3 9.5 10 4l7 5.5V17H3z M8 17v-4h4v4',
    display: 'M3 4h14v9H3z M7 17h6 M10 13v4',
    cast: 'M2.5 4h15v9.5h-15z M7 17h6 M10 6.5v4.5 M7.8 8.8L10 11l2.2-2.2', // a screen that receives (not Apple's AirPlay symbol)
    files: 'M3 5h5l1.5 2H17v9H3z',
    drop: 'M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-4 3v-3H4A1.5 1.5 0 0 1 2.5 13V6A1.5 1.5 0 0 1 4 4.5z M6.5 8.5h7 M6.5 11h4',
    drive: 'M3 11.5 5 4.5h10l2 7 M3 11.5h14v4H3z M13.5 13.5h.1',
    link: 'M8.5 11.5a3.2 3.2 0 0 0 4.5 0l2.5-2.5a3.2 3.2 0 0 0-4.5-4.5l-.8.8 M11.5 8.5a3.2 3.2 0 0 0-4.5 0L4.5 11a3.2 3.2 0 0 0 4.5 4.5l.8-.8',
    remote: 'M6.5 6.5h7a4 4 0 0 1 4 4v1.5a2.8 2.8 0 0 1-5 1.7L11.4 12H8.6l-1.1 1.7a2.8 2.8 0 0 1-5-1.7v-1.5a4 4 0 0 1 4-4z M6 8.5v3 M4.5 10h3 M13 9.5h0 M14.5 11h0',
    clipboard: 'M6 4h8v13H6z M8 3h4v2.5H8z M8 9h4 M8 12h4',
    bell: 'M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5h-12z M8.5 16.5a1.5 1.5 0 0 0 3 0',
    audio: 'M4 8h3l4-3v10l-4-3H4z M14 7.5c1 .8 1 4.2 0 5 M16 5.5c2.2 1.8 2.2 7.2 0 9',
    camera: 'M2.5 6h10v8h-10z M12.5 8.5l5-2.5v8l-5-2.5',
    moon: 'M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z',
    bolt: 'M11 2.5 4.5 11H10l-1 6.5L15.5 9H10z',
    general: 'M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M10 2.5v2 M10 15.5v2 M2.5 10h2 M15.5 10h2 M4.7 4.7l1.4 1.4 M13.9 13.9l1.4 1.4 M4.7 15.3l1.4-1.4 M13.9 6.1l1.4-1.4',
    about: 'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z M10 9v5 M10 6.2v.1',
    more: 'M4.5 10h.1 M10 10h.1 M15.5 10h.1',
    up: 'M10 16V4 M5 9l5-5 5 5',
    down: 'M10 4v12 M5 11l5 5 5-5',
    plus: 'M10 4v12 M4 10h12',
    cursor: 'M5 3l10 6-4.5 1.2L8.5 15z',
    gamepad: 'M6.5 6.5h7a4 4 0 0 1 4 4v1.5a2.8 2.8 0 0 1-5 1.7L11.4 12H8.6l-1.1 1.7a2.8 2.8 0 0 1-5-1.7v-1.5a4 4 0 0 1 4-4z M6 8.5v3 M4.5 10h3 M13 9.5h0 M14.5 11h0',
    mic: 'M10 3a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-5 0v-4A2.5 2.5 0 0 1 10 3z M5.5 9.5a4.5 4.5 0 0 0 9 0 M10 14v3',
    send: 'M10 15V5 M5.5 9.5 10 5l4.5 4.5',
    ring: 'M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5h-12z M8.5 16.5a1.5 1.5 0 0 0 3 0',
    lock: 'M5.5 9h9v8h-9z M7.5 9V6.5a2.5 2.5 0 0 1 5 0V9',
    sleep: 'M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z',
    bluetooth: 'M6 6.5l8 7-4 3.5V3l4 3.5-8 7',
    dnd: 'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z M6.5 10h7',
    keyboard: 'M2.5 5.5h15v9h-15z M5 8.5h.1 M8 8.5h.1 M11 8.5h.1 M14 8.5h.1 M6 11.5h8',
    stop: 'M5.5 5.5h9v9h-9z',
    extend: 'M2.5 5h8v7h-8z M12.5 7h5v7h-5z M5 15h3',
    mirror: 'M3 4h14v9H3z M7 17h6 M10 13v4 M7 8.5h6',
    share: 'M10 3v10 M6.5 6.5 10 3l3.5 3.5 M5 10H4v7.5h12V10h-1',
    copy: 'M7 7h9v10H7z M4 13V3h9',
    check: 'M4.5 10.5 8 14l7.5-8',
    full: 'M3.5 7.5v-4h4 M12.5 3.5h4v4 M16.5 12.5v4h-4 M7.5 16.5h-4v-4',
    play: 'M6.5 4.5 15 10l-8.5 5.5z',
    pause: 'M6.5 4.5v11 M13.5 4.5v11',
    next: 'M5 4.5 12 10l-7 5.5z M15 4.5v11',
    prev: 'M15 4.5 8 10l7 5.5z M5 4.5v11',
  };
  function icon(name, size) {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 20 20');
    s.setAttribute('class', 'ico');
    if (size) { s.style.width = size + 'px'; s.style.height = size + 'px'; }
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', ICONS[name] || '');
    s.append(p);
    return s;
  }
  const tile = (name, colors, size = 30) => el('span', { class: 'tile', style: `width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.27)}px;background:linear-gradient(${colors[0]},${colors[1]})` }, [icon(name, Math.round(size * 0.62))]);
  const btn = (label, onclick, cls = '', ico) => el('button', { class: `btn ${cls}`.trim(), onclick, type: 'button' }, [ico ? icon(ico) : null, label]);
  function sw(onchange) {
    const i = el('input', { type: 'checkbox', class: 'sw', role: 'switch' });
    i.onchange = () => onchange(i.checked);
    return i;
  }
  function seg(options, get, set, cls = '') {
    const s = el('div', { class: `seg ${cls}`.trim(), role: 'radiogroup' });
    s.paint = () => s.replaceChildren(...options.map(([v, l]) => el('button', { type: 'button', class: get() === v ? 'on' : '', text: l, onclick: () => { set(v); s.paint(); } })));
    s.paint();
    return s;
  }
  function row(label, hint, ctl, onclick) {
    const h = el('span', { class: 'hint', text: hint || '' });
    if (!hint) h.hidden = true;
    const l = el('span', { class: 'label', text: label });
    const r = el('div', { class: `row${onclick ? ' click' : ''}`, onclick }, [el('div', { class: 'text' }, [l, h]), ctl ? el('div', { class: 'ctl' }, [].concat(ctl)) : null]);
    r.setHint = (t) => { h.textContent = t || ''; h.hidden = !t; };
    r.setLabel = (t) => { l.textContent = t; };
    return r;
  }
  const valueRow = (label) => {
    const v = el('span', { class: 'value' });
    const r = row(label, '', [v]);
    r.set = (t) => { v.textContent = t == null || t === '' ? '—' : t; };
    return r;
  };
  function card(title, kids, action) {
    const t = el('span', { text: title || '' });
    const bar = el('div', { class: 'card-title' }, [t, action || null]);
    bar.hidden = !title && !action;
    const w = el('div', { class: 'card-wrap' }, [bar, el('div', { class: 'card' }, kids)]);
    w.setTitle = (x) => { t.textContent = x; bar.hidden = !x && !action; };
    return w;
  }
  function head(title, ctl) {
    const d = el('div', { class: 'desc' });
    const h = el('h1', { class: 'head', text: title });
    const e = el('div', { class: 'head-row' }, [el('div', {}, [h, d]), ctl || null]);
    e.desc = (t) => { d.textContent = t || ''; d.hidden = !t; };
    e.setHead = (t) => { h.textContent = t; };
    e.desc('');
    return e;
  }
  const note = (text, kind = '') => el('div', { class: `note ${kind}`, text });
  const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (s < 86400) return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  let toastTimer;
  function toast(t) {
    const e = $('toast');
    e.textContent = t;
    e.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { e.hidden = true; }, 2600);
  }
  function linkify(text) {
    const out = el('span');
    const re = /\bhttps?:\/\/[^\s<>"]+/g;
    let i = 0, m;
    while ((m = re.exec(text))) {
      out.append(text.slice(i, m.index), el('a', { href: m[0], target: '_blank', rel: 'noopener', text: m[0] }));
      i = m.index + m[0].length;
    }
    out.append(text.slice(i));
    return out;
  }
  async function copyText(t) {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch (_) {
      const ta = el('textarea', { style: 'position:fixed;top:-100px;opacity:0' });
      ta.value = t;
      document.body.append(ta);
      ta.select();
      ta.setSelectionRange(0, t.length);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove();
      return ok;
    }
  }
  const copy = async (t, what = tr('Copied')) => { const ok = await copyText(t); if (ok) haptic(); toast(ok ? what : tr('Could not copy')); };
  const copyBox = (get) => {
    const m = el('span', { class: 'mono' });
    const e = el('div', { class: 'copybox' }, [m, btn(tr('Copy'), () => copy(get()), 'small')]);
    e.update = () => { m.textContent = get(); };
    e.update();
    return e;
  };

  // ---------------------------------------------------------------- who we are, who it is
  const UA = navigator.userAgent;
  const IPAD = /iPad/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
  const ME = {
    os: IPAD ? 'ipados' : /iPhone|iPod/.test(UA) ? 'ios' : /Android/.test(UA) ? 'android' : /Mac OS X/.test(UA) ? 'mac' : /Windows/.test(UA) ? 'win' : /CrOS/.test(UA) ? 'linux' : /Linux/.test(UA) ? 'linux' : 'other',
  };
  ME.apple = ME.os === 'ios' || ME.os === 'ipados';
  document.documentElement.classList.toggle('flagfont', ['win', 'linux', 'other'].includes(ME.os));
  ME.mobile = ME.apple || ME.os === 'android';
  ME.model = IPAD ? 'iPad' : ME.os === 'ios' ? 'iPhone' : ME.os === 'android' ? tr('Android phone') : ME.os === 'mac' ? tr('Mac browser') : ME.os === 'win' ? tr('Windows browser') : tr('Browser');
  ME.kind = IPAD ? 'iPad' : ME.os === 'ios' ? 'iPhone' : ME.os === 'android' ? tr('phone') : tr('browser');
  const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const MAC_SAFARI = !STANDALONE && /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints < 2 && /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(navigator.userAgent);
  const STORE = 'twindesk.web';
  const load = () => { try { return JSON.parse(localStorage.getItem(STORE) || 'null') || {}; } catch (_) { return {}; } };
  const save = (o) => { try { localStorage.setItem(STORE, JSON.stringify(o)); } catch (_) {} };
  const prefs = {
    sound: true, touch: 'pad', speed: 1, tap: true, pad: {}, pen: true, control: true, pacing: 'fast', quality: 'auto', mode: 'mirror', full: false,
    theme: 'system', accent: '#0a84ff', keepAlive: false, push: true,
    ...((load().prefs) || {}),
  };
  const savePrefs = () => { const o = load(); o.prefs = prefs; save(o); };

  const S = {
    creds: null, // {id, key, token}
    pc: null, // {id, name, os, version, host, port, ips, control, vapid, media, mount, devices, extend}
    serving: null, // /api/ping before pairing: who serves this page
    peers: [], // /api/peers: the TwinDesk Web computers on this network, this one marked self
    conn: 'boot', // boot | pairing | connecting | online | offline
    pairErr: '',
    rtt: null,
    link: '', // how the computer sees this socket: 'USB-C', 'Wi-Fi', 'Ethernet' or ''
    secure: location.protocol === 'https:',
    clip: { text: '', at: 0, history: [] },
    chat: [],
    uploads: new Map(), // local id -> {name, size, sent}
    notifs: [], notifsOn: false, unseen: 0,
    screen: { status: 'off', on: false },
    picture: null, // [w, h] of what the viewer shows
    remote: null, // remote.state
    cam: { on: false, status: 'off', facing: 'user', stream: null },
    mic: { on: false, status: 'off', stream: null },
    scr: { on: false, status: 'off', stream: null }, // this device's screen on the computer
    allow: {}, // what the computer lets this device do (policy)
    listening: false, // the computer's sound without the picture
    alerts: null, push: false, // the computer's alert settings for this device, and whether it pushes
    devs: null, // {can, state}: the computer's ring, lock, sleep…
    mount: null, media: null,
  };

  // ---------------------------------------------------------------- the look
  const wideQ = matchMedia('(min-width: 760px)');
  const darkQ = matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => prefs.theme === 'dark' || (prefs.theme !== 'light' && darkQ.matches);
  const logo = () => (isDark() ? '/logo-dark.png' : '/logo-light.png');
  const ACCENTS = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff453a', '#ff9f0a', '#30d158', '#00c7be', '#8e8e93'];
  function applyLook() {
    const h = document.documentElement;
    h.classList.toggle('dark', isDark());
    h.classList.remove('mac');
    h.style.setProperty('--accent', prefs.accent || '#0a84ff');
    const m = $('theme-color');
    if (m) requestAnimationFrame(() => { m.content = getComputedStyle(document.body).backgroundColor; });
    for (const img of document.querySelectorAll('img.logo')) img.src = logo();
  }
  darkQ.addEventListener('change', () => { applyLook(); });

  // ---------------------------------------------------------------- the address: pairing, upgrade
  const hashParams = () => new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  // A .local name's first lookup can take a few seconds (mDNS); an address answers at once.
  async function reachable(base, ms = 2500) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(`${base}/api/ping`, { cache: 'no-store', signal: ctl.signal });
      return r.ok ? await r.json() : null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  // The TwinDesk Web computers on this network (each one lists the others): a choice at the top of
  // the page when there's more than one. Each computer keeps its own pairing, on its own address:
  // opening another one leaves this one's as it is.
  async function loadPeers() {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    try {
      const r = await fetch('/api/peers', { cache: 'no-store', signal: ctl.signal });
      const list = r.ok ? await r.json() : [];
      const key = (l) => JSON.stringify(l.map((x) => [x.id, x.name, x.ip, x.port]));
      if (Array.isArray(list) && key(list) !== key(S.peers)) { S.peers = list; refresh('overview', 'connection'); if (peerBars.size) for (const b of peerBars) b.update(); }
    } catch (_) {} finally { clearTimeout(t); }
  }
  setInterval(loadPeers, 30000);
  const peerUrl = (x) => `http://${x.ip}:${x.port + 1}/#h=${encodeURIComponent(x.host)}&p=${x.port}`;
  function openPeer(x) {
    if (x.self) return;
    toast(tr('Opening {name}…', { name: x.name }));
    location.assign(peerUrl(x));
  }
  const peerBars = new Set();
  function peerBar() {
    const list = el('div', { class: 'peers-list', role: 'radiogroup', 'aria-label': tr('Computer') });
    const e = el('div', { class: 'peers' }, [el('div', { class: 'peers-title', text: tr('Computers on this network') }), list]);
    e.update = () => {
      const L = S.peers || [];
      e.hidden = L.length < 2;
      if (e.hidden) return;
      list.replaceChildren(...L.map((x) => el('button', {
        type: 'button', class: x.self ? 'on' : '', role: 'radio', 'aria-checked': String(!!x.self), title: x.host,
        onclick: () => openPeer(x),
      }, [icon('display', 18), el('span', { text: x.name }), x.short ? el('i', { text: 'twindesk.local' }) : null])));
    };
    peerBars.add(e);
    e.update();
    return e;
  }

  // One device, several addresses (twindesk.local, the computer's name, its IP; http and https), and
  // each keeps its own storage: the pairing goes along in the address whenever the page moves, so
  // whichever one is typed ends up signed in.
  const credsHash = (c) => (c && c.id && c.key ? `d=${encodeURIComponent(c.id)}&k=${encodeURIComponent(c.key)}` : '');
  function carry(extra) {
    const h = hashParams();
    const st = load();
    if (!h.get('d') && st.creds) for (const [k, v] of new URLSearchParams(credsHash(st.creds))) h.set(k, v);
    h.delete('hop');
    for (const [k, v] of Object.entries(extra || {})) h.set(k, v);
    const out = h.toString();
    return out ? `#${out}` : '';
  }

  // On plain http (the QR code's address, twindesk.local), move to the secure page when this device
  // trusts it: by name first (the same whatever address the computer has), then by address. On https
  // with no pairing here, look once on the plain address, where an earlier pairing may be.
  async function upgrade() {
    // An installed app stays where it was added (moving would leave the app for the browser).
    if (STANDALONE) return false;
    const h = hashParams();
    const st = load();
    const host = h.get('h') || (st.pc && st.pc.host) || (/\.local$/.test(location.hostname) ? location.hostname : '');
    if (location.protocol === 'https:') {
      if (st.creds || h.get('d') || h.get('pair') || h.get('hop')) return false;
      try { if (sessionStorage.getItem('twindesk.web.hopped')) return false; sessionStorage.setItem('twindesk.web.hopped', '1'); } catch (_) {}
      const ping = await reachable('');
      const ip = ping && ping.ip;
      if (!ip) return false;
      // To the plain page by name (this page resolves it): a pairing made without the secure page is there.
      const name = ping.host || host || location.hostname;
      location.replace(`http://${/\.local$/.test(name) ? name : ip}:${(Number(location.port) || 47870) + 1}/${location.search}#hop=1&h=${encodeURIComponent(name)}&p=${Number(location.port) || 47870}`);
      return true;
    }
    if (location.protocol !== 'http:') return false;
    const port = Number(h.get('p')) || Number(location.port) - 1 || 47870;
    const onIp = /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname);
    const back = h.get('hop') && !st.creds; // came here looking for a pairing: none, back to https to pair
    // In order of preference, asked all at once: the secure page by name, the secure page on this
    // address, then (no secure page yet) the plain page by name. Off the address onto the name, an app
    // added from here keeps working when the computer's address changes (the name follows it).
    const name = host && /\.local$/.test(host) ? host : '';
    const bases = [name && `https://${name}:${port}`, `https://${location.hostname}:${port}`, onIp && name && `http://${name}:${port + 1}`].filter(Boolean);
    const tries = bases.map((b) => reachable(b, b.includes('.local') ? 6000 : 2500));
    for (let i = 0; i < bases.length; i++) {
      if (await tries[i]) {
        location.replace(`${bases[i]}/${location.search}${back ? `#hop=2&h=${encodeURIComponent(host)}&p=${port}` : carry()}`);
        return true;
      }
    }
    return false;
  }

  function adoptCreds() {
    const h = hashParams();
    const stored = load();
    if (h.get('d') && h.get('k')) S.creds = { id: h.get('d'), key: h.get('k'), token: stored.creds && stored.creds.id === h.get('d') ? stored.creds.token : '' };
    else if (stored.creds && stored.creds.id) S.creds = stored.creds;
    S.pc = stored.pc || null;
    S.pairCode = (h.get('pair') || '').replace(/\D/g, '').slice(0, 6);
  }

  // The address carries the pairing: the Home Screen app is added with it.
  function keepCreds() {
    const o = load();
    o.creds = S.creds;
    o.pc = S.pc;
    save(o);
    const frag = credsHash(S.creds);
    history.replaceState(null, '', `/#${frag}`);
    const m = $('manifest');
    if (m) m.href = `/manifest.webmanifest?h=${encodeURIComponent(frag)}`;
  }

  function dropCreds(why) {
    const o = load();
    delete o.creds;
    save(o);
    S.creds = null;
    S.chat = [];
    S.conn = 'pairing';
    S.pairErr = why || '';
    history.replaceState(null, '', '/');
    keepAlive(false);
    setBadge(0);
    frame();
  }

  // ---------------------------------------------------------------- the socket
  let ws = null;
  let tries = 0;
  let retry = null;
  // USB-C: when the computer has an address on a cable to this device (its hotspot over USB, USB
  // tethering), the socket moves there, and back to the page's own address when the cable comes out.
  // The page itself stays where it is (its origin, its installed app); only the socket moves, and the
  // old one closes once the new one is welcomed, so nothing stops in between.
  let via = ''; // the cable address the socket uses, '' for the page's own host
  let prev = null; // the socket being moved away from, until the new one is welcomed
  let lastPong = 0;
  const send = (m) => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; } return false; };
  const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${via ? `${via}${location.port ? `:${location.port}` : ''}` : location.host}/ws`;

  function moveTo(host) {
    if (host === via || prev || !ws || ws.readyState !== 1) return;
    prev = { sock: ws, via };
    via = host;
    ws = null;
    connect(true);
  }
  // The move failed before it was welcomed: stay on the old socket if it's still up.
  function moveBack() {
    if (!prev) return false;
    const p = prev;
    prev = null;
    if (p.sock.readyState !== 1) { via = ''; return false; }
    ws = p.sock;
    via = p.via;
    return true;
  }

  let probing = false;
  async function probeCable() {
    if (probing || prev || !S.creds || S.paused || !online() || !S.pc) return;
    const cable = S.pc.cable || [];
    const here = via || location.hostname;
    if (cable.includes(here)) return;
    if (via && !cable.includes(via)) return moveTo(''); // that cable is gone
    probing = true;
    try {
      for (const ip of cable) {
        try {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), 2000);
          const r = await fetch(`${location.protocol}//${ip}${location.port ? `:${location.port}` : ''}/api/ping`, { cache: 'no-store', signal: ctl.signal });
          clearTimeout(t);
          const j = await r.json();
          if (j && j.id === S.pc.id) { moveTo(ip); break; }
        } catch (_) {}
      }
    } finally { probing = false; }
  }
  setInterval(probeCable, 10000);

  function connect(quiet) {
    clearTimeout(retry);
    if (S.paused) return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    let sock;
    try { sock = new WebSocket(wsUrl()); } catch (_) { via = ''; sock = new WebSocket(wsUrl()); }
    ws = sock;
    if (S.creds && !quiet) { S.conn = S.conn === 'offline' ? 'offline' : 'connecting'; render(); }
    sock.onopen = () => {
      tries = 0;
      if (S.creds) sock.send(JSON.stringify({ t: 'hello', id: S.creds.id, key: S.creds.key, os: ME.os, model: ME.model, name: load().name || '' }));
      else if (S.pairCode && S.pairCode.length === 6 && !holdForInstall()) pair(S.pairCode);
    };
    sock.onmessage = (e) => {
      if (ws !== sock && !(prev && prev.sock === sock)) return;
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      // During a move the old socket still carries everything until the new one is welcomed.
      if (prev && prev.sock !== sock && m.t !== 'welcome' && m.t !== 'unknown' && m.t !== 'forgotten') return;
      if (prev && prev.sock === sock && (m.t === 'welcome' || m.t === 'paired')) return;
      onMessage(m);
    };
    sock.onclose = (e) => {
      if (prev && prev.sock === sock) { if (ws && ws.readyState === 1) return; prev = null; return; }
      if (ws !== sock) return;
      ws = null;
      if (prev && moveBack()) return render();
      // The cable came out under it: straight back on the page's own address.
      if (via && e.code !== 4001 && e.code !== 4002 && !S.paused) { via = ''; tries = 0; return connect(true); }
      if (e.code === 4001) return dropCreds(tr('This device was removed on the computer. Pair again to reconnect.'));
      if (e.code === 4002 || S.paused) { // Disconnect, here or on the computer: off until Connect
        S.paused = S.paused || 'computer';
        S.conn = 'paused';
        stopCam(true); stopMic(true);
        closeOverlay(true);
        keepAlive(false);
        return render();
      }
      if (S.creds) {
        S.conn = tries > 1 ? 'offline' : 'connecting';
        stopCam(true); stopMic(true);
        closeOverlay(true);
        render();
      }
      retry = setTimeout(connect, Math.min(10000, 800 * 2 ** tries++));
    };
  }

  // Disconnect (the Overview's button): closed until Connect, still paired.
  function disconnectHere() {
    S.paused = 'here';
    clearTimeout(retry);
    if (ws) try { ws.close(1000, 'disconnect'); } catch (_) {}
    S.conn = 'paused';
    render();
  }
  function reconnect() {
    S.paused = '';
    tries = 0;
    S.conn = 'connecting';
    render();
    connect();
  }

  function pair(code) {
    S.pairErr = '';
    if (!ws || ws.readyState !== 1) { S.pairCode = code; return connect(); }
    send({ t: 'pair', code, os: ME.os, model: ME.model, name: load().name || ME.model });
  }

  let pingTimer;
  function onMessage(m) {
    switch (m.t) {
      case 'paired':
        S.creds = { id: m.id, key: m.key, token: m.token };
        S.pc = m.pc;
        S.link = m.link || '';
        S.conn = 'online';
        keepCreds();
        toast(tr('Paired with {name}', { name: m.pc.name }));
        haptic();
        frame();
        go('overview');
        break;
      case 'welcome':
        S.creds.token = m.token;
        S.pc = m.pc;
        S.link = m.link || '';
        S.conn = 'online';
        if (prev) { const p = prev.sock; prev = null; try { p.close(1000, 'moved'); } catch (_) {} if (S.link === 'USB-C') toast(tr('Connected to {name} over USB-C', { name: pcName() })); }
        keepCreds();
        frame();
        break;
      case 'unknown': return dropCreds(tr('This device is no longer paired with the computer. Pair again to reconnect.'));
      case 'forgotten': return dropCreds(tr('This device was removed on the computer.'));
      case 'disconnected': S.paused = 'computer'; break;
      case 'bad-code':
        S.pairErr = m.why === 'off' ? tr('TwinDesk Web is turned off on that computer.') : m.wait ? tr('Too many attempts. Try again in {seconds} seconds.', { seconds: m.wait }) : tr('Incorrect code. Check the code in TwinDesk › TwinDesk Web on the computer.');
        renderPage();
        break;
      case 'pc.links': if (S.pc) { S.pc.ips = m.ips || S.pc.ips; S.pc.cable = m.cable || []; } probeCable(); break;
      case 'pong': lastPong = performance.now(); S.rtt = Math.max(1, Math.round(performance.now() - m.at)); renderTop(); refresh('connection', 'receive'); break;
      case 'clip': S.clip = { text: m.text || '', at: m.at, from: m.from, history: m.history || S.clip.history }; refresh('clipboard', 'overview'); if (copyWant) copyLatest(); break;
      case 'chat.all': S.chat = m.items || []; refresh('files', 'drop', 'overview'); break;
      case 'chat.add':
        S.chat.push(m.item);
        if (m.item.from === 'pc' && !document.hidden && cur !== 'drop' && cur !== 'files') toast(m.item.file ? tr('{name} sent {file}', { name: pcName(), file: m.item.file.name }) : `${pcName()}: ${String(m.item.text).slice(0, 60)}`);
        refresh('files', 'drop', 'overview');
        break;
      case 'chat.state': {
        const x = S.chat.find((i) => i.id === m.id);
        if (x && x.file) { x.file.got = m.got || 0; x.file.saved = m.saved || 0; refresh('files'); }
        break;
      }
      case 'chat.gone': S.chat = S.chat.filter((x) => x.id !== m.id); refresh('files', 'drop', 'overview'); break;
      case 'notifs.all': S.notifs = m.items || []; S.notifsOn = true; refresh('notifications'); break;
      case 'notif':
        S.notifs = [m.item, ...S.notifs.filter((x) => x.id !== m.item.id)].slice(0, 100);
        if (cur !== 'notifications') S.unseen++;
        refresh('notifications');
        renderNav();
        break;
      case 'screen.state':
        S.screen = { status: m.status || 'off', on: !!m.on, why: m.why || '', touch: m.touch === true };
        toFrame('viewer', { t: 'screen.state', on: S.screen.on, touch: S.screen.touch });
        if (m.status === 'off' && m.why) toast(m.why);
        if (S.screen.status.startsWith('error')) toast(S.screen.status.replace(/^error: /, ''));
        if (m.status === 'off') S.picture = null;
        paintBar();
        refresh('receive', 'sound', 'overview');
        break;
      case 'rtc.offer': case 'rtc.ice': case 'stream.info': case 'stream.stop':
        if (S.listening) listenMsg(m);
        else toFrame('viewer', m);
        break;
      case 'remote.state': S.remote = m; toFrame('remote', m); refresh('remote'); break;
      case 'cam.answer': case 'cam.ice': answerIn('cam', m); break;
      case 'mic.answer': case 'mic.ice': answerIn('mic', m); break;
      case 'cam.state':
        S.cam.status = m.status;
        if (m.status.startsWith('error')) { toast(m.status.replace(/^error: /, '')); stopCam(true); }
        if (m.status === 'off' && S.cam.on) { if (m.why) toast(m.why); stopCam(true); }
        refresh('camera');
        break;
      case 'mic.state':
        S.mic.status = m.status;
        S.mic.out = m.out || '';
        if (m.status.startsWith('error')) { toast(m.status.replace(/^error: /, '')); stopMic(true); }
        if (m.status === 'off' && S.mic.on) { if (m.why) toast(m.why); stopMic(true); }
        refresh('sound');
        break;
      case 'alerts':
        S.alerts = m.alerts;
        S.push = !!m.push;
        if (!document.hidden && m.unread) send({ t: 'seen' });
        refresh('background');
        break;
      case 'alert': localAlert(m); break;
      case 'push.result':
        toast(m.ok ? (m.local ? tr('Test sent. It appears when TwinDesk is in the background.') : tr('Test sent. Lock this device or switch apps to see it.')) : m.status ? tr('The test was not delivered (push service error {status})', { status: m.status }) : m.why ? tr('The test was not delivered: {reason}', { reason: m.why }) : tr('The test was not delivered'));
        break;
      case 'policy': S.allow = m.allow || {}; renderPage(); break;
      case 'scr.answer': case 'scr.ice': answerIn('scr', m); break;
      case 'scr.state':
        S.scr.status = m.status;
        if (m.status.startsWith('error')) { toast(m.status.replace(/^error: /, '')); stopScr(true); }
        if (m.status === 'off' && S.scr.on) { if (m.why) toast(m.why); stopScr(true); }
        presentBar();
        refresh('send');
        break;
      case 'dev.state': S.devs = { can: m.can || {}, state: m.state || {} }; refresh('overview'); break;
      case 'dev.error': toast(tr('Could not {action}: {reason}', { action: m.do, reason: m.why })); break;
      case 'mount': S.mount = m; refresh('mount'); break;
      case 'media.state': S.media = m; paintMedia(); refresh('background', 'overview'); break;
      default: break;
    }
    if (m.t === 'welcome' || m.t === 'paired') {
      clearInterval(pingTimer);
      lastPong = performance.now();
      const ping = () => {
        // On the cable and no answer for a while: the cable came out without the socket noticing.
        if (via && performance.now() - lastPong > 8000 && !prev) { const dead = ws; ws = null; via = ''; try { dead.onclose = null; dead.close(); } catch (_) {} return connect(true); }
        send({ t: 'ping', at: performance.now(), rtt: S.rtt });
      };
      ping();
      pingTimer = setInterval(ping, 5000);
      if (S.notifsOn === false && load().notifs !== false) send({ t: 'notifs', on: true });
      send({ t: 'vis', hidden: document.hidden });
      syncPush();
      takeShared();
      setTimeout(probeCable, 500);
      if (pendingGo) { const g = pendingGo; pendingGo = null; goTo(g); }
      paintMedia();
    }
  }
  document.addEventListener('visibilitychange', () => {
    send({ t: 'vis', hidden: document.hidden });
    if (!document.hidden) {
      setBadge(0);
      send({ t: 'seen' });
      if (S.creds && !ws) { tries = 0; connect(); }
      if (overlay) lockScreen(true);
    }
  });
  addEventListener('online', () => { tries = 0; connect(); });

  // ---------------------------------------------------------------- the frame
  const PAGES = [
    { id: 'overview', title: tr('Overview'), icon: 'overview', c: ['#8E8E93', '#636366'], g: 1 },
    { id: 'connection', title: tr('Connection'), icon: 'link', c: ['#30D158', '#248A3D'], g: 1 },
    { id: 'receive', title: tr('Receive screen'), short: tr('Screen'), icon: 'display', c: ['#5AC8FA', '#0A84FF'], g: 2 },
    { id: 'send', title: tr('Send screen'), icon: 'cast', c: ['#64D2FF', '#5E5CE6'], g: 2 },
    { id: 'remote', title: tr('Remote'), icon: 'remote', c: ['#BF5AF2', '#8944AB'], g: 3 },
    { id: 'clipboard', title: tr('Clipboard'), icon: 'clipboard', c: ['#64D2FF', '#30B0C7'], g: 4 },
    { id: 'notifications', title: tr('Notifications'), short: tr('Alerts'), icon: 'bell', c: ['#FF6961', '#FF3B30'], g: 4 },
    { id: 'files', title: tr('Files'), icon: 'files', c: ['#64D2FF', '#0A84FF'], g: 4 },
    { id: 'drop', title: tr('Drop'), icon: 'drop', c: ['#FFB340', '#FF9500'], g: 4 },
    { id: 'mount', title: tr('Mount'), icon: 'drive', c: ['#AEAEB2', '#636366'], g: 4 },
    { id: 'sound', title: tr('Sound'), icon: 'audio', c: ['#FF6482', '#FF2D55'], g: 5 },
    { id: 'camera', title: tr('Camera'), icon: 'camera', c: ['#BF5AF2', '#8944AB'], g: 5 },
    { id: 'background', title: tr('Background'), icon: 'moon', c: ['#7D7AFF', '#5E5CE6'], g: 6 },
    { id: 'shortcuts', title: tr('Shortcuts'), icon: 'bolt', c: ['#FF6482', '#BF5AF2'], g: 6 },
    { id: 'general', title: tr('General'), icon: 'general', c: ['#AEAEB2', '#636366'], g: 'bottom' },
    { id: 'about', title: tr('About'), icon: 'about', c: ['#64D2FF', '#0A84FF'], g: 'bottom' },
  ];
  const PAGE = Object.fromEntries(PAGES.map((p) => [p.id, p]));
  const BOTTOM = ['overview', 'receive', 'files', 'drop'];
  let cur = 'overview';
  let more = false;
  const built = new Map(); // id -> {el, render}
  let topEl = null, navEl = null, sheetEl = null, sideEl = null;
  const pcName = () => (S.pc && S.pc.name) || (S.serving && S.serving.name) || tr('your computer');
  const online = () => S.conn === 'online';

  function frame() {
    const root = $('root');
    const wide = wideQ.matches;
    document.documentElement.classList.toggle('wide', wide && !!S.creds);
    document.documentElement.classList.toggle('solo', wide && !S.creds);
    applyLook();
    built.clear();
    topEl = identity();
    sheetEl = el('div', { class: 'sheet' });
    if (!S.creds) {
      navEl = null;
      sideEl = null;
      root.replaceChildren(topEl, sheetEl);
    } else if (wide) {
      sideEl = el('nav', { class: 'side' });
      navEl = null;
      root.replaceChildren(sideEl, sheetEl);
    } else {
      navEl = el('nav', { class: 'nav' });
      sideEl = null;
      root.replaceChildren(topEl, sheetEl, navEl);
    }
    if (!S.creds) cur = 'overview';
    more = false;
    show(cur);
  }
  wideQ.addEventListener('change', frame);

  function identity() {
    const dot = el('span', { class: 'dot' });
    const who = el('span');
    const e = el('div', { class: 'identity' }, [
      el('img', { class: 'logo', src: logo(), alt: '' }),
      el('div', { style: 'min-width:0' }, [el('div', { class: 'name', text: 'TwinDesk' }), el('div', { class: 'who' }, [dot, who])]),
    ]);
    e.update = () => {
      dot.className = `dot${online() ? ' good' : S.conn === 'connecting' || S.conn === 'boot' ? ' warn' : ''}`;
      who.textContent = !S.creds ? (S.serving ? tr('Not connected · {name} available', { name: S.serving.name }) : tr('Not connected'))
        : online() ? [pcName(), S.link === 'USB-C' ? 'USB-C' : '', S.rtt != null ? `${S.rtt} ms` : ''].filter(Boolean).join(' · ')
          : S.conn === 'paused' ? tr('{name} · Disconnected', { name: pcName() }) : S.conn === 'offline' ? tr('{name} · Not reachable', { name: pcName() }) : tr('{name} · Connecting…', { name: pcName() });
    };
    e.update();
    return e;
  }
  const renderTop = () => { if (topEl) topEl.update(); if (cur === 'overview' || cur === 'connection') renderPage(); };

  function renderNav() {
    if (navEl) {
      navEl.replaceChildren(...[...BOTTOM, 'more'].map((id) => {
        const on = id === 'more' ? more || !BOTTOM.includes(cur) : !more && cur === id;
        const p = PAGE[id] || { title: tr('More'), icon: 'more' };
        const count = id === 'more' && S.unseen ? el('i', { class: 'count', text: String(Math.min(99, S.unseen)) }) : null;
        const live = id === 'receive' && S.screen.on ? el('span', { class: 'dot' }) : null;
        return el('button', { class: on ? 'on' : '', onclick: () => (id === 'more' ? showMore() : show(id)) }, [
          el('span', { class: 'pill' }, [icon(p.icon, 24), count, live]), el('span', { text: p.short || p.title }),
        ]);
      }));
    }
    if (sideEl) {
      const kids = [topEl];
      let g = null;
      for (const p of PAGES) {
        if (p.g === 'bottom' && g !== 'bottom') kids.push(el('div', { class: 'sep' }));
        else if (g !== null && p.g !== g) kids.push(el('div', { class: 'group' }));
        g = p.g;
        kids.push(el('button', { class: `nav-item${cur === p.id ? ' on' : ''}`, onclick: () => show(p.id) }, [tile(p.icon, p.c, 26), el('span', { class: 'label', text: p.title }), navState(p.id)]));
      }
      sideEl.replaceChildren(...kids);
    }
  }
  function navState(id) {
    if (id === 'notifications' && S.unseen) return el('span', { class: 'state', text: String(S.unseen) });
    const on = (id === 'receive' && S.screen.on) || (id === 'camera' && S.cam.on) || (id === 'sound' && (S.listening || S.mic.on)) || (id === 'background' && kaOn);
    return on ? el('span', { class: 'state on' }) : null;
  }

  function show(id) {
    if (!PAGE[id]) id = 'overview';
    if (cur === 'remote' && id !== 'remote') send({ t: 'remote.release' });
    cur = id;
    more = false;
    if (id === 'notifications') S.unseen = 0;
    let v = built.get(id);
    if (!v) {
      const page = el('div', { class: 'page' });
      const render = (S.creds ? BUILD[id] : BUILD.promo)(page) || (() => {});
      v = { el: page, render };
      built.set(id, v);
    }
    sheetEl.replaceChildren(v.el);
    const narrow = !wideQ.matches;
    sheetEl.classList.toggle('gap', narrow && !!S.creds && id !== 'overview');
    if (narrow && S.creds) topEl.hidden = id !== 'overview';
    v.el.scrollTop = 0;
    renderPage();
    renderNav();
  }
  const go = show;
  let pendingGo = null;
  // A clipboard alert tapped: what was copied on the computer goes onto this device's clipboard.
  // Browsers let a page write the clipboard only while it's in front (Safari: inside a tap), so when
  // the write isn't allowed straight away, one tap on the banner does it.
  let copyWant = false;
  async function copyLatest() {
    copyWant = false;
    const t = S.clip && S.clip.text;
    if (!t) { copyWant = true; return; } // the computer's clipboard comes with the welcome
    if (document.hasFocus() && (await copyText(t))) { haptic(); return toast(tr('Copied from {name}', { name: pcName() })); }
    const bar = el('div', { class: 'copy-bar' }, [
      el('span', { text: tr('Copied on {name}: {text}', { name: pcName(), text: t.replace(/\s+/g, ' ').slice(0, 80) }) }),
      btn(tr('Copy'), async () => { bar.remove(); await copy(t, tr('Copied')); }, 'small primary'),
      btn(tr('Dismiss'), () => bar.remove(), 'small'),
    ]);
    document.querySelectorAll('.copy-bar').forEach((x) => x.remove());
    document.body.append(bar);
    setTimeout(() => bar.remove(), 20000);
  }
  function goTo(g) {
    if (g === 'copy') { show('clipboard'); return void copyLatest(); }
    if (g === 'touchpad') return openRemote('pad');
    if (PAGE[g]) show(g);
  }

  function showMore() {
    more = true;
    if (!wideQ.matches) topEl.hidden = true;
    sheetEl.classList.add('gap');
    const page = el('div', { class: 'page' }, [head(tr('More'))]);
    let g = null;
    let rows = [];
    const flush = () => { if (rows.length) page.append(card('', rows)); rows = []; };
    for (const p of PAGES.filter((x) => !BOTTOM.includes(x.id))) {
      if (g !== null && p.g !== g) flush();
      g = p.g;
      const r = row(p.title, '', [navState(p.id), el('span', { class: 'chev', text: '›' })], () => show(p.id));
      r.classList.add('more-row');
      r.prepend(tile(p.icon, p.c, 30));
      rows.push(r);
    }
    flush();
    sheetEl.replaceChildren(page);
    renderNav();
  }

  // What the computer turned off for this device (its pages in TwinDesk there): said at the top of the page.
  const POLICY = {
    receive: [['screen', tr('Viewing the screen')]], sound: [['sound', tr('Computer audio')], ['mic', tr('The microphone')]],
    clipboard: [['clipOut', tr('Receiving the clipboard')], ['clipIn', tr('Sending the clipboard')]], notifications: [['notifs', tr('Notifications')]],
    files: [['files', tr('Sending files')]], camera: [['camera', tr('The camera')]], remote: [['control', tr('Control')]], send: [['share', tr('Sharing this screen')]],
  };
  function policyNote(v) {
    const off = (POLICY[cur] || []).filter(([k]) => S.allow && S.allow[k] === false).map(([, label]) => label);
    if (!v.policy) { v.policy = el('div', { class: 'note warn policy' }); v.el.prepend(v.policy); }
    v.policy.hidden = !off.length || !S.creds;
    v.policy.textContent = off.length === 1 ? tr('{what} is turned off for this {device} on {name}. Turn it on in TwinDesk there, on this device’s page.', { what: off[0], device: ME.kind, name: pcName() })
      : off.length ? tr('{what} and {last} are turned off for this {device} on {name}. Turn them on in TwinDesk there, on this device’s page.', { what: off.slice(0, -1).join(', '), last: off[off.length - 1], device: ME.kind, name: pcName() }) : '';
  }
  function renderPage() {
    if (topEl) topEl.update();
    const v = built.get(cur);
    if (v && !more) { try { policyNote(v); v.render(); } catch (e) { console.error(e); } }
  }
  function refresh(...ids) {
    if (!more && ids.includes(cur)) renderPage();
    if (ids.some((i) => ['notifications', 'receive', 'camera', 'sound', 'background'].includes(i))) renderNav();
  }
  function render() { renderTop(); renderNav(); renderPage(); }
  const offlineNote = () => note(S.conn === 'paused' ? (S.paused === 'computer' ? tr('Disconnected on {name}. Still paired: Connect when you want it back.', { name: pcName() }) : tr('Disconnected. Still paired: Connect when you want it back.')) : S.conn === 'offline' ? tr('{name} is not reachable. Make sure TwinDesk is open on it and both devices are on the same network.', { name: pcName() }) : tr('Connecting to {name}…', { name: pcName() }), 'warn');
  const needOnline = () => { if (online()) return true; toast(tr('Not connected to {name}', { name: pcName() })); return false; };
  const statusText = () => (online() ? [tr('Connected'), S.link === 'USB-C' ? 'USB-C' : '', S.rtt != null ? `${S.rtt} ms` : '', S.secure ? tr('Secure') : ''].filter(Boolean).join(' · ')
    : S.conn === 'paused' ? (S.paused === 'computer' ? tr('Disconnected on {name}', { name: pcName() }) : tr('Disconnected')) : S.conn === 'offline' ? tr('Not reachable') : tr('Connecting…'));
  const osName = (os) => ({ mac: 'macOS', win: 'Windows', linux: 'Linux' }[os] || '');
  const chev = () => el('span', { class: 'chev', text: '›' });
  const link = (text, fn) => el('a', { href: '#', class: 'act', text, onclick: (e) => { e.preventDefault(); fn(); } });

  // ---------------------------------------------------------------- the pages
  const BUILD = {};

  // The two devices and the link between them.
  let heroWas = null; // kept across rebuilds of the page, so the moment it connects is seen
  function hero() {
    const line = el('div', { class: 'line' }, [el('span', { class: 'pulse' })]);
    const ltxt = el('div', { class: 'txt' });
    const meN = el('span', { class: 'nm' });
    const pcN = el('span', { class: 'nm' });
    const msg = el('div', { class: 'hero-msg' });
    const btns = el('div', { class: 'hero-btns' });
    const meDev = ME.mobile ? el('div', { class: 'phone' }) : el('div', { class: 'comp' }, [el('div', { class: 'screen' }), el('div', { class: 'base' })]);
    const e = el('div', { class: 'hero' }, [
      el('div', { class: 'hero-devs' }, [
        el('div', { class: 'dev' }, [meDev, meN]),
        el('div', { class: 'link' }, [line, ltxt]),
        el('div', { class: 'dev' }, [el('div', { class: 'comp' }, [el('div', { class: 'screen' }), el('div', { class: 'base' })]), pcN]),
      ]),
      msg, btns,
    ]);
    e.update = (buttons, text) => {
      meN.textContent = load().name || ME.model;
      pcN.textContent = pcName();
      line.className = `line${online() ? ' up' : S.conn === 'connecting' || S.conn === 'boot' ? '' : ' idle'}`;
      // Just connected: the line fills in and both pictures light up once.
      if (online() && heroWas === false) {
        e.classList.remove('just');
        void e.offsetWidth;
        e.classList.add('just');
        setTimeout(() => e.classList.remove('just'), 1600);
        haptic();
      }
      heroWas = online();
      ltxt.textContent = statusText();
      msg.textContent = text || '';
      msg.hidden = !msg.textContent;
      if (buttons) btns.replaceChildren(...buttons);
      btns.hidden = !btns.children.length;
    };
    return e;
  }

  // ---- Not paired: product overview, pairing, downloads ----
  BUILD.promo = (page) => {
    const boxes = el('div', { class: 'code-boxes' });
    const input = el('input', { inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6', autocomplete: 'one-time-code', 'aria-label': tr('Pairing code') });
    const goBtn = btn(tr('Connect'), null, 'primary big');
    const err = note('', 'bad');
    // The six boxes are made once, the input stays where it is: moving a focused input (iOS) drops
    // its keyboard, so the code couldn't be typed.
    const cells = [0, 1, 2, 3, 4, 5].map(() => el('span'));
    boxes.replaceChildren(...cells, input);
    const paint = () => {
      const v = input.value.replace(/\D/g, '').slice(0, 6);
      if (v !== input.value) input.value = v;
      cells.forEach((c, i) => {
        c.textContent = v[i] || '';
        c.className = i === Math.min(v.length, 5) && document.activeElement === input ? 'cur' : '';
      });
      goBtn.disabled = v.length !== 6;
    };
    boxes.onclick = () => input.focus();
    input.oninput = () => { paint(); if (input.value.length === 6) submit(); };
    input.onfocus = input.onblur = paint;
    const submit = () => { if (input.value.length === 6) { S.pairErr = ''; pair(input.value); goBtn.textContent = tr('Connecting…'); setTimeout(() => { goBtn.textContent = tr('Connect'); }, 3000); } };
    goBtn.onclick = submit;
    if (S.pairCode) input.value = S.pairCode;
    paint();
    // A QR code from the computer's TwinDesk Web page: its code (and, for another computer, its address).
    const scanBtn = btn(tr('Scan QR Code'), () => scanQr((text) => {
      let u = null;
      try { u = new URL(text); } catch (_) { return toast(tr('That isn’t a TwinDesk QR code')); }
      const h = new URLSearchParams(u.hash.slice(1));
      const code = (h.get('pair') || '').replace(/\D/g, '').slice(0, 6);
      if (code.length !== 6) return toast(tr('That isn’t a TwinDesk QR code'));
      const host = h.get('h');
      const here = (S.serving && S.serving.host) || location.hostname;
      if (host && host !== here && u.host !== location.host) return location.assign(u.href); // another computer
      input.value = code;
      paint();
      submit();
    }), 'big', 'camera');
    const installBox = installFirst();
    const serve = el('div', { class: 'desc' });
    const F = [
      ['display', ['#5AC8FA', '#0A84FF'], tr('Screen sharing'), tr('View and control your computer, with audio')],
      ['files', ['#64D2FF', '#0A84FF'], tr('File transfer'), tr('Send and receive files in both directions')],
      ['clipboard', ['#64D2FF', '#30B0C7'], tr('Shared clipboard'), tr('Copy on one device, paste on the other')],
      ['remote', ['#BF5AF2', '#8944AB'], tr('Remote control'), tr('Trackpad, keyboard and gamepad')],
      ['bell', ['#FF6961', '#FF3B30'], tr('Notifications'), tr('Computer notifications on your lock screen')],
      ['camera', ['#BF5AF2', '#8944AB'], tr('Camera and microphone'), tr('Use this device as a webcam')],
    ];
    const promo = el('div', { class: 'promo' }, [
      el('img', { class: 'logo', src: logo(), alt: '' }),
      el('h1', { text: 'TwinDesk' }),
      el('p', { text: tr('Your computers and phone, working as one: screen, files, clipboard and input, shared across devices. Free and open source.') }),
    ]);
    const connect = card(tr('Connect to a computer'), [el('div', { class: 'pair-box' }, [serve, installBox, boxes, goBtn, scanBtn, err,
      el('div', { class: 'desc', text: ME.mobile ? tr('On the computer, open TwinDesk › TwinDesk Web. Scan the QR code with your camera or enter the six-digit code above.') : tr('On the computer, open TwinDesk › TwinDesk Web. Scan the QR code or enter the six-digit code above.') })])]);
    const feat = el('div', { class: 'feat' }, F.map(([i, c, t, d]) => el('div', {}, [tile(i, c, 34), el('b', { text: t }), el('span', { text: d })])));
    const dl = downloads();
    const peers = peerBar();
    if (wideQ.matches) page.replaceChildren(peers, el('div', { class: 'promo-grid' }, [el('div', { class: 'promo-main' }, [promo, feat, dl]), el('div', { class: 'aside' }, [el('div', { class: 'aside-gap' }), connect])]));
    else page.replaceChildren(peers, promo, connect, feat, dl);
    return () => {
      serve.textContent = S.serving ? tr('{name} is ready to pair. You only need to pair once.', { name: S.serving.name }) : tr('You only need to pair once.');
      peers.update();
      err.textContent = S.pairErr;
      err.hidden = !S.pairErr;
      installBox.update();
      paint();
    };
  };

  // ---- Install before pairing ----
  // An iPhone's Home Screen app keeps its own storage, apart from Safari's: paired in Safari, the app
  // opens unpaired. So on an iPhone or iPad the page offers the Home Screen first and waits to pair;
  // the app then opens with this pairing code (the manifest's start_url). Elsewhere the installed app
  // shares the browser's storage: Install is offered, pairing goes on either way.
  const HOLD_KEY = 'twindesk.web.pairHere';
  const holdForInstall = () => ME.apple && !STANDALONE && !S.creds && sessionStorage.getItem(HOLD_KEY) !== '1';
  function pendingFrag() {
    const h = new URLSearchParams();
    if (S.pairCode) h.set('pair', S.pairCode);
    const q = hashParams();
    for (const k of ['h', 'p', 'hop']) if (q.get(k)) h.set(k, q.get(k));
    return h.toString();
  }
  // Paired on the plain page: the dashboard offers the secure one (the steps are on Connection).
  const secLater = () => { try { return Date.now() - (Number(localStorage.getItem('twindesk.web.secureLater')) || 0) < 3 * 864e5; } catch (_) { return false; } };
  function secureOffer() {
    const box = el('div', { class: 'card install-card' });
    const LATER = 'twindesk.web.secureLater';
    box.update = () => {
      let later = 0;
      try { later = Number(localStorage.getItem(LATER)) || 0; } catch (_) {}
      box.hidden = S.secure || !S.creds || location.protocol !== 'http:' || Date.now() - later < 3 * 864e5;
      if (box.hidden || box.firstChild) return;
      box.replaceChildren(tile('lock', ['#30d158', '#248a3d'], 40),
        el('div', { class: 'ic-text' }, [el('b', { text: tr('Set up a secure connection') }), el('div', { class: 'desc', text: STANDALONE ? tr('For the camera, screen sharing, alerts and the clipboard. Takes a minute, once. Then add TwinDesk again from the secure address.') : tr('For the camera, screen sharing, alerts and the clipboard. Takes a minute, once, before adding TwinDesk as an app.') })]),
        el('div', { class: 'ic-btns' }, [btn(tr('Set Up'), () => go('connection'), 'small primary'), link(tr('Not now'), () => { try { localStorage.setItem(LATER, String(Date.now())); } catch (_) {} box.hidden = true; })]));
    };
    return box;
  }

  // Paired, but in the browser: the dashboard offers the app (it opens paired: the address it's added
  // with carries the pairing). Not now hides it for a week.
  function installCard() {
    const box = el('div', { class: 'card install-card' });
    const LATER = 'twindesk.web.installLater';
    box.update = () => {
      let later = 0;
      try { later = Number(localStorage.getItem(LATER)) || 0; } catch (_) {}
      const can = ME.apple || MAC_SAFARI || !!installEvt;
      box.hidden = STANDALONE || !S.creds || !can || Date.now() - later < 7 * 864e5 || (location.protocol === 'http:' && !S.secure && !skipSecure() && !secLater());
      if (box.hidden) return;
      const notNow = link(tr('Not now'), () => { try { localStorage.setItem(LATER, String(Date.now())); } catch (_) {} box.hidden = true; });
      const how = ME.apple ? el('div', { class: 'desc', html: tr('Tap <b>Share</b> in Safari, then <b>Add to Home Screen</b>. It opens connected, with alerts on the Lock Screen.') })
        : MAC_SAFARI ? el('div', { class: 'desc', html: tr('In Safari’s menu bar, choose <b>File › Add to Dock</b>. It opens connected, in its own window.') })
          : el('div', { class: 'desc', text: tr('It opens connected in its own window, with alerts and the share menu.') });
      box.replaceChildren(tile('down', ['#64d2ff', '#0a84ff'], 40), el('div', { class: 'ic-text' }, [el('b', { text: tr('Install TwinDesk for {name}', { name: pcName() }) }), how]),
        el('div', { class: 'ic-btns' }, [ME.apple || MAC_SAFARI ? null : installBtn(), notNow].filter(Boolean)));
    };
    return box;
  }

  // Before the app is added: the secure connection first (the app keeps the address it's added from, and
  // the camera, screen sharing and alerts need the secure one), then the app. Skip keeps it plain.
  const SKIP_SECURE = 'twindesk.web.skipSecure';
  const skipSecure = () => { try { return sessionStorage.getItem(SKIP_SECURE) === '1'; } catch (_) { return false; } };
  function installFirst() {
    const box = el('div', { class: 'install-first' });
    box.update = () => {
      if (STANDALONE || S.creds) { box.hidden = true; return; }
      if (location.protocol === 'http:' && !skipSecure() && (ME.mobile || MAC_SAFARI || installEvt)) {
        box.hidden = false;
        box.replaceChildren(
          el('b', { text: tr('First, set up a secure connection') }),
          el('div', { class: 'desc', text: ME.apple ? tr('Once per computer. The camera, screen sharing and alerts need it, and the Home Screen app opens on it.') : MAC_SAFARI ? tr('Once per computer. The camera, screen sharing and alerts need it, and the Dock app opens on it.') : tr('Once per computer. The camera, screen sharing and alerts need it, and the installed app opens on it.') }),
          el('ol', {}, secureSteps()),
          link(tr('Skip for now'), () => { try { sessionStorage.setItem(SKIP_SECURE, '1'); } catch (_) {} box.update(); }),
        );
        return;
      }
      const frag = pendingFrag();
      const m = $('manifest');
      if (m && frag) m.href = `/manifest.webmanifest?h=${encodeURIComponent(frag)}`; // the app opens with the code
      if (frag && location.hash.slice(1) !== frag) history.replaceState(null, '', `/#${frag}`);
      if (MAC_SAFARI) {
        box.hidden = false;
        box.replaceChildren(
          el('b', { text: tr('Add TwinDesk to the Dock') }),
          el('ol', {}, [
            el('li', { html: tr('In Safari’s menu bar, choose <b>File › Add to Dock</b>, then <b>Add</b>.') }),
            el('li', { text: tr('Open TwinDesk from the Dock: it pairs there and stays connected.') }),
          ]),
          el('div', { class: 'desc', text: tr('The Dock app keeps its own sign-in, apart from Safari.') }),
        );
      } else if (ME.apple) {
        const hold = holdForInstall();
        box.hidden = false;
        box.replaceChildren(
          el('b', { text: hold ? tr('First, add TwinDesk to your Home Screen') : tr('Add TwinDesk to your Home Screen') }),
          el('ol', {}, [
            el('li', { html: tr('Tap <b>Share</b> (the square with an arrow) in Safari.') }),
            el('li', { html: tr('Choose <b>Add to Home Screen</b>, then <b>Add</b>.') }),
            el('li', { text: tr('Open TwinDesk from the Home Screen: it pairs there and stays connected.') }),
          ]),
          el('div', { class: 'desc', text: tr('The Home Screen app keeps its own sign-in, apart from Safari, so pair it inside the app.') }),
          hold ? link(tr('Pair here in Safari instead'), () => { sessionStorage.setItem(HOLD_KEY, '1'); render(); if (S.pairCode && S.pairCode.length === 6) pair(S.pairCode); }) : null,
        );
      } else {
        const b = installBtn();
        box.hidden = b.hidden;
        box.replaceChildren(el('b', { text: tr('Install TwinDesk as an app') }), el('div', { class: 'desc', text: tr('It opens like an app, with alerts and shortcuts.') }), b);
      }
    };
    box.update();
    return box;
  }

  // ---- QR scanner: the camera where the page may use it (https), else a photo of the code ----
  let jsQrLoad = null;
  const loadJsQr = () => jsQrLoad || (jsQrLoad = new Promise((ok, no) => {
    const sc = document.createElement('script');
    sc.src = '/vendor/jsQR.js';
    sc.onload = () => (window.jsQR ? ok(window.jsQR) : no(new Error('no decoder')));
    sc.onerror = () => { jsQrLoad = null; no(new Error(tr('the decoder didn’t load'))); };
    document.head.append(sc);
  }));
  const decodeFrom = (jsQR, src, w, h) => {
    const k = Math.min(1, 1024 / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0, cw, ch);
    const r = jsQR(g.getImageData(0, 0, cw, ch).data, cw, ch, { inversionAttempts: 'attemptBoth' });
    return r && r.data;
  };
  function scanQr(done) {
    const live = !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    if (!live) return scanPhoto(done);
    const video = el('video', { class: 'qr-video', playsinline: '', muted: '', autoplay: '' });
    video.muted = true;
    video.setAttribute('playsinline', '');
    const close = btn(tr('Cancel'), () => stop(), 'big');
    const photo = link(tr('Use a photo instead'), () => { stop(); scanPhoto(done); });
    const sheet = el('div', { class: 'qr-sheet' }, [
      el('div', { class: 'qr-frame' }, [video, el('div', { class: 'qr-aim' })]),
      el('div', { class: 'desc', text: tr('Point the camera at the QR code in TwinDesk Web on the computer.') }),
      photo, close,
    ]);
    document.body.append(sheet);
    let stream = null;
    let on = true;
    const stop = () => { on = false; if (stream) stream.getTracks().forEach((t) => t.stop()); sheet.remove(); };
    Promise.all([loadJsQr(), navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })]).then(([jsQR, st]) => {
      stream = st;
      if (!on) return stop();
      video.srcObject = st;
      video.play().catch(() => {});
      const tick = () => {
        if (!on) return;
        if (video.readyState >= 2 && video.videoWidth) {
          const text = decodeFrom(jsQR, video, video.videoWidth, video.videoHeight);
          if (text) { stop(); return done(text); }
        }
        setTimeout(() => requestAnimationFrame(tick), 120);
      };
      tick();
    }, (e) => { stop(); toast(e && e.name === 'NotAllowedError' ? tr('Camera access is off: use a photo of the code') : tr('The camera isn’t available here')); scanPhoto(done); });
  }
  function scanPhoto(done) {
    const pick = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: '' });
    document.body.append(pick);
    pick.onchange = async () => {
      const f = pick.files && pick.files[0];
      pick.remove();
      if (!f) return;
      try {
        const jsQR = await loadJsQr();
        const img = await createImageBitmap(f);
        const text = decodeFrom(jsQR, img, img.width, img.height);
        if (text) done(text); else toast(tr('No QR code in that photo'));
      } catch (e) { toast(tr('Couldn’t read that photo')); }
    };
    pick.click();
  }

  // The newest published release's IPA on GitHub (its address, kept for this visit), or '' (none, or offline).
  let ipaAsk = null;
  function latestIpa() {
    if (ipaAsk) return ipaAsk;
    try { const k = sessionStorage.getItem('twindesk.web.ipa'); if (k) return (ipaAsk = Promise.resolve(k)); } catch (_) {}
    ipaAsk = fetch('https://api.github.com/repos/InukaAsith/TwinDesk/releases?per_page=15', { headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        for (const rel of Array.isArray(list) ? list : []) {
          const a = !rel.draft && (rel.assets || []).find((x) => /\.ipa$/i.test(x.name || ''));
          if (a && a.browser_download_url) {
            try { sessionStorage.setItem('twindesk.web.ipa', a.browser_download_url); } catch (_) {}
            return a.browser_download_url;
          }
        }
        return '';
      })
      .catch(() => '');
    return ipaAsk;
  }

  function downloads() {
    const v = (S.pc && S.pc.version) || (S.serving && S.serving.version) || '';
    const R = 'https://github.com/InukaAsith/TwinDesk/releases';
    const f = (name) => (v ? `${R}/download/v${v}/${name.replace(/\{v\}/g, v)}` : `${R}/latest`);
    const L = [
      ['macOS', 'Apple silicon', f('TwinDesk-{v}-arm64.dmg')],
      ['macOS', 'Intel', f('TwinDesk-{v}-x64_Intel.dmg')],
      ['Windows', tr('Installer (x64)'), f('TwinDesk-Setup-{v}.exe')],
      ['Linux', 'Debian / Ubuntu (.deb)', f('TwinDesk-{v}-amd64.deb')],
      ['Linux', 'AppImage', f('TwinDesk-{v}-x86_64.AppImage')],
      ['Android', 'APK', f('TwinDesk-{v}.apk')],
    ];
    // iPhone and iPad: the newest release on GitHub with an IPA (not every release has one yet).
    const ipa = el('a', { href: `${R}`, target: '_blank', rel: 'noopener' }, [el('b', { text: 'iPhone / iPad' }), el('span', { text: tr('IPA, to sideload with SideStore or AltStore') })]);
    latestIpa().then((u) => { if (u) ipa.href = u; });
    return card(tr('Download TwinDesk'), [
      el('div', { class: 'dl' }, [...L.map(([a, b, href]) => el('a', { href, target: '_blank', rel: 'noopener' }, [el('b', { text: a }), el('span', { text: b })])), ipa]),
      row(tr('All releases'), tr('Free and open source under GPL-3.0'), [chev()], () => window.open(R, '_blank')),
    ], v ? el('span', { class: 'muted act', text: tr('Version {version}', { version: v }) }) : null);
  }

  // ---- Overview: the computer, its actions, and what's happening ----
  BUILD.overview = (page) => {
    page.classList.add('wide-page');
    const name = el('h2');
    const status = el('div', { class: 'dv-status' });
    const dot = el('span', { class: 'dot' });
    const stText = el('span');
    status.append(dot, stText);
    const actions = el('div', { class: 'dv-actions' });
    const facts = el('dl', { class: 'dv-facts' });
    const hero = el('div', { class: 'dv-hero' }, [
      el('div', { class: 'dv-pic' }, [el('div', { class: 'screen' }), el('div', { class: 'base' })]),
      el('div', { class: 'dv-main' }, [name, status, actions]),
      facts,
    ]);
    const off = el('div');
    // Now playing on the computer.
    const art = el('div', { class: 'art' }, [icon('audio')]);
    const npT = el('b'), npA = el('span');
    const ctl = (ic, cmd) => el('button', { type: 'button', 'aria-label': cmd, onclick: () => { haptic(); send({ t: 'media.do', cmd }); } }, [icon(ic)]);
    const playB = ctl('play', 'toggle');
    const np = card(tr('Now playing'), [el('div', { class: 'np' }, [art, el('div', { class: 't' }, [npT, npA]), el('div', { class: 'ctl' }, [ctl('prev', 'previous'), playB, ctl('next', 'next')])])]);
    np.classList.add('span');
    const clipText = el('div', { class: 'clip-text' });
    const clip = card(tr('Clipboard'), [el('div', { class: 'pad16' }, [clipText, el('div', { class: 'two' }, [
      btn(tr('Copy'), () => copy(S.clip.text), 'soft', 'copy'),
      btn(tr('Send clipboard'), () => pastePhone(), '', 'up'),
    ])])], link(tr('History'), () => go('clipboard')));
    const nList = el('div', { class: 'card mini-list' });
    const notifs = el('div', { class: 'card-wrap' }, [el('div', { class: 'card-title' }, [el('span', { text: tr('Latest notifications') }), link(tr('See all'), () => go('notifications'))]), nList]);
    const fList = el('div', { class: 'card mini-list' });
    const files = el('div', { class: 'card-wrap' }, [el('div', { class: 'card-title' }, [el('span', { text: tr('Recent files') }), link(tr('See all'), () => go('files'))]), fList]);
    const zone = el('div', { class: 'dropzone slim', onclick: () => pickFiles() }, [icon('up', 28), el('b', { text: tr('Drop files here') }), el('span', { text: tr('or click to choose') })]);
    const sendCard = card(tr('Send files'), [zone]);
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files.length) upload([...e.dataTransfer.files], true); };
    const btSw = sw((v) => send({ t: 'dev.do', do: 'bluetooth', on: v }));
    const dndSw = sw((v) => send({ t: 'dev.do', do: 'dnd', on: v }));
    const btRow = row(tr('Bluetooth'), '', [btSw]);
    const dndRow = row(tr('Do Not Disturb'), '', [dndSw]);
    const controls = card(tr('Controls'), [btRow, dndRow]);
    // The clipboard and Send files side by side first, at iPad and desktop widths alike; then the rest in pairs.
    const grid = el('div', { class: 'ov-grid' }, [clip, sendCard, np, notifs, files, controls]);
    const inst = installCard();
    const secOffer = secureOffer();
    page.append(hero, off, secOffer, inst, grid);
    return () => {
      inst.update();
      secOffer.update();
      const can = (S.devs && S.devs.can) || {};
      const st = (S.devs && S.devs.state) || {};
      const ringing = !!st.ringing;
      name.textContent = pcName();
      dot.className = `dot${online() ? ' good' : S.conn === 'offline' || S.conn === 'paused' ? '' : ' warn'}`;
      stText.textContent = [statusText(), osName(S.pc && S.pc.os)].filter(Boolean).join(' · ');
      const A = online() ? [
        btn(tr('Show screen'), () => openViewer(), 'primary', 'display'),
        btn(tr('Send files'), () => pickFiles(), '', 'up'),
        can.ring && btn(ringing ? tr('Stop ringing') : tr('Ring'), () => { haptic(); send({ t: 'dev.do', do: ringing ? 'ringStop' : 'ring' }); st.ringing = !ringing; renderPage(); }, ringing ? 'on' : '', 'ring'),
        can.lock && btn(tr('Lock'), () => { haptic(); send({ t: 'dev.do', do: 'lock' }); toast(tr('Locking {name}', { name: pcName() })); }, '', 'lock'),
        can.sleep && btn(tr('Sleep'), () => { haptic(); send({ t: 'dev.do', do: 'sleep' }); toast(tr('Putting {name} to sleep', { name: pcName() })); }, '', 'sleep'),
        btn(tr('Disconnect'), () => disconnectHere(), '', 'stop'),
      ] : S.conn === 'paused' ? [
        btn(tr('Connect'), () => reconnect(), 'primary'),
        btn(tr('Use another computer'), () => forgetHere()),
      ] : [
        btn(tr('Try again'), () => { tries = 0; connect(); }, 'primary'),
        btn(tr('Use another computer'), () => forgetHere()),
      ];
      actions.replaceChildren(...A.filter(Boolean));
      const F = [
        [tr('Connection'), [S.link, S.secure ? tr('Secure') : tr('Not secure')].filter(Boolean).join(' · ')],
        [tr('Latency'), online() && S.rtt != null ? `${S.rtt} ms` : '—'],
        [tr('Address'), (S.pc && S.pc.ips && S.pc.ips[0]) || location.hostname],
        ['TwinDesk', (S.pc && S.pc.version) || '—'],
      ];
      facts.replaceChildren(...F.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
      off.replaceChildren(...(online() ? [] : [offlineNote()]));
      const m = S.media || {};
      np.hidden = !(S.pc && S.pc.media && m.title && online());
      npT.textContent = m.title || '';
      npA.textContent = [m.artist, m.album].filter(Boolean).join(' — ');
      art.style.backgroundImage = m.art ? `url("${m.art}")` : '';
      art.firstChild.style.display = m.art ? 'none' : '';
      playB.replaceChildren(icon(m.playing === false ? 'play' : 'pause'));
      clipText.textContent = S.clip.text || tr('The clipboard is empty');
      clipText.classList.toggle('muted', !S.clip.text);
      clip.hidden = !online();
      const N = S.notifs.slice(0, 3);
      nList.replaceChildren(...N.map((n) => row([n.appName, n.title].filter(Boolean).join(' · ') || tr('Notification'), String(n.body || '').slice(0, 90), [el('span', { class: 'muted', style: 'font-size:12px', text: ago(n.at) })])));
      notifs.hidden = !N.length;
      const fl = S.chat.filter((x) => x.file).slice(-3).reverse();
      fList.replaceChildren(...fl.map((x) => fileRow(x)));
      files.hidden = !fl.length;
      sendCard.hidden = !online() || (ME.mobile && !IPAD);
      btRow.hidden = !can.bluetooth;
      dndRow.hidden = !can.dnd;
      btSw.checked = !!st.bluetooth;
      dndSw.checked = !!st.dnd;
      controls.hidden = !online() || (!can.bluetooth && !can.dnd);
      // A card alone in the grid takes the whole width.
      grid.classList.toggle('one', [...grid.children].filter((c) => !c.hidden).length < 2);
    };
  };

  // ---- Connection ----
  BUILD.connection = (page) => {
    const h = hero();
    const hd = head(tr('Connection'));
    const status = valueRow(tr('Status'));
    const rtt = valueRow(tr('Latency'));
    const sec = valueRow(tr('Security'));
    const addr = el('div');
    const setup = el('div');
    const forget = row('', '', [btn(tr('Forget'), () => forgetHere(), 'small danger')]);
    const install = row(ME.apple ? tr('Add to Home Screen') : tr('Install as an app'), '', [installBtn()]);
    const others = el('div');
    page.append(peerBar(), hd, h,
      card('', [status, rtt, sec]),
      card(tr('Addresses'), [el('div', { class: 'pad16', style: 'gap:10px' }, [addr])]),
      setup,
      card(tr('Paired computer'), [forget]),
      others,
      card('', [install]),
    );
    let othersKey = '';
    let addrKey = '';
    return () => {
      hd.desc(tr('This {device} reconnects to {name} automatically, even when either device\'s network address changes.', { device: ME.kind, name: pcName() }));
      h.update(S.conn === 'paused' ? [btn(tr('Connect'), () => reconnect(), 'primary')] : []);
      status.set([statusText().split(' · ')[0], online() && S.link ? S.link : ''].filter(Boolean).join(' · '));
      rtt.set(online() && S.rtt != null ? `${S.rtt} ms` : '');
      sec.set(S.secure ? tr('Encrypted (HTTPS)') : tr('Not encrypted'));
      const key = JSON.stringify([S.pc && S.pc.host, S.pc && S.pc.ips, location.host]);
      if (key !== addrKey) {
        addrKey = key;
        const port = (S.pc && S.pc.port) || Number(location.port) || 47870;
        const L = [];
        if (S.pc && S.pc.host) L.push([tr('Secure address (recommended)'), `https://${S.pc.host}:${port}/`]);
        if (S.pc && S.pc.host) L.push([tr('By name (keeps working when the computer’s address changes)'), `http://${S.pc.host}:${port + 1}/`]);
        for (const ip of (S.pc && S.pc.ips) || []) L.push([tr('Local address ({ip})', { ip }), `http://${ip}:${port + 1}/`]);
        if (!L.length) L.push([tr('This page'), location.origin + '/']);
        addr.replaceChildren(...L.map(([l, u]) => el('div', {}, [el('div', { class: 'muted', style: 'font-size:12.5px', text: l }), copyBox(() => u)])));
      }
      if (!setup.firstChild && !S.secure) setup.append(secureCard());
      const rest = (S.peers || []).filter((x) => !x.self);
      const ok = JSON.stringify(rest.map((x) => [x.id, x.name, x.ip, x.port]));
      if (ok !== othersKey) {
        othersKey = ok;
        others.replaceChildren(...(rest.length ? [card(tr('Other computers on this network'), [
          ...rest.map((x) => row(x.name, [osName(x.os), x.host].filter(Boolean).join(' · '), [btn(tr('Open'), () => openPeer(x), 'small')])),
          el('div', { class: 'pad16 desc', text: tr('Each computer is paired separately. Opening another one keeps this {device} paired with {name}.', { device: ME.kind, name: pcName() }) }),
        ])] : []));
      }
      forget.setLabel(pcName());
      forget.setHint(S.pc && S.pc.version ? tr('Paired · TwinDesk {version}. Forgetting removes the pairing on both devices.', { version: S.pc.version }) : tr('Paired. Forgetting removes the pairing on both devices.'));
      install.setHint(STANDALONE ? tr('Installed. TwinDesk opens connected without pairing again.')
        : ME.apple ? tr('In Safari, tap Share › Add to Home Screen. Required for notifications on iPhone and iPad.')
          : MAC_SAFARI ? tr('In Safari’s menu bar, choose File › Add to Dock.')
          : tr('Opens TwinDesk in its own window and adds it to the share menu.'));
    };
  };

  // Install prompt (Chrome, Edge, Android): the browser's own, when it offers one.
  let installEvt = null;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; refresh('connection', 'shortcuts', 'overview'); });
  function installBtn() {
    const b = btn(tr('Install'), async () => {
      if (!installEvt) return;
      installEvt.prompt();
      try { await installEvt.userChoice; } catch (_) {}
      installEvt = null;
      b.hidden = true;
    }, 'small primary');
    b.hidden = !installEvt || STANDALONE;
    addEventListener('beforeinstallprompt', () => { b.hidden = STANDALONE; });
    return b;
  }

  function secureSteps() {
    const steps = ME.apple ? [
      el('li', {}, [el('a', { href: '/twindesk.mobileconfig', text: tr('Download the TwinDesk profile') }), '.']),
      el('li', { html: tr('Open Settings › <b>Profile Downloaded</b> and tap Install.') }),
      el('li', { html: tr('Go to Settings › General › About › <b>Certificate Trust Settings</b> and turn on TwinDesk.') }),
    ] : ME.os === 'android' ? [
      el('li', {}, [el('a', { href: '/twindesk.cer', text: tr('Download the TwinDesk certificate') }), '.']),
      el('li', { html: tr('Open Settings › Security › More security settings › Encryption &amp; credentials › <b>Install a certificate</b> › CA certificate, and select the file.') }),
    ] : ME.os === 'mac' ? [
      // A profile, as on iPhone: System Settings installs it and trusts it in one go. (Double-clicking a
      // .cer imports into the default keychain, which fails with -25294 when that's iCloud or Local Items.)
      el('li', {}, [el('a', { href: '/twindesk.mobileconfig', text: tr('Download the TwinDesk profile') }), '.']),
      el('li', { html: tr('Open System Settings › General › <b>Device Management</b> (on older macOS: Privacy &amp; Security › <b>Profiles</b>), double-click TwinDesk and click <b>Install</b>.') }),
      el('li', {}, trNodes('Or with Keychain Access: {download}, choose File › Import Items, pick the {login} keychain, then double-click it and set Trust to Always Trust.', { download: el('a', { href: '/twindesk.cer', text: tr('download the certificate') }), login: el('b', { text: 'login' }) })),
    ] : [
      el('li', {}, [el('a', { href: '/twindesk.cer', text: tr('Download the TwinDesk certificate') }), '.']),
      el('li', { text: ME.os === 'win' ? tr('Open the file and choose Install Certificate › Current User › Trusted Root Certification Authorities.') : tr('Import it into your browser’s certificate settings as a certificate authority.') }),
    ];
    steps.push(el('li', {}, [btn(tr('Switch to the secure address'), () => secureNow(), 'small primary')]));
    return steps;
  }
  function secureCard() {
    const steps = secureSteps();
    return card(tr('Set up a secure connection'), [
      el('div', { class: 'pad16', style: 'padding-bottom:0' }, [el('div', { class: 'muted', text: tr('Required for the camera, microphone, notifications and clipboard access. It also keeps the address the same when the computer changes networks.') })]),
      el('ol', { class: 'steps' }, steps),
      row(tr('About this certificate'), tr('It is valid only for this computer’s .local name and private network addresses. It cannot be used for websites.')),
    ]);
  }

  function fileRow(x, extra) {
    const r = row(x.file.name, x.from === 'pc' ? tr('From {name} · {size} · {ago}', { name: pcName(), size: bytes(x.file.size), ago: ago(x.at) }) : tr('Sent · {size} · {ago}', { size: bytes(x.file.size), ago: ago(x.at) }), [
      ...(extra || []),
      x.from === 'pc' ? saveBtn(x) : el('span', { class: 'muted', text: '✓' }),
    ]);
    const ext = el('span', { class: 'ext', text: (x.file.name.split('.').pop() || 'file').slice(0, 4) });
    if (isImage(x.file.name) && !/heic$/i.test(x.file.name)) ext.replaceChildren(el('img', { src: fileUrl(x, true), alt: '', loading: 'lazy', onerror: function () { this.remove(); } }));
    r.prepend(ext);
    return r;
  }
  const fileUrl = (x, view) => `/api/f/${encodeURIComponent(x.file.fid)}?t=${encodeURIComponent(S.creds.token)}${view ? '&view=1' : ''}`;
  const isImage = (n) => /\.(jpe?g|png|gif|webp|heic|bmp)$/i.test(n);

  // Saving a file: on a phone, the share sheet (Save Image puts a photo in Photos; Save to Files);
  // elsewhere, a download. The share sheet needs the tap it came from: the file is fetched first,
  // so a large one asks for a second tap.
  const blobs = new Map();
  function saveBtn(x) {
    if (!(ME.mobile && navigator.canShare)) return el('a', { class: 'btn small soft', href: fileUrl(x), download: x.file.name, text: tr('Save') });
    const b = btn(tr('Save'), null, 'small soft');
    b.onclick = () => shareFile(x, b);
    return b;
  }
  async function shareFile(x, b) {
    // A big file goes straight to the browser's downloads (Files on an iPhone): read into memory for
    // the share sheet first, it would take as long again and may not fit.
    if (x.file.size > 80 * 1024 * 1024 && !/\.(jpe?g|png|gif|webp|heic|mov|mp4)$/i.test(x.file.name)) { location.href = fileUrl(x); return; }
    const ready = blobs.get(x.file.fid);
    if (ready) {
      try { await navigator.share({ files: [ready] }); } catch (e) { if (e.name !== 'AbortError') location.href = fileUrl(x); }
      return;
    }
    if (b) b.textContent = '…';
    try {
      const r = await fetch(fileUrl(x));
      const blob = await r.blob();
      const f = new File([blob], x.file.name, { type: blob.type || 'application/octet-stream' });
      if (!navigator.canShare({ files: [f] })) { location.href = fileUrl(x); return; }
      blobs.set(x.file.fid, f);
      try {
        await navigator.share({ files: [f] });
      } catch (e) {
        if (e.name === 'NotAllowedError') toast(tr('Ready. Tap Save again.'));
        else if (e.name !== 'AbortError') location.href = fileUrl(x);
      }
    } catch (_) {
      location.href = fileUrl(x);
    } finally {
      if (b) b.textContent = tr('Save');
    }
  }

  // ---- Receive screen ----
  const QUALITY = { auto: [1440, 14], high: [2160, 24], medium: [1080, 10], low: [720, 5] };
  BUILD.receive = (page) => {
    const hd = head(tr('Receive screen'));
    const openB = el('button', { class: 'btn primary big', onclick: () => openViewer() }, [icon('display'), tr('Open screen')]);
    const status = note('');
    const modeSeg = seg([['mirror', tr('Mirror')], ['extend', tr('Extend')]], () => prefs.mode, (v) => { prefs.mode = v; savePrefs(); if (overlay && overlay.kind === 'viewer') startScreen(); renderPage(); });
    const modeRow = row(tr('Display mode'), '', [modeSeg]);
    const ctlSw = sw((v) => { prefs.control = v; savePrefs(); });
    const fullSw = sw((v) => { prefs.full = v; savePrefs(); });
    const soundSw = sw((v) => { prefs.sound = v; savePrefs(); toFrame('viewer', optsFor('viewer')); });
    // Steady takes a new session (viewer.js leaves the playout-delay extension out of its answer).
    const paceSeg = seg([['fast', tr('Lowest latency')], ['smooth', tr('Smooth')], ['steady', tr('Steady')]], () => prefs.pacing, (v) => { const was = prefs.pacing; prefs.pacing = v; savePrefs(); toFrame('viewer', optsFor('viewer')); if ((was === 'steady') !== (v === 'steady') && overlay && overlay.kind === 'viewer') startScreen(); });
    const qSeg = seg([['low', '720p'], ['medium', '1080p'], ['auto', '1440p'], ['high', '4K']], () => prefs.quality, (v) => { prefs.quality = v; savePrefs(); if (overlay && overlay.kind === 'viewer') startScreen(); });
    const touchSeg = seg([['pad', tr('Trackpad')], ['direct', tr('Direct')]], () => prefs.touch, (v) => { prefs.touch = v; savePrefs(); toFrame('viewer', optsFor('viewer')); });
    const tapSw = sw((v) => { prefs.tap = v; savePrefs(); toFrame('viewer', optsFor('viewer')); });
    const penSw = sw((v) => { prefs.pen = v; savePrefs(); toFrame('viewer', optsFor('viewer')); });
    const speed = el('input', { type: 'range', min: '0.4', max: '3', step: '0.1', style: 'width:150px' });
    speed.onchange = () => { prefs.speed = Number(speed.value); savePrefs(); toFrame('viewer', optsFor('viewer')); };
    const st = { status: valueRow(tr('Status')), picture: valueRow(tr('Resolution')), mode: valueRow(tr('Mode')), rtt: valueRow(tr('Latency')) };
    const ctlRow = row(tr('Allow control'), '', [ctlSw]);
    const fullRow = row(tr('Open in full screen'), tr('Hides the browser interface while viewing'), [fullSw]);
    const penRow = row(ME.apple ? tr('Apple Pencil input') : tr('Stylus input'), tr('Sends pressure and tilt for drawing apps. When off, the stylus works like a finger.'), [penSw]);
    page.append(
      hd,
      el('div', { class: 'stack', style: 'margin-bottom:18px' }, [openB, status]),
      card(tr('Display'), [modeRow, ctlRow, fullRow]),
      card(tr('Video and audio'), [row(tr('Audio'), tr('Play the computer’s audio with the video'), [soundSw]), row(tr('Playback'), tr('Lowest latency for interaction; Smooth for video on busy networks'), [paceSeg]), row(tr('Resolution'), '', [qSeg])]),
      card(tr('Touch input'), [
        row(tr('Touch mode'), tr('Trackpad moves the pointer like a laptop trackpad. Direct places it under your finger.'), [touchSeg]),
        row(tr('Tap to click'), '', [tapSw]),
        row(tr('Pointer speed'), '', [speed]),
        penRow,
      ]),
      card(tr('Session'), Object.values(st)),
    );
    return () => {
      hd.desc(tr('View and control {name} from this {device}.', { name: pcName(), device: ME.kind }));
      openB.disabled = !online();
      openB.lastChild.textContent = overlay && overlay.kind === 'viewer' ? tr('Return to screen') : tr('Open screen');
      const ext = !!(S.pc && S.pc.extend);
      modeSeg.hidden = !ext;
      modeRow.setHint(!ext ? tr('Mirror only. Extend requires a newer version of TwinDesk on the computer.') : prefs.mode === 'extend' ? tr('Adds a separate display to {name} for this {device}', { name: pcName(), device: ME.kind }) : tr('Shows {name}’s main display', { name: pcName() }));
      const locked = !!(S.pc && S.pc.control === false);
      ctlRow.setHint(locked ? tr('Turned off in TwinDesk on {name}', { name: pcName() }) : tr('Send touch, keyboard and stylus input to the computer'));
      ctlSw.checked = prefs.control && !locked;
      ctlSw.disabled = locked;
      fullRow.hidden = !document.fullscreenEnabled;
      fullSw.checked = prefs.full;
      soundSw.checked = prefs.sound;
      tapSw.checked = prefs.tap;
      penSw.checked = prefs.pen;
      penRow.hidden = !(ME.mobile || navigator.maxTouchPoints > 0);
      speed.value = prefs.speed;
      paceSeg.paint(); qSeg.paint(); touchSeg.paint(); modeSeg.paint();
      const s = S.screen.status;
      status.textContent = !online() ? (S.conn === 'offline' ? tr('{name} is not reachable', { name: pcName() }) : tr('Connecting…')) : s.startsWith('error') ? s.replace(/^error: /, '') : '';
      status.hidden = !status.textContent;
      status.className = `note${s.startsWith('error') ? ' bad' : ' warn'}`;
      const live = s === 'live' || s === 'connected';
      st.status.set(s === 'off' ? tr('Not viewing') : live ? tr('Live') : s.startsWith('error') ? tr('Stopped') : tr('Starting…'));
      st.picture.set(S.picture ? `${S.picture[0]} × ${S.picture[1]}` : '');
      st.mode.set(s === 'off' ? '' : prefs.mode === 'extend' && ext ? tr('Extended display') : tr('Mirrored display'));
      st.rtt.set(online() && S.rtt != null ? `${S.rtt} ms` : '');
    };
  };

  // ---- Send screen ----
  BUILD.send = (page) => {
    const hd = head(tr('Send screen'));
    const body = el('div');
    page.append(hd, body);
    return () => {
      const name = pcName();
      hd.desc(tr('Show this {device}’s screen on {name}.', { device: ME.kind, name }));
      let share = null;
      if (CAN_SHARE) {
        const vt = S.scr.stream && S.scr.stream.getVideoTracks()[0];
        const audio = sw((on) => { prefs.scrAudio = on; savePrefs(); });
        audio.checked = prefs.scrAudio !== false;
        audio.disabled = S.scr.on;
        const prev = el('video', { class: 'present-prev', muted: true, playsinline: true, autoplay: true });
        prev.muted = true;
        if (S.scr.stream) { prev.srcObject = S.scr.stream; prev.play().catch(() => {}); }
        const stage = S.scr.on
          ? el('div', { class: 'present-stage' }, [prev, el('div', { class: 'present-live' }, [el('span', { class: 'dot' + (S.scr.status === 'live' ? ' on' : '') }), S.scr.status === 'live' ? tr('Live on {name}', { name }) : tr('Connecting…')])])
          : el('div', { class: 'present-stage idle', onclick: () => { if (needOnline()) startScr(); } }, [tile('share', PAGE.send.c, 54), el('b', { text: tr('Present to {name}', { name }) }), el('span', { class: 'muted', text: ME.os === 'android' ? tr('Shares this phone’s screen in a window there.') : tr('Choose a screen, a window or a tab. It opens in a window there.') })]);
        share = el('div', {}, [
          stage,
          el('div', { class: S.scr.on && !ME.mobile ? 'two' : 'one', style: 'margin:14px 0 18px;display:grid' }, S.scr.on
            ? [ME.mobile ? null : btn(tr('Share another'), () => switchScr(), 'big', 'display'), btn(tr('Stop presenting'), () => stopScr(), 'big danger')].filter(Boolean)
            : [btn(tr('Start presenting'), () => { if (needOnline()) startScr(); }, 'primary big', 'share')]),
          card('', [
            row(tr('Share audio'), S.scr.on ? (S.scr.stream && S.scr.stream.getAudioTracks().length ? tr('Sound is going. Change it next time you start.') : tr('No sound in this share. Change it next time you start.')) : ME.os === 'android' ? tr('Where Android allows it (Android 10 and later, for apps that let it).') : tr('The tab’s sound, or the whole computer’s where the browser offers it (Chrome and Edge on Windows and ChromeOS).'), [audio]),
            S.scr.on && vt ? row(tr('Showing'), scrWhat(vt).replace(/^./, (c) => c.toUpperCase())) : null,
          ].filter(Boolean)),
        ]);
      } else if (!ME.apple && !window.isSecureContext) {
        // Browsers hide screen sharing on a plain http page: it's the connection, not the browser.
        // The same panel as when it can present, with what it takes: the secure page.
        share = el('div', {}, [
          el('div', { class: 'present-stage idle', onclick: () => go('connection') }, [tile('share', PAGE.send.c, 54), el('b', { text: tr('Present to {name}', { name }) }), el('span', { class: 'muted', text: tr('Browsers allow screen sharing only on a secure page. Set it up once, then choose a screen, a window or a tab here.') })]),
          el('div', { class: 'two', style: 'margin:14px 0 18px;display:grid' }, [btn(tr('Set Up Secure Connection'), () => go('connection'), 'primary big', 'lock'), btn(tr('Switch to Secure Address'), () => secureNow(), 'big')]),
        ]);
      } else if (!ME.apple) {
        share = card('', [row(tr('This browser can’t share its screen'), ME.os === 'android' ? tr('Use Chrome for Android, or AirPlay or screen casting if the computer has it turned on.') : tr('Use Chrome, Edge or Firefox, or AirPlay if this device has it.'))]);
      }
      if (ME.apple) {
        body.replaceChildren(
          el('div', { class: 'hero', style: 'padding:26px 20px;text-align:center' }, [tile('cast', PAGE.send.c, 56), el('h2', { style: 'margin:14px 0 4px;font-size:20px', text: tr('AirPlay to {name}', { name }) }), el('div', { class: 'muted', text: S.pc && S.pc.os === 'mac' ? tr('{name} receives AirPlay when AirPlay Receiver is on in its System Settings.', { name }) : tr('{name} appears as an AirPlay receiver when AirPlay is enabled in TwinDesk.', { name }) })]),
          card(tr('Mirror your screen'), [el('ol', { class: 'steps' }, [
            el('li', { html: tr('Open <b>Control Center</b>.') }),
            el('li', { html: tr('Tap <b>Screen Mirroring</b>.') }),
            el('li', {}, trNodes('Select {name}.', { name: el('b', { text: name }) })),
            el('li', { html: tr('To stop, open Screen Mirroring again and tap <b>Stop Mirroring</b>.') }),
          ])]),
          card(tr('Play video or audio'), [el('ol', { class: 'steps' }, [
            el('li', { html: tr('In Photos, Music, YouTube or another app, tap the <b>AirPlay</b> button.') }),
            el('li', {}, trNodes('Select {name}.', { name: el('b', { text: name }) })),
          ])]),
          card('', [row(tr('{name} is not listed', { name }), S.pc && S.pc.os === 'mac' ? tr('On {name}, open System Settings › General › AirDrop & Handoff and turn on AirPlay Receiver (Allow AirPlay for: Current User, or Everyone on the same network). Both devices must be on the same network.', { name }) : tr('Enable AirPlay in TwinDesk on {name} (AirPlay & SMB). Both devices must be on the same network, or connected with a cable.', { name }))]),
        );
      } else if (ME.os === 'android') {
        body.replaceChildren(
          share,
          card('', [row(tr('TwinDesk for Android'), tr('Shares this phone’s screen and audio with {name}, and lets {name} control it.', { name }), [el('a', { class: 'btn small primary', href: 'https://github.com/InukaAsith/TwinDesk/releases/latest', target: '_blank', rel: 'noopener', text: tr('Download') })])]),
          card(tr('Screen casting'), [el('ol', { class: 'steps' }, [
            el('li', { html: tr('Open Quick Settings and tap <b>Screen cast</b> (or Smart View).') }),
            el('li', {}, trNodes('Select {name}. Casting must be enabled in TwinDesk on the computer.', { name: el('b', { text: name }) })),
          ])]),
        );
      } else {
        body.replaceChildren(share, card('', [row(tr('Install TwinDesk on this computer'), tr('TwinDesk shares this screen with {name} as an extended or mirrored display, with keyboard and mouse.', { name }))]), downloads());
      }
    };
  };

  // ---- Files ----
  BUILD.files = (page) => {
    const hd = head(tr('Files'));
    // Send: from here to the computer. Receive: what the computer sent, waiting to be saved here.
    let view = 'send';
    const tabs = seg([['send', tr('Send')], ['receive', tr('Receive')]], () => view, (v) => { view = v; shown = ''; queueMicrotask(paint); }, 'full');
    const tabsWrap = el('div', { style: 'margin-bottom:18px' }, [tabs]);
    const zone = el('div', { class: 'dropzone', onclick: () => pickFiles() }, [tile('up', PAGE.files.c, 46), el('b', { text: tr('Drop files here to send') }), el('span', { text: tr('or click to choose files') })]);
    const actions = el('div', { class: 'two', style: 'margin-bottom:18px' }, [
      el('button', { class: 'btn primary big', onclick: () => pickFiles() }, [icon('up'), tr('Choose files')]),
      el('button', { class: 'btn big', onclick: () => pickFiles('image/*,video/*') }, [icon('camera'), tr('Photos and videos')]),
    ]);
    const prog = el('div', { class: 'card' });
    const progWrap = el('div', { class: 'card-wrap' }, [el('div', { class: 'card-title', text: tr('Sending') }), prog]);
    const sent = el('div', { class: 'card' });
    const sentWrap = el('div', { class: 'card-wrap' }, [el('div', { class: 'card-title', text: tr('Sent') }), sent]);
    const wait = el('div', { class: 'card' });
    const saveAll = el('button', { class: 'muted act', text: tr('Save All') });
    const waitWrap = el('div', { class: 'card-wrap' }, [el('div', { class: 'card-title' }, [el('span', { text: tr('Waiting') }), saveAll]), wait]);
    const done = el('div', { class: 'card' });
    const doneWrap = el('div', { class: 'card-wrap' }, [el('div', { class: 'card-title' }, [el('span', { text: tr('Saved') }), el('button', { class: 'muted act', text: tr('Clear'), onclick: () => { for (const x of incoming().filter((i) => i.file.saved)) send({ t: 'chat.del', id: x.id }); } })]), done]);
    const empty = el('div', { class: 'empty' });
    const sendPart = el('div', {}, [zone, actions, progWrap, sentWrap]);
    const recvPart = el('div', {}, [waitWrap, doneWrap]);
    let depth = 0;
    page.ondragenter = (e) => { e.preventDefault(); depth++; zone.classList.add('over'); };
    page.ondragleave = () => { if (--depth <= 0) { depth = 0; zone.classList.remove('over'); } };
    page.ondragover = (e) => { e.preventDefault(); };
    page.ondrop = (e) => { e.preventDefault(); depth = 0; zone.classList.remove('over'); if (e.dataTransfer.files.length) { view = 'send'; upload([...e.dataTransfer.files]); } };
    page.append(hd, tabsWrap, sendPart, recvPart, empty);
    const files = () => S.chat.filter((x) => x.file && x.kind === 'files');
    const incoming = () => files().filter((x) => x.from === 'pc').reverse();
    // Save All: one download each on a computer; on a phone the share sheet takes them together.
    saveAll.onclick = async () => {
      const list = incoming().filter((x) => !x.file.saved);
      if (!list.length) return;
      if (ME.mobile && navigator.canShare) {
        try {
          const fs = await Promise.all(list.map(async (x) => new File([await (await fetch(fileUrl(x))).blob()], x.file.name)));
          if (navigator.canShare({ files: fs })) return void (await navigator.share({ files: fs }));
        } catch (e) { if (e && e.name === 'AbortError') return; }
      }
      list.forEach((x, i) => setTimeout(() => { const a = el('a', { href: fileUrl(x), download: x.file.name }); document.body.append(a); a.click(); a.remove(); }, i * 400));
    };
    let shown = '';
    let seen = 0;
    const paint = () => {
      const got = incoming();
      const waiting = got.filter((x) => !x.file.saved);
      // A new file from the computer: show Receive.
      if (got.length > seen && got.some((x) => !x.file.saved && Date.now() - x.at < 15000)) view = 'receive';
      seen = got.length;
      hd.desc(view === 'send'
        ? tr('Files you send are saved in {name}’s received files folder (Downloads unless changed there). To put them somewhere else, press the Paste Files shortcut (⌃⌥V) on {name}.', { name: pcName() })
        : tr('Files {name} sends from its Files page wait here until you save them. Photos and messages sent in Drop stay in Drop.', { name: pcName() }));
      tabs.paint();
      const badge = waiting.length ? ` (${waiting.length})` : '';
      tabs.children[1].textContent = tr('Receive') + badge;
      const ups = [...S.uploads.values()].filter((u) => u.to !== 'drop');
      const key = JSON.stringify([view, files().map((x) => [x.id, x.file.got, x.file.saved]), ups.map((u) => Math.round(u.sent / Math.max(1, u.size) * 50))]);
      if (key === shown) return;
      shown = key;
      sendPart.hidden = view !== 'send';
      recvPart.hidden = view !== 'receive';
      const touchOnly = ME.mobile && !IPAD;
      zone.hidden = touchOnly;
      actions.hidden = !touchOnly;
      if (view === 'send') {
        const out = files().filter((x) => x.from !== 'pc').reverse();
        prog.replaceChildren(...ups.map((u) => {
          const r = row(u.name, tr('{sent} of {size}', { sent: bytes(u.sent), size: bytes(u.size) }), [el('span', { class: 'spin' })]);
          r.querySelector('.text').append(el('div', { class: 'bar' }, [el('i', { style: `width:${Math.round(u.sent / Math.max(1, u.size) * 100)}%` })]));
          return r;
        }));
        progWrap.hidden = !ups.length;
        sent.replaceChildren(...out.slice(0, 40).map((x) => fileRow(x)));
        sentWrap.hidden = !out.length;
        empty.replaceChildren(el('div', { text: tr('Nothing sent yet. Choose files to send them to {name}.', { name: pcName() }) }));
        empty.hidden = !!(out.length || ups.length) || !touchOnly;
      } else {
        const saved = got.filter((x) => x.file.saved);
        wait.replaceChildren(...waiting.slice(0, 60).map((x) => {
          const f = x.file;
          const going = f.got > 0 && f.size && f.got < f.size;
          const r = fileRow(x, [btn(tr('Remove'), () => send({ t: 'chat.del', id: x.id }), 'small')]);
          r.setHint(going ? tr('Saving… {got} of {size}', { got: bytes(f.got), size: bytes(f.size) }) : tr('From {name} · {size} · {ago}', { name: pcName(), size: bytes(f.size), ago: ago(x.at) }));
          if (going) r.querySelector('.text').append(el('div', { class: 'bar' }, [el('i', { style: `width:${Math.round((f.got / f.size) * 100)}%` })]));
          return r;
        }));
        waitWrap.hidden = !waiting.length;
        saveAll.hidden = waiting.length < 2;
        done.replaceChildren(...saved.slice(0, 40).map((x) => {
          const r = fileRow(x, [btn(tr('Remove'), () => send({ t: 'chat.del', id: x.id }), 'small')]);
          r.setHint(tr('Saved · {size} · {ago}', { size: bytes(x.file.size), ago: ago(x.file.saved) }));
          return r;
        }));
        doneWrap.hidden = !saved.length;
        empty.replaceChildren(el('div', { text: tr('Nothing to receive. Files {name} sends from its Files page appear here.', { name: pcName() }) }));
        empty.hidden = !!got.length;
      }
    };
    return paint;
  };

  // ---- Drop ----
  BUILD.drop = (page) => {
    page.className = 'page flush';
    const thread = el('div', { class: 'thread' });
    const ta = el('textarea', { rows: '1', placeholder: tr('Message'), enterkeyhint: 'send' });
    const sendB = el('button', { class: 'round go', type: 'submit', 'aria-label': tr('Send'), disabled: true }, [icon('send')]);
    const form = el('form', { class: 'composer' }, [el('button', { class: 'round', type: 'button', 'aria-label': tr('Attach files'), onclick: () => pickFiles(null, true) }, [icon('plus')]), ta, sendB]);
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; sendB.disabled = !ta.value.trim() || !online(); };
    ta.oninput = grow;
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !ME.mobile) { e.preventDefault(); form.requestSubmit(); } };
    form.onsubmit = (e) => { e.preventDefault(); const t = ta.value.trim(); if (!t || !online()) return; send({ t: 'chat', text: t }); ta.value = ''; grow(); haptic(); };
    const hd = head(tr('Drop'), btn(tr('Paste'), () => pastePhone(true), 'small', 'clipboard'));
    hd.style.marginBottom = '4px';
    const top = el('div', { style: wideQ.matches ? 'padding:28px 40px 0' : 'padding:20px 20px 0' }, [hd]);
    page.ondragover = (e) => { e.preventDefault(); };
    page.ondrop = (e) => { e.preventDefault(); if (e.dataTransfer.files.length) upload([...e.dataTransfer.files], true, 'drop'); };
    page.append(top, thread, form);
    let shown = '';
    return () => {
      hd.desc(tr('Messages, links and files shared with {name}.', { name: pcName() }));
      const items = S.chat.filter((x) => x.kind !== 'files');
      const ups = [...S.uploads.values()].filter((u) => u.to === 'drop');
      const key = JSON.stringify([items.map((x) => x.id), ups.map((u) => [u.name, Math.round(u.sent / Math.max(1, u.size) * 50)])]);
      grow();
      if (key === shown) return;
      shown = key;
      const atEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
      const kids = [];
      let day = '';
      for (const x of items) {
        const d = new Date(x.at).toDateString();
        if (d !== day) { day = d; kids.push(el('div', { class: 'day', text: d === new Date().toDateString() ? tr('Today') : new Date(x.at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) })); }
        kids.push(bubble(x));
      }
      for (const u of ups) {
        kids.push(el('div', { class: 'msg me' }, [el('div', { class: 'file' }, [el('div', { class: 'ext', text: (u.name.split('.').pop() || '').slice(0, 4) }), el('div', { style: 'min-width:0' }, [el('div', { class: 'nm', text: u.name }), el('div', { class: 'sz', text: tr('{sent} of {size}', { sent: bytes(u.sent), size: bytes(u.size) }) }), el('div', { class: 'bar' }, [el('i', { style: `width:${Math.round(u.sent / Math.max(1, u.size) * 100)}%` })])]), el('span', { class: 'spin' })])]));
      }
      if (!kids.length) kids.push(el('div', { class: 'empty' }, [tile('drop', PAGE.drop.c, 54), el('div', { text: tr('No messages yet. Send a note, link or photo to {name}.', { name: pcName() }) })]));
      thread.replaceChildren(...kids);
      if (atEnd || ups.length) thread.scrollTop = thread.scrollHeight;
    };
  };

  function bubble(x) {
    const me = x.from === 'phone';
    const del = el('button', { text: 'Delete', onclick: () => send({ t: 'chat.del', id: x.id }) });
    const meta = el('div', { class: 'meta' }, [el('span', { text: `${me ? tr('You') : pcName()} · ${ago(x.at)}` })]);
    const save = () => (ME.mobile && navigator.canShare ? shareFile(x) : (location.href = fileUrl(x)));
    let body;
    if (x.file) {
      if (isImage(x.file.name) && !/heic$/i.test(x.file.name)) {
        body = el('a', { class: 'photo', href: fileUrl(x, true), target: '_blank' }, [el('img', { src: fileUrl(x, true), alt: x.file.name, loading: 'lazy' })]);
      } else {
        body = el('div', { class: 'file' }, [
          el('div', { class: 'ext', text: (x.file.name.split('.').pop() || 'file').slice(0, 4) }),
          el('div', { style: 'min-width:0' }, [el('div', { class: 'nm', text: x.file.name }), el('div', { class: 'sz', text: bytes(x.file.size) })]),
          me ? el('span', { class: 'muted', text: '✓' }) : el('button', { class: 'get', 'aria-label': tr('Save'), onclick: save }, [icon('down', 18)]),
        ]);
      }
      if (!me) meta.append(el('button', { text: tr('Save'), onclick: save }));
    } else {
      body = el('div', { class: 'bubble' }, [linkify(x.text || '')]);
      meta.append(el('button', { text: tr('Copy'), onclick: () => copy(x.text) }));
    }
    meta.append(del);
    return el('div', { class: `msg ${me ? 'me' : 'them'}` }, [body, meta]);
  }

  const fileInput = el('input', { type: 'file', multiple: true, hidden: true });
  document.body.append(fileInput);
  let inDrop = false;
  fileInput.onchange = () => { const f = [...fileInput.files]; fileInput.value = ''; if (f.length) upload(f, inDrop, inDrop ? 'drop' : 'files'); };
  function pickFiles(accept, drop) {
    if (!needOnline()) return;
    inDrop = !!drop;
    fileInput.accept = accept || '';
    fileInput.click();
  }
  let upSeq = 0;
  // Progress repaints at most 5 times a second: repainting on every event slows a phone's upload.
  let progT = null;
  const progressSoon = () => { if (!progT) progT = setTimeout(() => { progT = null; refresh('files', 'drop'); }, 200); };
  function upload(files, stay, to) {
    if (!needOnline()) return;
    if (!stay && cur !== 'files' && cur !== 'drop') go('files');
    for (const f of files) {
      const id = ++upSeq;
      const u = { name: f.name || 'photo.jpg', size: f.size, sent: 0, to: to === 'drop' ? 'drop' : 'files' };
      S.uploads.set(id, u);
      const x = new XMLHttpRequest();
      x.open('POST', `/api/up?name=${encodeURIComponent(u.name)}&t=${encodeURIComponent(S.creds.token)}${to === 'drop' ? '&to=drop' : ''}`);
      x.upload.onprogress = (e) => { u.sent = e.loaded; progressSoon(); };
      x.onloadend = () => {
        S.uploads.delete(id);
        if (x.status !== 200) toast(tr('Could not send {name}', { name: u.name }));
        else haptic();
        refresh('files', 'drop', 'overview');
      };
      x.send(f);
    }
    refresh('files', 'drop');
  }

  async function pastePhone(asMessage) {
    if (!needOnline()) return;
    let t = '';
    try { t = await navigator.clipboard.readText(); } catch (_) { t = ''; }
    if (!t) { go('clipboard'); return toast(tr('Paste into the text box, then tap Send')); }
    if (asMessage) send({ t: 'chat', text: t });
    else send({ t: 'clip.set', text: t });
    haptic();
    toast(asMessage ? tr('Sent to {name}', { name: pcName() }) : tr('Copied to {name}', { name: pcName() }));
  }

  // ---- Clipboard ----
  BUILD.clipboard = (page) => {
    const hd = head(tr('Clipboard'));
    const text = el('div', { class: 'clip-text' });
    const when = el('span', { class: 'muted act' });
    const box = el('textarea', { class: 'field', rows: '3', placeholder: tr('Type or paste text') });
    const sendB = btn(tr('Send'), () => { const t = box.value; if (!t) return; send({ t: 'clip.set', text: t }); box.value = ''; sendB.disabled = true; haptic(); toast(tr('Copied to {name}', { name: pcName() })); }, 'primary', 'send');
    sendB.disabled = true;
    box.oninput = () => { sendB.disabled = !box.value || !online(); };
    const hist = el('div', { class: 'card' });
    const histWrap = el('div', { class: 'card-wrap' }, [el('div', { class: 'card-title', text: tr('History') }), hist]);
    const onPc = card('', [el('div', { class: 'pad16' }, [text, btn(tr('Copy'), () => copy(S.clip.text), 'soft big', 'copy')])], when);
    const toPc = card('', [el('div', { class: 'pad16' }, [box, el('div', { class: 'two' }, [btn(tr('Paste from this device'), () => pastePhone(), '', 'clipboard'), sendB])])]);
    const tip = row(ME.apple ? tr('Copy with Back Tap') : tr('Clipboard alerts'), ME.apple ? tr('Set up a shortcut to copy the computer’s clipboard with a double tap on the back of your iPhone') : tr('Get notified when something is copied on the computer'), [chev()], () => go(ME.apple ? 'shortcuts' : 'background'));
    page.append(hd, onPc, toPc, histWrap, card('', [tip]));
    return () => {
      hd.desc(tr('Copy text between this {device} and {name}.', { device: ME.kind, name: pcName() }));
      onPc.setTitle(tr('{name}’s clipboard', { name: pcName() }));
      toPc.setTitle(tr('Send to {name}', { name: pcName() }));
      text.textContent = S.clip.text || tr('The clipboard is empty');
      text.classList.toggle('muted', !S.clip.text);
      when.textContent = S.clip.at ? ago(S.clip.at) : '';
      const h = (S.clip.history || []).slice(1, 12);
      histWrap.hidden = !h.length;
      hist.replaceChildren(...h.map((x) => row(x.text.replace(/\s+/g, ' ').slice(0, 120), `${x.from || ''} · ${ago(x.at)}`, [btn(tr('Copy'), () => copy(x.text), 'small')])));
    };
  };

  // ---- Remote ----
  BUILD.remote = (page) => {
    const hd = head(tr('Remote'));
    const why = note('', 'warn');
    page.append(
      hd, why,
      el('div', { class: 'stack', style: 'margin-bottom:18px' }, [
        el('button', { class: 'btn primary big', onclick: () => openRemote('pad') }, [icon('cursor'), tr('Trackpad and keyboard')]),
        el('button', { class: 'btn big', onclick: () => openRemote('gamepad') }, [icon('gamepad'), tr('Gamepad')]),
      ]),
      card(tr('Gestures'), [
        row(tr('Trackpad'), tr('Slide to move · Tap to click · Touch and hold to right-click · Two fingers to scroll')),
        row(tr('Gamepad'), tr('Hold the {device} in landscape. Buttons are mapped to keys on the computer and can be changed under Keys.', { device: ME.kind })),
      ]),
    );
    return () => {
      hd.desc(tr('Use this {device} as a trackpad, keyboard or gamepad for {name}.', { device: ME.kind, name: pcName() }));
      const r = S.remote;
      why.textContent = !online() ? tr('Not connected to {name}', { name: pcName() }) : r && r.allowed === false ? (r.why || tr('Remote input is turned off in TwinDesk on {name}.', { name: pcName() })) : '';
      why.hidden = !why.textContent;
    };
  };

  // ---- Notifications ----
  BUILD.notifications = (page) => {
    const on = sw((v) => { const o = load(); o.notifs = v; save(o); S.notifsOn = v; send({ t: 'notifs', on: v }); if (!v) S.notifs = []; renderPage(); });
    const hd = head(tr('Notifications'), on);
    const bg = row(tr('Lock screen alerts'), '', [chev()], () => go('background'));
    const list = el('div');
    page.append(hd, card('', [bg]), list);
    return () => {
      hd.desc(tr('Notifications from {name}.', { name: pcName() }));
      on.checked = load().notifs !== false;
      on.disabled = !online();
      bg.setHint(S.alerts && S.alerts.notifs && notifPerm() === 'granted' ? tr('On. Notifications also arrive when TwinDesk is closed.') : tr('Receive these notifications when TwinDesk is closed'));
      const items = S.notifs;
      list.replaceChildren(...(items.length ? items.map((n) => {
        const code = /\b(\d{4,8})\b/.exec(`${n.title} ${n.body}`);
        return el('div', { class: 'alert' }, [
          el('div', { class: 'aico' }, [n.icon ? el('img', { src: n.icon, alt: '' }) : (n.appName || '?').slice(0, 1)]),
          el('div', { style: 'min-width:0' }, [
            el('div', { class: 'h' }, [el('span', { text: n.appName || n.app || '' }), el('span', { text: ago(n.at) })]),
            el('div', { class: 't', text: n.title || '' }),
            n.subtitle ? el('div', { class: 'b', text: n.subtitle }) : null,
            el('div', { class: 'b', text: n.body || '' }),
            code && /code|otp|verif|password|pin/i.test(`${n.title} ${n.body}`) ? btn(tr('Copy code {code}', { code: code[1] }), () => copy(code[1]), 'small soft') : null,
          ]),
        ]);
      }) : [el('div', { class: 'empty' }, [tile('bell', PAGE.notifications.c, 54), el('div', { text: load().notifs === false ? tr('Notifications are turned off.') : (S.pc && S.pc.os === 'mac' ? tr('No notifications yet. On macOS, TwinDesk needs Full Disk Access to read notifications.') : tr('No notifications yet.')) })])]));
    };
  };

  // ---- Mount ----
  BUILD.mount = (page) => {
    const hd = head(tr('Mount'));
    const body = el('div');
    page.append(hd, body);
    let asked = false;
    return () => {
      if (!asked && online()) { asked = true; send({ t: 'mount.get' }); }
      hd.desc(ME.apple ? tr('Access {name}’s shared folder as a network drive in the Files app.', { name: pcName() }) : tr('Access {name}’s shared folder as a network drive.', { name: pcName() }));
      const m = S.mount;
      if (!m || !m.on) {
        body.replaceChildren(
          note(S.pc && S.pc.mount === false ? tr('Folder sharing is not available in this version of TwinDesk on {name}.', { name: pcName() }) : tr('Folder sharing is off. Turn it on in TwinDesk on {name} under AirPlay & SMB.', { name: pcName() }), 'info'),
          card('', [row(tr('Connection details'), tr('The server address and sign-in details appear here once sharing is on.'))]),
        );
        return;
      }
      const url = m.url || `smb://${m.host}/${encodeURIComponent(m.share || '')}`;
      const unc = `\\\\${m.host}\\${m.share || ''}`;
      const field = (label, value) => el('div', {}, [el('div', { class: 'muted', style: 'font-size:12.5px', text: label }), copyBox(() => value)]);
      const steps = ME.apple ? [
        el('li', { html: tr('Open <b>Files</b>, tap <b>•••</b> and choose <b>Connect to Server</b>.') }),
        el('li', { text: tr('Enter the server address and tap Connect.') }),
        el('li', { html: tr('Choose <b>Registered User</b>, enter the user name and password, and tap Next.') }),
        el('li', { text: tr('{name} now appears under Shared in the Files app.', { name: pcName() }) }),
      ] : ME.os === 'android' ? [
        el('li', { text: tr('Open a file manager that supports SMB, such as Solid Explorer, CX File Explorer or Material Files.') }),
        el('li', { text: tr('Add a network location (SMB) with the address, user name and password.') }),
      ] : ME.os === 'win' ? [
        el('li', {}, trNodes('In File Explorer, enter {address} in the address bar.', { address: el('span', { class: 'mono', text: unc }) })),
        el('li', { text: tr('Sign in with the user name and password. To keep it, right-click it and choose Map network drive.') }),
      ] : ME.os === 'mac' ? [
        el('li', { html: tr('In Finder, choose Go › <b>Connect to Server</b> (⌘K).') }),
        el('li', { text: tr('Enter the server address, then the user name and password.') }),
      ] : [el('li', { text: tr('In your file manager, choose Connect to Server and enter the server address.') })];
      body.replaceChildren(
        card(tr('Connection details'), [el('div', { class: 'pad16', style: 'gap:10px' }, [
          field(tr('Server address'), ME.os === 'win' ? unc : url),
          m.user ? field(tr('User name'), m.user) : null,
          m.password ? field(tr('Password'), m.password) : null,
        ])]),
        card(tr('Instructions'), [el('ol', { class: 'steps' }, steps)]),
        m.path ? card('', [row(tr('Shared folder'), m.path)]) : null,
      );
    };
  };

  // ---- Sound ----
  BUILD.sound = (page) => {
    const listen = sw((v) => (v ? startListen() : stopListen()));
    const micSw = sw((v) => (v ? startMic() : stopMic()));
    const lr = row('', '', [listen]);
    const mr = row('', '', [micSw]);
    const hd = head(tr('Sound'));
    const a = card('', [lr]);
    const b = card('', [mr]);
    page.append(hd, a, b);
    return () => {
      hd.desc(tr('Stream {name}’s audio to this {device}, or use this {device} as its microphone.', { name: pcName(), device: ME.kind }));
      a.setTitle(tr('Computer audio'));
      b.setTitle(tr('Microphone'));
      lr.setLabel(tr('Play {name}’s audio here', { name: pcName() }));
      lr.setHint(S.listening ? (S.screen.status === 'live' ? tr('Playing') : tr('Starting…')) : tr('Audio only, without the screen'));
      listen.checked = S.listening;
      listen.disabled = !online();
      mr.setLabel(tr('Use as {name}’s microphone', { name: pcName() }));
      mr.setHint(!S.secure ? tr('Requires a secure connection. Set it up under Connection.') : S.mic.on ? (S.mic.status === 'live' ? (S.mic.out ? tr('Live through {device}', { device: S.mic.out }) : tr('Live. Install a virtual audio device on the computer so apps can select it.')) : tr('Starting…')) : tr('Apps on the computer receive it through a virtual audio device'));
      micSw.checked = S.mic.on;
      micSw.disabled = !online() || !S.secure;
    };
  };

  // ---- Camera ----
  BUILD.camera = (page) => {
    const camSw = sw((v) => (v ? startCam() : stopCam()));
    const flip = btn(tr('Switch camera'), () => { S.cam.facing = S.cam.facing === 'user' ? 'environment' : 'user'; if (S.cam.on) startCam(); }, 'small');
    const r = row('', '', [flip, camSw]);
    const prev = el('video', { playsinline: true, muted: true, autoplay: true });
    prev.muted = true;
    const prevWrap = el('div', { class: 'cam-preview' }, [prev]);
    const hd = head(tr('Camera'));
    page.append(hd, card('', [r, prevWrap]));
    return () => {
      hd.desc(tr('Use this {device}’s camera on {name}. Turn on Virtual Camera in TwinDesk to use it in video calls.', { device: ME.kind, name: pcName() }));
      r.setLabel(tr('Use as {name}’s camera', { name: pcName() }));
      r.setHint(!S.secure ? tr('Requires a secure connection. Set it up under Connection.') : S.cam.on ? (S.cam.status === 'live' ? tr('Live') : tr('Starting…')) : (S.cam.facing === 'user' ? tr('Front camera') : tr('Rear camera')));
      camSw.checked = S.cam.on;
      camSw.disabled = !online() || !S.secure;
      flip.hidden = !S.cam.on || !ME.mobile;
      prevWrap.hidden = !S.cam.on;
      if (S.cam.stream && prev.srcObject !== S.cam.stream) { prev.srcObject = S.cam.stream; prev.play().catch(() => {}); }
      prev.className = S.cam.facing === 'user' ? 'mirror' : '';
    };
  };

  // ---- Background ----
  const notifPerm = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const canPush = () => S.secure && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
  BUILD.background = (page) => {
    const hd = head(tr('Background'));
    const kaSw = sw((v) => { prefs.keepAlive = v; savePrefs(); keepAlive(v); renderPage(); });
    const kaRow = row(tr('Stay connected in the background'), '', [kaSw]);
    const mediaRow = row(tr('Lock screen controls'), '');
    const locSw = sw((v) => { prefs.keepLoc = v; savePrefs(); keepLocation(v && prefs.keepAlive); renderPage(); });
    const locRow = row(tr('Also use location'), tr('Watches this device’s approximate location as a second way to stay active. The location is not sent anywhere. Uses more battery.'), [locSw]);
    const nBtn = btn(tr('Allow'), () => enablePush(), 'small primary');
    const nRow = row(tr('Notifications'), '', [nBtn]);
    const testRow = row(tr('Test notification'), tr('Sends a test alert from the computer'), [btn(tr('Send test'), () => { if (needOnline()) send({ t: 'push.test' }); }, 'small')]);
    const A = [
      ['clip', tr('Clipboard changes'), tr('When text is copied on the computer')],
      ['drop', tr('Drop messages'), ''],
      ['files', tr('Incoming files'), ''],
      ['notifs', tr('Computer notifications'), tr('Forwards each notification shown on the computer')],
      ['preview', tr('Show previews'), tr('Include the text or file name in alerts')],
      ['badge', tr('App icon badge'), tr('Shows the number of unread alerts')],
    ];
    const sws = {};
    const aRows = A.map(([k, l, h]) => {
      sws[k] = sw((v) => { S.alerts = { ...(S.alerts || {}), [k]: v }; send({ t: 'alerts', alerts: S.alerts }); if (k === 'badge' && !v) setBadge(0); });
      return row(l, h, [sws[k]]);
    });
    const why = note('', 'info');
    page.append(hd, card(tr('Connection'), [kaRow, locRow, mediaRow]), card(tr('Notifications'), [nRow, testRow]), card(tr('Alerts'), aRows), why);
    return () => {
      hd.desc(tr('Keep receiving updates from {name} while this {device} is locked or another app is open.', { name: pcName(), device: ME.kind }));
      kaSw.checked = prefs.keepAlive;
      kaRow.setHint(ME.apple
        ? tr('Plays inaudible audio so iOS keeps the connection open. Other audio pauses briefly when it starts, and battery use increases slightly.')
        : ME.os === 'android' ? tr('Plays inaudible audio so the browser does not suspend the page.')
          : tr('Prevents the browser from suspending this page. Most desktop browsers stay connected without it.'));
      mediaRow.setHint(S.pc && S.pc.media ? tr('Shows media playing on {name} with play, pause and skip controls', { name: pcName() }) : tr('Shows “Connected to {name}” on the lock screen', { name: pcName() }));
      mediaRow.hidden = !prefs.keepAlive;
      locSw.checked = !!prefs.keepLoc;
      locRow.hidden = !prefs.keepAlive || !navigator.geolocation;
      locSw.disabled = !window.isSecureContext;
      if (!window.isSecureContext) locRow.setHint(tr('Requires a secure connection. Set it up under Connection.'));
      const p = notifPerm();
      const needsHome = ME.apple && !STANDALONE;
      nRow.setHint(!S.secure ? tr('Requires a secure connection. Set it up under Connection.')
        : needsHome ? tr('On iPhone and iPad, notifications require TwinDesk on the Home Screen. In Safari, tap Share › Add to Home Screen, then open TwinDesk from there.')
          : p === 'unsupported' ? tr('This browser does not support web notifications.')
            : p === 'denied' ? tr('Blocked. Allow notifications for this site in your browser settings.')
              : p === 'granted' ? (S.push ? tr('On. Alerts arrive even when TwinDesk is closed. Both devices need internet access.') : canPush() ? tr('On while TwinDesk is open. Turn on push to receive alerts when it is closed.') : tr('On while TwinDesk is open in the background.'))
                : tr('Off'));
      nBtn.hidden = !S.secure || needsHome || p === 'unsupported' || p === 'denied' || (p === 'granted' && (S.push || !canPush()));
      nBtn.textContent = p === 'granted' ? tr('Turn on push') : tr('Allow');
      testRow.hidden = p !== 'granted';
      const a = S.alerts || {};
      for (const [k] of A) { sws[k].checked = !!a[k]; sws[k].disabled = !online(); }
      aRows[3].setLabel(tr('{name} notifications', { name: pcName() }));
      aRows[5].hidden = !('setAppBadge' in navigator);
      why.textContent = ME.apple ? tr('iOS only lets a page copy to the clipboard after a tap. Tapping a clipboard alert opens TwinDesk with the text ready to copy. To copy in one step, add the Copy from computer shortcut under Shortcuts.') : '';
      why.hidden = !why.textContent;
    };
  };

  // ---- Shortcuts ----
  // iPhone and iPad: signed shortcuts (web/shortcuts/*.shortcut, made by web/shortcuts-src). Each asks
  // for its link when it's added; Add copies this device's link first, so it's a tap and a paste.
  BUILD.shortcuts = (page) => {
    const hd = head(tr('Shortcuts'));
    const body = el('div');
    page.append(hd, body);
    let key = '';
    return () => {
      hd.desc(ME.apple ? tr('Use TwinDesk from the share sheet, Back Tap and Siri.') : tr('Use TwinDesk from the share menu, the app icon and scripts.'));
      const k = JSON.stringify([S.creds && S.creds.token, S.pc && S.pc.host, S.secure, ME.os, !!installEvt]);
      if (k === key) return;
      key = k;
      const token = (S.creds && S.creds.token) || '';
      const port = (S.pc && S.pc.port) || 47870;
      const base = S.secure && S.pc && S.pc.host ? `https://${S.pc.host}:${port}` : `http://${(S.pc && S.pc.ips && S.pc.ips[0]) || location.hostname}:${port + 1}`;
      const U = (p, extra = '') => `${base}${p}?t=${token}${extra}`;
      const warn = note(tr('Set up a secure connection first (Connection). Shortcuts then keep working when {name}’s network address changes.', { name: pcName() }), 'warn');
      warn.hidden = S.secure;
      const security = note(tr('Shortcut links include this device’s access key. Anyone with a link can use it on your network. Forgetting this device revokes them.'), '');
      if (ME.apple) {
        const sc = (ic, colors, file, title, desc, tip, url) => {
          const add = el('button', { class: 'btn big add', type: 'button', onclick: async () => {
            await copyText(url);
            haptic();
            toast(tr('Link copied. Paste it when Shortcuts asks.'));
            setTimeout(() => { location.href = `/shortcuts/${encodeURIComponent(file)}.shortcut`; }, 350);
          } }, [icon('plus'), tr('Add to Shortcuts')]);
          return el('div', { class: 'sc' }, [
            el('div', { class: 'top' }, [tile(ic, colors, 44), el('div', {}, [el('b', { text: title }), el('span', { text: desc })])]),
            add,
            tip ? el('div', { class: 'tip', text: tip }) : null,
          ]);
        };
        body.replaceChildren(
          warn,
          el('div', { class: 'sc-grid' }, [
            sc('clipboard', PAGE.clipboard.c, tr('Copy from computer'), tr('Copy from computer'), tr('Copies {name}’s clipboard to this {device}', { name: pcName(), device: ME.kind }), tr('Tip: assign it to Back Tap in Settings › Accessibility › Touch › Back Tap.'), U('/api/clip')),
            sc('up', PAGE.files.c, tr('Send clipboard'), tr('Send clipboard'), tr('Copies this {device}’s clipboard to {name}', { device: ME.kind, name: pcName() }), tr('Tip: assign it to a triple Back Tap.'), U('/api/clip')),
            sc('share', PAGE.drop.c, tr('Send to computer'), tr('Send to computer'), tr('Sends photos and files from the share sheet'), tr('Files are saved to {name}’s Downloads folder.', { name: pcName() }), U('/api/up')),
            sc('link', PAGE.send.c, tr('Send to Drop'), tr('Send to Drop'), tr('Sends links and text from the share sheet'), '', U('/api/drop')),
          ]),
          card(tr('How it works'), [el('ol', { class: 'steps' }, [
            el('li', { html: tr('Tap <b>Add to Shortcuts</b>. TwinDesk copies a link for this device.') }),
            el('li', { html: tr('In Shortcuts, tap <b>Set Up Shortcut</b> and paste the link when asked.') }),
            el('li', { text: tr('Tap Add Shortcut.') }),
          ])]),
          security,
        );
      } else if (ME.os === 'android') {
        const inst = installBtn();
        body.replaceChildren(
          card(tr('Share menu'), [row(tr('Share to TwinDesk'), STANDALONE ? tr('Share photos, files and links from any app to {name}.', { name: pcName() }) : tr('Install TwinDesk to add it to the Android share menu.'), [inst])]),
          card(tr('App shortcuts'), [row(tr('Quick actions'), tr('Touch and hold the TwinDesk icon for Send files, Clipboard and Trackpad.'))]),
          card(tr('Automation apps'), [el('div', { class: 'pad16', style: 'gap:8px' }, [
            el('div', { class: 'muted', text: tr('Use this link in Tasker, MacroDroid or HTTP Shortcuts to read (GET) or set (POST) the computer’s clipboard.') }),
            copyBox(() => U('/api/clip')),
          ])]),
          security,
        );
      } else {
        const inst = installBtn();
        body.replaceChildren(
          warn,
          card('', [row(tr('Install as an app'), tr('Opens TwinDesk in its own window'), [inst])]),
          card(tr('Command line'), [el('div', { class: 'pad16', style: 'gap:8px' }, [
            el('div', { class: 'muted', text: tr('Read {name}’s clipboard', { name: pcName() }) }), copyBox(() => `curl -s "${U('/api/clip')}"`),
            el('div', { class: 'muted', text: tr('Set the clipboard') }), copyBox(() => `echo "text" | curl -s --data-binary @- "${U('/api/clip')}"`),
            el('div', { class: 'muted', text: tr('Send a file') }), copyBox(() => `curl -s --data-binary @photo.jpg "${U('/api/up', '&name=photo.jpg')}"`),
          ])]),
          security,
        );
      }
    };
  };

  // ---- General ----
  BUILD.general = (page) => {
    const nameIn = el('input', { class: 'field', style: 'width:200px;text-align:right;padding:9px 12px;font-size:15px', placeholder: ME.model });
    nameIn.onchange = () => { const o = load(); o.name = nameIn.value.trim(); save(o); send({ t: 'rename', name: o.name || ME.model }); toast(tr('Name updated')); renderTop(); };
    const look = () => { savePrefs(); applyLook(); frame(); };
    const themeSeg = seg([['system', tr('System')], ['light', tr('Light')], ['dark', tr('Dark')]], () => prefs.theme, (v) => { prefs.theme = v; look(); });
    const sw8 = el('div', { class: 'swatches' }, ACCENTS.map((c) => el('button', { type: 'button', 'aria-label': c, style: `background:${c}`, class: prefs.accent === c ? 'on' : '', onclick: () => { prefs.accent = c; look(); } })));
    const hd = head(tr('General'));
    const nameRow = row(tr('Device name'), '', [nameIn]);
    // The language: kept in this browser (pick.js reads it before the page), and the page opens again in it.
    const langs = card(tr('Language'), LANGUAGES.map(([code, name, flag]) => row(`${flag}  ${name}`, '', code === LANG ? [icon('check')] : null, () => {
      if (code === LANG) return;
      try { localStorage.setItem('twindesk.web.lang', code); } catch (_) {}
      location.reload();
    })));
    page.append(
      hd,
      langs,
      card(tr('Appearance'), [row(tr('Theme'), '', [themeSeg]), row(tr('Accent color'), '', [sw8])]),
      card(tr('This device'), [nameRow]),
    );
    return () => {
      hd.desc(tr('Language, appearance and device settings.'));
      nameRow.setHint(tr('The name shown on {name}', { name: pcName() }));
      if (document.activeElement !== nameIn) nameIn.value = load().name || '';
    };
  };

  async function secureNow() {
    const hp = hashParams();
    const host = (S.pc && S.pc.host) || hp.get('h') || (/\.local$/.test(location.hostname) ? location.hostname : '');
    const port = (S.pc && S.pc.port) || Number(hp.get('p')) || Number(location.port) - 1;
    const frag = S.creds ? `#d=${encodeURIComponent(S.creds.id)}&k=${encodeURIComponent(S.creds.key)}` : location.hash;
    for (const base of [host && `https://${host}:${port}`, `https://${location.hostname}:${port}`].filter(Boolean)) {
      if (await reachable(base)) return location.replace(`${base}/${frag}`);
    }
    toast(ME.apple ? tr('The certificate is not trusted yet. Install the profile and enable it in Certificate Trust Settings.') : tr('The certificate is not trusted yet. Install it as a certificate authority.'));
  }

  function forgetHere() {
    if (S.creds && online()) send({ t: 'forget' });
    stopCam(true); stopMic(true); stopListen();
    unsubscribePush();
    dropCreds('');
  }

  // ---- About ----
  // About, as the apps have it: the icon and version, who made it, this device, this page, the
  // licence and the downloads.
  BUILD.about = (page) => {
    const ver = el('p', { class: 'ver' });
    const go = (u) => () => window.open(u, '_blank', 'noopener');
    const fact = (label) => valueRow(label);
    const devName = fact(tr('Name')), devModel = fact(tr('Model')), devSys = fact(tr('System')), devBrowser = fact(tr('Browser')), devScreen = fact(tr('Screen'));
    const appVer = fact(tr('Version')), appFrom = fact(tr('Served by')), appConn = fact(tr('Connection')), appMode = fact(tr('Opened as'));
    page.append(
      el('div', { class: 'promo about-hero', style: 'padding-top:6px' }, [
        el('img', { class: 'logo', src: logo(), alt: '' }),
        el('h1', { text: 'TwinDesk' }),
        ver,
        el('p', { class: 'muted', text: tr('Use your computers and phones together: screens, files, clipboard and input.') }),
        el('p', { class: 'about-by', text: tr('by Inuka Asith') }),
      ]),
      card(tr('Made by'), [
        row('Inuka Asith', tr('Designed and built TwinDesk · inukaasith.vercel.app'), [chev()], go('https://inukaasith.vercel.app')),
        row(tr('Source code'), 'github.com/InukaAsith/TwinDesk', [chev()], go('https://github.com/InukaAsith/TwinDesk')),
        row(tr('All releases'), tr('Downloads for macOS, Windows, Linux, Android and iPhone'), [chev()], go('https://github.com/InukaAsith/TwinDesk/releases')),
        row(tr('Report a problem'), tr('Issues on GitHub'), [chev()], go('https://github.com/InukaAsith/TwinDesk/issues')),
      ]),
      card(tr('This device'), [devName, devModel, devSys, devBrowser, devScreen]),
      card(tr('This app'), [
        row('TwinDesk Web', tr('Served by TwinDesk on your computer over your local network. Push notifications are end-to-end encrypted and relayed by your browser’s push service.')),
        appVer, appFrom, appConn, appMode,
      ]),
      card(tr('Licence'), [
        row(tr('GNU General Public License v3'), tr('Free and open source. Copyright © 2026 inukaasith'), [chev()], go('https://github.com/InukaAsith/TwinDesk/blob/main/LICENSE')),
        row(tr('Crafted with ☕ and ❤️ in Sri Lanka 🇱🇰'), ''),
      ]),
      downloads(),
    );
    const sys = () => {
      const ua = navigator.userAgent;
      const ios = /OS (\d+)[._](\d+)/.exec(ua);
      const and = /Android ([\d.]+)/.exec(ua);
      const mac = /Mac OS X (\d+)[._](\d+)/.exec(ua);
      const win = /Windows NT ([\d.]+)/.exec(ua);
      if (ME.os === 'ios' || ME.os === 'ipados') return (ME.os === 'ipados' ? 'iPadOS' : 'iOS') + (ios ? ` ${ios[1]}.${ios[2]}` : '');
      if (and) return `Android ${and[1]}`;
      if (mac) return `macOS ${mac[1]}.${mac[2]}`;
      if (win) return 'Windows';
      return ME.os === 'linux' ? 'Linux' : '';
    };
    const browser = () => {
      const ua = navigator.userAgent;
      const m = /(Edg|OPR|Firefox|FxiOS|CriOS|Chrome|Version)\/([\d.]+)/.exec(ua);
      const names = { Edg: 'Edge', OPR: 'Opera', Firefox: 'Firefox', FxiOS: 'Firefox', CriOS: 'Chrome', Chrome: 'Chrome', Version: 'Safari' };
      return m ? `${names[m[1]]} ${m[2].split('.').slice(0, 2).join('.')}` : '';
    };
    return () => {
      const v = (S.pc && S.pc.version) || (S.serving && S.serving.version) || '';
      ver.textContent = v ? tr('Version {version}', { version: v }) : '';
      devName.set(load().name || ME.model);
      devModel.set(ME.model);
      devSys.set(sys());
      devBrowser.set(browser());
      devScreen.set(`${screen.width} × ${screen.height} · ${Math.round((devicePixelRatio || 1) * 10) / 10}×`);
      appVer.set(v);
      appFrom.set(S.pc ? pcName() : (S.serving && S.serving.name) || '');
      appConn.set(location.protocol === 'https:' ? tr('Secure') : tr('Not secure'));
      appMode.set(STANDALONE ? tr('App') : tr('Browser tab'));
    };
  };

  // ---------------------------------------------------------------- the phone app's pages, full screen
  const frames = { viewer: null, remote: null };
  const queued = { viewer: [], remote: [] };
  let overlay = null;

  function toFrame(kind, m) {
    const w = frames[kind];
    if (w && typeof w.tdRecv === 'function') { try { w.tdRecv(m); } catch (e) { console.warn(e); } } else if (overlay && overlay.kind === kind) queued[kind].push(m);
  }

  const CONTROLS = [['lsUp', tr('Left stick up')], ['lsLeft', tr('Left stick left')], ['lsDown', tr('Left stick down')], ['lsRight', tr('Left stick right')], ['l3', 'L3'], ['r3', 'R3'],
    ['a', 'A'], ['b', 'B'], ['x', 'X'], ['y', 'Y'], ['lb', 'LB'], ['rb', 'RB'], ['lt', 'LT'], ['rt', 'RT'],
    ['up', tr('D-pad up')], ['down', tr('D-pad down')], ['left', tr('D-pad left')], ['right', tr('D-pad right')], ['back', 'Back'], ['start', 'Start']];
  const PAD_DEFAULTS = { lsUp: 'KeyW', lsLeft: 'KeyA', lsDown: 'KeyS', lsRight: 'KeyD', l3: 'ShiftLeft', r3: 'KeyV', a: 'Space', b: 'ControlLeft', x: 'KeyR', y: 'KeyE', lb: 'KeyQ', rb: 'KeyF', lt: 'Mouse1', rt: 'Mouse0', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', back: 'Tab', start: 'Escape' };
  const KEYS = [['', tr('Nothing')], ['Mouse0', tr('Left click')], ['Mouse1', tr('Right click')], ['Mouse2', tr('Middle click')],
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => [`Key${c}`, c]), ...'0123456789'.split('').map((d) => [`Digit${d}`, d]),
    ['Space', tr('Space')], ['Enter', 'Enter'], ['Escape', 'Esc'], ['Tab', 'Tab'], ['Backspace', 'Backspace'], ['ShiftLeft', 'Shift'], ['ControlLeft', 'Ctrl'], ['AltLeft', 'Alt'],
    ['ArrowUp', tr('Up arrow')], ['ArrowDown', tr('Down arrow')], ['ArrowLeft', tr('Left arrow')], ['ArrowRight', tr('Right arrow')],
    ['Minus', '-'], ['Equal', '='], ['BracketLeft', '['], ['BracketRight', ']'], ['Semicolon', ';'], ['Quote', "'"], ['Comma', ','], ['Period', '.'], ['Slash', '/'], ['Backquote', '`'],
    ...Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `F${i + 1}`]), ['Insert', 'Insert'], ['Delete', 'Delete'], ['Home', 'Home'], ['End', 'End'], ['PageUp', 'Page Up'], ['PageDown', 'Page Down']];
  const padMap = () => Object.fromEntries(CONTROLS.map(([id]) => [id, prefs.pad[id] != null ? prefs.pad[id] : PAD_DEFAULTS[id]]));
  const optsFor = (kind) => (kind === 'viewer'
    ? { t: 'opts', name: pcName(), sound: prefs.sound, pacing: prefs.pacing, touch: prefs.touch, speed: prefs.speed, tap: prefs.tap, pen: prefs.pen }
    : { t: 'opts', mode: overlay && overlay.mode, name: pcName(), me: load().name || ME.model, connected: online(), os: (S.pc && S.pc.os) || '', ble: false, speed: prefs.speed, tap: prefs.tap, smooth: true, pad: padMap(), controls: CONTROLS, keys: KEYS });

  // This device's screen in pixels, held sideways: the size of a screen of its own (Extend).
  const shape = () => {
    const d = Math.min(devicePixelRatio || 1, 3);
    const a = Math.round(screen.width * d), b = Math.round(screen.height * d);
    return { w: Math.max(a, b), h: Math.min(a, b) };
  };
  function startScreen() {
    const [maxH, mbps] = QUALITY[prefs.quality] || QUALITY.auto;
    const ext = prefs.mode === 'extend' && S.pc && S.pc.extend;
    send({ t: 'screen.start', video: true, audio: prefs.sound, mode: ext ? 'extend' : 'mirror', ...(ext ? shape() : {}), maxH, fps: 60, mbps });
  }

  window.TDHost = {
    tr: (text, vars) => { let v = {}; try { v = JSON.parse(vars || '{}'); } catch (_) {} return tr(text, v); },
    ready(kind, win) {
      frames[kind] = win;
      toFrame(kind, optsFor(kind));
      if (kind === 'remote') { send({ t: 'remote.hello' }); if (S.remote) toFrame('remote', S.remote); }
      if (kind === 'viewer') {
        toFrame('viewer', { t: 'screen.state', on: false });
        startScreen();
      }
      for (const m of queued[kind].splice(0)) toFrame(kind, m);
    },
    send(kind, json) {
      let m;
      try { m = JSON.parse(json); } catch (_) { return; }
      if (!m || typeof m.t !== 'string') return;
      if (m.t === 'pair.sync') return toast(tr('Turn on Remote in TwinDesk on {name}', { name: pcName() }));
      if (kind === 'viewer' && m.t.startsWith('in.') && !prefs.control) return;
      if (kind === 'viewer' && m.t === 'screen.start') return startScreen();
      send(m);
    },
    event(kind, name) {
      if (name === 'close') closeOverlay();
      if (name === 'padReset') { prefs.pad = {}; savePrefs(); toFrame('remote', optsFor('remote')); }
    },
    setPad(kind, id, code) { prefs.pad[id] = code; savePrefs(); toFrame('remote', optsFor('remote')); },
    playing(kind, w, h) { S.picture = w && h ? [w, h] : null; refresh('receive'); },
  };

  async function lockScreen(on) {
    try {
      if (on && navigator.wakeLock && overlay && !overlay.lock) overlay.lock = await navigator.wakeLock.request('screen');
      if (overlay && overlay.lock) overlay.lock.onrelease = () => { if (overlay) overlay.lock = null; };
    } catch (_) {}
  }

  let paintBar = () => {};
  function openOverlay(kind, mode) {
    closeOverlay(true);
    if (!needOnline()) return;
    const f = el('iframe', { src: `/td/${kind}.html`, allow: 'autoplay; fullscreen', style: 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:40;background:#000' });
    const kids = [f];
    // The viewer: the computer's monitor bar on top (Extend, Mirror, Keyboard, Stop), out of the way
    // until the handle brings it back.
    if (kind === 'viewer') {
      let kb = false;
      let hideT = null;
      const bar = el('div', { class: 'vbar' });
      const handle = el('button', { class: 'vhandle', 'aria-label': tr('Show the bar'), onclick: () => wake() });
      const wake = () => { bar.classList.remove('away'); clearTimeout(hideT); hideT = setTimeout(() => bar.classList.add('away'), 3500); };
      bar.onpointerdown = wake;
      const b = (ic, label, fn, cls = '') => el('button', { type: 'button', class: cls, onclick: () => { fn(); wake(); } }, [icon(ic), label ? el('span', { text: label }) : null]);
      paintBar = () => {
        if (!overlay || overlay.kind !== 'viewer') return;
        const ext = !!(S.pc && S.pc.extend);
        bar.replaceChildren(...[
          ext ? b('extend', tr('Extend'), () => { prefs.mode = 'extend'; savePrefs(); startScreen(); paintBar(); }, prefs.mode === 'extend' ? 'on' : '') : null,
          ext ? b('mirror', tr('Mirror'), () => { prefs.mode = 'mirror'; savePrefs(); startScreen(); paintBar(); }, prefs.mode !== 'extend' ? 'on' : '') : null,
          ext ? el('span', { class: 'sep' }) : null,
          b('keyboard', ME.mobile ? '' : tr('Keyboard'), () => { kb = !kb; toFrame('viewer', { t: 'keyboard', on: kb }); }, kb ? 'on' : ''),
          b('audio', '', () => { prefs.sound = !prefs.sound; savePrefs(); toFrame('viewer', optsFor('viewer')); paintBar(); }, prefs.sound ? 'on' : ''),
          document.fullscreenEnabled ? b('full', '', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})) : null,
          el('span', { class: 'sep' }),
          b('stop', tr('Close'), () => closeOverlay(), 'stop'),
        ].filter(Boolean));
      };
      kids.push(handle, bar);
      setTimeout(() => { paintBar(); wake(); }, 0);
      if (prefs.full && document.fullscreenEnabled && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    }
    const wrap = el('div', { class: 'overlay' }, kids);
    overlay = { kind, mode, el: wrap };
    queued[kind] = [];
    document.body.append(wrap);
    lockScreen(true);
  }

  function closeOverlay(quiet) {
    if (!overlay) return;
    const o = overlay;
    overlay = null;
    if (o.kind === 'viewer' && !quiet) send({ t: 'screen.stop' });
    if (o.kind === 'remote' && !quiet) send({ t: 'remote.release' });
    frames[o.kind] = null;
    if (o.lock) o.lock.release().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    o.el.remove();
    paintBar = () => {};
    refresh('receive');
  }

  function openViewer() {
    if (S.listening) stopListen();
    openOverlay('viewer');
  }
  function openRemote(mode) {
    openOverlay('remote', mode);
    if (mode === 'gamepad' && screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  }

  // ---------------------------------------------------------------- feel
  // Android vibrates; an iPhone has no vibrate for pages, but toggling a switch (Safari 18) taps its
  // haptic engine, inside the touch that asked.
  function haptic() {
    try {
      if (!ME.apple) { if (navigator.vibrate) navigator.vibrate(8); return; }
      const label = el('label', { 'aria-hidden': 'true', style: 'display:none' });
      const input = el('input', { type: 'checkbox' });
      input.setAttribute('switch', '');
      label.append(input);
      document.head.append(label);
      label.click();
      label.remove();
    } catch (_) {}
  }

  // ---------------------------------------------------------------- staying alive in the background
  // A silent sound, looped: iOS keeps a page that plays running (and so its socket), and shows it on
  // the lock screen, where it's what plays on the computer (with its controls) when TwinDesk there
  // says, or "Connected". Not quite silence: a whisper of noise far below hearing, as some browsers
  // treat true silence as not playing.
  let ka = null;
  let kaOn = false;
  function silentUrl() {
    const rate = 8000, n = rate * 2;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round((Math.random() - 0.5) * 6), true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  // Location, beside the audio (Background › Also use location): a page watching the position is one
  // more reason for the browser to keep it running. Coarse and infrequent; nothing is sent anywhere.
  let geoWatch = null;
  function keepLocation(on) {
    if (!on || !navigator.geolocation || !window.isSecureContext) {
      if (geoWatch !== null) { try { navigator.geolocation.clearWatch(geoWatch); } catch (_) {} geoWatch = null; }
      return;
    }
    if (geoWatch !== null) return;
    try {
      geoWatch = navigator.geolocation.watchPosition(() => {}, (e) => {
        if (e && e.code === 1) { prefs.keepLoc = false; savePrefs(); geoWatch = null; toast(tr('Location access was denied. Background mode uses audio only.')); refresh('background'); }
      }, { enableHighAccuracy: false, maximumAge: 5 * 60000, timeout: 10 * 60000 });
    } catch (_) { geoWatch = null; }
  }
  function keepAlive(on) {
    keepLocation(on && prefs.keepLoc);
    if (!on) {
      kaOn = false;
      if (ka) { ka.pause(); }
      if (navigator.mediaSession && !S.listening) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; }
      renderNav();
      return;
    }
    if (!S.creds) return;
    if (!ka) {
      ka = el('audio', { loop: true, preload: 'auto' });
      ka.setAttribute('playsinline', '');
      ka.src = silentUrl();
      document.body.append(ka);
      ka.onpause = () => { if (kaOn && !document.hidden) ka.play().catch(() => {}); };
    }
    ka.play().then(() => { kaOn = true; paintMedia(); renderNav(); refresh('background', 'overview'); }, () => { kaOn = false; armKeepAlive(); });
  }
  // Starting a sound needs a touch: the first one after the page opens.
  function armKeepAlive() {
    const go1 = () => { removeEventListener('pointerdown', go1, true); if (prefs.keepAlive) keepAlive(true); };
    addEventListener('pointerdown', go1, true);
  }
  function paintMedia() {
    const ms = navigator.mediaSession;
    if (!ms || !kaOn || S.listening) return;
    const m = (S.pc && S.pc.media && S.media) || null;
    const has = !!(m && m.title);
    try {
      ms.metadata = new MediaMetadata(has
        ? { title: m.title, artist: m.artist || '', album: m.album || tr('on {name}', { name: pcName() }), artwork: m.art ? [{ src: m.art, sizes: '512x512' }] : [{ src: '/icon.png', sizes: '512x512', type: 'image/png' }] }
        : { title: tr('Connected to {name}', { name: pcName() }), artist: 'TwinDesk', album: online() ? tr('Running in the background') : tr('Reconnecting…'), artwork: [{ src: '/icon.png', sizes: '512x512', type: 'image/png' }] });
      ms.playbackState = has && m.playing === false ? 'paused' : 'playing';
      const act = (cmd) => () => { if (has) send({ t: 'media.do', cmd }); if (ka && ka.paused) ka.play().catch(() => {}); };
      ms.setActionHandler('play', act('play'));
      ms.setActionHandler('pause', act('pause'));
      ms.setActionHandler('nexttrack', has ? act('next') : null);
      ms.setActionHandler('previoustrack', has ? act('previous') : null);
      try { ms.setActionHandler('seekbackward', null); ms.setActionHandler('seekforward', null); } catch (_) {}
    } catch (_) {}
  }

  // ---------------------------------------------------------------- notifications
  let swReg = null;
  if ('serviceWorker' in navigator && S.secure) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((r) => { swReg = r; }, (e) => console.warn('[sw]', e.message));
    navigator.serviceWorker.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.t === 'go' && m.go) { if (online()) goTo(m.go); else pendingGo = m.go; }
      if (m.t === 'shared') gotShared(m.item);
    });
  }
  function setBadge(n) {
    try {
      if (n > 0 && navigator.setAppBadge) navigator.setAppBadge(n);
      else if (navigator.clearAppBadge) navigator.clearAppBadge();
    } catch (_) {}
  }
  const b64uBytes = (s) => {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  };
  // In the tap: permission first (iOS asks only inside one), then the push subscription.
  async function enablePush() {
    if (typeof Notification === 'undefined') return toast(tr('This browser does not support web notifications'));
    let p = Notification.permission;
    if (p !== 'granted') p = await Notification.requestPermission();
    if (p !== 'granted') { renderPage(); return toast(tr('Notifications are blocked for this site')); }
    prefs.push = true;
    savePrefs();
    if (canPush()) await subscribe(true);
    renderPage();
  }
  async function subscribe(loud) {
    if (!canPush() || !S.pc || !S.pc.vapid) return false;
    try {
      const reg = swReg || (await navigator.serviceWorker.ready);
      let sub = await reg.pushManager.getSubscription();
      // A subscription for another computer's key (this page served by another one before): anew.
      const key = sub && sub.options && sub.options.applicationServerKey;
      if (sub && key && btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== S.pc.vapid) { await sub.unsubscribe(); sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(S.pc.vapid) });
      send({ t: 'push.sub', sub: sub.toJSON(), alerts: S.alerts || undefined });
      if (loud) toast(tr('Push notifications from {name} are on', { name: pcName() }));
      return true;
    } catch (e) {
      if (loud) toast(tr('Could not turn on push notifications: {error}', { error: e.message }));
      return false;
    }
  }
  // Each connection: the computer gets this device's subscription again (it may have dropped it).
  function syncPush() {
    if (prefs.push !== false && notifPerm() === 'granted' && canPush()) subscribe(false);
  }
  async function unsubscribePush() {
    try {
      const reg = swReg || (await navigator.serviceWorker.getRegistration());
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) await sub.unsubscribe();
    } catch (_) {}
  }
  // The computer's alert on the socket (no push, the page in the background): shown here.
  async function localAlert(m) {
    if (typeof m.badge === 'number' && m.badge) setBadge(m.badge);
    if (!document.hidden && m.kind !== 'test') return;
    if (notifPerm() !== 'granted') return;
    const opts = { body: m.body || '', tag: m.tag, icon: '/icon.png', badge: '/icon.png', data: { go: m.go || '' } };
    try {
      const reg = swReg || (navigator.serviceWorker && (await navigator.serviceWorker.getRegistration()));
      if (reg) return void reg.showNotification(m.title || 'TwinDesk', opts);
      const n = new Notification(m.title || 'TwinDesk', opts);
      n.onclick = () => { window.focus(); if (m.go) goTo(m.go); n.close(); };
    } catch (_) {}
  }

  // ---------------------------------------------------------------- Android's share menu
  // web/sw.js holds what was shared (the manifest's share_target) until the page, connected, takes it.
  function takeShared() {
    if (query.get('shared') !== '1' || !navigator.serviceWorker || !navigator.serviceWorker.controller) return;
    navigator.serviceWorker.controller.postMessage({ t: 'take-shared' });
    history.replaceState(null, '', location.pathname + location.hash);
    query.delete('shared');
  }
  function gotShared(s) {
    if (!s) return;
    const text = [s.title, s.text, s.url].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n').trim();
    if (s.files && s.files.length) upload(s.files);
    if (text) { send({ t: 'chat', text }); if (!s.files || !s.files.length) go('drop'); }
    toast(tr('Sent to {name}', { name: pcName() }));
  }

  // ---------------------------------------------------------------- sound only
  let lpc = null;
  let lpending = null;
  const laudio = el('audio', { autoplay: true });
  laudio.setAttribute('playsinline', '');
  document.body.append(laudio);
  function startListen() {
    if (overlay && overlay.kind === 'viewer') closeOverlay();
    S.listening = true;
    laudio.muted = false;
    laudio.play().catch(() => {}); // in the tap: iOS lets this element play from now on
    send({ t: 'screen.start', video: false, audio: true });
    if (navigator.mediaSession) navigator.mediaSession.metadata = new MediaMetadata({ title: tr('{name} audio', { name: pcName() }), artist: 'TwinDesk', artwork: [{ src: '/icon.png', sizes: '512x512', type: 'image/png' }] });
    refresh('sound');
  }
  function stopListen() {
    if (!S.listening) return;
    S.listening = false;
    send({ t: 'screen.stop' });
    if (lpc) lpc.close();
    lpc = null;
    laudio.srcObject = null;
    paintMedia();
    refresh('sound');
  }
  async function listenMsg(m) {
    if (m.t === 'stream.stop') { if (lpc) lpc.close(); lpc = null; return; }
    if (m.t === 'rtc.offer') {
      if (lpc) lpc.close();
      const pc = new RTCPeerConnection({ iceServers: [] });
      lpc = pc;
      lpending = [];
      pc.ontrack = (e) => { laudio.srcObject = new MediaStream([e.track]); laudio.play().catch(() => toast(tr('Tap the audio switch again to start playback'))); };
      pc.onicecandidate = (e) => e.candidate && send({ t: 'rtc.ice', session: m.session, candidate: e.candidate.toJSON() });
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      for (const c of lpending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      lpending = null;
      await pc.setLocalDescription(await pc.createAnswer());
      send({ t: 'rtc.answer', session: m.session, sdp: pc.localDescription.sdp });
    } else if (m.t === 'rtc.ice' && lpc && m.candidate) {
      if (lpending) lpending.push(m.candidate);
      else lpc.addIceCandidate(m.candidate).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- this device's camera and microphone
  const outs = { cam: null, mic: null, scr: null };
  // This device's screen on the computer (browsers that share a screen: Android Chrome, desktop browsers).
  const CAN_SHARE = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !ME.apple;
  // As Meet and Teams share: the browser's picker (a screen, a window or a tab, with its sound where the
  // browser has it), a preview here, a "You're presenting" bar on every page, and Share another one
  // that swaps what's shown without starting over.
  // As sharp and as smooth as the computer asks for it (its Receive screen page), else up to 4K at 30.
  const pickScreen = () => navigator.mediaDevices.getDisplayMedia({
    video: (() => {
      const h = Number(S.allow && S.allow.scrMaxH) || 2160, f = Number(S.allow && S.allow.scrFps) || 30;
      return { frameRate: { ideal: f, max: Math.max(f, 30) }, width: { max: Math.round(h * 16 / 9) }, height: { max: h } };
    })(),
    audio: prefs.scrAudio !== false ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    systemAudio: prefs.scrAudio !== false ? 'include' : 'exclude', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', monitorTypeSurfaces: 'include',
  });
  const scrWhat = (vt) => {
    const st = (vt && vt.getSettings && vt.getSettings()) || {};
    return st.displaySurface === 'browser' ? tr('a tab') : st.displaySurface === 'window' ? tr('a window') : ME.os === 'android' ? tr('this phone’s screen') : tr('your screen');
  };
  async function startScr() {
    if (!S.secure && location.hostname !== 'localhost') return toast(tr('Sharing the screen requires a secure connection. Set it up under Connection.'));
    try {
      const stream = await pickScreen();
      S.scr = { on: true, stream, status: 'connecting' };
      const vt = stream.getVideoTracks()[0];
      if (vt) { vt.contentHint = 'detail'; vt.onended = () => stopScr(); }
      await offerOut('scr', stream);
      haptic();
    } catch (e) {
      if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast(tr('Screen: {error}', { error: e.message }));
      stopScr(true);
    }
    refresh('send', 'overview');
    presentBar();
  }
  // Another screen, window or tab, on the same connection (replaceTrack: the computer's window stays).
  async function switchScr() {
    const o = outs.scr;
    if (!o || !S.scr.on) return startScr();
    let stream;
    try { stream = await pickScreen(); } catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast(tr('Screen: {error}', { error: e.message })); return; }
    const old = S.scr.stream;
    const senders = o.pc.getSenders();
    let renegotiate = false;
    for (const kind of ['video', 'audio']) {
      const t = stream.getTracks().find((x) => x.kind === kind) || null;
      const sd = senders.find((x) => x.track && x.track.kind === kind) || senders.find((x) => !x.track && x._kind === kind);
      if (sd) { sd._kind = kind; await sd.replaceTrack(t).catch(() => {}); } else if (t) { o.pc.addTrack(t, stream); renegotiate = true; }
    }
    const vt = stream.getVideoTracks()[0];
    if (vt) { vt.contentHint = 'detail'; vt.onended = () => stopScr(); }
    S.scr.stream = stream;
    if (old) old.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    if (renegotiate) await offerOut('scr', stream);
    refresh('send', 'overview');
    presentBar();
  }
  function stopScr(quiet) {
    if (!S.scr.on && !S.scr.stream) return;
    if (!quiet) send({ t: 'scr.stop' });
    if (outs.scr) outs.scr.pc.close();
    outs.scr = null;
    if (S.scr.stream) S.scr.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    S.scr = { on: false, stream: null, status: 'off' };
    refresh('send', 'overview');
    presentBar();
  }
  // The bar, on every page while sharing.
  let bar = null;
  function presentBar() {
    if (!S.scr.on) { if (bar) { bar.remove(); bar = null; } document.documentElement.classList.remove('presenting'); return; }
    if (!bar) {
      const v = el('video', { class: 'pb-prev', muted: true, playsinline: true, autoplay: true });
      v.muted = true;
      bar = el('div', { class: 'present-bar', role: 'status' }, [
        v, el('div', { class: 'pb-text' }, [el('b'), el('span')]),
        btn(tr('Share another'), () => switchScr(), 'small'), btn(tr('Stop'), () => stopScr(), 'small danger'),
      ]);
      bar.querySelector('.pb-prev').onclick = () => go('send');
      document.body.append(bar);
      document.documentElement.classList.add('presenting');
    }
    const v = bar.querySelector('video');
    if (v.srcObject !== S.scr.stream) { v.srcObject = S.scr.stream; v.play().catch(() => {}); }
    const vt = S.scr.stream && S.scr.stream.getVideoTracks()[0];
    const audio = S.scr.stream && S.scr.stream.getAudioTracks().length > 0;
    bar.querySelector('b').textContent = S.scr.status === 'live' ? tr('You’re presenting to {name}', { name: pcName() }) : tr('Connecting to {name}…', { name: pcName() });
    bar.querySelector('span').textContent = audio ? tr('Showing {what}, with sound', { what: scrWhat(vt) }) : tr('Showing {what}', { what: scrWhat(vt) });
    bar.querySelectorAll('button')[0].hidden = ME.mobile;
  }
  async function offerOut(kind, stream) {
    const o = { pc: new RTCPeerConnection({ iceServers: [] }), pending: [], remote: false };
    if (outs[kind]) outs[kind].pc.close();
    outs[kind] = o;
    for (const t of stream.getTracks()) o.pc.addTrack(t, stream);
    o.pc.onicecandidate = (e) => e.candidate && send({ t: `${kind}.ice`, candidate: e.candidate.toJSON() });
    const offer = await o.pc.createOffer();
    await o.pc.setLocalDescription(offer);
    send({ t: `${kind}.offer`, sdp: o.pc.localDescription.sdp });
  }
  async function answerIn(kind, m) {
    const o = outs[kind];
    if (!o) return;
    if (m.t.endsWith('.answer')) {
      await o.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch((e) => toast(e.message));
      o.remote = true;
      for (const c of o.pending.splice(0)) o.pc.addIceCandidate(c).catch(() => {});
    } else if (m.candidate) {
      if (o.remote) o.pc.addIceCandidate(m.candidate).catch(() => {});
      else o.pending.push(m.candidate);
    }
  }

  async function startCam() {
    if (!S.secure) return toast(tr('The camera requires a secure connection. Set it up under Connection.'));
    try {
      if (S.cam.stream) S.cam.stream.getTracks().forEach((t) => t.stop());
      S.cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: S.cam.facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false });
      S.cam.on = true;
      S.cam.status = 'connecting';
      await offerOut('cam', S.cam.stream);
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? tr('Allow camera access for this site in Settings') : tr('Camera: {error}', { error: e.message }));
      stopCam();
    }
    refresh('camera', 'overview');
  }
  function stopCam(quiet) {
    if (!S.cam.on && !S.cam.stream) return;
    if (!quiet) send({ t: 'cam.stop' });
    if (outs.cam) outs.cam.pc.close();
    outs.cam = null;
    if (S.cam.stream) S.cam.stream.getTracks().forEach((t) => t.stop());
    S.cam = { ...S.cam, on: false, stream: null, status: 'off' };
    refresh('camera', 'overview');
  }
  async function startMic() {
    if (!S.secure) return toast(tr('The microphone requires a secure connection. Set it up under Connection.'));
    try {
      S.mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      S.mic.on = true;
      S.mic.status = 'connecting';
      await offerOut('mic', S.mic.stream);
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? tr('Allow microphone access for this site in Settings') : tr('Microphone: {error}', { error: e.message }));
      stopMic();
    }
    refresh('sound');
  }
  function stopMic(quiet) {
    if (!S.mic.on && !S.mic.stream) return;
    if (!quiet) send({ t: 'mic.stop' });
    if (outs.mic) outs.mic.pc.close();
    outs.mic = null;
    if (S.mic.stream) S.mic.stream.getTracks().forEach((t) => t.stop());
    S.mic = { ...S.mic, on: false, stream: null, status: 'off' };
    refresh('sound');
  }

  // ---------------------------------------------------------------- start
  (async () => {
    applyLook();
    adoptCreds();
    if (query.get('go')) pendingGo = query.get('go');
    frame();
    // The better address is looked for alongside: the page connects at once, and moves when one answers
    // (an untrusted certificate makes the secure page's probe wait out its time).
    let moving = false;
    upgrade().then((m) => { moving = m; }).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    if (moving) return;
    loadPeers();
    if (!S.creds) {
      S.conn = 'pairing';
      S.serving = await reachable('');
      render();
    }
    if (S.creds && prefs.keepAlive) armKeepAlive();
    connect();
  })();
})();

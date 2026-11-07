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
    airplay: 'M5 14H3.5V4h13v10H15 M6.5 17.5 10 13l3.5 4.5z',
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
    const tr = el('div', { class: 'card-title' }, [t, action || null]);
    tr.hidden = !title && !action;
    const w = el('div', { class: 'card-wrap' }, [tr, el('div', { class: 'card' }, kids)]);
    w.setTitle = (x) => { t.textContent = x; tr.hidden = !x && !action; };
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
  const copy = async (t, what = 'Copied') => { const ok = await copyText(t); if (ok) haptic(); toast(ok ? what : 'Could not copy'); };
  const copyBox = (get) => {
    const m = el('span', { class: 'mono' });
    const e = el('div', { class: 'copybox' }, [m, btn('Copy', () => copy(get()), 'small')]);
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
  ME.mobile = ME.apple || ME.os === 'android';
  ME.model = IPAD ? 'iPad' : ME.os === 'ios' ? 'iPhone' : ME.os === 'android' ? 'Android phone' : ME.os === 'mac' ? 'Mac browser' : ME.os === 'win' ? 'Windows browser' : 'Browser';
  ME.kind = IPAD ? 'iPad' : ME.os === 'ios' ? 'iPhone' : ME.os === 'android' ? 'phone' : 'browser';
  const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
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
    conn: 'boot', // boot | pairing | connecting | online | offline
    pairErr: '',
    rtt: null,
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
  async function reachable(base) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    try {
      const r = await fetch(`${base}/api/ping`, { cache: 'no-store', signal: ctl.signal });
      return r.ok ? await r.json() : null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  // On plain http (the QR code's address), move to the secure page when this device trusts it: by
  // name first (the same whatever address the computer has), then by address.
  async function upgrade() {
    if (location.protocol !== 'http:') return false;
    const h = hashParams();
    const host = h.get('h') || (load().pc && load().pc.host);
    const port = Number(h.get('p')) || Number(location.port) - 1 || 47870;
    const keep = location.hash;
    for (const base of [host && `https://${host}:${port}`, `https://${location.hostname}:${port}`].filter(Boolean)) {
      if (await reachable(base)) {
        location.replace(`${base}/${location.search}${keep}`);
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
    const frag = `d=${encodeURIComponent(S.creds.id)}&k=${encodeURIComponent(S.creds.key)}`;
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
  const send = (m) => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; } return false; };

  function connect() {
    clearTimeout(retry);
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws = sock;
    if (S.creds) { S.conn = S.conn === 'offline' ? 'offline' : 'connecting'; render(); }
    sock.onopen = () => {
      tries = 0;
      if (S.creds) sock.send(JSON.stringify({ t: 'hello', id: S.creds.id, key: S.creds.key, os: ME.os, model: ME.model, name: load().name || '' }));
      else if (S.pairCode && S.pairCode.length === 6) pair(S.pairCode);
    };
    sock.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } onMessage(m); };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      ws = null;
      if (e.code === 4001) return dropCreds('This device was removed on the computer. Pair again to reconnect.');
      if (S.creds) {
        S.conn = tries > 1 ? 'offline' : 'connecting';
        stopCam(true); stopMic(true);
        closeOverlay(true);
        render();
      }
      retry = setTimeout(connect, Math.min(10000, 800 * 2 ** tries++));
    };
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
        S.conn = 'online';
        keepCreds();
        toast(`Paired with ${m.pc.name}`);
        haptic();
        frame();
        go('overview');
        break;
      case 'welcome':
        S.creds.token = m.token;
        S.pc = m.pc;
        S.conn = 'online';
        keepCreds();
        frame();
        break;
      case 'unknown': return dropCreds('This device is no longer paired with the computer. Pair again to reconnect.');
      case 'forgotten': return dropCreds('This device was removed on the computer.');
      case 'bad-code':
        S.pairErr = m.why === 'off' ? 'TwinDesk Web is turned off on that computer.' : m.wait ? `Too many attempts. Try again in ${m.wait} seconds.` : 'Incorrect code. Check the code in TwinDesk › TwinDesk Web on the computer.';
        renderPage();
        break;
      case 'pong': S.rtt = Math.max(1, Math.round(performance.now() - m.at)); renderTop(); refresh('connection', 'receive'); break;
      case 'clip': S.clip = { text: m.text || '', at: m.at, from: m.from, history: m.history || S.clip.history }; refresh('clipboard', 'overview'); break;
      case 'chat.all': S.chat = m.items || []; refresh('files', 'drop', 'overview'); break;
      case 'chat.add':
        S.chat.push(m.item);
        if (m.item.from === 'pc' && !document.hidden && cur !== 'drop' && cur !== 'files') toast(m.item.file ? `${pcName()} sent ${m.item.file.name}` : `${pcName()}: ${String(m.item.text).slice(0, 60)}`);
        refresh('files', 'drop', 'overview');
        break;
      case 'chat.gone': S.chat = S.chat.filter((x) => x.id !== m.id); refresh('files', 'drop', 'overview'); break;
      case 'notifs.all': S.notifs = m.items || []; S.notifsOn = true; refresh('notifications'); break;
      case 'notif':
        S.notifs = [m.item, ...S.notifs.filter((x) => x.id !== m.item.id)].slice(0, 100);
        if (cur !== 'notifications') S.unseen++;
        refresh('notifications');
        renderNav();
        break;
      case 'screen.state':
        S.screen = { status: m.status || 'off', on: !!m.on, why: m.why || '' };
        toFrame('viewer', { t: 'screen.state', on: S.screen.on });
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
        toast(m.ok ? (m.local ? 'Test sent. It appears when TwinDesk is in the background.' : 'Test sent. Lock this device or switch apps to see it.') : `The test was not delivered${m.status ? ` (push service error ${m.status})` : m.why ? `: ${m.why}` : ''}`);
        break;
      case 'dev.state': S.devs = { can: m.can || {}, state: m.state || {} }; refresh('overview'); break;
      case 'dev.error': toast(`Could not ${m.do}: ${m.why}`); break;
      case 'mount': S.mount = m; refresh('mount'); break;
      case 'media.state': S.media = m; paintMedia(); refresh('background', 'overview'); break;
      default: break;
    }
    if (m.t === 'welcome' || m.t === 'paired') {
      clearInterval(pingTimer);
      const ping = () => send({ t: 'ping', at: performance.now() });
      ping();
      pingTimer = setInterval(ping, 5000);
      if (S.notifsOn === false && load().notifs !== false) send({ t: 'notifs', on: true });
      send({ t: 'vis', hidden: document.hidden });
      syncPush();
      takeShared();
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
    { id: 'overview', title: 'Overview', icon: 'overview', c: ['#8E8E93', '#636366'], g: 1 },
    { id: 'connection', title: 'Connection', icon: 'link', c: ['#30D158', '#248A3D'], g: 1 },
    { id: 'receive', title: 'Receive screen', short: 'Screen', icon: 'display', c: ['#5AC8FA', '#0A84FF'], g: 2 },
    { id: 'send', title: 'Send screen', icon: 'airplay', c: ['#64D2FF', '#5E5CE6'], g: 2 },
    { id: 'remote', title: 'Remote', icon: 'remote', c: ['#BF5AF2', '#8944AB'], g: 3 },
    { id: 'clipboard', title: 'Clipboard', icon: 'clipboard', c: ['#64D2FF', '#30B0C7'], g: 4 },
    { id: 'notifications', title: 'Notifications', short: 'Alerts', icon: 'bell', c: ['#FF6961', '#FF3B30'], g: 4 },
    { id: 'files', title: 'Files', icon: 'files', c: ['#64D2FF', '#0A84FF'], g: 4 },
    { id: 'drop', title: 'Drop', icon: 'drop', c: ['#FFB340', '#FF9500'], g: 4 },
    { id: 'mount', title: 'Mount', icon: 'drive', c: ['#AEAEB2', '#636366'], g: 4 },
    { id: 'sound', title: 'Sound', icon: 'audio', c: ['#FF6482', '#FF2D55'], g: 5 },
    { id: 'camera', title: 'Camera', icon: 'camera', c: ['#BF5AF2', '#8944AB'], g: 5 },
    { id: 'background', title: 'Background', icon: 'moon', c: ['#7D7AFF', '#5E5CE6'], g: 6 },
    { id: 'shortcuts', title: 'Shortcuts', icon: 'bolt', c: ['#FF6482', '#BF5AF2'], g: 6 },
    { id: 'general', title: 'General', icon: 'general', c: ['#AEAEB2', '#636366'], g: 'bottom' },
    { id: 'about', title: 'About', icon: 'about', c: ['#64D2FF', '#0A84FF'], g: 'bottom' },
  ];
  const PAGE = Object.fromEntries(PAGES.map((p) => [p.id, p]));
  const BOTTOM = ['overview', 'receive', 'files', 'drop'];
  let cur = 'overview';
  let more = false;
  const built = new Map(); // id -> {el, render}
  let topEl = null, navEl = null, sheetEl = null, sideEl = null;
  const pcName = () => (S.pc && S.pc.name) || (S.serving && S.serving.name) || 'your computer';
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
      who.textContent = !S.creds ? (S.serving ? `Not connected · ${S.serving.name} available` : 'Not connected')
        : online() ? [pcName(), S.rtt != null ? `${S.rtt} ms` : ''].filter(Boolean).join(' · ')
          : S.conn === 'offline' ? `${pcName()} · Not reachable` : `${pcName()} · Connecting…`;
    };
    e.update();
    return e;
  }
  const renderTop = () => { if (topEl) topEl.update(); if (cur === 'overview' || cur === 'connection') renderPage(); };

  function renderNav() {
    if (navEl) {
      navEl.replaceChildren(...[...BOTTOM, 'more'].map((id) => {
        const on = id === 'more' ? more || !BOTTOM.includes(cur) : !more && cur === id;
        const p = PAGE[id] || { title: 'More', icon: 'more' };
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
  function goTo(g) {
    if (g === 'touchpad') return openRemote('pad');
    if (PAGE[g]) show(g);
  }

  function showMore() {
    more = true;
    if (!wideQ.matches) topEl.hidden = true;
    sheetEl.classList.add('gap');
    const page = el('div', { class: 'page' }, [head('More')]);
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

  function renderPage() {
    if (topEl) topEl.update();
    const v = built.get(cur);
    if (v && !more) { try { v.render(); } catch (e) { console.error(e); } }
  }
  function refresh(...ids) {
    if (!more && ids.includes(cur)) renderPage();
    if (ids.some((i) => ['notifications', 'receive', 'camera', 'sound', 'background'].includes(i))) renderNav();
  }
  function render() { renderTop(); renderNav(); renderPage(); }
  const offlineNote = () => note(S.conn === 'offline' ? `${pcName()} is not reachable. Make sure TwinDesk is open on it and both devices are on the same network.` : `Connecting to ${pcName()}…`, 'warn');
  const needOnline = () => { if (online()) return true; toast(`Not connected to ${pcName()}`); return false; };
  const statusText = () => (online() ? ['Connected', S.rtt != null ? `${S.rtt} ms` : '', S.secure ? 'Secure' : ''].filter(Boolean).join(' · ') : S.conn === 'offline' ? 'Not reachable' : 'Connecting…');
  const osName = (os) => ({ mac: 'macOS', win: 'Windows', linux: 'Linux' }[os] || '');
  const chev = () => el('span', { class: 'chev', text: '›' });
  const link = (text, fn) => el('a', { href: '#', class: 'act', text, onclick: (e) => { e.preventDefault(); fn(); } });

  // ---------------------------------------------------------------- the pages
  const BUILD = {};

  // The two devices and the link between them.
  function hero() {
    const line = el('div', { class: 'line' });
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
    const input = el('input', { inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6', autocomplete: 'one-time-code', 'aria-label': 'Pairing code' });
    const goBtn = btn('Connect', null, 'primary big');
    const err = note('', 'bad');
    const paint = () => {
      const v = input.value.replace(/\D/g, '').slice(0, 6);
      if (v !== input.value) input.value = v;
      boxes.replaceChildren(...[0, 1, 2, 3, 4, 5].map((i) => el('span', { class: i === Math.min(v.length, 5) && document.activeElement === input ? 'cur' : '', text: v[i] || '' })), input);
      goBtn.disabled = v.length !== 6;
    };
    input.oninput = () => { paint(); if (input.value.length === 6) submit(); };
    input.onfocus = input.onblur = paint;
    const submit = () => { if (input.value.length === 6) { S.pairErr = ''; pair(input.value); goBtn.textContent = 'Connecting…'; setTimeout(() => { goBtn.textContent = 'Connect'; }, 3000); } };
    goBtn.onclick = submit;
    if (S.pairCode) input.value = S.pairCode;
    paint();
    const serve = el('div', { class: 'desc' });
    const F = [
      ['display', ['#5AC8FA', '#0A84FF'], 'Screen sharing', 'View and control your computer, with audio'],
      ['files', ['#64D2FF', '#0A84FF'], 'File transfer', 'Send and receive files in both directions'],
      ['clipboard', ['#64D2FF', '#30B0C7'], 'Shared clipboard', 'Copy on one device, paste on the other'],
      ['remote', ['#BF5AF2', '#8944AB'], 'Remote control', 'Trackpad, keyboard and gamepad'],
      ['bell', ['#FF6961', '#FF3B30'], 'Notifications', 'Computer notifications on your lock screen'],
      ['camera', ['#BF5AF2', '#8944AB'], 'Camera and microphone', 'Use this device as a webcam'],
    ];
    const promo = el('div', { class: 'promo' }, [
      el('img', { class: 'logo', src: logo(), alt: '' }),
      el('h1', { text: 'TwinDesk' }),
      el('p', { text: 'Your computers and phone, working as one: screen, files, clipboard and input, shared across devices. Free and open source.' }),
    ]);
    const connect = card('Connect to a computer', [el('div', { class: 'pair-box' }, [serve, boxes, goBtn, err,
      el('div', { class: 'desc', text: `On the computer, open TwinDesk › TwinDesk Web. Scan the QR code${ME.mobile ? ' with your camera' : ''} or enter the six-digit code above.` })])]);
    const feat = el('div', { class: 'feat' }, F.map(([i, c, t, d]) => el('div', {}, [tile(i, c, 34), el('b', { text: t }), el('span', { text: d })])));
    const dl = downloads();
    if (wideQ.matches) page.replaceChildren(el('div', { class: 'promo-grid' }, [el('div', {}, [promo, feat, dl]), el('div', { class: 'aside' }, [el('div', { style: 'height:30px' }), connect])]));
    else page.replaceChildren(promo, connect, feat, dl);
    return () => {
      serve.textContent = S.serving ? `${S.serving.name} is ready to pair. You only need to pair once.` : 'You only need to pair once.';
      err.textContent = S.pairErr;
      err.hidden = !S.pairErr;
      paint();
    };
  };

  function downloads() {
    const v = (S.pc && S.pc.version) || (S.serving && S.serving.version) || '';
    const R = 'https://github.com/InukaAsith/TwinDesk/releases';
    const f = (name) => (v ? `${R}/download/v${v}/${name.replace(/\{v\}/g, v)}` : `${R}/latest`);
    const L = [
      ['macOS', 'Apple silicon', f('TwinDesk-{v}-arm64.dmg')],
      ['macOS', 'Intel', f('TwinDesk-{v}-x64_Intel.dmg')],
      ['Windows', 'Installer (x64)', f('TwinDesk-Setup-{v}.exe')],
      ['Linux', 'Debian / Ubuntu (.deb)', f('TwinDesk-{v}-amd64.deb')],
      ['Linux', 'AppImage', f('TwinDesk-{v}-x86_64.AppImage')],
      ['Android', 'APK', f('TwinDesk-{v}.apk')],
    ];
    return card('Download TwinDesk', [
      el('div', { class: 'dl' }, L.map(([a, b, href]) => el('a', { href, target: '_blank', rel: 'noopener' }, [el('b', { text: a }), el('span', { text: b })]))),
      row('All releases', 'Free and open source under GPL-3.0', [chev()], () => window.open(R, '_blank')),
    ], v ? el('span', { class: 'muted act', text: `Version ${v}` }) : null);
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
    const np = card('Now playing', [el('div', { class: 'np' }, [art, el('div', { class: 't' }, [npT, npA]), el('div', { class: 'ctl' }, [ctl('prev', 'previous'), playB, ctl('next', 'next')])])]);
    np.classList.add('span');
    const clipText = el('div', { class: 'clip-text' });
    const clip = card('Clipboard', [el('div', { class: 'pad16' }, [clipText, el('div', { class: 'two' }, [
      btn('Copy', () => copy(S.clip.text), 'soft', 'copy'),
      btn('Send clipboard', () => pastePhone(), '', 'up'),
    ])])], link('History', () => go('clipboard')));
    const nList = el('div', { class: 'card mini-list' });
    const notifs = el('div', { class: 'card-wrap' }, [el('div', { class: 'card-title' }, [el('span', { text: 'Latest notifications' }), link('See all', () => go('notifications'))]), nList]);
    const fList = el('div', { class: 'card mini-list' });
    const files = el('div', { class: 'card-wrap' }, [el('div', { class: 'card-title' }, [el('span', { text: 'Recent files' }), link('See all', () => go('files'))]), fList]);
    const zone = el('div', { class: 'dropzone slim', onclick: () => pickFiles() }, [icon('up', 28), el('b', { text: 'Drop files here' }), el('span', { text: 'or click to choose' })]);
    const sendCard = card('Send files', [zone]);
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files.length) upload([...e.dataTransfer.files], true); };
    const btSw = sw((v) => send({ t: 'dev.do', do: 'bluetooth', on: v }));
    const dndSw = sw((v) => send({ t: 'dev.do', do: 'dnd', on: v }));
    const btRow = row('Bluetooth', '', [btSw]);
    const dndRow = row('Do Not Disturb', '', [dndSw]);
    const controls = card('Controls', [btRow, dndRow]);
    const grid = el('div', { class: 'ov-grid' }, [np, clip, notifs, files, sendCard, controls]);
    page.append(hero, off, grid);
    return () => {
      const can = (S.devs && S.devs.can) || {};
      const st = (S.devs && S.devs.state) || {};
      const ringing = !!st.ringing;
      name.textContent = pcName();
      dot.className = `dot${online() ? ' good' : S.conn === 'offline' ? '' : ' warn'}`;
      stText.textContent = [statusText(), osName(S.pc && S.pc.os)].filter(Boolean).join(' · ');
      const A = online() ? [
        btn('Show screen', () => openViewer(), 'primary', 'display'),
        btn('Send files', () => pickFiles(), '', 'up'),
        can.ring && btn(ringing ? 'Stop ringing' : 'Ring', () => { haptic(); send({ t: 'dev.do', do: ringing ? 'ringStop' : 'ring' }); st.ringing = !ringing; renderPage(); }, ringing ? 'on' : '', 'ring'),
        can.lock && btn('Lock', () => { haptic(); send({ t: 'dev.do', do: 'lock' }); toast(`Locking ${pcName()}`); }, '', 'lock'),
        can.sleep && btn('Sleep', () => { haptic(); send({ t: 'dev.do', do: 'sleep' }); toast(`Putting ${pcName()} to sleep`); }, '', 'sleep'),
      ] : [
        btn('Try again', () => { tries = 0; connect(); }, 'primary'),
        btn('Use another computer', () => forgetHere()),
      ];
      actions.replaceChildren(...A.filter(Boolean));
      const F = [
        ['Connection', S.secure ? 'Secure' : 'Not secure'],
        ['Latency', online() && S.rtt != null ? `${S.rtt} ms` : '—'],
        ['Address', (S.pc && S.pc.ips && S.pc.ips[0]) || location.hostname],
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
      clipText.textContent = S.clip.text || 'The clipboard is empty';
      clipText.classList.toggle('muted', !S.clip.text);
      clip.hidden = !online();
      const N = S.notifs.slice(0, 3);
      nList.replaceChildren(...N.map((n) => row([n.appName, n.title].filter(Boolean).join(' · ') || 'Notification', String(n.body || '').slice(0, 90), [el('span', { class: 'muted', style: 'font-size:12px', text: ago(n.at) })])));
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
    };
  };

  // ---- Connection ----
  BUILD.connection = (page) => {
    const h = hero();
    const hd = head('Connection');
    const status = valueRow('Status');
    const rtt = valueRow('Latency');
    const sec = valueRow('Security');
    const addr = el('div');
    const setup = el('div');
    const forget = row('', '', [btn('Forget', () => forgetHere(), 'small danger')]);
    const install = row(ME.apple ? 'Add to Home Screen' : 'Install as an app', '', [installBtn()]);
    page.append(hd, h,
      card('', [status, rtt, sec]),
      card('Addresses', [el('div', { class: 'pad16', style: 'gap:10px' }, [addr])]),
      setup,
      card('Paired computer', [forget]),
      card('', [install]),
    );
    let addrKey = '';
    return () => {
      hd.desc(`This ${ME.kind} reconnects to ${pcName()} automatically, even when either device's network address changes.`);
      h.update([]);
      status.set(online() ? 'Connected' : S.conn === 'offline' ? 'Not reachable' : 'Connecting…');
      rtt.set(online() && S.rtt != null ? `${S.rtt} ms` : '');
      sec.set(S.secure ? 'Encrypted (HTTPS)' : 'Not encrypted');
      const key = JSON.stringify([S.pc && S.pc.host, S.pc && S.pc.ips, location.host]);
      if (key !== addrKey) {
        addrKey = key;
        const port = (S.pc && S.pc.port) || Number(location.port) || 47870;
        const L = [];
        if (S.pc && S.pc.host) L.push(['Secure address (recommended)', `https://${S.pc.host}:${port}/`]);
        for (const ip of (S.pc && S.pc.ips) || []) L.push([`Local address (${ip})`, `http://${ip}:${port + 1}/`]);
        if (!L.length) L.push(['This page', location.origin + '/']);
        addr.replaceChildren(...L.map(([l, u]) => el('div', {}, [el('div', { class: 'muted', style: 'font-size:12.5px', text: l }), copyBox(() => u)])));
      }
      if (!setup.firstChild && !S.secure) setup.append(secureCard());
      forget.setLabel(pcName());
      forget.setHint(`Paired${S.pc && S.pc.version ? ` · TwinDesk ${S.pc.version}` : ''}. Forgetting removes the pairing on both devices.`);
      install.setHint(STANDALONE ? 'Installed. TwinDesk opens connected without pairing again.'
        : ME.apple ? 'In Safari, tap Share › Add to Home Screen. Required for notifications on iPhone and iPad.'
          : 'Opens TwinDesk in its own window and adds it to the share menu.');
    };
  };

  // Install prompt (Chrome, Edge, Android): the browser's own, when it offers one.
  let installEvt = null;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; refresh('connection', 'shortcuts'); });
  function installBtn() {
    const b = btn('Install', async () => {
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

  function secureCard() {
    const steps = ME.apple ? [
      el('li', {}, [el('a', { href: '/twindesk.mobileconfig', text: 'Download the TwinDesk profile' }), '.']),
      el('li', { html: 'Open Settings › <b>Profile Downloaded</b> and tap Install.' }),
      el('li', { html: 'Go to Settings › General › About › <b>Certificate Trust Settings</b> and turn on TwinDesk.' }),
    ] : ME.os === 'android' ? [
      el('li', {}, [el('a', { href: '/twindesk.cer', text: 'Download the TwinDesk certificate' }), '.']),
      el('li', { html: 'Open Settings › Security › More security settings › Encryption &amp; credentials › <b>Install a certificate</b> › CA certificate, and select the file.' }),
    ] : [
      el('li', {}, [el('a', { href: '/twindesk.cer', text: 'Download the TwinDesk certificate' }), '.']),
      el('li', { text: ME.os === 'mac' ? 'Open the file to add it to Keychain Access, then double-click it and set Trust to Always Trust.' : ME.os === 'win' ? 'Open the file and choose Install Certificate › Current User › Trusted Root Certification Authorities.' : 'Import it into your browser’s certificate settings as a certificate authority.' }),
    ];
    steps.push(el('li', {}, [btn('Switch to the secure address', () => secureNow(), 'small primary')]));
    return card('Set up a secure connection', [
      el('div', { class: 'pad16', style: 'padding-bottom:0' }, [el('div', { class: 'muted', text: 'Required for the camera, microphone, notifications and clipboard access. It also keeps the address the same when the computer changes networks.' })]),
      el('ol', { class: 'steps' }, steps),
      row('About this certificate', 'It is valid only for this computer’s .local name and private network addresses. It cannot be used for websites.'),
    ]);
  }

  function fileRow(x, extra) {
    const r = row(x.file.name, `${x.from === 'pc' ? `From ${pcName()}` : 'Sent'} · ${bytes(x.file.size)} · ${ago(x.at)}`, [
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
    if (!(ME.mobile && navigator.canShare)) return el('a', { class: 'btn small soft', href: fileUrl(x), download: x.file.name, text: 'Save' });
    const b = btn('Save', null, 'small soft');
    b.onclick = () => shareFile(x, b);
    return b;
  }
  async function shareFile(x, b) {
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
        if (e.name === 'NotAllowedError') toast('Ready. Tap Save again.');
        else if (e.name !== 'AbortError') location.href = fileUrl(x);
      }
    } catch (_) {
      location.href = fileUrl(x);
    } finally {
      if (b) b.textContent = 'Save';
    }
  }

  // ---- Receive screen ----
  const QUALITY = { auto: [1440, 14], high: [2160, 24], medium: [1080, 10], low: [720, 5] };
  BUILD.receive = (page) => {
    const hd = head('Receive screen');
    const openB = el('button', { class: 'btn primary big', onclick: () => openViewer() }, [icon('display'), 'Open screen']);
    const status = note('');
    const modeSeg = seg([['mirror', 'Mirror'], ['extend', 'Extend']], () => prefs.mode, (v) => { prefs.mode = v; savePrefs(); if (overlay && overlay.kind === 'viewer') startScreen(); renderPage(); });
    const modeRow = row('Display mode', '', [modeSeg]);
    const ctlSw = sw((v) => { prefs.control = v; savePrefs(); });
    const fullSw = sw((v) => { prefs.full = v; savePrefs(); });
    const soundSw = sw((v) => { prefs.sound = v; savePrefs(); toFrame('viewer', optsFor('viewer')); });
    const paceSeg = seg([['fast', 'Lowest latency'], ['smooth', 'Smooth']], () => prefs.pacing, (v) => { prefs.pacing = v; savePrefs(); toFrame('viewer', optsFor('viewer')); });
    const qSeg = seg([['low', '720p'], ['medium', '1080p'], ['auto', '1440p'], ['high', '4K']], () => prefs.quality, (v) => { prefs.quality = v; savePrefs(); if (overlay && overlay.kind === 'viewer') startScreen(); });
    const touchSeg = seg([['pad', 'Trackpad'], ['direct', 'Direct']], () => prefs.touch, (v) => { prefs.touch = v; savePrefs(); toFrame('viewer', optsFor('viewer')); });
    const tapSw = sw((v) => { prefs.tap = v; savePrefs(); toFrame('viewer', optsFor('viewer')); });
    const penSw = sw((v) => { prefs.pen = v; savePrefs(); toFrame('viewer', optsFor('viewer')); });
    const speed = el('input', { type: 'range', min: '0.4', max: '3', step: '0.1', style: 'width:150px' });
    speed.onchange = () => { prefs.speed = Number(speed.value); savePrefs(); toFrame('viewer', optsFor('viewer')); };
    const st = { status: valueRow('Status'), picture: valueRow('Resolution'), mode: valueRow('Mode'), rtt: valueRow('Latency') };
    const ctlRow = row('Allow control', '', [ctlSw]);
    const fullRow = row('Open in full screen', 'Hides the browser interface while viewing', [fullSw]);
    const penRow = row(ME.apple ? 'Apple Pencil input' : 'Stylus input', 'Sends pressure and tilt for drawing apps. When off, the stylus works like a finger.', [penSw]);
    page.append(
      hd,
      el('div', { class: 'stack', style: 'margin-bottom:18px' }, [openB, status]),
      card('Display', [modeRow, ctlRow, fullRow]),
      card('Video and audio', [row('Audio', 'Play the computer’s audio with the video', [soundSw]), row('Playback', 'Lowest latency for interaction; Smooth for video on busy networks', [paceSeg]), row('Resolution', '', [qSeg])]),
      card('Touch input', [
        row('Touch mode', 'Trackpad moves the pointer like a laptop trackpad. Direct places it under your finger.', [touchSeg]),
        row('Tap to click', '', [tapSw]),
        row('Pointer speed', '', [speed]),
        penRow,
      ]),
      card('Session', Object.values(st)),
    );
    return () => {
      hd.desc(`View and control ${pcName()} from this ${ME.kind}.`);
      openB.disabled = !online();
      openB.lastChild.textContent = overlay && overlay.kind === 'viewer' ? 'Return to screen' : 'Open screen';
      const ext = !!(S.pc && S.pc.extend);
      modeSeg.hidden = !ext;
      modeRow.setHint(!ext ? 'Mirror only. Extend requires a newer version of TwinDesk on the computer.' : prefs.mode === 'extend' ? `Adds a separate display to ${pcName()} for this ${ME.kind}` : `Shows ${pcName()}’s main display`);
      const locked = !!(S.pc && S.pc.control === false);
      ctlRow.setHint(locked ? `Turned off in TwinDesk on ${pcName()}` : 'Send touch, keyboard and stylus input to the computer');
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
      status.textContent = !online() ? (S.conn === 'offline' ? `${pcName()} is not reachable` : 'Connecting…') : s.startsWith('error') ? s.replace(/^error: /, '') : '';
      status.hidden = !status.textContent;
      status.className = `note${s.startsWith('error') ? ' bad' : ' warn'}`;
      const live = s === 'live' || s === 'connected';
      st.status.set(s === 'off' ? 'Not viewing' : live ? 'Live' : s.startsWith('error') ? 'Stopped' : 'Starting…');
      st.picture.set(S.picture ? `${S.picture[0]} × ${S.picture[1]}` : '');
      st.mode.set(s === 'off' ? '' : prefs.mode === 'extend' && ext ? 'Extended display' : 'Mirrored display');
      st.rtt.set(online() && S.rtt != null ? `${S.rtt} ms` : '');
    };
  };

  // ---- Send screen ----
  BUILD.send = (page) => {
    const hd = head('Send screen');
    const body = el('div');
    page.append(hd, body);
    return () => {
      const name = pcName();
      hd.desc(`Show this ${ME.kind}’s screen on ${name}.`);
      if (ME.apple) {
        body.replaceChildren(
          el('div', { class: 'hero', style: 'padding:26px 20px;text-align:center' }, [tile('airplay', PAGE.send.c, 56), el('h2', { style: 'margin:14px 0 4px;font-size:20px', text: `AirPlay to ${name}` }), el('div', { class: 'muted', text: `${name} appears as an AirPlay receiver when AirPlay is enabled in TwinDesk.` })]),
          card('Mirror your screen', [el('ol', { class: 'steps' }, [
            el('li', { html: 'Open <b>Control Center</b>.' }),
            el('li', { html: 'Tap <b>Screen Mirroring</b>.' }),
            el('li', {}, ['Select ', el('b', { text: name }), '.']),
            el('li', { html: 'To stop, open Screen Mirroring again and tap <b>Stop Mirroring</b>.' }),
          ])]),
          card('Play video or audio', [el('ol', { class: 'steps' }, [
            el('li', { html: 'In Photos, Music, YouTube or another app, tap the <b>AirPlay</b> button.' }),
            el('li', {}, ['Select ', el('b', { text: name }), '.']),
          ])]),
          card('', [row(`${name} is not listed`, `Enable AirPlay in TwinDesk on ${name} (AirPlay & SMB). Both devices must be on the same network, or connected with a cable.`)]),
        );
      } else if (ME.os === 'android') {
        body.replaceChildren(
          card('', [row('TwinDesk for Android', `Shares this phone’s screen and audio with ${name}, and lets ${name} control it.`, [el('a', { class: 'btn small primary', href: 'https://github.com/InukaAsith/TwinDesk/releases/latest', target: '_blank', rel: 'noopener', text: 'Download' })])]),
          card('Screen casting', [el('ol', { class: 'steps' }, [
            el('li', { html: 'Open Quick Settings and tap <b>Screen cast</b> (or Smart View).' }),
            el('li', {}, ['Select ', el('b', { text: name }), '. Casting must be enabled in TwinDesk on the computer.']),
          ])]),
        );
      } else {
        body.replaceChildren(card('', [row('Install TwinDesk on this computer', `TwinDesk shares this screen with ${name} as an extended or mirrored display, with keyboard and mouse.`)]), downloads());
      }
    };
  };

  // ---- Files ----
  BUILD.files = (page) => {
    const hd = head('Files');
    const zone = el('div', { class: 'dropzone', onclick: () => pickFiles() }, [tile('up', PAGE.files.c, 46), el('b', { text: 'Drop files here to send' }), el('span', { text: 'or click to choose files' })]);
    const actions = el('div', { class: 'two', style: 'margin-bottom:18px' }, [
      el('button', { class: 'btn primary big', onclick: () => pickFiles() }, [icon('up'), 'Choose files']),
      el('button', { class: 'btn big', onclick: () => pickFiles('image/*,video/*') }, [icon('camera'), 'Photos and videos']),
    ]);
    const prog = el('div', { class: 'card' });
    const progWrap = el('div', { class: 'card-wrap' }, [el('div', { class: 'card-title', text: 'Sending' }), prog]);
    const recv = el('div', { class: 'card' });
    const recvWrap = el('div', { class: 'card-wrap' }, [el('div', { class: 'card-title' }, [el('span', { text: 'Received' }), el('span', { class: 'muted act rc' })]), recv]);
    const sent = el('div', { class: 'card' });
    const sentWrap = el('div', { class: 'card-wrap' }, [el('div', { class: 'card-title', text: 'Sent' }), sent]);
    const empty = el('div', { class: 'empty' });
    let depth = 0;
    page.ondragenter = (e) => { e.preventDefault(); depth++; zone.classList.add('over'); };
    page.ondragleave = () => { if (--depth <= 0) { depth = 0; zone.classList.remove('over'); } };
    page.ondragover = (e) => { e.preventDefault(); };
    page.ondrop = (e) => { e.preventDefault(); depth = 0; zone.classList.remove('over'); if (e.dataTransfer.files.length) upload([...e.dataTransfer.files]); };
    page.append(hd, zone, actions, progWrap, recvWrap, sentWrap, empty);
    let shown = '';
    return () => {
      hd.desc(`Files you send are saved to ${pcName()}’s Downloads folder and placed on its clipboard, ready to paste with ⌃⌥V.`);
      const touchOnly = ME.mobile && !IPAD;
      zone.hidden = touchOnly;
      actions.hidden = !touchOnly;
      const key = JSON.stringify([S.chat.filter((x) => x.file).map((x) => x.id), [...S.uploads.values()].map((u) => Math.round(u.sent / Math.max(1, u.size) * 50))]);
      if (key === shown) return;
      shown = key;
      const files = S.chat.filter((x) => x.file);
      const got = files.filter((x) => x.from === 'pc').reverse();
      const out = files.filter((x) => x.from !== 'pc').reverse();
      recvWrap.querySelector('.rc').textContent = got.length ? String(got.length) : '';
      prog.replaceChildren(...[...S.uploads.values()].map((u) => {
        const r = row(u.name, `${bytes(u.sent)} of ${bytes(u.size)}`, [el('span', { class: 'spin' })]);
        r.querySelector('.text').append(el('div', { class: 'bar' }, [el('i', { style: `width:${Math.round(u.sent / Math.max(1, u.size) * 100)}%` })]));
        return r;
      }));
      progWrap.hidden = !S.uploads.size;
      recv.replaceChildren(...got.slice(0, 60).map((x) => fileRow(x, [btn('Remove', () => send({ t: 'chat.del', id: x.id }), 'small')])));
      recvWrap.hidden = !got.length;
      sent.replaceChildren(...out.slice(0, 40).map((x) => fileRow(x)));
      sentWrap.hidden = !out.length;
      empty.replaceChildren(el('div', { text: `No files yet. Files sent from ${pcName()} appear here.` }));
      empty.hidden = !!(got.length || out.length || S.uploads.size);
    };
  };

  // ---- Drop ----
  BUILD.drop = (page) => {
    page.className = 'page flush';
    const thread = el('div', { class: 'thread' });
    const ta = el('textarea', { rows: '1', placeholder: 'Message', enterkeyhint: 'send' });
    const sendB = el('button', { class: 'round go', type: 'submit', 'aria-label': 'Send', disabled: true }, [icon('send')]);
    const form = el('form', { class: 'composer' }, [el('button', { class: 'round', type: 'button', 'aria-label': 'Attach files', onclick: () => pickFiles(null, true) }, [icon('plus')]), ta, sendB]);
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; sendB.disabled = !ta.value.trim() || !online(); };
    ta.oninput = grow;
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !ME.mobile) { e.preventDefault(); form.requestSubmit(); } };
    form.onsubmit = (e) => { e.preventDefault(); const t = ta.value.trim(); if (!t || !online()) return; send({ t: 'chat', text: t }); ta.value = ''; grow(); haptic(); };
    const hd = head('Drop', btn('Paste', () => pastePhone(true), 'small', 'clipboard'));
    hd.style.marginBottom = '4px';
    const top = el('div', { style: wideQ.matches ? 'padding:28px 40px 0' : 'padding:20px 20px 0' }, [hd]);
    page.ondragover = (e) => { e.preventDefault(); };
    page.ondrop = (e) => { e.preventDefault(); if (e.dataTransfer.files.length) upload([...e.dataTransfer.files], true); };
    page.append(top, thread, form);
    let shown = '';
    return () => {
      hd.desc(`Messages, links and files shared with ${pcName()}.`);
      const key = JSON.stringify([S.chat.map((x) => x.id), [...S.uploads.values()].map((u) => [u.name, Math.round(u.sent / Math.max(1, u.size) * 50)])]);
      grow();
      if (key === shown) return;
      shown = key;
      const atEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
      const kids = [];
      let day = '';
      for (const x of S.chat) {
        const d = new Date(x.at).toDateString();
        if (d !== day) { day = d; kids.push(el('div', { class: 'day', text: d === new Date().toDateString() ? 'Today' : new Date(x.at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) })); }
        kids.push(bubble(x));
      }
      for (const [, u] of S.uploads) {
        kids.push(el('div', { class: 'msg me' }, [el('div', { class: 'file' }, [el('div', { class: 'ext', text: (u.name.split('.').pop() || '').slice(0, 4) }), el('div', { style: 'min-width:0' }, [el('div', { class: 'nm', text: u.name }), el('div', { class: 'sz', text: `${bytes(u.sent)} of ${bytes(u.size)}` }), el('div', { class: 'bar' }, [el('i', { style: `width:${Math.round(u.sent / Math.max(1, u.size) * 100)}%` })])]), el('span', { class: 'spin' })])]));
      }
      if (!kids.length) kids.push(el('div', { class: 'empty' }, [tile('drop', PAGE.drop.c, 54), el('div', { text: `No messages yet. Send a note, link or photo to ${pcName()}.` })]));
      thread.replaceChildren(...kids);
      if (atEnd || S.uploads.size) thread.scrollTop = thread.scrollHeight;
    };
  };

  function bubble(x) {
    const me = x.from === 'phone';
    const del = el('button', { text: 'Delete', onclick: () => send({ t: 'chat.del', id: x.id }) });
    const meta = el('div', { class: 'meta' }, [el('span', { text: `${me ? 'You' : pcName()} · ${ago(x.at)}` })]);
    const save = () => (ME.mobile && navigator.canShare ? shareFile(x) : (location.href = fileUrl(x)));
    let body;
    if (x.file) {
      if (isImage(x.file.name) && !/heic$/i.test(x.file.name)) {
        body = el('a', { class: 'photo', href: fileUrl(x, true), target: '_blank' }, [el('img', { src: fileUrl(x, true), alt: x.file.name, loading: 'lazy' })]);
      } else {
        body = el('div', { class: 'file' }, [
          el('div', { class: 'ext', text: (x.file.name.split('.').pop() || 'file').slice(0, 4) }),
          el('div', { style: 'min-width:0' }, [el('div', { class: 'nm', text: x.file.name }), el('div', { class: 'sz', text: bytes(x.file.size) })]),
          me ? el('span', { class: 'muted', text: '✓' }) : el('button', { class: 'get', 'aria-label': 'Save', onclick: save }, [icon('down', 18)]),
        ]);
      }
      if (!me) meta.append(el('button', { text: 'Save', onclick: save }));
    } else {
      body = el('div', { class: 'bubble' }, [linkify(x.text || '')]);
      meta.append(el('button', { text: 'Copy', onclick: () => copy(x.text) }));
    }
    meta.append(del);
    return el('div', { class: `msg ${me ? 'me' : 'them'}` }, [body, meta]);
  }

  const fileInput = el('input', { type: 'file', multiple: true, hidden: true });
  document.body.append(fileInput);
  let inDrop = false;
  fileInput.onchange = () => { const f = [...fileInput.files]; fileInput.value = ''; if (f.length) upload(f, inDrop); };
  function pickFiles(accept, drop) {
    if (!needOnline()) return;
    inDrop = !!drop;
    fileInput.accept = accept || '';
    fileInput.click();
  }
  let upSeq = 0;
  function upload(files, stay) {
    if (!needOnline()) return;
    if (!stay && cur !== 'files' && cur !== 'drop') go('files');
    for (const f of files) {
      const id = ++upSeq;
      const u = { name: f.name || 'photo.jpg', size: f.size, sent: 0 };
      S.uploads.set(id, u);
      const x = new XMLHttpRequest();
      x.open('POST', `/api/up?name=${encodeURIComponent(u.name)}&t=${encodeURIComponent(S.creds.token)}`);
      x.upload.onprogress = (e) => { u.sent = e.loaded; refresh('files', 'drop'); };
      x.onloadend = () => {
        S.uploads.delete(id);
        if (x.status !== 200) toast(`Could not send ${u.name}`);
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
    if (!t) { go('clipboard'); return toast('Paste into the text box, then tap Send'); }
    if (asMessage) send({ t: 'chat', text: t });
    else send({ t: 'clip.set', text: t });
    haptic();
    toast(asMessage ? `Sent to ${pcName()}` : `Copied to ${pcName()}`);
  }

  // ---- Clipboard ----
  BUILD.clipboard = (page) => {
    const hd = head('Clipboard');
    const text = el('div', { class: 'clip-text' });
    const when = el('span', { class: 'muted act' });
    const box = el('textarea', { class: 'field', rows: '3', placeholder: 'Type or paste text' });
    const sendB = btn('Send', () => { const t = box.value; if (!t) return; send({ t: 'clip.set', text: t }); box.value = ''; sendB.disabled = true; haptic(); toast(`Copied to ${pcName()}`); }, 'primary', 'send');
    sendB.disabled = true;
    box.oninput = () => { sendB.disabled = !box.value || !online(); };
    const hist = el('div', { class: 'card' });
    const histWrap = el('div', { class: 'card-wrap' }, [el('div', { class: 'card-title', text: 'History' }), hist]);
    const onPc = card('', [el('div', { class: 'pad16' }, [text, btn('Copy', () => copy(S.clip.text), 'soft big', 'copy')])], when);
    const toPc = card('', [el('div', { class: 'pad16' }, [box, el('div', { class: 'two' }, [btn('Paste from this device', () => pastePhone(), '', 'clipboard'), sendB])])]);
    const tip = row(ME.apple ? 'Copy with Back Tap' : 'Clipboard alerts', ME.apple ? 'Set up a shortcut to copy the computer’s clipboard with a double tap on the back of your iPhone' : 'Get notified when something is copied on the computer', [chev()], () => go(ME.apple ? 'shortcuts' : 'background'));
    page.append(hd, onPc, toPc, histWrap, card('', [tip]));
    return () => {
      hd.desc(`Copy text between this ${ME.kind} and ${pcName()}.`);
      onPc.setTitle(`${pcName()}’s clipboard`);
      toPc.setTitle(`Send to ${pcName()}`);
      text.textContent = S.clip.text || 'The clipboard is empty';
      text.classList.toggle('muted', !S.clip.text);
      when.textContent = S.clip.at ? ago(S.clip.at) : '';
      const h = (S.clip.history || []).slice(1, 12);
      histWrap.hidden = !h.length;
      hist.replaceChildren(...h.map((x) => row(x.text.replace(/\s+/g, ' ').slice(0, 120), `${x.from || ''} · ${ago(x.at)}`, [btn('Copy', () => copy(x.text), 'small')])));
    };
  };

  // ---- Remote ----
  BUILD.remote = (page) => {
    const hd = head('Remote');
    const why = note('', 'warn');
    page.append(
      hd, why,
      el('div', { class: 'stack', style: 'margin-bottom:18px' }, [
        el('button', { class: 'btn primary big', onclick: () => openRemote('pad') }, [icon('cursor'), 'Trackpad and keyboard']),
        el('button', { class: 'btn big', onclick: () => openRemote('gamepad') }, [icon('gamepad'), 'Gamepad']),
      ]),
      card('Gestures', [
        row('Trackpad', 'Slide to move · Tap to click · Touch and hold to right-click · Two fingers to scroll'),
        row('Gamepad', `Hold the ${ME.kind} in landscape. Buttons are mapped to keys on the computer and can be changed under Keys.`),
      ]),
    );
    return () => {
      hd.desc(`Use this ${ME.kind} as a trackpad, keyboard or gamepad for ${pcName()}.`);
      const r = S.remote;
      why.textContent = !online() ? `Not connected to ${pcName()}` : r && r.allowed === false ? (r.why || `Remote input is turned off in TwinDesk on ${pcName()}.`) : '';
      why.hidden = !why.textContent;
    };
  };

  // ---- Notifications ----
  BUILD.notifications = (page) => {
    const on = sw((v) => { const o = load(); o.notifs = v; save(o); S.notifsOn = v; send({ t: 'notifs', on: v }); if (!v) S.notifs = []; renderPage(); });
    const hd = head('Notifications', on);
    const bg = row('Lock screen alerts', '', [chev()], () => go('background'));
    const list = el('div');
    page.append(hd, card('', [bg]), list);
    return () => {
      hd.desc(`Notifications from ${pcName()}.`);
      on.checked = load().notifs !== false;
      on.disabled = !online();
      bg.setHint(S.alerts && S.alerts.notifs && notifPerm() === 'granted' ? 'On. Notifications also arrive when TwinDesk is closed.' : 'Receive these notifications when TwinDesk is closed');
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
            code && /code|otp|verif|password|pin/i.test(`${n.title} ${n.body}`) ? btn(`Copy code ${code[1]}`, () => copy(code[1]), 'small soft') : null,
          ]),
        ]);
      }) : [el('div', { class: 'empty' }, [tile('bell', PAGE.notifications.c, 54), el('div', { text: load().notifs === false ? 'Notifications are turned off.' : `No notifications yet.${S.pc && S.pc.os === 'mac' ? ' On macOS, TwinDesk needs Full Disk Access to read notifications.' : ''}` })])]));
    };
  };

  // ---- Mount ----
  BUILD.mount = (page) => {
    const hd = head('Mount');
    const body = el('div');
    page.append(hd, body);
    let asked = false;
    return () => {
      if (!asked && online()) { asked = true; send({ t: 'mount.get' }); }
      hd.desc(`Access ${pcName()}’s shared folder as a network drive${ME.apple ? ' in the Files app' : ''}.`);
      const m = S.mount;
      if (!m || !m.on) {
        body.replaceChildren(
          note(S.pc && S.pc.mount === false ? `Folder sharing is not available in this version of TwinDesk on ${pcName()}.` : `Folder sharing is off. Turn it on in TwinDesk on ${pcName()} under AirPlay & SMB.`, 'info'),
          card('', [row('Connection details', `The server address and sign-in details appear here once sharing is on.`)]),
        );
        return;
      }
      const url = m.url || `smb://${m.host}/${encodeURIComponent(m.share || '')}`;
      const unc = `\\\\${m.host}\\${m.share || ''}`;
      const field = (label, value) => el('div', {}, [el('div', { class: 'muted', style: 'font-size:12.5px', text: label }), copyBox(() => value)]);
      const steps = ME.apple ? [
        el('li', { html: 'Open <b>Files</b>, tap <b>•••</b> and choose <b>Connect to Server</b>.' }),
        el('li', { text: 'Enter the server address and tap Connect.' }),
        el('li', { html: 'Choose <b>Registered User</b>, enter the user name and password, and tap Next.' }),
        el('li', { text: `${pcName()} now appears under Shared in the Files app.` }),
      ] : ME.os === 'android' ? [
        el('li', { text: 'Open a file manager that supports SMB, such as Solid Explorer, CX File Explorer or Material Files.' }),
        el('li', { text: 'Add a network location (SMB) with the address, user name and password.' }),
      ] : ME.os === 'win' ? [
        el('li', {}, ['In File Explorer, enter ', el('span', { class: 'mono', text: unc }), ' in the address bar.']),
        el('li', { text: 'Sign in with the user name and password. To keep it, right-click it and choose Map network drive.' }),
      ] : ME.os === 'mac' ? [
        el('li', { html: 'In Finder, choose Go › <b>Connect to Server</b> (⌘K).' }),
        el('li', { text: 'Enter the server address, then the user name and password.' }),
      ] : [el('li', { text: 'In your file manager, choose Connect to Server and enter the server address.' })];
      body.replaceChildren(
        card('Connection details', [el('div', { class: 'pad16', style: 'gap:10px' }, [
          field('Server address', ME.os === 'win' ? unc : url),
          m.user ? field('User name', m.user) : null,
          m.password ? field('Password', m.password) : null,
        ])]),
        card('Instructions', [el('ol', { class: 'steps' }, steps)]),
        m.path ? card('', [row('Shared folder', m.path)]) : null,
      );
    };
  };

  // ---- Sound ----
  BUILD.sound = (page) => {
    const listen = sw((v) => (v ? startListen() : stopListen()));
    const micSw = sw((v) => (v ? startMic() : stopMic()));
    const lr = row('', '', [listen]);
    const mr = row('', '', [micSw]);
    const hd = head('Sound');
    const a = card('', [lr]);
    const b = card('', [mr]);
    page.append(hd, a, b);
    return () => {
      hd.desc(`Stream ${pcName()}’s audio to this ${ME.kind}, or use this ${ME.kind} as its microphone.`);
      a.setTitle('Computer audio');
      b.setTitle('Microphone');
      lr.setLabel(`Play ${pcName()}’s audio here`);
      lr.setHint(S.listening ? (S.screen.status === 'live' ? 'Playing' : 'Starting…') : 'Audio only, without the screen');
      listen.checked = S.listening;
      listen.disabled = !online();
      mr.setLabel(`Use as ${pcName()}’s microphone`);
      mr.setHint(!S.secure ? 'Requires a secure connection. Set it up under Connection.' : S.mic.on ? (S.mic.status === 'live' ? (S.mic.out ? `Live through ${S.mic.out}` : 'Live. Install a virtual audio device on the computer so apps can select it.') : 'Starting…') : 'Apps on the computer receive it through a virtual audio device');
      micSw.checked = S.mic.on;
      micSw.disabled = !online() || !S.secure;
    };
  };

  // ---- Camera ----
  BUILD.camera = (page) => {
    const camSw = sw((v) => (v ? startCam() : stopCam()));
    const flip = btn('Switch camera', () => { S.cam.facing = S.cam.facing === 'user' ? 'environment' : 'user'; if (S.cam.on) startCam(); }, 'small');
    const r = row('', '', [flip, camSw]);
    const prev = el('video', { playsinline: true, muted: true, autoplay: true });
    prev.muted = true;
    const prevWrap = el('div', { class: 'cam-preview' }, [prev]);
    const hd = head('Camera');
    page.append(hd, card('', [r, prevWrap]));
    return () => {
      hd.desc(`Use this ${ME.kind}’s camera on ${pcName()}. Turn on Virtual Camera in TwinDesk to use it in video calls.`);
      r.setLabel(`Use as ${pcName()}’s camera`);
      r.setHint(!S.secure ? 'Requires a secure connection. Set it up under Connection.' : S.cam.on ? (S.cam.status === 'live' ? 'Live' : 'Starting…') : `${S.cam.facing === 'user' ? 'Front' : 'Rear'} camera`);
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
    const hd = head('Background');
    const kaSw = sw((v) => { prefs.keepAlive = v; savePrefs(); keepAlive(v); renderPage(); });
    const kaRow = row('Stay connected in the background', '', [kaSw]);
    const mediaRow = row('Lock screen controls', '');
    const nBtn = btn('Allow', () => enablePush(), 'small primary');
    const nRow = row('Notifications', '', [nBtn]);
    const testRow = row('Test notification', 'Sends a test alert from the computer', [btn('Send test', () => { if (needOnline()) send({ t: 'push.test' }); }, 'small')]);
    const A = [
      ['clip', 'Clipboard changes', 'When text is copied on the computer'],
      ['drop', 'Drop messages', ''],
      ['files', 'Incoming files', ''],
      ['notifs', 'Computer notifications', 'Forwards each notification shown on the computer'],
      ['preview', 'Show previews', 'Include the text or file name in alerts'],
      ['badge', 'App icon badge', 'Shows the number of unread alerts'],
    ];
    const sws = {};
    const aRows = A.map(([k, l, h]) => {
      sws[k] = sw((v) => { S.alerts = { ...(S.alerts || {}), [k]: v }; send({ t: 'alerts', alerts: S.alerts }); if (k === 'badge' && !v) setBadge(0); });
      return row(l, h, [sws[k]]);
    });
    const why = note('', 'info');
    page.append(hd, card('Connection', [kaRow, mediaRow]), card('Notifications', [nRow, testRow]), card('Alerts', aRows), why);
    return () => {
      hd.desc(`Keep receiving updates from ${pcName()} while this ${ME.kind} is locked or another app is open.`);
      kaSw.checked = prefs.keepAlive;
      kaRow.setHint(ME.apple
        ? 'Plays inaudible audio so iOS keeps the connection open. Other audio pauses briefly when it starts, and battery use increases slightly.'
        : ME.os === 'android' ? 'Plays inaudible audio so the browser does not suspend the page.'
          : 'Prevents the browser from suspending this page. Most desktop browsers stay connected without it.');
      mediaRow.setHint(S.pc && S.pc.media ? `Shows media playing on ${pcName()} with play, pause and skip controls` : `Shows “Connected to ${pcName()}” on the lock screen`);
      mediaRow.hidden = !prefs.keepAlive;
      const p = notifPerm();
      const needsHome = ME.apple && !STANDALONE;
      nRow.setHint(!S.secure ? 'Requires a secure connection. Set it up under Connection.'
        : needsHome ? 'On iPhone and iPad, notifications require TwinDesk on the Home Screen. In Safari, tap Share › Add to Home Screen, then open TwinDesk from there.'
          : p === 'unsupported' ? 'This browser does not support web notifications.'
            : p === 'denied' ? 'Blocked. Allow notifications for this site in your browser settings.'
              : p === 'granted' ? (S.push ? 'On. Alerts arrive even when TwinDesk is closed. Both devices need internet access.' : canPush() ? 'On while TwinDesk is open. Turn on push to receive alerts when it is closed.' : 'On while TwinDesk is open in the background.')
                : 'Off');
      nBtn.hidden = !S.secure || needsHome || p === 'unsupported' || p === 'denied' || (p === 'granted' && (S.push || !canPush()));
      nBtn.textContent = p === 'granted' ? 'Turn on push' : 'Allow';
      testRow.hidden = p !== 'granted';
      const a = S.alerts || {};
      for (const [k] of A) { sws[k].checked = !!a[k]; sws[k].disabled = !online(); }
      aRows[3].setLabel(`${pcName()} notifications`);
      aRows[5].hidden = !('setAppBadge' in navigator);
      why.textContent = ME.apple ? 'iOS only lets a page copy to the clipboard after a tap. Tapping a clipboard alert opens TwinDesk with the text ready to copy. To copy in one step, add the Copy from computer shortcut under Shortcuts.' : '';
      why.hidden = !why.textContent;
    };
  };

  // ---- Shortcuts ----
  // iPhone and iPad: signed shortcuts (web/shortcuts/*.shortcut, made by web/shortcuts-src). Each asks
  // for its link when it's added; Add copies this device's link first, so it's a tap and a paste.
  BUILD.shortcuts = (page) => {
    const hd = head('Shortcuts');
    const body = el('div');
    page.append(hd, body);
    let key = '';
    return () => {
      hd.desc(ME.apple ? `Use TwinDesk from the share sheet, Back Tap and Siri.` : `Use TwinDesk from the share menu, the app icon and scripts.`);
      const k = JSON.stringify([S.creds && S.creds.token, S.pc && S.pc.host, S.secure, ME.os, !!installEvt]);
      if (k === key) return;
      key = k;
      const token = (S.creds && S.creds.token) || '';
      const port = (S.pc && S.pc.port) || 47870;
      const base = S.secure && S.pc && S.pc.host ? `https://${S.pc.host}:${port}` : `http://${(S.pc && S.pc.ips && S.pc.ips[0]) || location.hostname}:${port + 1}`;
      const U = (p, extra = '') => `${base}${p}?t=${token}${extra}`;
      const warn = note(`Set up a secure connection first (Connection). Shortcuts then keep working when ${pcName()}’s network address changes.`, 'warn');
      warn.hidden = S.secure;
      const security = note('Shortcut links include this device’s access key. Anyone with a link can use it on your network. Forgetting this device revokes them.', '');
      if (ME.apple) {
        const sc = (ic, colors, file, title, desc, tip, url) => {
          const add = el('button', { class: 'btn big add', type: 'button', onclick: async () => {
            await copyText(url);
            haptic();
            toast('Link copied. Paste it when Shortcuts asks.');
            setTimeout(() => { location.href = `/shortcuts/${encodeURIComponent(file)}.shortcut`; }, 350);
          } }, [icon('plus'), 'Add to Shortcuts']);
          return el('div', { class: 'sc' }, [
            el('div', { class: 'top' }, [tile(ic, colors, 44), el('div', {}, [el('b', { text: title }), el('span', { text: desc })])]),
            add,
            tip ? el('div', { class: 'tip', text: tip }) : null,
          ]);
        };
        body.replaceChildren(
          warn,
          el('div', { class: 'sc-grid' }, [
            sc('clipboard', PAGE.clipboard.c, 'Copy from computer', 'Copy from computer', `Copies ${pcName()}’s clipboard to this ${ME.kind}`, 'Tip: assign it to Back Tap in Settings › Accessibility › Touch › Back Tap.', U('/api/clip')),
            sc('up', PAGE.files.c, 'Send clipboard', 'Send clipboard', `Copies this ${ME.kind}’s clipboard to ${pcName()}`, 'Tip: assign it to a triple Back Tap.', U('/api/clip')),
            sc('share', PAGE.drop.c, 'Send to computer', 'Send to computer', 'Sends photos and files from the share sheet', `Files are saved to ${pcName()}’s Downloads folder.`, U('/api/up')),
            sc('link', PAGE.send.c, 'Send to Drop', 'Send to Drop', 'Sends links and text from the share sheet', '', U('/api/drop')),
          ]),
          card('How it works', [el('ol', { class: 'steps' }, [
            el('li', { html: 'Tap <b>Add to Shortcuts</b>. TwinDesk copies a link for this device.' }),
            el('li', { html: 'In Shortcuts, tap <b>Set Up Shortcut</b> and paste the link when asked.' }),
            el('li', { text: 'Tap Add Shortcut.' }),
          ])]),
          security,
        );
      } else if (ME.os === 'android') {
        const inst = installBtn();
        body.replaceChildren(
          card('Share menu', [row('Share to TwinDesk', STANDALONE ? `Share photos, files and links from any app to ${pcName()}.` : 'Install TwinDesk to add it to the Android share menu.', [inst])]),
          card('App shortcuts', [row('Quick actions', 'Touch and hold the TwinDesk icon for Send files, Clipboard and Trackpad.')]),
          card('Automation apps', [el('div', { class: 'pad16', style: 'gap:8px' }, [
            el('div', { class: 'muted', text: 'Use this link in Tasker, MacroDroid or HTTP Shortcuts to read (GET) or set (POST) the computer’s clipboard.' }),
            copyBox(() => U('/api/clip')),
          ])]),
          security,
        );
      } else {
        const inst = installBtn();
        body.replaceChildren(
          warn,
          card('', [row('Install as an app', 'Opens TwinDesk in its own window', [inst])]),
          card('Command line', [el('div', { class: 'pad16', style: 'gap:8px' }, [
            el('div', { class: 'muted', text: `Read ${pcName()}’s clipboard` }), copyBox(() => `curl -s "${U('/api/clip')}"`),
            el('div', { class: 'muted', text: 'Set the clipboard' }), copyBox(() => `echo "text" | curl -s --data-binary @- "${U('/api/clip')}"`),
            el('div', { class: 'muted', text: 'Send a file' }), copyBox(() => `curl -s --data-binary @photo.jpg "${U('/api/up', '&name=photo.jpg')}"`),
          ])]),
          security,
        );
      }
    };
  };

  // ---- General ----
  BUILD.general = (page) => {
    const nameIn = el('input', { class: 'field', style: 'width:200px;text-align:right;padding:9px 12px;font-size:15px', placeholder: ME.model });
    nameIn.onchange = () => { const o = load(); o.name = nameIn.value.trim(); save(o); send({ t: 'rename', name: o.name || ME.model }); toast('Name updated'); renderTop(); };
    const look = () => { savePrefs(); applyLook(); frame(); };
    const themeSeg = seg([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], () => prefs.theme, (v) => { prefs.theme = v; look(); });
    const sw8 = el('div', { class: 'swatches' }, ACCENTS.map((c) => el('button', { type: 'button', 'aria-label': c, style: `background:${c}`, class: prefs.accent === c ? 'on' : '', onclick: () => { prefs.accent = c; look(); } })));
    const hd = head('General');
    const nameRow = row('Device name', '', [nameIn]);
    page.append(
      hd,
      card('Appearance', [row('Theme', '', [themeSeg]), row('Accent color', '', [sw8])]),
      card('This device', [nameRow]),
    );
    return () => {
      hd.desc('Appearance and device settings.');
      nameRow.setHint(`The name shown on ${pcName()}`);
      if (document.activeElement !== nameIn) nameIn.value = load().name || '';
    };
  };

  async function secureNow() {
    const host = S.pc && S.pc.host;
    const port = (S.pc && S.pc.port) || Number(location.port) - 1;
    const frag = S.creds ? `#d=${encodeURIComponent(S.creds.id)}&k=${encodeURIComponent(S.creds.key)}` : location.hash;
    for (const base of [host && `https://${host}:${port}`, `https://${location.hostname}:${port}`].filter(Boolean)) {
      if (await reachable(base)) return location.replace(`${base}/${frag}`);
    }
    toast(ME.apple ? 'The certificate is not trusted yet. Install the profile and enable it in Certificate Trust Settings.' : 'The certificate is not trusted yet. Install it as a certificate authority.');
  }

  function forgetHere() {
    if (S.creds && online()) send({ t: 'forget' });
    stopCam(true); stopMic(true); stopListen();
    unsubscribePush();
    dropCreds('');
  }

  // ---- About ----
  BUILD.about = (page) => {
    page.append(
      el('div', { class: 'promo', style: 'padding-top:6px' }, [
        el('img', { class: 'logo', src: logo(), alt: '' }),
        el('h1', { text: 'TwinDesk' }),
        el('p', { class: 'ver' }),
      ]),
      card('', [
        row('TwinDesk Web', 'Served by TwinDesk on your computer over your local network. Push notifications are end-to-end encrypted and relayed by your browser’s push service.'),
        row('Source code', 'github.com/InukaAsith/TwinDesk', [chev()], () => window.open('https://github.com/InukaAsith/TwinDesk', '_blank')),
      ]),
      downloads(),
    );
    return () => { page.querySelector('.ver').textContent = S.pc && S.pc.version ? `Version ${S.pc.version} on ${pcName()}` : ''; };
  };

  // ---------------------------------------------------------------- the phone app's pages, full screen
  const frames = { viewer: null, remote: null };
  const queued = { viewer: [], remote: [] };
  let overlay = null;

  function toFrame(kind, m) {
    const w = frames[kind];
    if (w && typeof w.tdRecv === 'function') { try { w.tdRecv(m); } catch (e) { console.warn(e); } } else if (overlay && overlay.kind === kind) queued[kind].push(m);
  }

  const CONTROLS = [['lsUp', 'Left stick up'], ['lsLeft', 'Left stick left'], ['lsDown', 'Left stick down'], ['lsRight', 'Left stick right'], ['l3', 'L3'], ['r3', 'R3'],
    ['a', 'A'], ['b', 'B'], ['x', 'X'], ['y', 'Y'], ['lb', 'LB'], ['rb', 'RB'], ['lt', 'LT'], ['rt', 'RT'],
    ['up', 'D-pad up'], ['down', 'D-pad down'], ['left', 'D-pad left'], ['right', 'D-pad right'], ['back', 'Back'], ['start', 'Start']];
  const PAD_DEFAULTS = { lsUp: 'KeyW', lsLeft: 'KeyA', lsDown: 'KeyS', lsRight: 'KeyD', l3: 'ShiftLeft', r3: 'KeyV', a: 'Space', b: 'ControlLeft', x: 'KeyR', y: 'KeyE', lb: 'KeyQ', rb: 'KeyF', lt: 'Mouse1', rt: 'Mouse0', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', back: 'Tab', start: 'Escape' };
  const KEYS = [['', 'Nothing'], ['Mouse0', 'Left click'], ['Mouse1', 'Right click'], ['Mouse2', 'Middle click'],
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => [`Key${c}`, c]), ...'0123456789'.split('').map((d) => [`Digit${d}`, d]),
    ['Space', 'Space'], ['Enter', 'Enter'], ['Escape', 'Esc'], ['Tab', 'Tab'], ['Backspace', 'Backspace'], ['ShiftLeft', 'Shift'], ['ControlLeft', 'Ctrl'], ['AltLeft', 'Alt'],
    ['ArrowUp', 'Up arrow'], ['ArrowDown', 'Down arrow'], ['ArrowLeft', 'Left arrow'], ['ArrowRight', 'Right arrow'],
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
      if (m.t === 'pair.sync') return toast(`Turn on Remote in TwinDesk on ${pcName()}`);
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
      const handle = el('button', { class: 'vhandle', 'aria-label': 'Show the bar', onclick: () => wake() });
      const wake = () => { bar.classList.remove('away'); clearTimeout(hideT); hideT = setTimeout(() => bar.classList.add('away'), 3500); };
      bar.onpointerdown = wake;
      const b = (ic, label, fn, cls = '') => el('button', { type: 'button', class: cls, onclick: () => { fn(); wake(); } }, [icon(ic), label ? el('span', { text: label }) : null]);
      paintBar = () => {
        if (!overlay || overlay.kind !== 'viewer') return;
        const ext = !!(S.pc && S.pc.extend);
        bar.replaceChildren(...[
          ext ? b('extend', 'Extend', () => { prefs.mode = 'extend'; savePrefs(); startScreen(); paintBar(); }, prefs.mode === 'extend' ? 'on' : '') : null,
          ext ? b('mirror', 'Mirror', () => { prefs.mode = 'mirror'; savePrefs(); startScreen(); paintBar(); }, prefs.mode !== 'extend' ? 'on' : '') : null,
          ext ? el('span', { class: 'sep' }) : null,
          b('keyboard', ME.mobile ? '' : 'Keyboard', () => { kb = !kb; toFrame('viewer', { t: 'keyboard', on: kb }); }, kb ? 'on' : ''),
          b('audio', '', () => { prefs.sound = !prefs.sound; savePrefs(); toFrame('viewer', optsFor('viewer')); paintBar(); }, prefs.sound ? 'on' : ''),
          document.fullscreenEnabled ? b('full', '', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})) : null,
          el('span', { class: 'sep' }),
          b('stop', 'Close', () => closeOverlay(), 'stop'),
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
  function keepAlive(on) {
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
        ? { title: m.title, artist: m.artist || '', album: m.album || `on ${pcName()}`, artwork: m.art ? [{ src: m.art, sizes: '512x512' }] : [{ src: '/icon.png', sizes: '512x512', type: 'image/png' }] }
        : { title: `Connected to ${pcName()}`, artist: 'TwinDesk', album: online() ? 'Running in the background' : 'Reconnecting…', artwork: [{ src: '/icon.png', sizes: '512x512', type: 'image/png' }] });
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
    if (typeof Notification === 'undefined') return toast('This browser does not support web notifications');
    let p = Notification.permission;
    if (p !== 'granted') p = await Notification.requestPermission();
    if (p !== 'granted') { renderPage(); return toast('Notifications are blocked for this site'); }
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
      if (loud) toast(`Push notifications from ${pcName()} are on`);
      return true;
    } catch (e) {
      if (loud) toast(`Could not turn on push notifications: ${e.message}`);
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
    toast(`Sent to ${pcName()}`);
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
    if (navigator.mediaSession) navigator.mediaSession.metadata = new MediaMetadata({ title: `${pcName()} audio`, artist: 'TwinDesk', artwork: [{ src: '/icon.png', sizes: '512x512', type: 'image/png' }] });
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
      pc.ontrack = (e) => { laudio.srcObject = new MediaStream([e.track]); laudio.play().catch(() => toast('Tap the audio switch again to start playback')); };
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
  const outs = { cam: null, mic: null };
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
    if (!S.secure) return toast('The camera requires a secure connection. Set it up under Connection.');
    try {
      if (S.cam.stream) S.cam.stream.getTracks().forEach((t) => t.stop());
      S.cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: S.cam.facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false });
      S.cam.on = true;
      S.cam.status = 'connecting';
      await offerOut('cam', S.cam.stream);
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? 'Allow camera access for this site in Settings' : `Camera: ${e.message}`);
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
    if (!S.secure) return toast('The microphone requires a secure connection. Set it up under Connection.');
    try {
      S.mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      S.mic.on = true;
      S.mic.status = 'connecting';
      await offerOut('mic', S.mic.stream);
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? 'Allow microphone access for this site in Settings' : `Microphone: ${e.message}`);
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
    if (await upgrade()) return;
    if (!S.creds) {
      S.conn = 'pairing';
      S.serving = await reachable('');
      render();
    }
    if (S.creds && prefs.keepAlive) armKeepAlive();
    connect();
  })();
})();

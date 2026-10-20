// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Main window shell: sidebar + one page per registered tab (ui-*.js), pairing banner, accent
// rendering of the state pushed by main. Same structure and look as the Mac's.
'use strict';

(() => {
  const { el, api } = UI;
  const $ = (id) => document.getElementById(id);
  const nav = $('nav');
  const pages = $('pages');
  const views = new Map(); // id -> { def, page, navBtn, stateEl, master, render }
  let current = null;

  // Sidebar groups: no headings, one icon column, a small gap
  // between groups; General sits below a line.
  const GROUP = { overview: 0, 'mac-pc': 1, 'pc-mac': 1, cursor: 2, keyboard: 2, clipboard: 3, notifications: 3, files: 3, terminal: 4, audio: 4, apps: 4 };
  let lastGroup;
  for (const def of UI.tabs.slice().sort((a, b) => (a.order ?? 50) - (b.order ?? 50))) {
    if (def.navHidden) { // reached another way (the phone tile)
      views.set(def.id, { def, ...buildPage(def), navBtn: el('button'), stateEl: el('span') });
      continue;
    }
    const group = GROUP[def.id];
    if (!def.bottom && lastGroup !== undefined && group !== lastGroup) nav.append(el('li', { class: 'gap', attrs: { role: 'presentation' } }));
    lastGroup = group;
    if (def.bottom && !nav.querySelector('.sep')) nav.append(el('li', { class: 'sep', attrs: { role: 'presentation' } })); // one line above General and About
    const stateEl = el('span', { class: 'state' });
    const navLabel = el('span', { class: 'label', text: def.title });
    const tile = el('span', { class: 'tile' }, [UI.icon(def.icon || def.id)]);
    tile.style.background = def.color; // CSSOM, allowed by the CSP (inline style attributes aren't)
    const navBtn = el('button', { class: 'nav-item', attrs: { role: 'tab', 'aria-controls': 'page-' + def.id } }, [
      tile,
      navLabel,
      stateEl,
    ]);
    navBtn.onclick = () => show(def.id, true);
    nav.append(el('li', {}, [navBtn]));
    views.set(def.id, { def, ...buildPage(def), navBtn, stateEl, navLabel });
  }

  function buildPage(def) {
    const page = el('section', { class: 'page', id: 'page-' + def.id, hidden: true, attrs: { role: 'tabpanel' } });
    const headText = el('span', { text: def.heading || def.title });
    const limitNote = def.macOnly ? UI.note('info', '') : null;
    const titles = el('div', { class: 'titles' }, [
      el('h1', {}, [headText, def.phase ? el('span', { class: 'pill muted', text: 'Phase ' + def.phase }) : null]),
      el('p', { text: def.desc || '' }),
    ]);
    let master = null;
    if (def.master) {
      master = UI.switch((v) => def.master.set(v), { label: def.title, disabled: !!def.master.disabled });
    }
    page.append(el('header', { class: 'page-head' }, [titles, master ? master.el : null]));
    const body = el('div', { class: 'page-body' }, limitNote ? [limitNote] : []);
    page.append(body);
    pages.append(page);
    const render = def.build(body, page) || (() => {});
    return { page, master, render, headText, limitNote };
  }

  function show(id, user) {
    const v = views.get(id) || views.get('overview');
    if (current === v) return;
    if (current) {
      current.page.hidden = true;
      current.navBtn.classList.remove('active');
      current.navBtn.setAttribute('aria-selected', 'false');
    }
    current = v;
    v.page.hidden = false;
    v.navBtn.classList.add('active');
    v.navBtn.setAttribute('aria-selected', 'true');
    $('content').scrollTop = 0;
    for (const t of $('phones').children) t.classList.toggle('active', v.def.id === 'phone' && t.dataset.connected === '1');
    if (user) api.setTab(v.def.id);
    if (UI.state) renderPage(v, UI.state);
  }

  function renderPage(v, s) {
    // macOnly: true = only with a Mac; 'linux' = everything but a Linux peer (Apps).
    const limited = !v.limitNote || !s.peer ? '' : v.def.macOnly === 'linux' ? (s.peer.os === 'linux' ? 'Not on Linux yet' : '') : UI.peer(s).limited;
    if (v.limitNote) v.limitNote.set(limited);
    if (v.master) {
      const d = v.def.master.disabled; // a boolean, or (s) => boolean
      v.master.disable(!!(typeof d === 'function' ? d(s) : d) || !!limited);
      const on = !limited && !!v.def.master.get(s);
      v.master.set(on);
      v.page.classList.toggle('off', !on);
    }
    try {
      v.render(s);
    } catch (e) {
      console.error('render ' + v.def.id + ':', e);
    }
    UI.fillTree(v.page); // device names in whatever the render wrote
  }

  function renderSidebar(s) {
    const l = s.link;
    const dot = l.state === 'connected' ? 'good' : l.state === 'identity_changed' ? 'bad'
      : (s.pairing || l.state === 'connecting' || l.state === 'reconnecting') ? 'warn' : '';
    $('peer-dot').className = 'dot ' + dot;
    let text = 'Not paired';
    if (l.state === 'connected') text = l.macName + (l.rtt != null ? ' · ' + l.rtt + ' ms' : '');
    else if (s.pairing) text = 'Pairing…';
    else if (l.state === 'connecting' || l.state === 'reconnecting') text = 'Reconnecting…';
    else if (l.state === 'identity_changed') text = 'Identity changed';
    $('peer-text').textContent = text;
    renderPhones(s);
    // Tabs that don't apply to the peer (a phone has no terminal or screen to share to it…).
    for (const v of views.values()) {
      const hide = !!(v.def.hidden && v.def.hidden(s));
      if (v.navBtn.parentElement) v.navBtn.parentElement.hidden = hide;
      if (hide && current === v) show(s.phone && s.phone.connected ? 'phone' : 'overview', false);
    }
    for (const v of views.values()) {
      const b = v.def.badge ? v.def.badge(s) : v.def.phase ? 'P' + v.def.phase : '';
      v.stateEl.className = 'state' + (b === 'on' ? ' on' : b === 'warn' ? ' warn' : '');
      v.stateEl.textContent = b === 'on' || b === 'warn' ? '' : b || '';
    }
  }

  // Paired phones nearby, above Overview: the phone's wallpaper, its name and the link. Clicking
  // one connects it (the computer steps aside); the connected one opens its page.
  let phonesKey = '';
  let assetsSeen = '';
  function renderPhones(s) {
    const ph = s.phone || { nearby: [] };
    const assetsKey = (ph.activeId || '') + ':' + ph.assets; // the counter is per phone: two phones can show the same number
    if (assetsKey !== assetsSeen) {
      assetsSeen = assetsKey;
      api.phoneAssets().then((a) => {
        UI.phoneAssets = a;
        UI.phoneWall = a.wallpaper ? 'url("' + a.wallpaper + '")' : '';
        phonesKey = '';
        if (UI.state) render(UI.state);
      }, () => {});
    }
    const info = ph.info || {};
    const colors = info.colors && info.colors.length ? info.colors : null;
    const key = JSON.stringify([ph.nearby, ph.connecting, ph.connected && ph.connected.rttMs, ph.phones, ph.activeId, ph.held, info.battery, info.charging, colors, UI.phoneWall ? UI.phoneWall.length : 0, current && current.def.id]);
    if (key === phonesKey) return;
    phonesKey = key;
    $('phones').replaceChildren(...ph.nearby.map((d) => {
      const mine = (ph.phones || []).find((x) => x.id === d.id) || null; // this phone's own numbers, not the active one's
      const dcolors = mine && mine.colors ? mine.colors : colors;
      const wall = el('span', { class: 'phone-wall' }, [UI.icon('phone')]);
      if (d.connected && UI.phoneWall && (!ph.activeId || ph.activeId === d.id)) wall.style.backgroundImage = UI.phoneWall;
      else if (d.connected && dcolors) wall.style.backgroundImage = 'linear-gradient(160deg, ' + dcolors.join(', ') + (dcolors.length === 1 ? ', ' + dcolors[0] : '') + ')';
      const connecting = ph.connecting && ph.connecting.id === d.id;
      const sub = d.connected
        ? ((mine ? mine.rttMs : ph.connected && ph.connected.rttMs) != null ? (mine ? mine.rttMs : ph.connected.rttMs) + ' ms' : 'Connected')
          + ((mine ? mine.battery : info.battery) != null ? ' · ' + (mine ? mine.battery : info.battery) + '%' + ((mine ? mine.charging : info.charging) ? ' ⚡' : '') : '')
        : connecting ? 'Connecting…' : 'Nearby · Click to connect';
      const b = el('button', { class: 'phone-tile' + (d.connected ? ' connected' : ''), title: d.connected ? d.name : 'Connect to ' + d.name }, [
        wall,
        el('span', { class: 'phone-text' }, [el('span', { class: 'phone-name', text: d.name }), el('span', { class: 'phone-sub', text: sub })]),
        d.connected ? el('span', { class: 'dot good' }) : null,
      ]);
      b.dataset.connected = d.connected ? '1' : '';
      b.classList.toggle('active', d.connected && current && current.def.id === 'phone' && (!ph.activeId || ph.activeId === d.id)); // only the phone whose page is open
      // A connected phone: make it the selected device first, so its own page opens (not the last one that connected).
      b.onclick = () => {
        if (!d.connected) return api.connectPhone(d.id);
        Promise.resolve(api.setActivePeer(d.id)).then(() => show('phone', true), () => show('phone', true));
      };
      return b;
    }));
  }

  function renderBanner(s) {
    const p = s.pairing;
    $('banner').hidden = !p;
    if (!p) return;
    $('banner').classList.toggle('failed', p.phase === 'failed');
    const host = p.role === 'host'; // another computer asks to pair with this PC
    $('pair-title').textContent = host ? p.macName + ' wants to pair' : 'Pairing with ' + p.macName;
    $('pair-code-wrap').hidden = !p.code;
    $('pair-code').textContent = p.code ? p.code.slice(0, 3) + ' ' + p.code.slice(3) : '';
    $('pair-match').hidden = host ? !p.code || p.allowed : p.phase !== 'code';
    $('pair-match').textContent = host ? 'Allow' : 'Codes match';
    $('pair-cancel').textContent = host ? 'Deny' : p.phase === 'failed' ? 'Close' : 'Cancel';
    const hints = {
      connecting: 'Connecting to ' + p.address + '…',
      starting: 'Waiting for ' + p.macName + '…',
      code: 'Check that ' + p.macName + ' shows the same code, then click Codes match.',
      waiting: 'Waiting for Allow on ' + p.macName + '…',
      failed: p.error,
      request: !p.code ? 'Waiting for the code…' : p.allowed ? 'Waiting for ' + p.macName + '…' : 'Check that ' + p.macName + ' shows the same code, then click Allow.',
    };
    $('pair-hint').textContent = hints[p.phase] || '';
  }

  $('content').append(UI.setup.page); // Setup screen in place of the tabs while something isn't ready

  // Titles name what is connected: the Display tabs and every
  // direction card title follow the peer.
  let peerKey = '';
  function renderPeer(s) {
    const p = UI.peer(s);
    const key = p.toMe + '|' + p.fromMe + '|' + p.os;
    if (key === peerKey) return;
    peerKey = key;
    // The Display tabs keep their names (Receive screen / Share screen); headings name the peer.
    const heads = { 'mac-pc': p.Name + ' on ' + p.me, 'pc-mac': p.me + ' on ' + p.name }; // as the Mac: "Inuka on Inukas-MBA"
    for (const [id, text] of Object.entries(heads)) {
      const v = views.get(id);
      if (v) v.headText.textContent = text;
    }
    for (const e of document.querySelectorAll('[data-dir="m2p"]')) e.textContent = p.toMe;
    for (const e of document.querySelectorAll('[data-dir="p2m"]')) e.textContent = p.fromMe;
    // Sentences and route heads with the real name ({name}, {the}, {them}).
    for (const e of document.querySelectorAll('[data-peer]')) e.textContent = e.dataset.peer.replace(/\{(\w+)\}/g, (m, k) => (k in p ? p[k] : m));
    for (const e of document.querySelectorAll('[data-os="peer"]')) e.className = 'os-ico ' + UI.osClass(p.os);
    for (const e of document.querySelectorAll('.route')) e.setAttribute('aria-label', [...e.querySelectorAll('.nm')].map((n) => n.textContent).join(' to '));
  }

  function render(s) {
    UI.state = s;
    renderPeer(s);
    UI.setup.render(s);
    UI.fillTree(UI.setup.page);
    pages.hidden = !UI.setup.page.hidden;
    renderSidebar(s);
    renderBanner(s);
    if (current) renderPage(current, s);
  }

  $('pair-match').onclick = () => (UI.state && UI.state.pairing && UI.state.pairing.role === 'host' ? api.respondPair(true) : api.confirmCode());
  $('pair-cancel').onclick = () => api.cancelPair();
  window.addEventListener('macshare-go', (e) => show(e.detail, true));
  api.onGo((tab) => typeof tab === 'string' && views.has(tab) && show(tab, true));

  // ↑/↓ move between tabs while the sidebar has focus.
  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const ids = [...views.keys()].filter((id) => { const v = views.get(id); return !v.def.navHidden && !(v.def.hidden && UI.state && v.def.hidden(UI.state)); });
    const i = ids.indexOf(current.def.id) + (e.key === 'ArrowDown' ? 1 : -1);
    const next = ids[(i + ids.length) % ids.length];
    show(next, true);
    views.get(next).navBtn.focus();
  });

  // Relative times ("2 min ago") age without a state push.
  setInterval(() => UI.state && current && renderPage(current, UI.state), 15000);

  api.onState(render);
  api.getState().then((s) => {
    show((s.ui && s.ui.tab) === 'phone' && !(s.phone && s.phone.connected) ? 'overview' : (s.ui && s.ui.tab) || 'overview', false);
    render(s);
  });
})();

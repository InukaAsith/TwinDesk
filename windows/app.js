// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Main window shell: sidebar + one page per registered tab (ui-*.js), pairing banner, accent
// rendering of the state pushed by main. Same structure and look as the Mac's.
'use strict';

(() => {
  const { el, api } = UI;
  const t = window.I18n.t;
  const $ = (id) => document.getElementById(id);
  const nav = $('nav');
  const pages = $('pages');
  const views = new Map(); // id -> { def, page, navBtn, stateEl, master, render }
  let current = null;

  // Sidebar groups: no headings, one icon column, a small gap between groups: the device and
  // Connection, the phone's own things, screens, input, sharing, media; Multi-device, General and
  // About below a line. ORDER places each tab (the tab files' own order is the fallback).
  const GROUP = { overview: 0, connection: 0, messages: 1, calls: 1, media: 1, papps: 1, mirror: 2, 'mac-pc': 2, 'pc-mac': 2, share: 2, apps: 2, cursor: 3, keyboard: 3, remote: 3, clipboard: 4, drop: 4, notifications: 4, files: 4, pfiles: 4, mount: 4, audio: 5, camera: 5, rezume: 5, terminal: 5 };
  const ORDER = { overview: 0, connection: 1, messages: 5, calls: 6, media: 7, papps: 8, mirror: 10, 'mac-pc': 11, 'pc-mac': 12, share: 12, apps: 13, cursor: 20, keyboard: 21, remote: 22, clipboard: 40, drop: 41, notifications: 42, files: 43, pfiles: 44, mount: 45, audio: 60, camera: 61, rezume: 62, terminal: 63, multi: 95, general: 100, about: 110 };
  // Older names for a page (saved in settings, sent by the tray or a popup).
  const ALIAS = { phone: 'overview' };
  const orderOf = (d) => ORDER[d.id] ?? d.order ?? 50;
  let lastGroup;
  let gap = null; // the gap before the current group (hidden with the group: renderSidebar)
  for (const def of UI.tabs.slice().sort((a, b) => orderOf(a) - orderOf(b))) {
    if (def.navHidden) { // reached another way (the phone tile)
      views.set(def.id, { def, ...buildPage(def), navBtn: el('button'), stateEl: el('span') });
      continue;
    }
    const group = GROUP[def.id];
    if (!def.bottom && lastGroup !== undefined && group !== lastGroup) nav.append(gap = el('li', { class: 'gap', attrs: { role: 'presentation' } }));
    lastGroup = group;
    if (def.bottom && !nav.querySelector('.sep')) nav.append(el('li', { class: 'sep', attrs: { role: 'presentation' } })); // one line above General and About
    const stateEl = el('span', { class: 'state' });
    const navLabel = el('span', { class: 'label', text: t(def.title) });
    const tile = el('span', { class: 'tile' }, [UI.icon(def.icon || def.id)]);
    tile.style.background = def.color; // CSSOM, allowed by the CSP (inline style attributes aren't)
    const navBtn = el('button', { class: 'nav-item', attrs: { role: 'tab', 'aria-controls': 'page-' + def.id } }, [
      tile,
      navLabel,
      stateEl,
    ]);
    navBtn.onclick = () => show(def.id, true);
    nav.append(el('li', {}, [navBtn]));
    views.set(def.id, { def, ...buildPage(def), navBtn, stateEl, navLabel, gap });
  }

  function buildPage(def) {
    const page = el('section', { class: 'page', id: 'page-' + def.id, hidden: true, attrs: { role: 'tabpanel' } });
    const headText = el('span', { text: t(def.heading || def.title) });
    const limitNote = def.macOnly ? UI.note('info', '') : null;
    const titles = el('div', { class: 'titles' }, [
      el('h1', {}, [headText, def.phase ? el('span', { class: 'pill muted', text: t('Phase {phase}', { phase: def.phase }) }) : null,
        def.tag ? el('span', { class: 'pill beta', text: t(def.tag) }) : null]),
      el('p', { text: t(def.desc || '') }),
    ]);
    let master = null;
    if (def.master) {
      master = UI.switch((v) => def.master.set(v), { label: t(def.title), disabled: !!def.master.disabled });
    }
    page.append(el('header', { class: 'page-head' }, [titles, master ? master.el : null]));
    // Over Bluetooth, a page that needs Wi-Fi (and doesn't move the session onto it) says so, with
    // the button that moves it there.
    const wifiNote = def.wifiOnly ? UI.wifiGate() : null;
    if (wifiNote) page.append(wifiNote.el);
    page.classList.toggle('free', FeatureArt.FREE.includes(def.id)); // works with nothing connected: its switches stay blue
    // Until it's turned on, an introduction in place of the settings (shared/feature-art.js).
    const art = FeatureArt.has(def.id) ? FeatureArt.create(def.id, {
      color: def.color,
      keep: !def.master, // without a switch at the top, an introduction once
      onDismiss: () => UI.state && renderPage(views.get(def.id), UI.state),
    }) : null;
    if (art) page.append(art.el);
    const body = el('div', { class: 'page-body' }, limitNote ? [limitNote] : []);
    page.append(body);
    pages.append(page);
    let render = () => {};
    try {
      render = def.build(body, page) || render;
    } catch (e) { // one tab that fails to build doesn't take the rest of the sidebar with it
      console.error('build ' + def.id + ':', e);
    }
    return { page, body, master, render, headText, limitNote, wifiNote, art };
  }

  // The session is through Bluetooth (pages that need Wi-Fi say so).
  const onBle = (s) => !!(s && s.net && s.net.transport === 'ble');

  // Something to work with: the other computer, or a phone.
  const linked = (s) => !!(s && ((s.link && s.link.state === 'connected') || (s.phone && s.phone.connected) || s.activeWebDevice || (s.webDevices && s.webDevices.some((d) => d.active))));

  // Where to go when a page isn't there (hidden, or nothing connected): the device, else Connection.
  const home = (s) => (linked(s) ? 'overview' : 'connection');

  function show(id, user) {
    id = ALIAS[id] || id;
    let v = views.get(id) || views.get(home(UI.state));
    if (UI.state && v.def.hidden && v.def.hidden(UI.state)) v = views.get(home(UI.state)) || v;
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
    for (const t of $('phones').children) t.classList.toggle('active', t.dataset.connected === '1');
    if (user) api.setTab(v.def.id);
    if (UI.state) renderPage(v, UI.state);
  }

  function renderPage(v, s) {
    if (v.wifiNote) {
      const off = onBle(s);
      v.wifiNote.render(s, off);
      v.body.inert = off; // shown as it is; it works again on Wi-Fi
    }
    // macOnly: true = only with a Mac; 'linux' = everything but a Linux peer (Apps).
    const limited = !v.limitNote || !s.peer ? '' : v.def.macOnly === 'linux' ? (s.peer.os === 'linux' ? t('Not on Linux yet') : '') : UI.peer(s).limited;
    if (v.limitNote) v.limitNote.set(limited);
    if (v.master) {
      const d = v.def.master.disabled; // a boolean, or (s) => boolean
      v.master.disable(!!(typeof d === 'function' ? d(s) : d) || !!limited);
      const on = !limited && !!v.def.master.get(s);
      v.master.set(on);
      v.page.classList.toggle('off', !on);
    }
    if (v.art) { // while the page's switch is off; on a page without one, until dismissed
      let off = !v.def.master;
      try {
        if (v.def.master) off = !v.def.master.get(s);
      } catch (e) { /* its state isn't there yet */ }
      v.art.set(!limited && off);
      v.body.hidden = !v.art.el.hidden;
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
    let text = t('Not paired');
    if (l.state === 'connected') text = l.macName + (UI.via(s) !== 'Wi-Fi' ? ' · ' + UI.via(s) : '') + (l.rtt != null ? ' · ' + t('{value} ms', { value: l.rtt }) : '');
    else if (s.pairing) text = t('Pairing…');
    else if (l.state === 'connecting' || l.state === 'reconnecting') text = t('Reconnecting…');
    else if (l.state === 'identity_changed') text = t('Identity changed');
    $('peer-text').textContent = text;
    renderPhones(s);
    renderPcs(s);
    // Tabs that don't apply to the peer (a phone has no terminal or screen to share to it…).
    for (const v of views.values()) {
      const hide = !!(v.def.hidden && v.def.hidden(s));
      if (v.navBtn.parentElement) v.navBtn.parentElement.hidden = hide;
      if (hide && current === v) show(home(s), false);
    }
    // A group with every tab hidden takes its gap with it.
    for (const v of views.values()) if (v.gap) v.gap.hidden = [...views.values()].every((x) => x.gap !== v.gap || !x.navBtn.parentElement || x.navBtn.parentElement.hidden);
    for (const v of views.values()) {
      let b = v.def.badge ? v.def.badge(s) : v.def.phase ? 'P' + v.def.phase : '';
      if (b === 'on' && !linked(s)) b = 'warn'; // on, but nothing connected: it waits (yellow), it isn't working
      v.stateEl.className = 'state' + (b === 'on' ? ' on' : b === 'warn' ? ' warn' : '');
      v.stateEl.textContent = b === 'on' || b === 'warn' ? '' : b || '';
    }
  }

  // Paired phones nearby, above Overview: the phone's wallpaper, its name and the link. Clicking
  // one connects it (the computer steps aside); the connected one opens its page.
  let phonesKey = '';
  let assetsSeen = -1;
  // Paired computers nearby, under the phones (shared/ui-look.js): click to connect.
  function renderPcs(s) {
    const near = new Set((s.found || []).map((d) => d.id));
    const live = s.link && s.link.state === 'connected' && s.peer && s.peer.os !== 'android' ? s.peer.id : '';
    const all = [
      ...(s.paired ? [{ id: s.paired.macId, name: s.paired.macName, os: s.paired.os, go: () => api.connectAgain() }] : []),
      ...(s.guests || []).map((g) => ({ id: g.id, name: g.name, os: g.os, go: () => api.connectGuest(g.id) })),
    ];
    const seen = new Set();
    const list = [];
    for (const x of all) {
      if (seen.has(x.id) || x.os === 'android') continue;
      seen.add(x.id);
      const connected = x.id === live;
      if (!connected && !near.has(x.id)) continue;
      const rtt = s.link && s.link.rtt;
      list.push({ ...x, connected, sub: connected ? (rtt != null ? t('{value} ms', { value: rtt }) : t('Connected')) : t('Nearby · Click to connect') });
    }
    // Web desktop/PC devices
    for (const w of (s.webDevices || [])) {
      if (w.kind === 'phone' || w.os === 'ios' || w.os === 'ipados' || w.os === 'android') continue;
      const active = !!w.active || (s.activeWebDevice && s.activeWebDevice.id === w.id);
      list.push({
        id: w.id,
        name: w.name,
        os: w.os || 'win',
        connected: active,
        sub: active ? t('Connected · Web') : t('Web client'),
        go: () => { api.selectWebDevice(w.id); show('overview', true); },
      });
    }
    UI.renderPcs($('pcs'), list, { open: () => show('overview', true), active: true });
  }

  function renderPhones(s) {
    const ph = s.phone || { nearby: [] };
    const webPhones = (s.webDevices || []).filter((w) => w.kind === 'phone' || w.os === 'ios' || w.os === 'ipados' || w.os === 'android');
    if (ph.assets !== assetsSeen) {
      assetsSeen = ph.assets;
      api.phoneAssets().then((a) => {
        UI.phoneAssets = a;
        UI.phoneWall = a.wallpaper ? 'url("' + a.wallpaper + '")' : '';
        phonesKey = '';
        if (UI.state) render(UI.state);
      }, () => {});
    }
    const info = ph.info || {};
    const colors = info.colors && info.colors.length ? info.colors : null;
    // The connected phone's line (ping, battery) changes often: written in place, the tiles (and
    // their wallpaper) built again only when something else changed, else they flicker.
    const subOf = (d) => (d.connected
      ? (ph.connected.rttMs != null ? t('{value} ms', { value: ph.connected.rttMs }) : t('Connected')) + (info.battery != null ? ' · ' + info.battery + '%' + (info.charging ? ' ⚡' : '') : '')
      : ph.connecting && ph.connecting.id === d.id ? t('Connecting…') : t('Nearby · Click to connect'));
    const key = JSON.stringify([ph.nearby, webPhones, ph.connecting, ph.held, colors, UI.phoneWall ? UI.phoneWall.length : 0, current && current.def.id]);
    if (key === phonesKey) {
      ph.nearby.forEach((d, i) => {
        const sub = $('phones').children[i] && $('phones').children[i].querySelector('.phone-sub');
        if (sub && sub.textContent !== subOf(d)) sub.textContent = subOf(d);
      });
      return;
    }
    phonesKey = key;
    const phoneTiles = ph.nearby.map((d) => {
      const wall = el('span', { class: 'phone-wall' }, [UI.icon('phone')]);
      if (d.connected && UI.phoneWall) wall.style.backgroundImage = UI.phoneWall;
      else if (d.connected && colors) wall.style.backgroundImage = 'linear-gradient(160deg, ' + colors.join(', ') + (colors.length === 1 ? ', ' + colors[0] : '') + ')';
      const sub = subOf(d);
      const b = el('button', { class: 'phone-tile' + (d.connected ? ' connected' : ''), title: d.connected ? d.name : t('Connect to {name}', { name: d.name }) }, [
        wall,
        el('span', { class: 'phone-text' }, [el('span', { class: 'phone-name', text: d.name }), el('span', { class: 'phone-sub', text: sub })]),
        d.connected ? el('span', { class: 'dot good' }) : ph.connecting && ph.connecting.id === d.id ? el('span', { class: 'spin', attrs: { 'aria-hidden': 'true' } }) : null,
      ]);
      b.dataset.connected = d.connected ? '1' : '';
      b.classList.toggle('active', !!d.connected);
      b.onclick = () => (d.connected ? show('overview', true) : api.connectPhone(d.id));
      return b;
    });

    const webTiles = webPhones.map((w) => {
      const active = !!w.active || (s.activeWebDevice && s.activeWebDevice.id === w.id);
      const wall = el('span', { class: 'phone-wall' }, [UI.icon('phone')]);
      wall.style.backgroundImage = 'linear-gradient(160deg, #5ac8fa, #0a84ff)';
      const sub = active ? t('Connected · Web') : t('Web client');
      const b = el('button', { class: 'phone-tile' + (active ? ' connected active' : ''), title: w.name }, [
        wall,
        el('span', { class: 'phone-text' }, [el('span', { class: 'phone-name', text: w.name }), el('span', { class: 'phone-sub', text: sub })]),
        active ? el('span', { class: 'dot good' }) : null,
      ]);
      b.dataset.connected = active ? '1' : '';
      b.classList.toggle('active', active);
      b.onclick = () => { api.selectWebDevice(w.id); show('overview', true); };
      return b;
    });

    $('phones').replaceChildren(...phoneTiles, ...webTiles);
  }

  function renderBanner(s) {
    const inv = !s.pairing && s.inviting;
    $('banner').hidden = !s.pairing && !inv;
    if (inv) { // this PC asked a phone to pair: it goes on there
      $('banner').classList.remove('failed');
      $('pair-title').textContent = t('Press Pair on {name}', { name: inv.name });
      $('pair-code-wrap').hidden = true;
      $('pair-match').hidden = true;
      $('pair-cancel').textContent = t('Cancel');
      $('pair-hint').textContent = t('TwinDesk on {name} asks to pair with this PC. Press Pair there, then compare the codes.', { name: inv.name });
      return;
    }
    const p = s.pairing;
    if (!p) return;
    $('banner').classList.toggle('failed', p.phase === 'failed');
    const host = p.role === 'host'; // another computer asks to pair with this PC
    $('pair-title').textContent = host ? t('{name} wants to pair', { name: p.macName }) : t('Pairing with {name}', { name: p.macName });
    $('pair-code-wrap').hidden = !p.code || !!p.wired; // on the USB cable: nothing to compare
    $('pair-code').textContent = p.code ? p.code.slice(0, 3) + ' ' + p.code.slice(3) : '';
    $('pair-match').hidden = host ? !p.code || p.allowed : p.phase !== 'code';
    $('pair-match').textContent = host ? t('Allow') : t('Codes match');
    $('pair-cancel').textContent = host ? t('Deny') : p.phase === 'failed' ? t('Close') : t('Cancel');
    const hints = {
      connecting: t('Connecting to {address}…', { address: p.address }),
      starting: t('Waiting for {name}…', { name: p.macName }),
      code: t('Check that {name} shows the same code, then click Codes match.', { name: p.macName }),
      waiting: t('Waiting for Allow on {name}…', { name: p.macName }),
      failed: p.error,
      request: p.wired ? (p.allowed ? t('Pairing…') : p.qr ? t('{name} scanned the QR code. Click Allow to pair.', { name: p.macName }) : t('{name} is on the USB cable. Click Allow to pair.', { name: p.macName })) : !p.code ? t('Waiting for the code…') : p.allowed ? t('Waiting for {name}…', { name: p.macName }) : t('Check that {name} shows the same code, then click Allow.', { name: p.macName }),
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
    const heads = { 'mac-pc': t('{device} on {host}', { device: p.Name, host: p.me }), 'pc-mac': t('{device} on {host}', { device: p.me, host: p.name }) }; // as the Mac: "Inuka on Inukas-MBA"
    for (const [id, text] of Object.entries(heads)) {
      const v = views.get(id);
      if (v) v.headText.textContent = text;
    }
    for (const e of document.querySelectorAll('[data-dir="m2p"]')) e.textContent = p.toMe;
    for (const e of document.querySelectorAll('[data-dir="p2m"]')) e.textContent = p.fromMe;
    // Sentences and route heads with the real name ({name}, {the}, {them}).
    for (const e of document.querySelectorAll('[data-peer]')) {
      if (!e.closest('[data-literal]')) e.textContent = t(e.dataset.peer, p);
    }
    for (const e of document.querySelectorAll('[data-os="peer"]')) e.className = 'os-ico ' + UI.osClass(p.os);
    for (const e of document.querySelectorAll('.route')) e.setAttribute('aria-label', [...e.querySelectorAll('.nm')].map((n) => n.textContent).join(t(' to ')));
  }

  let wasLinked = null;
  function render(s) {
    UI.state = s;
    UI.look(s.look); // the accent colour (shared/ui-look.js)
    // Something just connected while Connection is open: its Overview.
    const now = linked(s);
    if (wasLinked === false && now && current && current.def.id === 'connection' && !s.pairing) show('overview', false);
    wasLinked = now;
    document.body.classList.toggle('no-peer', !linked(s)); // switches of what needs a device can't be changed (shared/feature-art.js)
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
  PairPop.attach($('banner'), $('pair-match')); // the popup over the window, Allow there presses this one
  window.addEventListener('macshare-go', (e) => show(e.detail, true));
  api.onGo((tab) => typeof tab === 'string' && views.has(ALIAS[tab] || tab) && show(tab, true));

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
    UI.state = s;
    show((s.ui && s.ui.tab) || home(s), false);
    render(s);
  });
})();

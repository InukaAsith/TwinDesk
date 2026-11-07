// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Boots the control window: sidebar + one page per registered tab, pairing banner, rendering.
'use strict';

(() => {
  const { el, api } = UI;
  const tr = window.I18n.t;
  const $ = (id) => document.getElementById(id);
  const nav = $('nav');
  const pages = $('pages');
  const views = new Map(); // id -> { def, page, navBtn, stateEl, master, render }
  let current = null;

  // The sidebar's order and groups (the same as the PC's and Linux's): the device and Connection,
  // the phone's own things, screens, input, sharing, media; Multi-device, General and About below a
  // line. A tab not named here keeps its own order and group.
  const GROUP = { overview: 0, connection: 0, messages: 1, calls: 1, media: 1, papps: 1, mirror: 2, receive: 2, share: 2, apps: 2, cursor: 3, keyboard: 3, remote: 3, clipboard: 4, notifications: 4, files: 4, pfiles: 4, mount: 4, audio: 5, camera: 5, rezume: 5, terminal: 5 };
  const ORDER = { overview: 0, connection: 1, messages: 5, calls: 6, media: 7, papps: 8, mirror: 10, receive: 11, share: 12, apps: 13, cursor: 20, keyboard: 21, remote: 22, clipboard: 40, notifications: 41, files: 42, pfiles: 43, mount: 44, audio: 60, camera: 61, rezume: 62, terminal: 63, multi: 95, general: 100, about: 110 };
  const ALIAS = { phone: 'overview', display: 'share' }; // older names (saved, the tray, a popup)
  const orderOf = (d) => ORDER[d.id] ?? d.order ?? 50;
  let lastGroup = null;
  let gap = null; // the gap before the current group (hidden with the group: renderSidebar)
  for (const def of UI.tabs.slice().sort((a, b) => orderOf(a) - orderOf(b))) {
    if (def.id in GROUP) def.group = GROUP[def.id];
    if (def.navHidden) { // reached another way (the phone tile)
      views.set(def.id, { def, ...buildPage(def), navBtn: el('button'), stateEl: el('span') });
      continue;
    }
    if (def.bottom && !nav.querySelector('.sep')) nav.append(el('li', { class: 'sep', attrs: { role: 'presentation' } })); // one line above General and About
    // Groups (System Settings style): a small gap before each, no heading, icons in one column.
    if (def.group !== lastGroup && !def.bottom && nav.children.length) nav.append(gap = el('li', { class: 'gap', attrs: { role: 'presentation' } }));
    lastGroup = def.group;
    const stateEl = el('span', { class: 'state' });
    const tile = el('span', { class: 'tile' }, [UI.icon(def.icon || def.id)]);
    tile.style.background = def.color; // CSSOM, allowed by the CSP (inline style attributes aren't)
    const label = el('span', { class: 'label', text: tr(def.title) });
    if (def.title.includes('{')) label.dataset.peer = tr(def.title); // peer-dependent (UI.names)
    const navBtn = el('button', { class: 'nav-item', attrs: { role: 'tab', 'aria-controls': `page-${def.id}` } }, [
      tile,
      label,
      stateEl,
    ]);
    navBtn.onclick = () => show(def.id, true);
    nav.append(el('li', {}, [navBtn]));
    views.set(def.id, { def, ...buildPage(def), navBtn, stateEl, gap });
  }

  function buildPage(def) {
    const page = el('section', { class: 'page', id: `page-${def.id}`, hidden: true, attrs: { role: 'tabpanel' } });
    const h1Text = el('span', { text: tr(def.heading || def.title) });
    const descEl = el('p', { text: tr(def.desc || '') });
    if ((def.heading || def.title).includes('{')) h1Text.dataset.peer = tr(def.heading || def.title);
    if ((def.desc || '').includes('{')) descEl.dataset.peer = tr(def.desc);
    const titles = el('div', { class: 'titles' }, [
      el('h1', {}, [h1Text, def.phase ? el('span', { class: 'pill muted', text: tr('Phase {phase}', { phase: def.phase }) }) : null,
        def.tag ? el('span', { class: 'pill beta', text: tr(def.tag) }) : null]),
      descEl,
    ]);
    let master = null;
    if (def.master) {
      master = UI.switch((v) => def.master.set(v), { label: tr(def.title), disabled: !!def.master.disabled });
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
    const body = el('div', { class: 'page-body' });
    page.append(body);
    pages.append(page);
    let render = () => {};
    try {
      render = def.build(body, page) || render;
    } catch (e) { // one tab that fails to build doesn't take the rest of the sidebar with it
      console.error('build ' + def.id + ':', e);
    }
    return { page, body, master, render, wifiNote, art };
  }

  // The session is through Bluetooth (pages that need Wi-Fi say so).
  const onBle = (s) => !!(s && s.client && s.client.transport === 'ble');

  // Something to work with: the other computer, or a phone.
  const linked = (s) => !!(s && (s.client || (s.phone && s.phone.connected)));

  // Where to go when a page isn't there (hidden, or nothing connected): the device, else Connection.
  const home = (s) => (linked(s) ? 'overview' : 'connection');

  // A web device's pages (shared/ui-web.js) while its tile is picked (UI.webDev); any other page
  // goes back to the sidebar's own.
  function show(id, user) {
    id = ALIAS[id] || id;
    const want = views.get(id);
    if (want && want.def.web && !UI.webDev) id = 'web';
    else if (want && !want.def.web && !UI.WEB_KEEP.includes(want.def.id)) UI.webDev = null; // TwinDesk Web, AirPlay, General, About: both
    let v = views.get(id) || views.get(home(UI.state));
    if (UI.state && v.def.hidden && v.def.hidden(UI.state)) v = views.get(home(UI.state)) || v;
    if (current === v) {
      if (UI.state) { renderSidebar(UI.state); renderPage(v, UI.state); }
      return;
    }
    if (current) {
      current.page.hidden = true;
      current.navBtn.classList.remove('active');
      current.navBtn.setAttribute('aria-selected', 'false');
    }
    current = v;
    if (UI.state) renderSidebar(UI.state); // in or out of a web device's pages
    v.page.hidden = false;
    v.navBtn.classList.add('active');
    v.navBtn.setAttribute('aria-selected', 'true');
    $('content').scrollTop = 0;
    for (const t of $('phones').children) t.classList.toggle('active', t.dataset.connected === '1' && !UI.webDev);
    if (user) api.setTab(v.def.id);
    if (UI.state) renderPage(v, UI.state);
  }

  function renderPage(v, s) {
    if (v.wifiNote) {
      const off = onBle(s);
      v.wifiNote.render(s, off);
      v.body.inert = off; // shown as it is; it works again on Wi-Fi
    }
    if (v.master) {
      const on = !!v.def.master.get(s);
      v.master.set(on);
      v.master.disable(!!v.def.master.disabled);
      v.page.classList.toggle('off', !on);
    }
    if (v.art) { // while the page's switch is off; on a page without one, until dismissed
      let off = !v.def.master;
      try {
        if (v.def.master) off = !v.def.master.get(s);
      } catch (e) { /* its state isn't there yet */ }
      v.art.set(off);
      v.body.hidden = !v.art.el.hidden;
    }
    try {
      v.render(s);
    } catch (e) {
      console.error(`render ${v.def.id}:`, e);
    }
  }

  function renderSidebar(s) {
    const c = s.client;
    $('peer-dot').className = `dot ${c ? 'good' : s.pairing ? 'warn' : ''}`;
    const gs = s.guest && s.guest.status && s.guest.status.state;
    $('peer-text').textContent = c ? `${c.name}${UI.via(s) !== 'Wi-Fi' ? ` · ${UI.via(s)}` : ''}${c.rttMs != null ? ` · ${c.rttMs} ms` : ''}`
      : s.pairing || (s.guest && s.guest.pairing) ? tr('Pairing…') : gs === 'connecting' || gs === 'reconnecting' ? tr('Connecting…') : tr('Not connected');
    if (UI.webDev && !UI.webDevOf(s)) UI.webDev = null; // forgotten meanwhile
    renderPhones(s);
    renderPcs(s);
    UI.webTiles($('webdevs'), s, (devId) => {
      UI.webDev = devId;
      show(devId ? (current && current.def.web ? current.def.id : 'wd-overview') : 'web', true);
    });
    // Tabs that don't apply to the peer (a phone has no terminal or screen to share to it…). A web
    // device picked: its own pages, then TwinDesk Web, AirPlay & SMB, General and About.
    for (const v of views.values()) {
      const hide = UI.webDev ? !v.def.web && !UI.WEB_KEEP.includes(v.def.id)
        : !!v.def.web || !!(v.def.hidden && v.def.hidden(s));
      if (v.navBtn.parentElement) v.navBtn.parentElement.hidden = hide;
      if (hide && current === v) show(home(s), false);
    }
    // A group with every tab hidden takes its gap with it.
    for (const v of views.values()) if (v.gap) v.gap.hidden = [...views.values()].every((x) => x.gap !== v.gap || !x.navBtn.parentElement || x.navBtn.parentElement.hidden);
    const wdFirst = views.get('wd-overview'); // a web device's pages start the list: no gap above them
    if (wdFirst && wdFirst.gap) wdFirst.gap.hidden = wdFirst.gap.hidden || !!UI.webDev;
    for (const v of views.values()) {
      let b = v.def.badge ? v.def.badge(s) : v.def.phase ? `P${v.def.phase}` : '';
      if (b === 'on' && !linked(s) && !FeatureArt.FREE.includes(v.def.id)) b = 'warn'; // on, but nothing connected: it waits (yellow), it isn't working
      v.stateEl.className = `state${b === 'on' ? ' on' : b === 'warn' ? ' warn' : ''}`;
      v.stateEl.textContent = b === 'on' || b === 'warn' ? '' : tr(b || '');
    }
  }

  // Paired phones nearby, above Overview: the phone's wallpaper, its name and the link. Clicking
  // one connects it (the computer steps aside); the connected one opens its page.
  let phonesKey = '';
  let assetsSeen = -1;
  // Paired computers nearby, under the phones (shared/ui-look.js): click to connect.
  function renderPcs(s) {
    const g = s.guest || { hosts: [] };
    const near = new Set((s.found || []).map((d) => d.id));
    const c = s.client && s.client.os !== 'android' ? s.client : null;
    const seen = new Set();
    const list = [];
    for (const x of [...(s.paired || []), ...(g.hosts || [])]) {
      if (!x || seen.has(x.id) || x.os === 'android') continue;
      seen.add(x.id);
      const connected = !!(c && c.id === x.id);
      if (!connected && !near.has(x.id)) continue;
      list.push({ id: x.id, name: x.name, os: x.os, connected, sub: connected ? (c.rttMs != null ? tr('{value} ms', { value: c.rttMs }) : tr('Connected')) : tr('Nearby · Click to connect'), go: () => api.pairWith(x.id) });
    }
    UI.renderPcs($('pcs'), list, { open: () => show('overview', true), active: !UI.webDev });
  }

  function renderPhones(s) {
    const ph = s.phone || { nearby: [] };
    if (ph.assets !== assetsSeen) {
      assetsSeen = ph.assets;
      api.phoneAssets().then((a) => {
        UI.phoneAssets = a;
        UI.phoneWall = a.wallpaper ? `url("${a.wallpaper}")` : '';
        phonesKey = '';
        if (UI.state) render(UI.state);
      }, () => {});
    }
    const info = ph.info || {};
    const colors = info.colors && info.colors.length ? info.colors : null;
    const key = JSON.stringify([UI.webDev, ph.nearby, ph.connecting, ph.connected && ph.connected.rttMs, ph.held, info.battery, info.charging, colors, UI.phoneWall ? UI.phoneWall.length : 0, current && current.def.id]);
    if (key === phonesKey) return;
    phonesKey = key;
    $('phones').replaceChildren(...ph.nearby.map((d) => {
      const wall = el('span', { class: 'phone-wall' }, [UI.icon('phone')]);
      if (d.connected && UI.phoneWall) wall.style.backgroundImage = UI.phoneWall;
      else if (d.connected && colors) wall.style.backgroundImage = `linear-gradient(160deg, ${colors.join(', ')}${colors.length === 1 ? `, ${colors[0]}` : ''})`;
      const connecting = ph.connecting && ph.connecting.id === d.id;
      const sub = d.connected
        ? `${ph.connected.rttMs != null ? `${ph.connected.rttMs} ms` : tr('Connected')}${info.battery != null ? ` · ${info.battery}%${info.charging ? ' ⚡' : ''}` : ''}`
        : connecting ? tr('Connecting…') : tr('Nearby · Click to connect');
      const b = el('button', { class: `phone-tile${d.connected ? ' connected' : ''}`, title: d.connected ? `${d.name}` : tr('Connect to {name}', { name: d.name }) }, [
        wall,
        el('span', { class: 'phone-text' }, [el('span', { class: 'phone-name', text: d.name, attrs: { 'data-literal': '' } }), el('span', { class: 'phone-sub', text: sub, attrs: { 'data-literal': '' } })]),
        d.connected ? el('span', { class: 'dot good' }) : ph.connecting && ph.connecting.id === d.id ? el('span', { class: 'spin', attrs: { 'aria-hidden': 'true' } }) : null,
      ]);
      b.dataset.connected = d.connected ? '1' : '';
      b.classList.toggle('active', !!d.connected && !UI.webDev);
      b.onclick = () => (d.connected ? show('overview', true) : api.connectPhone(d.id));
      return b;
    }));
  }

  // Two kinds of pairing request: someone pairs with this Mac (Allow / Deny), or this Mac pairs
  // with another Mac as its guest (Codes match / Cancel, like the PC app).
  let bannerMode = null;
  function renderBanner(s) {
    const title = (key, name) => {
      const parts = tr(key).split('{name}');
      $('pair-title').replaceChildren(parts[0], el('strong', { text: name, attrs: { 'data-literal': '' } }), parts[1] || '');
    };
    const p = s.pairing;
    const g = s.guest && s.guest.pairing;
    // This Mac asked a phone to pair: it goes on there (Cancel only hides this).
    const inv = !p && !g && s.connect && s.connect.inviting && !(s.client && s.client.id === s.connect.inviting.id) ? s.connect.inviting : null;
    bannerMode = p ? 'host' : g ? 'guest' : inv ? 'guest' : null;
    $('banner').hidden = !bannerMode;
    if (!bannerMode) return;
    if (inv) {
      title('Press Pair on {name}', inv.name);
      $('pair-code').hidden = $('pair-code-label').hidden = true;
      $('pair-allow').hidden = true;
      $('pair-deny').textContent = tr('Cancel');
      $('pair-hint').textContent = tr('TwinDesk on {name} asks to pair with this Mac. Press Pair there, then compare the codes.', { name: inv.name });
      return;
    }
    const code = (p || g).code;
    $('pair-code').textContent = code ? `${code.slice(0, 3)} ${code.slice(3)}` : '…';
    $('pair-code').hidden = $('pair-code-label').hidden = !!(p && p.wired); // on the USB cable: nothing to compare
    if (p) {
      title('{name} wants to pair', p.name);
      $('pair-allow').textContent = tr('Allow');
      $('pair-deny').textContent = tr('Deny');
      $('pair-allow').hidden = false;
      $('pair-allow').disabled = !p.code || p.allowed;
      const other = p.name;
      let hint = tr('Check that {name} shows the same code.', { name: other });
      if (p.wired) hint = p.allowed ? tr('Pairing…') : p.qr ? tr('{name} scanned the QR code. Click Allow to pair.', { name: other }) : tr('{name} is on the USB cable. Click Allow to pair.', { name: other });
      else if (!p.code) hint = tr('Waiting for the code…');
      else if (p.allowed && !p.confirmed) hint = tr('Allowed. Waiting for “Codes match” on {name}…', { name: other });
      else if (p.confirmed && !p.allowed) hint = tr('{name} confirmed the code. Click Allow if it matches.', { name: other });
      $('pair-hint').textContent = hint;
      return;
    }
    title('Pairing with {name}', g.name);
    $('pair-allow').textContent = tr('Codes match');
    $('pair-deny').textContent = g.phase === 'failed' ? tr('OK') : tr('Cancel');
    $('pair-allow').hidden = g.phase === 'failed';
    $('pair-allow').disabled = g.phase !== 'code';
    $('pair-hint').textContent = g.phase === 'failed' ? g.error
      : g.phase === 'code' ? tr('Check that {name} shows the same code.', { name: g.name })
        : g.phase === 'waiting' ? tr('Waiting for Allow on {name}…', { name: g.name }) : tr('Connecting…');
  }

  // Wi-Fi for a session through Bluetooth (netlink.js): what's happening, and for a phone's screen
  // its hotspot's name and password (kept for that phone; the password field empty = the saved one).
  let netShown = '';
  function renderNet(s) {
    const n = s.net;
    const c = s.client;
    const name = (c && c.name) || tr('the other device');
    const show = n && ['asking', 'hosting', 'joining', 'hotspot', 'failed'].includes(n.state) && (n.state !== 'failed' || n.error);
    $('net-banner').hidden = !show;
    if (!show) return void (netShown = '');
    const form = n.state === 'hotspot';
    $('net-form').hidden = !form;
    $('net-join').hidden = !form;
    $('net-cancel').textContent = n.state === 'failed' ? tr('OK') : tr('Cancel');
    if (form && netShown !== 'hotspot') { // fill in once, not while typing
      $('net-ssid').value = n.hotspotSsid || '';
      $('net-pass').value = '';
      $('net-pass').placeholder = n.hotspotSaved ? tr('Password (saved)') : tr('Password');
      setTimeout(() => (n.hotspotSsid ? $('net-pass') : $('net-ssid')).focus(), 0);
    }
    netShown = n.state;
    const TITLES = {
      asking: tr('Moving to Wi-Fi with {name}…', { name }),
      hosting: tr('Starting Wi-Fi for {name}…', { name }),
      joining: tr('Joining {ssid}…', { ssid: n.ssid || 'Wi-Fi' }),
      hotspot: tr('Switch on {name}’s hotspot', { name }),
      failed: tr('Couldn’t move to Wi-Fi'),
    };
    $('net-title').textContent = TITLES[n.state];
    $('net-hint').textContent = n.state === 'hotspot'
      ? tr('{name} isn’t on this Mac’s network. Its screen needs Wi-Fi: switch its hotspot on, then type its name and password here.', { name })
      : n.state === 'failed' ? tr('{error}. Still connected over Bluetooth.', { error: n.error })
        : n.kind === 'direct' ? tr((n.why || []).includes('user') || (n.peerWhy || []).includes('user') ? '{name} isn’t on this network: a direct Wi-Fi link. This Mac is off its own Wi-Fi meanwhile.' : (n.why || []).includes('files') || (n.peerWhy || []).includes('files') ? '{name} isn’t on this network: a direct Wi-Fi link for the files. This Mac is off its own Wi-Fi meanwhile.' : '{name} isn’t on this network: a direct Wi-Fi link for the screen. This Mac is off its own Wi-Fi meanwhile.', { name }) : '';
  }
  $('net-join').onclick = () => api.netJoinHotspot({ ssid: $('net-ssid').value, pass: $('net-pass').value });
  $('net-pass').onkeydown = $('net-ssid').onkeydown = (e) => { if (e.key === 'Enter') $('net-join').click(); };
  $('net-cancel').onclick = () => api.netCancel();

  let wasLinked = null;
  function render(s) {
    UI.state = s;
    UI.look(s.look); // the accent colour (shared/ui-look.js)
    // Something just connected while Connection is open: its Overview.
    const now = linked(s);
    if (wasLinked === false && now && current && current.def.id === 'connection' && !s.pairing) show('overview', false);
    wasLinked = now;
    document.body.classList.toggle('no-peer', !linked(s)); // switches of what needs a device can't be changed (shared/feature-art.js)
    UI.names(s);
    if (UI.setup.render(s)) {
      renderBanner(s);
      return;
    }
    renderSidebar(s);
    renderBanner(s);
    renderNet(s);
    if (current) renderPage(current, s);
  }

  $('pair-allow').onclick = () => (bannerMode === 'guest' ? api.confirmGuestCode() : api.pairRespond(true));
  $('pair-deny').onclick = () => (bannerMode === 'guest' ? api.cancelGuestPair() : api.pairRespond(false));
  PairPop.attach($('banner'), $('pair-allow')); // the popup over the window, Allow there presses this one
  window.addEventListener('macshare-go', (e) => show(e.detail, true));
  if (api.onGo) api.onGo((tab) => typeof tab === 'string' && views.has(ALIAS[tab] || tab) && show(tab, true));

  // ↑/↓ move between tabs while the sidebar has focus.
  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const ids = [...views.keys()];
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
    show((s.ui && s.ui.tab) || home(s), false); // 'display' (before the split) goes to Share screen: ALIAS
    render(s);
  });
})();

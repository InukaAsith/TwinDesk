// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Boots the control window: sidebar + one page per registered tab, pairing banner, rendering.
'use strict';

(() => {
  const { el, api } = UI;
  const M = window.SidebarModel; // shared/sidebar-model.js: device tiles and the sections per kind
  const $ = (id) => document.getElementById(id);
  const nav = $('nav');
  const pages = $('pages');
  const views = new Map(); // id -> { def, page, navBtn, stateEl, master, render }
  let current = null;

  let lastGroup = null;
  let gap = null; // the gap before the current group (hidden with the group: renderSidebar)
  for (const def of UI.tabs.slice().sort((a, b) => (a.order ?? 50) - (b.order ?? 50))) {
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
    const label = el('span', { class: 'label', text: def.title });
    if (def.title.includes('{')) label.dataset.peer = def.title; // peer-dependent (UI.names)
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
    const h1Text = el('span', { text: def.heading || def.title });
    const descEl = el('p', { text: def.desc || '' });
    const devTag = el('span', { class: 'pill muted dev-tag', hidden: true }); // names the selected device on its own sections
    if ((def.heading || def.title).includes('{')) h1Text.dataset.peer = def.heading || def.title;
    if ((def.desc || '').includes('{')) descEl.dataset.peer = def.desc;
    const titles = el('div', { class: 'titles' }, [
      el('h1', {}, [h1Text, def.phase ? el('span', { class: 'pill muted', text: `Phase ${def.phase}` }) : null, devTag]),
      descEl,
    ]);
    let master = null;
    if (def.master) {
      master = UI.switch((v) => def.master.set(v), { label: def.title, disabled: !!def.master.disabled });
    }
    page.append(el('header', { class: 'page-head' }, [titles, master ? master.el : null]));
    // Over Bluetooth, a page that needs Wi-Fi (and doesn't move the session onto it) says so, with
    // the button that moves it there.
    const wifiNote = def.wifiOnly ? UI.wifiGate() : null;
    if (wifiNote) page.append(wifiNote.el);
    const body = el('div', { class: 'page-body' });
    page.append(body);
    pages.append(page);
    const render = def.build(body, page) || (() => {});
    return { page, body, master, render, wifiNote, devTag };
  }

  // The session is through Bluetooth (pages that need Wi-Fi say so).
  const onBle = (s) => !!(s && s.client && s.client.transport === 'ble');

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
    markTiles();
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
    if (v.devTag) { // the selected device's name on the sections that show its settings and data
      const n = M.isScoped(v.def.id) && s.client ? s.client.name : '';
      v.devTag.hidden = !n;
      v.devTag.textContent = n || '';
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
      : s.pairing || (s.guest && s.guest.pairing) ? 'Pairing…' : gs === 'connecting' || gs === 'reconnecting' ? 'Connecting…' : 'Not connected';
    renderPhones(s);
    // Tabs that don't apply to the peer (a phone has no terminal or screen to share to it…).
    for (const v of views.values()) {
      const hide = !!(v.def.hidden && v.def.hidden(s));
      if (v.navBtn.parentElement) v.navBtn.parentElement.hidden = hide;
      if (hide && current === v) show(M.firstSection(kindOfState(s), availableFor(kindOfState(s))), false);
    }
    // A group with every tab hidden takes its gap with it.
    for (const v of views.values()) if (v.gap) v.gap.hidden = [...views.values()].every((x) => x.gap !== v.gap || !x.navBtn.parentElement || x.navBtn.parentElement.hidden);
    for (const v of views.values()) {
      const b = v.def.badge ? v.def.badge(s) : v.def.phase ? `P${v.def.phase}` : '';
      v.stateEl.className = `state${b === 'on' ? ' on' : b === 'warn' ? ' warn' : ''}`;
      v.stateEl.textContent = b === 'on' || b === 'warn' ? '' : b || '';
    }
  }

  // The kind of the selected device: its sections follow it (shared/sidebar-model.js).
  const kindOfState = (s) => (UI.isPhone(s) ? 'phone' : M.selectedKind(s.peers) === 'none' ? 'none' : 'computer');
  // Sections that exist for a kind of device.
  const availableFor = (kind) => [...views.keys()].filter((id) => M.sectionVisible(id, kind));

  // Tiles of the selected device's sections: lit while one of its own sections is open.
  function markTiles() {
    const scoped = !!(current && M.isScoped(current.def.id));
    for (const t of $('phones').children) t.classList.toggle('active', scoped && t.dataset.selected === '1');
  }

  // A tile was clicked: a connected device becomes the selected one (hub.select) and its sections
  // open (the open one when it exists for it, else its first); a phone nearby connects.
  let goAfter = null; // { id, kind, timer }: open the sections once the new selection reached this window
  function pick(t) {
    if (t.action === 'connect') return api.connectPhone(t.id);
    if (t.action !== 'select') return;
    const go = () => {
      if (goAfter) clearTimeout(goAfter.timer);
      goAfter = null;
      show(M.targetSection(current && current.def.id, t.kind, availableFor(t.kind)), true);
    };
    if (t.selected) return go();
    if (goAfter) clearTimeout(goAfter.timer);
    goAfter = { id: t.id, go, timer: setTimeout(go, 1500) }; // the state push with the new selection runs it (render)
    Promise.resolve(api.selectPeer(t.id)).catch(() => go());
  }

  // Every known device above the sections: paired phones (wallpaper, name, link) and computers (OS icon,
  // name, ping/transport), devices only another one reaches with a "via" line (not clickable).
  let phonesKey = '';
  let assetsSeen = -1;
  function renderPhones(s) {
    const ph = s.phone || { nearby: [] };
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
    const subOf = (d) => {
      const mine = (ph.phones || []).find((x) => x.id === d.id) || null; // this phone's own numbers, not the active one's
      if (!d.connected) return ph.connecting && ph.connecting.id === d.id ? 'Connecting…' : 'Nearby · Click to connect';
      const rtt = mine ? mine.rttMs : ph.connected && ph.connected.rttMs;
      const bat = mine ? mine.battery : info.battery;
      const chg = mine ? mine.charging : info.charging;
      return (rtt != null ? rtt + ' ms' : 'Connected') + (bat != null ? ' · ' + bat + '%' + (chg ? ' ⚡' : '') : '');
    };
    const phones = ph.nearby.map((d) => ({ id: d.id, name: d.name, connected: !!d.connected, connecting: !!(ph.connecting && ph.connecting.id === d.id), sub: subOf(d) }));
    const tiles = M.buildTiles({ peers: s.peers || [], phones, transport: UI.via(s) });
    const key = JSON.stringify([tiles.map((t) => [t.id, t.kind, t.name, t.os, t.state, t.selected, t.action, t.via]), ph.held, ph.activeId, (ph.phones || []).map((x) => [x.id, x.colors]), colors, UI.phoneWall ? UI.phoneWall.length : 0, current && current.def.id]);
    if (key === phonesKey) {
      const subs = new Map(tiles.map((t) => [t.id, t.sub]));
      for (const b of $('phones').children) {
        const sub = b.querySelector('.phone-sub');
        if (sub && subs.has(b.dataset.id) && sub.textContent !== subs.get(b.dataset.id)) sub.textContent = subs.get(b.dataset.id);
      }
      return;
    }
    phonesKey = key;
    $('phones').replaceChildren(...tiles.map((t) => {
      let wall;
      if (t.kind === 'phone') {
        const mine = (ph.phones || []).find((x) => x.id === t.id) || null;
        const dcolors = mine && mine.colors ? mine.colors : colors;
        wall = el('span', { class: 'phone-wall' }, [UI.icon('phone')]);
        if (t.connected && UI.phoneWall && (!ph.activeId || ph.activeId === t.id)) wall.style.backgroundImage = UI.phoneWall;
        else if (t.connected && dcolors) wall.style.backgroundImage = 'linear-gradient(160deg, ' + dcolors.join(', ') + (dcolors.length === 1 ? ', ' + dcolors[0] : '') + ')';
      } else {
        wall = el('span', { class: 'phone-wall computer-wall' }, [UI.osIcon(t.os)]);
      }
      const b = el('button', {
        class: 'phone-tile' + (t.kind === 'computer' ? ' computer' : '') + (t.connected ? ' connected' : '') + (t.selected ? ' selected' : '') + (t.state === 'via' ? ' via' : ''),
        title: t.state === 'via' ? t.name + ' is reached through ' + t.via.join(', ') : t.action === 'connect' ? 'Connect to ' + t.name : t.name,
      }, [
        wall,
        el('span', { class: 'phone-text' }, [el('span', { class: 'phone-name', text: t.name }), el('span', { class: 'phone-sub', text: t.sub })]),
        t.connected ? el('span', { class: 'dot good' }) : t.state === 'via' ? el('span', { class: 'pill muted', text: 'via ' + (t.via[0] || '…') }) : null,
      ]);
      b.dataset.id = t.id;
      b.dataset.connected = t.connected ? '1' : '';
      b.dataset.selected = t.selected ? '1' : '';
      if (t.action === 'none') b.setAttribute('aria-disabled', 'true');
      b.onclick = () => pick(t);
      return b;
    }));
    markTiles();
  }

  // Two kinds of pairing request: someone pairs with this Mac (Allow / Deny), or this Mac pairs
  // with another Mac as its guest (Codes match / Cancel, like the PC app).
  let bannerMode = null;
  function renderBanner(s) {
    const p = s.pairing;
    const g = s.guest && s.guest.pairing;
    // This Mac asked a phone to pair: it goes on there (Cancel only hides this).
    const inv = !p && !g && s.connect && s.connect.inviting && !(s.client && s.client.id === s.connect.inviting.id) ? s.connect.inviting : null;
    bannerMode = p ? 'host' : g ? 'guest' : inv ? 'guest' : null;
    $('banner').hidden = !bannerMode;
    if (!bannerMode) return;
    if (inv) {
      $('pair-title').replaceChildren('Press Pair on ', el('strong', { text: inv.name }));
      $('pair-code').hidden = $('pair-code-label').hidden = true;
      $('pair-allow').hidden = true;
      $('pair-deny').textContent = 'Cancel';
      $('pair-hint').textContent = `TwinDesk on ${inv.name} asks to pair with this Mac. Press Pair there, then compare the codes.`;
      return;
    }
    const code = (p || g).code;
    $('pair-code').textContent = code ? `${code.slice(0, 3)} ${code.slice(3)}` : '…';
    $('pair-code').hidden = $('pair-code-label').hidden = !!(p && p.wired); // on the USB cable: nothing to compare
    if (p) {
      $('pair-title').replaceChildren(el('strong', { text: p.name }), ' wants to pair');
      $('pair-allow').textContent = 'Allow';
      $('pair-deny').textContent = 'Deny';
      $('pair-allow').hidden = false;
      $('pair-allow').disabled = !p.code || p.allowed;
      const other = p.name;
      let hint = `Check that ${other} shows the same code.`;
      if (p.wired) hint = p.allowed ? 'Pairing…' : `${other} is on the USB cable. Click Allow to pair.`;
      else if (!p.code) hint = 'Waiting for the code…';
      else if (p.allowed && !p.confirmed) hint = `Allowed. Waiting for “Codes match” on ${other}…`;
      else if (p.confirmed && !p.allowed) hint = `${other[0].toUpperCase()}${other.slice(1)} confirmed the code. Click Allow if it matches.`;
      $('pair-hint').textContent = hint;
      return;
    }
    $('pair-title').replaceChildren('Pairing with ', el('strong', { text: g.name }));
    $('pair-allow').textContent = 'Codes match';
    $('pair-deny').textContent = g.phase === 'failed' ? 'OK' : 'Cancel';
    $('pair-allow').hidden = g.phase === 'failed';
    $('pair-allow').disabled = g.phase !== 'code';
    $('pair-hint').textContent = g.phase === 'failed' ? g.error
      : g.phase === 'code' ? `Check that ${g.name} shows the same code.`
        : g.phase === 'waiting' ? `Waiting for Allow on ${g.name}…` : 'Connecting…';
  }

  // Wi-Fi for a session through Bluetooth (netlink.js): what's happening, and for a phone's screen
  // its hotspot's name and password (kept for that phone; the password field empty = the saved one).
  let netShown = '';
  function renderNet(s) {
    const n = s.net;
    const c = s.client;
    const name = (c && c.name) || 'the other device';
    const show = n && ['asking', 'hosting', 'joining', 'hotspot', 'failed'].includes(n.state) && (n.state !== 'failed' || n.error);
    $('net-banner').hidden = !show;
    if (!show) return void (netShown = '');
    const form = n.state === 'hotspot';
    $('net-form').hidden = !form;
    $('net-join').hidden = !form;
    $('net-cancel').textContent = n.state === 'failed' ? 'OK' : 'Cancel';
    if (form && netShown !== 'hotspot') { // fill in once, not while typing
      $('net-ssid').value = n.hotspotSsid || '';
      $('net-pass').value = '';
      $('net-pass').placeholder = n.hotspotSaved ? 'Password (saved)' : 'Password';
      setTimeout(() => (n.hotspotSsid ? $('net-pass') : $('net-ssid')).focus(), 0);
    }
    netShown = n.state;
    const TITLES = {
      asking: `Moving to Wi-Fi with ${name}…`,
      hosting: `Starting Wi-Fi for ${name}…`,
      joining: `Joining ${n.ssid || 'Wi-Fi'}…`,
      hotspot: `Switch on ${name}’s hotspot`,
      failed: 'Couldn’t move to Wi-Fi',
    };
    $('net-title').textContent = TITLES[n.state];
    $('net-hint').textContent = n.state === 'hotspot'
      ? `${name} isn’t on this Mac’s network. Its screen needs Wi-Fi: switch its hotspot on, then type its name and password here.`
      : n.state === 'failed' ? `${n.error}. Still connected over Bluetooth.`
        : n.kind === 'direct' ? `${name} isn’t on this network: a direct Wi-Fi link${n.why.includes('user') || n.peerWhy.includes('user') ? '' : ` for ${n.why.includes('files') || n.peerWhy.includes('files') ? 'the files' : 'the screen'}`}. This Mac is off its own Wi-Fi meanwhile.` : '';
  }
  $('net-join').onclick = () => api.netJoinHotspot({ ssid: $('net-ssid').value, pass: $('net-pass').value });
  $('net-pass').onkeydown = $('net-ssid').onkeydown = (e) => { if (e.key === 'Enter') $('net-join').click(); };
  $('net-cancel').onclick = () => api.netCancel();

  // The selected device changed: the sections show the new device (no data of the previous one stays), and
  // the section a clicked tile asked for opens.
  let selKey = null;
  function selectionChanged(s) {
    const sel = M.selectedOf(s.peers);
    const k = sel ? sel.id : '';
    if (selKey === null) { selKey = k; return; }
    if (k !== selKey) {
      selKey = k;
      window.dispatchEvent(new CustomEvent('twindesk-device', { detail: k }));
    }
    if (goAfter && k === goAfter.id) goAfter.go();
  }

  function render(s) {
    UI.state = s;
    selectionChanged(s);
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
  if (api.onGo) api.onGo((tab) => typeof tab === 'string' && views.has(tab) && show(tab, true));

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
    const saved = s.ui && s.ui.tab;
    show(saved === 'display' ? 'share' : saved || 'overview', false); // 'display' = before the split
    render(s);
  });
})();

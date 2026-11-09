// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Boots the control window: sidebar + one page per registered tab, pairing banner, rendering.
'use strict';

(() => {
  const { el, api } = UI;
  const tr = window.I18n.t;
  const M = window.SidebarModel; // shared/sidebar-model.js: device tiles and the sections per kind
  const $ = (id) => document.getElementById(id);
  const nav = $('nav');
  const pages = $('pages');
  const views = new Map(); // id -> { def, page, navBtn, stateEl, master, render }
  let current = null;

  // The sidebar's order and groups (as ../ui-start.js): the device and Connection, the phone's own
  // things, screens, input, sharing, media; General below a line.
  const GROUP = { overview: 0, connection: 0, messages: 1, calls: 1, media: 1, papps: 1, mirror: 2, receive: 2, share: 2, apps: 2, cursor: 3, keyboard: 3, remote: 3, clipboard: 4, notifications: 4, files: 4, pfiles: 4, mount: 4, audio: 5, camera: 5, rezume: 5, terminal: 5 };
  const ORDER = { overview: 0, connection: 1, messages: 5, calls: 6, media: 7, papps: 8, mirror: 10, receive: 11, share: 12, apps: 13, cursor: 20, keyboard: 21, remote: 22, clipboard: 40, notifications: 41, files: 42, pfiles: 43, mount: 44, audio: 60, camera: 61, rezume: 62, terminal: 63, multi: 95, general: 100, about: 110 };
  const orderOf = (d) => ORDER[UI.baseOf(d)] ?? d.order ?? 50; // a kind's own version of a page (variantOf): the page's place
  let lastGroup = null;
  let gap = null; // the gap before the current group (hidden with the group: renderSidebar)
  for (const def of UI.tabs.slice().sort((a, b) => orderOf(a) - orderOf(b))) {
    if (UI.baseOf(def) in GROUP) def.group = GROUP[UI.baseOf(def)];
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
    const devTag = el('span', { class: 'pill muted dev-tag', hidden: true, attrs: { 'data-literal': '' } }); // names the selected device on its own sections
    if ((def.heading || def.title).includes('{')) h1Text.dataset.peer = tr(def.heading || def.title);
    if ((def.desc || '').includes('{')) descEl.dataset.peer = tr(def.desc);
    const titles = el('div', { class: 'titles' }, [
      el('h1', {}, [h1Text, def.phase ? el('span', { class: 'pill muted', text: tr('Phase {phase}', { phase: def.phase }) }) : null,
        def.tag ? el('span', { class: 'pill beta', text: tr(def.tag) }) : null, devTag]),
      descEl,
    ]);
    let master = null;
    if (def.master) {
      master = UI.switch((v) => def.master.set(v), { label: tr(def.title), disabled: def.master.disabled === true }); // a function is looked at with the state (below)
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
    return { page, body, master, render, wifiNote, devTag, art };
  }

  // The session is through Bluetooth (pages that need Wi-Fi say so).
  const onBle = (s) => !!(s && s.client && s.client.transport === 'ble');

  // Something to work with: the other computer, or a phone.
  const linked = (s) => !!(s && (s.client || (s.phone && s.phone.connected)));

  // A web device's pages (shared/ui-web.js) while its tile is picked (UI.webDev); any other page
  // goes back to the sidebar's own.
  function show(id, user) {
    const want = views.get(id);
    if (want && want.def.web && !UI.webDev) id = 'web';
    else if (want && !want.def.web && !UI.WEB_KEEP.includes(want.def.id)) UI.webDev = null;
    const v = views.get(UI.pick(id === 'phone' ? 'overview' : id)) || views.get('connection'); // 'phone': the old Phone page; UI.pick: the version for the device in session (shared/ui-kinds.js)
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
      const d = v.def.master.disabled; // a boolean, or (s) => boolean: a function itself isn't "disabled"
      v.master.disable(!!(typeof d === 'function' ? d(s) : d));
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
      : s.pairing || (s.guest && s.guest.pairing) ? tr('Pairing…') : gs === 'connecting' || gs === 'reconnecting' ? tr('Connecting…') : tr('Not connected');
    if (UI.webDev && !UI.webDevOf(s)) UI.webDev = null; // forgotten meanwhile
    renderPhones(s);
    UI.webTiles($('webdevs'), s, (devId) => {
      UI.webDev = devId;
      show(devId ? (current && current.def.web ? current.def.id : 'wd-overview') : 'web', true);
    });
    // Tabs that don't apply to the peer (a phone has no terminal or screen to share to it…). A web
    // device picked: its own pages, then Connection, TwinDesk Web, AirPlay & SMB, General and About.
    for (const v of views.values()) {
      const hide = UI.webDev ? !v.def.web && !UI.WEB_KEEP.includes(v.def.id)
        : !!v.def.web || !!(v.def.hidden && v.def.hidden(s));
      if (v.navBtn.parentElement) v.navBtn.parentElement.hidden = hide;
      // Hidden for the device now in session: its version of this page (shared/ui-kinds.js), else the start.
      if (hide && current === v) { const twin = UI.webDev ? v.def.id : UI.pick(v.def.id, s); show(twin !== v.def.id ? twin : M.firstSection(kindOfState(s), availableFor(kindOfState(s))), false); }
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

  // The kind of the selected device: its sections follow it (shared/sidebar-model.js).
  const kindOfState = (s) => (UI.isPhone(s) ? 'phone' : M.selectedKind(s.peers) === 'none' ? 'none' : 'computer');
  // Sections that exist for a kind of device.
  const availableFor = (kind) => [...views.keys()].filter((id) => M.sectionVisible(id, kind));

  // Tiles of the selected device's sections: lit while one of its own sections is open.
  function markTiles() {
    const scoped = !!(current && M.isScoped(current.def.id));
    for (const t of $('phones').children) t.classList.toggle('active', scoped && !UI.webDev && t.dataset.selected === '1');
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
      if (!d.connected) return ph.connecting && ph.connecting.id === d.id ? tr('Connecting…') : tr('Nearby · Click to connect');
      const rtt = mine ? mine.rttMs : ph.connected && ph.connected.rttMs;
      const bat = mine ? mine.battery : info.battery;
      const chg = mine ? mine.charging : info.charging;
      return (rtt != null ? rtt + ' ms' : tr('Connected')) + (bat != null ? ' · ' + bat + '%' + (chg ? ' ⚡' : '') : '');
    };
    const phones = ph.nearby.map((d) => ({ id: d.id, name: d.name, os: d.os, connected: !!d.connected, connecting: !!(ph.connecting && ph.connecting.id === d.id), sub: subOf(d) }));
    const tiles = M.buildTiles({ peers: s.peers || [], phones, transport: UI.via(s) }).map((tile) => {
      if (phones.some((d) => d.id === tile.id)) return tile; // the phone's own ping and battery line is already localized
      const peer = (s.peers || []).find((d) => d.id === tile.id) || {};
      const sub = tile.state === 'via' ? tr('via {name}', { name: tile.via.join(', ') || tr('another device') })
        : tile.connected ? (peer.rtt != null ? peer.rtt + ' ms' : tr('Connected')) + (tile.selected && UI.via(s) !== 'Wi-Fi' ? ' · ' + UI.via(s) : '')
          : tile.state === 'connecting' ? tr('Connecting…') : peer.state === 'waiting' ? tr('Waiting for it to connect')
            : peer.state === 'identity_changed' ? tr('Identity changed') : tr('Not connected');
      return { ...tile, sub };
    });
    const key = JSON.stringify([tiles.map((t) => [t.id, t.kind, t.name, t.os, t.state, t.selected, t.action, t.via, t.forget]), ph.held, ph.activeId, (ph.phones || []).map((x) => [x.id, x.colors]), colors, UI.phoneWall ? UI.phoneWall.length : 0, current && current.def.id]);
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
        title: t.state === 'via' ? tr('{name} is reached through {via}', { name: t.name, via: t.via.join(', ') }) : t.action === 'connect' ? tr('Connect to {name}', { name: t.name }) : t.name,
      }, [
        wall,
        el('span', { class: 'phone-text' }, [el('span', { class: 'phone-name', text: t.name, attrs: { 'data-literal': '' } }), el('span', { class: 'phone-sub', text: t.sub, attrs: { 'data-literal': '' } })]),
        t.connected ? el('span', { class: 'dot good' }) : t.state === 'connecting' ? el('span', { class: 'spin', attrs: { 'aria-hidden': 'true' } }) : t.state === 'via' ? el('span', { class: 'pill muted', text: tr('via {name}', { name: t.via[0] || '…' }) }) : null,
      ]);
      b.dataset.id = t.id;
      b.dataset.connected = t.connected ? '1' : '';
      b.dataset.selected = t.selected ? '1' : '';
      if (t.action === 'none') b.setAttribute('aria-disabled', 'true');
      b.onclick = () => pick(t);
      if (t.forget && t.forget.length) { // paired but offline: forget it (right-click, or the x on hover); a stale twin goes too
        const forget = () => { for (const id of t.forget) Promise.resolve(api.forgetPeer(id)).catch(() => {}); };
        b.appendChild(el('span', { class: 'tile-x', role: 'button', title: tr('Forget {name}', { name: t.name }), text: '×', onclick: (e) => { e.stopPropagation(); forget(); } }));
        b.oncontextmenu = (e) => { e.preventDefault(); forget(); };
      }
      return b;
    }));
    markTiles();
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
      if (p.wired) hint = p.allowed ? tr('Pairing…') : tr('{name} is on the USB cable. Click Allow to pair.', { name: other });
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
    UI.look(s.look); // the accent colour (shared/ui-look.js)
    document.body.classList.toggle('no-peer', !linked(s)); // switches of what needs a device can't be changed (shared/feature-art.js)
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
    show(saved === 'display' ? 'share' : saved || 'connection', false); // 'display' = before the split
    render(s);
  });
})();

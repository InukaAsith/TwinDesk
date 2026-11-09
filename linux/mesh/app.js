// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Main window shell: sidebar + one page per registered tab (ui-*.js), pairing banner, accent
// rendering of the state pushed by main. Same structure and look as the Mac's.
'use strict';

(() => {
  const { el, api } = UI;
  const t = window.I18n.t;
  const M = window.SidebarModel; // shared/sidebar-model.js: device tiles and the sections per kind
  const $ = (id) => document.getElementById(id);
  const nav = $('nav');
  const pages = $('pages');
  const views = new Map(); // id -> { def, page, navBtn, stateEl, master, render }
  let current = null;

  // Sidebar groups: no headings, one icon column, a small gap between groups: the device and
  // Connection, the phone's own things, screens, input, sharing, media; General below a line.
  // ORDER places each tab (the tab files' own order is the fallback), as in ../app.js.
  const GROUP = { overview: 0, connection: 0, messages: 1, calls: 1, media: 1, papps: 1, mirror: 2, 'mac-pc': 2, 'pc-mac': 2, apps: 2, cursor: 3, keyboard: 3, remote: 3, clipboard: 4, notifications: 4, files: 4, pfiles: 4, mount: 4, audio: 5, camera: 5, rezume: 5, terminal: 5 };
  const ORDER = { overview: 0, connection: 1, messages: 5, calls: 6, media: 7, papps: 8, mirror: 10, 'mac-pc': 11, 'pc-mac': 12, apps: 13, cursor: 20, keyboard: 21, remote: 22, clipboard: 40, notifications: 41, files: 42, pfiles: 43, mount: 44, audio: 60, camera: 61, rezume: 62, terminal: 63, multi: 95, general: 100, about: 110 };
  const orderOf = (d) => ORDER[UI.baseOf(d)] ?? d.order ?? 50; // a kind's own version of a page (variantOf): the page's place
  let lastGroup;
  let gap = null; // the gap before the current group (hidden with the group: renderSidebar)
  for (const def of UI.tabs.slice().sort((a, b) => orderOf(a) - orderOf(b))) {
    if (def.navHidden) { // reached another way (the phone tile)
      views.set(def.id, { def, ...buildPage(def), navBtn: el('button'), stateEl: el('span') });
      continue;
    }
    const group = GROUP[UI.baseOf(def)];
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
    const devTag = el('span', { class: 'pill muted dev-tag', hidden: true }); // names the selected device on its own sections
    const titles = el('div', { class: 'titles' }, [
      el('h1', {}, [headText, def.phase ? el('span', { class: 'pill muted', text: t('Phase {phase}', { phase: def.phase }) }) : null,
        def.tag ? el('span', { class: 'pill beta', text: t(def.tag) }) : null, devTag]),
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
    return { page, body, master, render, headText, limitNote, wifiNote, devTag, art };
  }

  // The session is through Bluetooth (pages that need Wi-Fi say so).
  const onBle = (s) => !!(s && s.net && s.net.transport === 'ble');

  // Something to work with: the other computer, or a phone.
  const linked = (s) => !!(s && ((s.link && s.link.state === 'connected') || (s.phone && s.phone.connected)));

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
    if (v.devTag) { // the selected device's name on the sections that show its settings and data
      const n = M.isScoped(v.def.id) && s.session ? s.session.name : '';
      v.devTag.hidden = !n;
      v.devTag.textContent = n || '';
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
    for (const v of views.values()) {
      let b = v.def.badge ? v.def.badge(s) : v.def.phase ? 'P' + v.def.phase : '';
      if (b === 'on' && !linked(s) && !FeatureArt.FREE.includes(v.def.id)) b = 'warn'; // on, but nothing connected: it waits (yellow), it isn't working
      v.stateEl.className = 'state' + (b === 'on' ? ' on' : b === 'warn' ? ' warn' : '');
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
    Promise.resolve(api.setActivePeer(t.id)).catch(() => go());
  }

  // Every known device above the sections: paired phones (wallpaper, name, link) and computers (OS icon,
  // name, ping/transport), devices only another one reaches with a "via" line (not clickable).
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
    // The connected phone's line (ping, battery) changes often: written in place, the tiles (and
    // their wallpaper) built again only when something else changed, else they flicker.
    const subOf = (d) => {
      const mine = (ph.phones || []).find((x) => x.id === d.id) || null; // this phone's own numbers, not the active one's
      if (!d.connected) return ph.connecting && ph.connecting.id === d.id ? t('Connecting…') : t('Nearby · Click to connect');
      const rtt = mine ? mine.rttMs : ph.connected && ph.connected.rttMs;
      const bat = mine ? mine.battery : info.battery;
      const chg = mine ? mine.charging : info.charging;
      return (rtt != null ? t('{value} ms', { value: rtt }) : t('Connected')) + (bat != null ? ' · ' + bat + '%' + (chg ? ' ⚡' : '') : '');
    };
    const phones = ph.nearby.map((d) => ({ id: d.id, name: d.name, os: d.os, connected: !!d.connected, connecting: !!(ph.connecting && ph.connecting.id === d.id), sub: subOf(d) }));
    const tiles = M.buildTiles({ peers: s.peers || [], phones, transport: UI.via(s) });
    for (const tile of tiles) {
      if (tile.kind === 'phone') continue;
      const peer = (s.peers || []).find((x) => x.id === tile.id) || {};
      tile.sub = tile.state === 'via' ? t('via {via}', { via: tile.via.join(', ') || t('another device') })
        : tile.connected ? (peer.rtt != null ? t('{value} ms', { value: peer.rtt }) : t('Connected')) + (tile.selected && UI.via(s) && UI.via(s) !== 'Wi-Fi' ? ' · ' + UI.via(s) : '')
        : tile.state === 'connecting' ? t('Connecting…')
        : peer.state === 'waiting' ? t('Waiting for it to connect')
        : peer.state === 'identity_changed' ? t('Identity changed') : t('Not connected');
    }
    const key = JSON.stringify([tiles.map((tile) => [tile.id, tile.kind, tile.name, tile.os, tile.state, tile.selected, tile.action, tile.via, tile.forget]), ph.held, ph.activeId, (ph.phones || []).map((x) => [x.id, x.colors]), colors, UI.phoneWall ? UI.phoneWall.length : 0, current && current.def.id]);
    if (key === phonesKey) {
      const subs = new Map(tiles.map((tile) => [tile.id, tile.sub]));
      for (const b of $('phones').children) {
        const sub = b.querySelector('.phone-sub');
        if (sub && subs.has(b.dataset.id) && sub.textContent !== subs.get(b.dataset.id)) sub.textContent = subs.get(b.dataset.id);
      }
      return;
    }
    phonesKey = key;
    $('phones').replaceChildren(...tiles.map((tile) => {
      let wall;
      if (tile.kind === 'phone') {
        const mine = (ph.phones || []).find((x) => x.id === tile.id) || null;
        const dcolors = mine && mine.colors ? mine.colors : colors;
        wall = el('span', { class: 'phone-wall' }, [UI.icon('phone')]);
        if (tile.connected && UI.phoneWall && (!ph.activeId || ph.activeId === tile.id)) wall.style.backgroundImage = UI.phoneWall;
        else if (tile.connected && dcolors) wall.style.backgroundImage = 'linear-gradient(160deg, ' + dcolors.join(', ') + (dcolors.length === 1 ? ', ' + dcolors[0] : '') + ')';
      } else {
        wall = el('span', { class: 'phone-wall computer-wall' }, [UI.osIcon(tile.os)]);
      }
      const b = el('button', {
        class: 'phone-tile' + (tile.kind === 'computer' ? ' computer' : '') + (tile.connected ? ' connected' : '') + (tile.selected ? ' selected' : '') + (tile.state === 'via' ? ' via' : ''),
        title: tile.state === 'via' ? t('{name} is reached through {via}', { name: tile.name, via: tile.via.join(', ') }) : tile.action === 'connect' ? t('Connect to {name}', { name: tile.name }) : tile.name,
      }, [
        wall,
        el('span', { class: 'phone-text' }, [el('span', { class: 'phone-name', text: tile.name }), el('span', { class: 'phone-sub', text: tile.sub })]),
        tile.connected ? el('span', { class: 'dot good' }) : tile.state === 'connecting' ? el('span', { class: 'spin', attrs: { 'aria-hidden': 'true' } }) : tile.state === 'via' ? el('span', { class: 'pill muted', text: t('via {via}', { via: tile.via[0] || '…' }) }) : null,
      ]);
      b.dataset.id = tile.id;
      b.dataset.connected = tile.connected ? '1' : '';
      b.dataset.selected = tile.selected ? '1' : '';
      if (tile.action === 'none') b.setAttribute('aria-disabled', 'true');
      b.onclick = () => pick(tile);
      if (tile.forget && tile.forget.length) { // paired but offline: forget it (right-click, or the x on hover); a stale twin goes too
        const forget = () => { for (const id of tile.forget) Promise.resolve(api.forgetPeer(id)).catch(() => {}); };
        b.appendChild(el('span', { class: 'tile-x', role: 'button', title: t('Forget {name}', { name: tile.name }), text: '×', onclick: (e) => { e.stopPropagation(); forget(); } }));
        b.oncontextmenu = (e) => { e.preventDefault(); forget(); };
      }
      return b;
    }));
    markTiles();
  }

  function renderBanner(s) {
    const inv = !s.pairing && s.inviting;
    $('banner').hidden = !s.pairing && !inv;
    if (inv) { // this computer asked a phone to pair: it goes on there
      $('banner').classList.remove('failed');
      $('pair-title').textContent = t('Press Pair on {name}', { name: inv.name });
      $('pair-code-wrap').hidden = true;
      $('pair-match').hidden = true;
      $('pair-cancel').textContent = t('Cancel');
      $('pair-hint').textContent = t('TwinDesk on {name} asks to pair with this computer. Press Pair there, then compare the codes.', { name: inv.name });
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
      request: p.wired ? (p.allowed ? t('Pairing…') : t('{name} is on the USB cable. Click Allow to pair.', { name: p.macName })) : !p.code ? t('Waiting for the code…') : p.allowed ? t('Waiting for {name}…', { name: p.macName }) : t('Check that {name} shows the same code, then click Allow.', { name: p.macName }),
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
    show((s.ui && s.ui.tab) === 'phone' && !(s.phone && s.phone.connected) ? 'connection' : (s.ui && s.ui.tab) || 'connection', false);
    render(s);
  });
})();

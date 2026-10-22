// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Main window shell: sidebar + one page per registered tab (ui-*.js), pairing banner, accent
// rendering of the state pushed by main. Same structure and look as the Mac's.
'use strict';

(() => {
  const { el, api } = UI;
  const M = window.SidebarModel; // shared/sidebar-model.js: device tiles and the sections per kind
  const $ = (id) => document.getElementById(id);
  const nav = $('nav');
  const pages = $('pages');
  const views = new Map(); // id -> { def, page, navBtn, stateEl, master, render }
  let current = null;

  // Sidebar groups: no headings, one icon column, a small gap
  // between groups; General sits below a line.
  const GROUP = { overview: 0, calls: 0.5, messages: 0.5, media: 0.5, 'mac-pc': 1, 'pc-mac': 1, cursor: 2, keyboard: 2, clipboard: 3, notifications: 3, files: 3, terminal: 4, audio: 4, apps: 4 };
  let lastGroup;
  let gap = null; // the gap before the current group (hidden with the group: renderSidebar)
  for (const def of UI.tabs.slice().sort((a, b) => (a.order ?? 50) - (b.order ?? 50))) {
    if (def.navHidden) { // reached another way (the phone tile)
      views.set(def.id, { def, ...buildPage(def), navBtn: el('button'), stateEl: el('span') });
      continue;
    }
    const group = GROUP[def.id];
    if (!def.bottom && lastGroup !== undefined && group !== lastGroup) nav.append(gap = el('li', { class: 'gap', attrs: { role: 'presentation' } }));
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
    views.set(def.id, { def, ...buildPage(def), navBtn, stateEl, navLabel, gap });
  }

  function buildPage(def) {
    const page = el('section', { class: 'page', id: 'page-' + def.id, hidden: true, attrs: { role: 'tabpanel' } });
    const headText = el('span', { text: def.heading || def.title });
    const limitNote = def.macOnly ? UI.note('info', '') : null;
    const devTag = el('span', { class: 'pill muted dev-tag', hidden: true }); // names the connected device on its own sections
    const titles = el('div', { class: 'titles' }, [
      el('h1', {}, [headText, def.phase ? el('span', { class: 'pill muted', text: 'Phase ' + def.phase }) : null, devTag]),
      el('p', { text: def.desc || '' }),
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
    const body = el('div', { class: 'page-body' }, limitNote ? [limitNote] : []);
    page.append(body);
    pages.append(page);
    const render = def.build(body, page) || (() => {});
    return { page, body, master, render, headText, limitNote, wifiNote, devTag };
  }

  // The session is through Bluetooth (pages that need Wi-Fi say so).
  const onBle = (s) => !!(s && s.net && s.net.transport === 'ble');

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
    if (v.devTag) { // the connected device's name on the sections that show its settings and data
      const n = M.isScoped(v.def.id) && s.peerSession ? s.peerSession.name : '';
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
    let text = 'Not paired';
    if (l.state === 'connected') text = l.macName + (UI.via(s) !== 'Wi-Fi' ? ' · ' + UI.via(s) : '') + (l.rtt != null ? ' · ' + l.rtt + ' ms' : '');
    else if (s.pairing) text = 'Pairing…';
    else if (l.state === 'connecting' || l.state === 'reconnecting') text = 'Reconnecting…';
    else if (l.state === 'identity_changed') text = 'Identity changed';
    $('peer-text').textContent = text;
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
      const b = v.def.badge ? v.def.badge(s) : v.def.phase ? 'P' + v.def.phase : '';
      v.stateEl.className = 'state' + (b === 'on' ? ' on' : b === 'warn' ? ' warn' : '');
      v.stateEl.textContent = b === 'on' || b === 'warn' ? '' : b || '';
    }
  }

  // The kind of the selected device: its sections follow it (shared/sidebar-model.js).
  // Linux has no hub: the one connected peer is the only device (and the selected one).
  const peersOf = (s) => M.singlePeer(s.peer, s.link && s.link.state, s.link && s.link.rtt);
  const kindOfState = (s) => (UI.isPhone(s) ? 'phone' : M.selectedKind(peersOf(s)) === 'none' ? 'none' : 'computer');
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
    Promise.resolve(api.setActivePeer ? api.setActivePeer(t.id) : null).catch(() => go());
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
      if (!d.connected) return ph.connecting && ph.connecting.id === d.id ? 'Connecting…' : 'Nearby · Click to connect';
      const rtt = mine ? mine.rttMs : ph.connected && ph.connected.rttMs;
      const bat = mine ? mine.battery : info.battery;
      const chg = mine ? mine.charging : info.charging;
      return (rtt != null ? rtt + ' ms' : 'Connected') + (bat != null ? ' · ' + bat + '%' + (chg ? ' ⚡' : '') : '');
    };
    const phones = ph.nearby.map((d) => ({ id: d.id, name: d.name, connected: !!d.connected, connecting: !!(ph.connecting && ph.connecting.id === d.id), sub: subOf(d) }));
    const tiles = M.buildTiles({ peers: peersOf(s), phones, transport: UI.via(s) });
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

  function renderBanner(s) {
    const inv = !s.pairing && s.inviting;
    $('banner').hidden = !s.pairing && !inv;
    if (inv) { // this computer asked a phone to pair: it goes on there
      $('banner').classList.remove('failed');
      $('pair-title').textContent = 'Press Pair on ' + inv.name;
      $('pair-code-wrap').hidden = true;
      $('pair-match').hidden = true;
      $('pair-cancel').textContent = 'Cancel';
      $('pair-hint').textContent = 'TwinDesk on ' + inv.name + ' asks to pair with this computer. Press Pair there, then compare the codes.';
      return;
    }
    const p = s.pairing;
    if (!p) return;
    $('banner').classList.toggle('failed', p.phase === 'failed');
    const host = p.role === 'host'; // another computer asks to pair with this PC
    $('pair-title').textContent = host ? p.macName + ' wants to pair' : 'Pairing with ' + p.macName;
    $('pair-code-wrap').hidden = !p.code || !!p.wired; // on the USB cable: nothing to compare
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
      request: p.wired ? (p.allowed ? 'Pairing…' : p.macName + ' is on the USB cable. Click Allow to pair.') : !p.code ? 'Waiting for the code…' : p.allowed ? 'Waiting for ' + p.macName + '…' : 'Check that ' + p.macName + ' shows the same code, then click Allow.',
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

  // The connected device changed: the sections show the new one (no data of the previous one stays).
  let selKey = null;
  function selectionChanged(s) {
    const sel = M.selectedOf(peersOf(s));
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
    show((s.ui && s.ui.tab) === 'phone' && !(s.phone && s.phone.connected) ? 'overview' : (s.ui && s.ui.tab) || 'overview', false);
    render(s);
  });
})();

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Overview (Mac, PC and Linux): the connected device itself, shown once something is connected;
// the device's tile at the top of the sidebar opens it too. Before that, Connection is the start.
//   A phone: its picture, battery and link; Show screen, Ring, Disconnect; what plays there; its
//   quick settings (Wi-Fi, Bluetooth, data, hotspot, torch, Do not disturb, rotation, battery
//   saver), its volume and ringer; the latest notifications (a one-time code gets Copy); its most
//   used apps.
//   A computer: both computers and the link; Ring, Lock, Sleep, its Bluetooth and Do not disturb.
//   Both: ReZume's offer, then what each feature that's on has: its notifications on the left; on the
//   right the clipboard's recent items, the most used apps and a drop zone that sends files. A column
//   with nothing in it gives the other the whole width; with nothing on at all, none of it shows.
//   The switches themselves are on each feature's page.
// What the other side doesn't report (an older TwinDesk) is left out, not shown as off.
'use strict';

(function () {
  const t = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
  const PHONE_QS = [
    // id, label, icon (20×20 strokes)
    ['wifi', t('Wi-Fi'), 'M2.5 7.5a11 11 0 0 1 15 0 M5 10.3a7.3 7.3 0 0 1 10 0 M7.6 13a3.5 3.5 0 0 1 4.8 0 M10 15.8v.1'],
    ['bluetooth', t('Bluetooth'), 'M6 6.5l8 7-4 3.5V3l4 3.5-8 7'],
    ['data', t('Mobile data'), 'M6.5 16V5 M4 7.5l2.5-2.5L9 7.5 M13.5 4v11 M11 12.5l2.5 2.5 2.5-2.5'],
    ['hotspot', t('Hotspot'), 'M10 10.5v.1 M7.3 13a3.8 3.8 0 0 1 0-5.2 M12.7 7.8a3.8 3.8 0 0 1 0 5.2 M4.8 15.4a7.3 7.3 0 0 1 0-10.2 M15.2 5.2a7.3 7.3 0 0 1 0 10.2'],
    ['torch', t('Torch'), 'M7 2.5h6v4l-1.5 2.5V17.5h-3V9L7 6.5z'],
    ['dnd', t('Do not disturb'), 'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z M6 10h8'],
    ['rotate', t('Auto-rotate'), 'M3.5 10a6.5 6.5 0 0 1 11.3-4.4L16.5 7 M16.5 3v4h-4 M16.5 10a6.5 6.5 0 0 1-11.3 4.4L3.5 13 M3.5 17v-4h4'],
    ['saver', t('Battery saver'), 'M3.5 6.5h11v7h-11z M14.5 8.5h2v3h-2 M9 8v4 M7 10h4'],
  ];
  const RINGER = [{ value: 'ring', label: t('Ring') }, { value: 'vibrate', label: t('Vibrate') }, { value: 'silent', label: t('Silent') }];
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const glyph = (d) => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
    return svg;
  };
  const otpOf = (t) => (window.Otp ? window.Otp.otpOf(t) : '');
  // The PC and Linux say the session in s.link, the Mac in s.client.
  const linked = (s) => !!(s && ((s.link && s.link.state === 'connected') || s.client || (s.phone && s.phone.connected) || s.activeWebDevice || (s.webDevices && s.webDevices.some((d) => d.active))));
  const viaOf = (s) => (UI.via ? UI.via(s) : s.client && s.client.transport === 'ble' ? t('Bluetooth') : t('Wi-Fi'));

  UI.tab({
    id: 'overview',
    order: 0,
    title: 'Overview',
    heading: 'Overview',
    icon: 'overview',
    color: 'linear-gradient(#8e8e93, #636366)',
    desc: '',
    hidden: (s) => !linked(s), // Connection until something is connected
    build(body, page) {
      const { el, api } = UI;
      page.classList.add('device-page');
      const h1 = page.querySelector('h1 span');
      const desc = page.querySelector('.page-head p');
      // This page interpolates its own messages; braces in device data stay literal.
      for (const node of [body, h1, desc]) node.setAttribute('data-literal', '');
      const row = (label, hint, controls = []) => UI.row(label, hint, controls, { literal: true });
      const doIt = (c) => (api.deviceDo ? api.deviceDo(c) : Promise.resolve());

      // ---- hero ----
      const pic = el('div', { class: 'device phone big' });
      const name = el('div', { class: 'hero-name' });
      const sub = el('div', { class: 'hero-status' });
      const batt = el('div', { class: 'dv-batt' }, [el('div', { class: 'dv-batt-fill' })]);
      const battText = el('span', { class: 'dv-batt-text' });
      const battRow = el('div', { class: 'dv-batt-row' }, [batt, battText]);
      const showBtn = UI.button(t('Show screen'), () => (UI.state && UI.state.activeWebDevice ? UI.go('share') : api.phoneScreen(true)), 'primary');
      let ringing = false;
      const ringBtn = UI.button(t('Ring'), () => { ringing = !ringing; doIt({ do: ringing ? 'ring' : 'ringStop' }); paint(); });
      const lockBtn = UI.button(t('Lock'), () => doIt({ do: 'lock' }));
      const sleepBtn = UI.button(t('Sleep'), () => doIt({ do: 'sleep' }));
      let wifiOn = false;
      const wifiBtn = UI.button(t('Use Wi-Fi Direct'), () => api.netWifi(!wifiOn));
      const hotspotBtn = UI.button(t('Use hotspot'), () => { api.netWifi('hotspot'); UI.go('connection'); });
      const discBtn = UI.button(t('Disconnect'), () => {
        const s = UI.state || {};
        if (s.activeWebDevice && api.disconnectWebClient) return api.disconnectWebClient(s.activeWebDevice.id);
        if (UI.isPhone(s) && api.disconnectPhone) return api.disconnectPhone();
        return api.disconnect();
      });
      // Each button with its icon (20×20 strokes, the colour of its text).
      const ICO = {
        show: 'M6.5 2.5h7a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z M9 15h2',
        ring: 'M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5h-12z M8.5 16.5a1.5 1.5 0 0 0 3 0',
        lock: 'M5 9h10v8H5z M7 9V6.5a3 3 0 0 1 6 0V9 M10 12v2',
        sleep: 'M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z',
        wifi: 'M2.5 7.5a11 11 0 0 1 15 0 M5 10.3a7.3 7.3 0 0 1 10 0 M7.6 13a3.5 3.5 0 0 1 4.8 0 M10 15.8v.1',
        hotspot: 'M10 10.5v.1 M7.3 13a3.8 3.8 0 0 1 0-5.2 M12.7 7.8a3.8 3.8 0 0 1 0 5.2 M4.8 15.4a7.3 7.3 0 0 1 0-10.2 M15.2 5.2a7.3 7.3 0 0 1 0 10.2',
        disconnect: 'M8.5 11.5l-1 1a3 3 0 0 1-4.2-4.2l2.2-2.2 M11.5 8.5l1-1a3 3 0 0 1 4.2 4.2l-2.2 2.2 M3 3l14 14',
      };
      const iconed = (b, k) => { b.prepend(glyph(ICO[k])); b.classList.add('ico'); return b; };
      iconed(showBtn, 'show'); iconed(ringBtn, 'ring'); iconed(lockBtn, 'lock'); iconed(sleepBtn, 'sleep');
      iconed(wifiBtn, 'wifi'); iconed(hotspotBtn, 'hotspot'); iconed(discBtn, 'disconnect');
      const ringNote = el('div', { class: 'hint dv-ring-note', text: '' });
      const facts = el('dl', { class: 'dv-facts' });
      const hero = el('div', { class: 'card dv-hero' }, [
        pic,
        el('div', { class: 'dv-hero-main' }, [
          name, sub, battRow,
          el('div', { class: 'dv-actions' }, [showBtn, ringBtn, lockBtn, sleepBtn, wifiBtn, hotspotBtn, discBtn]),
          ringNote,
        ]),
        facts,
      ]);
      const notConnected = UI.note('info', '');

      // ---- now playing (shared/ui-nowplaying.js) ----
      const media = UI.nowPlaying ? UI.nowPlaying() : null;
      const mediaCard = el('div', { class: 'card dv-media' }, media ? [media.el] : []);

      // ---- quick settings ----
      const tiles = {};
      const grid = el('div', { class: 'dv-qs' });
      for (const [id, label, icon] of PHONE_QS) {
        const state = el('span', { class: 'dv-qs-state' });
        const b = el('button', { class: 'dv-qs-tile', attrs: { 'aria-pressed': 'false' } }, [glyph(icon), el('span', { class: 'dv-qs-label' }, [el('span', { text: label }), state])]);
        b.onclick = () => {
          const qs = (UI.state && UI.state.phone && UI.state.phone.qs) || {};
          doIt({ do: 'qs', id, on: !qs[id] });
        };
        tiles[id] = { b, state, label };
        grid.append(b);
      }
      // Even rows: every tile in one row when each gets 110 px, else half of them per row.
      const cols = () => {
        const n = [...grid.children].filter((b) => !b.hidden).length || 1;
        const w = grid.clientWidth - 28;
        grid.style.setProperty('--cols', String(w >= n * 110 ? n : Math.ceil(n / 2)));
      };
      new ResizeObserver(cols).observe(grid);
      const vol = UI.slider({ min: 0, max: 100, step: 1, format: (v) => v + '%' }, (v) => doIt({ do: 'volume', stream: 'media', level: v / 100 }));
      const ringer = UI.segmented(RINGER, (v) => doIt({ do: 'ringer', mode: v }));
      const soundRow = row(t('Media volume'), '', [vol, ringer]);
      const qsCard = UI.card(t('Quick actions'), [grid, soundRow], { actions: [UI.button(t('Customize'), () => UI.go('general'), 'small link')] });

      // ---- computer controls ----
      const pcBt = UI.switch((v) => doIt({ do: 'bluetooth', on: v }), { label: t('Bluetooth') });
      const pcDnd = UI.switch((v) => doIt({ do: 'dnd', on: v }), { label: t('Do not disturb') });
      const pcBtRow = row(t('Bluetooth'), '', [pcBt]);
      const pcDndRow = row(t('Do not disturb'), '', [pcDnd]);
      const pcVol = UI.slider({ min: 0, max: 100, step: 1, format: (v) => v + '%' }, (v) => doIt({ do: 'volume', level: v / 100 }));
      const pcVolRow = row(t('Volume'), '', [pcVol]);
      const pcCard = UI.card(t('Controls'), [pcBtRow, pcDndRow, pcVolRow]);

      // ---- what's on: notifications on the left; clipboard, most used apps and send files on the right ----
      const notifList = el('div');
      const notifCard = UI.card(t('Latest notifications'), [notifList], { actions: [UI.button(t('See all'), () => UI.go('notifications'), 'small link')] });
      const clipList = el('div', { class: 'history' });
      const clipCard = UI.card(t('Clipboard'), [clipList], { actions: [UI.button(t('See all'), () => UI.go('clipboard'), 'small link')] });
      const appsGrid = el('div', { class: 'app-grid dv-apps' });
      const appsCard = UI.card(t('Most used'), [appsGrid], { actions: [UI.button(t('All apps'), () => UI.go('papps'), 'small link')] });
      const dropHint = el('div', { class: 'hint' });
      const zone = el('div', { class: 'dropzone dv-drop' }, [el('div', {}, [el('div', { class: 'big', text: t('Drop files here') }), dropHint])]);
      const dropCard = UI.card(t('Send files'), [zone], { actions: [UI.button(t('Choose…'), () => api.chooseSendFiles(), 'small link')] });
      let canSend = false;
      zone.ondragover = (e) => { e.preventDefault(); if (canSend) zone.classList.add('over'); };
      zone.ondragleave = () => zone.classList.remove('over');
      zone.ondrop = (e) => {
        e.preventDefault();
        zone.classList.remove('over');
        // As an array: a FileList reaches the preload as a plain object, which can't be iterated.
        if (canSend) api.sendFiles(api.pathsOf([...e.dataTransfer.files]));
      };
      const left = el('div', { class: 'dv-col' }, [notifCard]);
      const right = el('div', { class: 'dv-col' }, [clipCard, appsCard, dropCard]);
      // The cards that are on fill the two columns with no gaps: notifications first on the left, then each
      // card in whichever column is shorter (a tie: the left). One card, or a narrow window: one column.
      // Nodes move only when a card's column changes (moving one mid-drag would drop the drag).
      const narrow = window.matchMedia('(max-width: 860px)');
      const flow = () => {
        const shown = [notifCard, clipCard, appsCard, dropCard].filter((c) => !c.hidden);
        lower.hidden = !shown.length;
        if (lower.hidden) return;
        left.hidden = right.hidden = false; // a card in a hidden column measures 0
        const one = shown.length < 2 || narrow.matches;
        let hl = 0;
        let hr = 0;
        const plan = shown.map((c) => {
          const col = one || hl <= hr ? left : right;
          if (col === left) hl += c.offsetHeight; else hr += c.offsetHeight; // the columns are the same width
          return [c, col];
        });
        for (const col of [left, right]) {
          const want = plan.filter(([, x]) => x === col).map(([c]) => c);
          const have = [...col.children].filter((c) => !c.hidden);
          if (want.length !== have.length || want.some((c, i) => c !== have[i])) col.append(...want);
        }
        left.hidden = !plan.some(([, x]) => x === left);
        right.hidden = !plan.some(([, x]) => x === right);
        lower.classList.toggle('one', left.hidden || right.hidden);
      };
      narrow.addEventListener('change', flow);
      const lower = el('div', { class: 'dv-two' }, [left, right]);

      const rezume = UI.rezumeCard ? UI.rezumeCard() : null;
      const rezumeTitle = rezume && rezume.el.querySelector('[data-peer]');

      body.append(notConnected, hero, mediaCard, qsCard, pcCard, ...(rezume ? [rezume.el] : []), lower);

      let notifKey = '';
      let clipKey = '';
      let appsKey = '';
      // A button's words, its icon kept.
      const label = (b, t) => { const n = [...b.childNodes].find((x) => x.nodeType === 3); if (n) n.nodeValue = t; else b.append(t); };
      function paint() {
        label(ringBtn, ringing ? t('Stop ringing') : t('Ring'));
        ringBtn.classList.toggle('danger', ringing);
        ringNote.textContent = ringing ? t('Rings at full volume, even on silent, until you stop it here or there.') : '';
        ringNote.hidden = !ringing;
      }

      return (s) => {
        const phone = UI.isPhone(s);
        const ph = s.phone || {};
        const c = ph.connected;
        const on = linked(s);
        notConnected.set(on ? '' : t('Nothing is connected. Connect a phone or computer on the Connection page.'));
        for (const x of [hero, mediaCard, qsCard, pcCard, lower]) x.hidden = !on;
        if (!on) return;
        const p = UI.peer(s);
        const info = ph.info || {};
        const ctl = (phone ? ph.ctl : s.peerCtl) || null; // what the other side can do (deviceDo), null: an older TwinDesk

        // hero
        const web = s.activeWebDevice;
        const devName = phone && c ? c.name : (web ? web.name : ((s.peer && s.peer.name) || (s.client && s.client.name) || p.name));
        h1.textContent = devName;
        name.textContent = devName;
        pic.className = 'device big ' + (phone ? 'phone' : (web ? UI.osClass(web.os) : UI.osClass(p.os)));
        if (phone && UI.phoneWall) pic.style.setProperty('--phone-wall', UI.phoneWall);
        else if (phone && info.colors && info.colors.length) pic.style.setProperty('--phone-wall', `linear-gradient(160deg, ${info.colors.join(', ')}${info.colors.length === 1 ? `, ${info.colors[0]}` : ''})`);
        else pic.style.removeProperty('--phone-wall');
        const rtt = phone ? c && c.rttMs : s.link ? s.link.rtt : s.client && s.client.rttMs;
        const via = phone && c && c.usb ? 'USB' : (web ? t('Web') : viaOf(s));
        desc.textContent = web ? (web.kind === 'phone' ? (web.os === 'ios' ? 'Apple iPhone' : t('Mobile Web Client')) : (web.os === 'ipados' ? 'Apple iPad' : t('Web Companion Client')))
          : phone ? [info.maker && info.model ? `${info.maker} ${info.model}` : info.model, info.release && `Android ${info.release}`].filter(Boolean).join(' · ')
          : { mac: 'Mac', win: t('Windows PC'), linux: t('Linux computer') }[p.os] || '';
        sub.textContent = [t('Connected'), via, rtt != null ? t('{value} ms', { value: rtt }) : ''].filter(Boolean).join(' · ');
        const level = phone ? info.battery : s.peerInfo && s.peerInfo.battery;
        battRow.hidden = level == null;
        if (level != null) {
          batt.firstChild.style.width = Math.max(2, Math.min(100, level)) + '%';
          batt.classList.toggle('low', level <= 20);
          battText.textContent = t('{level}%{charging}', { level, charging: (phone ? info.charging : s.peerInfo && s.peerInfo.charging) ? ' · ' + t('Charging') : '' });
        }
        const ready = !!(ph.bridge && ph.bridge.state === 'ready');
        if (s.activeWebDevice) {
          showBtn.hidden = false;
          showBtn.disabled = false;
          showBtn.title = t('Share screen with web client');
        } else {
          showBtn.hidden = !phone;
          showBtn.disabled = !ready;
          showBtn.title = ready ? '' : t('Needs wireless debugging (Connection)');
        }
        const can = (k) => !!(ctl && ctl.can && ctl.can[k]);
        ringBtn.hidden = !can('ring');
        if (ctl && typeof ctl.ringing === 'boolean' && ctl.ringing !== ringing) ringing = ctl.ringing;
        paint();
        lockBtn.hidden = !can('lock');
        sleepBtn.hidden = phone || !can('sleep');
        const n = s.net || {};
        wifiOn = (n.why || []).includes('user') || !!n.linked;
        label(wifiBtn, wifiOn ? t('Back to Bluetooth') : t('Use Wi-Fi Direct'));
        const ble = n.transport === 'ble' || !!(s.client && s.client.transport === 'ble'); // the Mac says it on s.client
        wifiBtn.hidden = !(wifiOn || ble);
        hotspotBtn.hidden = !phone || wifiOn || n.state === 'hotspot' || !ble;

        const fact = (k, v) => (v ? [el('dt', { text: k }), el('dd', { text: v })] : []);
        const br = ph.bridge || {};
        const pi = (ctl && ctl.info) || {};
        const control = br.input === 'phone' ? t('Accessibility')
          : br.state === 'ready' ? t('ADB · ready') : br.state === 'connecting' ? t('ADB · connecting') : br.state === 'needsPair' ? t('ADB · not paired') : br.state === 'waitingWifi' ? t('ADB · off') : t('Not set up');
        // Which TwinDesk it runs (dev.state's app: shared/appinfo.js), red when older than this one.
        const ac = ctl && ctl.appCheck;
        const verFact = () => {
          if (!ac) return [];
          const dd = el('dd', { text: ac.version || t('Older') });
          dd.classList.toggle('dv-old', ac.older);
          dd.title = ac.older ? t('Older than this one. Update it there: some features need the same version on both') : '';
          return [el('dt', { text: 'TwinDesk' }), dd];
        };
        facts.replaceChildren(...(phone ? [
          ...fact(t('Storage'), pi.storageTotal ? t('{used} of {total} GB', { used: pi.storageUsed, total: pi.storageTotal }) : info.storage ? t('{used} of {total} GB', { used: info.storage.used, total: info.storage.total }) : ''),
          ...fact(t('Network'), [pi.wifi, pi.cell].filter(Boolean).join(' · ')),
          ...fact(t('Control'), control),
          ...fact(t('Signal'), pi.signal),
          ...fact(t('Link'), via),
          ...verFact(),
        ] : [
          ...fact(t('System'), s.peer && s.peer.osVersion),
          ...fact(t('Address'), (s.paired && s.paired.address) || (s.client && s.client.address)),
          ...fact(t('Link'), via),
          ...verFact(),
        ]));
        facts.hidden = !facts.childElementCount;

        // media: while something plays there and Media controls is on
        if (media) media.update(s);
        mediaCard.hidden = !media || media.el.hidden || (s.audio || {}).phoneMedia === false;

        // quick settings: only what the phone reports
        const qs = phone && ph.qs;
        qsCard.hidden = !qs;
        if (qs) {
          for (const [id] of PHONE_QS) {
            const tile = tiles[id];
            const has = id in qs;
            tile.b.hidden = !has;
            if (!has) continue;
            tile.b.classList.toggle('on', !!qs[id]);
            tile.b.setAttribute('aria-pressed', String(!!qs[id]));
            const detail = qs.detail && qs.detail[id];
            tile.state.textContent = qs[id] ? detail || t('On') : t('Off');
            tile.b.title = qs.panel && qs.panel[id] ? t('Opens the setting on the phone') : '';
          }
          cols();
          soundRow.hidden = qs.volume == null;
          if (qs.volume != null) vol.set(Math.round(qs.volume * 100));
          ringer.el.hidden = !qs.ringer;
          if (qs.ringer) ringer.set(qs.ringer);
        }

        // computer controls
        pcCard.hidden = phone || !(can('bluetooth') || can('dnd') || can('volume'));
        if (!pcCard.hidden) {
          pcBtRow.hidden = !can('bluetooth');
          pcBt.set(!!ctl.bluetooth);
          pcDndRow.hidden = !can('dnd');
          pcDnd.set(!!ctl.dnd);
          pcVolRow.hidden = !can('volume');
          if (ctl.volume != null) pcVol.set(Math.round(ctl.volume * 100));
        }

        const ov = (s.ui && s.ui.overview) || {}; // General › Overview: what's left out

        // latest notifications: while Notifications is on
        const nf = s.notifs || {};
        const history = (nf.history || []).slice(0, 6);
        notifCard.hidden = !nf.receive || ov.notifs === false;
        const nk = JSON.stringify([history.map((h) => [h.id, h.at, h.actions]), Object.keys(nf.historyIcons || {}).length, devName, phone]);
        if (nk !== notifKey) {
          notifKey = nk;
          notifList.replaceChildren(...(history.length ? history.map((item) => {
            const text = [item.subtitle, item.body].filter(Boolean).join(' · ');
            const code = otpOf([item.title, item.body].join(' '));
            const copy = code ? UI.button(t('Copy {code}', { code }), () => api.copyText(code), 'small') : null;
            // A phone's: its own buttons (Mark as read…), and × dismisses it there too (shared/notifacts.js).
            const acts = phone && api.notifReply ? (item.actions || []).map((a, i) => UI.button(a, () => api.notifReply({ id: item.id, act: i }), 'small')) : [];
            const x = phone && api.notifReply ? UI.button('×', () => api.notifReply({ id: item.id, dismiss: true }), 'small') : null;
            if (x) { x.title = t('Dismiss'); x.setAttribute('aria-label', t('Dismiss')); }
            const r = row([item.appName || item.app, item.title].filter(Boolean).join(' · '), (text || t('Notification')) + ' · ' + UI.ago(item.at), [copy, ...acts, x]);
            const icon = (nf.historyIcons || {})[item.app];
            if (icon) {
              r.querySelector('.text').prepend(el('img', { class: 'dv-nicon', src: icon, alt: '' }));
              r.classList.add('with-ico');
            }
            return r;
          }) : [row(t('Nothing yet'), t('New notifications from {name} show here', { name: devName }))]));
        }

        // the clipboard's recent items: while Clipboard is on
        const cb = s.clipboard || {};
        const recent = (cb.history || []).slice(0, 4);
        clipCard.hidden = !cb.enabled || ov.clipboard === false;
        const ck = JSON.stringify([recent.map((h) => [h.at, h.dir, !!(h.image && h.image.copy)]), cb.historySize, devName, Math.floor(Date.now() / 15000)]);
        if (!clipCard.hidden && ck !== clipKey) {
          clipKey = ck;
          clipList.replaceChildren(...(recent.length ? recent.map((h, i) => el('div', { class: 'hist-item' }, [
            el('span', { class: 'hist-dir ' + h.dir, title: t(h.dir === 'out' ? 'Sent to {name}' : 'From {name}', { name: devName }) }, [UI.icon(h.dir === 'out' ? 'up' : 'down')]),
            h.image && h.image.thumb ? el('img', { class: 'hist-thumb', src: h.image.thumb, alt: '' }) : null,
            el('div', { class: 'hist-text' }, [
              el('div', { class: 'hist-preview', text: h.image ? (h.image.shot ? t('Screenshot') : t('Picture')) + ' · ' + h.image.w + ' × ' + h.image.h : String(h.text || '').replace(/\s+/g, ' ').trim() || t('(whitespace)') }),
              el('div', { class: 'hint', text: t(h.dir === 'out' ? 'To {name}' : 'From {name}', { name: devName }) + ' · ' + UI.ago(h.at) }),
            ]),
            !h.image || h.image.copy ? UI.button(t('Copy'), () => api.copyHistory(i), 'small') : null,
          ])) : [row(cb.historySize === 0 ? t('Recent items are off') : t('Nothing yet'), cb.historySize === 0 ? t('Turn them on in Clipboard') : t('What’s copied on either side shows here'))]));
        }

        // send files: while sending files is on (the Mac has no switch for it: always)
        const fl = s.files || {};
        canSend = fl.dropToMac !== false;
        dropCard.hidden = !canSend || ov.files === false;
        dropHint.textContent = t('They go to {name}’s Downloads', { name: devName });

        // most used apps: the phone's own order (Usage access), else what was opened from here
        const apps = (UI.phoneAssets && UI.phoneAssets.apps) || [];
        const top = (phone ? ph.top || [] : []).map((id) => apps.find((a) => a.id === id)).filter(Boolean).slice(0, 8);
        appsCard.hidden = !top.length || ov.apps === false;
        const ak = JSON.stringify([top.map((a) => a.id), ready]);
        if (ak !== appsKey) {
          appsKey = ak;
          appsGrid.replaceChildren(...top.map((a) => {
            const b = el('button', { class: 'app-tile', title: t('Open {app}', { app: a.name }), disabled: !ready }, [UI.appIcon(a.icon), el('span', { text: a.name })]);
            b.onclick = () => api.phoneOpenApp({ id: a.id, name: a.name });
            return b;
          }));
        }
        if (ov.media === false) mediaCard.hidden = true;
        if (ov.qs === false) qsCard.hidden = true;

        flow();
        if (rezume) {
          if (rezumeTitle) rezumeTitle.textContent = t('Continue from {name}', { name: devName });
          rezume.update(s, true);
        }
      };
    },
  });
})();

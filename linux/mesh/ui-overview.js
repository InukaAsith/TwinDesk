// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Overview tab (copy of windows/mesh/ui-overview.js): this computer's address and Connect by address on top, the
// computers found nearby (always visible), the two computers, one switch per feature and
// direction, and what is paired.
'use strict';

UI.tab({
  id: 'connection', // was Overview: the device's own Overview is shared/ui-device.js
  order: 1,
  title: window.I18n.t('Connection'),
  heading: window.I18n.t('Connection'),
  icon: 'link',
  desc: '',
  color: 'linear-gradient(#5ac8fa, #007aff)',
  badge: (s) => (s.link.state === 'identity_changed' || (s.discovery && !s.discovery.on) || s.found.some((d) => d.invited) ? 'warn' : ''),
  build(body) {
    const { el, api } = UI;
    const t = (text, vars) => window.I18n ? window.I18n.t(text, vars) : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
    const WHERE = { driving: t('You’re using {there}'), driven: t('{There} is using {me}') };

    const linkLine = el('div', { class: 'hero-link' }, [el('span', { class: 'hero-pulse' })]);
    const linkText = el('div', { class: 'hero-link-text' });
    const pcName = el('div', { class: 'hero-name', attrs: { 'data-literal': '' } });
    const macName = el('div', { class: 'hero-name', attrs: { 'data-literal': '' } });
    const status = el('div', { class: 'hero-status', attrs: { 'data-literal': '' } });
    // The session: Disconnect it; Connect again after one (or Take over while another device has it).
    const discBtn = UI.button(t('Disconnect'), () => api.disconnect(), 'small');
    const againBtn = UI.button(t('Connect'), () => api.connectAgain(), 'small primary');
    const sessionBtns = el('div', { class: 'hero-actions' }, [againBtn, discBtn]);
    const peerDev = el('div', { class: 'device mac' });
    const netCancel = UI.button(t('Cancel'), () => api.netCancel(), 'small');
    netCancel.hidden = true;
    // A session on Bluetooth: onto a direct Wi-Fi link on request, until Back to Bluetooth.
    let wifiOn = false;
    const wifiBtn = UI.button(t('Connect with Wi-Fi Direct'), () => api.netWifi(!wifiOn), 'small');
    wifiBtn.hidden = true;
    // A phone: its hotspot instead. It switches it on; its name and password here once (saved for it).
    const hotspotBtn = UI.button(t('Connect with hotspot'), () => api.netWifi('hotspot'), 'small');
    hotspotBtn.hidden = true;
    const hsSsid = el('input', { type: 'text', placeholder: t('Hotspot name'), autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': t('Hotspot name') } });
    const hsPass = el('input', { type: 'password', placeholder: t('Password'), autocomplete: 'off', attrs: { 'aria-label': t('Hotspot password') } });
    const hsJoin = UI.button(t('Join'), () => api.netJoinHotspot({ ssid: hsSsid.value, pass: hsPass.value }), 'small primary');
    hsSsid.onkeydown = hsPass.onkeydown = (e) => { if (e.key === 'Enter') hsJoin.click(); };
    const hsForm = el('div', { class: 'hero-actions' }, [hsSsid, hsPass, hsJoin]);
    hsForm.hidden = true;
    let hsShown = false;
    const hero = el('div', { class: 'card hero' }, [
      el('div', { class: 'hero-devices' }, [
        el('div', { class: 'hero-device' }, [el('div', { class: 'device pc' }), pcName]),
        el('div', { class: 'hero-mid' }, [linkLine, linkText]),
        el('div', { class: 'hero-device' }, [peerDev, macName]),
      ]),
      status,
      hsForm,
      netCancel,
      el('div', { class: 'hero-actions' }, [wifiBtn, hotspotBtn]),
      sessionBtns,
    ]);

    // One switch per feature and direction, labels only; the row opens the tab.
    // later: not on Linux yet, always off (nothing uses it now: Linux has every row).
    // phone: false = hidden while a phone is the peer.
    const row = (label, tab, get, set, later, { phone = true } = {}) => {
      const sw = UI.switch(set || (() => {}), { label, disabled: !set });
      const r = UI.row(label, '', [sw, el('span', { class: 'chev', text: '›' })], { onClick: () => UI.go(tab) });
      r.update = (s) => {
        const limited = later ? t('Not on Linux yet') : '';
        sw.set(!limited && get(s));
        sw.disable(!set || !!limited);
        r.setHint(limited);
        r.hidden = !phone && UI.isPhone(s);
      };
      return r;
    };
    const notPhone = { phone: false };
    const m2p = [
      row(t('Screen'), 'mac-pc', (s) => s.stream.state === 'on', null, undefined, notPhone),
      row(t('Sound'), 'audio', (s) => s.audio.receive, (v) => api.setAudio({ receive: v })),
      row(t('Mouse and keyboard'), 'cursor', (s) => s.kvm.beDriven, (v) => api.setKvm({ beDriven: v })),
      row(t('Clipboard'), 'clipboard', (s) => s.clipboard.receive, (v) => api.setClipboard({ receive: v })),
      row(t('Notifications'), 'notifications', (s) => s.notifs.receive, (v) => api.setNotifs({ receive: v })),
      row(t('Shared folder'), 'files', (s) => s.files.mountMac, (v) => api.setFiles({ mountMac: v })),
      row(t('Terminal'), 'terminal', (s) => s.terminal.allowMac, (v) => api.setTerminal({ allowMac: v }), undefined, notPhone),
      row(t('Apps'), 'apps', (s) => s.apps.open > 0, null, undefined, notPhone),
    ];
    const p2m = [
      row(t('Screen'), 'pc-mac', (s) => s.pcScreen.mode !== 'off', (v) => api.setPcScreenMode(v ? 'last' : 'off')),
      row(t('Sound'), 'audio', (s) => s.audio.send, (v) => api.setAudio({ send: v })),
      row(t('Mouse and keyboard'), 'cursor', (s) => s.kvm.driveOther, (v) => api.setKvm({ driveOther: v })),
      row(t('Clipboard'), 'clipboard', (s) => s.clipboard.send, (v) => api.setClipboard({ send: v })),
      row(t('Notifications'), 'notifications', (s) => s.notifs.send, (v) => api.setNotifs({ send: v })),
      row(t('Shared folder'), 'files', (s) => s.files.shareOn, (v) => api.setShareOn(v)),
      row(t('Terminal'), 'terminal', (s) => s.terminal.enabled, (v) => api.setTerminal({ enabled: v }), undefined, notPhone),
      row(t('Apps'), 'apps', (s) => s.pcApps.allow, (v) => api.setPcApps({ allow: v }), undefined, notPhone),
    ];
    const pair = UI.dirCards({ rows: m2p }, { rows: p2m });

    // ---- this computer + connect by address (always visible) ----
    const addrVal = el('span', { class: 'value addr', attrs: { 'data-literal': '' } });
    const copyBtn = UI.button(t('Copy'), () => UI.state && api.copyText(UI.state.addresses[0] || ''), 'small');
    const addrRow = UI.row('{me}', '', [addrVal, copyBtn]);
    const ipInput = el('input', { type: 'text', placeholder: '192.168.1.20', autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': t('Address') } });
    let asking = '';
    const ipBtn = UI.button(t('Connect'), async () => {
      const v = ipInput.value.trim();
      if (!v || asking) return;
      asking = v;
      render();
      try { await api.connectAddress(v); } finally { asking = ''; render(); }
    }, 'small primary');
    ipInput.onkeydown = (e) => { if (e.key === 'Enter') ipBtn.click(); };
    const ipRow = UI.row(t('Connect by address'), '', [ipInput, ipBtn], { literal: true });

    // ---- found nearby (always visible) ----
    const discRow = UI.row(t('Can’t look for computers on this network.'), '', [UI.button(t('Fix firewall'), () => api.fixFirewall(), 'small')], { literal: true });
    const foundList = el('div');
    // General's two Bluetooth switches, here too: who can turn up through Bluetooth.
    const bleSw = UI.switch((v) => api.setNet({ ble: v }), { label: t('Bluetooth with phones') });
    const blePcSw = UI.switch((v) => api.setNet({ blePc: v }), { label: t('Bluetooth with computers') });
    // Multi-device on Linux: computers connect over the network only, so only the phones' switch is here.
    const bleRows = [UI.row(t('Bluetooth with phones'), '', [bleSw])];
    const refresh = UI.button(t('Refresh'), () => { // the list empties and fills again with whoever answers
      api.refreshFound();
      refresh.disabled = true;
      refresh.textContent = t('Looking…');
      setTimeout(() => { refresh.disabled = false; refresh.textContent = t('Refresh'); }, 1500);
    }, 'small');

    // ---- a connected phone's wireless debugging, until it works (the Phone page has it too) ----
    const ADB = { needsPair: ['bad', t('Pair once')], waitingWifi: ['bad', t('Off')], connecting: ['muted', t('Looking…')], missing: ['bad', t('Missing')], error: ['bad', t('Problem')] };
    const adbPill = el('span', { class: 'pill bad' });
    const adbRow = UI.row(t('Wireless debugging'), '', [adbPill, UI.button(t('Try Again'), () => api.phoneRetry(), 'small')], { literal: true });
    const adbCode = el('input', { type: 'text', placeholder: '123456', maxLength: 6, inputMode: 'numeric', autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': t('Pairing code') } });
    const adbWhere = el('input', { type: 'text', placeholder: t('Address:port (optional)'), autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': t('Pairing address') } });
    const adbPair = UI.button(t('Pair'), () => api.phonePair({ code: adbCode.value, where: adbWhere.value }), 'small primary');
    adbCode.onkeydown = adbWhere.onkeydown = (e) => { if (e.key === 'Enter') adbPair.click(); };
    const adbPairRow = UI.row(t('Pairing code'), t('Or type it on the phone, in TwinDesk’s notification'), [adbCode, adbWhere, adbPair]);
    const adbCard = UI.card(t('Phone screen, mouse and keyboard'), [adbRow, adbPairRow]);

    // Every phone whose screen/mouse/keyboard connection (wireless debugging or cable) is not working yet, each with
    // a Fix button: it makes that phone the selected one (its pairing fields show below) and tries again.
    const FIX_HINT = {
      waitingWifi: t('Turn on Developer options › Wireless debugging on the phone (same Wi-Fi), then tap Fix.'),
      needsPair: t('Pair once: Wireless debugging › Pair device with pairing code on the phone, then type the code in the Pairing code row below.'),
      missing: t('adb is missing from this build.'),
      connecting: t('Looking for the phone’s wireless debugging… If this stays, tap Fix.'),
      error: t('The connection stopped. Tap Fix to try again.'),
    };
    const fixList = el('div');
    const fixCard = UI.card(t('Phones that need fixing'), [fixList]);
    let fixKey = '';
    const notReadySince = new Map();
    setInterval(() => { if (last) update(last); }, 4000); // 'connecting' for 8 s turns into a problem without another state push

    // ---- devices (docs/mesh.md): every paired device; the selected one is what the features below use ----
    const devicesList = el('div');
    let devicesKey = '';

    const pairedList = el('div');
    const webCard = UI.webConnCard ? UI.webConnCard() : null; // TwinDesk Web's paired devices (shared/ui-web.js)
    body.append(
      UI.card('', [addrRow, ipRow]),
      UI.card(t('Found nearby'), [discRow, foundList, ...bleRows], { actions: [refresh] }),
      hero,
      adbCard,
      pair.el,
      UI.card(t('Paired'), [pairedList]),
      ...(webCard ? [webCard.el] : []),
    );

    let last = null;
    let foundKey = '';
    let pairedKey = '';
    const render = () => last && update(last);
    const update = (s) => {
      if (webCard) webCard.render(s);
      last = s;
      bleSw.set(!s.net || s.net.ble !== false);
      blePcSw.set(!!s.net && s.net.blePc === true);
      const l = s.link;
      const connected = l.state === 'connected';
      pcName.textContent = s.device.name;
      const p = UI.peer(s);
      macName.textContent = s.peer ? s.peer.name : t('The other computer');
      peerDev.className = 'device ' + UI.osClass(p.os);
      if (UI.phoneWall && p.phone) peerDev.style.setProperty('--phone-wall', UI.phoneWall);
      else peerDev.style.removeProperty('--phone-wall');
      linkLine.className = 'hero-link' + (connected ? ' up' : '');
      const ble = s.net && s.net.transport === 'ble';
      linkText.textContent = connected ? (l.rtt != null ? l.rtt + ' ms · ' : '') + UI.via(s)
        : s.pairing ? t('Pairing…') : s.paired ? t('Connecting…') : t('Not connected');
      const bad = l.state === 'identity_changed';
      status.textContent = bad ? t('This {kind} looks different now. Forget it and pair again.', { kind: t(p.kind) })
        : connected ? UI.fill(t(s.kvmState.message || '') || WHERE[s.input] || t('Connected'))
          : s.peer ? t('Open TwinDesk on {name}.', { name: s.peer.name })
            : t('Pick a computer below, or connect by address.');
      status.classList.toggle('bad', bad);
      // Disconnected here or by the other side, taken over, or in use by another device.
      const stopped = l.state === 'stopped';
      const busyBy = !connected && !stopped && l.busy;
      if (s.paired && !connected && (stopped || busyBy)) {
        status.textContent = stopped ? t(l.message || 'Disconnected').replace(/\{Name\}/g, () => s.paired.macName) + '.' : t(busyBy) + '.';
      }
      discBtn.hidden = !connected;
      againBtn.hidden = connected || !s.paired || !(stopped || busyBy);
      againBtn.textContent = busyBy || (stopped && l.message) ? t('Take over') : t('Connect');
      sessionBtns.hidden = discBtn.hidden && againBtn.hidden;
      // Moving the session to Wi-Fi (files, screens through Bluetooth: netlink.js)
      const n = s.net || {};
      const moving = { hotspot: t('Switch on {name}’s hotspot, then type its name and password here.', { name: p.name }), asking: t('Asking {name} for Wi-Fi…', { name: p.name }), hosting: t('Starting Wi-Fi for {name}…', { name: p.name }), joining: t('Joining {ssid}…', { ssid: n.ssid || 'Wi-Fi' }), joined: t('On Wi-Fi with {name}', { name: p.name }) }[n.state];
      if (connected && !bad && (moving || n.state === 'failed')) {
        status.textContent = n.state === 'failed' ? t(n.error || 'Wi-Fi didn’t come up') : moving;
        status.classList.toggle('bad', n.state === 'failed');
      }
      netCancel.hidden = !(connected && ['asking', 'hosting', 'joining', 'hotspot'].includes(n.state));
      hsForm.hidden = !(connected && n.state === 'hotspot');
      if (!hsForm.hidden && !hsShown) { // filled in once, not while typing
        hsSsid.value = n.hotspotSsid || '';
        hsPass.value = '';
        hsPass.placeholder = n.hotspotSaved ? t('Password (saved)') : t('Password');
        setTimeout(() => (n.hotspotSsid ? hsPass : hsSsid).focus(), 0);
      }
      hsShown = !hsForm.hidden;
      wifiOn = (n.why || []).includes('user') || !!n.linked; // made for the screen or files too
      wifiBtn.textContent = wifiOn ? t('Back to Bluetooth') : t('Connect with Wi-Fi Direct');
      wifiBtn.hidden = !connected || !netCancel.hidden || !(wifiOn || ble);
      hotspotBtn.hidden = !connected || !netCancel.hidden || wifiOn || !ble || !UI.isPhone(s);

      for (const r of m2p.concat(p2m)) r.update(s);

      // the phone's wireless debugging: only while it needs something
      const ph = s.phone || {};
      const br = (ph.connected && ph.bridge) || { state: 'off' };
      const pairable = br.state === 'needsPair' || !!br.canPair;
      adbCard.hidden = !ph.connected || !(pairable || ['waitingWifi', 'missing', 'error'].includes(br.state));
      if (!adbCard.hidden) {
        const [cls, label] = ADB[br.state] || ADB.error;
        adbPill.className = `pill ${cls}`;
        adbPill.textContent = label;
        adbRow.setHint(t(br.message || ''));
        adbPairRow.hidden = !pairable;
        if (UI.adbBle(s, adbCard, adbRow, adbPill)) adbPairRow.hidden = true;
      }

      // A phone that is only just connecting is not a problem yet: 'connecting' counts after 8 s.
      const now = Date.now();
      for (const p of ph.phones || []) {
        if (p.state === 'ready' || p.state === 'off') notReadySince.delete(p.id);
        else if (!notReadySince.has(p.id)) notReadySince.set(p.id, now);
      }
      const broken = (ph.phones || []).filter((p) => p.state && p.state !== 'ready' && p.state !== 'off'
        && (p.state !== 'connecting' || now - (notReadySince.get(p.id) || now) > 8000));
      fixCard.hidden = !broken.length;
      const key = JSON.stringify(broken.map((p) => [p.id, p.state, p.message]));
      if (key !== fixKey) {
        fixKey = key;
        fixList.replaceChildren(...broken.map((p) => {
          const [cls, label] = ADB[p.state] || ADB.error;
          const pill = el('span', { class: `pill ${cls}`, text: label });
          const fix = UI.button(t('Fix'), () => Promise.resolve(api.setActivePeer(p.id)).then(() => api.phoneRetry(p.id)), 'small primary');
          return UI.row(p.name || t('Phone'), t(p.message || '') || FIX_HINT[p.state] || '', [pill, fix], { literal: true });
        }));
      }

      // this computer
      addrVal.textContent = s.addresses.length ? s.addresses[0] : t('No network'); // The one the other computer can reach
      copyBtn.hidden = !s.addresses.length;
      const busy = !!s.pairing && s.pairing.phase !== 'failed';
      ipBtn.disabled = busy || !!asking;
      const failed = s.pairing && s.pairing.phase === 'failed';
      ipRow.setHint(asking ? t('Looking for TwinDesk at {address}…', { address: asking }) : failed ? UI.fill(t(s.pairing.error || '')) : '');
      ipRow.hint.classList.toggle('bad', !asking && !!failed);

      // found nearby
      const d = s.discovery || { on: true, error: '' };
      const fwBad = s.firewall && s.firewall.ok === false && !s.firewall.checking;
      const blocked = !d.on || fwBad;
      discRow.hidden = !blocked;
      discRow.setHint(!d.on ? t('{error}. Connect by address still works.', { error: t(d.error || '') }) : t('The firewall blocks it. Connect by address may still work.'));
      // Paired both ways: the computer we connect to (s.paired) and the ones that connect to us (s.guests).
      const known = new Set([...(s.paired ? [s.paired.macId] : []), ...s.guests.map((g) => g.id)]);
      const live = s.peer && connected ? s.peer.id : '';
      const peers = s.peers || [];
      const up = new Set(peers.filter((d) => d.connected).map((d) => d.id)); // every connected device
      const fk = JSON.stringify([s.found, [...known], [...up], busy, blocked]);
      if (fk !== foundKey) {
        foundKey = fk;
        let focus = null;
        const rows = s.found.map((dev) => {
          const isKnown = known.has(dev.id);
          const online = up.has(dev.id);
          // A Mac hosts; with a PC or another Linux computer the one who clicks is the guest (L4).
          // A phone is asked to pair. Another computer can be paired while others are connected.
          const btn = online || isKnown ? null : UI.button(dev.os === 'mac' || dev.os === 'android' ? t('Pair') : t('Connect'), () => api.pair(dev.id), 'small' + (dev.invited ? ' primary' : ''));
          if (btn) btn.disabled = busy;
          // Paired: Take over (the computer we're a guest of: a takeover hello; one that connects to us:
          // invited, and its hello takes the session from whoever has it).
          const take = !online && isKnown ? UI.button(t('Take over'), () => (s.paired && dev.id === s.paired.macId ? api.connectAgain() : api.connectGuest(dev.id)), 'small') : null;
          if (take) take.disabled = busy;
          if (btn && dev.invited && !busy) focus = btn;
          const r = UI.row(dev.name, dev.invited ? t('{address} · wants to connect', { address: dev.address }) : dev.address, [
            online ? el('span', { class: 'pill good', text: t('Connected') }) : isKnown ? el('span', { class: 'pill muted', text: t('Paired') }) : null, btn, take], { literal: true });
          r.querySelector('.text').prepend(UI.osIcon(dev.os));
          r.classList.add('with-ico');
          return r;
        });
        if (!rows.length && !blocked) rows.push(UI.row(t('Looking for computers…'), t('Open TwinDesk on the other computer.')));
        foundList.replaceChildren(...rows);
        if (focus) focus.focus();
      }

      // devices: the connected ones first, the selected one at the top
      const linkedMap = (s.kvm && s.kvm.linkedBy) || {};
      const dk = JSON.stringify([peers, s.mesh && s.mesh.selectedId, linkedMap, s.kvm && s.kvm.linked]);
      if (dk !== devicesKey) {
        devicesKey = dk;
        const sorted = peers.slice().sort((a, b) => (b.selected - a.selected) || (b.connected - a.connected));
        const drows = sorted.map((d) => {
          const hint = d.state === 'via' ? t('Via {names} · not linked to this PC', { names: (d.via || []).join(', ') })
            : d.connected
            ? (Array.isArray(d.direct) && d.direct.length ? t('{status} · linked to {count}', { status: d.rtt != null ? d.rtt + ' ms' : t('Connected'), count: d.direct.length }) : d.rtt != null ? d.rtt + ' ms' : t('Connected'))
            : d.state === 'waiting' ? t('Waiting for it to connect')
              : d.state === 'identity_changed' ? t('Looks different now. Forget it and pair again.')
                : d.state === 'connecting' || d.state === 'reconnecting' ? t('Connecting…') : t('Not connected');
          const pill = d.selected ? el('span', { class: 'pill good', text: t('Selected') }) : d.connected ? el('span', { class: 'pill muted', text: t('Connected') }) : null;
          const use = d.connected && !d.selected ? UI.button(t('Use'), () => api.setActivePeer(d.id), 'small') : null;
          const viaPill = d.state === 'via' ? el('span', { class: 'pill muted', text: t('via {names}', { names: (d.via || []).join(', ') }) }) : null;
          const forget = d.state === 'via' ? null : UI.button(t('Forget'), () => api.forgetPeer(d.id), 'small');
          // Cursor sharing with this device (off when the hotkey was double-tapped while it was selected, or the device said so).
          const on = d.selected ? !!(s.kvm && s.kvm.linked) : linkedMap[d.id] !== false;
          const cursor = d.connected ? UI.switch((v) => api.setLinkedFor(d.id, v), { label: t('Cursor') }) : null;
          if (cursor) cursor.set(on);
          const r = UI.row(d.name || t('Device'), d.connected && !on ? t('{status} · Cursor sharing is off for it', { status: hint }) : hint, [pill || viaPill, cursor, use, forget], { literal: true });
          r.querySelector('.text').prepend(UI.osIcon(d.os));
          r.classList.add('with-ico');
          return r;
        });
        devicesList.replaceChildren(...(drows.length ? drows : [UI.row(t('No devices yet'), t('Pair with a computer in Found nearby.'))]));
      }

      // paired
      const wk = s.wake || { peers: {} };
      const near = new Set(s.found.map((dev) => dev.id));
      const pk = JSON.stringify([s.paired, s.guests, [...up], [...near], Object.keys(wk.peers), wk.waking]);
      if (pk === pairedKey) return;
      pairedKey = pk;
      const all = [
        ...(s.paired ? [{ id: s.paired.macId, name: s.paired.macName, os: s.paired.os, hint: s.paired.address, forget: () => api.forget(), connect: () => api.connectAgain() }] : []),
        ...s.guests.map((g) => ({ id: g.id, name: g.name, os: g.os, hint: g.lastSeen ? t('Last seen {time}', { time: UI.ago(g.lastSeen) }) : '', forget: () => api.forgetGuest(g.id),
          connect: near.has(g.id) ? () => api.connectGuest(g.id) : null })),
      ];
      pairedList.replaceChildren(...(all.length ? all.map((x) => {
        const online = up.has(x.id);
        const waking = !online && wk.waking === x.id;
        // An offline computer that told us how to wake it gets Wake.
        const wakeBtn = !online && wk.peers[x.id] ? UI.button(waking ? t('Waking…') : t('Wake'), () => api.wakePeer(x.id), 'small') : null;
        if (wakeBtn) wakeBtn.disabled = waking;
        const r = UI.row(x.name, online ? t('Connected') : waking ? t('Waking {name}…', { name: x.name }) : x.hint, [
          online ? el('span', { class: 'pill good', text: t('Online') }) : null,
          wakeBtn,
          // Switch to it: whatever the session is now, it ends (paired, and nearby to be reached).
          !online && x.connect ? UI.button(live ? t('Switch') : t('Connect'), x.connect, 'small') : null,
          UI.button(t('Forget'), x.forget, 'small'),
        ], { literal: true });
        r.querySelector('.text').prepend(UI.osIcon(x.os));
        r.classList.add('with-ico');
        return r;
      }) : [UI.row(t('Nothing paired yet'), t('Pair with a computer in Found nearby.'))]));
    };
    return update;
  },
});

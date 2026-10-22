// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Overview tab: this PC's address and Connect by address on top, the
// computers found nearby (always visible), the two computers, one switch per feature and
// direction, and what is paired.
'use strict';

UI.tab({
  id: 'overview',
  order: 0,
  title: 'Overview',
  heading: 'TwinDesk',
  desc: '',
  color: 'linear-gradient(#8e8e93, #636366)',
  badge: (s) => (s.link.state === 'identity_changed' || (s.discovery && !s.discovery.on) || s.found.some((d) => d.invited) ? 'warn' : ''),
  build(body) {
    const { el, api } = UI;
    const WHERE = { driving: 'You’re using {there}', driven: '{There} is using {me}' };

    const linkLine = el('div', { class: 'hero-link' }, [el('span', { class: 'hero-pulse' })]);
    const linkText = el('div', { class: 'hero-link-text' });
    const pcName = el('div', { class: 'hero-name' });
    const macName = el('div', { class: 'hero-name' });
    const status = el('div', { class: 'hero-status' });
    // The session: Disconnect it; Connect again after one (or Take over while another device has it).
    const discBtn = UI.button('Disconnect', () => api.disconnect(), 'small');
    const againBtn = UI.button('Connect', () => api.connectAgain(), 'small primary');
    const sessionBtns = el('div', { class: 'hero-actions' }, [againBtn, discBtn]);
    const netCancel = UI.button('Cancel', () => api.netCancel(), 'small');
    netCancel.hidden = true;
    const netLocation = UI.button('Location settings', () => api.netLocation(), 'small'); // joining needed Windows' Location
    netLocation.hidden = true;
    // A session on Bluetooth: onto a direct Wi-Fi link on request, until Back to Bluetooth.
    let wifiOn = false;
    const wifiBtn = UI.button('Connect with Wi-Fi Direct', () => api.netWifi(!wifiOn), 'small');
    wifiBtn.hidden = true;
    // A phone: its hotspot instead. It switches it on; its name and password here once (saved for it).
    const hotspotBtn = UI.button('Connect with hotspot', () => api.netWifi('hotspot'), 'small');
    hotspotBtn.hidden = true;
    const hsSsid = el('input', { type: 'text', placeholder: 'Hotspot name', autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': 'Hotspot name' } });
    const hsPass = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'off', attrs: { 'aria-label': 'Hotspot password' } });
    const hsJoin = UI.button('Join', () => api.netJoinHotspot({ ssid: hsSsid.value, pass: hsPass.value }), 'small primary');
    hsSsid.onkeydown = hsPass.onkeydown = (e) => { if (e.key === 'Enter') hsJoin.click(); };
    const hsForm = el('div', { class: 'hero-actions' }, [hsSsid, hsPass, hsJoin]);
    hsForm.hidden = true;
    let hsShown = false;
    const peerDev = el('div', { class: 'device mac' });
    const hero = el('div', { class: 'card hero' }, [
      el('div', { class: 'hero-devices' }, [
        el('div', { class: 'hero-device' }, [el('div', { class: 'device pc' }), pcName]),
        el('div', { class: 'hero-mid' }, [linkLine, linkText]),
        el('div', { class: 'hero-device' }, [peerDev, macName]),
      ]),
      status,
      sessionBtns,
      hsForm,
      netCancel,
      netLocation,
      el('div', { class: 'hero-actions' }, [wifiBtn, hotspotBtn]),
    ]);

    // One switch per feature and direction, labels only; the row opens the tab.
    // macOnly: 'linux' = off only with a Linux peer (nothing uses it now: Linux has every row).
    // phone: false = hidden while a phone is the peer.
    const row = (label, tab, get, set, macOnly, { phone = true } = {}) => {
      const sw = UI.switch(set || (() => {}), { label, disabled: !set });
      const r = UI.row(label, '', [sw, el('span', { class: 'chev', text: '›' })], { onClick: () => UI.go(tab) });
      r.update = (s) => {
        const limited = !macOnly || !s.peer ? '' : macOnly === 'linux' ? (s.peer.os === 'linux' ? 'Not on Linux yet' : '') : UI.peer(s).limited;
        sw.set(!limited && get(s));
        sw.disable(!set || !!limited);
        r.setHint(limited);
        r.hidden = !phone && UI.isPhone(s);
      };
      return r;
    };
    const notPhone = { phone: false };
    const m2p = [
      row('Screen', 'mac-pc', (s) => s.stream.state === 'on', null, undefined, notPhone),
      row('Sound', 'audio', (s) => s.audio.receive, (v) => api.setAudio({ receive: v })),
      row('Mouse and keyboard', 'cursor', (s) => s.kvm.beDriven, (v) => api.setKvm({ beDriven: v })),
      row('Clipboard', 'clipboard', (s) => s.clipboard.receive, (v) => api.setClipboard({ receive: v })),
      row('Notifications', 'notifications', (s) => s.notifs.receive, (v) => api.setNotifs({ receive: v })),
      row('Shared folder', 'files', (s) => s.files.mountMac, (v) => api.setFiles({ mountMac: v })),
      row('Terminal', 'terminal', (s) => s.terminal.allowMac, (v) => api.setTerminal({ allowMac: v }), undefined, notPhone),
      row('Apps', 'apps', (s) => s.apps.open > 0, null, undefined, notPhone),
    ];
    const p2m = [
      row('Screen', 'pc-mac', (s) => s.pcScreen.mode !== 'off', (v) => api.setPcScreenMode(v ? 'mirror' : 'off')),
      row('Sound', 'audio', (s) => s.audio.send, (v) => api.setAudio({ send: v })),
      row('Mouse and keyboard', 'cursor', (s) => s.kvm.driveOther, (v) => api.setKvm({ driveOther: v })),
      row('Clipboard', 'clipboard', (s) => s.clipboard.send, (v) => api.setClipboard({ send: v })),
      row('Notifications', 'notifications', (s) => s.notifs.send, (v) => api.setNotifs({ send: v })),
      row('Shared folder', 'files', (s) => s.files.shareOn, (v) => api.setShareOn(v)),
      row('Terminal', 'terminal', (s) => s.terminal.enabled, (v) => api.setTerminal({ enabled: v }), undefined, notPhone),
      row('Apps', 'apps', (s) => s.pcApps.allow, (v) => api.setPcApps({ allow: v }), undefined, notPhone),
    ];
    const pair = UI.dirCards({ rows: m2p }, { rows: p2m });

    // ---- this PC + connect by address (always visible) ----
    const addrVal = el('span', { class: 'value addr' });
    const copyBtn = UI.button('Copy', () => UI.state && api.copyText(UI.state.addresses[0] || ''), 'small');
    const addrRow = UI.row('{me}', '', [addrVal, copyBtn]);
    const ipInput = el('input', { type: 'text', placeholder: '192.168.1.20', autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': 'Address' } });
    let asking = '';
    const ipBtn = UI.button('Connect', async () => {
      const v = ipInput.value.trim();
      if (!v || asking) return;
      asking = v;
      render();
      try { await api.connectAddress(v); } finally { asking = ''; render(); }
    }, 'small primary');
    ipInput.onkeydown = (e) => { if (e.key === 'Enter') ipBtn.click(); };
    const ipRow = UI.row('Connect by address', '', [ipInput, ipBtn]);

    // ---- found nearby (always visible) ----
    const discRow = UI.row('Can’t look for computers on this network.', '', [UI.button('Fix firewall', () => api.fixFirewall(), 'small')]);
    const foundList = el('div');
    // General's two Bluetooth switches, here too: who can turn up through Bluetooth.
    const bleSw = UI.switch((v) => api.setNet({ ble: v }), { label: 'Bluetooth with phones' });
    const blePcSw = UI.switch((v) => api.setNet({ blePc: v }), { label: 'Bluetooth with computers' });
    const bleRows = [UI.row('Bluetooth with phones', '', [bleSw]), UI.row('Bluetooth with computers', '', [blePcSw])];
    const refresh = UI.button('Refresh', () => { // the list empties and fills again with whoever answers
      api.refreshFound();
      refresh.disabled = true;
      refresh.textContent = 'Looking…';
      setTimeout(() => { refresh.disabled = false; refresh.textContent = 'Refresh'; }, 1500);
    }, 'small');

    // ---- a connected phone's wireless debugging, until it works (the Phone page has it too) ----
    const ADB = { needsPair: ['bad', 'Pair once'], waitingWifi: ['bad', 'Off'], connecting: ['muted', 'Looking…'], missing: ['bad', 'Missing'], error: ['bad', 'Problem'] };
    const adbPill = el('span', { class: 'pill bad' });
    const adbRow = UI.row('Wireless debugging', '', [adbPill, UI.button('Try Again', () => api.phoneRetry(), 'small')]);
    const adbCode = el('input', { type: 'text', placeholder: '123456', maxLength: 6, inputMode: 'numeric', autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': 'Pairing code' } });
    const adbWhere = el('input', { type: 'text', placeholder: 'Address:port (optional)', autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': 'Pairing address' } });
    const adbPair = UI.button('Pair', () => api.phonePair({ code: adbCode.value, where: adbWhere.value }), 'small primary');
    adbCode.onkeydown = adbWhere.onkeydown = (e) => { if (e.key === 'Enter') adbPair.click(); };
    const adbPairRow = UI.row('Pairing code', 'Or type it on the phone, in TwinDesk’s notification', [adbCode, adbWhere, adbPair]);
    const adbCard = UI.card('Phone screen, mouse and keyboard', [adbRow, adbPairRow]);

    // Every phone whose screen/mouse/keyboard connection (wireless debugging or cable) is not working yet, each with
    // a Fix button: it makes that phone the selected one (its pairing fields show below) and tries again.
    const FIX_HINT = {
      waitingWifi: 'Turn on Developer options › Wireless debugging on the phone (same Wi-Fi), then tap Fix.',
      needsPair: 'Pair once: Wireless debugging › Pair device with pairing code on the phone, then type the code in the Pairing code row below.',
      missing: 'adb is missing from this build.',
      connecting: 'Looking for the phone’s wireless debugging… If this stays, tap Fix.',
      error: 'The connection stopped. Tap Fix to try again.',
    };
    const fixList = el('div');
    const fixCard = UI.card('Phones that need fixing', [fixList]);
    let fixKey = '';
    const notReadySince = new Map();
    setInterval(() => { if (last) update(last); }, 4000); // 'connecting' for 8 s turns into a problem without another state push

    // ---- devices (docs/mesh.md): every paired device; the selected one is what the features below use ----
    const devicesList = el('div');
    let devicesKey = '';

    const pairedList = el('div');
    body.append(
      UI.card('', [addrRow, ipRow]),
      UI.card('Found nearby', [discRow, foundList, ...bleRows], { actions: [refresh] }),
      hero,
      adbCard,
      pair.el,
      UI.card('Paired', [pairedList]),
    );

    let last = null;
    let foundKey = '';
    let pairedKey = '';
    const render = () => last && update(last);
    const update = (s) => {
      last = s;
      bleSw.set(!s.net || s.net.ble !== false);
      blePcSw.set(!!s.net && s.net.blePc === true);
      const l = s.link;
      const connected = l.state === 'connected';
      pcName.textContent = s.device.name;
      const p = UI.peer(s);
      macName.textContent = s.peer ? s.peer.name : 'The other computer';
      peerDev.className = 'device ' + UI.osClass(p.os);
      if (UI.phoneWall && p.phone) peerDev.style.setProperty('--phone-wall', UI.phoneWall);
      else peerDev.style.removeProperty('--phone-wall');
      linkLine.className = 'hero-link' + (connected ? ' up' : '');
      const ble = s.net && s.net.transport === 'ble';
      linkText.textContent = connected ? (l.rtt != null ? l.rtt + ' ms · ' : '') + UI.via(s)
        : s.pairing ? 'Pairing…' : s.paired ? 'Connecting…' : 'Not connected';
      const bad = l.state === 'identity_changed';
      status.textContent = bad ? 'This ' + p.kind + ' looks different now. Forget it and pair again.'
        : connected ? s.kvmState.message || (WHERE[s.input] || 'Connected').replace('{there}', p.the).replace('{There}', p.the.charAt(0).toUpperCase() + p.the.slice(1))
          : s.peer ? 'Open TwinDesk on ' + s.peer.name + '.'
            : 'Pick a computer below, or connect by address.';
      status.classList.toggle('bad', bad);
      // Disconnected here or by the other side, taken over, or in use by another device.
      const stopped = l.state === 'stopped';
      const busyBy = !connected && !stopped && l.busy;
      if (s.paired && !connected && (stopped || busyBy)) {
        status.textContent = stopped ? (l.message || 'Disconnected').replace(/\{Name\}/g, s.paired.macName) + '.' : busyBy + '.';
      }
      discBtn.hidden = !connected;
      againBtn.hidden = connected || !s.paired || !(stopped || busyBy);
      againBtn.textContent = busyBy || (stopped && l.message) ? 'Take over' : 'Connect';
      sessionBtns.hidden = discBtn.hidden && againBtn.hidden;
      // Moving the session to Wi-Fi (files, screens through Bluetooth: netlink.js)
      const n = s.net || {};
      const moving = { hotspot: 'Switch on {name}’s hotspot, then type its name and password here.', asking: 'Asking {name} for Wi-Fi…', hosting: 'Starting Wi-Fi Direct for {name}…', joining: 'Joining ' + (n.ssid || 'Wi-Fi') + '…', joined: 'On Wi-Fi with {name}' }[n.state];
      if (connected && !bad && (moving || n.state === 'failed')) {
        status.textContent = n.state === 'failed' ? n.error || 'Wi-Fi didn’t come up' : moving;
        status.classList.toggle('bad', n.state === 'failed');
      }
      netCancel.hidden = !(connected && ['asking', 'hosting', 'joining', 'hotspot'].includes(n.state));
      hsForm.hidden = !(connected && n.state === 'hotspot');
      if (!hsForm.hidden && !hsShown) { // filled in once, not while typing
        hsSsid.value = n.hotspotSsid || '';
        hsPass.value = '';
        hsPass.placeholder = n.hotspotSaved ? 'Password (saved)' : 'Password';
        setTimeout(() => (n.hotspotSsid ? hsPass : hsSsid).focus(), 0);
      }
      hsShown = !hsForm.hidden;
      netLocation.hidden = !(connected && n.state === 'failed' && n.location);
      wifiOn = (n.why || []).includes('user') || !!n.linked; // made for the screen or files too
      wifiBtn.textContent = wifiOn ? 'Back to Bluetooth' : 'Connect with Wi-Fi Direct';
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
        adbRow.setHint(br.message || '');
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
          const fix = UI.button('Fix', () => Promise.resolve(api.setActivePeer(p.id)).then(() => api.phoneRetry(p.id)), 'small primary');
          return UI.row(p.name || 'Phone', p.message || FIX_HINT[p.state] || '', [pill, fix]);
        }));
      }

      // this PC
      addrVal.textContent = s.addresses.length ? s.addresses[0] : 'No network'; // The one the other computer can reach
      copyBtn.hidden = !s.addresses.length;
      const busy = !!s.pairing && s.pairing.phase !== 'failed';
      ipBtn.disabled = busy || !!asking;
      const failed = s.pairing && s.pairing.phase === 'failed';
      ipRow.setHint(asking ? 'Looking for TwinDesk at ' + asking + '…' : failed ? s.pairing.error : '');
      ipRow.hint.classList.toggle('bad', !asking && !!failed);

      // found nearby
      const d = s.discovery || { on: true, error: '' };
      const fwBad = s.firewall && s.firewall.ok === false && !s.firewall.checking;
      const blocked = !d.on || fwBad;
      discRow.hidden = !blocked;
      discRow.setHint(!d.on ? d.error + '. Connect by address still works.' : 'The firewall blocks it. Connect by address may still work.');
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
          // A Mac hosts; with a PC or Linux the one who clicks is the guest. A phone is asked to pair.
          // Another computer can be paired while others are connected.
          const btn = online || isKnown ? null : UI.button(dev.os === 'mac' || dev.os === 'android' ? 'Pair' : 'Connect', () => api.pair(dev.id), 'small' + (dev.invited ? ' primary' : ''));
          if (btn) btn.disabled = busy;
          // Paired: Take over (the computer we're a guest of: a takeover hello; one that connects to us:
          // invited, and its hello takes the session from whoever has it).
          const take = !online && isKnown ? UI.button('Take over', () => (s.paired && dev.id === s.paired.macId ? api.connectAgain() : api.connectGuest(dev.id)), 'small') : null;
          if (take) take.disabled = busy;
          if (btn && dev.invited && !busy) focus = btn;
          const r = UI.row(dev.name, dev.address + (dev.invited ? ' · wants to connect' : ''), [
            online ? el('span', { class: 'pill good', text: 'Connected' }) : isKnown ? el('span', { class: 'pill muted', text: 'Paired' }) : null, btn, take]);
          r.querySelector('.text').prepend(UI.osIcon(dev.os));
          r.classList.add('with-ico');
          return r;
        });
        if (!rows.length && !blocked) rows.push(UI.row('Looking for computers…', 'Open TwinDesk on the other computer.'));
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
          const hint = d.state === 'via' ? 'Via ' + (d.via || []).join(', ') + ' · not linked to this PC'
            : d.connected
            ? (d.rtt != null ? d.rtt + ' ms' : 'Connected') + (Array.isArray(d.direct) && d.direct.length ? ' · linked to ' + d.direct.length : '')
            : d.state === 'waiting' ? 'Waiting for it to connect'
              : d.state === 'identity_changed' ? 'Looks different now. Forget it and pair again.'
                : d.state === 'connecting' || d.state === 'reconnecting' ? 'Connecting…' : 'Not connected';
          const pill = d.selected ? el('span', { class: 'pill good', text: 'Selected' }) : d.connected ? el('span', { class: 'pill muted', text: 'Connected' }) : null;
          const use = d.connected && !d.selected ? UI.button('Use', () => api.setActivePeer(d.id), 'small') : null;
          const viaPill = d.state === 'via' ? el('span', { class: 'pill muted', text: 'via ' + (d.via || []).join(', ') }) : null;
          const forget = d.state === 'via' ? null : UI.button('Forget', () => api.forgetPeer(d.id), 'small');
          // Cursor sharing with this device (off when the hotkey was double-tapped while it was selected, or the device said so).
          const on = d.selected ? !!(s.kvm && s.kvm.linked) : linkedMap[d.id] !== false;
          const cursor = d.connected ? UI.switch((v) => api.setLinkedFor(d.id, v), { label: 'Cursor' }) : null;
          if (cursor) cursor.set(on);
          const r = UI.row(d.name || 'Device', hint + (d.connected && !on ? ' · Cursor sharing is off for it' : ''), [pill || viaPill, cursor, use, forget]);
          r.querySelector('.text').prepend(UI.osIcon(d.os));
          r.classList.add('with-ico');
          return r;
        });
        devicesList.replaceChildren(...(drows.length ? drows : [UI.row('No devices yet', 'Pair with a computer in Found nearby.')]));
      }

      // paired
      const wk = s.wake || { peers: {} };
      const near = new Set(s.found.map((dev) => dev.id));
      const pk = JSON.stringify([s.paired, s.guests, [...up], [...near], Object.keys(wk.peers), wk.waking]);
      if (pk === pairedKey) return;
      pairedKey = pk;
      const all = [
        ...(s.paired ? [{ id: s.paired.macId, name: s.paired.macName, os: s.paired.os, hint: s.paired.address, forget: () => api.forget(), connect: () => api.connectAgain() }] : []),
        ...s.guests.map((g) => ({ id: g.id, name: g.name, os: g.os, hint: g.lastSeen ? 'Last seen ' + UI.ago(g.lastSeen) : '', forget: () => api.forgetGuest(g.id),
          connect: near.has(g.id) ? () => api.connectGuest(g.id) : null })),
      ];
      pairedList.replaceChildren(...(all.length ? all.map((x) => {
        const online = up.has(x.id);
        const waking = !online && wk.waking === x.id;
        // An offline computer that told us how to wake it gets Wake.
        const wakeBtn = !online && wk.peers[x.id] ? UI.button(waking ? 'Waking…' : 'Wake', () => api.wakePeer(x.id), 'small') : null;
        if (wakeBtn) wakeBtn.disabled = waking;
        const r = UI.row(x.name, online ? 'Connected' : waking ? 'Waking ' + x.name + '…' : x.hint, [
          online ? el('span', { class: 'pill good', text: 'Online' }) : null,
          wakeBtn,
          // Switch to it: whatever the session is now, it ends (paired, and nearby to be reached).
          !online && x.connect ? UI.button(live ? 'Switch' : 'Connect', x.connect, 'small') : null,
          UI.button('Forget', x.forget, 'small'),
        ]);
        r.querySelector('.text').prepend(UI.osIcon(x.os));
        r.classList.add('with-ico');
        return r;
      }) : [UI.row('Nothing paired yet', 'Pair with a computer in Found nearby.')]));
    };
    return update;
  },
});

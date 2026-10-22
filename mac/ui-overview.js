// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Overview tab: this Mac's address and Connect by address on top, the
// computers nearby (always visible), the two computers, one switch per feature and direction,
// and everything paired.
'use strict';

UI.tab({
  id: 'overview',
  order: 0,
  title: 'Overview',
  heading: 'TwinDesk',
  desc: '',
  color: 'linear-gradient(#8e8e93, #636366)',
  badge: (s) => (s.discovery && (!s.discovery.on || !s.discovery.localNetwork) ? '!' : ''),
  build(body) {
    const { el, api } = UI;

    // ---- this Mac + connect by address ----
    const addrVal = el('span', { class: 'value addr' });
    const copyBtn = UI.button('Copy', () => UI.state && api.copyText(UI.state.addresses[0] || ''), 'small');
    const addrRow = UI.row('{me}', 'Its address', [addrVal, copyBtn]);
    const ipInput = el('input', { type: 'text', placeholder: '192.168.1.20', autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': 'Address' } });
    const ipBtn = UI.button('Connect', () => api.connectAddress(ipInput.value), 'small primary');
    ipInput.onkeydown = (e) => { if (e.key === 'Enter') ipBtn.click(); };
    const ipRow = UI.row('Connect by address', '', [ipInput, ipBtn]);

    // ---- nearby ----
    const discRow = UI.row('', '', []);
    const discFix = UI.button('Allow', () => api.allowPermission('localNetwork'), 'small');
    discRow.querySelector('.controls').append(discFix);
    const foundList = el('div');
    // General's two Bluetooth switches, here too: who can turn up through Bluetooth.
    const bleSw = UI.switch((v) => api.setNet({ ble: v }), { label: 'Bluetooth with phones' });
    const blePcSw = UI.switch((v) => api.setNet({ blePc: v }), { label: 'Bluetooth with computers' });
    const bleRows = [UI.row('Bluetooth with phones', '', [bleSw]), UI.row('Bluetooth with computers', '', [blePcSw])];
    const refresh = UI.button('Refresh', () => { // the list empties and fills again with whoever answers
      api.refreshDiscovery();
      refresh.disabled = true;
      refresh.textContent = 'Looking…';
      setTimeout(() => { refresh.disabled = false; refresh.textContent = 'Refresh'; }, 1500);
    }, 'small');

    // ---- hero ----
    const WHERE = { driving: 'You’re using {name}', driven: '{name} is using {me}' };
    const linkLine = el('div', { class: 'hero-link' }, [el('span', { class: 'hero-pulse' })]);
    const linkText = el('div', { class: 'hero-link-text' });
    const peerName = el('div', { class: 'hero-name' });
    const macName = el('div', { class: 'hero-name' });
    const peerDev = el('div', { class: 'device pc' });
    const status = el('div', { class: 'hero-status' });
    // The session: Disconnect it (a phone or a computer); Connect again to the Mac we're a guest of
    // after one, or Take over while another device has it.
    const discBtn = UI.button('Disconnect', () => api.disconnect(), 'small');
    const againBtn = UI.button('Connect', () => api.connectAgain(), 'small primary');
    const sessionBtns = el('div', { class: 'hero-actions' }, [againBtn, discBtn]);
    // A session on Bluetooth: onto a direct Wi-Fi link on request, until Back to Bluetooth.
    const wifiBtn = UI.button('Connect with Wi-Fi Direct', () => api.netWifi(!wifiOn), 'small');
    let wifiOn = false;
    wifiBtn.hidden = true;
    const hotspotBtn = UI.button('Connect with hotspot', () => api.netWifi('hotspot'), 'small'); // a phone's, this Mac joins
    hotspotBtn.hidden = true;
    const hero = el('div', { class: 'card hero' }, [
      el('div', { class: 'hero-devices' }, [
        el('div', { class: 'hero-device' }, [el('div', { class: 'device mac' }), macName]),
        el('div', { class: 'hero-mid' }, [linkLine, linkText]),
        el('div', { class: 'hero-device' }, [peerDev, peerName]),
      ]),
      status,
      sessionBtns,
      el('div', { class: 'hero-actions' }, [wifiBtn, hotspotBtn]),
    ]);

    // ---- feature switches ----
    const sw = (label, tab, get, set, { phone = true } = {}) => {
      const c = UI.switch(set, { label });
      const row = UI.row(label, '', [c, el('span', { class: 'chev', text: '›' })], { onClick: () => UI.go(tab) });
      return { c, row, get, phone }; // phone: false = hidden while a phone is the peer
    };
    const notPhone = { phone: false };
    const m2w = [
      sw('Screen', 'share', (s) => s.sharing && s.sharing.on, (v) => api.setSharing(v)),
      sw('Sound', 'audio', (s) => s.audio && s.audio.send, (v) => api.setAudio({ send: v })),
      sw('Mouse and keyboard', 'cursor', (s) => s.kvm && s.kvm.driveOther, (v) => api.setKvm({ driveOther: v })),
      sw('Clipboard', 'clipboard', (s) => s.clipboard && s.clipboard.send, (v) => api.setClipboard({ send: v })),
      sw('Notifications', 'notifications', (s) => s.notifs && s.notifs.send, (v) => api.setNotifs({ send: v })),
      sw('Shared folder', 'files', (s) => s.smb && s.smb.sharing, (v) => api.setShareMac(v)),
      sw('Terminal', 'terminal', (s) => s.terminal && s.terminal.connectPc, (v) => api.setTerminal({ connectPc: v }), notPhone),
      sw('Apps', 'apps', (s) => s.apps && s.apps.offer, (v) => api.setApps({ offer: v }), notPhone),
    ];
    const w2m = [
      sw('Screen', 'receive', (s) => s.receive && s.receive.open, (v) => (v ? api.showPcView() : api.closePcView()), notPhone),
      sw('Sound', 'audio', (s) => s.audio && s.audio.receive, (v) => api.setAudio({ receive: v })),
      sw('Mouse and keyboard', 'cursor', (s) => s.kvm && s.kvm.beDriven, (v) => api.setKvm({ beDriven: v })),
      sw('Clipboard', 'clipboard', (s) => s.clipboard && s.clipboard.receive, (v) => api.setClipboard({ receive: v })),
      sw('Notifications', 'notifications', (s) => s.notifs && s.notifs.receive, (v) => api.setNotifs({ receive: v })),
      sw('Shared folder', 'files', (s) => s.smb && s.smb.connectPc, (v) => api.setSmb({ connectPc: v })),
      sw('Terminal', 'terminal', (s) => s.terminal && s.terminal.allowPc, (v) => api.setTerminal({ allowPc: v }), notPhone),
      sw('Apps', 'apps', (s) => s.papps && s.papps.on, (v) => api.setPcApps({ on: v }), notPhone),
    ];
    const quick = [...m2w, ...w2m];

    // ---- permissions missing after Setup (it shows only once): a row here, the switches in General ----
    const PERMS = [['screen', 'Screen Recording', (p) => p.screen !== 'granted'], ['accessibility', 'Accessibility', (p) => !p.accessibility], ['inputMonitoring', 'Input Monitoring', (p) => p.inputMonitoring === false]];
    const permRow = UI.row('', '', [UI.button('Open General', () => UI.go('general'), 'small primary')]);
    const permCard = UI.card('', [permRow]);

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
    const pairedList = el('div');
    // Devices: every computer and phone of the mesh. Use makes it the one the features talk to.
    const devicesList = el('div');

    body.append(
      permCard,
      UI.card('', [addrRow, ipRow]),
      UI.card('Nearby', [discRow, foundList, ...bleRows], { actions: [refresh] }),
      hero,
      adbCard,
      UI.pair(UI.dir('m2w', m2w.map((x) => x.row)), UI.dir('w2m', w2m.map((x) => x.row))),
      UI.card('Devices', [devicesList]),
      UI.card('Paired', [pairedList]),
    );

    let foundKey = '';
    let pairedKey = '';
    let devicesKey = '';
    return (s) => {
      const p = UI.names(s);
      bleSw.set(!s.net || s.net.ble !== false);
      blePcSw.set(!!s.net && s.net.blePc === true);
      const c = s.client;
      const g = s.guest || { status: {}, hosts: [] };

      // devices of the mesh
      const devKey = JSON.stringify(s.peers || []);
      if (devKey !== devicesKey) {
        devicesKey = devKey;
        const devs = s.peers || [];
        devicesList.replaceChildren(...(devs.length
          ? devs.map((dv) => {
            const direct = Array.isArray(dv.direct) ? dv.direct.length : 0;
            const state = dv.state === 'via' ? `via ${(dv.via || []).join(', ') || 'another device'}` : dv.connected ? (dv.rtt != null ? `${dv.rtt} ms` : 'Connected')
              : dv.state === 'waiting' ? 'Waiting for it to connect' : dv.state === 'connecting' || dv.state === 'reconnecting' ? 'Connecting…' : 'Not connected';
            const hint = [state, dv.connected && direct ? `${direct} direct link${direct === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
            const r = UI.row(dv.name || 'Device', hint, [
              dv.selected ? el('span', { class: 'pill good', text: 'In use' }) : null,
              dv.connected && !dv.selected ? UI.button('Use', () => api.selectPeer(dv.id), 'small') : null,
              dv.state === 'via' ? el('span', { class: 'pill muted', text: `via ${(dv.via || [])[0] || 'device'}` }) : UI.button('Forget', () => api.forgetPeer(dv.id), 'small'),
            ]);
            r.querySelector('.text').prepend(UI.osIcon(dv.os));
            r.classList.add('with-ico');
            return r;
          })
          : [UI.row('No devices yet', 'Pair with a computer in Nearby.')]));
      }

      // this Mac
      addrVal.textContent = s.addresses.length ? s.addresses[0] : 'No network';
      copyBtn.hidden = !s.addresses.length;
      const cn = s.connect || {};
      const gp = g.pairing;
      ipBtn.disabled = !!cn.busy || !!(gp && gp.phase !== 'failed');
      ipRow.setHint(gp && gp.phase === 'failed' ? gp.error : cn.message);
      ipRow.hint.classList.toggle('bad', !!(cn.error || (gp && gp.phase === 'failed')));

      // permissions
      const lost = s.permissions && s.ui && s.ui.setupDone ? PERMS.filter(([, , miss]) => miss(s.permissions)).map(([, label]) => label) : [];
      permCard.hidden = !lost.length;
      permRow.label.textContent = `${lost.join(', ')} ${lost.length > 1 ? 'aren’t' : 'isn’t'} allowed`;
      permRow.setHint('TwinDesk needs it to share this Mac with the other computer. After an update, allow it again.');

      // nearby
      const d = s.discovery || { on: true, localNetwork: true };
      const blocked = !d.on || !d.localNetwork;
      discRow.hidden = !blocked;
      discRow.label.textContent = 'Can’t look for computers on this network.';
      discRow.setHint(!d.localNetwork ? 'Allow Local Network for TwinDesk, or connect by address.' : d.error);
      discFix.hidden = d.localNetwork;
      const pairedIds = new Set([...s.paired.map((x) => x.id), ...g.hosts.map((x) => x.id)]);
      const fk = JSON.stringify([s.found, [...pairedIds], c && c.id, blocked]);
      if (fk !== foundKey) {
        foundKey = fk;
        const rows = s.found.map((dev) => {
          const online = c && c.id === dev.id;
          const known = pairedIds.has(dev.id);
          const label = online ? null : known ? 'Take over' : dev.os === 'mac' ? 'Pair' : 'Connect';
          const btn = label && UI.button(label, () => api.pairWith(dev.id), `small${dev.invited ? ' primary' : ''}`);
          const r = UI.row(dev.name, `${dev.address}${dev.invited ? ' · wants to connect' : ''}`,
            [online ? el('span', { class: 'pill good', text: 'Connected' }) : known ? el('span', { class: 'pill muted', text: 'Paired' }) : null, btn]);
          r.querySelector('.text').prepend(UI.osIcon(dev.os));
          r.classList.add('with-ico');
          return r;
        });
        if (!rows.length && !blocked) rows.push(UI.row('Looking for computers…', 'Open TwinDesk on the other computer.'));
        foundList.replaceChildren(...rows);
      }

      // hero
      macName.textContent = s.macName;
      peerName.textContent = c ? c.name : p.Name;
      peerDev.className = `device ${UI.osClass(p.os)}`;
      if (UI.phoneWall && p.phone) peerDev.style.setProperty('--phone-wall', UI.phoneWall);
      else peerDev.style.removeProperty('--phone-wall');
      linkLine.className = `hero-link ${c ? 'up' : ''}`;
      const connecting = ['connecting', 'reconnecting'].includes(g.status.state);
      linkText.textContent = c ? `${c.rttMs != null ? `${c.rttMs} ms · ` : ''}${UI.via(s)}`
        : s.pairing || gp ? 'Pairing…' : connecting ? 'Connecting…' : 'Not connected';
      const inp = s.input || { where: 'home' };
      const bad = s.serverError || (g.status.state === 'identity_changed' && g.status.message);
      status.textContent = bad
        || (c ? UI.fill(WHERE[inp.where] || 'Connected')
          : pairedIds.size ? 'Open TwinDesk on the other computer to connect.'
            : 'Pick a computer above, or connect by address.');
      // Disconnected (here or by the other side), taken over, or the Mac we connect to is in use.
      const gStopped = !c && g.hosts.length && g.status.state === 'stopped';
      const gBusy = !c && g.hosts.length && !gStopped && g.status.busy;
      if (!bad && (gStopped || gBusy)) status.textContent = `${gStopped ? g.status.message || 'Disconnected' : gBusy}.`;
      discBtn.hidden = !c;
      againBtn.hidden = !(gStopped || gBusy);
      againBtn.textContent = gBusy || (gStopped && g.status.message) ? 'Take over' : 'Connect';
      sessionBtns.hidden = discBtn.hidden && againBtn.hidden;
      status.classList.toggle('bad', !!bad);
      const n = s.net || {};
      wifiOn = (n.why || []).includes('user') || !!n.linked; // made for the screen or files too
      wifiBtn.textContent = wifiOn ? 'Back to Bluetooth' : 'Connect with Wi-Fi Direct';
      wifiBtn.hidden = !c || !(wifiOn || c.transport === 'ble');
      hotspotBtn.hidden = !c || wifiOn || n.state === 'hotspot' || c.transport !== 'ble' || !UI.isPhone(s);

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

      for (const x of quick) {
        x.c.set(x.get(s));
        x.row.hidden = !!(x.phone === false && p.phone);
      }

      // paired: guests (they connect to us) and hosts (we connect to them)
      const wk = (s.wake && s.wake.peers) || {};
      const near = new Set(s.found.map((dev) => dev.id));
      const pk = JSON.stringify([s.paired, g.hosts, c && c.id, Object.keys(wk), s.wake && s.wake.last, [...near]]);
      if (pk === pairedKey) return;
      pairedKey = pk;
      const all = [...s.paired, ...g.hosts.map((h) => ({ ...h, host: true }))];
      pairedList.replaceChildren(...(all.length
        ? all.map((x) => {
          const online = c && c.id === x.id;
          const r = UI.row(x.name, online ? 'Connected' : `Last seen ${UI.ago(x.lastSeen)}`,
            [online ? el('span', { class: 'pill good', text: 'Online' }) : null,
              // Wake it over the network (it told us how while connected).
              !online && wk[x.id] ? UI.button(s.wake.last && s.wake.last.id === x.id && Date.now() - s.wake.last.at < 20000 ? 'Waking…' : 'Wake', () => api.wakePeer(x.id), 'small') : null,
              // Switch to it (nearby): whatever the session is now, it ends.
              !online && near.has(x.id) ? UI.button(c ? 'Switch' : 'Connect', () => api.pairWith(x.id), 'small') : null,
              UI.button('Forget', () => api.forget(x.id), 'small')]);
          r.querySelector('.text').prepend(UI.osIcon(x.os));
          r.classList.add('with-ico');
          return r;
        })
        : [UI.row('Nothing paired yet', 'Pair with a computer in Nearby.')]));
    };
  },
});

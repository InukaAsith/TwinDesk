// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Overview tab: this Mac's address and Connect by address on top, the
// computers nearby (always visible), the two computers, one switch per feature and direction,
// and everything paired.
'use strict';

UI.tab({
  id: 'connection', // was Overview: the device's own Overview is shared/ui-device.js
  order: 1,
  title: window.I18n.t('Connection'),
  heading: window.I18n.t('Connection'),
  icon: 'link',
  desc: '',
  color: 'linear-gradient(#5ac8fa, #007aff)',
  badge: (s) => (s.discovery && (!s.discovery.on || !s.discovery.localNetwork) ? '!' : ''),
  build(body) {
    const { el, api } = UI;
    const tr = window.I18n.t;
    const bridgeMessage = UI.adbMessage;

    // ---- this Mac + connect by address ----
    const addrVal = el('span', { class: 'value addr', attrs: { 'data-literal': '' } });
    const copyBtn = UI.button(tr('Copy'), () => UI.state && api.copyText(UI.state.addresses[0] || ''), 'small');
    const addrRow = UI.row('{me}', tr('Its address'), [addrVal, copyBtn]);
    const ipInput = el('input', { type: 'text', placeholder: '192.168.1.20', autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': tr('Address') } });
    const ipBtn = UI.button(tr('Connect'), () => api.connectAddress(ipInput.value), 'small primary');
    ipInput.onkeydown = (e) => { if (e.key === 'Enter') ipBtn.click(); };
    const ipRow = UI.row(tr('Connect by address'), '', [ipInput, ipBtn], { literal: true });

    // ---- nearby ----
    const discRow = UI.row('', '', [], { literal: true });
    const discFix = UI.button(tr('Allow'), () => api.allowPermission('localNetwork'), 'small');
    discRow.querySelector('.controls').append(discFix);
    const foundList = el('div');
    // General's two Bluetooth switches, here too: who can turn up through Bluetooth.
    const bleSw = UI.switch((v) => api.setNet({ ble: v }), { label: tr('Bluetooth with phones') });
    const blePcSw = UI.switch((v) => api.setNet({ blePc: v }), { label: tr('Bluetooth with computers') });
    const bleRows = [UI.row(tr('Bluetooth with phones'), '', [bleSw]), UI.row(tr('Bluetooth with computers'), '', [blePcSw])];
    const refresh = UI.button(tr('Refresh'), () => { // the list empties and fills again with whoever answers
      api.refreshDiscovery();
      refresh.disabled = true;
      refresh.textContent = tr('Looking…');
      setTimeout(() => { refresh.disabled = false; refresh.textContent = tr('Refresh'); }, 1500);
    }, 'small');

    // ---- hero ----
    const WHERE = { driving: 'You’re using {name}', driven: '{name} is using {me}' };
    const linkLine = el('div', { class: 'hero-link' }, [el('span', { class: 'hero-pulse' })]);
    const linkText = el('div', { class: 'hero-link-text' });
    const peerName = el('div', { class: 'hero-name', attrs: { 'data-literal': '' } });
    const macName = el('div', { class: 'hero-name', attrs: { 'data-literal': '' } });
    const peerDev = el('div', { class: 'device pc' });
    const status = el('div', { class: 'hero-status', attrs: { 'data-literal': '' } });
    // The session: Disconnect it (a phone or a computer); Connect again to the Mac we're a guest of
    // after one, or Take over while another device has it.
    const discBtn = UI.button(tr('Disconnect'), () => api.disconnect(), 'small');
    const againBtn = UI.button(tr('Connect'), () => api.connectAgain(), 'small primary');
    const sessionBtns = el('div', { class: 'hero-actions' }, [againBtn, discBtn]);
    // A session on Bluetooth: onto a direct Wi-Fi link on request, until Back to Bluetooth.
    const wifiBtn = UI.button(tr('Connect with Wi-Fi Direct'), () => api.netWifi(!wifiOn), 'small');
    let wifiOn = false;
    wifiBtn.hidden = true;
    const hotspotBtn = UI.button(tr('Connect with hotspot'), () => api.netWifi('hotspot'), 'small'); // a phone's, this Mac joins
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
      sw(tr('Screen'), 'share', (s) => s.sharing && s.sharing.on, (v) => api.setSharing(v)),
      sw(tr('Sound'), 'audio', (s) => s.audio && s.audio.send, (v) => api.setAudio({ send: v })),
      sw(tr('Mouse and keyboard'), 'cursor', (s) => s.kvm && s.kvm.driveOther, (v) => api.setKvm({ driveOther: v })),
      sw(tr('Clipboard'), 'clipboard', (s) => s.clipboard && s.clipboard.send, (v) => api.setClipboard({ send: v })),
      sw(tr('Notifications'), 'notifications', (s) => s.notifs && s.notifs.send, (v) => api.setNotifs({ send: v })),
      sw(tr('Shared folder'), 'files', (s) => s.smb && s.smb.sharing, (v) => api.setShareMac(v)),
      sw(tr('Terminal'), 'terminal', (s) => s.terminal && s.terminal.connectPc, (v) => api.setTerminal({ connectPc: v }), notPhone),
      sw(tr('Apps'), 'apps', (s) => s.apps && s.apps.offer, (v) => api.setApps({ offer: v }), notPhone),
    ];
    const w2m = [
      sw(tr('Screen'), 'receive', (s) => s.receive && s.receive.open, (v) => (v ? api.showPcView() : api.closePcView()), notPhone),
      sw(tr('Sound'), 'audio', (s) => s.audio && s.audio.receive, (v) => api.setAudio({ receive: v })),
      sw(tr('Mouse and keyboard'), 'cursor', (s) => s.kvm && s.kvm.beDriven, (v) => api.setKvm({ beDriven: v })),
      sw(tr('Clipboard'), 'clipboard', (s) => s.clipboard && s.clipboard.receive, (v) => api.setClipboard({ receive: v })),
      sw(tr('Notifications'), 'notifications', (s) => s.notifs && s.notifs.receive, (v) => api.setNotifs({ receive: v })),
      sw(tr('Shared folder'), 'files', (s) => s.smb && s.smb.connectPc, (v) => api.setSmb({ connectPc: v })),
      sw(tr('Terminal'), 'terminal', (s) => s.terminal && s.terminal.allowPc, (v) => api.setTerminal({ allowPc: v }), notPhone),
      sw(tr('Apps'), 'apps', (s) => s.papps && s.papps.on, (v) => api.setPcApps({ on: v }), notPhone),
    ];
    const quick = [...m2w, ...w2m];

    // ---- permissions missing after Setup (it shows only once): a row here, the switches in General ----
    const PERMS = [['screen', 'Screen Recording', (p) => p.screen !== 'granted'], ['accessibility', 'mac.accessibility', (p) => !p.accessibility], ['inputMonitoring', 'Input Monitoring', (p) => p.inputMonitoring === false]];
    const permRow = UI.row('', '', [UI.button(tr('Open General'), () => UI.go('general'), 'small primary')], { literal: true });
    const permCard = UI.card('', [permRow]);

    // ---- a connected phone's wireless debugging, until it works (the Phone page has it too) ----
    const ADB = { needsPair: ['bad', 'Pair once'], waitingWifi: ['bad', 'Off'], connecting: ['muted', tr('Looking…')], missing: ['bad', 'Missing'], error: ['bad', 'Problem'] };
    const adbPill = el('span', { class: 'pill bad' });
    const adbRow = UI.row(tr('Wireless debugging'), '', [adbPill, UI.button(tr('Try Again'), () => api.phoneRetry(), 'small')], { literal: true });
    const adbCode = el('input', { type: 'text', placeholder: '123456', maxLength: 6, inputMode: 'numeric', autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': tr('Pairing code') } });
    const adbWhere = el('input', { type: 'text', placeholder: tr('Address:port (optional)'), autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': tr('Pairing address') } });
    const adbPair = UI.button(tr('Pair'), () => api.phonePair({ code: adbCode.value, where: adbWhere.value }), 'small primary');
    adbCode.onkeydown = adbWhere.onkeydown = (e) => { if (e.key === 'Enter') adbPair.click(); };
    const adbPairRow = UI.row(tr('Pairing code'), tr('Or type it on the phone, in TwinDesk’s notification'), [adbCode, adbWhere, adbPair]);
    const adbCard = UI.card(tr('Phone screen, mouse and keyboard'), [adbRow, adbPairRow]);
    const pairedList = el('div');
    const webCard = UI.webConnCard ? UI.webConnCard() : null; // TwinDesk Web's paired devices (shared/ui-web.js)
    // Devices: every computer and phone of the mesh. Use makes it the one the features talk to.
    const devicesList = el('div');

    body.append(
      permCard,
      UI.card('', [addrRow, ipRow]),
      UI.card(tr('Nearby'), [discRow, foundList, ...bleRows], { actions: [refresh] }),
      hero,
      adbCard,
      UI.pair(UI.dir('m2w', m2w.map((x) => x.row)), UI.dir('w2m', w2m.map((x) => x.row))),
      UI.card(tr('Devices'), [devicesList]),
      UI.card(tr('Paired'), [pairedList]),
      ...(webCard ? [webCard.el] : []),
    );

    let foundKey = '';
    let pairedKey = '';
    let devicesKey = '';
    return (s) => {
      if (webCard) webCard.render(s);
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
            const state = dv.state === 'via' ? tr('via {name}', { name: (dv.via || []).join(', ') || tr('another device') }) : dv.connected ? (dv.rtt != null ? `${dv.rtt} ms` : tr('Connected'))
              : dv.state === 'waiting' ? tr('Waiting for it to connect') : dv.state === 'connecting' || dv.state === 'reconnecting' ? tr('Connecting…') : tr('Not connected');
            const hint = [state, dv.connected && direct ? tr(direct === 1 ? '{count} direct link' : '{count} direct links', { count: direct }) : ''].filter(Boolean).join(' · ');
            const r = UI.row(dv.name || tr('Device'), hint, [
              dv.selected ? el('span', { class: 'pill good', text: tr('In use') }) : null,
              dv.connected && !dv.selected ? UI.button(tr('Use'), () => api.selectPeer(dv.id), 'small') : null,
              dv.state === 'via' ? el('span', { class: 'pill muted', text: tr('via {name}', { name: (dv.via || [])[0] || tr('device') }) }) : UI.button(tr('Forget'), () => api.forgetPeer(dv.id), 'small'),
            ], { literal: true });
            r.querySelector('.text').prepend(UI.osIcon(dv.os));
            r.classList.add('with-ico');
            return r;
          })
          : [UI.row(tr('No devices yet'), tr('Pair with a computer in Nearby.'))]));
      }

      // this Mac
      addrVal.textContent = s.addresses.length ? s.addresses[0] : tr('No network');
      copyBtn.hidden = !s.addresses.length;
      const cn = s.connect || {};
      const gp = g.pairing;
      ipBtn.disabled = !!cn.busy || !!(gp && gp.phase !== 'failed');
      const staleHint = c && ((cn.pending && cn.pending.id === c.id) || (cn.inviting && cn.inviting.id === c.id));
      ipRow.setHint(gp && gp.phase === 'failed' ? gp.error : staleHint ? '' : cn.messageKey ? tr(cn.messageKey, cn.messageVars) : cn.error ? cn.message : tr(cn.message || ''));
      ipRow.hint.classList.toggle('bad', !!(cn.error || (gp && gp.phase === 'failed')));

      // permissions
      const lost = s.permissions && s.ui && s.ui.setupDone ? PERMS.filter(([, , miss]) => miss(s.permissions)).map(([, label]) => tr(label)) : [];
      permCard.hidden = !lost.length;
      permRow.label.textContent = tr(lost.length > 1 ? '{permissions} aren’t allowed' : '{permissions} isn’t allowed', { permissions: lost.join(', ') });
      permRow.setHint(tr('TwinDesk needs it to share this Mac with the other computer. After an update, allow it again.'));

      // nearby
      const d = s.discovery || { on: true, localNetwork: true };
      const blocked = !d.on || !d.localNetwork;
      discRow.hidden = !blocked;
      discRow.label.textContent = tr('Can’t look for computers on this network.');
      discRow.setHint(!d.localNetwork ? tr('Allow Local Network for TwinDesk, or connect by address.') : d.error);
      discFix.hidden = d.localNetwork;
      const pairedIds = new Set([...s.paired.map((x) => x.id), ...g.hosts.map((x) => x.id)]);
      const fk = JSON.stringify([s.found, [...pairedIds], c && c.id, blocked]);
      if (fk !== foundKey) {
        foundKey = fk;
        const rows = s.found.map((dev) => {
          const online = c && c.id === dev.id;
          const known = pairedIds.has(dev.id);
          const label = online ? null : known ? tr('Take over') : dev.os === 'mac' ? tr('Pair') : tr('Connect');
          const btn = label && UI.button(tr(label), () => api.pairWith(dev.id), `small${dev.invited ? ' primary' : ''}`);
          const r = UI.row(dev.name, dev.invited ? tr('{address} · wants to connect', { address: dev.address }) : dev.address,
            [online ? el('span', { class: 'pill good', text: tr('Connected') }) : known ? el('span', { class: 'pill muted', text: tr('Paired') }) : null, btn], { literal: true });
          r.querySelector('.text').prepend(UI.osIcon(dev.os));
          r.classList.add('with-ico');
          return r;
        });
        if (!rows.length && !blocked) rows.push(UI.row(tr('Looking for computers…'), tr('Open TwinDesk on the other computer.')));
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
        : s.pairing || gp ? tr('Pairing…') : connecting ? tr('Connecting…') : tr('Not connected');
      const inp = s.input || { where: 'home' };
      const bad = s.serverError || (g.status.state === 'identity_changed' && tr(g.status.message || ''));
      status.textContent = bad
        || (c ? tr(WHERE[inp.where] || 'Connected', p)
          : pairedIds.size ? tr('Open TwinDesk on the other computer to connect.')
            : tr('Pick a computer above, or connect by address.'));
      // Disconnected (here or by the other side), taken over, or the Mac we connect to is in use.
      const gStopped = !c && g.hosts.length && g.status.state === 'stopped';
      const gBusy = !c && g.hosts.length && !gStopped && g.status.busy;
      if (!bad && (gStopped || gBusy)) status.textContent = tr('{status}.', { status: tr(gStopped ? g.status.message || 'Disconnected' : gBusy) });
      discBtn.hidden = !c;
      againBtn.hidden = !(gStopped || gBusy);
      againBtn.textContent = gBusy || (gStopped && g.status.message) ? tr('Take over') : tr('Connect');
      sessionBtns.hidden = discBtn.hidden && againBtn.hidden;
      status.classList.toggle('bad', !!bad);
      const n = s.net || {};
      wifiOn = (n.why || []).includes('user') || !!n.linked; // made for the screen or files too
      wifiBtn.textContent = wifiOn ? tr('Back to Bluetooth') : tr('Connect with Wi-Fi Direct');
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
        adbPill.textContent = tr(label);
        adbRow.setHint(bridgeMessage(br.message));
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
          const r = UI.row(x.name, online ? tr('Connected') : tr('Last seen {time}', { time: UI.ago(x.lastSeen) }),
            [online ? el('span', { class: 'pill good', text: tr('Online') }) : null,
              // Wake it over the network (it told us how while connected).
              !online && wk[x.id] ? UI.button(s.wake.last && s.wake.last.id === x.id && Date.now() - s.wake.last.at < 20000 ? tr('Waking…') : tr('Wake'), () => api.wakePeer(x.id), 'small') : null,
              // Switch to it (nearby): whatever the session is now, it ends.
              !online && near.has(x.id) ? UI.button(c ? tr('Switch') : tr('Connect'), () => api.pairWith(x.id), 'small') : null,
              UI.button(tr('Forget'), () => api.forget(x.id), 'small')], { literal: true });
          r.querySelector('.text').prepend(UI.osIcon(x.os));
          r.classList.add('with-ico');
          return r;
        })
        : [UI.row(tr('Nothing paired yet'), tr('Pair with a computer in Nearby.'))]));
    };
  },
});

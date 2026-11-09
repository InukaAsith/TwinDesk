// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Connection page (was Overview): this Mac's address and Connect by address on top, the computers
// and phones nearby, pairing a phone with a QR code, the link itself, the phone's wireless debugging
// and everything paired. The start page until something is connected; then Overview
// (shared/ui-device-*.js) shows the device.
'use strict';

UI.tab({
  id: 'connection',
  order: 1,
  title: window.I18n.t('Connection'),
  heading: window.I18n.t('Connection'),
  icon: 'link',
  group: 'Device',
  desc: '',
  color: 'linear-gradient(#5ac8fa, #007aff)',
  badge: (s) => (s.discovery && (!s.discovery.on || !s.discovery.localNetwork) ? '!' : ''),
  build(body) {
    const { el, api } = UI;
    const tr = window.I18n.t;

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

    // ---- permissions missing after Setup (it shows only once): a row here, the switches in General ----
    const PERMS = [['screen', 'Screen Recording', (p) => p.screen !== 'granted'], ['accessibility', 'mac.accessibility', (p) => !p.accessibility], ['inputMonitoring', 'Input Monitoring', (p) => p.inputMonitoring === false]];
    const permRow = UI.row('', '', [UI.button(tr('Open General'), () => UI.go('general'), 'small primary')], { literal: true });
    const permCard = UI.card('', [permRow]);

    // ---- a connected phone's wireless debugging (shared/ui-adb.js) and pairing by QR code (shared/ui-qrpair.js) ----
    const adb = UI.adbCard();
    const qrPair = UI.qrPairCard ? UI.qrPairCard() : null;
    const pairedList = el('div');
    const webCard = UI.webConnCard ? UI.webConnCard() : null; // TwinDesk Web's paired devices (shared/ui-web.js)

    body.append(
      permCard,
      UI.card('', [addrRow, ipRow]),
      UI.card(tr('Nearby'), [discRow, foundList, ...bleRows], { actions: [refresh] }),
      ...(qrPair ? [qrPair.el] : []),
      hero,
      adb.el,
      UI.card(tr('Paired'), [pairedList]),
      ...(webCard ? [webCard.el] : []),
    );

    let foundKey = '';
    let pairedKey = '';
    let last = null;

    // Each nearby row shows its own progress, set on the click itself and then followed from the
    // pairing (this Mac's host pairing s.pairing, or its guest pairing with another Mac) and the
    // session: Connecting… → Check the code → Waiting for Allow → Paired ✓, or the reason and Retry.
    // A PC that is asked to pair (an invite) has a minute to start; a connect or Take over 8 s.
    // pending: dev id -> {kind: 'pair' | 'invite' | 'take', since}; done: dev id -> {at, kind}.
    const LIMIT_MS = { pair: 8000, take: 8000, invite: 60000 };
    const pending = {};
    const done = {};
    const redraw = () => { foundKey = ''; if (last) update(last); };
    const go = (dev, kind) => {
      pending[dev.id] = { kind, since: Date.now() };
      delete done[dev.id];
      redraw(); // this row changes now, before the request goes out
      api.pairWith(dev.id);
      setTimeout(redraw, LIMIT_MS[kind] + 50);
    };
    // {busy, text} | {code, allow} | {wait, text} | {fail, text} | {ok, text} | null
    function rowState(s, dev, online) {
      const g = s.guest && s.guest.pairing && s.guest.pairing.address === dev.address ? s.guest.pairing : null;
      const h = s.pairing && (s.pairing.id === dev.id || (!s.pairing.id && s.pairing.name === dev.name)) ? s.pairing : null;
      const mine = pending[dev.id];
      if (online) {
        if (mine) {
          delete pending[dev.id];
          done[dev.id] = { at: Date.now(), kind: mine.kind };
          setTimeout(redraw, 1550);
        }
        const d = done[dev.id];
        return d && Date.now() - d.at < 1500 ? { ok: true, text: d.kind === 'take' ? tr('Connected') : tr('Paired ✓') } : null;
      }
      if (h) { // it pairs with this Mac
        if (mine) mine.seen = true;
        if (!h.code) return { busy: true, text: tr('Connecting…') };
        if (!h.allowed) return { code: h.code, allow: true };
        return { wait: true, text: tr('Waiting for “Codes match” on {name}…', { name: dev.name }) };
      }
      if (g) { // this Mac pairs with it
        if (mine) mine.seen = true;
        if (g.phase === 'failed') return { fail: true, text: g.error };
        if (g.phase === 'code') return { code: g.code };
        if (g.phase === 'waiting') return { wait: true, text: tr('Waiting for {name} to allow…', { name: dev.name }) };
        return { busy: true, text: tr('Connecting…') };
      }
      if (!mine) return null;
      if (mine.seen) { // its pairing ended without connecting (Cancel, Deny)
        delete pending[dev.id];
        return null;
      }
      if (Date.now() - mine.since > LIMIT_MS[mine.kind]) {
        return { fail: true, text: mine.kind === 'invite' ? tr('{name} didn’t answer. Is TwinDesk open there?', { name: dev.name }) : tr('Can’t reach {name} at {address}. Is TwinDesk open there, on the same Wi-Fi?', { name: dev.name, address: dev.address }) };
      }
      return mine.kind === 'invite' ? { wait: true, text: tr('Asked {name} to pair. Confirm there…', { name: dev.name }) } : { busy: true, text: mine.kind === 'take' ? tr('Taking over…') : tr('Connecting…') };
    }

    const update = (s) => {
      if (webCard) webCard.render(s);
      last = s;
      const p = UI.names(s);
      bleSw.set(!s.net || s.net.ble !== false);
      blePcSw.set(!!s.net && s.net.blePc === true);
      const c = s.client;
      const g = s.guest || { status: {}, hosts: [] };

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
      const phoneGoing = s.phone && s.phone.connecting ? s.phone.connecting.id : ''; // a phone connecting: its row turns
      const fk = JSON.stringify([s.found, [...pairedIds], c && c.id, blocked, s.pairing, g.pairing, Object.keys(pending), phoneGoing]);
      if (fk !== foundKey) {
        foundKey = fk;
        const rows = s.found.map((dev) => {
          const online = c && c.id === dev.id;
          const known = pairedIds.has(dev.id);
          const st = dev.os === 'android' || dev.os === 'ios' ? null : rowState(s, dev, online); // a phone has its own popup
          const kind = known ? 'take' : dev.os === 'mac' ? 'pair' : 'invite';
          const going = (dev.os === 'android' || dev.os === 'ios') && phoneGoing === dev.id;
          const label = online || going || (st && !st.fail) ? null : st ? tr('Retry') : known ? tr('Take over') : dev.os === 'mac' ? tr('Pair') : tr('Connect');
          const btn = label && UI.button(tr(label), () => go(dev, kind), `small${dev.invited || st ? ' primary' : ''}`);
          const match = st && st.code ? UI.button(st.allow ? tr('Allow') : tr('Codes match'), () => (st.allow ? api.pairRespond(true) : api.confirmGuestCode()), 'small primary') : null;
          const hint = going ? tr('Connecting…') : !st || st.ok ? dev.invited ? tr('{address} · wants to connect', { address: dev.address }) : dev.address
            : st.code ? tr('Check the code: {code} (the same on {name}?)', { code: st.code.slice(0, 3) + ' ' + st.code.slice(3), name: dev.name }) : st.text;
          const r = UI.row(dev.name, hint, [
            going || (st && (st.busy || st.wait)) ? el('span', { class: 'spin', attrs: { 'aria-hidden': 'true' } }) : null,
            st && st.ok ? el('span', { class: 'pill good', text: st.text }) : online ? el('span', { class: 'pill good', text: tr('Connected') }) : known && !st ? el('span', { class: 'pill muted', text: tr('Paired') }) : null,
            match, btn], { literal: true });
          if (st && st.fail) r.hint.classList.add('bad');
          if (st && st.code) r.hint.classList.add('code-hint');
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

      // the phone's wireless debugging, and pairing a phone with a QR code
      adb.update(s);
      if (qrPair) qrPair.update(s);

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
    return update;
  },
});

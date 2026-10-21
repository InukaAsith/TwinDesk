// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Calls page (Mac, PC and Linux): the phone's calls here — the one going on, calling a name or a
// number, the sound over Bluetooth (this computer as the phone's headset) and the call history.
'use strict';

UI.tab({
  id: 'calls',
  group: 'Phone',
  order: 5,
  title: 'Calls',
  icon: 'call',
  color: 'linear-gradient(#5ee07a, #30b94d)',
  desc: 'Answer and make your phone’s calls here.',
  hidden: (s) => !UI.isPhone(s), // only while a phone is connected
  master: { get: (s) => !!(s.hub && s.hub.calls), set: (v) => UI.api.hub({ do: 'set', what: 'calls', on: v }) },
  badge: (s) => (s.hub && s.hub.call ? 'warn' : s.hub && s.hub.calls ? 'on' : ''),
  build(body, page) {
    const { el, api } = UI;
    const top = UI.hubTop('calls');

    // The call going on.
    const avatarSlot = el('span');
    const who = el('span', { class: 'label' });
    const sub = el('span', { class: 'hint' });
    const act = (a, extra = {}) => api.hub({ do: 'call', a, ...extra });
    const answer = UI.button('Answer', () => act('answer'), 'primary');
    const decline = UI.button('Decline', () => act('end'), 'danger');
    const mute = UI.button('Mute', () => act('mute', { on: !(UI.state.hub && UI.state.hub.muted) }));
    const where = UI.button('Sound here', () => api.hub({ do: 'audio', a: UI.state.hub.audio && UI.state.hub.audio.here ? 'phone' : 'here' }));
    const end = UI.button('End', () => act('end'), 'danger');
    const nowRow = el('div', { class: 'row hub-call' }, [avatarSlot, el('div', { class: 'text' }, [who, sub]), el('div', { class: 'controls' }, [mute, where, decline, end, answer])]);
    const nowCard = UI.card('Now', [nowRow]);

    // Call a number: typed, or on the keypad; the contacts it matches show under it.
    const number = el('input', { type: 'tel', class: 'hub-input hub-number', placeholder: 'Enter a number', spellcheck: false, autocomplete: 'off', attrs: { 'aria-label': 'Number' } });
    const callBtn = UI.button('Call', () => dial(number.value), 'primary');
    const padBtn = UI.button('Keypad', () => { pad.hidden = !pad.hidden; padBtn.classList.toggle('on', !pad.hidden); number.focus(); });
    const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
    const pad = el('div', { class: 'hub-keypad', hidden: true }, [
      ...KEYS.map(([k, sub]) => {
        const b = el('button', { class: 'hub-key', attrs: { 'aria-label': k } }, [el('span', { text: k }), el('small', { text: sub })]);
        b.onclick = () => key(k);
        return b;
      }),
      el('span'),
      Object.assign(el('button', { class: 'hub-key hub-key-call', title: 'Call', attrs: { 'aria-label': 'Call' } }, [UI.icon('call')]), { onclick: () => dial(number.value) }),
      Object.assign(el('button', { class: 'hub-key hub-key-del', text: '⌫', title: 'Delete', attrs: { 'aria-label': 'Delete' } }), {
        onclick: () => { number.value = number.value.slice(0, -1); typed(); number.focus(); },
      }),
    ]);
    const matches = el('div', { class: 'hub-list' });
    const dialCard = UI.card('Call', [el('div', { class: 'row hub-dial' }, [number, padBtn, callBtn]), pad, matches]);
    const digits = (v) => String(v || '').replace(/[^\d+]/g, '');
    // Typed digits in a saved number, the trunk 0 aside (0771… finds +94 771…).
    const has = (n, d) => { const x = digits(n); const local = d.replace(/^0+/, ''); return x.includes(d) || (local.length >= 3 && x.includes(local)); };
    const isNumber = (v) => /^[\d\s()+*#.,;-]+$/.test(v.trim()) && /\d|[*#]/.test(v);
    const dial = (n) => {
      const v = String(n || '').trim();
      if (!isNumber(v)) return;
      act('dial', { number: v });
      number.value = '';
      typed();
    };
    const key = (k) => {
      number.value += k;
      typed();
      number.focus();
    };
    const typed = () => {
      const v = number.value.trim();
      callBtn.disabled = !isNumber(v);
      const d = digits(v).replace(/^\+/, '');
      const hits = d.length >= 3 ? contacts.filter((p) => p.numbers.some((x) => has(x.n, d))).slice(0, 4) : [];
      matches.replaceChildren(...hits.map((p) => contactRow(p, d)));
    };
    number.oninput = typed;
    number.onkeydown = (e) => { if (e.key === 'Enter') dial(number.value); };
    callBtn.disabled = true;

    // The phone's contacts: all of them, searched here.
    let contacts = []; // [{name, starred, numbers: [{n, label}]}]
    let contactsLoaded = false;
    let shownContacts = 60;
    const search = el('input', { type: 'search', class: 'hub-input hub-grow', placeholder: 'Search contacts', spellcheck: false, attrs: { 'aria-label': 'Search contacts' } });
    const contactList = el('div', { class: 'hub-list hub-scroll' });
    const moreContacts = UI.button('Show more', () => { shownContacts += 100; showContacts(); }, 'small');
    const loadContacts = () => { contactsLoaded = true; UI.hubAsk({ t: 'contacts', q: '' }); };
    const contactsCard = UI.card('Contacts', [el('div', { class: 'row hub-dial' }, [search]), contactList, el('div', { class: 'hub-more' }, [moreContacts])],
      { actions: [UI.button('Refresh', loadContacts, 'small')] });
    // A contact with a Call button; with several numbers, which one (the one matching `d` first).
    const contactRow = (p, d = '') => {
      const nums = p.numbers;
      const first = (d && nums.find((x) => has(x.n, d))) || nums[0];
      const line = (x) => `${x.label ? `${x.label} · ` : ''}${x.n}`;
      let pick = null;
      if (nums.length > 1) {
        pick = UI.select(nums.map((x) => ({ value: x.n, label: line(x) })), () => {});
        pick.set(first.n);
      }
      const r = UI.row(p.name, nums.length > 1 ? `${nums.length} numbers` : line(first),
        [pick && pick.el, UI.button('Call', () => dial(pick ? pick.el.value : first.n), 'small')].filter(Boolean));
      if (p.starred) r.label.classList.add('hub-starred');
      r.prepend(UI.avatar(p.name));
      return r;
    };
    const showContacts = () => {
      const q = search.value.trim().toLowerCase();
      const d = digits(q).replace(/^\+/, '');
      const list = !q ? contacts : contacts.filter((p) => p.name.toLowerCase().includes(q) || (d.length >= 2 && p.numbers.some((x) => has(x.n, d))));
      contactList.replaceChildren(...list.slice(0, shownContacts).map((p) => contactRow(p, d.length >= 2 ? d : '')));
      if (!list.length) contactList.append(el('div', { class: 'hub-empty', text: !contactsLoaded ? '' : q ? 'No contacts match' : contacts.length ? '' : 'No contacts on the phone' }));
      moreContacts.hidden = list.length <= shownContacts;
    };
    let searchTimer = 0;
    search.oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { shownContacts = 60; showContacts(); }, 120);
    };
    UI.hubOn('contacts', (m) => {
      if (m.q) return; // only the whole list is asked for
      contacts = (m.items || []).filter((p) => p && Array.isArray(p.numbers) && p.numbers.length)
        .map((p) => ({ name: String(p.name || p.numbers[0].n), starred: !!p.starred, numbers: p.numbers.filter((x) => x && x.n).map((x) => ({ n: String(x.n), label: String(x.label || '') })) }))
        .sort((a, b) => (b.starred - a.starred) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      showContacts();
      typed();
    });

    // The sound over Bluetooth: this computer as the phone's headset.
    const audioSw = UI.switch((v) => api.hub({ do: 'opt', callAudio: v }), { label: 'Talk and listen on this computer' });
    const audioRow = UI.row('Talk and listen on {me}', '', [audioSw]);
    const retryBtn = UI.button('Connect', () => api.hub({ do: 'audio', a: 'connect' }));
    // Which paired Bluetooth device the phone is, when its name didn't say (or to change it).
    const which = UI.select([], (id) => id && api.hub({ do: 'opt', btDevice: id }));
    which.el.setAttribute('aria-label', 'Which phone');
    const statusRow = UI.row('Bluetooth', '', [which.el, retryBtn]);
    const soundCard = UI.card('Sound', [audioRow, statusRow]);

    // Setting it up: the person pairs the two in the systems' own Bluetooth settings, over classic
    // Bluetooth (what a call goes through); TwinDesk doesn't pair them itself, only says how, and
    // connects once they are. Forget at the bottom: both forget each other, classic and LE.
    const settingsBtn = UI.button('Open Bluetooth settings', () => api.hub({ do: 'audio', a: 'settings' }), 'small primary');
    const step1 = UI.row('', '');
    const step2 = UI.row('', '', [settingsBtn]);
    const step3 = UI.row('3. Confirm the code on both', '');
    const pairedRow = UI.row('', '');
    const forgetBtn = UI.button('Forget', () => {
      if (forgetBtn.dataset.sure !== '1') { forgetBtn.dataset.sure = '1'; forgetBtn.textContent = 'Forget?'; forgetBtn.classList.add('danger'); return; }
      unsure();
      api.hub({ do: 'audio', a: 'forget' });
    }, 'small');
    const unsure = () => { forgetBtn.dataset.sure = ''; forgetBtn.textContent = 'Forget'; forgetBtn.classList.remove('danger'); };
    const forgetRow = UI.row('Forget', '', [forgetBtn]);
    const setupCard = UI.card('Bluetooth setup', [step1, step2, step3, pairedRow, forgetRow]);
    // Back in this window from pairing (Settings, or the phone): connected at once when they are.
    window.addEventListener('focus', () => {
      const a = UI.state && UI.state.hub && UI.state.hub.audio;
      if (a && ['needs-pair', 'choose'].includes(a.state)) api.hub({ do: 'audio', a: 'check' });
    });

    // The call history.
    const recent = el('div', { class: 'hub-list hub-scroll' });
    const reload = UI.button('Refresh', () => UI.hubAsk({ t: 'call.log', n: 100 }), 'small');
    const recentCard = UI.card('Recent', [recent], { actions: [reload] });
    const TYPE = { in: 'Incoming', out: 'Outgoing', missed: 'Missed', rejected: 'Declined', blocked: 'Blocked', voicemail: 'Voicemail' };
    UI.hubOn('call.log', (m) => {
      recent.replaceChildren(...(m.items || []).map((c) => {
        const r = UI.row(c.name || c.number || 'Unknown number', `${TYPE[c.type] || ''}${c.dur && c.type !== 'missed' ? ` · ${UI.duration(c.dur)}` : ''} · ${UI.clock(c.at)}`,
          c.number ? [UI.button('Call', () => dial(c.number), 'small')] : []);
        if (c.type === 'missed' || c.type === 'rejected') r.label.classList.add('hub-missed');
        r.prepend(UI.avatar(c.name || c.number));
        return r;
      }));
      if (!recent.children.length) recent.append(el('div', { class: 'hub-empty', text: m.items ? 'No calls yet' : '' }));
    });

    body.append(top.el, nowCard, dialCard, recentCard, contactsCard, soundCard, setupCard);

    let loaded = false;
    let hadCall = false;
    const canContacts = (s) => UI.hubReady(s, 'calls') && !(s.hub.perm.calls.missing || []).includes('contacts');
    let loadedAt = 0;
    const load = () => {
      loaded = true;
      if (Date.now() - loadedAt < 2000) return; // shown and rendered at once: asked once
      loadedAt = Date.now();
      UI.hubAsk({ t: 'call.log', n: 100 });
      if (!contactsLoaded && canContacts(UI.state)) loadContacts();
    };
    UI.onShown(page, (shown) => { if (shown && UI.hubReady(UI.state, 'calls')) load(); });

    return (s) => {
      const h = s.hub || {};
      top.render(s);
      const ready = UI.hubReady(s, 'calls');
      if (!ready) {
        loaded = false;
        if (contactsLoaded || contacts.length) { contactsLoaded = false; contacts = []; showContacts(); typed(); } // another phone, or none: asked again
      } else if (!loaded && !page.hidden) load();
      else if (!contactsLoaded && !page.hidden && canContacts(s)) loadContacts(); // allowed since
      const c = h.call;
      if (hadCall && !c && ready) setTimeout(() => UI.hubAsk({ t: 'call.log', n: 100 }), 1500); // the call just ended is in the log now
      hadCall = !!c;

      nowCard.hidden = !c;
      if (c) {
        avatarSlot.replaceChildren(UI.avatar(c.name || c.number, c.photo));
        who.textContent = c.name || c.number || 'Unknown number';
        const bt = h.audio && h.audio.state === 'ready';
        sub.textContent = c.state === 'ringing' ? `Incoming call${c.name && c.number ? ` · ${c.number}` : ''}`
          : `${c.dir === 'out' ? 'Calling' : 'On a call'} · ${UI.duration((Date.now() - c.since) / 1000)}${bt ? (h.audio.here ? ' · Sound here' : ' · Sound on the phone') : ''}`;
        const ringing = c.state === 'ringing';
        answer.hidden = !ringing;
        decline.hidden = !ringing;
        end.hidden = ringing;
        mute.hidden = ringing;
        mute.textContent = h.muted ? 'Unmute' : 'Mute';
        where.hidden = ringing || !bt || h.audio.canMove === false;
        where.textContent = bt && h.audio.here ? 'Sound on the phone' : 'Sound here';
      }
      dialCard.hidden = !ready;
      contactsCard.hidden = !canContacts(s);
      recentCard.hidden = !ready || !(h.perm && !(h.perm.calls.missing || []).includes('numbers'));

      // Sound
      soundCard.hidden = !h.calls || !h.canAudio;
      audioSw.set(!!h.callAudio);
      audioRow.setHint(h.audioLimit || '');
      const a = h.audio;
      const bt = h.perm && h.perm.bt;
      let status = '';
      if (!h.callAudio) status = `Off: calls sound on ${UI.phoneName(s)}`;
      else if (!h.connected) status = `When ${UI.phoneName(s)} is connected`;
      else if (!a) status = 'Starting…';
      else status = a.message || '';
      const phone = UI.phoneName(s);
      const needsPair = !!(a && ['needs-pair', 'choose'].includes(a.state));
      if (h.callAudio && h.connected && needsPair && bt) {
        // The phone's side of the pairing (Hub.kt): LE only can't carry a call.
        if (bt.bonding) status = `Pairing… Confirm the code on ${phone} and on {me}`;
        else if (bt.le) status = `${phone} and {me} are paired over Bluetooth LE only, which can’t carry a call: Forget below, then pair them again in Bluetooth settings`;
        else if (bt.forget) status = `${phone} keeps its old pairing with {me}: forget {me} in Bluetooth settings on ${phone} (they opened there), then pair them again in Bluetooth settings`;
        else if (bt.radio === false) status = `Bluetooth is off on ${phone}`;
        else if (a.state === 'needs-pair') status = `Not paired with ${phone} over classic Bluetooth: pair them in Bluetooth settings, as below. TwinDesk connects once they are`;
      }
      statusRow.setHint(status);
      retryBtn.hidden = !(a && ['failed', 'off'].includes(a.state));
      const devices = (a && h.connected && a.devices) || [];
      which.el.hidden = !(a && (a.state === 'choose' || (devices.length > 1 && a.state !== 'ready')));
      if (!which.el.hidden) {
        which.options([{ value: '', label: `Which one is ${phone}?` }, ...devices.map((d) => ({ value: d.id, label: d.name }))]);
        which.set(a.device || '');
      }

      // Setup: the steps until they're paired, Forget always at the bottom.
      setupCard.hidden = soundCard.hidden || !h.callAudio || !h.connected || !a || ['off', 'starting', 'unavailable'].includes(a.state);
      const paired = !needsPair && !!(a && a.device);
      step1.hidden = paired;
      step2.hidden = paired;
      step3.hidden = paired;
      pairedRow.hidden = !paired;
      if (paired) {
        pairedRow.label.textContent = `Paired with ${phone}`;
        pairedRow.setHint('Over classic Bluetooth, which carries the calls’ sound');
      } else {
        step1.label.textContent = `1. On ${phone}: Settings › Bluetooth › Pair new device`;
        step1.setHint(`${phone} can be found while that screen is open`);
        step2.label.textContent = UI.fill('2. Pair from {me}');
        step2.setHint((a && a.pairHow) || `In {me}’s Bluetooth settings, add a device and pick ${phone}`);
        settingsBtn.hidden = !h.btSettings;
        step3.setHint(bt && bt.bonding ? `Pairing… Confirm it on ${phone} and on {me}`
          : h.pairWatch ? `Looking for ${phone}… TwinDesk connects as soon as they’re paired`
            : 'TwinDesk connects as soon as they’re paired');
      }
      forgetRow.setHint(`${phone} and {me} forget each other, over classic Bluetooth and LE, then pair again from the start`);
      if (setupCard.hidden) unsure();
    };
  },
});

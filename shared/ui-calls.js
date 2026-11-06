// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Calls page (Mac, PC and Linux): the phone's calls here — the one going on, calling a name or a
// number, the sound over Bluetooth (this computer as the phone's headset) and the call history.
'use strict';

(() => {
  const tr = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);

  const audioStatus = (a) => {
    if (!window.I18n || window.I18n.locale === 'en' || !a.ui) return tr(a.message || '');
    const u = a.ui;
    const phone = u.phoneName || tr('the phone');
    const target = u.targetName || tr('the phone');
    switch (a.state) {
      case 'starting': return tr('Starting…');
      case 'off': return tr('Off');
      case 'unavailable': return tr(u.error || 'Bluetooth is off on this PC');
      case 'needs-pair': return tr('Not paired with {phone} over classic Bluetooth: pair them in Bluetooth settings, as below', { phone });
      case 'choose': return tr('Which one is {phone}? Pick it, or pair it below if it isn’t there', { phone });
      case 'connecting': return tr('Connecting to {phone}…', { phone: target });
      case 'ready': return tr(u.local ? 'Connected to {phone} over Bluetooth: calls play on this PC'
        : 'Connected to {phone}, but calls stay on the phone while a Bluetooth headset is connected to this PC: Windows plays calls only through wired or built-in speakers and a microphone, with no Bluetooth headset connected', { phone: target });
      case 'failed':
        if (u.denied) return u.denial === 'unregistered' ? tr('Windows keeps {phone}’s calls for another app: Forget it below and pair it again', { phone })
          : u.denial === 'privacy' ? tr('Windows’ privacy settings keep calls from TwinDesk: allow it in Settings › Privacy & security › Phone calls, then Connect') : u.error || '';
        const error = u.error && u.error !== 'stopped' ? u.error : '';
        return tr(u.retrying
          ? error ? 'Couldn’t reach {phone} over Bluetooth ({error}). Trying again soon' : 'Couldn’t reach {phone} over Bluetooth. Trying again soon'
          : error ? 'Couldn’t reach {phone} over Bluetooth ({error}). Click Connect to try again' : 'Couldn’t reach {phone} over Bluetooth. Click Connect to try again', { phone: target, error });
      default: return tr(a.message || '');
    }
  };
  const audioPairHow = (a) => window.I18n && window.I18n.locale !== 'en' && a && a.ui
    ? tr('In Settings › Bluetooth & devices: Add device › Bluetooth, then pick {phone} (the one with a phone icon)', { phone: a.ui.phoneName || tr('the phone') })
    : tr((a && a.pairHow) || '');

UI.tab({
  id: 'calls',
  group: 'Phone',
  order: 5,
  title: tr('Calls'),
  icon: 'call',
  color: 'linear-gradient(#5ee07a, #30b94d)',
  desc: tr('Answer and make your phone’s calls here.'),
  hidden: (s) => !UI.isPhone(s) || !!s.activeWebDevice, // only while a phone is connected
  master: { get: (s) => !!(s.hub && s.hub.calls), set: (v) => UI.api.hub({ do: 'set', what: 'calls', on: v }) },
  badge: (s) => (s.hub && s.hub.call ? 'warn' : s.hub && s.hub.calls ? 'on' : ''),
  build(body, page) {
    const { el, api } = UI;
    const top = UI.hubTop('calls');

    // The call going on.
    const avatarSlot = el('span');
    const who = el('span', { class: 'label', attrs: { 'data-literal': '' } });
    const sub = el('span', { class: 'hint', attrs: { 'data-literal': '' } });
    const act = (a, extra = {}) => api.hub({ do: 'call', a, ...extra });
    const answer = UI.button(tr('Answer'), () => act('answer'), 'primary');
    const decline = UI.button(tr('Decline'), () => act('end'), 'danger');
    const mute = UI.button(tr('Mute'), () => act('mute', { on: !(UI.state.hub && UI.state.hub.muted) }));
    const where = UI.button(tr('Sound here'), () => api.hub({ do: 'audio', a: UI.state.hub.audio && UI.state.hub.audio.here ? 'phone' : 'here' }));
    const end = UI.button(tr('End'), () => act('end'), 'danger');
    // What the phone app can do on the call (call.state can): Silence while it rings; Hold and the
    // keypad once the phone allowed TwinDesk the calls themselves (over wireless debugging, once).
    const silence = UI.button(tr('Silence'), () => act('silence'));
    const hold = UI.button(tr('Hold'), () => act('hold', { on: !(UI.state.hub && UI.state.hub.call && UI.state.hub.call.held) }));
    const tonesBtn = UI.button(tr('Keypad'), () => { tones.hidden = !tones.hidden; tonesBtn.classList.toggle('on', !tones.hidden); });
    const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
    const sent = el('div', { class: 'hint hub-tones-sent', attrs: { 'data-literal': '' } });
    const tones = el('div', { hidden: true }, [sent, el('div', { class: 'hub-keypad' }, KEYS.map(([k, s]) => {
      const b = el('button', { class: 'hub-key', attrs: { 'aria-label': k } }, [el('span', { text: k }), el('small', { text: s })]);
      b.onclick = () => { act('dtmf', { key: k }); sent.textContent = (sent.textContent + k).slice(-24); };
      return b;
    }))]);
    const nowRow = el('div', { class: 'row hub-call' }, [avatarSlot, el('div', { class: 'text' }, [who, sub]), el('div', { class: 'controls' }, [silence, mute, hold, tonesBtn, where, decline, end, answer])]);
    const nowCard = UI.card(tr('Now'), [nowRow, tones]);

    // Call a number: typed, or on the keypad; the contacts it matches show under it.
    const number = el('input', { type: 'tel', class: 'hub-input hub-number', placeholder: tr('Enter a number'), spellcheck: false, autocomplete: 'off', attrs: { 'aria-label': tr('Number') } });
    const callBtn = UI.button(tr('Call'), () => dial(number.value), 'primary');
    const padBtn = UI.button(tr('Keypad'), () => { pad.hidden = !pad.hidden; padBtn.classList.toggle('on', !pad.hidden); number.focus(); });
    // Two SIMs or more: which one the call goes out on ('' is the phone's default).
    const simPick = UI.select([{ value: '', label: tr('Default SIM') }], () => {});
    simPick.el.setAttribute('aria-label', tr('SIM'));
    const pad = el('div', { class: 'hub-keypad', hidden: true }, [
      ...KEYS.map(([k, sub]) => {
        const b = el('button', { class: 'hub-key', attrs: { 'aria-label': k } }, [el('span', { text: k }), el('small', { text: sub })]);
        b.onclick = () => key(k);
        return b;
      }),
      el('span'),
      Object.assign(el('button', { class: 'hub-key hub-key-call', title: tr('Call'), attrs: { 'aria-label': tr('Call') } }, [UI.icon('call')]), { onclick: () => dial(number.value) }),
      Object.assign(el('button', { class: 'hub-key hub-key-del', text: '⌫', title: tr('Delete'), attrs: { 'aria-label': tr('Delete') } }), {
        onclick: () => { number.value = number.value.slice(0, -1); typed(); number.focus(); },
      }),
    ]);
    const matches = el('div', { class: 'hub-list' });
    // A code (*#06#, call forwarding…) isn't dialed from here: the phone's dialer opens with it.
    const onPhone = el('div', { class: 'hint', hidden: true, text: tr('The code is in the phone’s dialer: tap Call there to run it.') });
    const dialCard = UI.card(tr('Call'), [el('div', { class: 'row hub-dial' }, [number, simPick.el, padBtn, callBtn]), onPhone, pad, matches]);
    UI.hubOn('call.done', (m) => {
      if (m.a !== 'dial') return;
      onPhone.hidden = !m.onPhone;
      if (m.onPhone) setTimeout(() => { onPhone.hidden = true; }, 15000);
    });
    const digits = (v) => String(v || '').replace(/[^\d+]/g, '');
    // Typed digits in a saved number, the trunk 0 aside (0771… finds +94 771…).
    const has = (n, d) => { const x = digits(n); const local = d.replace(/^0+/, ''); return x.includes(d) || (local.length >= 3 && x.includes(local)); };
    const isNumber = (v) => /^[\d\s()+*#.,;-]+$/.test(v.trim()) && /\d|[*#]/.test(v);
    const dial = (n) => {
      const v = String(n || '').trim();
      if (!isNumber(v)) return;
      act('dial', { number: v, sim: simPick.el.value || undefined });
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
    const search = el('input', { type: 'search', class: 'hub-input hub-grow', placeholder: tr('Search contacts'), spellcheck: false, attrs: { 'aria-label': tr('Search contacts') } });
    const contactList = el('div', { class: 'hub-list hub-scroll' });
    const moreContacts = UI.button(tr('Show more'), () => { shownContacts += 100; showContacts(); }, 'small');
    const loadContacts = () => { contactsLoaded = true; UI.hubAsk({ t: 'contacts', q: '' }); };
    const contactsCard = UI.card(tr('Contacts'), [el('div', { class: 'row hub-dial' }, [search]), contactList, el('div', { class: 'hub-more' }, [moreContacts])],
      { actions: [UI.button(tr('Refresh'), loadContacts, 'small')] });
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
      const r = UI.row(p.name, nums.length > 1 ? tr('{count} numbers', { count: nums.length }) : line(first),
        [pick && pick.el, UI.button(tr('Call'), () => dial(pick ? pick.el.value : first.n), 'small')].filter(Boolean), { literal: true });
      if (p.starred) r.label.classList.add('hub-starred');
      r.prepend(UI.avatar(p.name));
      return r;
    };
    const showContacts = () => {
      const q = search.value.trim().toLowerCase();
      const d = digits(q).replace(/^\+/, '');
      const list = !q ? contacts : contacts.filter((p) => p.name.toLowerCase().includes(q) || (d.length >= 2 && p.numbers.some((x) => has(x.n, d))));
      contactList.replaceChildren(...list.slice(0, shownContacts).map((p) => contactRow(p, d.length >= 2 ? d : '')));
      if (!list.length) contactList.append(el('div', { class: 'hub-empty', text: !contactsLoaded ? '' : q ? tr('No contacts match') : contacts.length ? '' : tr('No contacts on the phone') }));
      moreContacts.hidden = list.length <= shownContacts;
    };
    let searchTimer = 0;
    search.oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
 shownContacts = 60; showContacts(); }, 120);
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
    const audioSw = UI.switch((v) => api.hub({ do: 'opt', callAudio: v }), { label: tr('Talk and listen on this computer') });
    const audioRow = UI.row(tr('Talk and listen on {me}'), '', [audioSw]);
    const retryBtn = UI.button(tr('Connect'), () => api.hub({ do: 'audio', a: 'connect' }));
    // Which paired Bluetooth device the phone is, when its name didn't say (or to change it).
    const which = UI.select([], (id) => id && api.hub({ do: 'opt', btDevice: id }));
    which.el.setAttribute('aria-label', tr('Which phone'));
    const statusRow = UI.row(tr('Bluetooth'), '', [which.el, retryBtn], { literal: true });
    const soundCard = UI.card(tr('Sound'), [audioRow, statusRow]);

    // Setting it up: the person pairs the two in the systems' own Bluetooth settings, over classic
    // Bluetooth (what a call goes through); TwinDesk doesn't pair them itself, only says how, and
    // connects once they are. Forget at the bottom: both forget each other, classic and LE.
    const settingsBtn = UI.button(tr('Open Bluetooth settings'), () => api.hub({ do: 'audio', a: 'settings' }), 'small primary');
    const step1 = UI.row('', '', [], { literal: true });
    const step2 = UI.row('', '', [settingsBtn], { literal: true });
    const step3 = UI.row(tr('3. Confirm the code on both'), '', [], { literal: true });
    const pairedRow = UI.row('', '', [], { literal: true });
    const forgetBtn = UI.button(tr('Forget'), () => {
      if (forgetBtn.dataset.sure !== '1') { forgetBtn.dataset.sure = '1'; forgetBtn.textContent = tr('Forget?'); forgetBtn.classList.add('danger'); return; }
      unsure();
      api.hub({ do: 'audio', a: 'forget' });
    }, 'small');
    const unsure = () => { forgetBtn.dataset.sure = ''; forgetBtn.textContent = tr('Forget'); forgetBtn.classList.remove('danger'); };
    const forgetRow = UI.row(tr('Forget'), '', [forgetBtn], { literal: true });
    const setupCard = UI.card(tr('Bluetooth setup'), [step1, step2, step3, pairedRow, forgetRow]);
    // Back in this window from pairing (Settings, or the phone): connected at once when they are.
    window.addEventListener('focus', () => {
      const a = UI.state && UI.state.hub && UI.state.hub.audio;
      if (a && ['needs-pair', 'choose'].includes(a.state)) api.hub({ do: 'audio', a: 'check' });
    });

    // The call history.
    const recent = el('div', { class: 'hub-list hub-scroll' });
    const reload = UI.button(tr('Refresh'), () => UI.hubAsk({ t: 'call.log', n: 100 }), 'small');
    const recentCard = UI.card(tr('Recent'), [recent], { actions: [reload] });
    const TYPE = { in: tr('Incoming'), out: tr('Outgoing'), missed: tr('Missed'), rejected: tr('Declined'), blocked: tr('Blocked'), voicemail: tr('Voicemail') };
    UI.hubOn('call.log', (m) => {
      recent.replaceChildren(...(m.items || []).map((c) => {
        const r = UI.row(c.name || c.number || tr('Unknown number'), `${TYPE[c.type] || ''}${c.dur && c.type !== 'missed' ? ` · ${UI.duration(c.dur)}` : ''} · ${UI.clock(c.at)}`,
          c.number ? [UI.button(tr('Call'), () => dial(c.number), 'small')] : [], { literal: true });
        if (c.type === 'missed' || c.type === 'rejected') r.label.classList.add('hub-missed');
        r.prepend(UI.avatar(c.name || c.number));
        return r;
      }));
      if (!recent.children.length) recent.append(el('div', { class: 'hub-empty', text: m.items ? tr('No calls yet') : '' }));
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
    UI.onDeviceChange(() => { // another device: its call log and contacts, not the previous one's
      loaded = false;
      loadedAt = 0;
      contactsLoaded = false;
      contacts = [];
      showContacts();
      typed();
      if (!page.hidden && UI.hubReady(UI.state, 'calls')) load();
    });

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
        who.textContent = c.name || c.number || tr('Unknown number');
        const bt = h.audio && h.audio.state === 'ready';
        sub.textContent = c.state === 'ringing' ? c.name && c.number ? tr('Incoming call · {number}', { number: c.number }) : tr('Incoming call')
          : tr(bt ? (h.audio.here ? '{state} · {duration} · Sound here' : '{state} · {duration} · Sound on the phone') : '{state} · {duration}', { state: tr(c.dir === 'out' ? 'Calling' : 'On a call'), duration: UI.duration((Date.now() - c.since) / 1000) });
        const ringing = c.state === 'ringing';
        answer.hidden = !ringing;
        decline.hidden = !ringing;
        end.hidden = ringing;
        mute.hidden = ringing;
        mute.textContent = h.muted ? tr('Unmute') : tr('Mute');
        where.hidden = ringing || !bt || h.audio.canMove === false;
        where.textContent = bt && h.audio.here ? tr('Sound on the phone') : tr('Sound here');
        const can = c.can || [];
        silence.hidden = !ringing || !can.includes('silence');
        silence.disabled = !!c.silenced;
        silence.textContent = c.silenced ? tr('Silenced') : tr('Silence');
        hold.hidden = ringing || !can.includes('hold');
        hold.textContent = c.held ? tr('Resume') : tr('Hold');
        tonesBtn.hidden = ringing || !can.includes('dtmf');
        if (tonesBtn.hidden) { tones.hidden = true; tonesBtn.classList.remove('on'); }
      } else {
        tones.hidden = true;
        tonesBtn.classList.remove('on');
        sent.textContent = '';
      }
      const sims = (h.perm && h.perm.calls && h.perm.calls.sims) || [];
      simPick.options([{ value: '', label: tr('Default SIM') }, ...sims.map((x) => ({ value: x.id, label: x.label }))]);
      simPick.el.hidden = sims.length < 2;
      dialCard.hidden = !ready;
      contactsCard.hidden = !canContacts(s);
      recentCard.hidden = !ready || !(h.perm && !(h.perm.calls.missing || []).includes('numbers'));

      // Sound
      soundCard.hidden = !h.calls || !h.canAudio;
      audioSw.set(!!h.callAudio);
      audioRow.setHint(tr(h.audioLimit || ''));
      const a = h.audio;
      const bt = h.perm && h.perm.bt;
      let status = '';
      if (!h.callAudio) status = tr('Off: calls sound on {phone}', { phone: UI.phoneName(s) });
      else if (!h.connected) status = tr('When {phone} is connected', { phone: UI.phoneName(s) });
      else if (!a) status = tr('Starting…');
      else status = audioStatus(a);
      const phone = UI.phoneName(s);
      const needsPair = !!(a && ['needs-pair', 'choose'].includes(a.state));
      if (h.callAudio && h.connected && needsPair && bt) {
        // The phone's side of the pairing (Hub.kt): LE only can't carry a call.
        if (bt.bonding) status = tr('Pairing… Confirm the code on {phone} and on {me}', { phone, me: UI.fill('{me}') });
        else if (bt.le) status = tr('{phone} and {me} are paired over Bluetooth LE only, which can’t carry a call: Forget below, then pair them again in Bluetooth settings', { phone, me: UI.fill('{me}') });
        else if (bt.forget) status = tr('{phone} keeps its old pairing with {me}: forget {me} in Bluetooth settings on {phone} (they opened there), then pair them again in Bluetooth settings', { phone, me: UI.fill('{me}') });
        else if (bt.radio === false) status = tr('Bluetooth is off on {phone}', { phone, me: UI.fill('{me}') });
        else if (a.state === 'needs-pair') status = tr('Not paired with {phone} over classic Bluetooth: pair them in Bluetooth settings, as below. TwinDesk connects once they are', { phone, me: UI.fill('{me}') });
      }
      statusRow.setHint(status);
      retryBtn.hidden = !(a && ['failed', 'off'].includes(a.state));
      const devices = (a && h.connected && a.devices) || [];
      which.el.hidden = !(a && (a.state === 'choose' || (devices.length > 1 && a.state !== 'ready')));
      if (!which.el.hidden) {
        which.options([{ value: '', label: tr('Which one is {phone}?', { phone, me: UI.fill('{me}') }) }, ...devices.map((d) => ({ value: d.id, label: d.name }))]);
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
        pairedRow.label.textContent = tr('Paired with {phone}', { phone, me: UI.fill('{me}') });
        pairedRow.setHint(tr('Over classic Bluetooth, which carries the calls’ sound'));
      } else {
        step1.label.textContent = tr('1. On {phone}: Settings › Bluetooth › Pair new device', { phone, me: UI.fill('{me}') });
        step1.setHint(tr('{phone} can be found while that screen is open', { phone, me: UI.fill('{me}') }));
        step2.label.textContent = tr('2. Pair from {me}', { me: UI.fill('{me}') });
        step2.setHint(audioPairHow(a) || tr('In {me}’s Bluetooth settings, add a device and pick {phone}', { phone, me: UI.fill('{me}') }));
        settingsBtn.hidden = !h.btSettings;
        step3.setHint(bt && bt.bonding ? tr('Pairing… Confirm it on {phone} and on {me}', { phone, me: UI.fill('{me}') })
          : h.pairWatch ? tr('Looking for {phone}… TwinDesk connects as soon as they’re paired', { phone, me: UI.fill('{me}') })
            : tr('TwinDesk connects as soon as they’re paired'));
      }
      forgetRow.setHint(tr('{phone} and {me} forget each other, over classic Bluetooth and LE, then pair again from the start', { phone, me: UI.fill('{me}') }));
      if (setupCard.hidden) unsure();
    };
  },
});

})();

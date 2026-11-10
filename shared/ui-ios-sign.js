// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk iPhone (Mac, PC and Linux): TwinDesk for iPhone and iPad signed with the person's own
// Apple ID and installed from this computer, in place of AltStore or Sideloadly (shared/iossign.js,
// ios-signer/). Opt in, and said plainly. Top to bottom:
//   the switch, and under it the warning (with AltStore recommended);
//   on: Install TwinDesk first when it isn't on the device; the iPhones and iPads this computer can
//   reach (cable, Wi-Fi sync, Bluetooth), one picked when there are several; a run's progress, step by
//   step, with Apple's questions in it; TwinDesk on the device and Refresh now; automatic refresh and
//   its options; a copy kept on this computer (off, behind a warning);
//   How this works, as plain paragraphs.
'use strict';

(function () {
  const tr = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
  const mac = /Mac/.test(navigator.platform);
  const linux = /Linux/.test(navigator.platform);
  const here = mac ? tr('this Mac') : linux ? tr('this computer') : tr('this PC');

  const daysLeft = (expires) => Math.floor((expires * 1000 - Date.now()) / 86400000);
  const leftText = (expires) => {
    if (!expires) return '';
    const ms = expires * 1000 - Date.now();
    if (ms <= 0) return tr('Expired');
    const d = daysLeft(expires);
    return d >= 1 ? tr('{count} days left', { count: d }) : tr('{count} hours left', { count: Math.max(1, Math.floor(ms / 3600000)) });
  };

  // A run's steps, in order (signin or session: one of the two).
  const STEPS = [
    ['find', 'Looking for the iPhone'], ['download', 'Downloading TwinDesk'], ['signin', 'Signing in to Apple'],
    ['session', 'Opening the Apple session'], ['register', 'Registering the device'], ['cert', 'Getting the certificate'],
    ['appid', 'Registering the app ID'], ['profile', 'Getting the provisioning profile'], ['sign', 'Signing the app'], ['install', 'Installing'],
  ];
  const AHEAD = ['register', 'cert', 'appid', 'profile', 'sign', 'install']; // always still to come until seen

  const SVG = 'http://www.w3.org/2000/svg';
  const svg = (d, attrs = {}) => {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    for (const one of [].concat(d)) {
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('d', one);
      s.append(p);
    }
    return s;
  };
  // A warning sign: a rounded triangle with an exclamation mark.
  const warnIcon = () => {
    const s = svg(['M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4.5', 'M12 17.2v.1'],
      { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    return s;
  };
  const check = () => svg('M5 12.5l4.5 4.5L19 7.5');
  const dot = () => svg('M12 11.9v.2');

  UI.tab({
    id: 'iossign',
    group: 7,
    order: 92,
    icon: 'phone',
    title: tr('TwinDesk iPhone'),
    desc: tr('Install TwinDesk on an iPhone or iPad from {computer} and keep it from expiring, signed with your own Apple ID.', { computer: here }),
    color: 'linear-gradient(#5e5ce6, #3634a3)',
    hidden: (s) => !(s && s.iosSign),
    badge: (s) => (s && s.iosSign && s.iosSign.run ? 'on' : ''),
    build(body) {
      const { el } = UI;
      const api = () => UI.api;
      const act = (o) => api().iosSign(o);

      const missing = UI.note('warn', '');

      // ---- the switch, then the warning ----
      const onSw = UI.switch((v) => { if (v) { onSw.set(false); act({ a: 'enable' }); } else act({ a: 'set', on: false }); },
        { label: tr('Install TwinDesk and refresh it with the iOS app') });
      const onCard = UI.card('', [UI.row(tr('Install TwinDesk and refresh it with the iOS app'),
        tr('{computer} installs TwinDesk on your iPhone or iPad and signs it again before its 7 days run out, asked by TwinDesk there. Turning this off removes what {computer} kept.', { computer: here }),
        [onSw.el], { literal: true })]);
      const warn = el('div', { class: 'ios-warn', attrs: { role: 'note' } }, [
        warnIcon(),
        el('div', { class: 'body' }, [
          el('div', { class: 'title', text: tr('Not recommended') }),
          el('p', { text: tr('Apple has refused sign-ins from tools like this one, locked Apple IDs for a while, and stopped some from signing apps at all. Use an Apple ID made for this, not your main one.') }),
          el('div', { class: 'alt' }, [
            el('span', { text: tr('We recommend AltStore. If you already use it, keep using it.') }),
            UI.button('altstore.io', () => api().openLink && api().openLink('https://altstore.io'), 'small'),
          ]),
        ]),
      ]);

      // ---- install (at the top when TwinDesk isn't on the device) ----
      const email = el('input', { type: 'email', attrs: { autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Apple ID', placeholder: 'name@example.com' } });
      const pass = el('input', { type: 'password', attrs: { autocomplete: 'off', 'aria-label': tr('Password') } });
      const go = () => {
        if (!email.value.trim() || !pass.value) return;
        act({ a: 'signin', email: email.value.trim(), password: pass.value });
        pass.value = ''; // used once
      };
      pass.onkeydown = (e) => { if (e.key === 'Enter') go(); };
      const installBtn = UI.button(tr('Install'), go, 'primary');
      const ipaBtn = UI.button(tr('Choose an IPA…'), () => api().iosSignIpa(), 'small');
      const ipaClear = UI.button(tr('TwinDesk instead'), () => act({ a: 'ipa' }), 'small');
      const ipaRow = UI.row(tr('App to install'), '', [ipaBtn, ipaClear], { literalHint: true });
      const installHead = UI.row('', '', [], { literal: true });
      const installCard = UI.card(tr('Install TwinDesk'), [
        installHead,
        UI.row('Apple ID', tr('Sent to Apple only, and not kept on {computer}.', { computer: here }), [email], { literal: true }),
        UI.row(tr('Password'), tr('Used once, to sign in. Apple’s developer session that comes back is kept on the iPhone.'), [pass], { literal: true }),
        ipaRow,
        UI.row('', '', [installBtn]),
      ]);

      // ---- the devices ----
      const devList = el('div');
      const lookBtn = UI.button(tr('Look again'), () => act({ a: 'look' }), 'small');
      const devCard = UI.card(tr('iPhone and iPad'), [devList], { actions: [lookBtn] });

      // ---- a run's progress, and Apple's questions ----
      const steps = el('ol', { class: 'ios-steps' });
      const bar = el('div', { class: 'ios-bar' }, [el('div')]);
      const result = el('div', { class: 'ios-result' });
      const stopBtn = UI.button(tr('Stop'), () => act({ a: 'stop' }), 'small');
      const code = el('input', { type: 'text', attrs: { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '8', 'aria-label': tr('Verification code') } });
      const sendCode = () => { if (code.value.trim()) { act({ a: 'answer', code: code.value }); code.value = ''; } };
      code.onkeydown = (e) => { if (e.key === 'Enter') sendCode(); };
      const codeRow = UI.row(tr('Verification code'), tr('Apple sent a code to your devices.'), [code, UI.button(tr('Continue'), sendCode, 'primary'), UI.button(tr('Send again'), () => act({ a: 'answer', resend: true }), 'small')]);
      const certRow = UI.row(tr('No free certificate'), tr('This Apple ID has as many development certificates as Apple allows. Only one TwinDesk made can be revoked here: the apps signed with it stop until they are signed again. The others belong to other tools.'), [UI.button(tr('Cancel'), () => act({ a: 'answer', abort: true }), 'small')]);
      const certList = el('div');
      const phoneAsks = UI.row(tr('Apple asks something'), tr('Answer it on the iPhone.'), [], { literal: true });
      const progCard = UI.card(tr('Progress'), [steps, bar, codeRow, certRow, certList, phoneAsks, result], { actions: [stopBtn] });

      // ---- TwinDesk on the device ----
      const refreshBtn = UI.button(tr('Refresh now'), () => act({ a: 'refresh' }), 'primary');
      const refreshRow = UI.row(tr('TwinDesk'), '', [refreshBtn], { literalHint: true });
      const appList = el('div');
      const refreshCard = UI.card(tr('On the device'), [refreshRow, appList]);

      // ---- automatic refresh ----
      const autoSw = UI.switch((v) => act({ a: 'set', auto: v }));
      const autoRow = UI.row(tr('Refresh automatically'), tr('{computer} asks TwinDesk on the iPhone, over Wi-Fi or, when it’s asleep, Bluetooth.', { computer: here }), [autoSw.el]);
      const daysSel = UI.select([1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: n === 1 ? tr('Less than 1 day') : tr('Less than {count} days', { count: n }) })), (v) => act({ a: 'set', days: Number(v) }));
      const daysRow = UI.row(tr('When an app has left'), '', [daysSel.el]);
      const howSeg = UI.segmented([
        { value: 'self', label: tr('By itself') },
        { value: 'ask', label: tr('Ask first') },
      ], (v) => act({ a: 'set', how: v }));
      const howRow = UI.row(tr('On the iPhone'), '', [howSeg]);
      const whichSel = UI.select([
        { value: 'all', label: tr('TwinDesk and installed IPAs') },
        { value: 'twindesk', label: tr('TwinDesk only') },
      ], (v) => act({ a: 'set', which: v }));
      const whichRow = UI.row(tr('Apps'), tr('Installed IPAs can be refreshed when {computer} keeps them (below).', { computer: here }), [whichSel.el]);
      const retrySel = UI.select([], (v) => act({ a: 'set', retry: Number(v) }));
      const retryRow = UI.row(tr('After one didn’t work, try again'), '', [retrySel.el]);
      const cacheSw = UI.switch((v) => act({ a: 'set', cache: v }));
      const cacheRow = UI.row(tr('Keep installed IPAs on {computer}', { computer: here }), tr('An app installed from an IPA can then be refreshed from here. Switching this off deletes the kept IPAs.'), [cacheSw.el], { literal: true });
      const autoCard = UI.card(tr('Automatic refresh'), [autoRow, daysRow, howRow, whichRow, retryRow, cacheRow]);

      // ---- keep a copy ----
      const keepSw = UI.switch((v) => {
        if (!v) return act({ a: 'set', keep: false });
        keepSw.set(false); // not yet: the warning first
        danger.hidden = false;
      });
      const keepRow = UI.row(tr('Keep a copy on {computer}', { computer: here }), tr('Refreshes without the iPhone’s app: closed, locked or already expired. {computer} asks for its Keychain once, when you turn this on.', { computer: here }), [keepSw.el], { literal: true });
      const danger = el('div', { class: 'ios-warn', hidden: true }, [
        warnIcon(),
        el('div', { class: 'body' }, [
          el('p', { text: tr('{computer} will keep Apple’s developer session and the certificate’s key. Any program running as you can read them, and with them manage this Apple ID’s certificates, app IDs and devices for up to a year. They can’t open iCloud and don’t include your password.', { computer: here }) }),
          el('div', { class: 'alt' }, [
            el('span', { text: tr('Only with an Apple ID made for this.') }),
            el('span', {}, [
              UI.button(tr('Cancel'), () => { danger.hidden = true; }, 'small'),
              UI.button(tr('Keep a copy anyway'), () => { danger.hidden = true; act({ a: 'set', keep: true }); }, 'small'),
            ]),
          ]),
        ]),
      ]);
      const keepCard = UI.card(tr('Without the iPhone’s app'), [keepRow, danger]);

      // ---- how this works ----
      const anisette = el('p');
      const how = el('section', { class: 'ios-how' }, [
        el('h3', { text: tr('How this works') }),
        el('p', { text: tr('An app from outside the App Store runs for 7 days when it is signed with a free Apple ID, and then has to be signed again. AltStore and Sideloadly do that. This does the same from TwinDesk.') }),
        el('p', { text: tr('{computer} signs in to Apple with your Apple ID the way Xcode does, asks Apple for a development certificate named “TwinDesk”, signs the app with it and installs it through the cable or Wi-Fi sync.', { computer: here.charAt(0).toUpperCase() + here.slice(1) }) }),
        el('p', { text: tr('Your password is used once, to sign in, and is not kept. What is kept is Apple’s developer session (about a year; it can manage certificates and app IDs, not iCloud or purchases), the certificate’s key and a device identity, in the Keychain of the iPhone. {computer} keeps none of it unless you turn on Keep a copy.', { computer: here.charAt(0).toUpperCase() + here.slice(1) }) }),
        el('p', { text: tr('When an app is close to running out, {computer} asks TwinDesk on the iPhone, waking it over Bluetooth when it’s asleep. The iPhone refreshes by itself while it’s unlocked, or shows a notification: tap it and the rest happens on its own.', { computer: here }) }),
        anisette,
      ]);

      // Above the devices while TwinDesk isn't on the chosen one; after the options once it is.
      body.append(missing, onCard, warn, installCard, devCard, progCard, refreshCard, autoCard, keepCard, how);

      let devKey = '';
      let appKey = '';
      let certKey = '';
      return (s) => {
        const v = s.iosSign || {};
        const run = v.run;
        const last = v.last || {};
        missing.set(v.available ? '' : tr('The signing helper isn’t part of this build of TwinDesk.'));
        // Off: only the switch, the warning and How this works. The helper isn't even run.
        onCard.hidden = !v.available;
        onSw.set(v.on);
        const on = !!(v.available && v.on);
        for (const c of [installCard, devCard, progCard, refreshCard, autoCard, keepCard]) c.hidden = !on;
        anisette.textContent = tr('The Apple ID and password go to Apple only. One more server is used: an “anisette” server ({server}), which Apple’s sign-in needs. It never gets the Apple ID or the password, but it does hold the identity Apple trusts after your verification code.', { server: v.anisette || 'ani.iloader.app' });
        if (!on) return;

        // ---- the devices ----
        const devs = v.devices || [];
        const near = v.near || [];
        const sess = v.session;
        const dk = JSON.stringify([devs, near, sess, v.udid]);
        if (dk !== devKey) {
          devKey = dk;
          const pick = devs.length > 1;
          const rows = devs.map((d) => {
            const via = [d.usb ? tr('Cable') : '', d.wifi ? tr('Wi-Fi') : ''].filter(Boolean).join(' · ');
            const mine = d.udid === v.udid;
            const r = UI.row(d.name || d.udid, via, [el('span', { class: 'tick', attrs: { 'aria-hidden': 'true' } })], {
              literal: true, onClick: pick ? () => act({ a: 'set', udid: d.udid }) : undefined,
            });
            r.classList.add('ios-dev');
            r.classList.toggle('pick', pick);
            r.classList.toggle('on', mine);
            r.setAttribute('role', pick ? 'radio' : 'listitem');
            if (pick) r.setAttribute('aria-checked', String(mine));
            return r;
          });
          // TwinDesk on an iPhone this computer can't install to right now.
          if (sess && !devs.length) rows.push(UI.row(sess.name, tr('Connected to TwinDesk, but {computer} can’t install to it yet: connect its cable once and tap Trust. After that Wi-Fi is enough with “Show this iPhone when on Wi-Fi” in Finder.', { computer: here }), [], { literal: true }));
          for (const n of near) rows.push(UI.row(n.name, tr('Near, over Bluetooth. TwinDesk there wakes up for a refresh.'), [el('span', { class: 'pill muted', text: 'Bluetooth' })], { literal: true }));
          if (!rows.length) rows.push(UI.row(tr('None found'), tr('Connect the iPhone or iPad with its cable, unlock it and tap Trust. After that Wi-Fi is enough when “Show this iPhone when on Wi-Fi” is on in Finder, or Wi-Fi sync in Apple Devices or iTunes.'), [], { literal: true }));
          if (pick && !v.udid) rows.unshift(UI.row(tr('Choose one'), tr('More than one is here: pick the one this is for.'), [], { literal: true }));
          devList.replaceChildren(...rows);
        }

        // ---- TwinDesk there? ----
        const apps = v.apps || [];
        const td = apps.find((a) => a.twindesk);
        const devName = ((devs.find((d) => d.udid === v.udid) || {}).name) || tr('the device');
        const missingTd = !td;
        // Not found: Install first, at the top. Found: after the options, for an IPA or a fresh install.
        const before = missingTd ? devCard : keepCard;
        if (installCard.nextSibling !== before) body.insertBefore(installCard, before);
        installCard.querySelector('.card-title span').textContent = missingTd ? tr('Install TwinDesk') : tr('Install from {computer}', { computer: here });
        installHead.label.textContent = !v.udid ? (devs.length ? tr('Choose the iPhone or iPad below') : tr('Connect the iPhone or iPad'))
          : missingTd ? tr('TwinDesk isn’t on {device}', { device: devName }) : tr('Install again, or another app');
        installHead.setHint(!v.udid ? tr('Then sign in with the Apple ID to install TwinDesk on it.')
          : missingTd ? tr('Sign in with the Apple ID to install it. After that TwinDesk on the iPhone keeps itself refreshed through {computer}.', { computer: here })
            : tr('Usually not needed: TwinDesk refreshes from the iPhone. For a first install with another Apple ID, or when TwinDesk there has expired.'));
        installBtn.disabled = !!run || !v.udid;
        installBtn.textContent = v.ipa ? tr('Install {name}', { name: v.ipa }) : missingTd ? tr('Install TwinDesk') : tr('Install');
        ipaRow.hidden = !v.anyIpa;
        ipaRow.setHint(v.ipa || 'TwinDesk');
        ipaClear.hidden = !v.ipa;

        // ---- progress ----
        const shown = run || last.done || last.error || last.info;
        progCard.hidden = !shown;
        stopBtn.hidden = !run;
        if (shown) {
          const seen = run ? run.seen || [] : [];
          const now = run ? run.step : '';
          const list = STEPS.filter(([k]) => seen.includes(k) || (run && AHEAD.includes(k) && !seen.includes(k)));
          if (!run) list.length = 0;
          steps.replaceChildren(...list.map(([k, label]) => {
            const state = k === now ? 'now' : seen.includes(k) ? 'done' : '';
            const pct = k === now && (k === 'sign' || k === 'install') && run.percent ? el('span', { class: 'pct', text: `${run.percent}%` }) : null;
            return el('li', { class: state }, [state === 'now' ? el('span', { class: 'ios-spin' }) : state === 'done' ? check() : dot(), el('span', { text: tr(label) }), pct]);
          }));
          steps.hidden = !list.length;
          const pctNow = run && (now === 'sign' || now === 'install') ? run.percent || 0 : 0;
          bar.hidden = !run || !(now === 'sign' || now === 'install');
          bar.firstChild.style.width = `${pctNow}%`;
          if (run) {
            result.hidden = run.from !== 'phone';
            result.className = 'ios-result';
            result.textContent = run.from === 'phone' ? tr('Asked by TwinDesk on the iPhone.') : '';
          } else {
            result.hidden = false;
            result.className = `ios-result ${last.error ? 'bad' : last.done ? 'good' : ''}`;
            const e = last.error;
            result.replaceChildren(...(e ? [el('strong', { text: tr(e.message || 'It didn’t work') }),
              e.detail && e.detail !== e.message ? el('div', { text: tr(e.detail) }) : null, e.code != null ? el('div', { text: tr('Apple’s code: {code}', { code: e.code }) }) : null].filter(Boolean)
              : last.done ? [el('div', { text: tr('Installed on {device}. It runs until {date}.', { device: last.done.device || devName, date: new Date((last.done.expires || 0) * 1000).toLocaleString() }) })]
                : [el('div', { text: tr(last.info) })]));
          }
        }
        const need = run && run.from !== 'phone' ? run.need : null;
        codeRow.hidden = !(need && need.what === 'code');
        certRow.hidden = certList.hidden = !(need && need.what === 'cert');
        phoneAsks.hidden = !(run && run.from === 'phone' && run.need);
        if (need && need.what === 'code' && need.error) codeRow.setHint(need.error);
        const ck = JSON.stringify((need && need.certs) || []);
        if (ck !== certKey) {
          certKey = ck;
          certList.replaceChildren(...((need && need.certs) || []).map((c) => UI.row(c.machine || c.name || c.serial,
            [c.ours ? '' : tr('Not TwinDesk’s: can’t be revoked here'), c.expires ? tr('Until {date}', { date: new Date(c.expires * 1000).toLocaleDateString() }) : ''].filter(Boolean).join(' · '),
            [c.ours ? UI.button(tr('Revoke'), () => act({ a: 'answer', revoke: [c.serial] }), 'small') : null].filter(Boolean), { literal: true })));
        }

        // ---- on the device ----
        refreshCard.hidden = !v.udid && !sess && !near.length;
        const phone = v.phone;
        const kept = v.keep && v.kept && v.kept.signedIn;
        refreshBtn.disabled = !!run || !(kept || (phone && phone.signedIn) || (!sess && near.length));
        refreshRow.setHint(td ? [leftText(td.expires), phone && phone.signedIn ? tr('signed in as {account}', { account: phone.email }) : kept ? tr('{computer} keeps a copy for {account}', { computer: here, account: v.kept.email }) : ''].filter(Boolean).join(' · ')
          : !sess && near.length ? tr('Near over Bluetooth: Refresh now wakes TwinDesk there.')
            : sess && !(phone && phone.signedIn) ? tr('Not signed in on the iPhone: TwinDesk › App refresh there.') : v.udid ? tr('Not installed') : '');
        const ak = JSON.stringify(apps.filter((a) => !a.twindesk)) + Math.floor(Date.now() / 3600000);
        if (ak !== appKey) {
          appKey = ak;
          appList.replaceChildren(...apps.filter((a) => !a.twindesk).map((a) => UI.row(a.name, [a.version, a.teamName].filter(Boolean).join(' · '), [
            a.cached && v.anyIpa ? UI.button(tr('Refresh'), () => act({ a: 'app', bundleId: a.bundleId }), 'small') : null,
            el('span', { class: daysLeft(a.expires) < 2 ? 'pill bad' : 'pill muted', text: leftText(a.expires) }),
          ].filter(Boolean), { literal: true })));
        }

        // ---- automatic refresh ----
        autoSw.set(v.auto);
        daysSel.set(String(v.days || 3));
        howSeg.set(v.how || 'self');
        howRow.setHint(v.how === 'ask' ? tr('A notification there says how long is left. Tap it and the refresh runs.')
          : tr('While the iPhone is unlocked it refreshes on its own; locked, it shows a notification to tap.'));
        whichSel.set(v.which || 'all');
        retrySel.options((v.retries || [1, 3, 6, 12, 24]).map((h) => ({ value: String(h), label: h === 1 ? tr('After 1 hour') : tr('After {count} hours', { count: h }) })));
        retrySel.set(String(v.retry || 6));
        for (const r of [daysRow, howRow, whichRow, retryRow]) r.hidden = !v.auto;
        whichRow.hidden = !v.auto || !v.anyIpa;
        cacheRow.hidden = !v.anyIpa;
        cacheSw.set(v.cache);

        // ---- keep a copy ----
        keepCard.hidden = !v.canKeep;
        keepSw.set(v.keep);
      };
    },
  });
})();

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk iPhone (Mac, PC and Linux): TwinDesk for iPhone and iPad signed with the person's own
// Apple ID and installed from this computer, in place of AltStore or Sideloadly (shared/iossign.js,
// ios-signer/). Opt in, and said plainly. Top to bottom:
//   the switch, and under it (only while off) the warning, with AltStore recommended;
//   on: a run's progress, step by step, with Apple's questions in it (at the top); the iPhones and
//   iPads this computer can reach (cable, Wi-Fi sync, Bluetooth), one picked when there are several;
//   Install TwinDesk when it isn't on the device; TwinDesk on the device and Refresh now; automatic
//   refresh and its options; the encrypted copy of Apple's session (on by default); Reinstall;
//   How this works, as plain paragraphs.
'use strict';

(function () {
  const tr = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
  const mac = /Mac/.test(navigator.platform);
  const linux = /Linux/.test(navigator.platform);
  const here = mac ? tr('this Mac') : linux ? tr('this computer') : tr('this PC');
  const Here = here.charAt(0).toUpperCase() + here.slice(1); // at the start of a sentence

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
    ['find', 'Locating the device'], ['cached', 'Using the stored TwinDesk IPA'], ['download', 'Downloading TwinDesk'], ['signin', 'Signing in to Apple'],
    ['session', 'Restoring the Apple session'], ['register', 'Registering the device'], ['revoke', 'Revoking TwinDesk’s certificate'], ['cert', 'Getting the certificate'],
    ['appid', 'Registering the app ID'], ['profile', 'Getting the provisioning profile'], ['installprofile', 'Installing the provisioning profiles'], ['sign', 'Signing the app'], ['install', 'Installing'],
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

  // The page's picture while off: a phone with TwinDesk on it and a refresh arrow going round it.
  const heroArt = () => {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 160 120');
    const add = (tag, attrs, parent = s) => {
      const n = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      parent.append(n);
      return n;
    };
    const ring = add('g', { class: 'ring' });
    add('path', { d: 'M80 14a46 46 0 0 1 44.6 34.7', class: 'arc' }, ring);
    add('path', { d: 'M126.5 40.5l-1.6 8.6-8.2-3', class: 'arc' }, ring);
    add('path', { d: 'M80 106a46 46 0 0 1-44.6-34.7', class: 'arc' }, ring);
    add('path', { d: 'M33.5 79.5l1.6-8.6 8.2 3', class: 'arc' }, ring);
    add('rect', { x: 62, y: 28, width: 36, height: 64, rx: 7, class: 'phone' });
    add('rect', { x: 73, y: 32, width: 14, height: 3, rx: 1.5, class: 'notch' });
    add('rect', { x: 70, y: 50, width: 20, height: 20, rx: 5, class: 'app' });
    add('path', { d: 'M75.5 60.2l3.2 3.2 6-6.4', class: 'tick' });
    return s;
  };

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
      const store = mac ? tr('the macOS Keychain') : linux ? tr('the system keyring') : tr('Windows Data Protection (DPAPI)');

      // ---- the switch; the warning under it while it's off ----
      const onSw = UI.switch((v) => { if (v) { onSw.set(false); act({ a: 'enable' }); } else act({ a: 'set', on: false }); },
        { label: tr('Install TwinDesk on iOS (free Apple ID) and auto-refresh it with {computer}', { computer: here }) });
      const onCard = UI.card('', [UI.row(tr('Install TwinDesk on iOS (free Apple ID) and auto-refresh it with {computer}', { computer: here }),
        tr('{Computer} installs TwinDesk on your iPhone or iPad and re-signs it before its 7-day provisioning profile expires, on request from the TwinDesk iOS app. Switching this on or off does the same in the iOS app; turning it off deletes all signing data stored on {computer}.', { Computer: Here, computer: here }),
        [onSw.el], { literal: true })]);
      const warn = el('div', { class: 'ios-warn', attrs: { role: 'note' } }, [
        warnIcon(),
        el('div', { class: 'body' }, [
          el('div', { class: 'title', text: tr('Not recommended') }),
          el('p', { text: tr('This feature signs in to Apple with your Apple ID to request development certificates and provisioning profiles. Apple may reject the sign-in, temporarily lock the account, or prevent it from signing apps. Use a dedicated Apple ID rather than your primary account.') }),
          el('div', { class: 'alt' }, [
            el('span', { text: tr('We recommend AltStore for installing and refreshing TwinDesk.') }),
            UI.button('altstore.io', () => api().openLink && api().openLink('https://altstore.io'), 'small'),
          ]),
        ]),
      ]);

      // While off: what it does, drawn (a phone whose app is signed again, round and round), and for
      // anyone new to sideloading, TwinDesk Web, which needs nothing installed or signed.
      const hero = el('div', { class: 'ios-hero', attrs: { 'aria-hidden': 'true' } }, [heroArt()]);
      const webNote = el('div', { class: 'ios-alt' }, [
        el('div', { class: 'body' }, [
          el('div', { class: 'title', text: tr('New to iOS sideloading?') }),
          el('p', { text: tr('Use TwinDesk Web instead. It runs in Safari on the iPhone or iPad, with nothing to install, sign or refresh.') }),
        ]),
        UI.button(tr('Open TwinDesk Web'), () => UI.go('web'), 'small primary'),
      ]);

      // ---- a run's progress (at the top while one runs), and Apple's questions ----
      const steps = el('ol', { class: 'ios-steps' });
      const bar = el('div', { class: 'ios-bar' }, [el('div')]);
      const result = el('div', { class: 'ios-result' });
      const stopBtn = UI.button(tr('Stop'), () => act({ a: 'stop' }), 'small');
      const code = el('input', { type: 'text', attrs: { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '8', 'aria-label': tr('Verification code') } });
      const sendCode = () => { if (code.value.trim()) { act({ a: 'answer', code: code.value }); code.value = ''; } };
      code.onkeydown = (e) => { if (e.key === 'Enter') sendCode(); };
      const codeRow = UI.row(tr('Verification code'), tr('Enter the code Apple sent to your trusted devices.'), [code, UI.button(tr('Continue'), sendCode, 'primary'), UI.button(tr('Resend'), () => act({ a: 'answer', resend: true }), 'small')]);
      const certRow = UI.row(tr('Certificate limit reached'), tr('This Apple ID has the maximum number of development certificates. Revoke one to continue: apps signed with it stop launching until they are signed again. Nothing is revoked unless you choose it here.'), [UI.button(tr('Cancel'), () => act({ a: 'answer', abort: true }), 'small')]);
      const certList = el('div');
      const phoneAsks = UI.row(tr('Action required on the iPhone'), tr('Apple requested additional information. Respond on the iPhone to continue.'), [], { literal: true });
      const progCard = UI.card(tr('Progress'), [steps, bar, codeRow, certRow, certList, phoneAsks, result], { actions: [stopBtn] });

      // ---- the devices ----
      const devList = el('div');
      const lookBtn = UI.button(tr('Search again'), () => act({ a: 'look' }), 'small');
      const devCard = UI.card(tr('Devices'), [devList], { actions: [lookBtn] });

      // ---- install (under the devices; before the options while TwinDesk isn't on the device) ----
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
      const ipaClear = UI.button(tr('Use TwinDesk'), () => act({ a: 'ipa' }), 'small');
      const ipaRow = UI.row(tr('App to install'), '', [ipaBtn, ipaClear], { literalHint: true });
      const installHead = UI.row('', '', [], { literal: true });
      const installCard = UI.card(tr('Install TwinDesk'), [
        installHead,
        UI.row('Apple ID', tr('Sent only to Apple. Not stored on {computer}.', { computer: here }), [email], { literal: true }),
        UI.row(tr('Password'), tr('Used once to sign in and never stored.'), [pass], { literal: true }),
        ipaRow,
        UI.row('', '', [installBtn]),
      ]);

      // ---- TwinDesk on the device ----
      const refreshBtn = UI.button(tr('Refresh now'), () => act({ a: 'refresh' }), 'primary');
      const refreshRow = UI.row(tr('TwinDesk'), '', [refreshBtn], { literalHint: true });
      // A newer release than the TwinDesk on the device: signed and installed over it (its data stays).
      const updateBtn = UI.button(tr('Update'), () => act({ a: 'update' }), 'primary');
      const updateRow = UI.row(tr('Update TwinDesk'), '', [updateBtn], { literalHint: true });
      const appList = el('div');
      const refreshCard = UI.card(tr('Installed apps'), [refreshRow, updateRow, appList]);

      // ---- automatic refresh ----
      const autoSw = UI.switch((v) => act({ a: 'set', auto: v }));
      const autoRow = UI.row(tr('Refresh automatically'), tr('{computer} sends refresh requests to TwinDesk on the iPhone over Wi-Fi, or over Bluetooth when the app is suspended.', { computer: Here }), [autoSw.el]);
      const daysSel = UI.select([1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: n === 1 ? tr('Less than 1 day') : tr('Less than {count} days', { count: n }) })), (v) => act({ a: 'set', days: Number(v) }));
      const daysRow = UI.row(tr('Refresh when the remaining time is'), '', [daysSel.el]);
      const howSeg = UI.segmented([
        { value: 'self', label: tr('Automatic') },
        { value: 'ask', label: tr('Ask first') },
      ], (v) => act({ a: 'set', how: v }));
      const howRow = UI.row(tr('Confirmation on the iPhone'), '', [howSeg]);
      const whichSel = UI.select([
        { value: 'all', label: tr('TwinDesk and installed IPAs') },
        { value: 'twindesk', label: tr('TwinDesk only') },
      ], (v) => act({ a: 'set', which: v }));
      const whichRow = UI.row(tr('Apps'), tr('Other apps get new profiles; their stored IPA is used only if they must be signed again.'), [whichSel.el]);
      const retrySel = UI.select([], (v) => act({ a: 'set', retry: Number(v) }));
      const retryRow = UI.row(tr('Retry after a failed refresh'), '', [retrySel.el]);
      const cacheSw = UI.switch((v) => act({ a: 'set', cache: v }));
      const cacheRow = UI.row(tr('Store IPAs on {computer}', { computer: here }), tr('Each IPA installed from here is kept, so TwinDesk and other apps are signed again from it instead of being downloaded again. Turning this off deletes the stored IPAs.'), [cacheSw.el], { literal: true });
      const updSw = UI.switch((v) => act({ a: 'set', update: v }));
      const updAutoRow = UI.row(tr('Update TwinDesk automatically'), tr('When a new release is out, {computer} signs and installs it on the device the same way as a refresh. The app and its data stay.', { computer: Here }), [updSw.el]);
      const autoCard = UI.card(tr('Automatic refresh'), [autoRow, daysRow, howRow, whichRow, retryRow, updAutoRow, cacheRow]);

      // ---- keep a copy (on by default) ----
      const keepSw = UI.switch((v) => act({ a: 'set', keep: v }));
      // Said as it is: the Keychain limits the item to TwinDesk; DPAPI and the keyring only to the user account.
      const scope = mac ? tr('Other apps cannot read it without your permission.')
        : tr('Other apps running under your user account can decrypt it.');
      const keepRow = UI.row(tr('Keep a copy of the Apple developer session on {computer} (encrypted)', { computer: here }),
        tr('Allows refreshes when the iOS app is closed, locked or expired. Encrypted with {store}. {scope} The session can manage this Apple ID’s certificates, app IDs and devices for up to a year; it cannot access iCloud and does not include your password. Turning this off deletes the copy.', { store, scope }),
        [keepSw.el], { literal: true });
      const idsBtn = UI.button(tr('View app IDs'), () => act({ a: 'appids' }), 'small');
      const idsRow = UI.row(tr('App IDs'), '', [idsBtn], { literalHint: true });
      const idsList = el('div');
      const keepCard = UI.card(tr('Apple developer account'), [keepRow, idsRow, idsList]);

      // ---- how this works ----
      const anisette = el('p');
      const how = el('details', { class: 'ios-how' }, [
        el('summary', { text: tr('How this works') }),
        el('p', { text: tr('Apps installed outside the App Store with a free Apple ID use a provisioning profile that is valid for 7 days, after which they must be signed again. AltStore and Sideloadly automate this; this feature does the same from TwinDesk.') }),
        el('p', { text: tr('{computer} authenticates with Apple through the same developer services Xcode uses, requests a development certificate named “TwinDesk”, registers the device and the app ID, signs the app and installs it over USB or Wi-Fi sync.', { computer: Here }) }),
        el('p', { text: tr('A refresh, like AltStore’s, only installs Apple’s new provisioning profiles: the app and its data stay as they are. The app is signed and installed again only when its certificate has changed.') }),
        el('p', { text: tr('Your password is used only to sign in and is never stored. Apple returns a developer session valid for about a year, which can manage certificates, app IDs and devices but cannot access iCloud or purchases. The session, the certificate’s private key and a device identity are stored in the iPhone’s Keychain and, with Keep a copy on, encrypted on {computer}.', { computer: here }) }),
        el('p', { text: tr('When an app approaches expiry, {computer} sends a refresh request to TwinDesk on the iPhone, waking it over Bluetooth if necessary. The iPhone refreshes while it is unlocked; otherwise it shows a notification, and tapping it starts the refresh.', { computer: here }) }),
        anisette,
      ]);

      body.append(missing, onCard, hero, warn, webNote, progCard, devCard, installCard, refreshCard, autoCard, keepCard, how);

      let devKey = '';
      let appKey = '';
      let certKey = '';
      let idsKey = '';
      return (s) => {
        const v = s.iosSign || {};
        const run = v.run;
        const last = v.last || {};
        missing.set(v.available ? '' : tr('The signing helper is not included in this build of TwinDesk.'));
        // Off: only the switch, the warning and How this works. The helper isn't even run.
        onCard.hidden = !v.available;
        onSw.set(v.on);
        const on = !!(v.available && v.on);
        warn.hidden = hero.hidden = webNote.hidden = on;
        for (const c of [installCard, devCard, progCard, refreshCard, autoCard, keepCard]) c.hidden = !on;
        anisette.textContent = tr('Your Apple ID and password are sent only to Apple. Apple’s sign-in also requires an anisette server ({server}). It never receives your credentials, but it does hold the device identity Apple trusts after two-factor verification.', { server: v.anisette || 'ani.iloader.app' });
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
          if (sess && !devs.length) rows.push(UI.row(sess.name, tr('Connected to TwinDesk but not available for installation. Connect it to {computer} by cable once and tap Trust; Wi-Fi sync then works without the cable.', { computer: here }), [], { literal: true }));
          for (const n of near) rows.push(UI.row(n.name, tr('Nearby over Bluetooth — for automatic refresh only. To install TwinDesk for the first time, connect by cable and tap Trust.'), [el('span', { class: 'pill muted', text: 'Bluetooth' })], { literal: true }));
          if (near.length && !devs.length) rows.push(UI.row(tr('No cable connection'), !mac && !linux ? tr('Connect by cable, unlock it and tap Trust. Install Apple Devices or iTunes from the Microsoft Store if the iPhone or iPad is not detected.') : tr('Connect by cable, unlock it and tap Trust. Wi-Fi sync then works without the cable.'), [], { literal: true }));
          if (!rows.length) rows.push(UI.row(tr('No devices found'), !mac && !linux ? tr('Connect the iPhone or iPad by cable, unlock it and tap Trust. Install Apple Devices or iTunes from the Microsoft Store if it is not detected. Wi-Fi sync then works without the cable.') : tr('Connect the iPhone or iPad by cable, unlock it and tap Trust. It is then also reachable over Wi-Fi if Wi-Fi sync is enabled in Finder, Apple Devices or iTunes.'), [], { literal: true }));
          if (pick && !v.udid) rows.unshift(UI.row(tr('Select a device'), tr('Several devices are available. Select the one to install to.'), [], { literal: true }));
          devList.replaceChildren(...rows);
        }

        // ---- TwinDesk there? ----
        const apps = v.apps || [];
        const td = apps.find((a) => a.twindesk);
        const devName = ((devs.find((d) => d.udid === v.udid) || {}).name) || tr('the device');
        const missingTd = !td;
        // Not found: Install right under the devices. Found: after the options, for an IPA or a reinstall.
        const before = missingTd ? refreshCard : how;
        if (installCard.nextSibling !== before) body.insertBefore(installCard, before);
        installCard.querySelector('.card-title span').textContent = missingTd ? tr('Install TwinDesk') : tr('Reinstall');
        installHead.label.textContent = !v.udid ? (devs.length ? tr('Select a device above') : tr('No device connected'))
          : missingTd ? tr('TwinDesk is not installed on {device}', { device: devName }) : tr('Reinstall TwinDesk or install another app');
        installHead.setHint(!v.udid ? tr('Then sign in with your Apple ID to install TwinDesk.')
          : missingTd ? tr('Sign in with your Apple ID to install it. The TwinDesk iOS app then requests future refreshes through {computer}.', { computer: here })
            : tr('Not normally required, as TwinDesk refreshes itself through the iOS app. Use this for a first install with a different Apple ID, or if the app has expired.'));
        installBtn.disabled = !!run || !v.udid;
        installBtn.textContent = v.ipa ? tr('Install {name}', { name: v.ipa }) : missingTd ? tr('Install TwinDesk') : tr('Install');
        ipaRow.hidden = !v.anyIpa;
        ipaRow.setHint(v.ipa || 'TwinDesk');
        ipaClear.hidden = !v.ipa;

        // ---- progress ----
        const shown = run || last.done || last.error || last.info;
        progCard.hidden = !shown;
        // Running: at the top, under the switch. Finished: its result stays above the devices too.
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
            result.className = 'ios-result';
            result.textContent = [run.from === 'phone' ? tr('Requested by TwinDesk on the iPhone.') : '', run.note ? tr(run.note) : ''].filter(Boolean).join(' ');
            result.hidden = !result.textContent;
          } else {
            result.hidden = false;
            result.className = `ios-result ${last.error ? 'bad' : last.done ? 'good' : ''}`;
            const e = last.error;
            result.replaceChildren(...(e ? [el('strong', { text: tr(e.message || 'The operation failed') }),
              e.detail && e.detail !== e.message ? el('div', { text: tr(e.detail) }) : null, e.code != null ? el('div', { text: tr('Apple error code: {code}', { code: e.code }) }) : null].filter(Boolean)
              : last.done ? [el('div', { text: tr(last.done.profileOnly ? 'Refreshed on {device} without reinstalling. Valid until {date}.' : 'Installed on {device}. Valid until {date}.', { device: last.done.device || devName, date: new Date((last.done.expires || 0) * 1000).toLocaleString() }) })]
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
          // TwinDesk's own first; another tool's asks for confirmation before it goes (the app's dialog).
          const certs = ((need && need.certs) || []).slice().sort((p, q) => (q.ours ? 1 : 0) - (p.ours ? 1 : 0));
          certList.replaceChildren(...certs.map((c) => UI.row(c.machine || c.name || c.serial,
            [c.ours ? tr('Created by TwinDesk') : tr('Created by another tool: the apps it signed stop launching'), c.expires ? tr('Until {date}', { date: new Date(c.expires * 1000).toLocaleDateString() }) : ''].filter(Boolean).join(' · '),
            [UI.button(tr('Revoke'), () => act({ a: 'answer', revoke: [c.serial] }), c.ours ? 'small' : 'small danger')], { literal: true })));
        }

        // ---- on the device ----
        refreshCard.hidden = !v.udid && !sess && !near.length;
        const phone = v.phone;
        const kept = v.keep && v.kept && v.kept.signedIn;
        refreshBtn.disabled = !!run || !(kept || (phone && phone.signedIn) || (!sess && near.length));
        refreshRow.setHint(td ? [leftText(td.expires), phone && phone.signedIn ? tr('Apple ID: {account}', { account: phone.email }) : kept ? tr('Session stored on {computer} for {account}', { computer: here, account: v.kept.email }) : ''].filter(Boolean).join(' · ')
          : !sess && near.length ? tr('Nearby over Bluetooth. Refresh now wakes TwinDesk on the device.')
            : sess && !(phone && phone.signedIn) ? tr('Not signed in. Sign in on the iPhone under TwinDesk › App refresh.') : v.udid ? tr('Not installed') : '');
        const up = v.update;
        updateRow.hidden = !up;
        updateBtn.disabled = !!run || !(kept || (phone && phone.signedIn));
        if (up) updateRow.setHint(tr('{latest} is available. {device} has {version}.', { latest: up.latest, version: up.version, device: devName }));
        const ak = JSON.stringify([apps.filter((a) => !a.twindesk), v.anyIpa, !!(kept || (phone && phone.signedIn))]) + Math.floor(Date.now() / 3600000);
        if (ak !== appKey) {
          appKey = ak;
          appList.replaceChildren(...apps.filter((a) => !a.twindesk).map((a) => UI.row(a.name, [a.version, a.teamName].filter(Boolean).join(' · '), [
            // No stored IPA needed: new profiles are enough unless it has to be signed again.
            v.anyIpa && (kept || (phone && phone.signedIn)) ? UI.button(tr('Refresh'), () => act({ a: 'app', bundleId: a.bundleId }), 'small') : null,
            el('span', { class: daysLeft(a.expires) < 2 ? 'pill bad' : 'pill muted', text: leftText(a.expires) }),
          ].filter(Boolean), { literal: true })));
        }

        // ---- automatic refresh ----
        autoSw.set(v.auto);
        updSw.set(!!v.autoUpdate);
        daysSel.set(String(v.days || 3));
        howSeg.set(v.how || 'self');
        howRow.setHint(v.how === 'ask' ? tr('The iPhone shows a notification with the remaining time. Tapping it starts the refresh.')
          : tr('Refreshes without confirmation while the iPhone is unlocked. When it is locked, a notification is shown instead.'));
        whichSel.set(v.which || 'all');
        retrySel.options((v.retries || [1, 3, 6, 12, 24]).map((h) => ({ value: String(h), label: h === 1 ? tr('After 1 hour') : tr('After {count} hours', { count: h }) })));
        retrySel.set(String(v.retry || 6));
        for (const r of [daysRow, howRow, whichRow, retryRow]) r.hidden = !v.auto;
        whichRow.hidden = !v.auto || !v.anyIpa;
        cacheSw.set(v.cache);

        // ---- keep a copy, app IDs ----
        keepRow.hidden = !v.canKeep;
        keepSw.set(v.keep);
        const ids = v.ids;
        const canIds = !!(v.keep && v.kept && v.kept.signedIn);
        idsBtn.disabled = !canIds || !!(ids && ids.loading);
        idsBtn.textContent = ids && ids.list ? tr('Reload') : tr('View app IDs');
        idsRow.setHint(ids && ids.loading ? tr('Loading from Apple…')
          : ids && ids.error ? tr(ids.error)
            : ids && ids.list ? [tr('{count} registered', { count: ids.list.length }), ids.available != null ? tr('{count} more can be created this week', { count: ids.available }) : '', ids.teamName ? tr('Team: {team}', { team: ids.teamName }) : ''].filter(Boolean).join(' · ')
              : canIds ? tr('The app IDs registered for this Apple ID. Free accounts can create 10 app IDs per 7 days.')
                : tr('Requires the developer session stored on {computer}.', { computer: here }));
        const ik = JSON.stringify(ids && ids.list || []);
        if (ik !== idsKey) {
          idsKey = ik;
          idsList.replaceChildren(...((ids && ids.list) || []).map((a) => UI.row(a.name || a.id, a.id, [
            a.expires ? el('span', { class: daysLeft(a.expires) < 2 ? 'pill bad' : 'pill muted', text: leftText(a.expires) }) : null,
          ].filter(Boolean), { literal: true })));
        }
      };
    },
  });
})();

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// iPhone app signing (Mac, PC and Linux): TwinDesk for iPhone and iPad signed with the person's own
// Apple ID and installed from this computer, in place of AltStore or Sideloadly (shared/iossign.js,
// ios-signer/). Opt in, and said plainly: what it does, where the Apple ID goes, what can go wrong.
//   The iPhone or iPad the computer sees and what's sideloaded on it, each with the day it runs out.
//   Refresh now, and by itself when TwinDesk there has few days left.
//   Install from this computer: the Apple ID typed here, for the first install or an expired app.
//   Keep a copy on this computer: off, behind a warning.
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
  const STEPS = {
    start: 'Starting…', download: 'Downloading TwinDesk…', signin: 'Signing in to Apple…', session: 'Opening the Apple session…',
    signedin: 'Signed in', register: 'Registering the device…', sign: 'Signing…', install: 'Installing…',
  };

  UI.tab({
    id: 'iossign',
    group: 7,
    order: 92,
    icon: 'phone',
    title: tr('iPhone app signing'),
    desc: tr('Install and refresh TwinDesk on an iPhone or iPad from {computer}, signed with your own Apple ID.', { computer: here }),
    color: 'linear-gradient(#5e5ce6, #3634a3)',
    hidden: (s) => !(s && s.iosSign),
    badge: (s) => (s && s.iosSign && s.iosSign.run ? 'on' : ''),
    build(body) {
      const { el } = UI;
      const api = () => UI.api;
      const act = (o) => api().iosSign(o);
      const para = (text) => el('p', { text });

      // ---- what this is ----
      const missing = UI.note('warn', '');
      const how = UI.card(tr('How this works'), [el('div', { class: 'note info' }, [
        para(tr('An app from outside the App Store runs on an iPhone for 7 days when it is signed with a free Apple ID, and then has to be signed again. AltStore and Sideloadly do that. This does the same from TwinDesk.')),
        para(tr('It signs in to Apple with your Apple ID the way Xcode does, asks Apple for a development certificate named “TwinDesk”, signs the app with it and installs it through the cable or Wi-Fi sync.')),
        para(tr('Your password is used once, to sign in, and is not kept anywhere. What is kept is Apple’s developer session (about a year; it can manage certificates and app IDs, not iCloud or purchases), the certificate’s key and a device identity. They are kept in the Keychain of the iPhone, not on this computer.')),
        para(tr('The Apple ID and password go to Apple only. One more server is used: an “anisette” server ({server}), which Apple’s sign-in needs. It never gets the Apple ID or the password, but it does hold the identity Apple trusts after your verification code.', { server: '' })),
      ])]);
      const anisetteLine = how.querySelector('p:last-child');
      const risks = UI.note('warn', tr('Apple doesn’t support this. Sign-ins from tools like this one have been refused, accounts have been locked for a while, and some Apple IDs can no longer sign apps at all. Use an Apple ID made for this, not your main one. If you’d rather not, use TwinDesk Web in Safari, or AltStore.'));

      // ---- the device and its apps ----
      const devSel = UI.select([], (v) => act({ a: 'set', udid: v }));
      const devRow = UI.row(tr('iPhone or iPad'), '', [devSel.el, UI.button(tr('Look again'), () => act({ a: 'look' }), 'small')], { literalHint: true });
      const appList = el('div');
      const devCard = UI.card(tr('On the device'), [devRow, appList]);

      // ---- refresh ----
      const status = UI.note('info', '');
      const refreshBtn = UI.button(tr('Refresh now'), () => act({ a: 'refresh' }), 'primary');
      const stopBtn = UI.button(tr('Stop'), () => act({ a: 'stop' }), 'small');
      const refreshRow = UI.row(tr('TwinDesk on the device'), '', [refreshBtn, stopBtn], { literalHint: true });
      const autoSw = UI.switch((v) => act({ a: 'set', auto: v }));
      const daysSel = UI.select([1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: tr('{count} days left', { count: n }) })), (v) => act({ a: 'set', days: Number(v) }));
      const autoRow = UI.row(tr('Refresh automatically'), tr('When TwinDesk on the device has this long left and it is connected.'), [daysSel.el, autoSw.el]);
      const refreshCard = UI.card(tr('Refresh'), [refreshRow, autoRow]);

      // ---- a question from a run answered here ----
      const code = el('input', { type: 'text', attrs: { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '8', 'aria-label': tr('Verification code') } });
      const sendCode = () => { if (code.value.trim()) { act({ a: 'answer', code: code.value }); code.value = ''; } };
      code.onkeydown = (e) => { if (e.key === 'Enter') sendCode(); };
      const codeRow = UI.row(tr('Verification code'), tr('Apple sent a code to your devices.'), [code, UI.button(tr('Continue'), sendCode, 'primary'), UI.button(tr('Send again'), () => act({ a: 'answer', resend: true }), 'small')]);
      const certList = el('div');
      const certRow = UI.row(tr('No free certificate'), tr('This Apple ID has as many development certificates as it may. Revoking one stops the apps signed with it until they are signed again.'), [UI.button(tr('Cancel'), () => act({ a: 'answer', abort: true }), 'small')]);
      const askCard = UI.card(tr('Apple asks'), [codeRow, certRow, certList]);

      // ---- typed here ----
      const email = el('input', { type: 'email', attrs: { autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Apple ID' } });
      const pass = el('input', { type: 'password', attrs: { autocomplete: 'off', 'aria-label': tr('Password') } });
      const go = () => {
        if (!email.value.trim() || !pass.value) return;
        act({ a: 'signin', email: email.value.trim(), password: pass.value });
        pass.value = ''; // used once
      };
      pass.onkeydown = (e) => { if (e.key === 'Enter') go(); };
      const installBtn = UI.button(tr('Sign in and install'), go, 'primary');
      const ipaBtn = UI.button(tr('Choose an IPA…'), () => api().iosSignIpa(), 'small');
      const ipaClear = UI.button(tr('TwinDesk instead'), () => act({ a: 'ipa' }), 'small');
      const ipaRow = UI.row(tr('App to install'), '', [ipaBtn, ipaClear], { literalHint: true });
      const hereCard = UI.card(tr('Install from {computer}', { computer: here }), [
        UI.row('Apple ID', tr('For the first install, or when TwinDesk on the device has expired and can’t answer. Typed here, sent to Apple, not kept.'), [email], { literal: true, literalHint: false }),
        UI.row(tr('Password'), '', [pass]),
        ipaRow,
        UI.row('', '', [installBtn]),
      ]);

      // ---- keep a copy ----
      const keepSw = UI.switch((v) => {
        if (!v) return act({ a: 'set', keep: false });
        keepSw.set(false); // not yet: the warning first
        danger.hidden = false;
      });
      const keepRow = UI.row(tr('Keep a copy on {computer}', { computer: here }), tr('Refreshes without the iPhone’s app: closed, locked or already expired.'), [keepSw.el]);
      const danger = el('div', { class: 'note bad', hidden: true }, [
        el('div', { text: tr('Danger: {computer} will keep Apple’s developer session and the certificate’s key. Any program running as you on this computer can read them, and with them manage this Apple ID’s certificates, app IDs and registered devices for up to a year. They can’t open iCloud and don’t include your password. Only turn this on with an Apple ID made for this.', { computer: here }) }),
        el('div', {}, [
          UI.button(tr('Keep a copy anyway'), () => { danger.hidden = true; act({ a: 'set', keep: true }); }, 'small'),
          UI.button(tr('Cancel'), () => { danger.hidden = true; }, 'small'),
        ]),
      ]);
      const keepCard = UI.card(tr('Without the iPhone’s app'), [keepRow, danger]);

      body.append(missing, risks, devCard, status, refreshCard, askCard, hereCard, keepCard, how);

      let appKey = '';
      let certKey = '';
      return (s) => {
        const v = s.iosSign || {};
        const run = v.run;
        const need = run && run.from !== 'phone' ? run.need : null;
        missing.set(v.available ? '' : tr('The signing helper isn’t part of this build of TwinDesk.'));
        for (const c of [devCard, refreshCard, hereCard, keepCard, status]) c.hidden = !v.available;
        askCard.hidden = !need;
        if (!v.available) return;
        anisetteLine.textContent = tr('The Apple ID and password go to Apple only. One more server is used: an “anisette” server ({server}), which Apple’s sign-in needs. It never gets the Apple ID or the password, but it does hold the identity Apple trusts after your verification code.', { server: v.anisette || '' });

        // the device
        const devs = v.devices || [];
        devSel.options((devs.length ? devs : [{ udid: '', name: tr('None found') }]).map((d) => ({ value: d.udid, label: d.name || d.udid })));
        if (v.udid) devSel.set(v.udid);
        devSel.el.disabled = devs.length < 2;
        devRow.setHint(!devs.length ? tr('Connect it with its cable once, unlock it and tap Trust. After that Wi-Fi is enough when “Show this iPhone when on Wi-Fi” is on in Finder, or Wi-Fi sync in Apple Devices or iTunes.')
          : !v.udid ? tr('More than one is here: choose the one this is for.') : '');
        const apps = v.apps || [];
        const ak = JSON.stringify(apps) + Math.floor(Date.now() / 3600000);
        if (ak !== appKey) {
          appKey = ak;
          appList.replaceChildren(...apps.map((a) => UI.row(a.name, [a.version, a.teamName].filter(Boolean).join(' · '), [el('span', { class: daysLeft(a.expires) < 2 ? 'pill bad' : 'pill muted', text: leftText(a.expires) })], { literal: true })));
        }

        // refresh
        const td = apps.find((a) => a.twindesk);
        const phone = v.phone;
        const kept = v.keep && v.kept && v.kept.signedIn;
        const canRefresh = !run && !!v.udid && (kept || (phone && phone.signedIn));
        refreshBtn.disabled = !canRefresh;
        stopBtn.hidden = !run;
        refreshRow.setHint(td ? leftText(td.expires) : v.udid ? tr('Not installed') : '');
        autoSw.set(v.auto);
        daysSel.set(String(v.days || 3));
        daysSel.el.disabled = !v.auto;
        const last = v.last || {};
        status.className = `note ${run ? 'info' : last.error ? 'bad' : 'info'}`;
        status.set(run ? [run.from === 'phone' ? tr('The iPhone asked for a refresh.') : '', tr(STEPS[run.step] || 'Working…'), run.step === 'install' && run.percent ? `${run.percent}%` : ''].filter(Boolean).join(' ')
          : last.error ? [tr(last.error.message || 'It didn’t work'), last.error.detail && last.error.detail !== last.error.message ? last.error.detail : '', last.error.code != null ? `(${last.error.code})` : ''].filter(Boolean).join(' ')
            : last.done ? tr('Installed. It runs until {date}.', { date: new Date((last.done.expires || 0) * 1000).toLocaleString() })
              : v.pending ? tr('Signed. Open TwinDesk on the iPhone and connect it: it takes over the signing state from here.')
                : kept ? tr('{computer} keeps a copy for {account}.', { computer: here, account: v.kept.email })
                  : phone && phone.signedIn ? tr('The iPhone is signed in as {account}.', { account: phone.email })
                    : tr('Not signed in. Sign in on the iPhone (TwinDesk › App signing), or install from here below.'));

        // Apple asks
        codeRow.hidden = !(need && need.what === 'code');
        certRow.hidden = certList.hidden = !(need && need.what === 'cert');
        if (need && need.what === 'code' && need.error) codeRow.setHint(need.error);
        const ck = JSON.stringify((need && need.certs) || []);
        if (ck !== certKey) {
          certKey = ck;
          certList.replaceChildren(...((need && need.certs) || []).map((c) => UI.row(c.machine || c.name || c.serial, c.expires ? new Date(c.expires * 1000).toLocaleDateString() : '', [UI.button(tr('Revoke'), () => act({ a: 'answer', revoke: [c.serial] }), 'small')], { literal: true })));
        }

        // typed here
        installBtn.disabled = !!run || !v.udid;
        ipaRow.hidden = !v.anyIpa;
        ipaRow.setHint(v.ipa || 'TwinDesk');
        ipaClear.hidden = !v.ipa;

        // keep a copy
        keepCard.hidden = !v.canKeep;
        keepSw.set(v.keep);
      };
    },
  });
})();

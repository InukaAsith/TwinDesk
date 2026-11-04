// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The connected phone's wireless debugging (Mac, PC and Linux), on the Connection page: its state,
// the steps to turn it on, pairing with the phone's code (typed here or in TwinDesk's notification
// there) or its QR code, and the full app over the standard one. Was on the Phone page.
// UI.adbCard() → {el, update(state)}; the card hides itself without a connected phone.
'use strict';

// Translate only application-owned wrappers; native details and device names stay literal.
UI.adbMessage = (message, device) => {
  const t = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
  const text = message || '';
  if (device && text === `Installing on ${device}…`) return t('Installing on {device}…', { device });
  const pairing = /^Pairing didn’t work \(([\s\S]*)\)\. Try a new code\.$/.exec(text);
  if (pairing) return t('Pairing didn’t work ({error}). Try a new code.', { error: pairing[1] });
  const stopped = /^The phone connection stopped \(([\s\S]*)\)\.$/.exec(text);
  if (stopped) return t('The phone connection stopped ({error}).', { error: stopped[1] });
  const install = /^Couldn’t install \(([\s\S]*)\)$/.exec(text);
  return install ? t('Couldn’t install ({error})', { error: t(install[1]) }) : t(text);
};

UI.adbCard = () => {
  const { el, api } = UI;
  const t = (text, vars) => window.I18n ? window.I18n.t(text, vars) : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
  const STATES = {
    ready: ['good', t('Ready')], connecting: ['muted', t('Connecting…')], needsPair: ['bad', t('Not paired')],
    waitingWifi: ['bad', t('Off')], missing: ['bad', t('Missing')], error: ['bad', t('Problem')], off: ['muted', '—'],
    idle: ['muted', t('Not in use')], // everything is set to Limited (Native, shared/phonemodes.js): nothing switches it on or asks
  };
  const pill = el('span', { class: 'pill muted' });
  const retry = UI.button(t('Try Again'), () => api.phoneRetry(), 'small');
  const row = UI.row(t('Wireless debugging'), '', [pill, retry], { literal: true });
  let howOpen = false;
  const howBtn = UI.button(t('Show steps'), () => { howOpen = !howOpen; UI.state && update(UI.state); }, 'small');
  row.querySelector('.controls').prepend(howBtn);
  const how = el('ol', { class: 'how-steps' }, [
    t('On the phone, open Settings › About phone and tap Build number seven times.'),
    t('Open Settings › Developer options and turn on USB debugging.'),
    t('Turn on Wireless debugging on the same page. The phone needs a Wi-Fi network.'),
    t('Tap Pair device with pairing code and enter the code below, or tap Pair device with QR code and scan the QR code here.'),
    t('After the first pairing, TwinDesk turns wireless debugging on by itself.'),
  ].map((t) => el('li', { text: t })));

  const code = el('input', { type: 'text', placeholder: '123456', maxLength: 7, inputMode: 'numeric', autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': t('Pairing code') } });
  const where = el('input', { type: 'text', placeholder: t('Address:port (optional)'), autocomplete: 'off', spellcheck: false, attrs: { 'aria-label': t('Pairing address') } });
  const pairBtn = UI.button(t('Pair'), () => api.phonePair({ code: code.value.replace(/\D/g, ''), where: where.value }), 'small primary'); // "123 456", "123-456" too
  code.onkeydown = where.onkeydown = (e) => { if (e.key === 'Enter') pairBtn.click(); };
  const pairRow = UI.row(t('Pairing code'), t('From the phone’s Pair device with pairing code, or type it in TwinDesk’s notification there'), [code, where, pairBtn]);

  // Android's own Pair device with QR code (shared/adbqr.js): only where this computer can do it.
  const qr = UI.adbQr ? UI.adbQr() : null;

  const fullBtn = UI.button(t('Install'), () => api.phoneInstallFull(), 'small primary');
  const fullRow = UI.row(t('Notifications from the phone'), '', [fullBtn], { literal: true });
  const steps = UI.note('info', '');
  const card = UI.card(t('Wireless debugging'), [row, how, pairRow].concat(qr ? [qr.el] : [], [steps, fullRow]));

  function update(s) {
    const ph = s.phone || {};
    const c = ph.connected;
    card.hidden = !c;
    if (!c) return;
    const br = ph.bridge || { state: 'off' };
    const ready = br.state === 'ready';
    const off = br.state === 'waitingWifi';
    const [cls, label] = STATES[br.state] || STATES.off;
    pill.className = 'pill ' + (ready && br.inputBlocked ? 'bad' : cls);
    pill.textContent = ready && br.inputBlocked ? t('Touch blocked') : label;
    retry.hidden = ready;
    retry.textContent = br.state === 'idle' ? t('Set Up') : t('Try Again');
    row.setHint(off ? (/direct Wi-Fi/.test(br.message) ? t(br.message) : t('Off on the phone. Mirroring and ADB control need it; Accessibility control doesn’t.'))
      : ready && br.inputBlocked ? t('The screen works, but this Xiaomi blocks input. On the phone: Developer options › USB debugging (Security settings).')
        : ready ? t('Screen, apps, touch and keyboard, and the clipboard in the background')
          : br.state === 'idle' ? t('Not needed now: the mouse and keyboard, the screen and the sound are set to Limited. Set it up for Full (ADB), phone apps in windows and the camera.')
            : UI.adbMessage(br.message));
    const pairable = br.state === 'needsPair' || !!br.canPair;
    howBtn.hidden = ready;
    howBtn.textContent = howOpen ? t('Hide steps') : t('Show steps');
    how.hidden = ready || !howOpen;
    pairRow.hidden = !pairable;
    steps.set(br.state === 'needsPair' ? t('TwinDesk pairs with the phone’s wireless debugging once. After that, mirroring, phone apps and ADB control work without this step.') : '');
    if (qr) qr.update(s, pairable);
    if (UI.adbBle && UI.adbBle(s, card, row, pill)) {
      steps.set('');
      pairRow.hidden = how.hidden = howBtn.hidden = true;
      if (qr) qr.el.hidden = true;
    }

    // The standard build can't read notifications (Play Protect blocks downloaded apps that do).
    const full = !ph.adb || ph.adb.full !== false;
    const inst = br.install;
    fullRow.hidden = full && !(inst && inst.state === 'done');
    fullBtn.hidden = full;
    fullBtn.disabled = !ready || !br.fullApk || (inst && inst.state === 'installing');
    fullRow.setHint(inst && inst.state !== 'failed' && inst.message ? UI.adbMessage(inst.message, c.name)
      : !br.fullApk ? t('This build of TwinDesk doesn’t include the Android app.')
        : (() => {
          let message = t('The downloaded app can’t read notifications. Install the full app over it; settings and pairing stay.');
          if (!ready) message = t('{message} Needs wireless debugging.', { message });
          return inst && inst.state === 'failed' ? t('{error} {hint}', { error: UI.adbMessage(inst.message, c.name), hint: message }) : message;
        })());
  }
  return { el: card, update };
};

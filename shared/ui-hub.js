// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What the Calls, Messages, Photos and Files pages share, on the Mac, PC and Linux alike (they use only
// the UI kit's common API): the line at the top of each saying what's missing — the phone, its
// permission (Allow asks on the phone, only now), the right TwinDesk on it — and the phone's
// answers (phonehub.js passes them on as 'hub' messages) by type.
'use strict';

(() => {
  const tr = (text, vars) => window.I18n ? window.I18n.t(text, vars) : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
  const handlers = new Map(); // type -> [fn]
  let listening = false;

  // fn(msg) for each answer of this type from the phone.
  UI.hubOn = (t, fn) => {
    if (!handlers.has(t)) handlers.set(t, []);
    handlers.get(t).push(fn);
    if (listening || !UI.api.onHub) return;
    listening = true;
    UI.api.onHub((m) => {
      for (const f of handlers.get(m && m.t) || []) {
        try { f(m); } catch (e) { console.error(`hub ${m.t}:`, e); }
      }
    });
  };

  // Ask the phone (only while that page's switch is on: phonehub.js checks).
  UI.hubAsk = (msg) => UI.api.hub({ do: 'send', msg });

  // The folder saved files go to here, by its name: General › Received files on Windows and Linux
  // (files.received, the one in use), Files › Save to on the Mac (files.folder, '' = Downloads).
  UI.receivedName = (s) => {
    const f = (s && s.files) || {};
    const dir = f.received || f.folder || '';
    return dir ? dir.split(/[\\/]/).filter(Boolean).pop() || dir : tr('Downloads');
  };

  // That page can show the phone's things now.
  UI.hubReady = (s, what) => {
    const h = s && s.hub;
    return !!(h && h[what] && h.connected && h.perm && h.perm[what] && ['ok', 'partial'].includes(h.perm[what].perm));
  };

  // The session runs through Bluetooth (Mac: s.client; PC and Linux: s.net). USB, Wi-Fi and Wi-Fi
  // Direct aren't: Photos and Phone Files work on those, and load nothing over Bluetooth.
  // Wireless debugging reaches the phone over Wi-Fi only: over Bluetooth its card is greyed out and
  // says so (the Phone page, the Overview). True while it is.
  UI.adbBle = (s, card, row, pill) => {
    const t = (text, vars) => window.I18n ? window.I18n.t(text, vars) : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
    const ble = UI.onBle(s);
    card.classList.toggle('wifi-only', ble);
    if (!ble) return false;
    pill.className = 'pill muted';
    pill.textContent = t('Wi-Fi only');
    row.setHint(t('Only available over Wi-Fi: you’re connected over Bluetooth. Connect with Wi-Fi Direct, or join the same Wi-Fi network.'));
    return true;
  };
  UI.onBle = (s) => !!(s && ((s.client && s.client.transport === 'ble') || (s.net && s.net.transport === 'ble')));
  // How the session runs, for the status lines: Bluetooth; a Wi-Fi Direct link (or a phone's
  // hotspot) made for a file or a screen, which goes again by itself ("Temporary"), or asked for
  // with Connect with Wi-Fi Direct on either side; else the same network.
  UI.via = (s) => {
    const t = (text, vars) => window.I18n ? window.I18n.t(text, vars) : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
    if (UI.onBle(s)) return t('Bluetooth');
    const n = (s && s.net) || {};
    // A group up beside a session on the real network is still that network: Ethernet when this
    // computer reaches the other one through a cable (state.net.lan, shared/lantype.js, #140).
    if (!['hosting', 'joined'].includes(n.state) || n.onGroup === false) return n.lan === 'Ethernet' ? t('Ethernet') : 'Wi-Fi';
    const name = n.kind === 'hotspot' ? t('Hotspot') : 'Wi-Fi Direct';
    const asked = ['user', 'hotspot'].some((w) => (n.why || []).includes(w) || (n.peerWhy || []).includes(w));
    return asked ? name : t('Temporary {transport}', { transport: name });
  };

  UI.phoneName = (s) => (s && s.hub && s.hub.name) || tr('your phone');
  // How a connected phone's sound gets here (phone-bridge.js _sound), for the Audio page; null: no phone.
  UI.phoneSound = (s) => {
    const b = s && s.phone && s.phone.connected && s.phone.bridge;
    if (!b) return null;
    const ph = s.phone.connected.name;
    const n = b.sound || {};
    if (n.on) return tr('Playing. {phone} captures it, so it plays there too (wireless debugging moves it off the phone)', { phone: ph });
    if (n.error) return n.error;
    if (n.waiting) return tr('Tap Start on {phone} (its notification, or Sound in TwinDesk there)', { phone: ph });
    if (n.net) return tr('Asking {phone}…', { phone: ph });
    if (b.state === 'ready') return tr('Through wireless debugging');
    return tr('Over Wi-Fi: through wireless debugging, or captured by {phone}', { phone: ph });
  };

  // The selected device changed (the sidebar's device list): a page that loaded data of the previous
  // device drops it and loads the new one's (fn runs after UI.state is the new device's).
  UI.onDeviceChange = (fn) => window.addEventListener('twindesk-device', fn);

  // page shown / hidden (the shells toggle `hidden`).
  UI.onShown = (page, fn) => {
    new MutationObserver(() => fn(!page.hidden)).observe(page, { attributes: true, attributeFilter: ['hidden'] });
  };

  const NEEDS = {
    calls: { state: 'its calls', numbers: 'who is calling and the call history', dial: 'making calls', answer: 'answering and ending calls', contacts: 'contact names' },
    messages: { read: 'reading texts', send: 'sending texts', contacts: 'contact names' },
  };
  const LABEL = { calls: 'Calls', messages: 'Messages', media: 'Photos and videos', files: 'Files' };

  // The top of a page: { el, render(s) }.
  UI.hubTop = (what) => {
    const { el, api } = UI;
    const text = el('div', { class: 'hub-top-text', attrs: { 'data-literal': '' } });
    const asked = el('div', { class: 'hint', attrs: { 'data-literal': '' } });
    const allow = UI.button(tr('Allow on the phone'), () => {
      api.hub({ do: 'ask', what });
      allow.dataset.at = String(Date.now());
    }, 'primary');
    const install = UI.button(tr('Install'), () => UI.api.phoneInstallFull && UI.api.phoneInstallFull());
    const box = el('div', { class: 'note hub-top' }, [el('div', { class: 'hub-top-body' }, [text, asked]), el('div', { class: 'hub-top-actions' }, [install, allow])]);
    box.hidden = true;
    const render = (s) => {
      const h = s.hub || {};
      const phone = UI.phoneName(s);
      const st = h.perm && h.perm[what];
      let msg = '', kind = 'info', canAllow = false, canInstall = false;
      if (!h[what]) msg = tr('Off. When you switch it on, {phone} asks for what it needs.', { phone });
      else if (!h.connected) msg = tr('Connect {phone} to use {feature}: click it at the top of the sidebar.', { phone, feature: tr(LABEL[what]) });
      else if (!h.supported) msg = tr('Waiting for {phone}… TwinDesk on it needs to be up to date for {feature}.', { phone, feature: tr(LABEL[what]) });
      else if (st.perm === 'none' && what === 'files') { msg = tr('Files needs Android 11 or later on {phone}. Mount works through ADB instead.', { phone }); kind = 'warn'; }
      else if (st.perm === 'none') {
        msg = tr('{feature} need TwinDesk with notifications on {phone} (Android doesn’t let downloaded apps read texts). {install}', { feature: tr(LABEL[what]), phone, install: tr(s.phone && s.phone.adb && s.phone.adb.address ? 'Install puts it on the phone through wireless debugging; your settings stay.' : 'Set up wireless debugging on the Phone page, then Install.') });
        kind = 'warn';
        canInstall = !!UI.api.phoneInstallFull;
      } else if (st.perm === 'ask') {
        msg = what === 'media' ? tr('Allow {phone} to share its photos and videos with TwinDesk.', { phone })
          : what === 'files' ? tr('Allow All files access for TwinDesk on {phone}: it reads and writes the phone’s storage itself, no ADB. Android opens the setting there.', { phone })
            : tr('Allow {feature} on {phone}: TwinDesk asks for {permissions}.', { feature: tr(LABEL[what]), phone, permissions: Object.values(NEEDS[what]).map(v => tr(v)).join(', ') });
        kind = 'warn';
        canAllow = true;
      } else if (st.perm === 'partial') {
        msg = what === 'media' ? tr('Only the photos you chose on {phone} show here.', { phone })
          : tr('Some of {feature} needs more on {phone}: {permissions}.', { feature: tr(LABEL[what]), phone, permissions: (st.missing || []).map((m) => NEEDS[what][m]).filter(Boolean).map(v => tr(v)).join(', ') });
        canAllow = true;
      }
      box.hidden = !msg;
      box.className = `note hub-top ${kind}`;
      text.textContent = msg;
      allow.hidden = !canAllow;
      install.hidden = !canInstall;
      const recently = Number(allow.dataset.at || 0) > Date.now() - 60000;
      asked.textContent = canAllow && recently ? (h.perm && h.perm.opens ? tr('Check {phone}: Android asks there.', { phone }) : tr('Tap the notification on {phone}.', { phone })) : '';
      asked.hidden = !asked.textContent;
    };
    return { el: box, render };
  };

  // Over Bluetooth, a page that needs Wi-Fi (the shells' wifiOnly) is shown as it is, with this on
  // top: only over Wi-Fi Direct (or the same network), and the button that moves the session
  // there (netlink.js; Linux has none: join the same network). { el, render(s, off) }.
  UI.wifiGate = () => {
    const { el, api } = UI;
    const text = el('div', { class: 'hub-top-text', attrs: { 'data-literal': '' } });
    const go = UI.button(tr('Connect with Wi-Fi Direct'), () => api.netWifi(true), 'primary');
    const box = el('div', { class: 'note warn hub-top wifi-note' }, [el('div', { class: 'hub-top-body' }, [text]), el('div', { class: 'hub-top-actions' }, [go])]);
    box.hidden = true;
    const render = (s, off) => {
      box.hidden = !off;
      if (!off) return;
      const n = s.net || {};
      const moving = ['asking', 'hosting', 'joining'].includes(n.state);
      const can = !!api.netWifi;
      text.textContent = moving ? tr('Only available over Wi-Fi Direct. Connecting…')
        : n.state === 'failed' ? tr('Only available over Wi-Fi Direct. {error}.', { error: tr(n.error || 'Wi-Fi Direct didn’t come up') })
          : tr(can ? 'Only available over Wi-Fi Direct: you’re connected over Bluetooth. Or join the same Wi-Fi network.' : 'Only available over Wi-Fi Direct or the same Wi-Fi network: you’re connected over Bluetooth.');
      go.hidden = !can;
      go.disabled = moving;
      go.textContent = tr(moving ? 'Connecting…' : n.state === 'failed' ? 'Try again' : 'Connect with Wi-Fi Direct');
    };
    return { el: box, render };
  };

  UI.initial = (name) => {
    const t = String(name || '').trim();
    return /^[+\d]/.test(t) || !t ? '#' : t.charAt(0).toUpperCase();
  };

  UI.avatar = (name, photo) => {
    const a = UI.el('span', { class: 'hub-avatar', text: photo ? '' : UI.initial(name) });
    if (photo) a.style.backgroundImage = `url("${photo}")`;
    return a;
  };

  UI.clock = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(window.I18n ? window.I18n.locale : [], { hour: 'numeric', minute: '2-digit' });
    if (now - d < 6 * 86400000) return d.toLocaleDateString(window.I18n ? window.I18n.locale : [], { weekday: 'short' });
    return d.toLocaleDateString(window.I18n ? window.I18n.locale : [], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  };

  UI.duration = (s) => {
    s = Math.max(0, Math.round(s));
    return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
})();

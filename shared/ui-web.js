// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Web in the window (Mac, PC and Linux; state.web from shared/web/webwire.js):
//   - TwinDesk Web: the switch, the QR code and pairing code, the addresses, what web devices may do,
//     and the paired devices (rename, forget).
//   - AirPlay & SMB: this computer's shared folder for the Files app on an iPhone (and any SMB client).
//   - Each web device's own pages, shown in place of the sidebar's when its tile (UI.webTiles) is
//     picked: Overview, Connection, Share and Receive screen, Remote, Clipboard, Notifications, Files,
//     Drop, Audio and Camera, each with this device's own settings (state.web.devices[].allow).
// The shell (ui-start.js / app.js) shows the device pages (def.web) while UI.webDev is set.
'use strict';

(() => {
  const tr = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
  const { el } = UI;
  const api = () => UI.api;
  const W = (s) => (s && s.web) || { cfg: {}, devices: [] };
  const me = (s) => (s && (s.macName || s.pcName || s.name)) || tr('this computer');
  const OS = { ios: 'iPhone', ipados: 'iPad', android: 'Android', mac: 'Mac', win: 'Windows', linux: 'Linux', other: 'Browser' };
  const kind = (d) => d.model || OS[d.os] || tr('Browser');
  const ago = (ts) => (UI.ago ? UI.ago(ts) : new Date(ts).toLocaleString());
  const bytes = (n) => (UI.bytes ? UI.bytes(n) : `${Math.round(n / 1024)} KB`);
  UI.webDev = null; // the web device whose pages show, or null
  UI.WEB_KEEP = ['connection', 'web', 'airplay', 'general', 'about']; // shown with a web device's pages too
  UI.openWebDev = (id) => { UI.webDev = id; UI.go('wd-overview'); };
  UI.webDevOf = (s) => (UI.webDev && W(s).devices.find((d) => d.id === UI.webDev)) || null;

  const copyBtn = (get) => {
    const b = UI.button(tr('Copy'), () => {
      api().webCopy(get());
      b.textContent = tr('Copied');
      setTimeout(() => { b.textContent = tr('Copy'); }, 1500);
    }, 'small');
    return b;
  };
  const status = (d) => !d.online ? tr('Last seen {when}', { when: ago(d.lastSeen) })
    : d.background ? tr('Connected · in the background') : tr('Connected');

  // ---------------------------------------------------------------- TwinDesk Web
  UI.tab({
    id: 'web',
    group: 7,
    order: 90,
    icon: 'globe',
    title: 'TwinDesk Web',
    desc: 'Use an iPhone, iPad or any device with a web browser with this computer: no app to install. Pair it once with the QR code.',
    color: 'linear-gradient(#5ac8fa, #007aff)',
    master: { get: (s) => !!W(s).cfg.on, set: (v) => api().webSet({ on: v }) },
    badge: (s) => (W(s).running ? (W(s).devices.some((d) => d.online) ? 'on' : '') : ''),
    build(body) {
      const err = el('div', { class: 'note warn', hidden: true });
      const qrBox = el('div', { class: 'web-qr' });
      const code = el('div', { class: 'web-code mono' });
      const codeHint = el('div', { class: 'hint', text: tr('Scan the QR code with the phone’s camera, or open one of the addresses below and enter this code.') });
      const pairCard = UI.card(tr('Pair a device'), [el('div', { class: 'web-pair' }, [qrBox, el('div', { class: 'web-pair-text' }, [
        el('div', { class: 'hint', text: tr('Pairing code') }), code, codeHint,
        el('div', { class: 'web-pair-btns' }, [UI.button(tr('New Code'), () => api().webNewCode(), 'small')]),
      ])])]);
      const shortRow = UI.row(tr('Type in the browser'), '', [copyBtn(() => `http://${(last.links || {}).short}`)], { literalHint: true });
      const secureRow = UI.row(tr('Secure address'), '', [copyBtn(() => (last.links || {}).secure || '')], { literalHint: true });
      const plainRow = UI.row(tr('Address'), '', [copyBtn(() => (last.links || {}).plain || '')], { literalHint: true });
      const certRow = UI.row(tr('Certificate'), tr('For the secure address, install TwinDesk’s certificate once on the device: its page offers it. Notifications and installing to the Home Screen need it.'), []);
      const addrCard = UI.card(tr('Addresses'), [shortRow, secureRow, plainRow, certRow]);
      const sw = (key) => UI.switch((v) => api().webSet({ [key]: v }));
      const screenSw = sw('screen');
      const controlSw = sw('control');
      const camSw = sw('camera');
      const micSw = sw('mic');
      const allowCard = UI.card(tr('New devices can'), [
        UI.row(tr('View this screen and hear its sound'), tr('One device at a time. Extend gives it a screen of its own.'), [screenSw]),
        UI.row(tr('Control this computer'), tr('Mouse and keyboard from the screen viewer, and the Remote page’s touchpad, keyboard and gamepad.'), [controlSw]),
        UI.row(tr('Use their camera here'), tr('Its picture shows on the device’s Camera page and in TwinDesk Camera.'), [camSw]),
        UI.row(tr('Use their microphone here'), tr('Plays into a virtual audio cable when one is installed (BlackHole, VB-Cable), else the speakers.'), [micSw]),
      ]);
      const list = el('div');
      const devCard = UI.card(tr('Paired devices'), [list]);
      body.append(err, pairCard, addrCard, allowCard, devCard);
      let last = {};
      let qrKey = '';
      let listKey = '';
      return (s) => {
        const w = W(s);
        last = w;
        err.hidden = !w.error;
        err.textContent = w.error || '';
        pairCard.hidden = addrCard.hidden = !w.running;
        if (w.running && w.links && w.links.qr !== qrKey) {
          qrKey = w.links.qr;
          qrBox.replaceChildren(window.Qr ? window.Qr.canvas(w.links.qr, 176) : el('div', { class: 'mono', text: w.links.qr }));
        }
        code.textContent = w.code ? `${w.code.slice(0, 3)} ${w.code.slice(3)}` : '';
        shortRow.hidden = !(w.links && w.links.short);
        if (w.links && w.links.short) shortRow.setHint(`${w.links.short}  ·  ${tr('opens the pairing page, then moves to this computer’s own address')}`);
        if (w.links) {
          secureRow.setHint(w.links.secure);
          plainRow.setHint(w.links.plain + (w.links.all && w.links.all.length > 1 ? `  ·  ${tr('also')} ${w.links.all.filter((a) => a !== w.links.ip).join(', ')}` : ''));
        }
        screenSw.set(w.cfg.screen !== false);
        controlSw.set(w.cfg.control !== false);
        camSw.set(w.cfg.camera !== false);
        micSw.set(w.cfg.mic !== false);
        const key = JSON.stringify(w.devices.map((d) => [d.id, d.name, d.online, d.background, d.lastSeen, d.ip, d.secure, d.push]));
        if (key === listKey) return;
        listKey = key;
        list.replaceChildren(...(w.devices.length ? w.devices.map((d) => {
          const hint = [kind(d), status(d), d.ip, d.online ? (d.secure ? tr('Secure') : tr('Not secure')) : '', d.push ? tr('Notifications on') : ''].filter(Boolean).join(' · ');
          return UI.row(d.name, hint, [
            UI.button(tr('Open'), () => UI.openWebDev(d.id), 'small'),
            UI.button(tr('Forget'), () => api().webForget(d.id), 'small'),
          ], { literal: true });
        }) : [UI.row(tr('No devices yet'), tr('Paired devices appear here and in the sidebar.'), [])]));
      };
    },
  });

  // ---------------------------------------------------------------- AirPlay & SMB
  UI.tab({
    id: 'airplay',
    group: 7,
    order: 91,
    icon: 'folder',
    title: 'AirPlay & SMB',
    desc: 'This computer’s shared folder in the Files app on an iPhone or iPad, and AirPlay.',
    color: 'linear-gradient(#ffd60a, #ff9f0a)',
    badge: (s) => (W(s).share && W(s).share.on ? 'on' : ''),
    build(body) {
      const shareSw = UI.switch((v) => api().webShareSet(v));
      const shareRow = UI.row(tr('Share a folder'), '', [shareSw], { literalHint: true });
      const folderRow = UI.row(tr('Folder'), '', [UI.button(tr('Choose…'), () => api().webShareFolder(), 'small')], { literalHint: true });
      const addrRow = UI.row(tr('Server address'), '', [copyBtn(() => addr)], { literalHint: true });
      const userRow = UI.row(tr('User name'), '', [], { literalHint: true });
      const pwRow = UI.row(tr('Password'), tr('Shown on the device’s Mount page in TwinDesk Web, with the steps.'), []);
      const shareErr = el('div', { class: 'note warn', hidden: true });
      const smbCard = UI.card(tr('Folder sharing (SMB)'), [shareRow, folderRow, addrRow, userRow, pwRow]);
      const steps = el('ol', { class: 'web-steps' }, [
        el('li', { text: tr('On the iPhone or iPad, open Files, tap ••• and choose Connect to Server.') }),
        el('li', { text: tr('Enter the server address, choose Registered User, and enter the user name and password.') }),
        el('li', { text: tr('The folder stays under Shared in Files.') }),
      ]);
      const howCard = UI.card(tr('In the Files app'), [el('div', { class: 'web-pad' }, [steps])]);
      const airCard = UI.card(tr('AirPlay'), [
        UI.row(tr('Receive AirPlay'), tr('Not available yet. Until then, a web device shows this screen with Screen in TwinDesk Web, and sends its own with the steps on its Send screen page.'), [UI.switch(() => {}, { disabled: true }).el]),
      ]);
      body.append(shareErr, smbCard, howCard, airCard);
      let addr = '';
      return (s) => {
        const w = W(s);
        const m = w.share || {};
        const on = !!m.on;
        shareSw.set(on);
        shareSw.disable(!!m.busy);
        shareRow.setHint(m.busy ? tr('Working…') : on ? tr('Shared as {share}', { share: m.name || 'MacShare' }) : tr('Asks for an administrator password once.'));
        folderRow.setHint(m.folder || '');
        shareErr.hidden = !m.error;
        shareErr.textContent = m.error ? tr(m.error) : '';
        const host = (w.links && w.links.host) || (w.links && w.links.ip) || '';
        addr = host ? `smb://${host}/${m.name || 'MacShare'}` : '';
        addrRow.hidden = userRow.hidden = pwRow.hidden = howCard.hidden = !on;
        addrRow.setHint(addr || tr('Turn on TwinDesk Web to get this computer’s network name'));
        userRow.setHint(m.user || 'macshare');
      };
    },
  });

  // ---------------------------------------------------------------- a web device's pages
  // As a device's own pages (shared/ui-device.js and the rest): each with this device's settings
  // (allow, kept by the hub per device). Colours and icons as the sidebar's pages of the same name.
  const like = (id, k) => ((UI.tabs.find((t) => t.id === id) || {})[k]);
  const devPage = (id, base, extra) => UI.tab({ id, web: true, icon: like(base, 'icon') || base, color: like(base, 'color') || 'linear-gradient(#8e8e93, #636366)', ...extra });
  // A switch of this device's settings, and its row.
  const allowSw = (key) => {
    const sw = UI.switch((v) => UI.webDev && api().webAllow({ id: UI.webDev, [key]: v }));
    sw.key = key;
    return sw;
  };
  const setAll = (d, sws) => { for (const sw of sws) sw.set((d.allow || {})[sw.key] !== false); };
  const live = (st) => (st === 'live' ? tr('Live') : st === 'connecting' || st === 'new' ? tr('Connecting…') : st ? tr(String(st).replace(/^error: /, '')) : tr('Off'));

  // The device's Overview: as a phone's (shared/ui-device.js), its picture, name, status and facts.
  UI.tab({
    id: 'wd-overview', web: true, group: 'w0', order: 92, icon: 'overview', title: 'Overview', color: 'linear-gradient(#8e8e93, #636366)',
    build(body, page) {
      page.classList.add('device-page');
      body.setAttribute('data-literal', '');
      const pic = el('div', { class: 'device phone big' });
      const name = el('div', { class: 'hero-name' });
      const sub = el('div', { class: 'hero-status' });
      const facts = el('dl', { class: 'dv-facts' });
      const dropBtn = UI.button(tr('Send files'), () => UI.webDev && api().webChooseFiles({ id: UI.webDev, kind: 'files' }), 'primary');
      const chatBtn = UI.button(tr('Drop'), () => UI.go('wd-drop'));
      const stopBtn = UI.button(tr('Stop screen'), () => UI.webDev && api().webStopScreen(UI.webDev));
      const offBtn = UI.button(tr('Disconnect'), () => UI.webDev && api().webDisconnect(UI.webDev));
      const hero = el('div', { class: 'card dv-hero' }, [pic, el('div', { class: 'dv-hero-main' }, [name, sub, el('div', { class: 'dv-actions' }, [dropBtn, chatBtn, stopBtn, offBtn])]), facts]);
      // What it may do here, at a glance: each opens its page.
      const feats = el('div', { class: 'card web-feats' });
      // Its pairing (the rest of its connection is in Connection, as for every device).
      const nameIn = el('input', { class: 'web-name', type: 'text', maxLength: 60, attrs: { 'aria-label': tr('Name') } });
      nameIn.onchange = () => UI.webDev && nameIn.value.trim() && api().webRename({ id: UI.webDev, name: nameIn.value });
      const pairCard = UI.card(tr('This device'), [
        UI.row(tr('Name'), tr('How this device appears on this computer'), [nameIn]),
        UI.row(tr('Disconnect'), tr('Its TwinDesk Web closes the connection and stays off until Connect is pressed there. It stays paired.'), [UI.button(tr('Disconnect'), () => UI.webDev && api().webDisconnect(UI.webDev), 'small')]),
        UI.row(tr('Forget this device'), tr('It will need a new pairing code to connect again. Its messages and files list are removed.'), [UI.button(tr('Forget'), () => UI.webDev && api().webForget(UI.webDev), 'small')]),
      ]);
      body.append(hero, UI.card(tr('On this device'), [feats]), pairCard);
      const FEATS = [['wd-share', 'Share screen', 'screen'], ['wd-receive', 'Receive screen', 'share'], ['wd-audio', 'Audio', 'sound'], ['wd-clipboard', 'Clipboard', 'clipOut'],
        ['wd-notifications', 'Notifications', 'notifs'], ['wd-files', 'Files', 'files'], ['wd-camera', 'Camera', 'camera'], ['wd-remote', 'Remote', 'control']];
      const fact = (k, v) => (v ? [el('dt', { text: k }), el('dd', { text: v })] : []);
      return (s) => {
        const d = UI.webDevOf(s);
        if (!d) return;
        name.textContent = d.name;
        sub.textContent = `${kind(d)} · ${status(d)}`;
        const al = d.allow || {};
        feats.replaceChildren(...FEATS.map(([id, label, key]) => {
          const b = el('button', { class: 'web-feat' }, [el('span', { class: 'web-feat-name', text: tr(label) }), el('span', { class: `web-feat-state${al[key] === false ? '' : ' on'}`, text: al[key] === false ? tr('Off') : tr('On') })]);
          b.onclick = () => UI.go(id);
          return b;
        }));
        stopBtn.hidden = !d.watching;
        offBtn.hidden = !d.online;
        dropBtn.disabled = !d.online;
        if (document.activeElement !== nameIn) nameIn.value = d.name;
        const alt = d.alerts || {};
        const notes = d.push ? [alt.clip && tr('Clipboard'), alt.drop && tr('Messages'), alt.files && tr('Files'), alt.notifs && tr('Notifications')].filter(Boolean).join(', ') || tr('None') : tr('Off');
        facts.replaceChildren(
          ...fact(tr('Address'), d.ip),
          ...fact(tr('Connection'), d.online ? (d.secure ? tr('Secure') : tr('Not secure')) : tr('Offline')),
          ...fact(tr('Alerts'), notes),
          ...fact(tr('Now'), d.watching ? (d.watching.mode === 'extend' ? tr('Extended screen') : tr('Mirroring screen')) : d.remote ? tr('Remote') : ''),
          ...fact(tr('Paired'), d.pairedAt ? new Date(d.pairedAt).toLocaleDateString() : ''),
        );
      };
    },
  });

  devPage('wd-share', 'share', {
    group: 'w1', order: 92.1, title: 'Share screen',
    desc: 'This computer’s screen on the device. The device starts it from its Receive screen page.',
    build(body) {
      const screenSw = allowSw('screen');
      const extendSw = allowSw('extend');
      const controlSw = allowSw('control');
      const q = UI.select ? UI.select([[0, tr('As the device asks')], [720, '720p'], [1080, '1080p'], [1440, '1440p'], [2160, '4K']].map(([value, label]) => ({ value, label })), (v) => UI.webDev && api().webAllow({ id: UI.webDev, maxH: Number(v) })) : null;
      const stRow = UI.row(tr('Now'), '', [UI.button(tr('Stop'), () => UI.webDev && api().webStopScreen(UI.webDev), 'small')], { literalHint: true });
      const extRow = UI.row(tr('Extend'), '', [extendSw]);
      body.append(
        UI.card(tr('Share screen'), [
          UI.row(tr('Let it view this screen'), tr('With this computer’s sound when the device asks for it (Audio).'), [screenSw]),
          extRow,
          UI.row(tr('Let it control this computer'), tr('Mouse, keyboard and pen from the screen viewer, and the Remote page.'), [controlSw]),
          q ? UI.row(tr('Highest quality'), tr('The picture never goes above this, whatever the device picks.'), [q]) : null,
        ]),
        UI.card(tr('Status'), [stRow]),
      );
      return (s) => {
        const d = UI.webDevOf(s);
        if (!d) return;
        setAll(d, [screenSw, extendSw, controlSw]);
        if (q) q.set(String((d.allow || {}).maxH || 0));
        extRow.setHint(W(s).extend ? tr('A screen of its own, in the device’s shape, beside this one') : tr('Not available while this screen is shared with the other computer'));
        const st = d.watching;
        stRow.setHint(st ? `${st.video ? (st.mode === 'extend' ? tr('Extended screen') : tr('Mirrored screen')) : tr('Sound only')} · ${live(st.status)}` : tr('Not watching'));
        stRow.querySelector('button').hidden = !st;
      };
    },
  });

  devPage('wd-receive', 'receive', {
    group: 'w1', order: 92.11, title: 'Receive screen',
    desc: 'The device’s screen in a window here. It starts from the device’s Send screen page.',
    build(body) {
      const sw = allowSw('share');
      const stRow = UI.row(tr('Now'), '', [UI.button(tr('Stop'), () => UI.webDev && api().webStopCam({ id: UI.webDev, kind: 'scr' }), 'small')], { literalHint: true });
      const howRow = UI.row(tr('How'), '', [], { literalHint: true });
      body.append(UI.card(tr('Receive screen'), [UI.row(tr('Show its screen here'), tr('In a window of its own; closing the window stops it.'), [sw]), stRow, howRow]));
      return (s) => {
        const d = UI.webDevOf(s);
        if (!d) return;
        setAll(d, [sw]);
        const c = (W(s).cam || {}).scr;
        const mine = c && c.dev === d.id;
        stRow.setHint(mine ? live(c.status) : tr('Not sharing'));
        stRow.querySelector('button').hidden = !mine;
        howRow.setHint(d.os === 'ios' || d.os === 'ipados'
          ? tr('An iPhone or iPad shares its screen with AirPlay, which isn’t available here yet.')
          : tr('On the device, open Send screen in TwinDesk Web and tap Start. A browser asks which screen, window or tab to share.'));
      };
    },
  });

  devPage('wd-remote', 'remote', {
    group: 'w2', order: 92.2, title: 'Remote',
    desc: 'The device as a touchpad, keyboard and gamepad for this computer.',
    build(body) {
      const sw = allowSw('control');
      const stRow = UI.row(tr('Now'), '', [], { literalHint: true });
      body.append(UI.card(tr('Remote'), [UI.row(tr('Let it control this computer'), tr('Also the mouse and keyboard in its screen viewer (Share screen).'), [sw]), stRow]));
      return (s) => {
        const d = UI.webDevOf(s);
        if (!d) return;
        setAll(d, [sw]);
        const r = W(s).remote;
        stRow.setHint(d.remote ? (r && r.why ? tr(r.why) : r && r.using ? tr('In use') : tr('Open on the device')) : tr('Not open on the device'));
      };
    },
  });

  devPage('wd-clipboard', 'clipboard', {
    group: 'w3', order: 92.3, title: 'Clipboard',
    desc: 'Copy on one, paste on the other.',
    build(body) {
      const out = allowSw('clipOut');
      const inn = allowSw('clipIn');
      const nowRow = UI.row(tr('On this computer’s clipboard'), '', [], { literalHint: true });
      body.append(
        UI.card(tr('Clipboard'), [
          UI.row(tr('Send this computer’s clipboard to it'), tr('What you copy here shows on its Clipboard page, and as an alert when its page is in the background.'), [out]),
          UI.row(tr('Take its clipboard'), tr('What it sends (its Clipboard page, a Shortcut) goes on this computer’s clipboard.'), [inn]),
        ]),
        UI.card(tr('Now'), [nowRow]),
      );
      return (s) => {
        const d = UI.webDevOf(s);
        if (!d) return;
        setAll(d, [out, inn]);
        const c = W(s).clip || {};
        nowRow.setHint(c.text ? c.text.slice(0, 300) : tr('Empty'));
      };
    },
  });

  devPage('wd-notifications', 'notifications', {
    group: 'w3', order: 92.31, title: 'Notifications',
    desc: 'This computer’s notifications on the device.',
    build(body) {
      const sw = allowSw('notifs');
      const devRow = UI.row(tr('On the device'), '', [], { literalHint: true });
      body.append(UI.card(tr('Notifications'), [UI.row(tr('Send this computer’s notifications'), tr('They show on its Notifications page, and as alerts when its page is in the background. The device chooses which kinds alert it.'), [sw]), devRow]));
      return (s) => {
        const d = UI.webDevOf(s);
        if (!d) return;
        setAll(d, [sw]);
        devRow.setHint(!d.notifs ? tr('Off on the device (its Notifications page)') : d.push && (d.alerts || {}).notifs ? tr('On, with alerts in the background') : tr('On, shown while its page is open'));
      };
    },
  });

  devPage('wd-files', 'files', {
    group: 'w3', order: 92.32, title: 'Files',
    desc: 'Files from the device, and where they go.',
    build(body) {
      const sw = allowSw('files');
      const folderRow = UI.row(tr('Save them in'), '', [UI.button(tr('Choose…'), () => UI.webDev && api().webChooseFolder(UI.webDev), 'small'), UI.button(tr('Default'), () => UI.webDev && api().webAllow({ id: UI.webDev, folder: '' }), 'small')], { literalHint: true });
      body.append(
        UI.card(tr('Files'), [
          UI.row(tr('Take files from it'), tr('Each one also goes on the Paste Files shortcut: press it in a folder or an app to put it there.'), [sw]),
          folderRow,
          UI.row(tr('Send files to it'), tr('They wait on its Files page until it saves them. Drag files here too.'), [UI.button(tr('Choose Files…'), () => UI.webDev && api().webChooseFiles({ id: UI.webDev, kind: 'files' }), 'small')]),
        ]),
      );
      // Transfers both ways: what it sent, and what's waiting for it or on its way.
      const list = el('div', { class: 'web-xfers' });
      const none = el('div', { class: 'hint web-xfers-none', text: tr('Nothing yet') });
      const xcard = UI.card(tr('Transfers'), [none, list]);
      body.append(xcard);
      body.addEventListener('dragover', (e) => { e.preventDefault(); xcard.classList.add('hub-drop'); });
      body.addEventListener('dragleave', () => xcard.classList.remove('hub-drop'));
      body.addEventListener('drop', (e) => {
        e.preventDefault();
        xcard.classList.remove('hub-drop');
        const paths = api().pathsOf ? api().pathsOf(e.dataTransfer.files) : [];
        if (paths.length && UI.webDev) api().webSendFiles({ id: UI.webDev, paths, kind: 'files' });
      });
      let key = '';
      const xfers = (d) => {
        const items = (d.chat || []).filter((x) => x.file && x.kind === 'files').slice().reverse();
        const k = JSON.stringify([d.id, items.map((x) => [x.id, x.file.got, x.file.saved, !!x.path])]);
        if (k === key) return;
        key = k;
        none.hidden = items.length > 0;
        list.replaceChildren(...items.map((x) => {
          const f = x.file;
          const pc = x.from === 'pc';
          const state = !pc ? tr('Received') : f.saved ? tr('Saved on {name}', { name: d.name })
            : f.got > 0 && f.size ? tr('Sending… {p}%', { p: Math.floor((100 * f.got) / f.size) }) : tr('Waiting for {name} to save it', { name: d.name });
          const fill = el('i');
          fill.style.width = `${pc ? (f.saved ? 100 : f.size ? Math.floor((100 * (f.got || 0)) / f.size) : 0) : 100}%`; // CSSOM: the window's CSP blocks style attributes
          const bar = el('div', { class: 'web-xfer-bar' }, [fill]);
          const acts = [];
          if (x.path) acts.push(UI.button(pc ? tr('Show') : tr('Open'), () => api().webOpenItem({ id: d.id, item: x.id, reveal: pc }), 'small'));
          acts.push(UI.button(pc && !f.saved ? tr('Cancel') : tr('Remove'), () => api().webDeleteItem({ id: d.id, item: x.id }), 'small'));
          return el('div', { class: `web-xfer ${pc ? 'out' : 'in'}` }, [
            UI.icon('doc'),
            el('div', { class: 'web-xfer-text' }, [el('div', { class: 'web-file-name', text: `${pc ? '↑' : '↓'} ${f.name}` }), el('div', { class: 'hint', text: `${bytes(f.size || 0)} · ${state}` }), bar]),
            el('div', { class: 'web-xfer-acts' }, acts),
          ]);
        }));
      };
      return (s) => {
        const d = UI.webDevOf(s);
        if (!d) return;
        setAll(d, [sw]);
        xfers(d);
        folderRow.setHint((d.allow || {}).folder || tr('The received files folder (Files › Save to)'));
      };
    },
  });

  // Drop: one conversation, as Messages shows one (shared/ui-messages.js, phonehub.css).
  UI.tab({
    id: 'wd-drop', web: true, group: 'w3', order: 92.33, icon: 'message', title: 'Drop', color: 'linear-gradient(#ffcc00, #ff9500)',
    desc: 'Messages and files with this device. Drag files here to send them.',
    build(body) {
      body.setAttribute('data-literal', '');
      const bubbles = el('div', { class: 'hub-bubbles' });
      const empty = el('div', { class: 'hub-conv-empty hint', text: tr('No messages yet') });
      const scroll = el('div', { class: 'hub-conv-scroll' }, [empty, bubbles]);
      const box = el('textarea', { class: 'hub-compose', rows: 1, placeholder: tr('Message'), attrs: { 'aria-label': tr('Message') } });
      const send = () => {
        const text = box.value.trim();
        if (!text || !UI.webDev) return;
        api().webSendText({ id: UI.webDev, text });
        box.value = '';
        box.style.height = '';
      };
      box.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
      box.oninput = () => { box.style.height = ''; box.style.height = `${Math.min(140, box.scrollHeight)}px`; };
      const attach = UI.button('+', () => UI.webDev && api().webChooseFiles({ id: UI.webDev, kind: 'drop' }), 'hub-attach-btn');
      attach.title = tr('Send files');
      const sendBtn = UI.button(tr('Send'), send, 'primary');
      const head = el('div', { class: 'hub-conv-head web-conv-head' }, [el('div', { class: 'hub-conv-name' }), UI.button(tr('Clear All'), () => UI.webDev && api().webClearChat(UI.webDev), 'small')]);
      const conv = el('div', { class: 'hub-conv' }, [head, scroll, el('div', { class: 'hub-compose-row' }, [attach, el('div', { class: 'hub-compose-col' }, [box]), sendBtn])]);
      const card = el('div', { class: 'card web-drop' }, [conv]);
      body.append(card);
      conv.addEventListener('dragover', (e) => { e.preventDefault(); conv.classList.add('hub-drop'); });
      conv.addEventListener('dragleave', () => conv.classList.remove('hub-drop'));
      conv.addEventListener('drop', (e) => {
        e.preventDefault();
        conv.classList.remove('hub-drop');
        const paths = api().pathsOf ? api().pathsOf(e.dataTransfer.files) : [];
        if (paths.length && UI.webDev) api().webSendFiles({ id: UI.webDev, paths, kind: 'drop' });
      });
      const clock = (at) => (UI.clock ? UI.clock(at) : new Date(at).toLocaleString());
      let key = '';
      return (s) => {
        const d = UI.webDevOf(s);
        if (!d) return;
        head.firstChild.textContent = d.name;
        const chat = (d.chat || []).filter((x) => x.kind !== 'files');
        const k = JSON.stringify([d.id, chat.map((x) => x.id)]);
        if (k === key) return;
        key = k;
        empty.hidden = chat.length > 0;
        const nodes = [];
        let lastDay = '';
        for (const x of chat) {
          const day = new Date(x.at).toDateString();
          if (day !== lastDay) { lastDay = day; nodes.push(el('div', { class: 'hub-day', text: clock(x.at) })); }
          const del = el('button', { class: 'web-del', title: tr('Delete'), text: '×' });
          del.onclick = (e) => { e.stopPropagation(); api().webDeleteItem({ id: d.id, item: x.id }); };
          const kids = x.file
            ? [el('div', { class: 'web-file' }, [UI.icon('doc'), el('div', { class: 'web-file-text' }, [el('div', { class: 'web-file-name', text: x.file.name }), el('div', { class: 'hub-status', text: bytes(x.file.size || 0) })])])]
            : [el('div', { class: 'hub-text', text: x.text || '' })];
          if (x.file && x.path && x.from !== 'pc') {
            const save = el('button', { class: 'web-save', text: tr('Save…') });
            save.onclick = (e) => { e.stopPropagation(); api().webSaveItem({ id: d.id, item: x.id }); };
            kids[0].append(save);
          }
          const b = el('div', { class: `hub-bubble ${x.from === 'pc' ? 'out' : 'in'}${x.file ? ' web-bubble-file' : ''}`, title: new Date(x.at).toLocaleString() }, [...kids, del]);
          if (x.file && x.path) {
            b.title = tr('Open · right-click to show in the folder');
            b.onclick = () => api().webOpenItem({ id: d.id, item: x.id });
            b.oncontextmenu = (e) => { e.preventDefault(); api().webOpenItem({ id: d.id, item: x.id, reveal: true }); };
          }
          nodes.push(b);
        }
        bubbles.replaceChildren(...nodes);
        scroll.scrollTop = scroll.scrollHeight;
      };
    },
  });

  devPage('wd-audio', 'audio', {
    group: 'w4', order: 92.4, title: 'Audio',
    desc: 'This computer’s sound on the device, and the device’s microphone here.',
    build(body) {
      const snd = allowSw('sound');
      const mic = allowSw('mic');
      const micRow = UI.row(tr('Now'), '', [UI.button(tr('Stop'), () => UI.webDev && api().webStopCam({ id: UI.webDev, kind: 'mic' }), 'small')], { literalHint: true });
      body.append(
        UI.card(tr('Computer audio'), [UI.row(tr('Let it hear this computer'), tr('With the screen, or by itself from its Audio page.'), [snd])]),
        UI.card(tr('Microphone'), [UI.row(tr('Use its microphone here'), tr('Plays into a virtual audio cable when one is installed (BlackHole, VB-Cable), else the speakers.'), [mic]), micRow]),
      );
      return (s) => {
        const d = UI.webDevOf(s);
        if (!d) return;
        setAll(d, [snd, mic]);
        const m = (W(s).cam || {}).mic;
        const mine = m && m.dev === d.id;
        micRow.setHint(mine ? `${live(m.status)}${m.out ? ` · ${m.out}` : ''}` : tr('Off'));
        micRow.querySelector('button').hidden = !mine;
      };
    },
  });

  devPage('wd-camera', 'camera', {
    group: 'w4', order: 92.41, title: 'Camera',
    desc: 'The device’s camera on this computer. It starts from the device’s Camera page.',
    build(body) {
      const sw = allowSw('camera');
      const img = el('img', { class: 'web-cam', alt: '' });
      let url = '';
      if (api().onCamPreview) {
        api().onCamPreview((buf) => {
          if (!UI.webDev) return;
          if (url) URL.revokeObjectURL(url);
          url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
          img.src = url;
        });
      }
      const camRow = UI.row(tr('Now'), '', [UI.button(tr('Stop'), () => UI.webDev && api().webStopCam({ id: UI.webDev, kind: 'cam' }), 'small')], { literalHint: true });
      const picCard = UI.card('', [el('div', { class: 'web-cam-box' }, [img])]);
      body.append(
        UI.card(tr('Camera'), [
          UI.row(tr('Use its camera here'), '', [sw]),
          camRow,
          UI.row(tr('In other apps'), tr('Apps here pick TwinDesk Camera (Camera › Virtual camera) for its picture.'), [UI.button(tr('Camera'), () => { UI.webDev = null; UI.go('camera'); }, 'small')]),
        ]),
        picCard,
      );
      return (s) => {
        const d = UI.webDevOf(s);
        if (!d) return;
        setAll(d, [sw]);
        const c = (W(s).cam || {}).cam;
        const mine = c && c.dev === d.id;
        camRow.setHint(mine ? live(c.status) : tr('Off'));
        camRow.querySelector('button').hidden = !mine;
        picCard.hidden = !mine;
      };
    },
  });

  // ---------------------------------------------------------------- Connection's card
  // Paired web devices beside the paired computers and phones (each platform's Connection tab).
  UI.webConnCard = () => {
    const list = el('div');
    const card = UI.card(tr('TwinDesk Web'), [list], { actions: [UI.button(tr('Pair a Device…'), () => UI.go('web'), 'small')] });
    let key = '';
    return {
      el: card,
      render(s) {
        const w = W(s);
        card.hidden = !w.cfg.on && !w.devices.length;
        const k = JSON.stringify([w.running, w.devices.map((d) => [d.id, d.name, d.online, d.background, d.lastSeen])]);
        if (k === key) return;
        key = k;
        list.replaceChildren(...(w.devices.length ? w.devices.map((d) => UI.row(d.name, [kind(d), status(d)].join(' · '), [
          d.online ? el('span', { class: 'pill good', text: tr('Connected') }) : el('span', { class: 'pill muted', text: tr('Paired') }),
          UI.button(tr('Open'), () => UI.openWebDev(d.id), 'small'),
          UI.button(tr('Forget'), () => api().webForget(d.id), 'small'),
        ], { literal: true })) : [UI.row(tr('No web devices yet'), w.running ? tr('Pair an iPhone, iPad or any browser with the QR code in TwinDesk Web.') : tr('Turn on TwinDesk Web to pair an iPhone, iPad or any browser.'), [])]));
      },
    };
  };

  // ---------------------------------------------------------------- the sidebar's tiles
  // Paired web devices, under the phones and computers: only the connected ones (and the one whose
  // pages show, so they don't go from under the pointer). The rest are in Connection and TwinDesk Web.
  let tilesKey = '';
  // With a web device's pages, Connection goes right under its Overview, and TwinDesk Web and AirPlay &
  // SMB after its pages (above General and About); back where they were after. Their items are moved,
  // not copied: the shell keeps them.
  const MOVED = ['connection', 'web', 'airplay'];
  let arranged = false;
  let order = null;
  const arrange = (on) => {
    const nav = document.getElementById('nav');
    if (!nav || on === arranged) return;
    arranged = on;
    if (!order) order = [...nav.children];
    if (!on) return nav.replaceChildren(...order);
    const idOf = (li) => { const b = li.querySelector('[aria-controls]'); return b ? b.getAttribute('aria-controls').replace(/^page-/, '') : ''; };
    const moved = order.filter((li) => MOVED.includes(idOf(li)));
    const conn = moved.find((li) => idOf(li) === 'connection');
    const rest = order.filter((li) => !moved.includes(li));
    const at = rest.findIndex((li) => li.classList.contains('sep') || idOf(li) === 'general');
    const gap = el('li', { class: 'gap', attrs: { role: 'presentation' } });
    rest.splice(at < 0 ? rest.length : at, 0, gap, ...moved.filter((li) => li !== conn));
    const ov = rest.findIndex((li) => idOf(li) === 'wd-overview');
    if (conn) rest.splice(ov < 0 ? 0 : ov + 1, 0, conn);
    nav.replaceChildren(...rest);
  };
  // After the shell's own pass (it shows and hides gaps by group): no gap first, none twice.
  const tidyGaps = () => {
    const nav = document.getElementById('nav');
    if (!nav || !UI.webDev) return;
    let prevGap = true;
    for (const li of nav.children) {
      if (li.hidden) continue;
      const g = li.classList.contains('gap');
      if (g && prevGap) li.hidden = true;
      else prevGap = g;
    }
  };
  UI.webTiles = (box, s, pick) => {
    arrange(!!UI.webDev);
    queueMicrotask(tidyGaps);
    if (!box) return;
    const w = W(s);
    const list = w.running ? w.devices.filter((d) => d.online || d.id === UI.webDev) : [];
    const key = JSON.stringify([list.map((d) => [d.id, d.name, d.online, d.background, d.watching && d.watching.status]), UI.webDev]);
    if (key === tilesKey) return;
    tilesKey = key;
    box.replaceChildren(...list.map((d) => {
      const sub = d.online ? (d.watching ? tr('Watching the screen') : d.background ? tr('In the background') : tr('Connected')) : tr('Last seen {when}', { when: ago(d.lastSeen) });
      const b = el('button', { class: 'phone-tile web-tile' + (d.online ? ' connected' : ''), title: d.name }, [
        el('span', { class: 'phone-wall web-wall' }, [UI.icon(d.os === 'ios' || d.os === 'ipados' || d.os === 'android' ? 'phone' : 'globe')]),
        el('span', { class: 'phone-text' }, [el('span', { class: 'phone-name', text: d.name, attrs: { 'data-literal': '' } }), el('span', { class: 'phone-sub', text: sub, attrs: { 'data-literal': '' } })]),
        d.online ? el('span', { class: 'dot good' }) : null,
      ]);
      b.classList.toggle('active', UI.webDev === d.id);
      b.onclick = () => pick(UI.webDev === d.id ? null : d.id); // the picked one again: back to the sidebar's own pages
      return b;
    }));
  };
})();

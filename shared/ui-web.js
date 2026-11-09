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

  // Motion only where it's welcome, and only while it can be seen (a hidden tab costs nothing).
  const still = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const seen = (e) => e.isConnected && !document.hidden && e.offsetParent !== null;

  // A browser's address bar typing `text`, again and again: what to type on the device.
  // UI.typingBar(text) → element.
  UI.typingBar = (text) => {
    const typed = el('span', { class: 'wt-typed' });
    const bar = el('div', { class: 'wt-bar', attrs: { role: 'img', 'aria-label': text } }, [
      el('span', { class: 'wt-lock', attrs: { 'aria-hidden': 'true' } }), typed, el('i', { class: 'wt-caret', attrs: { 'aria-hidden': 'true' } }),
    ]);
    if (still()) { typed.textContent = text; return bar; }
    let n = 0;
    const tick = () => {
      if (!bar.isConnected && n > 0) return; // left the page for good
      let wait = 120;
      if (!seen(bar)) wait = 800;
      else if (n < text.length) typed.textContent = text.slice(0, ++n);
      else { wait = 2200; n = 0; setTimeout(() => { typed.textContent = ''; }, 2000); }
      if (n === 0) wait += 500;
      setTimeout(tick, wait);
    };
    setTimeout(tick, 400);
    return bar;
  };

  // Where Screen Mirroring is on an iPhone or iPad, playing on a loop (the iPhone app's MirrorGuide):
  // 1 swipe down from the top right corner, 2 Screen Mirroring in Control Center, 3 this computer in
  // the list. UI.mirrorGuide() → {el, target(name)}.
  UI.mirrorGuide = () => {
    const apps = el('div', { class: 'mg-apps' }, Array.from({ length: 16 }, (_, i) => el('i', { style: `--h:${(i * 47) % 360}` })));
    const tile = (cls) => el('i', { class: 'mg-tile ' + cls });
    const mirror = el('div', { class: 'mg-tile mg-mirror' }, [el('span', { class: 'mg-mirror-ic' }), el('span', { text: tr('Screen Mirroring') })]);
    const cc = el('div', { class: 'mg-cc' }, [el('div', { class: 'mg-row' }, [tile('blue'), tile('green'), tile('orange'), tile('blue')]), mirror,
      el('div', { class: 'mg-row' }, [tile('wide'), tile('wide')])]);
    const name = el('span');
    const list = el('div', { class: 'mg-list' }, [el('b', { text: tr('Screen Mirroring') }), el('div', { class: 'mg-item' }, [el('span', { class: 'mg-tv' }), name])]);
    const finger = el('i', { class: 'mg-finger' });
    const phone = el('div', { class: 'mg-phone', attrs: { 'aria-hidden': 'true' } }, [apps, cc, list, finger]);
    const labels = [tr('Swipe down from the top right corner'), tr('Tap Screen Mirroring'), ''];
    const items = labels.map((t, i) => el('li', {}, [el('b', { text: String(i + 1) }), el('span', { text: t })]));
    const card = el('div', { class: 'mg' }, [phone, el('div', { class: 'mg-text' }, [
      el('div', { class: 'mg-head', text: tr('On the iPhone or iPad') }), el('ol', { class: 'mg-steps' }, items),
      el('div', { class: 'hint mg-note', text: tr('On an iPhone with a Home button, swipe up from the bottom edge instead.') }),
    ])]);
    let step = 0;
    const show = (k) => {
      step = k;
      phone.dataset.step = String(k);
      items.forEach((li, i) => li.classList.toggle('on', i === k));
    };
    show(still() ? 2 : 0);
    if (!still()) {
      const tick = () => { if (seen(card)) show((step + 1) % 3); setTimeout(tick, step === 2 ? 2600 : 1900); };
      setTimeout(tick, 1900);
    }
    return {
      el: card,
      target(n) {
        name.textContent = n;
        items[2].lastChild.textContent = tr('Select {target}', { target: n });
      },
    };
  };

  // ---------------------------------------------------------------- TwinDesk Web
  UI.tab({
    id: 'web',
    group: 7,
    order: 90,
    icon: 'globe',
    title: 'TwinDesk Web',
    heading: 'twindesk.local (TwinDesk Web)', // the page's title; the sidebar keeps TwinDesk Web
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
        UI.row(tr('View this screen and play its audio'), tr('One device at a time. Extend adds a separate display for it.'), [screenSw]),
        UI.row(tr('Control this computer'), tr('Mouse and keyboard from the screen viewer, and the Remote page’s touchpad, keyboard and gamepad.'), [controlSw]),
        UI.row(tr('Use their cameras on this computer'), tr('The video appears on the device’s Camera page and in TwinDesk Camera.'), [camSw]),
        UI.row(tr('Use their microphones on this computer'), tr('Plays into a virtual audio cable when one is installed (BlackHole, VB-Cable), else the speakers.'), [micSw]),
      ]);
      const list = el('div');
      const devCard = UI.card(tr('Paired devices'), [list]);
      // The short name to type, typing itself out: on or off (off, it says to turn it on first).
      const visitHint = el('div', { class: 'hint' });
      const visitCard = UI.card(tr('Visit twindesk.local'), [el('div', { class: 'wt' }, [UI.typingBar('twindesk.local'), visitHint])], { cls: 'keep-on' });
      body.append(err, visitCard, pairCard, addrCard, allowCard, devCard);
      let last = {};
      let qrKey = '';
      let listKey = '';
      return (s) => {
        const w = W(s);
        last = w;
        err.hidden = !w.error;
        err.textContent = w.error || '';
        pairCard.hidden = addrCard.hidden = !w.running;
        visitHint.textContent = !w.running ? tr('Turn on TwinDesk Web, then type it in the browser on an iPhone, iPad or any device on this network.')
          : w.links && !w.links.short ? tr('Another computer on this network answers to twindesk.local now: open one of the addresses below instead.')
            : tr('Type it in the browser on an iPhone, iPad or any device on this network: it opens the pairing page.');
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
        const key = JSON.stringify(w.devices.map((d) => [d.id, d.name, d.online, d.background, d.lastSeen, d.ip, d.secure, d.push, d.link]));
        if (key === listKey) return;
        listKey = key;
        list.replaceChildren(...(w.devices.length ? w.devices.map((d) => {
          const hint = [kind(d), status(d), d.ip, d.online && d.link === 'USB-C' ? 'USB-C' : '', d.online ? (d.secure ? tr('Secure') : tr('Not secure')) : '', d.push ? tr('Notifications on') : ''].filter(Boolean).join(' · ');
          return UI.row(d.name, hint, [
            UI.button(tr('Open'), () => UI.openWebDev(d.id), 'small'),
            UI.button(tr('Forget'), () => api().webForget(d.id), 'small'),
          ], { literal: true });
        }) : [UI.row(tr('No devices yet'), tr('Paired devices appear here and in the sidebar.'), [])]));
      };
    },
  });

  // ---------------------------------------------------------------- Mac → this computer with AirPlay
  // On Receive screen while the other computer is a Mac (a PC or Linux computer here): the Mac can show
  // its screen here by itself, from its own Screen Mirroring, while Receive AirPlay is on (AirPlay &
  // SMB, shared/airplay). A picture of it, the steps, and a button that turns the receiver on.
  // Hide is remembered on this computer. UI.airplayMacTip() → {el, update(state)}.
  UI.airplayMacTip = () => {
    const KEY = 'twindesk.airplayMacTip.hidden';
    let gone = false;
    try { gone = localStorage.getItem(KEY) === '1'; } catch (_) {}
    const pic = el('div', { class: 'apt-pic', attrs: { 'aria-hidden': 'true' } });
    // The Mac (left) mirrors to this computer (right): the AirPlay sign between, waves going across.
    const rep = 'repeatCount="indefinite"';
    const wave = (d) => `<path class="apt-wave" d="M188 88q12 -12 24 0">`
      + `<animate attributeName="opacity" values="0;1;0" dur="1.8s" begin="${d}s" ${rep}/>`
      + `<animateTransform attributeName="transform" type="translate" values="-30 0;30 0" dur="1.8s" begin="${d}s" ${rep}/></path>`;
    pic.innerHTML = '<svg viewBox="0 0 400 150">'
      // the Mac: a laptop with a menu bar and a dock
      + '<rect class="apt-dev" x="40" y="34" width="118" height="76" rx="7"/>'
      + '<rect class="apt-scr" x="46" y="40" width="106" height="64" rx="3"/>'
      + '<rect class="apt-bar" x="46" y="40" width="106" height="6"/>'
      + '<rect class="apt-dock" x="76" y="96" width="46" height="5" rx="2.5"/>'
      + '<path class="apt-dev" d="M26 112h146l-9 10H35z"/>'
      // this computer: a monitor showing the same screen
      + '<rect class="apt-dev" x="236" y="26" width="132" height="84" rx="7"/>'
      + '<rect class="apt-scr on" x="242" y="32" width="120" height="72" rx="3"/>'
      + '<rect class="apt-bar" x="242" y="32" width="120" height="6"/>'
      + '<rect class="apt-dock" x="278" y="96" width="48" height="5" rx="2.5"/>'
      + '<rect class="apt-dev" x="295" y="110" width="14" height="12"/>'
      + '<rect class="apt-dev" x="278" y="122" width="48" height="6" rx="3"/>'
      // AirPlay: a screen with a triangle at its foot
      + '<g class="apt-ap"><path d="M190 66h-4a3 3 0 0 1-3-3V45a3 3 0 0 1 3-3h28a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3h-4"/>'
      + '<path class="fill" d="M200 58l9 11h-18z"/></g>'
      + wave(0) + wave(0.6) + wave(1.2)
      + '</svg>';
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const svg = pic.firstChild;
      if (svg && svg.pauseAnimations) svg.pauseAnimations();
    }
    const head = el('div', { class: 'apt-head', text: tr('Mirror the Mac with AirPlay, no app needed') });
    const steps = el('ol', { class: 'web-steps apt-steps' });
    const state = el('div', { class: 'apt-state' });
    const onBtn = UI.button(tr('Turn on Receive AirPlay'), () => api().webAirplaySet(true), 'small primary');
    const setBtn = UI.button(tr('AirPlay settings'), () => UI.go('airplay'), 'small');
    let card = null;
    const hide = UI.button(tr('Hide'), () => {
      gone = true;
      try { localStorage.setItem(KEY, '1'); } catch (_) {}
      card.hidden = true;
    }, 'small');
    card = el('div', { class: 'card apt', hidden: true }, [
      pic,
      el('div', { class: 'apt-body' }, [head, steps, state, el('div', { class: 'apt-actions' }, [onBtn, setBtn, hide])]),
    ]);
    let key = '';
    return {
      el: card,
      update(s) {
        const a = W(s).airplay;
        const peer = s && s.peer;
        card.hidden = gone || !a || !peer || peer.os !== 'mac';
        if (card.hidden) return;
        const name = a.name || me(s);
        const mac = peer.name || tr('the Mac');
        const live = a.session && a.session.mirroring !== false ? a.session.name : '';
        const k = [name, mac, !!a.on, live].join('|');
        if (k === key) return;
        key = k;
        steps.replaceChildren(
          el('li', { text: tr('On {mac}, open Control Center (top right of the menu bar) and click Screen Mirroring.', { mac }) }),
          el('li', { text: tr('Pick {name}. The Mac’s screen and its sound show in a window here.', { name }) }),
          el('li', { text: tr('Or choose Use As Separate Display there, for a second screen. Over Wi-Fi or a cable between the two.') }),
        );
        state.textContent = live
          ? tr('{device} is mirroring now.', { device: live })
          : a.on ? tr('Receive AirPlay is on: the Mac lists {name}.', { name }) : tr('Receive AirPlay is off, so the Mac doesn’t list this computer yet.');
        state.classList.toggle('on', !!a.on);
        onBtn.hidden = !!a.on;
      },
    };
  };

  // ---------------------------------------------------------------- AirPlay & SMB
  UI.tab({
    id: 'airplay',
    group: 7,
    order: 91,
    icon: 'folder',
    title: 'AirPlay & SMB',
    desc: 'This computer’s shared folder in the Files app on an iPhone or iPad, and AirPlay.',
    color: 'linear-gradient(#ffd60a, #ff9f0a)',
    badge: (s) => ((W(s).share && W(s).share.on) || (W(s).airplay && W(s).airplay.on) ? 'on' : ''),
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
      // The Mac receives AirPlay itself (System Settings), so TwinDesk only points there.
      const mac = /Mac/.test(navigator.platform);
      // A PC or Linux computer: TwinDesk's own receiver (shared/airplay): screen mirroring, with sound.
      const airSw = mac ? null : UI.switch((v) => api().webAirplaySet(v));
      const airRow = mac
        ? UI.row(tr('AirPlay Receiver'), tr('This Mac receives AirPlay itself: System Settings › General › AirDrop & Handoff › AirPlay Receiver. An iPhone or iPad then mirrors to it from Control Center.'))
        : UI.row(tr('Receive AirPlay'), '', [airSw.el], { literalHint: true });
      const liveRow = mac ? null : UI.row(tr('Mirroring'), '', [UI.button(tr('Stop'), () => api().webAirplayStop(), 'small')], { literalHint: true });
      // The receiver's switches (settings.web.airplayMusic / airplaySound / airplayFull).
      const opt = (k) => UI.switch((v) => api().webAirplayOpt({ [k]: v }));
      const musicSw = mac ? null : opt('music');
      const soundSw = mac ? null : opt('sound');
      const fullSw = mac ? null : opt('full');
      const optRows = mac ? [] : [
        UI.row(tr('Music from apps'), tr('Spotify, Music, YouTube and other apps can play to this computer as a speaker, from their AirPlay button.'), [musicSw.el]),
        UI.row(tr('Mirroring sound'), tr('A mirrored screen’s sound from this computer’s speakers. Off: the picture only (the window’s Sound button mutes just that session).'), [soundSw.el]),
        UI.row(tr('Open full screen'), tr('The mirrored screen fills the display. Esc leaves full screen, F11 goes back.'), [fullSw.el]),
      ];
      const airErr = el('div', { class: 'note warn', hidden: true });
      // Where Screen Mirroring is on the iPhone or iPad, right under the switch.
      const guide = UI.mirrorGuide();
      const airCard = UI.card(tr('AirPlay'), mac ? [airRow, guide.el] : [airRow, guide.el, liveRow, ...optRows]);
      // What a device plays here (music from an app), with its controls (shared/ui-nowplaying.js).
      const playing = !mac && UI.airplayPlaying ? UI.airplayPlaying() : null;
      body.append(shareErr, ...(playing ? [playing.el] : []), smbCard, howCard, airErr, airCard);
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
        guide.target((w.airplay && w.airplay.name) || me(s));
        if (!mac) {
          const a = w.airplay || {};
          airSw.set(!!a.on);
          airRow.setHint(a.on
            ? tr('On iPhone or iPad: Control Center › Screen Mirroring › {name}. The screen and its sound show in a window here.', { name: a.name || me(s) })
            : tr('Shows an iPhone’s, iPad’s or Mac’s screen here with Screen Mirroring, for anyone on the same network.'));
          musicSw.set(a.music !== false);
          soundSw.set(a.sound !== false);
          fullSw.set(a.full === true);
          for (const r of optRows) r.hidden = !a.on;
          liveRow.hidden = !a.session;
          if (a.session) {
            liveRow.label.textContent = a.session.mirroring === false ? tr('Playing') : tr('Mirroring');
            const VIA = { ethernet: tr('over Ethernet'), wifi: tr('over Wi-Fi') };
            const via = VIA[a.session.via] ? ' · ' + VIA[a.session.via] : '';
            liveRow.setHint(tr('{name} · since {when}', { name: a.session.name, when: new Date(a.session.since).toLocaleTimeString() }) + via);
          }
          if (playing) playing.update(s);
          airErr.hidden = !a.error;
          airErr.textContent = a.error ? tr('AirPlay couldn’t start: {why}', { why: a.error }) : '';
        }
      };
    },
  });

  // ---------------------------------------------------------------- a web device's pages
  // As a device's own pages (shared/ui-device-*.js and the rest): each with this device's settings
  // (allow, kept by the hub per device). Colours and icons as the sidebar's pages of the same name.
  const like = (id, k) => ((UI.tabs.find((t) => t.id === id) || {})[k]);
  // The same on every platform, whatever order the pages load in (and whatever a platform calls its own).
  const LOOK = {
    share: ['display', 'linear-gradient(#5ac8fa, #0a84ff)'], receive: ['receive', 'linear-gradient(#5ac8fa, #0a84ff)'],
    remote: ['remote', 'linear-gradient(#bf5af2, #8944ab)'], clipboard: ['clipboard', 'linear-gradient(#64d2ff, #30b0c7)'],
    notifications: ['bell', 'linear-gradient(#ff6961, #ff3b30)'], files: ['files', 'linear-gradient(#64d2ff, #0a84ff)'],
    audio: ['audio', 'linear-gradient(#ff6482, #ff2d55)'], camera: ['camera', 'linear-gradient(#bf5af2, #8944ab)'],
  };
  const devPage = (id, base, extra) => UI.tab({ id, web: true, icon: (LOOK[base] || [])[0] || like(base, 'icon') || base, color: (LOOK[base] || [])[1] || like(base, 'color') || 'linear-gradient(#8e8e93, #636366)', ...extra });
  // A switch of this device's settings, and its row.
  const allowSw = (key) => {
    const sw = UI.switch((v) => UI.webDev && api().webAllow({ id: UI.webDev, [key]: v }));
    sw.key = key;
    return sw;
  };
  const setAll = (d, sws) => { for (const sw of sws) sw.set((d.allow || {})[sw.key] !== false); };
  const live = (st) => (st === 'live' ? tr('Live') : st === 'connecting' || st === 'new' ? tr('Connecting…') : st ? tr(String(st).replace(/^error: /, '')) : tr('Off'));

  // 20×20 stroke icons, as the phone's Overview draws them (shared/ui-device-*.js).
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const glyph = (d) => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
    return svg;
  };
  const GL = {
    files: 'M10 13.5V3.5 M6.5 7L10 3.5 13.5 7 M3.5 12.5v3a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-3',
    drop: 'M3.5 4.5h13v9h-7l-4 3v-3h-2z',
    stop: 'M5.5 5.5h9v9h-9z',
    disconnect: 'M8.5 11.5l-1 1a3 3 0 0 1-4.2-4.2l2.2-2.2 M11.5 8.5l1-1a3 3 0 0 1 4.2 4.2l-2.2 2.2 M3 3l14 14',
    screen: 'M2.5 4h15v9.5h-15z M7 17h6 M10 13.5V17',
    receive: 'M2.5 4h15v9.5h-15z M7 17h6 M10 6.5v4.5 M7.8 8.8L10 11l2.2-2.2',
    extend: 'M1.5 5h8v7h-8z M10.5 5h8v7h-8z M4 15h3 M13 15h3',
    control: 'M6 3.5l8.5 7-4 .5 2.3 4.6-1.8.9-2.3-4.6L6 14.5z',
    sound: 'M3 8h3l4-3.5v11L6 12H3z M13 7.5a3.5 3.5 0 0 1 0 5 M15 5.5a6.5 6.5 0 0 1 0 9',
    mic: 'M10 2.5a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0V5A2.5 2.5 0 0 1 10 2.5z M5 9.5a5 5 0 0 0 10 0 M10 14.5v3',
    clip: 'M7 3.5h6v2.5H7z M5.5 4.5h-1v12h11v-12h-1 M7.5 10h5 M7.5 13h3',
    notifs: 'M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5h-12z M8.5 16.5a1.5 1.5 0 0 0 3 0',
    camera: 'M2.5 6h10v8h-10z M12.5 8.5l5-2.5v8l-5-2.5',
    remote: 'M7 2.5h6v15H7z M10 5.5v.1 M8.7 8.5h2.6 M10 7.2v2.6 M8.5 13h3',
    folder: 'M2.5 5.5a1 1 0 0 1 1-1h4l1.5 1.5h7.5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z',
  };
  const iconed = (b, k) => { b.prepend(glyph(GL[k])); b.classList.add('ico'); return b; };
  UI.webGlyph = (k) => glyph(GL[k]);

  // The device's Overview, as a phone's (shared/ui-device-*.js): its picture, name and link; its actions with
  // their icons; what it may do, as quick-action tiles; then Drop and a drop zone for files on the left, and
  // the clipboard on the right.
  UI.tab({
    id: 'wd-overview', web: true, group: 'w0', order: 92, icon: 'overview', title: 'Overview', color: 'linear-gradient(#8e8e93, #636366)',
    build(body, page) {
      page.classList.add('device-page');
      body.setAttribute('data-literal', '');
      const pic = el('div', { class: 'device phone big' });
      const name = el('div', { class: 'hero-name' });
      const sub = el('div', { class: 'hero-status' });
      const facts = el('dl', { class: 'dv-facts' });
      const dropBtn = iconed(UI.button(tr('Send files'), () => UI.webDev && api().webChooseFiles({ id: UI.webDev, kind: 'files' }), 'primary'), 'files');
      const chatBtn = iconed(UI.button(tr('Drop'), () => UI.go('wd-drop')), 'drop');
      const stopBtn = iconed(UI.button(tr('Stop screen'), () => UI.webDev && api().webStopScreen(UI.webDev)), 'stop');
      const offBtn = iconed(UI.button(tr('Disconnect'), () => UI.webDev && api().webDisconnect(UI.webDev)), 'disconnect');
      const hero = el('div', { class: 'card dv-hero' }, [pic, el('div', { class: 'dv-hero-main' }, [name, sub, el('div', { class: 'dv-actions' }, [dropBtn, chatBtn, stopBtn, offBtn])]), facts]);

      // Shortcuts, as a phone's or a computer's Overview has them (shared/ui-device-parts.js tiles):
      // what's done with the device from here in a click, and its pages, customized in place. What it
      // may do (screen, control, files…) is switched on its pages.
      const D = UI.deviceParts;
      const shortcuts = D.tilesCard(tr('Shortcuts'), { key: 'web.shortcuts', standard: { rows: 1,
        items: [{ id: 'files', s: 's' }, { id: 'p.wd-share', s: 's' }, { id: 'p.wd-drop', s: 's' }, { id: 'p.wd-clipboard', s: 's' }] } });
      const webPages = (s) => UI.tabs.filter((x) => x.web && x.id !== 'wd-overview' && !x.navHidden)
        .sort((x, y) => (x.order ?? 50) - (y.order ?? 50)).map((x) => D.pageTile(x.id, s)).filter(Boolean);

      // Drop and Send files on the left; the clipboard on the right.
      const dropList = el('div', { class: 'history web-ov-drop' });
      const dropCard = UI.card(tr('Drop'), [dropList], { actions: [UI.button(tr('Open'), () => UI.go('wd-drop'), 'small link')] });
      const clipText = el('div', { class: 'web-ov-clip' });
      const clipCard = UI.card(tr('Clipboard'), [clipText], { actions: [UI.button(tr('See all'), () => UI.go('wd-clipboard'), 'small link')] });
      const zoneHint = el('div', { class: 'hint' });
      const zone = el('div', { class: 'dropzone dv-drop' }, [el('div', {}, [el('div', { class: 'big', text: tr('Drop files here') }), zoneHint])]);
      const sendCard = UI.card(tr('Send files'), [zone], { actions: [UI.button(tr('Choose…'), () => UI.webDev && api().webChooseFiles({ id: UI.webDev, kind: 'files' }), 'small link')] });
      let canSend = false;
      zone.ondragover = (e) => { e.preventDefault(); if (canSend) zone.classList.add('over'); };
      zone.ondragleave = () => zone.classList.remove('over');
      zone.ondrop = (e) => {
        e.preventDefault();
        zone.classList.remove('over');
        const paths = api().pathsOf ? api().pathsOf([...e.dataTransfer.files]) : [];
        if (canSend && paths.length && UI.webDev) api().webSendFiles({ id: UI.webDev, paths, kind: 'files' });
      };
      const lower = el('div', { class: 'dv-two' }, [el('div', { class: 'dv-col' }, [dropCard, sendCard]), el('div', { class: 'dv-col' }, [clipCard])]);

      // Its pairing (the rest of its connection is in Connection, as for every device).
      const nameIn = el('input', { class: 'web-name', type: 'text', maxLength: 60, attrs: { 'aria-label': tr('Name') } });
      nameIn.onchange = () => UI.webDev && nameIn.value.trim() && api().webRename({ id: UI.webDev, name: nameIn.value });
      const pairCard = UI.card(tr('This device'), [
        UI.row(tr('Name'), tr('How this device appears on this computer'), [nameIn]),
        UI.row(tr('Disconnect'), tr('Ends the connection. The device stays paired and reconnects when Connect is pressed on it.'), [UI.button(tr('Disconnect'), () => UI.webDev && api().webDisconnect(UI.webDev), 'small')]),
        UI.row(tr('Forget this device'), tr('Removes the pairing on both devices, with its messages and file list. Connecting again requires a new pairing code.'), [UI.button(tr('Forget'), () => UI.webDev && api().webForget(UI.webDev), 'small')]),
      ]);
      const airplay = UI.airplayPlaying ? UI.airplayPlaying() : null; // music this device plays here (AirPlay)
      body.append(hero, ...(airplay ? [airplay.el] : []), shortcuts.el, lower, pairCard);
      const fact = (k, v) => (v ? [el('dt', { text: k }), el('dd', { text: v })] : []);
      const tablet = (d) => /ipad|tablet|tab\b|pad/i.test(`${d.model || ''} ${d.os || ''}`);
      let dropKey = '';
      return (s) => {
        if (airplay) airplay.update(s);
        const d = UI.webDevOf(s);
        if (!d) return;
        name.textContent = d.name;
        sub.textContent = [kind(d), status(d), d.online && d.rtt != null ? tr('{value} ms', { value: d.rtt }) : ''].filter(Boolean).join(' · ');
        pic.className = `device big ${['mac', 'win', 'linux'].includes(d.os) ? (d.os === 'mac' ? 'mac' : 'pc') : 'phone'}${tablet(d) ? ' tablet' : ''}`;
        const al = d.allow || {};
        const w = W(s);
        shortcuts.render([
          { id: 'files', label: tr('Send files'), icon: GL.files, color: 'linear-gradient(#64d2ff, #0a84ff)', has: !!d.online && al.files !== false,
            state: tr('To {name}', { name: d.name }), run: () => api().webChooseFiles({ id: d.id, kind: 'files' }) },
          { id: 'stop', label: tr('Stop screen'), icon: GL.stop, color: 'linear-gradient(#ff6961, #ff3b30)', has: !!d.watching, run: () => api().webStopScreen(d.id) },
          { id: 'disconnect', label: tr('Disconnect'), icon: GL.disconnect, color: 'linear-gradient(#8e8e93, #636366)', has: !!d.online, run: () => api().webDisconnect(d.id) },
          ...webPages(s),
        ]);
        stopBtn.hidden = !d.watching;
        offBtn.hidden = !d.online;
        dropBtn.disabled = !d.online;
        canSend = !!d.online && al.files !== false;
        zone.classList.toggle('off', !canSend);
        zoneHint.textContent = !d.online ? tr('{name} is not connected', { name: d.name }) : al.files === false ? tr('File transfer is turned off for this device') : tr('Files appear on the device’s Files page until they are saved.');
        // Drop: the latest few.
        const chat = (d.chat || []).filter((x) => x.kind !== 'files').slice(-5).reverse();
        const k = JSON.stringify(chat.map((x) => x.id));
        if (k !== dropKey) {
          dropKey = k;
          dropList.replaceChildren(...(chat.length ? chat.map((x) => {
            const r = UI.row(x.file ? `📎 ${x.file.name}` : String(x.text || '').replace(/\s+/g, ' ').slice(0, 140), `${x.from === 'pc' ? tr('You') : d.name} · ${ago(x.at)}`, [], { literal: true });
            r.classList.add('click');
            r.onclick = () => UI.go('wd-drop');
            return r;
          }) : [el('div', { class: 'hint web-ov-none', text: tr('No messages yet') })]));
        }
        const c = w.clip || {};
        clipText.textContent = al.clipOut === false ? tr('Clipboard sharing is turned off for this device') : c.text ? c.text.slice(0, 400) : tr('Nothing copied yet');
        clipText.classList.toggle('hint', al.clipOut === false || !c.text);
        if (document.activeElement !== nameIn) nameIn.value = d.name;
        const alt = d.alerts || {};
        const notes = d.push ? [alt.clip && tr('Clipboard'), alt.drop && tr('Messages'), alt.files && tr('Files'), alt.notifs && tr('Notifications')].filter(Boolean).join(', ') || tr('None') : tr('Off');
        facts.replaceChildren(
          ...fact(tr('Address'), d.ip),
          ...fact(tr('Connection'), d.online ? [d.link === 'USB-C' ? 'USB-C' : d.link ? tr(d.link) : '', d.secure ? tr('Secure') : tr('Not secure')].filter(Boolean).join(' · ') : tr('Offline')),
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
      const stRow = UI.row(tr('Status'), '', [UI.button(tr('Stop'), () => UI.webDev && api().webStopScreen(UI.webDev), 'small')], { literalHint: true });
      const extRow = UI.row(tr('Extend'), '', [extendSw]);
      // Sharing settings, as for a computer or a phone: which display, how smooth, how sharp.
      const set = (k) => (v) => UI.webDev && api().webAllow({ id: UI.webDev, [k]: v });
      let dispKey = '';
      const dispSel = UI.select ? UI.select([{ value: '', label: tr('Main display') }], set('display')) : null;
      const dispRow = dispSel ? UI.row(tr('Display'), tr('The display shown in Mirror mode. Extend always adds a separate display.'), [dispSel]) : null;
      const fpsSeg = UI.segmented ? UI.segmented([{ value: '0', label: tr('Auto') }, { value: '30', label: '30 fps' }, { value: '60', label: '60 fps' }], (v) => set('fps')(Number(v))) : null;
      const mbpsSel = UI.select ? UI.select([[0, tr('As the device asks')], [4, tr('Low (4 Mbps)')], [8, tr('Medium (8 Mbps)')], [12, tr('High (12 Mbps)')], [20, tr('Very high (20 Mbps)')], [30, tr('Highest (30 Mbps)')]].map(([value, label]) => ({ value: String(value), label })), (v) => set('mbps')(Number(v))) : null;
      body.append(
        UI.card(tr('Share screen'), [
          UI.row(tr('Allow this device to view this screen'), tr('Includes this computer’s audio when the device requests it.'), [screenSw]),
          extRow,
          UI.row(tr('Allow this device to control this computer'), tr('Mouse, keyboard and pen from the screen viewer, and the Remote page.'), [controlSw]),
        ]),
        UI.card(tr('Sharing'), [
          dispRow,
          q ? UI.row(tr('Highest resolution'), tr('The picture never goes above this, whatever the device picks.'), [q]) : null,
          fpsSeg ? UI.row(tr('Frame rate'), tr('60 for video and games, 30 saves battery and Wi-Fi.'), [fpsSeg]) : null,
          mbpsSel ? UI.row(tr('Quality'), tr('More is sharper on a strong Wi-Fi; less holds up on a weak one.'), [mbpsSel]) : null,
        ].filter(Boolean)),
        UI.card(tr('Status'), [stRow]),
      );
      return (s) => {
        const d = UI.webDevOf(s);
        if (!d) return;
        setAll(d, [screenSw, extendSw, controlSw]);
        if (q) q.set(String((d.allow || {}).maxH || 0));
        const al = d.allow || {};
        const ds = W(s).displays || [];
        if (dispSel && dispSel.options) {
          const k = JSON.stringify(ds);
          if (k !== dispKey) { dispKey = k; dispSel.options([{ value: '', label: tr('Main display') }, ...ds.filter((x) => !x.main).map((x) => ({ value: x.id, label: `${x.label} · ${x.w} × ${x.h}` }))]); }
        }
        if (dispRow) dispRow.hidden = ds.length < 2;
        if (dispSel) dispSel.set(ds.some((x) => x.id === al.display) ? al.display : '');
        if (fpsSeg) fpsSeg.set(String(al.fps || 0));
        if (mbpsSel) mbpsSel.set(String(al.mbps || 0));
        extRow.setHint(W(s).extend ? tr('Adds a separate display that matches the device’s screen') : tr('Not available while this screen is shared with the other computer'));
        const st = d.watching;
        stRow.setHint(st ? `${st.video ? (st.mode === 'extend' ? tr('Extended screen') : tr('Mirrored screen')) : tr('Sound only')} · ${live(st.status)}` : tr('Not watching'));
        stRow.querySelector('button').hidden = !st;
      };
    },
  });

  devPage('wd-receive', 'receive', {
    group: 'w1', order: 92.11, title: 'Receive screen',
    desc: 'The device’s screen in a window on this computer. The device starts it from its Send Screen page.',
    build(body) {
      const sw = allowSw('share');
      const fullSw = allowSw('scrFull');
      const topSw = allowSw('scrTop');
      const soundSw = allowSw('scrSound');
      const set = (k) => (v) => UI.webDev && api().webAllow({ id: UI.webDev, [k]: Number(v) });
      const resSel = UI.select ? UI.select([[0, tr('Automatic')], [720, '720p'], [1080, '1080p'], [1440, '1440p'], [2160, '4K']].map(([value, label]) => ({ value: String(value), label })), set('scrMaxH')) : null;
      const fpsSeg = UI.segmented ? UI.segmented([{ value: '0', label: tr('Auto') }, { value: '15', label: '15 fps' }, { value: '30', label: '30 fps' }, { value: '60', label: '60 fps' }], set('scrFps')) : null;
      const showBtn = UI.button(tr('Show Window'), () => api().webShowScr && api().webShowScr(), 'small');
      const stopBtn = UI.button(tr('Stop'), () => UI.webDev && api().webStopCam({ id: UI.webDev, kind: 'scr' }), 'small');
      const stRow = UI.row(tr('Status'), '', [showBtn, stopBtn], { literalHint: true });
      const howRow = UI.row(tr('How to start'), '', [], { literalHint: true });
      body.append(
        UI.card(tr('Receive screen'), [UI.row(tr('Allow screen sharing from this device'), tr('Its screen opens in a window here. Closing the window ends the session.'), [sw]), stRow]),
        UI.card(tr('Window'), [
          UI.row(tr('Open in full screen'), tr('The window fills this display when sharing starts. Press Esc to leave full screen.'), [fullSw]),
          UI.row(tr('Keep on top'), tr('The window stays above other windows.'), [topSw]),
          UI.row(tr('Play audio'), tr('Plays the shared tab or screen audio when the device includes it.'), [soundSw]),
        ]),
        UI.card(tr('Quality'), [
          resSel ? UI.row(tr('Maximum resolution'), tr('The highest resolution the device sends. Applies the next time it starts sharing.'), [resSel]) : null,
          fpsSeg ? UI.row(tr('Frame rate'), tr('60 fps for video and animation, 15 fps for documents and slides on a weak network.'), [fpsSeg]) : null,
        ].filter(Boolean)),
        UI.card('', [howRow]),
      );
      return (s) => {
        const d = UI.webDevOf(s);
        if (!d) return;
        setAll(d, [sw, topSw, soundSw]);
        fullSw.set((d.allow || {}).scrFull === true);
        topSw.set((d.allow || {}).scrTop === true);
        if (resSel) resSel.set(String((d.allow || {}).scrMaxH || 0));
        if (fpsSeg) fpsSeg.set(String((d.allow || {}).scrFps || 0));
        const c = (W(s).cam || {}).scr;
        const mine = c && c.dev === d.id;
        stRow.setHint(mine ? live(c.status) : tr('Not sharing'));
        showBtn.hidden = !mine;
        stopBtn.hidden = !mine;
        howRow.setHint(d.os === 'ios' || d.os === 'ipados'
          ? tr('iPhone and iPad share their screens with AirPlay: on the device, open Control Center › Screen Mirroring and choose this computer.')
          : tr('On the device, open Send Screen in TwinDesk Web and choose Start Presenting. The browser asks which screen, window or tab to share.'));
      };
    },
  });

  devPage('wd-remote', 'remote', {
    group: 'w2', order: 92.2, title: 'Remote',
    desc: 'Use the device as a touchpad, keyboard and gamepad for this computer.',
    build(body) {
      const sw = allowSw('control');
      const stRow = UI.row(tr('Status'), '', [], { literalHint: true });
      const padSw = UI.switch((v) => api().webRemotePad && api().webRemotePad(v));
      const padRow = UI.row(tr('Real gamepad'), '', [padSw]);
      const padNote = UI.note ? UI.note('info', '') : null;
      body.append(
        UI.card(tr('Remote'), [UI.row(tr('Allow this device to control this computer'), tr('Touchpad, keyboard and gamepad on the device’s Remote page, and the pointer and keyboard in its screen viewer.'), [sw]), stRow]),
        UI.card(tr('Gamepad'), [padRow, padNote].filter(Boolean)),
      );
      return (s) => {
        const d = UI.webDevOf(s);
        if (!d) return;
        setAll(d, [sw]);
        const r = W(s).remote || {};
        const p = r.pad || {};
        padSw.set(!!p.on);
        if (padSw.disable) padSw.disable(!p.supported || !!p.busy);
        padRow.setHint(!p.supported ? tr('Not available on this computer. The gamepad’s buttons send keys instead.')
          : p.busy ? tr(p.busy)
            : !p.on ? tr('Off. The gamepad’s sticks and buttons send keys and mouse input.')
              : p.live ? tr('On. The device’s gamepad appears to games as a controller ({controller}).', { controller: p.name || tr('Xbox 360 Controller') })
                : tr('On. Ready when the device opens its gamepad.'));
        if (padNote) { padNote.set(p.message ? tr(p.message) : ''); }
        stRow.setHint(d.remote ? (r.why ? tr(r.why) : r.using ? tr('In use') : tr('Open on the device')) : tr('Not open on the device'));
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
          UI.row(tr('Send this computer’s clipboard to it'), tr('Text copied on this computer appears on the device’s Clipboard page, and as an alert when TwinDesk Web is in the background.'), [out]),
          UI.row(tr('Receive the device’s clipboard'), tr('Text and photos sent from the device (its Clipboard page or a Shortcut) are placed on this computer’s clipboard.'), [inn]),
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
      body.append(UI.card(tr('Notifications'), [UI.row(tr('Send this computer’s notifications'), tr('Notifications appear on the device’s Notifications page, and as alerts when TwinDesk Web is in the background. The device chooses which kinds it is alerted for.'), [sw]), devRow]));
      return (s) => {
        const d = UI.webDevOf(s);
        if (!d) return;
        setAll(d, [sw]);
        devRow.setHint(!d.notifs ? tr('Turned off on the device (Notifications page)') : d.push && (d.alerts || {}).notifs ? tr('On, with alerts in the background') : tr('On. Shown while TwinDesk Web is open'));
      };
    },
  });

  devPage('wd-files', 'files', {
    group: 'w3', order: 92.32, title: 'Files',
    desc: 'Files from the device, and where they go.',
    build(body) {
      const sw = allowSw('files');
      const folderRow = UI.row(tr('Save them in'), '', [UI.button(tr('Choose…'), () => UI.webDev && api().webChooseFolder(UI.webDev), 'small'), UI.button(tr('Default'), () => UI.webDev && api().webAllow({ id: UI.webDev, folder: '' }), 'small')], { literalHint: true });
      // At the top, as on a phone's or a computer's Files page: drop files here to send them.
      const zoneHint = el('div', { class: 'hint' });
      const zone = el('div', { class: 'dropzone dv-drop web-files-zone' }, [el('div', {}, [el('div', { class: 'big', text: tr('Drop files here to send') }), zoneHint])]);
      zone.onclick = () => UI.webDev && api().webChooseFiles({ id: UI.webDev, kind: 'files' });
      let canSend = false;
      zone.ondragover = (e) => { e.preventDefault(); if (canSend) zone.classList.add('over'); };
      zone.ondragleave = () => zone.classList.remove('over');
      zone.ondrop = (e) => {
        e.preventDefault();
        zone.classList.remove('over');
        const paths = api().pathsOf ? api().pathsOf([...e.dataTransfer.files]) : [];
        if (canSend && paths.length && UI.webDev) api().webSendFiles({ id: UI.webDev, paths, kind: 'files' });
      };
      body.append(
        UI.card(tr('Send files'), [zone], { actions: [UI.button(tr('Choose…'), () => UI.webDev && api().webChooseFiles({ id: UI.webDev, kind: 'files' }), 'small link')] }),
        UI.card(tr('Files'), [
          UI.row(tr('Receive files from this device'), tr('Each file is also available to the Paste Files shortcut: press it in a folder or app to paste it there. Photos are placed on the clipboard too.'), [sw]),
          folderRow,
        ]),
      );
      // Transfers both ways: what it sent, and what's waiting for it or on its way.
      const list = el('div', { class: 'web-xfers' });
      const none = el('div', { class: 'hint web-xfers-none', text: tr('Nothing yet') });
      const xcard = UI.card(tr('Transfers'), [none, list]);
      body.append(xcard);
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
        canSend = !!d.online;
        zone.classList.toggle('off', !canSend);
        zoneHint.textContent = d.online ? tr('or click to choose. They wait on {name}’s Files page until it saves them.', { name: d.name }) : tr('{name} is not connected', { name: d.name });
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

  // Audio › Capture: which engine records this computer's sound (for every device it plays on), and
  // muting this computer while it does, offered only where the engine can (the helper's on a Mac,
  // Windows' loopback). On the Audio tab and on a web device's Audio page.
  UI.audioCaptureCard = (o = {}) => {
    const sel = UI.select([], (v) => api().webAudio && api().webAudio({ engine: v }));
    const engRow = UI.row(tr('Capture engine'), '', [sel]);
    const muteSw = UI.switch((v) => api().webAudio && api().webAudio({ mute: v }));
    const muteRow = UI.row(tr('Mute this computer while sending'), tr('Its speakers stay silent while its sound plays on another device.'), [muteSw]);
    const card = UI.card(tr('Capture'), [engRow, muteRow]);
    return {
      el: card,
      update(s) {
        const a = W(s).audio;
        card.hidden = !a;
        if (!a) return;
        sel.options(a.engines.map((x) => ({ value: x.id, label: x.label })));
        sel.set(a.engine);
        sel.el.disabled = a.engines.length < 2;
        const cur = a.engines.find((x) => x.id === a.engine) || a.engines[0] || {};
        engRow.setHint([cur.hint, a.restart ? tr('Restart TwinDesk to use it.') : ''].filter(Boolean).join(' '));
        muteRow.hidden = !cur.mute || o.mute === false; // the page has its own
        muteSw.set(!!a.mute);
      },
    };
  };

  devPage('wd-audio', 'audio', {
    group: 'w4', order: 92.4, title: 'Audio',
    desc: 'This computer’s sound on the device, and the device’s microphone here.',
    build(body) {
      const snd = allowSw('sound');
      const mic = allowSw('mic');
      const micRow = UI.row(tr('Status'), '', [UI.button(tr('Stop'), () => UI.webDev && api().webStopCam({ id: UI.webDev, kind: 'mic' }), 'small')], { literalHint: true });
      const cap = UI.audioCaptureCard();
      body.append(
        UI.card(tr('Computer audio'), [UI.row(tr('Allow this device to play this computer’s audio'), tr('With the screen, or on its own from the device’s Audio page.'), [snd])]),
        cap.el,
        UI.card(tr('Microphone'), [UI.row(tr('Use the device’s microphone on this computer'), tr('Routed to a virtual audio device when one is installed (BlackHole, VB-CABLE); otherwise played through the speakers.'), [mic]), micRow]),
      );
      return (s) => {
        cap.update(s);
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
      const camRow = UI.row(tr('Status'), '', [UI.button(tr('Stop'), () => UI.webDev && api().webStopCam({ id: UI.webDev, kind: 'cam' }), 'small')], { literalHint: true });
      const picCard = UI.card('', [el('div', { class: 'web-cam-box' }, [img])]);
      body.append(
        UI.card(tr('Camera'), [
          UI.row(tr('Use the device’s camera on this computer'), '', [sw]),
          camRow,
          UI.row(tr('In other apps'), tr('Video apps on this computer can select TwinDesk Camera (Camera › Virtual Camera) to use it.'), [UI.button(tr('Camera'), () => { UI.webDev = null; UI.go('camera'); }, 'small')]),
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
  // With a web device's pages: the Connection page's hero is this computer and that device, as for any
  // connection (the same picture, link line and moving pulse), with its own Disconnect.
  const webHero = () => {
    const linkLine = el('div', { class: 'hero-link' }, [el('span', { class: 'hero-pulse' })]);
    const linkText = el('div', { class: 'hero-link-text' });
    const meName = el('div', { class: 'hero-name', attrs: { 'data-literal': '' } });
    const devName = el('div', { class: 'hero-name', attrs: { 'data-literal': '' } });
    const meDev = el('div', { class: 'device pc' });
    const devPic = el('div', { class: 'device phone' });
    const status = el('div', { class: 'hero-status', attrs: { 'data-literal': '' } });
    const offBtn = UI.button(tr('Disconnect'), () => UI.webDev && api().webDisconnect(UI.webDev), 'small');
    const openBtn = UI.button(tr('Overview'), () => UI.go('wd-overview'), 'small');
    const hero = el('div', { class: 'card hero web-hero' }, [
      el('div', { class: 'hero-devices' }, [
        el('div', { class: 'hero-device' }, [meDev, meName]),
        el('div', { class: 'hero-mid' }, [linkLine, linkText]),
        el('div', { class: 'hero-device' }, [devPic, devName]),
      ]),
      status,
      el('div', { class: 'hero-actions' }, [openBtn, offBtn]),
    ]);
    let was = null;
    hero.render = (s) => {
      const d = UI.webDevOf(s);
      hero.hidden = !d;
      const page = hero.closest('.page, section');
      if (page) page.classList.toggle('web-mode', !!d);
      if (!d) { was = null; return; }
      const w = W(s);
      const me = w.me || {};
      meName.textContent = me.name || '';
      meDev.className = `device ${me.os === 'mac' ? 'mac' : 'pc'}`;
      devName.textContent = d.name;
      devPic.className = `device ${['mac', 'win', 'linux'].includes(d.os) ? (d.os === 'mac' ? 'mac' : 'pc') : 'phone'}`;
      const up = !!d.online;
      linkLine.className = `hero-link${up ? ' up' : ''}`;
      // Just connected: the line fills in and both pictures light up once, as the HUD shows it.
      if (up && was === false) {
        hero.classList.remove('just');
        void hero.offsetWidth;
        hero.classList.add('just');
        setTimeout(() => hero.classList.remove('just'), 1600);
      }
      was = up;
      linkText.textContent = up ? [tr('TwinDesk Web'), d.link === 'USB-C' ? 'USB-C' : '', d.secure ? tr('Secure') : tr('Not secure')].filter(Boolean).join(' · ') : tr('Not connected');
      status.textContent = up ? (d.watching ? (d.watching.mode === 'extend' ? tr('{name} is extending this screen', { name: d.name }) : tr('{name} is viewing this screen', { name: d.name })) : tr('Connected'))
        : tr('Paired. It connects when TwinDesk Web is opened on it. {when}', { when: status_(d) });
      offBtn.hidden = !up;
    };
    return hero;
  };
  const status_ = (d) => status(d);

  UI.webConnCard = () => {
    const list = el('div');
    const card = UI.card(tr('TwinDesk Web'), [list], { actions: [UI.button(tr('Pair a Device…'), () => UI.go('web'), 'small')] });
    const hero = webHero();
    let key = '';
    let placed = false;
    return {
      el: card,
      render(s) {
        // The hero goes first on the page, once the card is on it.
        if (!placed && card.parentNode) { placed = true; card.parentNode.prepend(hero); }
        hero.render(s);
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
  // The line under TwinDesk at the top of the sidebar while a web device's pages show: that device,
  // its link and round trip (as for a connected computer), not the computer's own connection.
  UI.webPeerLine = (s) => {
    const d = UI.webDev && UI.webDevOf(s);
    if (!d) return null;
    const text = d.online ? [d.name, d.link === 'USB-C' ? 'USB-C' : '', d.rtt != null ? tr('{value} ms', { value: d.rtt }) : ''].filter(Boolean).join(' · ')
      : `${d.name} · ${tr('Not connected')}`;
    return { text, dot: d.online ? 'good' : '' };
  };
  UI.webTiles = (box, s, pick) => {
    arrange(!!UI.webDev);
    queueMicrotask(tidyGaps);
    if (!box) return;
    const w = W(s);
    const list = w.running ? w.devices.filter((d) => d.online || d.id === UI.webDev) : [];
    const key = JSON.stringify([list.map((d) => [d.id, d.name, d.online, d.background, d.rtt, d.link, d.watching && d.watching.status, d.watching && d.watching.mode]), UI.webDev]);
    if (key === tilesKey) return;
    tilesKey = key;
    box.replaceChildren(...list.map((d) => {
      // As the phones' and computers' tiles: its round trip while connected, then what it's doing.
      const ms = d.rtt != null ? tr('{value} ms', { value: d.rtt }) : '';
      const sub = d.online ? [ms || (d.background ? '' : tr('Connected')), d.link === 'USB-C' ? 'USB-C' : '', d.watching ? (d.watching.mode === 'extend' ? tr('Extending') : tr('Viewing')) : d.background ? tr('In the background') : ''].filter(Boolean).join(' · ')
        : tr('Last seen {when}', { when: ago(d.lastSeen) });
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

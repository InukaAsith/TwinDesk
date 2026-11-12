// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The tour for someone new to TwinDesk, and What's new after an update (Mac, Windows, Linux).
//
// The tour runs once, on the first start of a new install (an install that already paired something,
// or kept anything in this window's storage, is not new): New to TwinDesk? → what it's for (another
// computer, a phone) → which one → how to install TwinDesk there (drawn, with a QR code for a phone)
// → how to connect (the real Connection page) → a demo device in the sidebar and the real pages of
// what it does, each pointed at over the window. Skip is always there; after that it is only in
// General › Tutorial (Tour.start). What's new (Tour.news): once per release that has a list, never
// on a new install, never with pictures. Nothing here is an image: the drawings are CSS and the app
// icon the sidebar already has, so the installers don't grow by anything but this text.
//
// The tour only looks: a shade over the window takes the clicks, the pages are the real ones (a page
// hidden with nothing connected is let through while it's shown: UI.tourPeek), and the demo device
// is a drawn tile, not a connection. Per-window storage (localStorage) as Arrange and the feature
// introductions keep theirs.
'use strict';

(() => {
  const { el, api } = UI;
  const t = (...a) => I18n.t(...a);
  const KEY = 'td.tour';
  const MAC = /Mac/.test(navigator.platform);

  // What's new, newest first: shown once when the app's version starts with `v` (3.1.0, 3.1.2…).
  const NEWS = [
    { v: '3.1', items: [
      ['Deck', 'Tiles on your phone that run shortcuts, media, sound, brightness and Bluetooth on this computer, full screen, with widgets and a window space to arrange your windows.'],
      ['Multi-device, out of beta', 'Every computer and phone at once, now with fast files, Camera, Remote, the Deck and ReZume, and phones paired with a QR code.'],
      ['Air mouse and Presentation', 'Point the phone to move the pointer, or run your slides from it, with a laser pointer.'],
      ['Search everywhere', 'Find any setting, shortcut or feature by what it does: the search button beside each page’s title, or {key}.'],
      ['Arrange the sidebar', 'Put the pages in your own order.'],
      ['History that stays', 'The clipboard’s and notifications’ history kept across restarts, encrypted, for a day up to a year. Off until you turn it on.'],
      ['Updates install in place', 'Install now updates TwinDesk without a trip to the download page.'],
      ['Modules', 'Switch off the pages you don’t use in General › Modules. They aren’t even loaded.'],
      ['TwinDesk iPhone', 'Install the iPhone app with your own Apple ID from this computer, and keep it refreshed. Opt in.'],
      ['A tour of TwinDesk', 'For someone new: how to install it on the other device, connect, and what each page does. In General › Tutorial.'],
    ] },
  ];

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } };
  const save = (o) => { try { localStorage.setItem(KEY, JSON.stringify({ ...(load() || {}), ...o })); } catch (_) { /* this time only */ } };
  const newsFor = (version) => NEWS.find((n) => String(version || '').startsWith(n.v + '.')) || null;

  // ---- the overlay -------------------------------------------------------------------------------

  let root = null; // the overlay while a tour or What's new is open
  let onEnd = null;
  let hole = null; // the element pointed at (its rect cut out of the shade)
  let ring = null; // a second one, outlined (a page's sidebar item)
  let cap = 0; // the hole no taller than this part of the window (a page: its top, the card below it)

  function open(kind) {
    close();
    const shade = el('div', { class: 'tour-shade' });
    const cut = el('div', { class: 'tour-hole', hidden: true });
    const outline = el('div', { class: 'tour-ring', hidden: true });
    const card = el('div', { class: 'tour-card', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-live': 'polite' } });
    const skip = el('button', { class: 'tour-skip', text: kind === 'news' ? t('Close') : t('Skip tour'), title: t('Esc') });
    skip.onclick = () => end();
    root = el('div', { class: 'tour ' + kind }, [shade, cut, outline, card, skip]);
    document.body.append(root);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    return card;
  }

  function close() {
    if (!root) return;
    root.remove();
    root = null;
    hole = ring = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
  }

  function end() {
    const fn = onEnd;
    onEnd = null;
    close();
    if (fn) fn();
  }

  function onKey(e) {
    if (!root) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); return; }
    // Keys stay in the tour (the window's own shortcuts, ⌘K, would open under it).
    if (!root.contains(e.target)) { e.preventDefault(); e.stopPropagation(); }
  }

  // Point at `target` (the page) and outline `outlined` (its sidebar item); the card goes beside it.
  function point(target, outlined, top = 0) {
    hole = target || null;
    ring = outlined || null;
    cap = top;
    place();
  }

  function place() {
    if (!root) return;
    const cut = root.querySelector('.tour-hole');
    const outline = root.querySelector('.tour-ring');
    const card = root.querySelector('.tour-card');
    const W = window.innerWidth;
    const H = window.innerHeight;
    const rectOf = (e, most = 0) => {
      if (!e || !e.isConnected) return null;
      const r = e.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      // Inside the window, and a page no taller than what shows of it.
      const x = Math.max(4, r.left - 6);
      const y = Math.max(4, r.top - 6);
      const h = Math.min(H - 4, r.bottom + 6) - y;
      return { x, y, w: Math.min(W - 4, r.right + 6) - x, h: most ? Math.min(h, Math.round(H * most)) : h };
    };
    const set = (node, r) => {
      node.hidden = !r;
      if (r) Object.assign(node.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    };
    const h = rectOf(hole, cap);
    const o = rectOf(ring);
    set(cut, h);
    set(outline, o);
    root.classList.toggle('pointing', !!h);
    // The card: beside the hole where there's room, else under it, over it, or over its lower part;
    // centred without one.
    card.style.left = card.style.top = '';
    card.classList.remove('beside');
    if (!h) return;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    let x;
    let y;
    if (h.x + h.w + 16 + cw <= W - 12) { x = h.x + h.w + 16; y = h.y + 24; }
    else if (h.x - 16 - cw >= 12) { x = h.x - 16 - cw; y = h.y + 24; }
    else if (h.y + h.h + 14 + ch <= H - 12) { x = h.x + 24; y = h.y + h.h + 14; }
    else if (h.y - 14 - ch >= 12) { x = h.x + 24; y = h.y - 14 - ch; }
    else { x = h.x + h.w - cw - 24; y = h.y + h.h - ch - 24; }
    x = Math.max(12, Math.min(W - cw - 12, x));
    y = Math.max(12, Math.min(H - ch - 12, y));
    card.classList.add('beside');
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  }

  // One screen of the card: {title, text, art, choices: [{label, primary, go}], back, step: [i, n]}.
  function screen(card, s) {
    const body = [];
    if (s.step) body.push(el('div', { class: 'tour-dots', attrs: { 'aria-label': t('Step {n} of {total}', { n: s.step[0] + 1, total: s.step[1] }) } },
      Array.from({ length: s.step[1] }, (_, i) => el('span', { class: i === s.step[0] ? 'on' : i < s.step[0] ? 'done' : '' }))));
    if (s.kicker) body.push(el('div', { class: 'tour-kicker', text: s.kicker }));
    body.push(el('h2', { text: s.title }));
    if (s.text) body.push(el('p', { text: s.text }));
    if (s.art) body.push(s.art);
    if (s.extra) body.push(s.extra);
    const buttons = (s.choices || []).map((c) => {
      const b = UI.button(c.label, c.go, c.primary ? 'primary' : '');
      if (c.wide) b.classList.add('wide');
      return b;
    });
    const row = el('div', { class: 'tour-actions' + (s.stack ? ' stack' : '') }, [
      s.back ? el('button', { class: 'btn tour-back', text: t('Back'), onclick: s.back }) : null,
      el('span', { class: 'tour-gap' }),
      ...buttons,
    ]);
    if (s.back) row.firstChild.onclick = s.back;
    body.push(row);
    card.classList.toggle('wide', !!s.wide);
    card.replaceChildren(...body);
    place();
    const first = card.querySelector('.tour-actions .primary') || card.querySelector('.tour-actions button');
    if (first) first.focus({ preventScroll: true });
  }

  // ---- drawings (CSS only) ------------------------------------------------------------------------

  const icon = () => el('span', { class: 'app-mark tour-icon' });

  // A device with TwinDesk going onto it: the bar fills, the icon lands, a tick.
  function installArt(device, lines) {
    const screenEl = el('div', { class: 'tour-screen' }, [
      el('div', { class: 'tour-bar' }, [el('span')]),
      icon(),
      el('span', { class: 'tour-tick', text: '✓' }),
    ]);
    const frame = el('div', { class: 'tour-device ' + device }, [screenEl]);
    const steps = el('ol', { class: 'tour-steps' }, lines.map((l) => el('li', { text: l })));
    return el('div', { class: 'tour-art' }, [frame, steps]);
  }

  // A QR code for the phone's camera (shared/qr.js), with what it opens.
  function qr(url, label) {
    let code = null;
    try { code = window.Qr && Qr.canvas(url, 112); } catch (_) { code = null; }
    if (!code) return null;
    code.classList.add('tour-qr-code');
    return el('div', { class: 'tour-qr' }, [code, el('span', { text: label })]);
  }

  // Two devices, a line between them, a code on both.
  function connectArt(a, b) {
    return el('div', { class: 'tour-art connect' }, [
      el('div', { class: 'tour-device ' + a }, [el('div', { class: 'tour-screen' }, [el('span', { class: 'tour-code', text: '482 913' })])]),
      el('div', { class: 'tour-link' }, [el('span'), el('span'), el('span')]),
      el('div', { class: 'tour-device ' + b }, [el('div', { class: 'tour-screen' }, [el('span', { class: 'tour-code', text: '482 913' })])]),
    ]);
  }

  // ---- the demo device ----------------------------------------------------------------------------

  let demo = null;
  let demoWatch = null;

  function demoOn(kind, name) {
    demoOff();
    const where = document.getElementById(kind === 'pc' ? 'pcs' : 'phones');
    if (!where) return null;
    const dot = el('span', { class: 'spin', attrs: { 'aria-hidden': 'true' } });
    const sub = el('span', { class: 'tour-demo-sub', text: t('Connecting…') });
    demo = el('div', { class: 'phone-tile tour-demo connected' }, [
      el('span', { class: 'phone-wall tour-demo-wall' }, [UI.icon(kind === 'pc' ? 'display' : 'phone')]),
      el('span', { class: 'phone-text' }, [el('span', { class: 'phone-name', text: name }), sub]),
      dot,
    ]);
    where.append(demo);
    // The sidebar draws its tiles again on a change: the demo goes back in at the end.
    demoWatch = new MutationObserver(() => { if (demo && !demo.isConnected) where.append(demo); });
    demoWatch.observe(where, { childList: true });
    setTimeout(() => {
      if (!demo) return;
      dot.className = 'dot good';
      sub.textContent = t('Demo · {value} ms', { value: 4 });
      demo.classList.add('live');
    }, 1100);
    return demo;
  }

  function demoOff() {
    if (demoWatch) demoWatch.disconnect();
    demoWatch = null;
    if (demo) demo.remove();
    demo = null;
  }

  // ---- the tour -----------------------------------------------------------------------------------

  const LINK = { iphone: 'https://twin-desk.vercel.app/#iphone', android: 'https://twin-desk.vercel.app/#android', download: 'https://twin-desk.vercel.app/#download' };
  const NAMES = { iphone: 'iPhone', android: 'Android', mac: 'Mac', win: 'Windows PC', linux: 'Linux computer' };

  // The pages shown with the demo device: the first id of each that this app has.
  const FEATURES = {
    android: [
      [['mirror'], 'Its screen, here', 'The phone’s screen in a window. Tap with the mouse, type with this keyboard, and open its apps in windows of their own.'],
      [['messages'], 'Texts', 'Read and send the phone’s texts from this computer.'],
      [['calls'], 'Calls', 'Answer and make calls here, the sound through this computer’s speakers and microphone.'],
      [['notifications'], 'Notifications', 'The phone’s notifications on this computer, with Reply and dismiss.'],
      [['remote'], 'Remote', 'The phone as this computer’s touchpad, keyboard, air mouse, presentation remote with a laser, or gamepad.'],
      [['deck'], 'Deck', 'Tiles on the phone that run shortcuts, media, sound and brightness here, and arrange your windows. Lay them out on this page.'],
      [['camera'], 'Camera', 'The phone’s camera as a webcam for Zoom, Teams or Meet.'],
      [['clipboard'], 'Clipboard', 'Copy on the phone, paste here, and back: text and pictures.'],
      [['files'], 'Files', 'Send files and folders either way, from the share menu or by dropping them here.'],
      [['rezume'], 'ReZume', 'Pick up where you left off: the tab, video or document you were on, on the other device.'],
    ],
    iphone: [
      [['remote'], 'Remote', 'The iPhone as this computer’s touchpad, keyboard, air mouse, presentation remote with a laser, or gamepad.'],
      [['deck'], 'Deck', 'Tiles on the iPhone that run shortcuts, media, sound and brightness here, and arrange your windows. Lay them out on this page.'],
      [['camera'], 'Camera', 'The iPhone’s camera as a webcam for Zoom, Teams or Meet.'],
      [['clipboard'], 'Clipboard', 'Copy on the iPhone, paste here, and back: text and pictures.'],
      [['files'], 'Files', 'Send files and photos either way, from the share sheet or by dropping them here.'],
      [['rezume'], 'ReZume', 'Pick up where you left off: the tab, video or document you were on, on the other device.'],
    ],
    pc: [
      [['cursor'], 'One mouse', 'Move the pointer off the edge of this screen and it carries on onto the other computer. The keyboard follows it.'],
      [['clipboard'], 'Clipboard', 'Copy on one computer, paste on the other: text, pictures and files.'],
      [['files'], 'Files', 'Drag a file across the edge of the screen and drop it there, or send whole folders.'],
      [['receive', 'mac-pc'], 'The other screen', 'See the other computer’s screen in a window here, or use it as a second display.'],
      [['apps'], 'Apps', 'Open the other computer’s apps in windows of their own, next to this computer’s.'],
      [['camera'], 'Camera', 'One computer’s camera on the other, and as a camera other apps can pick.'],
      [['rezume'], 'ReZume', 'Walk to the other computer and carry on with the tab, video or document you were on.'],
    ],
  };

  const pageOf = (ids) => ids.find((id) => document.getElementById('page-' + id));
  const navOf = (id) => document.querySelector(`.nav-item[aria-controls="page-${id}"]`);

  function go(id) {
    UI.tourPeek = id; // a page hidden with nothing connected (the Deck, Mirroring) shows for now
    UI.go(id);
  }

  function start() {
    if (root) return;
    const before = UI.state && UI.state.ui && UI.state.ui.tab;
    const card = open('tour');
    const a = {}; // the answers: use ('pc' | 'phone'), os
    onEnd = () => {
      demoOff();
      UI.tourPeek = null;
      UI.go(before || 'connection');
    };

    const welcome = () => {
      point(null);
      screen(card, {
        kicker: t('Welcome to TwinDesk'),
        title: t('New to TwinDesk? Let’s have a look.'),
        text: t('A minute or two: how to put TwinDesk on your other device, connect it, and what you can do then. You can skip it at any time.'),
        art: el('div', { class: 'tour-hero' }, [icon()]),
        choices: [
          { label: t('Skip'), go: end },
          { label: t('Show me how TwinDesk works'), primary: true, go: use },
        ],
      });
    };

    const use = () => {
      point(null);
      screen(card, {
        title: t('What will you mainly use TwinDesk for?'),
        text: t('You can connect both later. This only picks what the tour shows.'),
        back: welcome,
        stack: true,
        choices: [
          { label: t('To connect another computer'), wide: true, go: () => { a.use = 'pc'; which(); } },
          { label: t('To connect a phone or tablet'), wide: true, primary: true, go: () => { a.use = 'phone'; which(); } },
        ],
      });
    };

    const which = () => {
      const phone = a.use === 'phone';
      screen(card, {
        title: phone ? t('Which phone?') : t('What is the other computer?'),
        back: use,
        stack: true,
        choices: phone
          ? [{ label: t('iPhone or iPad'), wide: true, go: () => { a.os = 'iphone'; install(); } },
            { label: t('Android phone or tablet'), wide: true, go: () => { a.os = 'android'; install(); } }]
          : [{ label: 'Mac', wide: true, go: () => { a.os = 'mac'; install(); } },
            { label: 'Windows', wide: true, go: () => { a.os = 'win'; install(); } },
            { label: 'Linux', wide: true, go: () => { a.os = 'linux'; install(); } }],
      });
    };

    const install = () => {
      const os = a.os;
      const extraRow = (...kids) => el('div', { class: 'tour-extra' }, kids.filter(Boolean));
      const link = (label, key) => UI.button(label, () => api.openLink(key), 'small');
      let s;
      if (os === 'iphone') {
        s = {
          title: t('TwinDesk on the iPhone or iPad'),
          text: t('Two ways, both free. With no app: on the same Wi-Fi, open Safari and type twindesk.local. Or the app, through AltStore (or SideStore), with more it can do.'),
          art: installArt('phone', [
            t('No app: Safari › twindesk.local'),
            t('The app: open our iPhone page there and tap Add to AltStore'),
            t('Open TwinDesk and allow what it asks'),
          ]),
          extra: extraRow(qr(LINK.iphone, t('Scan with the iPhone’s camera for our iPhone page')), link(t('Open the iPhone page'), 'siteIphone')),
        };
      } else if (os === 'android') {
        s = {
          title: t('TwinDesk on the Android phone'),
          text: t('Download TwinDesk from our Android page on the phone and install it. Android asks once to allow installs from the browser.'),
          art: installArt('phone', [
            t('Scan the code, or open twin-desk.vercel.app'),
            t('Download TwinDesk and install it'),
            t('Open it and allow what it asks'),
          ]),
          extra: extraRow(qr(LINK.android, t('Scan with the phone’s camera for our Android page')), link(t('Open the Android page'), 'siteAndroid')),
        };
      } else {
        const how = {
          mac: [t('Download the Mac app (Apple silicon or Intel), or brew install --cask inukaasith/twindesk/twindesk'), t('Drag TwinDesk into Applications and open it'), t('Allow Accessibility and Screen Recording when it asks')],
          win: [t('Download TwinDesk Setup (x64 or ARM)'), t('Run it: TwinDesk installs and opens'), t('Allow it through the firewall when Windows asks')],
          linux: [t('Download the AppImage, .deb or the Arch package, or add our apt repository'), t('Install it, or make the AppImage executable'), t('Open TwinDesk')],
        }[os];
        s = {
          title: t('TwinDesk on the {device}', { device: t(NAMES[os]) }),
          text: t('On that computer, open twin-desk.vercel.app and download TwinDesk. It’s the same app as this one.'),
          art: installArt('laptop', how),
          extra: extraRow(link(t('Open the download page'), 'siteDownload')),
        };
      }
      point(null);
      screen(card, { ...s, wide: true, back: which, choices: [{ label: t('Next'), primary: true, go: connect }] });
    };

    const connect = () => {
      go('connection');
      setTimeout(() => {
        const phone = a.use === 'phone';
        point(document.getElementById('page-connection'), navOf('connection'), 0.42);
        screen(card, {
          kicker: t('Connect'),
          title: t('Then pair them, once'),
          text: phone
            ? (a.os === 'iphone'
              ? t('Keep both on the same Wi-Fi. Open TwinDesk on the iPhone (or twindesk.local in Safari) and pick this computer, or scan the QR code on this page. Check that both show the same code.')
              : t('Keep both on the same Wi-Fi, or plug the phone in with a cable. Open TwinDesk on the phone and tap this computer, or scan the QR code on this page. Check that both show the same code.'))
            : t('Open TwinDesk on both. The other computer shows up here as Nearby: click it, and check that both show the same code. No shared Wi-Fi? A cable or Bluetooth works too.'),
          art: connectArt(phone ? 'laptop' : 'laptop', phone ? 'phone' : 'laptop'),
          back: install,
          choices: [{ label: t('Show me a demo'), primary: true, go: () => demoStep(0) }],
        });
      }, 120);
    };

    const list = () => (FEATURES[a.use === 'pc' ? 'pc' : a.os] || []).map(([ids, title, text]) => ({ id: pageOf(ids), title, text })).filter((f) => f.id);

    const demoStep = (i) => {
      const feats = list();
      const name = t('Demo {device}', { device: t(NAMES[a.os] || 'device') });
      if (i === 0) {
        UI.tourPeek = null;
        point(null);
        const tile = demoOn(a.use === 'pc' ? 'pc' : 'phone', name);
        point(tile);
        screen(card, {
          kicker: t('Demo'),
          title: t('Connected'),
          text: t('This is how a connected device looks: here in the sidebar, with its ping{battery}. Click it to open its page. The demo isn’t a real connection: the pages next are the real ones, waiting for your device.', { battery: a.use === 'phone' ? t(' and battery') : '' }),
          back: connect,
          choices: [{ label: t('Show me what it can do'), primary: true, go: () => demoStep(1) }],
        });
        return;
      }
      const f = feats[i - 1];
      if (!f) { done(); return; }
      go(f.id);
      setTimeout(() => {
        point(document.getElementById('page-' + f.id), navOf(f.id), 0.42);
        screen(card, {
          kicker: t('What it can do'),
          title: t(f.title),
          text: t(f.text),
          step: [i - 1, feats.length],
          back: () => demoStep(i - 1),
          choices: [{ label: i === feats.length ? t('Finish') : t('Next'), primary: true, go: () => demoStep(i + 1) }],
        });
      }, 120);
    };

    const done = () => {
      demoOff();
      UI.tourPeek = null;
      go('general');
      setTimeout(() => {
        point(navOf('general'), navOf('general'));
        screen(card, {
          kicker: t('That’s it'),
          title: t('You’re all set'),
          text: t('Pages you haven’t turned on explain themselves when you open them. To see this tour again, or what’s new, go to General › Tutorial.'),
          choices: [{ label: t('Done'), primary: true, go: () => { onEnd = () => { UI.tourPeek = null; UI.go('connection'); }; end(); } }],
        });
      }, 120);
    };

    welcome();
  }

  // ---- What's new ---------------------------------------------------------------------------------

  function news(version) {
    if (root) return;
    const n = newsFor(version) || NEWS[0];
    if (!n) return;
    const card = open('news');
    point(null);
    const key = MAC ? '⌘K' : 'Ctrl K';
    screen(card, {
      kicker: t('TwinDesk {version}', { version: version && version.startsWith(n.v) ? version : n.v }),
      title: t('What’s new'),
      wide: true,
      extra: el('ul', { class: 'tour-news' }, n.items.map(([title, text]) => el('li', {}, [el('strong', { text: t(title) }), el('span', { text: t(text, { key }) })]))),
      choices: [{ label: t('Show me around'), go: () => { end(); start(); } }, { label: t('Continue'), primary: true, go: end }],
    });
  }

  // ---- once, at start ---------------------------------------------------------------------------

  // Someone who already used TwinDesk: anything paired, or anything this window keeps. Not phones
  // merely seen nearby: a new install on a network where phones run TwinDesk sees them at once, and
  // skipped the welcome for it.
  const used = (s) => {
    let kept = 0;
    try { kept = localStorage.length; } catch (_) { kept = 0; }
    const ph = s.phone || {};
    return kept > 0 || (Array.isArray(s.paired) ? s.paired.length > 0 : !!s.paired) || (s.guests || []).length > 0
      || !!s.client || !!(s.link && s.link.state === 'connected') || !!ph.connected || (ph.paired || []).length > 0;
  };

  const ready = () => {
    const setup = document.querySelector('.setup-page');
    return !(setup && !setup.hidden) && !document.querySelector('#banner:not([hidden])') && !document.querySelector('.updater-modal, .modal-backdrop:not([hidden])');
  };

  let checked = false;
  function maybe(s) {
    if (checked || !s) return;
    checked = true;
    const version = s.version || '';
    let seen = load();
    if (!seen) { // first start with this code: a new install, or an update from before it
      seen = used(s) ? { tour: true, news: '' } : { tour: false, news: version };
      save(seen);
    }
    // After the Mac's permissions screen, a pairing or an update popup: however long that takes.
    // Marked as seen when it opens (a restart from the permissions screen brings it back).
    const wait = (fn) => setTimeout(() => (ready() ? fn() : wait(fn)), 1500);
    if (!seen.tour) {
      wait(() => { save({ tour: true, news: version }); start(); }); // once, even if it's skipped or the app quits half way
    } else if (newsFor(version) && seen.news !== version) {
      wait(() => { save({ news: version }); news(version); });
    }
  }

  window.Tour = { start, news: () => news(UI.state && UI.state.version), maybe };
})();

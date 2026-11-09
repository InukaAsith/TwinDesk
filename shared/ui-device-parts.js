// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The pieces every device's Overview is made of (Mac, PC and Linux). Each kind of device has its
// own Overview page that puts them together:
//   shared/ui-device-pc.js       another computer
//   shared/ui-device-android.js  an Android phone
//   shared/ui-device-ios.js      an iPhone or iPad
// (TwinDesk Web devices: shared/ui-web.js.)
// The pieces: the page's setup, the hero (picture, name, link, battery, the actions, the facts),
// what plays there, ReZume's offer, and below: the notifications on the left, on the right the
// clipboard's recent items, the most used apps (a phone that says them) and a drop zone that sends
// files. A column with nothing in it gives the other the whole width; with nothing on, none of it
// shows. What the other side doesn't report (an older TwinDesk) is left out, not shown as off.
'use strict';

(function () {
  const t = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
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
  const otpOf = (text) => (window.Otp ? window.Otp.otpOf(text) : '');
  // The PC and Linux say the session in s.link, the Mac in s.client.
  const linked = (s) => !!(s && ((s.link && s.link.state === 'connected') || s.client || (s.phone && s.phone.connected)));
  const viaOf = (s) => (UI.via ? UI.via(s) : s.client && s.client.transport === 'ble' ? t('Bluetooth') : t('Wi-Fi'));
  // Each action button with its icon (20×20 strokes, the colour of its text).
  const ICO = {
    show: 'M6.5 2.5h7a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z M9 15h2',
    ring: 'M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5h-12z M8.5 16.5a1.5 1.5 0 0 0 3 0',
    lock: 'M5 9h10v8H5z M7 9V6.5a3 3 0 0 1 6 0V9 M10 12v2',
    sleep: 'M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z',
    wifi: 'M2.5 7.5a11 11 0 0 1 15 0 M5 10.3a7.3 7.3 0 0 1 10 0 M7.6 13a3.5 3.5 0 0 1 4.8 0 M10 15.8v.1',
    hotspot: 'M10 10.5v.1 M7.3 13a3.8 3.8 0 0 1 0-5.2 M12.7 7.8a3.8 3.8 0 0 1 0 5.2 M4.8 15.4a7.3 7.3 0 0 1 0-10.2 M15.2 5.2a7.3 7.3 0 0 1 0 10.2',
    disconnect: 'M8.5 11.5l-1 1a3 3 0 0 1-4.2-4.2l2.2-2.2 M11.5 8.5l1-1a3 3 0 0 1 4.2 4.2l-2.2 2.2 M3 3l14 14',
  };
  // A button's words, its icon kept.
  const label = (b, text) => { const n = [...b.childNodes].find((x) => x.nodeType === 3); if (n) n.nodeValue = text; else b.append(text); };

  const P = {
    t, glyph, linked, viaOf,

    // The page's own setup: { h1, desc, row, doIt }. Device data is shown as it is (data-literal).
    setup(body, page) {
      page.classList.add('device-page');
      const h1 = page.querySelector('h1 span');
      const desc = page.querySelector('.page-head p');
      for (const node of [body, h1, desc]) node.setAttribute('data-literal', '');
      const row = (lbl, hint, controls = []) => UI.row(lbl, hint, controls, { literal: true });
      const doIt = (c) => (UI.api.deviceDo ? UI.api.deviceDo(c) : Promise.resolve());
      return { h1, desc, row, doIt };
    },

    // An action button with its icon: key one of ICO's.
    button(text, key, onclick) {
      const b = UI.button(text, onclick);
      b.prepend(glyph(ICO[key]));
      b.classList.add('ico');
      return b;
    },

    // Ring / Stop ringing, with its note under the buttons: { btn, note, update(ctl) }.
    ring(doIt) {
      let ringing = false;
      const note = UI.el('div', { class: 'hint dv-ring-note', text: '' });
      const paint = () => {
        label(btn, ringing ? t('Stop ringing') : t('Ring'));
        btn.classList.toggle('danger', ringing);
        note.textContent = ringing ? t('Rings at full volume, even on silent, until you stop it here or there.') : '';
        note.hidden = !ringing;
      };
      const btn = P.button(t('Ring'), 'ring', () => { ringing = !ringing; doIt({ do: ringing ? 'ring' : 'ringStop' }); paint(); });
      return {
        btn, note,
        update(ctl) {
          btn.hidden = !(ctl && ctl.can && ctl.can.ring);
          if (ctl && typeof ctl.ringing === 'boolean' && ctl.ringing !== ringing) ringing = ctl.ringing;
          paint();
        },
      };
    },

    // Use Wi-Fi Direct / Back to Bluetooth: { btn, update(s) }; shown on Bluetooth or while on it.
    wifi() {
      let on = false;
      const btn = P.button(t('Use Wi-Fi Direct'), 'wifi', () => UI.api.netWifi(!on));
      return {
        btn,
        update(s) {
          const n = s.net || {};
          on = (n.why || []).includes('user') || !!n.linked;
          label(btn, on ? t('Back to Bluetooth') : t('Use Wi-Fi Direct'));
          const ble = n.transport === 'ble' || !!(s.client && s.client.transport === 'ble'); // the Mac says it on s.client
          btn.hidden = !(on || ble);
          return { on, ble, n };
        },
      };
    },

    // The hero card: the picture, name, link line, battery, the actions given, and the facts.
    // Returns { el, pic, name, sub, facts, battery(level, charging), setFacts([[label, value]…]) }.
    hero(actions, note) {
      const { el } = UI;
      const pic = el('div', { class: 'device phone big' });
      const name = el('div', { class: 'hero-name' });
      const sub = el('div', { class: 'hero-status' });
      const batt = el('div', { class: 'dv-batt' }, [el('div', { class: 'dv-batt-fill' })]);
      const battText = el('span', { class: 'dv-batt-text' });
      const battRow = el('div', { class: 'dv-batt-row' }, [batt, battText]);
      const facts = el('dl', { class: 'dv-facts' });
      const card = el('div', { class: 'card dv-hero' }, [
        pic,
        el('div', { class: 'dv-hero-main' }, [name, sub, battRow, el('div', { class: 'dv-actions' }, actions), note || null]),
        facts,
      ]);
      return {
        el: card, pic, name, sub,
        battery(level, charging) {
          battRow.hidden = level == null;
          if (level == null) return;
          batt.firstChild.style.width = Math.max(2, Math.min(100, level)) + '%';
          batt.classList.toggle('low', level <= 20);
          battText.textContent = t('{level}%{charging}', { level, charging: charging ? ' · ' + t('Charging') : '' });
        },
        // [[label, value]…]: the ones with a value; dd: an element in place of a value.
        setFacts(list) {
          const out = [];
          for (const [k, v] of list) {
            if (!v) continue;
            out.push(el('dt', { text: k }), v instanceof Node ? v : el('dd', { text: v }));
          }
          facts.replaceChildren(...out);
          facts.hidden = !facts.childElementCount;
        },
      };
    },

    // A phone's picture: its wallpaper, else its colours.
    phonePic(pic, info) {
      pic.className = 'device big phone';
      if (UI.phoneWall) pic.style.setProperty('--phone-wall', UI.phoneWall);
      else if (info.colors && info.colors.length) pic.style.setProperty('--phone-wall', `linear-gradient(160deg, ${info.colors.join(', ')}${info.colors.length === 1 ? `, ${info.colors[0]}` : ''})`);
      else pic.style.removeProperty('--phone-wall');
    },

    // Which TwinDesk it runs (dev.state's app: shared/appinfo.js), red when older than this one.
    version(ctl) {
      const ac = ctl && ctl.appCheck;
      if (!ac) return null;
      const dd = UI.el('dd', { text: ac.version || t('Older') });
      dd.classList.toggle('dv-old', ac.older);
      dd.title = ac.older ? t('Older than this one. Update it there: some features need the same version on both') : '';
      return dd;
    },

    // What plays there (shared/ui-nowplaying.js): { el, update(s, ov) }.
    media() {
      const media = UI.nowPlaying ? UI.nowPlaying() : null;
      const card = UI.el('div', { class: 'card dv-media' }, media ? [media.el] : []);
      return {
        el: card,
        update(s, ov) {
          if (media) media.update(s);
          card.hidden = !media || media.el.hidden || (s.audio || {}).phoneMedia === false || ov.media === false;
        },
      };
    },

    // Music an iPhone, iPad or Mac plays here (AirPlay): { el, update(s) } or null.
    airplay() {
      return UI.airplayPlaying ? UI.airplayPlaying() : null;
    },

    // ReZume's offer from the device: { el, update(s, devName) } or null.
    rezume() {
      const rz = UI.rezumeCard ? UI.rezumeCard() : null;
      if (!rz) return null;
      const title = rz.el.querySelector('[data-peer]');
      return {
        el: rz.el,
        update(s, devName) {
          if (title) title.textContent = t('Continue from {name}', { name: devName });
          rz.update(s, true);
        },
      };
    },

    // Below the rest: notifications on the left; clipboard, most used apps (withApps) and send
    // files on the right. Returns { el, update(s, { phone, devName, top, ready }) }.
    lower(row, { withApps = false } = {}) {
      const { el, api } = UI;
      const notifList = el('div');
      const notifCard = UI.card(t('Latest notifications'), [notifList], { actions: [UI.button(t('See all'), () => UI.go('notifications'), 'small link')] });
      const clipList = el('div', { class: 'history' });
      const clipCard = UI.card(t('Clipboard'), [clipList], { actions: [UI.button(t('See all'), () => UI.go('clipboard'), 'small link')] });
      const appsGrid = el('div', { class: 'app-grid dv-apps' });
      const appsCard = withApps ? UI.card(t('Most used'), [appsGrid], { actions: [UI.button(t('All apps'), () => UI.go('papps'), 'small link')] }) : null;
      const dropHint = el('div', { class: 'hint' });
      const zone = el('div', { class: 'dropzone dv-drop' }, [el('div', {}, [el('div', { class: 'big', text: t('Drop files here') }), dropHint])]);
      const dropCard = UI.card(t('Send files'), [zone], { actions: [UI.button(t('Choose…'), () => api.chooseSendFiles(), 'small link')] });
      let canSend = false;
      zone.ondragover = (e) => { e.preventDefault(); if (canSend) zone.classList.add('over'); };
      zone.ondragleave = () => zone.classList.remove('over');
      zone.ondrop = (e) => {
        e.preventDefault();
        zone.classList.remove('over');
        // As an array: a FileList reaches the preload as a plain object, which can't be iterated.
        if (canSend) api.sendFiles(api.pathsOf([...e.dataTransfer.files]));
      };
      const cards = [notifCard, clipCard, ...(appsCard ? [appsCard] : []), dropCard];
      const left = el('div', { class: 'dv-col' }, [notifCard]);
      const right = el('div', { class: 'dv-col' }, cards.slice(1));
      const lower = el('div', { class: 'dv-two' }, [left, right]);
      // The cards that are on fill the two columns with no gaps: notifications first on the left, then each
      // card in whichever column is shorter (a tie: the left). One card, or a narrow window: one column.
      // Nodes move only when a card's column changes (moving one mid-drag would drop the drag).
      const narrow = window.matchMedia('(max-width: 860px)');
      const flow = () => {
        const shown = cards.filter((c) => !c.hidden);
        lower.hidden = !shown.length;
        if (lower.hidden) return;
        left.hidden = right.hidden = false; // a card in a hidden column measures 0
        const one = shown.length < 2 || narrow.matches;
        let hl = 0;
        let hr = 0;
        const plan = shown.map((c) => {
          const col = one || hl <= hr ? left : right;
          if (col === left) hl += c.offsetHeight; else hr += c.offsetHeight; // the columns are the same width
          return [c, col];
        });
        for (const col of [left, right]) {
          const want = plan.filter(([, x]) => x === col).map(([c]) => c);
          const have = [...col.children].filter((c) => !c.hidden);
          if (want.length !== have.length || want.some((c, i) => c !== have[i])) col.append(...want);
        }
        left.hidden = !plan.some(([, x]) => x === left);
        right.hidden = !plan.some(([, x]) => x === right);
        lower.classList.toggle('one', left.hidden || right.hidden);
      };
      narrow.addEventListener('change', flow);

      let notifKey = '';
      let clipKey = '';
      let appsKey = '';
      return {
        el: lower,
        update(s, { phone, devName, top = [], ready = false }) {
          const ov = (s.ui && s.ui.overview) || {}; // General › Overview: what's left out

          // latest notifications: while Notifications is on
          const nf = s.notifs || {};
          const history = (nf.history || []).slice(0, 6);
          notifCard.hidden = !nf.receive || ov.notifs === false;
          const nk = JSON.stringify([history.map((h) => [h.id, h.at, h.actions]), Object.keys(nf.historyIcons || {}).length, devName, phone]);
          if (nk !== notifKey) {
            notifKey = nk;
            notifList.replaceChildren(...(history.length ? history.map((item) => {
              const text = [item.subtitle, item.body].filter(Boolean).join(' · ');
              const code = otpOf([item.title, item.body].join(' '));
              const copy = code ? UI.button(t('Copy {code}', { code }), () => api.copyText(code), 'small') : null;
              // A phone's: its own buttons (Mark as read…), and × dismisses it there too (shared/notifacts.js).
              const acts = phone && api.notifReply ? (item.actions || []).map((a, i) => UI.button(a, () => api.notifReply({ id: item.id, act: i }), 'small')) : [];
              const x = phone && api.notifReply ? UI.button('×', () => api.notifReply({ id: item.id, dismiss: true }), 'small') : null;
              if (x) { x.title = t('Dismiss'); x.setAttribute('aria-label', t('Dismiss')); }
              const r = row([item.appName || item.app, item.title].filter(Boolean).join(' · '), (text || t('Notification')) + ' · ' + UI.ago(item.at), [copy, ...acts, x]);
              const icon = (nf.historyIcons || {})[item.app];
              if (icon) {
                r.querySelector('.text').prepend(el('img', { class: 'dv-nicon', src: icon, alt: '' }));
                r.classList.add('with-ico');
              }
              return r;
            }) : [row(t('Nothing yet'), t('New notifications from {name} show here', { name: devName }))]));
          }

          // the clipboard's recent items: while Clipboard is on
          const cb = s.clipboard || {};
          const recent = (cb.history || []).slice(0, 4);
          clipCard.hidden = !cb.enabled || ov.clipboard === false;
          const ck = JSON.stringify([recent.map((h) => [h.at, h.dir, !!(h.image && h.image.copy)]), cb.historySize, devName, Math.floor(Date.now() / 15000)]);
          if (!clipCard.hidden && ck !== clipKey) {
            clipKey = ck;
            clipList.replaceChildren(...(recent.length ? recent.map((h, i) => el('div', { class: 'hist-item' }, [
              el('span', { class: 'hist-dir ' + h.dir, title: t(h.dir === 'out' ? 'Sent to {name}' : 'From {name}', { name: devName }) }, [UI.icon(h.dir === 'out' ? 'up' : 'down')]),
              h.image && h.image.thumb ? el('img', { class: 'hist-thumb', src: h.image.thumb, alt: '' }) : null,
              el('div', { class: 'hist-text' }, [
                el('div', { class: 'hist-preview', text: h.image ? (h.image.shot ? t('Screenshot') : t('Picture')) + ' · ' + h.image.w + ' × ' + h.image.h : String(h.text || '').replace(/\s+/g, ' ').trim() || t('(whitespace)') }),
                el('div', { class: 'hint', text: t(h.dir === 'out' ? 'To {name}' : 'From {name}', { name: devName }) + ' · ' + UI.ago(h.at) }),
              ]),
              !h.image || h.image.copy ? UI.button(t('Copy'), () => api.copyHistory(i), 'small') : null,
            ])) : [row(cb.historySize === 0 ? t('Recent items are off') : t('Nothing yet'), cb.historySize === 0 ? t('Turn them on in Clipboard') : t('What’s copied on either side shows here'))]));
          }

          // send files: while sending files is on (the Mac has no switch for it: always)
          const fl = s.files || {};
          canSend = fl.dropToMac !== false;
          dropCard.hidden = !canSend || ov.files === false;
          dropHint.textContent = t('They go to {name}’s Downloads', { name: devName });

          // most used apps: the phone's own order (Usage access), else what was opened from here
          if (appsCard) {
            const apps = (UI.phoneAssets && UI.phoneAssets.apps) || [];
            const list = top.map((id) => apps.find((a) => a.id === id)).filter(Boolean).slice(0, 8);
            appsCard.hidden = !list.length || ov.apps === false;
            const ak = JSON.stringify([list.map((a) => a.id), ready]);
            if (ak !== appsKey) {
              appsKey = ak;
              appsGrid.replaceChildren(...list.map((a) => {
                const b = el('button', { class: 'app-tile', title: t('Open {app}', { app: a.name }), disabled: !ready }, [UI.appIcon(a.icon), el('span', { text: a.name })]);
                b.onclick = () => api.phoneOpenApp({ id: a.id, name: a.name });
                return b;
              }));
            }
          }
          flow();
        },
      };
    },
  };

  UI.deviceParts = P;
})();

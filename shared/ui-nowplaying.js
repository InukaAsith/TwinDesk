// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone's media controls (Mac, PC and Linux), on the right of the Phone page's card:
// what plays there (its art, title, artist and app), Previous, Play/Pause, Next and where it is,
// only while something plays (and a few minutes after a pause). Audio › Media controls on the Phone page
// turns it off. UI.nowPlaying() → {el, update(state)}; state.phoneMedia from shared/nowplaying.js.
// UI.phoneAudioCard() → {el, update(state)}: the Audio tab's phone rows, that switch and Play phone
// sound here (Bluetooth) (state.btAudio from shared/btaudio.js; null where it can't be: the Mac).
'use strict';

// General › Media controls on the Phone page: the same setting as the Audio tab's, there with or without a
// phone connected. UI.mediaControlsRow() → {el, update(state)}.
UI.mediaControlsRow = () => {
  const t = (...args) => typeof I18n === 'undefined' ? args[0] : I18n.t(...args);
  const sw = UI.switch((v) => UI.api.setAudio({ phoneMedia: v }), { label: t('Media controls on the Phone page') });
  const row = UI.row(t('Media controls on the Phone page'), '', [sw]);
  return {
    el: row,
    update(s) {
      const on = (s.audio || {}).phoneMedia !== false;
      sw.set(on);
      const m = s.phoneMedia;
      row.setHint(on && m && m.why === 'listener'
        ? t('Needs the full TwinDesk app on the phone, with its notification access on')
        : t('What plays on a connected phone, with Play, Pause, Next and Previous, on the Phone page while it plays'));
    },
  };
};

UI.phoneAudioCard = () => {
  const t = (...args) => typeof I18n === 'undefined' ? args[0] : I18n.t(...args);
  const { el, api } = UI;
  const bt = UI.switch((v) => api.setAudio({ phoneBt: v }), { label: t('Play phone sound here (Bluetooth)') });
  const btRow = UI.row(t('Play phone sound here (Bluetooth)'), '', [bt]);
  const pick = UI.select([], (id) => api.phoneBtPick(id));
  const pickRow = UI.row(t('The phone'), t('Paired with this computer over Bluetooth'), [pick]);
  const media = UI.switch((v) => api.setAudio({ phoneMedia: v }), { label: t('Media controls on the Phone page') });
  const mediaRow = UI.row(t('Media controls on the Phone page'), '', [media]);
  // Play phone sound here (Audio's switch): Auto, Full (ADB) or Limited (Native, shared/phonemodes.js).
  const soundVia = UI.segmented([{ value: 'auto', label: t('Auto') }, { value: 'adb', label: t('Full (ADB)') }, { value: 'native', label: t('Limited') }], (v) => api.setPhone({ soundVia: v }));
  const viaRow = UI.row(t('Phone sound goes through'), '', [soundVia.el]);
  const card = UI.card('{name}', [viaRow, btRow, pickRow, mediaRow]);
  return {
    el: card,
    update(s) {
      card.hidden = !UI.isPhone(s) || s.btAudio === undefined; // Multi-device has neither yet
      if (card.hidden) return;
      const a = s.audio || {};
      const b = s.btAudio;
      const br = (s.phone && s.phone.bridge) || {};
      const phone = (s.phone && s.phone.connected && s.phone.connected.name) || t('the phone');
      viaRow.hidden = !br.soundMode; // a computer from before the choice
      if (!viaRow.hidden) {
        soundVia.set(br.soundMode || br.soundVia || 'native');
        const ready = br.state === 'ready';
        viaRow.setHint(br.soundMode === 'auto' ? (ready ? t('Auto: Full (ADB), wireless debugging is ready') : t('Auto: Limited until wireless debugging is set up'))
          : br.soundVia === 'native' ? t('Limited: {phone} captures its own sound (Android 10 or later). It keeps playing there too, and some apps don’t allow it', { phone })
            : t('Full (ADB): through wireless debugging, which moves the sound off {phone}', { phone }) + (ready ? '' : t(' (not set up yet)')));
      }
      bt.set(!!(b ? b.on : false));
      bt.disable(!b);
      btRow.setHint(!b ? t('This computer can’t take a phone’s sound over Bluetooth (macOS has no Bluetooth speaker mode)')
        : b.on && b.text ? t(b.text)
          : t('This computer as {name}’s Bluetooth speaker: its music, videos and every other sound play here. Pair them in Bluetooth settings first'));
      const choose = !!(b && b.on && b.devices && b.devices.length && (b.state === 'choose' || b.state === 'playing'));
      pickRow.hidden = !choose;
      if (choose) {
        pick.options([{ value: '', label: t('Choose…') }, ...b.devices.map((d) => ({ value: d.id, label: d.name }))]);
        pick.set(b.state === 'choose' ? '' : b.device);
      }
      media.set(a.phoneMedia !== false);
      const m = s.phoneMedia;
      mediaRow.setHint(m && m.why === 'listener' && a.phoneMedia !== false
        ? t('Needs the full TwinDesk app on {name}, with its notification access on')
        : t('What plays on {name}, with Play, Pause, Next and Previous, on the Phone page while it plays'));
    },
  };
};

UI.nowPlaying = () => {
  const t = (...args) => typeof I18n === 'undefined' ? args[0] : I18n.t(...args);
  const { el, api } = UI;
  const svg = (d) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 20 20');
    s.innerHTML = d;
    return s;
  };
  const PLAY = '<path d="M6.5 4.5v11l9-5.5z"/>';
  const PAUSE = '<path d="M6 4.5h2.5v11H6z M11.5 4.5H14v11h-2.5z"/>';
  const ctl = (a, d, label) => {
    const b = el('button', { class: 'np-btn', title: label, attrs: { 'aria-label': label } }, [svg(d)]);
    b.onclick = () => api.phoneMedia({ a });
    return b;
  };
  const art = el('div', { class: 'np-art' });
  const title = el('div', { class: 'np-title' });
  const sub = el('div', { class: 'np-sub' });
  const prev = ctl('prev', '<path d="M5 4.5v11 M15.5 4.5v11L7 10z"/>', t('Previous'));
  const play = ctl('toggle', PLAY, t('Play'));
  const next = ctl('next', '<path d="M15 4.5v11 M4.5 4.5v11L13 10z"/>', t('Next'));
  const bar = el('div', { class: 'np-bar' }, [el('div', { class: 'np-fill' })]);
  const time = el('div', { class: 'np-time' });
  const box = el('div', { class: 'np', hidden: true }, [
    art,
    el('div', { class: 'np-main' }, [title, sub, el('div', { class: 'np-pos' }, [bar, time])]),
    el('div', { class: 'np-ctl' }, [prev, play, next]),
  ]);

  let now = null;
  let lastArt = null;
  const clock = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  const pos = () => (now.playing ? now.position + (Date.now() - now.at) * (now.speed || 1) : now.position);
  // Where it is, moved on between messages while it plays.
  const tick = () => {
    if (!now || box.hidden) return;
    const d = now.duration;
    const p = Math.min(d || Infinity, Math.max(0, pos()));
    bar.hidden = time.hidden = !(d > 0 && now.position >= 0);
    bar.firstChild.style.width = d > 0 ? (100 * p / d).toFixed(1) + '%' : '0';
    time.textContent = clock(p) + ' / ' + clock(d);
  };
  setInterval(tick, 1000);
  // Click the bar: there (when the app can seek).
  bar.onclick = (e) => {
    if (!now || !now.seek || !(now.duration > 0)) return;
    const r = bar.getBoundingClientRect();
    api.phoneMedia({ a: 'seek', pos: Math.round(now.duration * Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))) });
  };

  return {
    el: box,
    update(s) {
      const m = s.phoneMedia;
      now = UI.isPhone(s) && m && m.now ? m.now : null;
      box.hidden = !now;
      if (!now) return;
      if (now.art !== lastArt) {
        lastArt = now.art;
        art.style.backgroundImage = now.art ? `url("${now.art}")` : '';
        art.classList.toggle('none', !now.art);
      }
      title.textContent = now.title;
      sub.textContent = [now.artist, now.appName].filter(Boolean).join(' · ');
      play.replaceChildren(svg(now.playing ? PAUSE : PLAY));
      play.title = now.playing ? t('Pause') : t('Play');
      play.setAttribute('aria-label', play.title);
      prev.disabled = !now.prev;
      next.disabled = !now.next;
      bar.classList.toggle('seek', !!now.seek);
      tick();
    },
  };
};

// Music an iPhone, iPad or Mac plays here over AirPlay (shared/airplay/viewer.js: state.web.airplay
// .session.now): its art, title, artist and album, where it is, Previous, Play/Pause and Next (sent
// back to the device) and Stop. On the Audio and Overview pages, only while it plays.
// UI.airplayPlaying() → {el, update(state)}.
UI.airplayPlaying = () => {
  const t = (...args) => typeof I18n === 'undefined' ? args[0] : I18n.t(...args);
  const { el } = UI;
  const call = (a) => UI.api && UI.api.webAirplayCtl && UI.api.webAirplayCtl(a);
  const svg = (d) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 20 20');
    s.innerHTML = d;
    return s;
  };
  const PLAY = '<path d="M6.5 4.5v11l9-5.5z"/>';
  const PAUSE = '<path d="M6 4.5h2.5v11H6z M11.5 4.5H14v11h-2.5z"/>';
  const ctl = (a, d, label) => {
    const b = el('button', { class: 'np-btn', title: label, attrs: { 'aria-label': label } }, [svg(d)]);
    b.onclick = () => call(a);
    return b;
  };
  const art = el('div', { class: 'np-art' });
  const title = el('div', { class: 'np-title' });
  const sub = el('div', { class: 'np-sub' });
  const from = el('div', { class: 'np-sub' });
  const prev = ctl('prev', '<path d="M5 4.5v11 M15.5 4.5v11L7 10z"/>', t('Previous'));
  const play = ctl('toggle', PLAY, t('Play'));
  const next = ctl('next', '<path d="M15 4.5v11 M4.5 4.5v11L13 10z"/>', t('Next'));
  const stop = ctl('stop', '<rect x="5" y="5" width="10" height="10" rx="1.5"/>', t('Stop'));
  const bar = el('div', { class: 'np-bar' }, [el('div', { class: 'np-fill' })]);
  const time = el('div', { class: 'np-time' });
  const box = el('div', { class: 'np' }, [
    art,
    el('div', { class: 'np-main' }, [title, sub, from, el('div', { class: 'np-pos' }, [bar, time])]),
    el('div', { class: 'np-ctl' }, [prev, play, next, stop]),
  ]);
  const card = el('div', { class: 'card dv-media', hidden: true }, [box]);

  let now = null;
  let lastArt = null;
  const clock = (sec) => { const s = Math.max(0, Math.round(sec)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const tick = () => {
    if (!now || card.hidden) return;
    const d = now.duration;
    const p = Math.min(d || Infinity, Math.max(0, now.playing ? now.position + (Date.now() - now.at) / 1000 : now.position));
    bar.hidden = time.hidden = !(d > 0);
    bar.firstChild.style.width = d > 0 ? (100 * p / d).toFixed(1) + '%' : '0';
    time.textContent = clock(p) + ' / ' + clock(d);
  };
  setInterval(tick, 1000);

  return {
    el: card,
    update(s) {
      const a = (s && s.web && s.web.airplay) || null;
      const ses = a && a.session;
      now = ses && ses.now ? ses.now : null;
      card.hidden = !now;
      if (!now) return;
      if (now.art !== lastArt) {
        lastArt = now.art;
        art.style.backgroundImage = now.art ? `url("${now.art}")` : '';
        art.classList.toggle('none', !now.art);
      }
      title.textContent = now.title || t('AirPlay');
      sub.textContent = [now.artist, now.album].filter(Boolean).join(' · ');
      sub.hidden = !sub.textContent;
      from.textContent = t('AirPlay from {device}', { device: ses.name });
      play.replaceChildren(svg(now.playing ? PAUSE : PLAY));
      play.title = now.playing ? t('Pause') : t('Play');
      play.setAttribute('aria-label', play.title);
      for (const b of [prev, play, next]) b.disabled = !now.control;
      tick();
    },
  };
};

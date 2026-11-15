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

// The card itself, in the window's own look (Glass or Simple): the art, title and artist; a seek bar
// you can drag (where the app can seek) with the time gone and the time left; back and forward 10
// seconds, Previous, Play/Pause and Next; the phone's media volume (phone.qs.volume, deviceDo volume)
// and where its sound plays (the phone, or here: Audio › Play sound here). A tint of the art behind
// it (off in its menu) and a smaller one-line card (collapse): both kept in this window (localStorage).
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
  const BACK = '<path fill="none" d="M4.5 10a5.5 5.5 0 1 0 1.6-3.9 M4.5 3.5v3h3"/><text x="10" y="12.6" text-anchor="middle" font-size="6" stroke="none">10</text>';
  const FWD = '<path fill="none" d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9 M15.5 3.5v3h-3"/><text x="10" y="12.6" text-anchor="middle" font-size="6" stroke="none">10</text>';
  const pref = (() => { try { return JSON.parse(localStorage.getItem('td.np') || '{}') || {}; } catch (_) { return {}; } })();
  const savePref = () => { try { localStorage.setItem('td.np', JSON.stringify(pref)); } catch (_) { /* this session only */ } };
  const btn = (d, label, fn, cls = '') => {
    const b = el('button', { class: 'np-btn' + (cls ? ' ' + cls : ''), title: label, attrs: { 'aria-label': label } }, [svg(d)]);
    b.onclick = fn;
    return b;
  };
  let now = null;
  let lastArt = null;
  let dragging = false;
  const pos = () => (now.playing ? now.position + (Date.now() - now.at) * (now.speed || 1) : now.position);
  const jump = (ms) => {
    if (!now || !now.seek || !(now.duration > 0)) return;
    const p = Math.max(0, Math.min(now.duration, pos() + ms));
    api.phoneMedia({ a: 'seek', pos: Math.round(p) });
    now = { ...now, position: p, at: Date.now() };
    tick();
  };
  const art = el('div', { class: 'np-art' });
  const title = el('div', { class: 'np-title' });
  const sub = el('div', { class: 'np-sub' });
  const back = btn(BACK, t('Back 10 seconds'), () => jump(-10000), 'np-skip');
  const prev = btn('<path d="M5 4.5v11 M15.5 4.5v11L7 10z"/>', t('Previous'), () => api.phoneMedia({ a: 'prev' }));
  const play = btn(PLAY, t('Play'), () => api.phoneMedia({ a: 'toggle' }), 'np-play');
  const next = btn('<path d="M15 4.5v11 M4.5 4.5v11L13 10z"/>', t('Next'), () => api.phoneMedia({ a: 'next' }));
  const fwd = btn(FWD, t('Forward 10 seconds'), () => jump(10000), 'np-skip');
  // The seek bar: a range input, so it drags, takes the arrow keys and reads out its place.
  const seek = el('input', { type: 'range', class: 'np-seek', attrs: { min: '0', max: '1000', step: '1', value: '0', 'aria-label': t('Position') } });
  const gone = el('span', { class: 'np-time' });
  const left = el('span', { class: 'np-time' });
  const paint = (k) => seek.style.setProperty('--np-k', (k * 100).toFixed(1) + '%');
  seek.addEventListener('input', () => {
    dragging = true;
    paint(seek.value / 1000);
    if (now && now.duration > 0) gone.textContent = clock(now.duration * seek.value / 1000);
  });
  seek.addEventListener('change', () => {
    dragging = false;
    if (!now || !now.seek || !(now.duration > 0)) return tick();
    const p = Math.round(now.duration * seek.value / 1000);
    api.phoneMedia({ a: 'seek', pos: p });
    now = { ...now, position: p, at: Date.now() };
    tick();
  });
  const posRow = el('div', { class: 'np-pos' }, [gone, seek, left]);
  // The phone's media volume and where its sound plays.
  const VOL = '<path d="M3.5 8h3l4-3.5v11l-4-3.5h-3z M13.5 7.5a3.5 3.5 0 0 1 0 5"/>';
  const volIco = el('span', { class: 'np-ico', attrs: { 'aria-hidden': 'true' } }, [svg(VOL)]);
  const vol = el('input', { type: 'range', class: 'np-seek np-vol', attrs: { min: '0', max: '100', step: '1', value: '0', 'aria-label': t('Media volume') } });
  let volAt = 0;
  vol.addEventListener('input', () => {
    volAt = Date.now();
    vol.style.setProperty('--np-k', vol.value + '%');
    clearTimeout(vol.timer);
    vol.timer = setTimeout(() => api.deviceDo && api.deviceDo({ do: 'volume', stream: 'media', level: vol.value / 100 }), 80);
  });
  const volBox = el('div', { class: 'np-volbox' }, [volIco, vol]);
  const out = UI.segmented([{ value: 'phone', label: t('Phone') }, { value: 'here', label: t('This computer') }], (v) => api.setAudio({ receive: v === 'here' }));
  out.el.classList.add('np-out');
  out.el.title = t('Where the phone’s sound plays');
  const extra = el('div', { class: 'np-extra' }, [volBox, out.el]);
  // Its menu: the tint, and collapse.
  const tintBtn = btn('<circle cx="10" cy="10" r="6.5" fill="none"/><path d="M10 3.5a6.5 6.5 0 0 1 0 13z" stroke="none"/>', t('Colour from the artwork'), () => {
    pref.tint = pref.tint === false;
    savePref();
    applyTint();
  }, 'np-mini');
  const foldBtn = btn('<path fill="none" d="M5.5 8l4.5 4.5L14.5 8"/>', t('Smaller'), () => {
    pref.small = !pref.small;
    savePref();
    applyFold();
  }, 'np-mini');
  const box = el('div', { class: 'np', hidden: true }, [
    art,
    el('div', { class: 'np-main' }, [
      el('div', { class: 'np-head' }, [el('div', { class: 'np-names' }, [title, sub]), tintBtn, foldBtn]),
      posRow,
      el('div', { class: 'np-ctl' }, [back, prev, play, next, fwd]),
      extra,
    ]),
  ]);

  // The art's colour: its average, a little darker in light and lighter in dark, read from a tiny copy.
  let tint = '';
  const applyTint = () => {
    const on = pref.tint !== false && !!tint;
    box.classList.toggle('tinted', on);
    box.style.setProperty('--np-tint', on ? tint : 'transparent');
    tintBtn.classList.toggle('on', pref.tint !== false);
    tintBtn.setAttribute('aria-pressed', String(pref.tint !== false));
  };
  const applyFold = () => {
    box.classList.toggle('small', !!pref.small);
    foldBtn.replaceChildren(svg(pref.small ? '<path fill="none" d="M5.5 12l4.5-4.5 4.5 4.5"/>' : '<path fill="none" d="M5.5 8l4.5 4.5L14.5 8"/>'));
    foldBtn.title = pref.small ? t('Larger') : t('Smaller');
    foldBtn.setAttribute('aria-label', foldBtn.title);
  };
  const readTint = (url) => {
    tint = '';
    applyTint();
    if (!url) return;
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 12;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, 12, 12);
        const d = g.getImageData(0, 0, 12, 12).data;
        let r = 0, gg = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
          const w = 1 + (mx - mn) / 32; // colourful pixels count more than grey ones
          r += d[i] * w; gg += d[i + 1] * w; b += d[i + 2] * w; n += w;
        }
        if (url !== lastArt) return;
        tint = `rgb(${Math.round(r / n)}, ${Math.round(gg / n)}, ${Math.round(b / n)})`;
        applyTint();
      } catch (_) { /* no tint */ }
    };
    img.src = url;
  };
  applyTint();
  applyFold();

  const clock = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s >= 3600 ? Math.floor(s / 3600) + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  // Where it is, moved on between messages while it plays.
  const tick = () => {
    if (!now || box.hidden || dragging) return;
    const d = now.duration;
    const p = Math.min(d || Infinity, Math.max(0, pos()));
    posRow.hidden = !(d > 0 && now.position >= 0);
    const k = d > 0 ? p / d : 0;
    seek.value = String(Math.round(k * 1000));
    paint(k);
    gone.textContent = clock(p);
    left.textContent = '−' + clock(Math.max(0, d - p));
  };
  setInterval(tick, 1000);

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
        readTint(now.art);
      }
      title.textContent = now.title;
      sub.textContent = [now.artist, now.appName].filter(Boolean).join(' · ');
      play.replaceChildren(svg(now.playing ? PAUSE : PLAY));
      play.title = now.playing ? t('Pause') : t('Play');
      play.setAttribute('aria-label', play.title);
      prev.disabled = !now.prev;
      next.disabled = !now.next;
      seek.disabled = !now.seek;
      back.hidden = fwd.hidden = !now.seek;
      const qs = (s.phone && s.phone.qs) || null;
      volBox.hidden = !qs || qs.volume == null || !api.deviceDo;
      if (!volBox.hidden && Date.now() - volAt > 1500) {
        vol.value = String(Math.round(qs.volume * 100));
        vol.style.setProperty('--np-k', vol.value + '%');
      }
      out.el.hidden = !api.setAudio || !s.audio;
      if (!out.el.hidden) out.set(s.audio.receive ? 'here' : 'phone');
      extra.hidden = volBox.hidden && out.el.hidden;
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

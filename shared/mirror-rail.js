// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone window's side rail (Mac and Linux; Windows has its side panel and takes Screenshot and
// Record from here too): a column down the right with Screenshot, Record, the volume keys, Rotate,
// Auto-rotate (the window turns with the app or the phone), Power and Phone screen off. The title bar's rail button shows or hides it, remembered here.
//
// Screenshot: the picture as a PNG, copied and saved (shared/mirror-save.js, in the app).
// Record: the picture, and the phone's sound when it plays here, as MP4 where Chromium can (else
// WebM), streamed to the app a second at a time, so a long one never sits in memory.
// Nothing runs until a button is pressed: no timers, no capture.
//
//   const rail = MirrorRail({ api, canvas, kind, sound: () => ({ actx, node }) | null, i18n });
//   rail.controls → [{k, el}] (for a panel of one's own); rail.mount() puts its own rail in the page.
'use strict';

(function (root) {
  const ICONS = {
    shot: '<path d="M3.5 6.5h3l1.5-2h4l1.5 2h3v9h-13z"/><circle cx="10" cy="11" r="2.8"/>',
    rec: '<circle cx="10" cy="10" r="6"/><circle class="dot" cx="10" cy="10" r="3"/>',
    volumeUp: '<path d="M3.5 8h2.5l3.5-3v10l-3.5-3H3.5z M14 7.5v5 M11.5 10h5"/>',
    volumeDown: '<path d="M3.5 8h2.5l3.5-3v10l-3.5-3H3.5z M11.5 10h5"/>',
    rotate: '<path d="M4.5 10a5.5 5.5 0 1 0 1.6-3.9 M4.5 3.5v3h3"/>',
    autoRotate: '<rect x="6.5" y="4" width="7" height="12" rx="1.5"/><path d="M3 8.5a7.5 7.5 0 0 1 2-4 M17 11.5a7.5 7.5 0 0 1-2 4 M3.5 4.2l1.5.3-.2 1.6 M16.5 15.8l-1.5-.3.2-1.6"/>',
    power: '<path d="M10 3.5v6 M6.2 6a5.5 5.5 0 1 0 7.6 0"/>',
    screenOff: '<rect x="6" y="3" width="8" height="14" rx="1.5"/><path d="M3.5 3.5l13 13"/>',
    rail: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M12.5 4v12"/>',
  };
  const KEY = 'twindesk.mirrorRail';
  const svg = (k) => `<svg viewBox="0 0 20 20">${ICONS[k]}</svg>`;

  // What this Chromium may record, best first: MP4 (H.264 with AAC, else with Opus: Chromium has no
  // AAC encoder on some systems), then WebM. A format can still fail to start (its encoder): the
  // next one is tried then.
  function formats(withSound) {
    const R = root.MediaRecorder;
    if (!R) return [];
    const list = withSound
      ? [['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'], ['video/mp4;codecs=avc1,opus', 'mp4'], ['video/webm;codecs=vp9,opus', 'webm'], ['video/webm', 'webm']]
      : [['video/mp4;codecs=avc1', 'mp4'], ['video/mp4', 'mp4'], ['video/webm;codecs=vp9', 'webm'], ['video/webm', 'webm']];
    return list.filter(([mime]) => R.isTypeSupported(mime)).map(([mime, ext]) => ({ mime, ext }));
  }

  function MirrorRail({ api, canvas, kind, sound = () => null, i18n = root.PlayerI18n }) {
    const t = (k) => (i18n && i18n.t ? i18n.t(k) : k);
    const phone = kind === 'screen' || kind === 'app';
    const LIST = [
      { k: 'shot', title: 'Screenshot (copied, and saved in Pictures › TwinDesk)' },
      { k: 'rec', title: 'Record (saved in Movies › TwinDesk)' },
      ...(phone ? [
        { k: 'volumeUp', title: 'Volume up' },
        { k: 'volumeDown', title: 'Volume down' },
        { k: 'rotate', title: kind === 'app' ? 'Rotate the window' : 'Rotate' },
        { k: 'autoRotate', title: kind === 'app' ? 'Auto-rotate: the window turns with the app' : 'Auto-rotate: the window turns with the phone', toggle: 'autoRotate' },
      ] : []),
      ...(kind === 'screen' ? [{ k: 'power', title: 'Power (lock or wake the phone)' }] : []),
      ...(phone ? [{ k: 'screenOff', title: 'Phone screen off (it keeps showing here, and saves the battery)', toggle: 'screenOff' }] : []),
    ];

    // ---- record ----
    let rec = null; // {recorder, dest, node, started}
    const recording = () => !!rec;
    function startRec() {
      if (rec || !canvas.width || !canvas.captureStream) return;
      // The window's canvas is low-latency (desynchronized), and Chromium's captureStream gets no
      // frames from one: while recording, what it shows is copied into a plain canvas of the same
      // size once a display frame, and that one is recorded. Nothing runs when not recording.
      const copy = canvas.ownerDocument.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const g = copy.getContext('2d', { alpha: false });
      let copying = true;
      const step = () => {
        if (!copying) return;
        try { g.drawImage(canvas, 0, 0, copy.width, copy.height); } catch (_) {}
        root.requestAnimationFrame(step);
      };
      step();
      const stream = copy.captureStream(30);
      const s = sound();
      let dest = null;
      if (s && s.actx && s.node) {
        try {
          dest = s.actx.createMediaStreamDestination();
          s.node.connect(dest); // as well as to the speakers
          for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);
        } catch (_) { dest = null; }
      }
      const list = formats(!!dest);
      const done = () => {
        if (dest && s.node) try { s.node.disconnect(dest); } catch (_) {}
        for (const tr of stream.getTracks()) tr.stop();
        copying = false;
      };
      const id = `${Date.now()}`;
      // One format; the app hears of it with its first second (begin), so a format that fails to
      // start leaves no empty file behind and the next one is tried.
      const attempt = (i) => {
        const f = list[i];
        if (!f) { rec = null; paint(); done(); return; }
        let recorder;
        try { recorder = new MediaRecorder(stream, { mimeType: f.mime, videoBitsPerSecond: 8e6 }); } catch (_) { attempt(i + 1); return; }
        let seq = 0;
        let chain = Promise.resolve();
        recorder.ondataavailable = (e) => {
          if (!e.data || !e.data.size) return;
          const n = seq++;
          if (n === 0) api.send({ t: 'rec', id, begin: true, ext: f.ext });
          chain = chain.then(() => e.data.arrayBuffer()).then((b) => api.send({ t: 'rec', id, seq: n, ext: f.ext, part: new Uint8Array(b) }));
        };
        let failed = false;
        recorder.onerror = (e) => { failed = true; console.warn('[rail] recording', f.mime, (e && e.error && e.error.message) || e); };
        recorder.onstop = () => {
          if (failed && !seq && rec && rec.recorder === recorder) { attempt(i + 1); return; } // its encoder didn't start
          if (rec && rec.recorder === recorder) { rec = null; paint(); } // stopped by itself (the picture ended)
          if (seq) chain.then(() => api.send({ t: 'rec', id, end: true, ext: f.ext }));
          done();
        };
        rec = { recorder, started: Date.now() };
        recorder.start(1000);
      };
      attempt(0);
      paint();
    }
    function stopRec() {
      if (!rec) return;
      const r = rec;
      rec = null;
      try { r.recorder.stop(); } catch (_) {}
      paint();
    }

    function shot() {
      if (!canvas.width || !canvas.height) return;
      canvas.toBlob((blob) => { if (blob) blob.arrayBuffer().then((b) => api.send({ t: 'shot', png: new Uint8Array(b), save: true })); }, 'image/png');
    }

    const controls = LIST.map((c) => {
      const el = document.createElement('button');
      el.className = 'ctl';
      el.dataset.k = c.k;
      el.innerHTML = svg(c.k);
      el.onclick = () => {
        if (c.k === 'shot') shot();
        else if (c.k === 'rec') (rec ? stopRec : startRec)();
        else if (c.k === 'screenOff') api.send({ t: 'nav', key: 'screenPower' });
        else if (c.k === 'autoRotate') api.send({ t: 'toggle', what: 'autoRotate' });
        else api.send({ t: 'nav', key: c.k });
        canvas.focus();
      };
      return { ...c, el };
    });
    function paint() {
      for (const c of controls) {
        const title = c.k === 'rec' && rec ? t('Stop recording') : t(c.title);
        c.el.title = title;
        c.el.setAttribute('aria-label', title);
        if (c.k === 'rec') c.el.classList.toggle('recording', !!rec);
      }
      document.body.classList.toggle('recording', !!rec);
    }
    paint();
    if (i18n && i18n.onChange) i18n.onChange(paint);
    api.on('opts', (m) => {
      if (!m) return;
      for (const c of controls) if (c.toggle && typeof m[c.toggle] === 'boolean') c.el.classList.toggle('on', m[c.toggle]);
    });
    // The window closing (or its picture ending) stops a recording, which is then saved.
    window.addEventListener('beforeunload', stopRec);

    // Its own rail down the right, and the title bar's button that shows or hides it.
    function mount(toggleHost) {
      const nav = document.createElement('nav');
      nav.id = 'rail';
      nav.append(...controls.map((c) => c.el));
      document.body.append(nav);
      let on = false;
      try { on = root.localStorage.getItem(KEY) === '1'; } catch (_) {}
      const set = (v) => {
        on = v;
        document.body.classList.toggle('rail', on);
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
        try { root.localStorage.setItem(KEY, on ? '1' : '0'); } catch (_) {}
      };
      const btn = document.createElement('button');
      btn.id = 'b-rail';
      btn.innerHTML = svg('rail');
      const label = () => { const s = t('Side rail: screenshot, record, volume'); btn.title = s; btn.setAttribute('aria-label', s); };
      label();
      if (i18n && i18n.onChange) i18n.onChange(label);
      btn.onclick = () => { set(!on); canvas.focus(); };
      if (toggleHost) toggleHost.append(btn);
      set(on);
      return { nav, btn, set };
    }

    return { controls, mount, recording, stop: stopRec };
  }

  root.MirrorRail = MirrorRail;
})(typeof window !== 'undefined' ? window : globalThis);

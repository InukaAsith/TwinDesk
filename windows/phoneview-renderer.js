// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The phone window: decodes the phone's H.264 (WebCodecs, Annex B with SPS/PPS in band) onto a
// canvas, plays its sound (raw 48 kHz stereo PCM through pcm-worklet.js), and turns this PC's
// mouse, touchpad and keyboard into the phone's touches, scrolls and keys (port of
// mac/phoneview-renderer.js):
//   click / drag = a finger · hover = the mouse · right click = Back · middle click = Home
//   wheel / two-finger scroll = scroll · pinch = two fingers pinching · keys = keys
'use strict';

(() => {
  const api = window.phoneview;
  const q = new URLSearchParams(location.search);
  const kind = q.get('kind') || 'screen';
  document.body.classList.add(kind);
  document.getElementById('title').textContent = q.get('title') || 'Phone';
  const canvas = document.getElementById('screen');
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const status = document.getElementById('status');
  const ACTION = { DOWN: 0, UP: 1, MOVE: 2, HOVER_MOVE: 7 };
  const FINGER = -2; // scrcpy's generic finger
  let size = null; // video size
  let decoder = null;
  let config = null; // SPS/PPS, sent in front of the next key frame
  let waitingKey = true;
  // Skip to the next keyframe, and ask the phone for one now (it sends one only every ~10 s):
  // the frames in between build on each other, so drawing them on a gap smears the picture.
  let askedKey = 0;
  function needKey() {
    waitingKey = true;
    const now = performance.now();
    if (now - askedKey < 1000) return;
    askedKey = now;
    api.send({ t: 'resetVideo' });
  }

  const setStatus = (t) => {
    status.textContent = t || '';
    status.hidden = !t;
  };

  // ---- video ----

  function codecOf(sps) {
    // Annex B: find the SPS NAL (type 7); profile, constraints and level are the next three bytes.
    for (let i = 0; i + 4 < sps.length; i++) {
      if (sps[i] === 0 && sps[i + 1] === 0 && sps[i + 2] === 1 && (sps[i + 3] & 0x1f) === 7) {
        const h = (b) => b.toString(16).padStart(2, '0');
        return `avc1.${h(sps[i + 4])}${h(sps[i + 5])}${h(sps[i + 6])}`;
      }
    }
    return 'avc1.42e01f';
  }

  function makeDecoder(codec) {
    if (decoder && decoder.state !== 'closed') try { decoder.close(); } catch {}
    decoder = new VideoDecoder({
      output: (frame) => {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
          fit();
        }
        ctx.drawImage(frame, 0, 0);
        frame.close();
        if (!status.hidden) setStatus('');
      },
      error: (e) => {
        console.warn('decoder', e.message);
        needKey();
      },
    });
    decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
  }

  api.on('video', (p) => {
    const data = p.data instanceof Uint8Array ? p.data : new Uint8Array(p.data);
    if (p.config) {
      config = data;
      makeDecoder(codecOf(data));
      waitingKey = true;
      return;
    }
    if (!decoder || decoder.state !== 'configured') return;
    if (waitingKey && !p.key) return needKey();
    // Behind (a slow decoder): drop up to a fresh keyframe rather than one frame, which smears.
    if (decoder.decodeQueueSize > 4 && !p.key) return needKey();
    let chunk = data;
    if (p.key && config) {
      chunk = new Uint8Array(config.length + data.length);
      chunk.set(config, 0);
      chunk.set(data, config.length);
    }
    waitingKey = false;
    decoder.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: p.pts, data: chunk }));
  });

  api.on('size', (s) => {
    size = s;
    fit();
  });

  api.on('status', (s) => {
    if (s.via) {
      const el = document.getElementById('via');
      el.textContent = s.via === 'usb' ? 'USB' : 'Wi-Fi';
      el.className = s.via;
      el.title = s.via === 'usb' ? 'Through the USB cable' : 'Through wireless debugging';
      el.hidden = false;
    }
    if (s.error) setStatus(s.error);
    else if (s.closed) setStatus(`The phone stopped sharing (${s.closed}).`);
    else if (s.ready && !size) setStatus('Waiting for the picture…');
  });

  // An app's virtual display has at least 2 pixels per point, like the Mac's: at 100% scaling a
  // 1-pixel display looks blurry. Same rule as phoneview.js's openApp.
  const appScale = () => Math.max(2, devicePixelRatio);

  // Letterbox: the canvas keeps the phone's aspect inside the window.
  function fit() {
    const stage = document.getElementById('stage');
    const w = canvas.width || (size && size.width) || 9;
    const h = canvas.height || (size && size.height) || 19;
    const k = Math.min(stage.clientWidth / w, stage.clientHeight / h);
    canvas.style.width = `${Math.floor(w * k)}px`;
    canvas.style.height = `${Math.floor(h * k)}px`;
  }
  new ResizeObserver(() => {
    fit();
    // An app window: its virtual display follows the window (device pixels).
    if (kind === 'app') {
      clearTimeout(fit.timer);
      const stage = document.getElementById('stage');
      fit.timer = setTimeout(() => api.send({ t: 'resize', w: stage.clientWidth * appScale(), h: stage.clientHeight * appScale() }), 250);
    }
  }).observe(document.getElementById('stage'));

  // ---- sound ----

  let player = null;
  let actx = null;
  async function startAudio() {
    actx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await actx.audioWorklet.addModule('pcm-worklet.js');
    player = new AudioWorkletNode(actx, 'pcm-player', { outputChannelCount: [2] });
    player.connect(actx.destination);
    if (actx.state === 'suspended') await actx.resume(); // never left waiting for a click
  }
  api.on('audio', (d) => {
    if (!player) {
      if (!startAudio.started) startAudio.started = startAudio().catch((e) => console.warn('audio', e.message));
      return;
    }
    const u8 = d instanceof Uint8Array ? d : new Uint8Array(d);
    const s16 = new Int16Array(u8.buffer, u8.byteOffset, u8.byteLength >> 1);
    const f = new Float32Array(s16.length);
    for (let i = 0; i < s16.length; i++) f[i] = s16[i] / 32768;
    player.port.postMessage(f, [f.buffer]);
  });

  // The phone's own capture (no wireless debugging): Opus packets through the session, 20 ms each
  // (or raw 48 kHz stereo s16le from a phone without an Opus encoder).
  let opusDec = null;
  let ts = 0;
  const play = (f) => player && player.port.postMessage(f, [f.buffer]);
  const fromOpus = (a) => {
    const n = a.numberOfFrames;
    const f = new Float32Array(n * 2);
    const ch = [];
    for (let c = 0; c < Math.min(2, a.numberOfChannels); c++) {
      const p = new Float32Array(n);
      a.copyTo(p, { planeIndex: c, format: 'f32-planar' });
      ch.push(p);
    }
    a.close();
    const [l, r = l] = ch;
    for (let i = 0; i < n; i++) { f[i * 2] = l[i]; f[i * 2 + 1] = r[i]; }
    play(f);
  };
  api.on('netaudio', (m) => {
    if (!player) {
      if (!startAudio.started) startAudio.started = startAudio().catch((e) => console.warn('audio', e.message));
      return;
    }
    for (const b64 of m.p) {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      if (m.codec === 'pcm') {
        const s16 = new Int16Array(u8.buffer, 0, u8.byteLength >> 1);
        const f = new Float32Array(s16.length);
        for (let i = 0; i < s16.length; i++) f[i] = s16[i] / 32768;
        play(f);
        continue;
      }
      if (!opusDec || opusDec.state === 'closed') {
        opusDec = new AudioDecoder({ output: fromOpus, error: (e) => console.warn('opus', e.message) });
        opusDec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
        ts = 0;
      }
      opusDec.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data: u8 }));
      ts += 20000;
    }
  });

  // ---- input ----

  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    const w = (size && size.width) || canvas.width;
    const h = (size && size.height) || canvas.height;
    return { x: Math.max(0, Math.min(w - 1, ((e.clientX - r.left) / r.width) * w)), y: Math.max(0, Math.min(h - 1, ((e.clientY - r.top) / r.height) * h)) };
  };
  let down = false;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    if (e.button === 2) return api.send({ t: 'nav', key: 'back' });
    if (e.button === 1) return api.send({ t: 'nav', key: 'home' });
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    down = true;
    api.send({ t: 'touch', action: ACTION.DOWN, pointer: FINGER, ...at(e) });
  });
  canvas.addEventListener('pointermove', (e) => {
    if (down) api.send({ t: 'touch', action: ACTION.MOVE, pointer: FINGER, ...at(e) });
    else api.send({ t: 'touch', action: ACTION.HOVER_MOVE, pointer: -1, ...at(e) });
  });
  const up = (e) => {
    if (!down) return;
    down = false;
    api.send({ t: 'touch', action: ACTION.UP, pointer: FINGER, ...at(e) });
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Scroll, and pinch (Chromium turns a touchpad pinch into ctrl+wheel): two fingers around the
  // pointer, moving apart or together, lifted when the pinch stops.
  let pinch = null;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = at(e);
    if (e.ctrlKey) {
      const w = (size && size.width) || canvas.width;
      if (!pinch) {
        pinch = { cx: p.x, cy: p.y, d: w * 0.08 };
        api.send({ t: 'touch', action: ACTION.DOWN, pointer: 0, x: pinch.cx - pinch.d, y: pinch.cy });
        api.send({ t: 'touch', action: ACTION.DOWN, pointer: 1, x: pinch.cx + pinch.d, y: pinch.cy });
      }
      pinch.d = Math.max(10, Math.min(w * 0.45, pinch.d * Math.exp(-e.deltaY / 60)));
      api.send({ t: 'touch', action: ACTION.MOVE, pointer: 0, x: pinch.cx - pinch.d, y: pinch.cy });
      api.send({ t: 'touch', action: ACTION.MOVE, pointer: 1, x: pinch.cx + pinch.d, y: pinch.cy });
      clearTimeout(pinch.timer);
      pinch.timer = setTimeout(() => {
        api.send({ t: 'touch', action: ACTION.UP, pointer: 0, x: pinch.cx - pinch.d, y: pinch.cy });
        api.send({ t: 'touch', action: ACTION.UP, pointer: 1, x: pinch.cx + pinch.d, y: pinch.cy });
        pinch = null;
      }, 160);
      return;
    }
    const k = e.deltaMode === 1 ? 1 : 1 / 100; // lines, or pixels (100 a wheel notch)
    api.send({ t: 'scroll', ...p, hs: -e.deltaX * k, vs: -e.deltaY * k });
  }, { passive: false });

  // Keys go to the phone; Alt+F4 closes the window like any other.
  const onKey = (e) => {
    if (e.altKey && e.code === 'F4') return;
    e.preventDefault();
    api.send({ t: 'key', code: e.code, down: e.type === 'keydown', repeat: e.repeat });
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', () => {
    for (const code of ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']) api.send({ t: 'key', code, down: false });
  });

  // Files dragged onto the window go to the phone.
  document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drop'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drop'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('drop');
    if (e.dataTransfer && e.dataTransfer.files.length) api.drop(e.dataTransfer.files);
  });

  // ---- controls ----
  // In a side panel down the right (the default), the title bar, or Back/Home/Recents in a bar
  // under the picture (Phone page › Settings › Window controls). An app window runs on a display
  // of its own, so what acts on the phone's main screen (Recents, the shade, Power) isn't there,
  // and its Rotate turns the window round.
  const ICONS = {
    back: '<path d="M12.5 4.5 7 10l5.5 5.5"/>',
    home: '<circle cx="10" cy="10" r="5.5"/>',
    recents: '<rect x="5" y="5" width="10" height="10" rx="1.5"/>',
    notifications: '<path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 1.5h-12z M8.5 16.5a1.5 1.5 0 0 0 3 0"/>',
    settings: '<path d="M4 6h12 M4 10h12 M4 14h12"/><circle cx="7.5" cy="6" r="1.6"/><circle cx="12.5" cy="10" r="1.6"/><circle cx="8.5" cy="14" r="1.6"/>',
    rotate: '<path d="M4.5 10a5.5 5.5 0 1 0 1.6-3.9 M4.5 3.5v3h3"/>',
    volumeUp: '<path d="M3.5 8h2.5l3.5-3v10l-3.5-3H3.5z M14 7.5v5 M11.5 10h5"/>',
    volumeDown: '<path d="M3.5 8h2.5l3.5-3v10l-3.5-3H3.5z M11.5 10h5"/>',
    mute: '<path d="M3.5 8h2.5l3.5-3v10l-3.5-3H3.5z M12 8l4 4 M16 8l-4 4"/>',
    power: '<path d="M10 3.5v6 M6.2 6a5.5 5.5 0 1 0 7.6 0"/>',
    shot: '<path d="M3.5 6.5h3l1.5-2h4l1.5 2h3v9h-13z"/><circle cx="10" cy="11" r="2.8"/>',
    pin: '<path d="M8 3.5h4l-.5 5 2.5 2.5h-8l2.5-2.5z M10 11v5.5"/>',
  };
  // nav: Back, Home and Recents (the side panel's foot, or the bottom bar); screen: not in app windows.
  const CONTROLS = [
    { k: 'volumeUp', title: 'Volume up' },
    { k: 'volumeDown', title: 'Volume down' },
    { k: 'mute', title: 'Mute' },
    { k: 'rotate', title: kind === 'app' ? 'Rotate the window' : 'Rotate' },
    { k: 'shot', title: 'Screenshot (copies it: paste with Ctrl+V)' },
    { k: 'notifications', title: 'Notifications', screen: true },
    { k: 'settings', title: 'Quick settings', screen: true },
    { k: 'power', title: 'Power (lock or wake the phone)', screen: true },
    { k: 'pin', title: 'Keep on top' },
    { k: 'back', title: 'Back (right click, Esc)', nav: true },
    { k: 'home', title: 'Home (middle click)', nav: true },
    { k: 'recents', title: 'Recent apps', nav: true, screen: true },
  ].filter((c) => kind !== 'app' || !c.screen);
  // The title bar layouts carry what the title bar always had: Back, Home, Recents, Notifications, Rotate.
  const TOP = ['notifications', 'rotate'];
  for (const c of CONTROLS) {
    c.el = document.createElement('button');
    c.el.className = 'ctl';
    c.el.title = c.title;
    c.el.setAttribute('aria-label', c.title);
    c.el.innerHTML = `<svg viewBox="0 0 20 20">${ICONS[c.k]}</svg>`;
    c.el.onclick = () => {
      if (c.k === 'shot') return shot();
      if (c.k === 'pin') return api.send({ t: 'pin' });
      api.send({ t: 'nav', key: c.k });
      canvas.focus();
    };
  }
  const els = (list) => list.map((c) => c.el);
  function layout(mode) {
    mode = ['side', 'top', 'bottom'].includes(mode) ? mode : 'side';
    document.body.dataset.controls = mode;
    const panel = document.getElementById('panel');
    const navbar = document.getElementById('navbar');
    const tools = document.querySelector('#bar .tools');
    for (const box of [panel, navbar, tools]) box.replaceChildren();
    const nav = els(CONTROLS.filter((c) => c.nav));
    if (mode === 'side') {
      const gap = document.createElement('div');
      gap.className = 'gap';
      panel.append(...els(CONTROLS.filter((c) => !c.nav)), gap, ...nav);
    } else {
      const top = els(TOP.map((k) => CONTROLS.find((c) => c.k === k)).filter(Boolean));
      if (mode === 'bottom') { tools.append(...top); navbar.append(...nav); } else tools.append(...nav, ...top);
    }
  }
  layout(q.get('controls'));
  api.on('opts', (m) => {
    if (!m) return;
    if (m.controls) layout(m.controls);
    if (typeof m.pinned === 'boolean') CONTROLS.find((c) => c.k === 'pin').el.classList.toggle('on', m.pinned);
  });

  // The picture as it is now, as a PNG (phoneview.js puts it on the clipboard).
  function shot() {
    if (!canvas.width || !canvas.height) return;
    canvas.toBlob((blob) => { if (blob) blob.arrayBuffer().then((b) => api.send({ t: 'shot', png: new Uint8Array(b) })); }, 'image/png');
  }

  canvas.focus();
})();

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac's screen on the phone (like windows/monitor.js): answers the Mac's WebRTC offer and
// plays the picture (and its sound), and sends input back as in.* (normalized 0–1):
//   touch   touchpad (opts.touch 'pad', the default): slide = move the pointer (never clicks) ·
//           tap = left click ("Tap to click", on unless switched off) · hold = right click ·
//           Android/Mac: two fingers scroll, pinch zooms, three fingers pan the view
//           direct ('direct'): tap = click · hold = right click · drag = drag
//           (the Mac's pointer follows the finger, so it is a touch screen for the Mac)
//   mouse   and a hardware keyboard work as on a computer
//   stylus  a pen on the computer: where it points, with its pressure, tilt, eraser and side button
//           (opts.pen; off: a mouse). A stroke's samples go each in its own in.mm, paced as the pen
//           made them (Fast writing, opts.penFast: once per pointer event, in.mm `pts`), and the
//           stroke is drawn here at once (the ink preview, opts.ink) until the picture
//           shows the computer's own ink
//   soft keyboard: what is typed goes as keys (the app's Keyboard button shows it)
// The app talks to it through window.TD (send, ready, …) and window.tdRecv(message).
'use strict';

(() => {
  const video = document.getElementById('video');
  const audio = document.getElementById('audio');
  const overlay = document.getElementById('overlay');
  const pointerCue = document.getElementById('pointer-cue');
  const kbd = document.getElementById('kbd');
  document.addEventListener('visibilitychange', () => { if (document.hidden) hidePointerCue(); });
  window.addEventListener('blur', hidePointerCue);
  window.addEventListener('resize', hidePointerCue);
  video.addEventListener('resize', hidePointerCue);
  for (const event of ['waiting', 'stalled', 'emptied', 'ended']) video.addEventListener(event, hidePointerCue);
  // The app's language (I18n.kt through TD.tr): {name} parts filled from vars, English without the app.
  const t = (text, vars = {}) => (typeof TD.tr === 'function' ? TD.tr(text, JSON.stringify(vars))
    : text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)));
  const TD = window.TD;
  const send = (m) => TD.send(JSON.stringify(m));
  // in.mm straight to the socket (WebHost's TD.move): no object or JSON per pointer event.
  const sendAt = typeof TD.move === 'function' ? (x, y) => TD.move(2, x, y, false) : (x, y) => send({ t: 'in.mm', x, y });
  const B = { LEFT: 0, RIGHT: 1, MIDDLE: 2 };

  let pc = null;
  let session = null;
  let pending = null;
  let viewerGeneration = 0;
  let videoOwner = null;
  let frameProbe = 0;
  let name = t('the computer'); // the one we're connected to (opts)
  let streamAudio = false;
  let sound = true;
  let pacing = 'fast';
  let touchMode = 'pad'; // 'pad' | 'direct' (opts.touch)
  let speed = 1; // the touchpad's pointer speed (opts.speed)
  let tapClick = true; // a quick tap left-clicks (opts.tap)
  let penOn = true; // a stylus is a pen (opts.pen); off: a mouse
  let penFast = false; // Fast writing (opts.penFast): a stroke's samples in one in.mm (pts); off: each its own, paced
  let realTouch = false; // the computer injects real touch (screen.state touch): Direct sends in.tc
  let zoom = 1, panX = 0, panY = 0;
  let viewGestures = false; // A host advertises per-stream detail sizes to enable local pinch/pan.
  let detail = null;
  let detailTimer = null;
  let detailRevision = 0;
  let detailHeight = 0;

  function cancelDetail() {
    clearTimeout(detailTimer);
    detailTimer = null;
    detailRevision++;
  }

  function readDetail(raw) {
    if (!raw || !Number.isInteger(raw.baseline) || raw.baseline < 1 ||
        !Number.isFinite(raw.fps) || raw.fps < 1 || raw.fps > 120 || !Array.isArray(raw.sizes)) return null;
    const sizes = raw.sizes.slice(0, 8).filter(size => size && Number.isInteger(size.width) &&
      Number.isInteger(size.height) && size.width > 0 && size.width <= 4096 &&
      size.height > raw.baseline && size.height <= 2160);
    if (!sizes.length) return null;
    return { baseline: raw.baseline, fps: raw.fps, sizes: sizes.sort((a, b) => a.height - b.height) };
  }

  function scheduleDetail() {
    cancelDetail();
    const owner = videoOwner, revision = detailRevision;
    if (!detail || !viewGestures || typeof TD.detail !== 'function' ||
        typeof TD.canDecodeVideo !== 'function' || !owner?.playing ||
        (zoom <= 1 && detailHeight === 0)) return;
    const current = () => revision === detailRevision && owner === videoOwner &&
      owner.pc === pc && owner.playing && !document.hidden &&
      pc.connectionState === 'connected' && !touches.size;
    detailTimer = setTimeout(async () => {
      detailTimer = null;
      if (!current()) return;
      let height = 0;
      const r = fitRect();
      if (!r) return;
      const need = r.h * zoom * (window.devicePixelRatio || 1) / 1.04;
      if (zoom > 1 && need > detail.baseline) {
        if (!owner.detailSizes?.length) {
          let codec;
          try {
            const stats = await owner.pc.getStats();
            const inbound = [...stats.values()].find(stat =>
              stat.type === 'inbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video'));
            codec = stats.get(inbound?.codecId)?.mimeType;
          } catch { return; }
          if (!current() || typeof codec !== 'string') return;
          owner.detailSizes = detail.sizes.filter(size =>
            TD.canDecodeVideo(codec, size.width, size.height, detail.fps));
        }
        const supported = owner.detailSizes;
        height = (supported.find(size => size.height >= need) || supported.at(-1))?.height || 0;
      }
      if (!current() || height === detailHeight) return;
      detailHeight = height;
      TD.detail(owner.generation, owner.session, height);
    }, 400);
  }

  function fitRect() {
    const vw = video.videoWidth, vh = video.videoHeight;
    const W = window.innerWidth, H = window.innerHeight;
    if (!vw || !vh || W <= 0 || H <= 0) return null;
    const k = Math.min(W / vw, H / vh);
    return { x: (W - vw * k) / 2, y: (H - vh * k) / 2, w: vw * k, h: vh * k };
  }
  function resetLocalZoom() {
    if (zoom === 1) return;
    cancelInput();
    zoom = 1;
    panX = panY = 0;
    applyViewport();
    scheduleDetail();
  }

  function applyViewport() {
    const r = fitRect();
    const dx = r ? Math.max(0, (r.w * zoom - window.innerWidth) / 2) : 0;
    const dy = r ? Math.max(0, (r.h * zoom - window.innerHeight) / 2) : 0;
    panX = Math.max(-dx, Math.min(dx, panX));
    panY = Math.max(-dy, Math.min(dy, panY));
    video.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  }
  window.addEventListener('resize', () => { if (viewGestures) cancelViewTouch(); applyViewport(); scheduleDetail(); });

  function setOverlay(t) {
    overlay.textContent = t || '';
    overlay.classList.toggle('hidden', !t);
  }

  // steady: no hints, and the answer leaves out the playout-delay extension, so the computer's
  // "show it now" on every frame never arrives: WebRTC's own pacing, as a web browser plays it.
  function pace(r) {
    const fast = pacing === 'fast';
    if ('jitterBufferTarget' in r) r.jitterBufferTarget = fast ? 0 : pacing === 'steady' ? null : 16;
    if ('playoutDelayHint' in r) r.playoutDelayHint = fast ? 0 : null;
  }
  const steadySdp = (sdp) => (pacing === 'steady' ? sdp.replace(/^a=extmap:[^\r\n]*\/playout-delay\r?\n/gm, '') : sdp);

  let doctorTimer = null, doctorRevision = 0;
  let doctorLast = null;

  function stopDoctor() {
    clearTimeout(doctorTimer);
    doctorTimer = null;
    doctorLast = null;
    doctorRevision++;
  }

  function scheduleDoctor(owner = videoOwner) {
    if (doctorTimer !== null || typeof TD.videoMetrics !== 'function' || !owner?.playing ||
        document.hidden) return;
    const revision = doctorRevision;
    const current = () => revision === doctorRevision && owner === videoOwner && owner.pc === pc &&
      owner.playing && !document.hidden && video.srcObject === owner.stream &&
      pc.connectionState === 'connected';
    doctorTimer = setTimeout(async () => {
      doctorTimer = null;
      if (!current()) return;
      doctorTimer = -1; // Do not overlap getStats calls for this owner.
      try {
        const report = await owner.pc.getStats();
        if (!current()) return;
        const inbound = [...report.values()].find(stat =>
          stat.type === 'inbound-rtp' && (stat.kind === 'video' || stat.mediaType === 'video'));
        if (inbound) {
          const last = doctorLast;
          const elapsed = last && inbound.id === last.id ? inbound.timestamp - last.timestamp : 0;
          const rate = (key, factor) => elapsed >= 250 && elapsed <= 10000 &&
            Number.isFinite(inbound[key]) && Number.isFinite(last[key]) && inbound[key] >= last[key]
            ? Math.round((inbound[key] - last[key]) * factor / elapsed) : -1;
          const dropped = Number.isSafeInteger(inbound.framesDropped) && inbound.framesDropped >= 0
            ? inbound.framesDropped : -1;
          TD.videoMetrics(owner.generation, owner.session, video.videoWidth, video.videoHeight,
            rate('framesDecoded', 1000), rate('bytesReceived', 8), dropped);
          doctorLast = inbound;
        }
      } catch { /* Statistics can be unavailable while the receiver changes tracks. */ }
      finally {
        if (revision === doctorRevision && doctorTimer === -1) doctorTimer = null;
      }
      if (current()) scheduleDoctor(owner);
    }, 2000);
  }

  function reportVideo(playing, owner = videoOwner) {
    if (!playing) stopDoctor();
    if (!playing) { frameProbe++; cancelDetail(); if (owner) owner.playing = false; }
    if (owner && owner === videoOwner && owner.pc === pc && video.srcObject === owner.stream &&
        (!playing || owner.pc.connectionState === 'connected') && typeof TD.videoState === 'function' && Number.isInteger(owner.generation) && owner.generation > 0 && Number.isInteger(owner.session)) {
      owner.playing = playing;
      TD.videoState(owner.generation, owner.session, playing, video.videoWidth, video.videoHeight);
      if (playing) scheduleDetail();
      if (playing) scheduleDoctor(owner);
    }
  }

  function requireCurrentFrame(owner = videoOwner) {
    if (typeof TD.videoState !== 'function') return;
    if (!owner || owner !== videoOwner || owner.pc !== pc || video.srcObject !== owner.stream) return;
    const probe = ++frameProbe;
    const current = () => probe === frameProbe && owner === videoOwner && owner.pc === pc && video.srcObject === owner.stream;
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => { if (current()) reportVideo(true, owner); });
    } else {
      const started = video.currentTime;
      let left = 60;
      const check = () => {
        if (!current()) return;
        if (video.currentTime > started && video.videoWidth > 0 && video.videoHeight > 0) reportVideo(true, owner);
        else if (--left > 0) requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    }
  }

  function closePc() {
    reportVideo(false);
    videoOwner = null;
    if (detail) {
      zoom = 1; panX = panY = 0;
      applyViewport();
    }
    detail = null;
    detailHeight = 0;
    viewGestures = false;
    if (pc) pc.close();
    pc = null;
    session = null;
    pending = null;
    video.srcObject = null;
    audio.srcObject = null;
    hidePointerCue();
  }

  function applyAudio() {
    audio.muted = !sound || !streamAudio;
    if (audio.srcObject && !audio.muted) audio.play().catch(() => {});
  }

  async function onOffer(msg) {
    if (viewGestures) cancelInput();
    closePc();
    // On a USB cable the computer sends its relay (msg.ice): the picture goes through adb.
    const my = (pc = new RTCPeerConnection(msg.ice || { iceServers: [] }));
    session = msg.session;
    detail = readDetail(msg.detail);
    viewGestures = !!detail;
    viewerGeneration = msg.viewerGeneration || 0;
    const queue = (pending = []);
    setOverlay(t('Connecting to {name}…', { name }));
    my.ontrack = (e) => {
      if (my !== pc) return;
      if (e.track.kind === 'audio') {
        if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 0;
        audio.srcObject = new MediaStream([e.track]);
        applyAudio();
        return;
      }
      hidePointerCue();
      pace(e.receiver);
      const stream = new MediaStream([e.track]);
      videoOwner = { pc: my, stream, generation: viewerGeneration, session: msg.session };
      video.srcObject = stream;
      video.play().catch(() => {});
    };
    my.onicecandidate = (e) => {
      if (e.candidate && my === pc) send({ t: 'rtc.ice', session: msg.session, candidate: e.candidate.toJSON() });
    };
    my.onconnectionstatechange = () => {
      if (my !== pc) return;
      if (my.connectionState !== 'connected') hidePointerCue();
      const connection = my.connectionState;
      if (connection === 'connected') requireCurrentFrame();
      else if (connection === 'failed') { reportVideo(false); setOverlay(t('Reconnecting…')); }
      else if (connection === 'disconnected') { reportVideo(false); setOverlay(t('The video connection was interrupted…')); }
    };
    try {
      await my.setRemoteDescription({ type: 'offer', sdp: steadySdp(msg.sdp) });
      for (const c of queue) await my.addIceCandidate(c).catch(() => {});
      if (my !== pc) return;
      pending = null;
      await my.setLocalDescription(await my.createAnswer());
      if (my !== pc) return;
      send({ t: 'rtc.answer', session: msg.session, sdp: my.localDescription.sdp });
    } catch (err) {
      console.log(`viewer offer failed: ${err.message}`);
      if (my === pc) setOverlay(t('Couldn’t start the video: {error}', { error: err.message }));
    }
  }

  video.addEventListener('playing', () => {
    setOverlay('');
    applyViewport();
    TD.playing(video.videoWidth, video.videoHeight);
    requireCurrentFrame();
  });
  for (const event of ['waiting', 'stalled', 'emptied', 'ended']) video.addEventListener(event, () => {
    reportVideo(false);
    if (event === 'waiting' || event === 'stalled') requireCurrentFrame();
  });
  let videoAspect = 0;
  video.addEventListener('resize', () => {
    const aspect = video.videoHeight ? video.videoWidth / video.videoHeight : 0;
    if (viewGestures && videoAspect && Math.abs(aspect - videoAspect) > 0.001) cancelInput();
    videoAspect = aspect;
    applyViewport(); TD.playing(video.videoWidth, video.videoHeight);
    requireCurrentFrame();
  });

  window.tdRecv = (msg) => {
    if (msg.t !== 'rtc.ice') console.log(`viewer <- ${msg.t}${msg.session != null ? ` #${msg.session}` : ''}`);
    switch (msg.t) {
      case 'viewer.probe':
        if (videoOwner && msg.session === session && Number.isInteger(msg.viewerGeneration) && msg.viewerGeneration > 0) {
          reportVideo(false);
          viewerGeneration = msg.viewerGeneration;
          videoOwner = { ...videoOwner, generation: viewerGeneration };
          if (msg.accept === true) requireCurrentFrame();
        }
        break;
      case 'stream.info': // its name is the display shared, not the computer
        streamAudio = msg.audio === true;
        applyAudio();
        if (!pc) setOverlay(t('Waiting for {name}…', { name }));
        break;
      case 'rtc.offer':
        setOverlay(t('Waiting for {name}…', { name }));
        onOffer(msg); break;
      case 'rtc.ice':
        if (!pc || msg.session !== session || !msg.candidate) break;
        if (pending) pending.push(msg.candidate);
        else pc.addIceCandidate(msg.candidate).catch(() => {});
        break;
      case 'stream.stop':
        if (viewGestures) cancelInput();
        closePc();
        setOverlay(t('{name} isn’t sharing its screen', { name }));
        break;
      case 'viewer.input':
        inputAllowsCue = msg.on === true;
        if (!inputAllowsCue) hidePointerCue();
        break;
      case 'screen.state': {
        const wasDirect = real();
        if ('touch' in msg) realTouch = msg.touch === true;
        shareAllowsCue = msg.on === true;
        if (!shareAllowsCue) hidePointerCue();
        if (viewGestures && !wasDirect && real()) resetLocalZoom();
        if (msg.on === false) reportVideo(false);
        if (!pc) setOverlay(msg.on ? t('Waiting for {name}…', { name })
          : t('{name} isn’t sharing its screen. Start it with the button below.', { name }));
        break;
      }
      case 'opts': {
        inputAllowsCue = msg.inputOn === true;
        if (!inputAllowsCue) hidePointerCue();
        if (msg.name) name = msg.name;
        sound = msg.sound !== false;
        pacing = ['smooth', 'steady'].includes(msg.pacing) ? msg.pacing : 'fast';
        const touch = msg.touch === 'direct' ? 'direct' : 'pad';
        const wasDirect = real();
        if (touch !== touchMode) cancelInput();
        touchMode = touch;
        if (viewGestures && !wasDirect && real()) resetLocalZoom();
        if (Number(msg.speed) > 0) speed = Number(msg.speed);
        tapClick = msg.tap === true;
        if (msg.pen === false && penOn) penLeave(); // switched off while it is near
        penOn = msg.pen !== false;
        penFast = msg.penFast === true;
        penPace.flush();
        ink.set(msg.ink !== false);
        document.body.classList.toggle('pad', touchMode === 'pad');
        applyAudio();
        if (pc) for (const r of pc.getReceivers()) if (r.track.kind === 'video') pace(r);
        break;
      }
      case 'keyboard':
        if (msg.on) { kbd.value = ''; sent = ''; kbd.focus(); } else kbd.blur();
        break;
      default: break;
    }
  };

  // ---- input ----

  function drawn() {
    const r = fitRect();
    if (!r) return null;
    const W = window.innerWidth, H = window.innerHeight;
    return { x: (W - r.w * zoom) / 2 + panX, y: (H - r.h * zoom) / 2 + panY, w: r.w * zoom, h: r.h * zoom };
  }
  function norm(cx, cy, clamp) {
    const r = drawn();
    if (!r) return null;
    let x = (cx - r.x) / r.w, y = (cy - r.y) / r.h;
    if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
    x = Math.min(1, Math.max(0, x));
    y = Math.min(1, Math.max(0, y));
    return { x, y };
  }

  // Android Mac view: one finger controls, two scroll or pinch, three pan locally.
  // Other viewers retain two-finger scrolling.
  const touches = new Map(); // pointerId -> {x, y}
  let one = null; // {start, at, moved, dragging, timer, right}
  let two = null; // {x, y} average of the two fingers
  const SLOP = 10;
  let gesture = null;
  function cancelFinger() {
    if (one) {
      clearTimeout(one.timer);
      if (one.dragging) send({ t: 'in.mu', x: one.p.x, y: one.p.y, b: B.LEFT });
    }
    one = null; two = null;
  }
  function cancelViewTouch() { cancelFinger(); gesture = null; touches.clear(); }
  function fingerGeometry(ids) {
    const p = ids.map((id) => touches.get(id));
    if (p.some((v) => !v)) return null;
    return { x: p.reduce((n, v) => n + v.x, 0) / p.length,
      y: p.reduce((n, v) => n + v.y, 0) / p.length,
      span: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) };
  }
  function beginGesture() {
    cancelFinger();
    if (touches.size >= 4) { if (gesture) gesture.frozen = true; return; }
    if (gesture && gesture.frozen) return;
    if (gesture && gesture.latched) {
      if (gesture.ids.length !== 2 || touches.size !== 3 || performance.now() - gesture.started >= 150) return;
      zoom = gesture.zoom; panX = gesture.panX; panY = gesture.panY; applyViewport();
    }
    const ids = [...touches.keys()];
    const at = fingerGeometry(ids);
    gesture = { ids, at, last: at, zoom, panX, panY, started: performance.now(), latched: false, frozen: false, mode: null, queued: false };
  }
  function moveGesture(e) {
    const g = gesture;
    if (g.frozen || !g.ids.includes(e.pointerId)) return;
    // A frame contains both fingers' moves; classifying the first event alone
    // makes parallel scrolling look like a pinch.
    if (g.queued) return;
    g.queued = true;
    requestAnimationFrame(() => { g.queued = false; if (gesture === g) updateGesture(); });
  }
  function updateGesture(ending = false) {
    const g = gesture;
    if (!g || g.frozen) return;
    const at = fingerGeometry(g.ids);
    if (!at) { g.frozen = true; return; }
    if (!g.latched) {
      if (Math.hypot(at.x - g.at.x, at.y - g.at.y) <= SLOP &&
          (g.ids.length !== 2 || Math.abs(at.span - g.at.span) <= SLOP)) return;
      g.latched = true;
      g.mode = g.ids.length === 3 ? 'pan' :
        Math.abs(at.span - g.at.span) > Math.hypot(at.x - g.at.x, at.y - g.at.y) * 1.5 ? 'pinch' : 'scroll';
    }
    if (g.mode === 'scroll') {
      // Let a slightly staggered third finger turn the gesture into a local
      // pan before committing any remote scroll. A lift settles two fingers.
      const wait = 150 - (performance.now() - g.started);
      if (!ending && wait > 0) {
        if (!g.scrollTimer) g.scrollTimer = setTimeout(() => {
          g.scrollTimer = null;
          if (gesture === g) updateGesture();
        }, wait);
        return;
      }
      const dx = (g.last.x - at.x) * 2, dy = (g.last.y - at.y) * 2;
      if (Math.abs(dx) + Math.abs(dy) >= 1) { send({ t: 'in.wh', dx, dy }); g.last = at; }
      return;
    }
    if (!fitRect()) return;
    if (g.mode === 'pan') {
      panX = g.panX + at.x - g.at.x;
      panY = g.panY + at.y - g.at.y;
      applyViewport();
      return;
    }
    const min = 1;
    const max = Math.max(4, g.zoom);
    const next = Math.max(min, Math.min(max, g.at.span > 0 ? g.zoom * at.span / g.at.span : g.zoom));
    zoom = Math.abs(next - 1) < 0.05 ? 1 : next;
    panX = at.x - window.innerWidth / 2 - (g.at.x - window.innerWidth / 2 - g.panX) * zoom / g.zoom;
    panY = at.y - window.innerHeight / 2 - (g.at.y - window.innerHeight / 2 - g.panY) * zoom / g.zoom;
    applyViewport();
  }
  function followCursor() {
    if (!viewGestures) return;
    const r = drawn();
    if (!r || (r.w <= window.innerWidth && r.h <= window.innerHeight)) return;
    const x = r.x + cur.x * r.w, y = r.y + cur.y * r.h;
    const margin = 32;
    if (x < margin) panX += margin - x;
    else if (x > window.innerWidth - margin) panX += window.innerWidth - margin - x;
    if (y < margin) panY += margin - y;
    else if (y > window.innerHeight - margin) panY += window.innerHeight - margin - y;
    applyViewport();
  }

  // Real touch (Direct, the computer takes in.tc): every finger as a finger on its touch screen, so
  // a swipe scrolls, a pinch zooms, as the computer's own touch screen does. Moves go once a frame.
  const slots = new Map(); // pointerId -> {id 0–9, x, y}
  let tcQueued = false;
  function tcSend() {
    tcQueued = false;
    send({ t: 'in.tc', p: [...slots.values()].map((s) => [s.id, s.x, s.y]) });
  }
  function tcDown(e) {
    if (slots.size >= 10) return;
    const p = norm(e.clientX, e.clientY, false);
    if (!p) return;
    let id = 0;
    while ([...slots.values()].some((s) => s.id === id)) id++;
    slots.set(e.pointerId, { id, ...p });
    tcSend();
  }
  function tcMove(e) {
    const s = slots.get(e.pointerId);
    if (!s) return;
    const p = norm(e.clientX, e.clientY, true);
    if (!p) return;
    s.x = p.x; s.y = p.y;
    if (!tcQueued) { tcQueued = true; requestAnimationFrame(tcSend); }
  }
  function tcUp(e) {
    if (!slots.delete(e.pointerId)) return;
    tcSend();
  }
  const real = () => realTouch && touchMode === 'direct';

  function fingerDown(e) {
    cancelDetail();
    if (penNear || performance.now() - Math.max(penAway, penAt) < PALM_MS) return; // the hand holding the pen
    if (real()) return tcDown(e);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (viewGestures && (touches.size > 1 || gesture)) { beginGesture(); return; }
    if (touchMode === 'pad') return padDown(e);
    if (touches.size === 1) {
      const p = norm(e.clientX, e.clientY, false);
      if (!p) return;
      one = { sx: e.clientX, sy: e.clientY, p, moved: false, dragging: false, right: false };
      sendAt(p.x, p.y);
      one.timer = setTimeout(() => { // held still: a right click
        if (!one || one.moved) return;
        one.right = true;
        send({ t: 'in.md', x: one.p.x, y: one.p.y, b: B.RIGHT });
        send({ t: 'in.mu', x: one.p.x, y: one.p.y, b: B.RIGHT });
        TD.haptic();
      }, 550);
    } else if (touches.size === 2) {
      if (one) {
        clearTimeout(one.timer);
        if (one.dragging) send({ t: 'in.mu', x: one.p.x, y: one.p.y, b: B.LEFT });
        one = null;
      }
      const [a, b] = [...touches.values()];
      two = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }

  function fingerMove(e) {
    if (slots.size) return tcMove(e);
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (viewGestures && gesture) return moveGesture(e);
    if (two && touches.size >= 2) {
      const [a, b] = [...touches.values()];
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dx = (two.x - c.x) * 2, dy = (two.y - c.y) * 2;
      if (Math.abs(dx) + Math.abs(dy) >= 1) {
        send({ t: 'in.wh', dx, dy });
        two = c;
      }
      return;
    }
    if (!one) return;
    if (touchMode === 'pad') return padMove(e);
    const p = norm(e.clientX, e.clientY, true);
    if (!p) return;
    if (!one.moved && Math.hypot(e.clientX - one.sx, e.clientY - one.sy) > SLOP) {
      one.moved = true;
      clearTimeout(one.timer);
      if (!one.right) {
        one.dragging = true;
        send({ t: 'in.md', x: one.p.x, y: one.p.y, b: B.LEFT });
      }
    }
    one.p = p;
    if (one.moved) sendAt(p.x, p.y);
  }

  function fingerUp(e) {
    if (slots.has(e.pointerId)) return tcUp(e);
    if (viewGestures && gesture) updateGesture(true);
    touches.delete(e.pointerId);
    if (viewGestures && gesture) {
      if (gesture.ids.includes(e.pointerId)) gesture.frozen = true;
      if (!touches.size) { gesture = null; scheduleDetail(); }
      return;
    }
    if (touches.size === 0) { two = null; scheduleDetail(); }
    if (!one) return;
    if (touchMode === 'pad') return padUp(e);
    clearTimeout(one.timer);
    if (one.dragging) send({ t: 'in.mu', x: one.p.x, y: one.p.y, b: B.LEFT });
    else if (!one.right && !one.moved) {
      send({ t: 'in.md', x: one.p.x, y: one.p.y, b: B.LEFT });
      send({ t: 'in.mu', x: one.p.x, y: one.p.y, b: B.LEFT });
    }
    one = null;
  }

  // Touchpad: the pointer moves by how far the finger slides (faster flicks go further) and the
  // finger never clicks; held still it right-clicks. cur is the pointer, normalized like in.mm.
  const cur = { x: 0.5, y: 0.5 };
  let cueFrame = null, cueTimer = null;
  let inputAllowsCue = false, shareAllowsCue = false;

  function hidePointerCue() {
    clearTimeout(cueTimer);
    if (cueFrame !== null) cancelAnimationFrame(cueFrame);
    cueFrame = cueTimer = null;
    if (pointerCue) pointerCue.hidden = true;
  }

  function previewPointer() {
    if (!pointerCue || !inputAllowsCue || !shareAllowsCue || document.hidden ||
        pc?.connectionState !== 'connected' || !video.srcObject ||
        video.paused || video.readyState < video.HAVE_CURRENT_DATA) return;
    clearTimeout(cueTimer);
    cueTimer = setTimeout(hidePointerCue, 160);
    if (cueFrame !== null) return;
    cueFrame = requestAnimationFrame(() => {
      cueFrame = null;
      const r = drawn();
      if (!r) return hidePointerCue();
      pointerCue.style.transform = `translate(${r.x + cur.x * r.w}px, ${r.y + cur.y * r.h}px)`;
      pointerCue.hidden = false;
    });
  }

  function padDown(e) {
    if (touches.size === 1) {
      followCursor();
      one = { id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, t0: performance.now(), moved: false, right: false };
      one.timer = setTimeout(() => { // held still: a right click
        if (!one || one.moved) return;
        one.right = true;
        send({ t: 'in.md', x: cur.x, y: cur.y, b: B.RIGHT });
        send({ t: 'in.mu', x: cur.x, y: cur.y, b: B.RIGHT });
        TD.haptic();
      }, 550);
    } else if (touches.size === 2) {
      hidePointerCue();
      if (one) { clearTimeout(one.timer); one = null; }
      const [a, b] = [...touches.values()];
      two = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  function padMove(e) {
    if (e.pointerId !== one.id) return;
    const r = drawn();
    if (!r) return;
    if (!one.moved) {
      if (Math.hypot(e.clientX - one.sx, e.clientY - one.sy) <= SLOP) return;
      one.moved = true;
      clearTimeout(one.timer);
      one.lx = one.sx; // the slide counts from where the finger came down
      one.ly = one.sy;
    }
    const dx = e.clientX - one.lx, dy = e.clientY - one.ly;
    one.lx = e.clientX;
    one.ly = e.clientY;
    const g = speed * (1 + Math.min(1, Math.hypot(dx, dy) / 30));
    cur.x = Math.min(1, Math.max(0, cur.x + (dx * g) / r.w));
    cur.y = Math.min(1, Math.max(0, cur.y + (dy * g) / r.h));
    followCursor();
    sendAt(cur.x, cur.y);
    previewPointer();
  }
  function padUp(e) {
    if (e.pointerId !== one.id) return;
    hidePointerCue();
    clearTimeout(one.timer);
    if (tapClick && !one.moved && !one.right && performance.now() - one.t0 < 300) {
      send({ t: 'in.md', x: cur.x, y: cur.y, b: B.LEFT });
      send({ t: 'in.mu', x: cur.x, y: cur.y, b: B.LEFT });
    }
    one = null;
  }

  // A stylus: where it points, as a pen on the computer. in.mm/md/mu carry `pen`: {p pressure 0–1,
  // tx/ty tilt (degrees, −90…90), tw twist (degrees, 0–359), c the tip (or the eraser) touches,
  // er the eraser end, bar the side button held, out it left the screen's range}. The helpers inject
  // a tablet pen; a computer that doesn't know `pen` takes it as a mouse. md/mu: b 0 the tip or the
  // eraser, b 1 the side button (a right click as a mouse). While it is near, fingers do nothing (the
  // hand resting on the screen).
  //
  // An Apple Pencil in Safari (iPadOS), as drawing apps on the web handle it:
  //   - tilt from altitudeAngle/azimuthAngle when the browser has them (Safari's tiltX/tiltY are whole
  //     degrees; the angles are exact), else tiltX/tiltY;
  //   - the first sample of a stroke can come with pressure 0: the stroke's last pressure (or a light
  //     touch) instead, so a line doesn't start with a gap;
  //   - Scribble (iPadOS handwriting) swallows pointer events unless touchmove is cancelled
  //     (WebKit bug 217430): every touchmove here is, and a stylus touchstart too;
  //   - palm rejection: while the pen is near, and for PALM_MS after it last did anything, a finger
  //     is the hand holding it (a Pencil without hover is only "near" while it touches).
  const PEN_BUTTON = { 0: B.LEFT, 5: B.LEFT, 2: B.RIGHT };
  const PALM_MS = 1500;
  let penNear = false;
  let penAway = 0; // when it left (fingers count again a moment later)
  let penAt = 0; // when it last did anything
  let penLast = null; // {x, y, pen} what was sent last
  let strokeP = 0; // the stroke's last pressure
  const penHeld = new Set();
  const DEG = 180 / Math.PI;
  function penTilt(e) {
    const alt = e.altitudeAngle, az = e.azimuthAngle;
    if (typeof alt === 'number' && typeof az === 'number' && alt > 0) {
      if (alt >= Math.PI / 2 - 1e-6) return [0, 0]; // straight up
      const t = Math.tan(alt);
      return [Math.round(Math.atan(Math.cos(az) / t) * DEG * 10) / 10, Math.round(Math.atan(Math.sin(az) / t) * DEG * 10) / 10];
    }
    return [Math.round(e.tiltX || 0), Math.round(e.tiltY || 0)];
  }
  function penState(e) {
    const c = (e.buttons & 33) !== 0; // the tip (1) or the eraser (32)
    let p = c ? Math.min(1, Math.max(0, e.pressure || 0)) : 0;
    if (c && p === 0) p = strokeP || 0.2; // a first sample without pressure
    strokeP = c ? p : 0;
    const [tx, ty] = penTilt(e);
    return {
      p: Math.round(p * 10000) / 10000,
      tx, ty, tw: Math.round(e.twist || 0) % 360,
      c, er: (e.buttons & 32) !== 0 || e.button === 5, bar: (e.buttons & 2) !== 0,
    };
  }
  // Scribble: cancelled touch moves keep Safari from taking the Pencil's strokes for handwriting.
  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchstart', (e) => {
    if ([...e.changedTouches].some((t) => t.touchType === 'stylus')) e.preventDefault();
  }, { passive: false });
  function penNearNow() {
    penAt = performance.now();
    if (!penNear) { // the hand comes with it: let go of what fingers were doing
      penNear = true;
      hidePointerCue();
      if (one) {
        clearTimeout(one.timer);
        if (one.dragging) send({ t: 'in.mu', x: one.p.x, y: one.p.y, b: B.LEFT });
      }
      one = null;
      two = null;
      gesture = null;
      touches.clear();
      if (slots.size) { slots.clear(); tcSend(); }
    }
  }
  function penSend(t, e, b) {
    penPace.flush(); // a down, up or hover after the stroke's samples, never before
    const p = norm(e.clientX, e.clientY, penHeld.size > 0 || t !== 'in.mm');
    if (!p) return penOut(); // hovering outside the picture
    penLast = { x: p.x, y: p.y, pen: penState(e) };
    ink.at(e, penLast.pen);
    send(b === undefined ? { t, x: p.x, y: p.y, pen: penLast.pen } : { t, x: p.x, y: p.y, b, pen: penLast.pen });
  }
  // A stroke's samples since the last event (120–240 a second) in one in.mm: the last one as x, y
  // and pen, those before it in `pts` [[x, y, p, tx, ty], …] (P.penPoints; a computer that doesn't
  // know `pts` takes the last). One message instead of several keeps up on a busy link.
  function penSendAll(list) {
    penPace.flush();
    const pts = [];
    let last = null;
    for (const e of list) {
      const p = norm(e.clientX, e.clientY, true);
      if (!p) continue;
      const st = penState(e);
      ink.at(e, st);
      if (last) pts.push([last.x, last.y, last.pen.p, last.pen.tx, last.pen.ty]);
      last = { x: p.x, y: p.y, pen: st };
    }
    if (!last) return;
    penLast = last;
    send(pts.length ? { t: 'in.mm', x: last.x, y: last.y, pen: last.pen, pts } : { t: 'in.mm', x: last.x, y: last.y, pen: last.pen });
  }

  // Precise writing (Fast writing off, the default): every sample its own in.mm, sent as far apart
  // as the pen made them (their timeStamps, at most a frame behind). Samples that arrive together
  // are injected together, and macOS and Windows merge a burst of pen moves into its last one: the
  // line on the computer loses the points between (the ink preview here still has them).
  const penPace = (() => {
    const GAP_MAX = 8; // ms between two samples, at most
    const LAG_MAX = 20; // ms behind the pen, at most: past it the rest go at once
    let q = [], timer = 0, due = 0, prevT = 0;
    function run() {
      timer = 0;
      const now = performance.now();
      while (q.length && q[0].due <= now + 0.5) send(q.shift().m);
      if (q.length) timer = setTimeout(run, Math.max(0, q[0].due - now));
    }
    return {
      add(m, t) {
        const now = performance.now();
        if (!q.length && due <= now) { due = now; prevT = t; send(m); return; }
        due = Math.max(now, due + Math.min(GAP_MAX, Math.max(0, t - prevT)));
        if (due - now > LAG_MAX) due = now;
        prevT = t;
        q.push({ m, due });
        if (!timer) timer = setTimeout(run, Math.max(0, q[0].due - now));
      },
      flush() {
        if (timer) { clearTimeout(timer); timer = 0; }
        for (const x of q) send(x.m);
        q = [];
        due = 0;
      },
    };
  })();
  function penSendEach(list) {
    for (const e of list) {
      const p = norm(e.clientX, e.clientY, true);
      if (!p) continue;
      const st = penState(e);
      ink.at(e, st);
      penLast = { x: p.x, y: p.y, pen: st };
      penPace.add({ t: 'in.mm', x: p.x, y: p.y, pen: st }, e.timeStamp);
    }
  }

  // The ink preview: the stroke drawn under the pen at once, fading once the picture has had time
  // to show the computer's own (the video comes back a frame or several later).
  const ink = (() => {
    const HOLD = 220, FADE = 260;
    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:1';
    document.body.appendChild(cv);
    const g = cv.getContext('2d');
    let on = true, segs = [], prev = null, queued = false;
    function size() {
      const d = Math.min(window.devicePixelRatio || 1, 3);
      cv.width = Math.round(window.innerWidth * d);
      cv.height = Math.round(window.innerHeight * d);
      g.setTransform(d, 0, 0, d, 0, 0);
      g.lineCap = 'round';
    }
    size();
    window.addEventListener('resize', size);
    function frame() {
      queued = false;
      const now = performance.now();
      segs = segs.filter((s) => now - s.t < HOLD + FADE);
      g.clearRect(0, 0, cv.width, cv.height);
      for (const s of segs) {
        g.globalAlpha = Math.min(1, Math.max(0, 1 - (now - s.t - HOLD) / FADE));
        g.lineWidth = s.w;
        g.strokeStyle = s.er ? 'rgba(255,255,255,0.6)' : 'rgba(90,160,255,0.95)';
        g.beginPath();
        g.moveTo(s.x1, s.y1);
        g.lineTo(s.x2, s.y2);
        g.stroke();
      }
      if (segs.length) { queued = true; requestAnimationFrame(frame); }
    }
    return {
      set(v) { on = v; if (!on) { segs = []; prev = null; g.clearRect(0, 0, cv.width, cv.height); } },
      // A pen sample (client px) in its state: a segment from the last one while it touches.
      at(e, st) {
        if (!on || !st.c) { prev = null; return; }
        const x = e.clientX, y = e.clientY;
        if (prev) segs.push({ x1: prev.x, y1: prev.y, x2: x, y2: y, w: 1.2 + 3 * st.p, er: st.er, t: performance.now() });
        prev = { x, y };
        if (!queued) { queued = true; requestAnimationFrame(frame); }
      },
    };
  })();
  function penOut() {
    penPace.flush();
    ink.at(null, { c: false });
    if (penLast && !penLast.pen.out) {
      for (const b of penHeld) send({ t: 'in.mu', x: penLast.x, y: penLast.y, b, pen: { ...penLast.pen, c: false, p: 0 } });
      penHeld.clear();
      penLast.pen = { ...penLast.pen, c: false, p: 0, bar: false, out: true };
      send({ t: 'in.mm', x: penLast.x, y: penLast.y, pen: penLast.pen });
    }
    penLast = null;
  }
  function penDown(e) {
    e.preventDefault();
    penNearNow();
    const b = PEN_BUTTON[e.button];
    if (b === undefined) return;
    penHeld.add(b);
    penSend('in.md', e, b);
  }
  function penMove(e) {
    penNearNow();
    // Every sample since the last event (a pen reports 120–240 a second): strokes stay smooth.
    // Hovering, only where it is now.
    const all = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (!penHeld.size) return penSend('in.mm', e);
    if (penFast) return all.length ? penSendAll(all) : penSend('in.mm', e);
    penSendEach(all.length ? all : [e]);
  }
  function penUp(e) {
    const b = PEN_BUTTON[e.button];
    if (b === undefined || !penHeld.has(b)) return;
    penHeld.delete(b);
    penSend('in.mu', e, b);
  }
  function penLeave() {
    penOut();
    penNear = false;
    penAway = performance.now();
  }
  // Out of its range: the pen leaves the page (pointerleave doesn't bubble up to window).
  document.documentElement.addEventListener('pointerleave', (e) => { if (e.pointerType === 'pen') penLeave(); });

  // A mouse (or trackpad) on the phone: as on a computer.
  const BUTTONS = { 0: B.LEFT, 1: B.MIDDLE, 2: B.RIGHT, 3: 3, 4: 4 };
  const held = new Set();
  const keyHeld = new Set();
  let mouseLast = { x: 0.5, y: 0.5 };
  function cancelInput() {
    cancelDetail();
    if (one) {
      clearTimeout(one.timer);
      if (one.dragging) send({ t: 'in.mu', x: one.p.x, y: one.p.y, b: B.LEFT });
    }
    one = two = null; gesture = null; touches.clear();
    if (slots.size) { slots.clear(); tcSend(); }
    if (penNear || penLast || penHeld.size) penLeave();
    for (const b of held) send({ t: 'in.mu', ...mouseLast, b });
    held.clear();
    for (const code of keyHeld) send({ t: 'in.ku', code });
    keyHeld.clear();
  }
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen' && penOn) return penDown(e);
    if (e.pointerType === 'touch') return fingerDown(e);
    e.preventDefault();
    const p = norm(e.clientX, e.clientY, false);
    const b = BUTTONS[e.button];
    if (!p || b === undefined) return;
    mouseLast = p;
    held.add(b);
    send({ t: 'in.md', x: p.x, y: p.y, b });
  });
  // pointerrawupdate comes as soon as the system has the sample, not once a frame (Chromium; Safari
  // has none): the pen goes from there, a frame sooner.
  const RAW = 'onpointerrawupdate' in window;
  if (RAW) window.addEventListener('pointerrawupdate', (e) => { if (e.pointerType === 'pen' && penOn) penMove(e); });
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'pen' && penOn) return RAW ? undefined : penMove(e);
    if (e.pointerType === 'touch') return fingerMove(e);
    const p = norm(e.clientX, e.clientY, held.size > 0);
    if (p) { mouseLast = p; sendAt(p.x, p.y); }
  });
  window.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'pen' && penOn) return penUp(e);
    if (e.pointerType === 'touch') return fingerUp(e);
    const b = BUTTONS[e.button];
    if (!held.has(b)) return;
    held.delete(b);
    const p = norm(e.clientX, e.clientY, true);
    if (p) send({ t: 'in.mu', x: p.x, y: p.y, b });
  });
  window.addEventListener('pointercancel', (e) => {
    if (e.pointerType === 'pen') { if (penOn) penLeave(); }
    else if (e.pointerType === 'touch') {
      if (viewGestures && !real()) { cancelFinger(); touches.delete(e.pointerId); if (gesture) gesture.frozen = true; if (!touches.size) gesture = null; }
      else fingerUp(e);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (viewGestures) cancelInput();
      reportVideo(false);
    }
    else requireCurrentFrame();
  });
  window.addEventListener('blur', () => { if (viewGestures) cancelInput(); });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : 1;
    send({ t: 'in.wh', dx: e.deltaX * k, dy: e.deltaY * k });
  }, { passive: false });

  // Keys: a hardware keyboard sends codes; the soft keyboard sends characters (mapped to keys).
  // The soft keyboard's Backspace or Enter on an empty field comes as a key, with no code sometimes.
  const keyCode = (e) => e.code || ({ Backspace: 'Backspace', Enter: 'Enter' })[e.key] || '';
  window.addEventListener('keydown', (e) => {
    if (!keyCode(e) || e.keyCode === 229 || e.isComposing) return; // composing on the soft keyboard: see 'input'
    e.preventDefault();
    keyHeld.add(keyCode(e));
    send({ t: 'in.kd', code: keyCode(e) });
  });
  window.addEventListener('keyup', (e) => {
    if (!keyCode(e) || e.keyCode === 229 || e.isComposing) return;
    e.preventDefault();
    keyHeld.delete(keyCode(e));
    send({ t: 'in.ku', code: keyCode(e) });
  });

  const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';
  const PLAIN = '`1234567890-=[]\\;\',./';
  const CODES = ['Backquote', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash'];
  function keyFor(ch) {
    if (/^[a-z]$/.test(ch)) return { code: `Key${ch.toUpperCase()}`, shift: false };
    if (/^[A-Z]$/.test(ch)) return { code: `Key${ch}`, shift: true };
    if (ch === ' ') return { code: 'Space', shift: false };
    if (ch === '\n') return { code: 'Enter', shift: false };
    let i = PLAIN.indexOf(ch);
    if (i >= 0) return { code: CODES[i], shift: false };
    i = SHIFTED.indexOf(ch);
    if (i >= 0) return { code: CODES[i], shift: true };
    return null;
  }
  function tap(code, shift) {
    if (shift) send({ t: 'in.kd', code: 'ShiftLeft' });
    send({ t: 'in.kd', code });
    send({ t: 'in.ku', code });
    if (shift) send({ t: 'in.ku', code: 'ShiftLeft' });
  }
  // The soft keyboard composes in the field ("h", "he", "hel", then autocorrect) and that can't be
  // prevented: what's sent is the difference from what was sent before, and the field is emptied
  // once nothing is being composed.
  let sent = '';
  let composing = false;
  function sync() {
    const v = kbd.value;
    let i = 0;
    while (i < sent.length && i < v.length && sent[i] === v[i]) i++;
    for (const ch of sent.slice(i)) if (keyFor(ch)) tap('Backspace', false);
    for (const ch of v.slice(i)) {
      const k = keyFor(ch);
      if (k) tap(k.code, k.shift);
    }
    sent = v;
  }
  function settle() {
    setTimeout(() => { if (!composing) { kbd.value = ''; sent = ''; } }, 0);
  }
  kbd.addEventListener('compositionstart', () => { composing = true; });
  kbd.addEventListener('compositionend', () => { composing = false; sync(); settle(); });
  kbd.addEventListener('input', (e) => {
    sync();
    if (!e.isComposing && !composing) settle();
  });

  setOverlay(t('Waiting for the computer…'));
  TD.ready();
})();

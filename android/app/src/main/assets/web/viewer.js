// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac's screen on the phone (like windows/monitor.js): answers the Mac's WebRTC offer and
// plays the picture (and its sound), and sends input back as in.* (normalized 0–1):
//   touch   touchpad (opts.touch 'pad', the default): slide = move the pointer (never clicks) ·
//           tap = left click ("Tap to click", on unless switched off) · hold = right click ·
//           two fingers = scroll
//           direct ('direct'): tap = click · hold = right click · drag = drag · two fingers = scroll
//           (the Mac's pointer follows the finger, so it is a touch screen for the Mac)
//   mouse   and a hardware keyboard work as on a computer
//   stylus  a pen on the computer: where it points, with its pressure, tilt, eraser and side button
//           (opts.pen; off: a mouse)
//   soft keyboard: what is typed goes as keys (the app's Keyboard button shows it)
// The app talks to it through window.TD (send, ready, …) and window.tdRecv(message).
'use strict';

(() => {
  const video = document.getElementById('video');
  const audio = document.getElementById('audio');
  const overlay = document.getElementById('overlay');
  const kbd = document.getElementById('kbd');
  const TD = window.TD;
  const send = (m) => TD.send(JSON.stringify(m));
  // in.mm straight to the socket (WebHost's TD.move): no object or JSON per pointer event.
  const sendAt = typeof TD.move === 'function' ? (x, y) => TD.move(2, x, y, false) : (x, y) => send({ t: 'in.mm', x, y });
  const B = { LEFT: 0, RIGHT: 1, MIDDLE: 2 };

  let pc = null;
  let session = null;
  let pending = null;
  let name = 'the computer'; // the one we're connected to (opts)
  let streamAudio = false;
  let sound = true;
  let pacing = 'fast';
  let touchMode = 'pad'; // 'pad' | 'direct' (opts.touch)
  let speed = 1; // the touchpad's pointer speed (opts.speed)
  let tapClick = true; // a quick tap left-clicks (opts.tap)
  let penOn = true; // a stylus is a pen (opts.pen); off: a mouse

  function setOverlay(t) {
    overlay.textContent = t || '';
    overlay.classList.toggle('hidden', !t);
  }

  function pace(r) {
    const fast = pacing === 'fast';
    if ('jitterBufferTarget' in r) r.jitterBufferTarget = fast ? 0 : 16;
    if ('playoutDelayHint' in r) r.playoutDelayHint = fast ? 0 : null;
  }

  function closePc() {
    if (pc) pc.close();
    pc = null;
    session = null;
    pending = null;
    video.srcObject = null;
    audio.srcObject = null;
  }

  function applyAudio() {
    audio.muted = !sound || !streamAudio;
    if (audio.srcObject && !audio.muted) audio.play().catch(() => {});
  }

  async function onOffer(msg) {
    closePc();
    // On a USB cable the computer sends its relay (msg.ice): the picture goes through adb.
    const my = (pc = new RTCPeerConnection(msg.ice || { iceServers: [] }));
    session = msg.session;
    const queue = (pending = []);
    setOverlay(`Connecting to ${name}…`);
    my.ontrack = (e) => {
      if (e.track.kind === 'audio') {
        if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 0;
        audio.srcObject = new MediaStream([e.track]);
        applyAudio();
        return;
      }
      pace(e.receiver);
      video.srcObject = new MediaStream([e.track]);
      video.play().catch(() => {});
    };
    my.onicecandidate = (e) => {
      if (e.candidate && my === pc) send({ t: 'rtc.ice', session: msg.session, candidate: e.candidate.toJSON() });
    };
    my.onconnectionstatechange = () => {
      if (my !== pc) return;
      if (my.connectionState === 'failed') setOverlay('Reconnecting…');
      else if (my.connectionState === 'disconnected') setOverlay('The video connection was interrupted…');
    };
    try {
      await my.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      for (const c of queue) await my.addIceCandidate(c).catch(() => {});
      if (my !== pc) return;
      pending = null;
      await my.setLocalDescription(await my.createAnswer());
      if (my !== pc) return;
      send({ t: 'rtc.answer', session: msg.session, sdp: my.localDescription.sdp });
    } catch (err) {
      console.log(`viewer offer failed: ${err.message}`);
      if (my === pc) setOverlay(`Couldn’t start the video: ${err.message}`);
    }
  }

  video.addEventListener('playing', () => {
    setOverlay('');
    TD.playing(video.videoWidth, video.videoHeight);
  });
  video.addEventListener('resize', () => TD.playing(video.videoWidth, video.videoHeight));

  window.tdRecv = (msg) => {
    if (msg.t !== 'rtc.ice') console.log(`viewer <- ${msg.t}${msg.session != null ? ` #${msg.session}` : ''}`);
    switch (msg.t) {
      case 'stream.info': // its name is the display shared, not the computer
        streamAudio = msg.audio === true;
        applyAudio();
        if (!pc) setOverlay(`Waiting for ${name}…`);
        break;
      case 'rtc.offer': onOffer(msg); break;
      case 'rtc.ice':
        if (!pc || msg.session !== session || !msg.candidate) break;
        if (pending) pending.push(msg.candidate);
        else pc.addIceCandidate(msg.candidate).catch(() => {});
        break;
      case 'stream.stop':
        closePc();
        setOverlay(`${name} isn’t sharing its screen`);
        break;
      case 'screen.state':
        if (!pc) setOverlay(msg.on ? `Waiting for ${name}…` : `${name} isn’t sharing its screen. Start it with the button below.`);
        break;
      case 'opts':
        if (msg.name) name = msg.name;
        sound = msg.sound !== false;
        pacing = msg.pacing === 'smooth' ? 'smooth' : 'fast';
        touchMode = msg.touch === 'direct' ? 'direct' : 'pad';
        if (Number(msg.speed) > 0) speed = Number(msg.speed);
        tapClick = msg.tap === true;
        if (msg.pen === false && penOn) penLeave(); // switched off while it is near
        penOn = msg.pen !== false;
        document.body.classList.toggle('pad', touchMode === 'pad');
        applyAudio();
        if (pc) for (const r of pc.getReceivers()) if (r.track.kind === 'video') pace(r);
        break;
      case 'keyboard':
        if (msg.on) { kbd.value = ''; sent = ''; kbd.focus(); } else kbd.blur();
        break;
      default: break;
    }
  };

  // ---- input ----

  function drawn() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const W = window.innerWidth, H = window.innerHeight;
    const k = Math.min(W / vw, H / vh);
    return { x: (W - vw * k) / 2, y: (H - vh * k) / 2, w: vw * k, h: vh * k };
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

  // Touch: one finger is the Mac's pointer; two fingers scroll.
  const touches = new Map(); // pointerId -> {x, y}
  let one = null; // {start, at, moved, dragging, timer, right}
  let two = null; // {x, y} average of the two fingers
  const SLOP = 10;

  function fingerDown(e) {
    if (penNear || performance.now() - Math.max(penAway, penAt) < PALM_MS) return; // the hand holding the pen
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
    touches.delete(e.pointerId);
    if (touches.size === 0) two = null;
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
  function padDown(e) {
    if (touches.size === 1) {
      one = { id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, t0: performance.now(), moved: false, right: false };
      one.timer = setTimeout(() => { // held still: a right click
        if (!one || one.moved) return;
        one.right = true;
        send({ t: 'in.md', x: cur.x, y: cur.y, b: B.RIGHT });
        send({ t: 'in.mu', x: cur.x, y: cur.y, b: B.RIGHT });
        TD.haptic();
      }, 550);
    } else if (touches.size === 2) {
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
    sendAt(cur.x, cur.y);
  }
  function padUp(e) {
    if (e.pointerId !== one.id) return;
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
      if (one) {
        clearTimeout(one.timer);
        if (one.dragging) send({ t: 'in.mu', x: one.p.x, y: one.p.y, b: B.LEFT });
      }
      one = null;
      two = null;
      touches.clear();
    }
  }
  function penSend(t, e, b) {
    const p = norm(e.clientX, e.clientY, penHeld.size > 0 || t !== 'in.mm');
    if (!p) return penOut(); // hovering outside the picture
    penLast = { x: p.x, y: p.y, pen: penState(e) };
    send(b === undefined ? { t, x: p.x, y: p.y, pen: penLast.pen } : { t, x: p.x, y: p.y, b, pen: penLast.pen });
  }
  function penOut() {
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
    // Every sample since the last frame (a pen reports 120–240 a second): strokes stay smooth.
    const all = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const s of all.length ? all : [e]) penSend('in.mm', s);
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
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'pen' && penOn) return penDown(e);
    if (e.pointerType === 'touch') return fingerDown(e);
    e.preventDefault();
    const p = norm(e.clientX, e.clientY, false);
    const b = BUTTONS[e.button];
    if (!p || b === undefined) return;
    held.add(b);
    send({ t: 'in.md', x: p.x, y: p.y, b });
  });
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'pen' && penOn) return penMove(e);
    if (e.pointerType === 'touch') return fingerMove(e);
    const p = norm(e.clientX, e.clientY, held.size > 0);
    if (p) sendAt(p.x, p.y);
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
    else if (e.pointerType === 'touch') fingerUp(e);
  });
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
    send({ t: 'in.kd', code: keyCode(e) });
  });
  window.addEventListener('keyup', (e) => {
    if (!keyCode(e) || e.keyCode === 229 || e.isComposing) return;
    e.preventDefault();
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

  setOverlay('Waiting for the computer…');
  TD.ready();
})();

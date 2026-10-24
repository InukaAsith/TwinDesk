// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac's screen on the phone (like windows/monitor.js): answers the Mac's WebRTC offer and
// plays the picture (and its sound), and sends input back as in.* (normalized 0–1):
//   touch   touchpad (opts.touch 'pad', the default): slide = move the pointer (never clicks) ·
//           tap = left click ("Tap to click", on unless switched off) · hold = right click ·
//           the Click button = left click (hold it and slide to drag) · two fingers = scroll
//           direct ('direct'): tap = click · hold = right click · drag = drag · two fingers = scroll
//           (the Mac's pointer follows the finger, so it is a touch screen for the Mac)
//   mouse   and a hardware keyboard work as on a computer
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
        document.body.classList.toggle('pad', touchMode === 'pad');
        applyAudio();
        if (pc) for (const r of pc.getReceivers()) if (r.track.kind === 'video') pace(r);
        break;
      case 'keyboard':
        if (msg.on) { kbd.value = ''; kbd.focus(); } else kbd.blur();
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
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchMode === 'pad') return padDown(e);
    if (touches.size === 1) {
      const p = norm(e.clientX, e.clientY, false);
      if (!p) return;
      one = { sx: e.clientX, sy: e.clientY, p, moved: false, dragging: false, right: false };
      send({ t: 'in.mm', x: p.x, y: p.y });
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
    if (one.moved) send({ t: 'in.mm', x: p.x, y: p.y });
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
    send({ t: 'in.mm', x: cur.x, y: cur.y });
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

  // The touchpad's Click button: left button down for as long as it's touched, so holding it and
  // sliding another finger drags. Its touches stay out of the ones above.
  const clickBtn = document.getElementById('click');
  let clickDown = false;
  clickBtn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    clickBtn.setPointerCapture(e.pointerId);
    if (clickDown) return;
    clickDown = true;
    clickBtn.classList.add('down');
    send({ t: 'in.md', x: cur.x, y: cur.y, b: B.LEFT });
    if (TD.tick) TD.tick();
  });
  const clickUp = (e) => {
    e.stopPropagation();
    if (!clickDown) return;
    clickDown = false;
    clickBtn.classList.remove('down');
    send({ t: 'in.mu', x: cur.x, y: cur.y, b: B.LEFT });
  };
  clickBtn.addEventListener('pointerup', clickUp);
  clickBtn.addEventListener('pointercancel', clickUp);
  clickBtn.addEventListener('pointermove', (e) => e.stopPropagation());

  // A mouse (or trackpad) on the phone: as on a computer.
  const BUTTONS = { 0: B.LEFT, 1: B.MIDDLE, 2: B.RIGHT, 3: 3, 4: 4 };
  const held = new Set();
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return fingerDown(e);
    e.preventDefault();
    const p = norm(e.clientX, e.clientY, false);
    const b = BUTTONS[e.button];
    if (!p || b === undefined) return;
    held.add(b);
    send({ t: 'in.md', x: p.x, y: p.y, b });
  });
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return fingerMove(e);
    const p = norm(e.clientX, e.clientY, held.size > 0);
    if (p) send({ t: 'in.mm', x: p.x, y: p.y });
  });
  window.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch') return fingerUp(e);
    const b = BUTTONS[e.button];
    if (!held.has(b)) return;
    held.delete(b);
    const p = norm(e.clientX, e.clientY, true);
    if (p) send({ t: 'in.mu', x: p.x, y: p.y, b });
  });
  window.addEventListener('pointercancel', (e) => { if (e.pointerType === 'touch') fingerUp(e); });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : 1;
    send({ t: 'in.wh', dx: e.deltaX * k, dy: e.deltaY * k });
  }, { passive: false });

  // Keys: a hardware keyboard sends codes; the soft keyboard sends characters (mapped to keys).
  window.addEventListener('keydown', (e) => {
    if (!e.code || e.keyCode === 229) return; // composing on the soft keyboard: see 'input'
    e.preventDefault();
    send({ t: 'in.kd', code: e.code });
  });
  window.addEventListener('keyup', (e) => {
    if (!e.code || e.keyCode === 229) return;
    e.preventDefault();
    send({ t: 'in.ku', code: e.code });
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
  kbd.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    if (e.inputType === 'deleteContentBackward') return tap('Backspace', false);
    if (e.inputType === 'insertLineBreak') return tap('Enter', false);
    for (const ch of e.data || '') {
      const k = keyFor(ch);
      if (k) tap(k.code, k.shift);
    }
  });

  setOverlay('Waiting for the computer…');
  TD.ready();
})();

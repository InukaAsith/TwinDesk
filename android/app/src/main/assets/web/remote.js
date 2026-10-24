// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Remote page (RemoteActivity): this device as the computer's touchpad and keyboard, or a
// gamepad whose sticks and buttons press the computer's keys. Everything goes out as remote.*
// (relative, like the computers' own mouse and keyboard sharing); the computer answers
// remote.state (whether it takes input from here). opts come from Remote.kt.
//   touchpad  slide = move (never clicks) · tap = left click ("Tap to click", on unless switched off)
//             hold = right click · two fingers = scroll · two-finger tap = right click
//   gamepad   left stick = four keys (WASD) · right stick = the mouse · buttons = their keys
'use strict';

(() => {
  const send = (m) => TD.send(JSON.stringify(m));
  const tick = () => { try { TD.tick(); } catch (_) { /* older app */ } };
  const $ = (id) => document.getElementById(id);
  let opts = { mode: 'pad', name: 'the computer', me: 'this device', connected: true, os: '', ble: false, speed: 1, tap: true, smooth: true, pad: {} };
  let allowed = null; // the computer's remote.state

  // ---- keys and buttons held down: counted (two controls may press the same key), all let go on close ----
  const held = new Map(); // KeyboardEvent.code or 'Mouse0'/'Mouse1'/'Mouse2' -> how many controls hold it
  function press(code, down) {
    if (!code) return;
    const n = held.get(code) || 0;
    if (down) {
      held.set(code, n + 1);
      if (n > 0) return;
    } else {
      if (n === 0) return;
      if (n > 1) return void held.set(code, n - 1);
      held.delete(code);
    }
    flush(); // the moves still waiting go first: a click lands where the pointer ends up
    const mouse = /^Mouse([0-2])$/.exec(code);
    if (mouse) send({ t: down ? 'remote.md' : 'remote.mu', b: Number(mouse[1]) });
    else send({ t: down ? 'remote.kd' : 'remote.ku', code });
  }
  const tapKey = (code) => { press(code, true); press(code, false); };
  function releaseAll() {
    for (const code of [...held.keys()]) { held.set(code, 1); press(code, false); }
    dropMods();
  }

  // ---- what the page shows ----
  function render() {
    const game = opts.mode === 'gamepad';
    document.body.classList.toggle('gamepad', game);
    document.body.classList.toggle('pad', !game);
    $('name').textContent = `${game ? 'Gamepad' : 'Touchpad'} · ${opts.name}`;
    const note = !opts.connected ? `Not connected to ${opts.name}. Connect from TwinDesk’s Overview.`
      : allowed === false ? `${opts.name} doesn’t take input from ${opts.me}. On ${opts.name}, turn on Cursor › “Use ${opts.me}’s mouse and keyboard on ${opts.name}” (or “Let ${opts.me} Control ${opts.name}” in its tray menu).`
        : allowed === null && (opts.os === 'mac' || opts.os === 'linux') ? `${opts.name} doesn’t take the remote yet: for now only TwinDesk on Windows does.`
          : '';
    $('note').textContent = note;
    $('note').hidden = !note;
  }

  window.tdRecv = (m) => {
    if (m.t === 'opts') {
      opts = { ...opts, ...m };
      if (!opts.connected) { allowed = null; releaseAll(); }
    } else if (m.t === 'remote.state') {
      allowed = m.allowed === true;
      if (!allowed) releaseAll();
    } else return;
    render();
  };

  $('b-close').onclick = () => { releaseAll(); TD.event('close'); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  window.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- pointer movement and scrolling: added up and sent once a frame (through Bluetooth, where
  // every message is a round trip on the radio, about 30 times a second) ----
  const BLE_MS = 33;
  let mx = 0, my = 0, wx = 0, wy = 0, queued = false;
  function flush() {
    queued = false;
    const dx = Math.trunc(mx), dy = Math.trunc(my);
    if (dx || dy) {
      mx -= dx; my -= dy; // keep the fractions for the next frame
      send({ t: 'remote.mm', dx, dy, smooth: opts.smooth !== false });
    }
    const sx = Math.round(wx), sy = Math.round(wy);
    if (sx || sy) {
      wx -= sx; wy -= sy;
      send({ t: 'remote.wh', dx: sx, dy: sy });
    }
  }
  function queue() {
    if (queued) return;
    queued = true;
    if (opts.ble) setTimeout(flush, BLE_MS); else requestAnimationFrame(flush);
  }
  function move(dx, dy) {
    mx += dx; my += dy;
    queue();
  }
  function scroll(dx, dy) {
    wx += dx; wy += dy;
    queue();
  }

  // ---- touchpad ----
  const pad = $('pad');
  const SLOP = 8, HOLD_MS = 550, TAP_MS = 300;
  const fingers = new Map(); // pointerId -> {x, y}
  let one = null; // one finger: {id, sx, sy, lx, ly, t0, moved, right, timer}
  let two = null; // two fingers: {x, y, t0, moved}
  // Phone pixels to the computer's: 1× when slow (fine aim), up to 2× for a quick flick. The
  // computer also scales by its display scaling, so this stays gentle.
  const gain = (d) => opts.speed * (1 + Math.min(1, d / 30));

  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size === 1) {
      one = { id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, t0: performance.now(), moved: false, right: false };
      one.timer = setTimeout(() => { // held still: a right click
        if (!one || one.moved) return;
        one.right = true;
        tapKey('Mouse1');
        TD.haptic();
      }, HOLD_MS);
    } else if (fingers.size === 2) {
      if (one) { clearTimeout(one.timer); one = null; }
      const [a, b] = [...fingers.values()];
      two = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, t0: performance.now(), moved: false };
    }
  });

  pad.addEventListener('pointermove', (e) => {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    f.x = e.clientX;
    f.y = e.clientY;
    if (two) {
      if (fingers.size < 2) return;
      const [a, b] = [...fingers.values()];
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dx = (two.x - c.x) * 2, dy = (two.y - c.y) * 2; // the page follows the fingers
      if (Math.abs(dx) + Math.abs(dy) >= 2) {
        two.moved = true;
        scroll(dx, dy);
        two.x = c.x;
        two.y = c.y;
      }
      return;
    }
    if (!one || e.pointerId !== one.id) return;
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
    const g = gain(Math.hypot(dx, dy));
    move(dx * g, dy * g);
  });

  function lift(e) {
    if (!fingers.delete(e.pointerId)) return;
    if (two) {
      if (fingers.size > 0) return;
      if (!two.moved && performance.now() - two.t0 < 300) { tapKey('Mouse1'); tick(); } // two-finger tap
      two = null;
      return;
    }
    if (!one || e.pointerId !== one.id) return;
    clearTimeout(one.timer);
    if (opts.tap && !one.moved && !one.right && performance.now() - one.t0 < TAP_MS) { tapKey('Mouse0'); tick(); }
    one = null;
  }
  pad.addEventListener('pointerup', lift);
  pad.addEventListener('pointercancel', lift);

  // A button held down for as long as it's touched (Left click + a slide on the pad = a drag).
  function holdable(el, code) {
    let pressed = null; // what this touch pressed (the mapping may change meanwhile)
    const up = () => {
      if (pressed == null) return;
      el.classList.remove('down');
      press(pressed, false);
      pressed = null;
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      if (pressed != null) return;
      pressed = typeof code === 'function' ? code() : code;
      el.classList.add('down');
      press(pressed, true);
      tick();
    });
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
  holdable($('b-left'), 'Mouse0');
  holdable($('b-right'), 'Mouse1');

  // ---- keys: a strip of the ones a phone keyboard lacks; Ctrl, Alt, Shift and Win stay down for the next key ----
  const STRIP = [
    ['Esc', 'Escape'], ['Tab', 'Tab'], ['Ctrl', 'ControlLeft', true], ['Alt', 'AltLeft', true], ['Shift', 'ShiftLeft', true], ['Win', 'MetaLeft', true],
    ['←', 'ArrowLeft'], ['↑', 'ArrowUp'], ['↓', 'ArrowDown'], ['→', 'ArrowRight'],
    ['⌫', 'Backspace'], ['Enter', 'Enter'], ['Del', 'Delete'], ['Home', 'Home'], ['End', 'End'], ['PgUp', 'PageUp'], ['PgDn', 'PageDown'], ['F5', 'F5'],
    ['⏯', 'MediaPlayPause'], ['⏮', 'MediaTrackPrevious'], ['⏭', 'MediaTrackNext'], ['Vol −', 'AudioVolumeDown'], ['Vol +', 'AudioVolumeUp'], ['Mute', 'AudioVolumeMute'],
  ];
  const mods = new Map(); // code -> its button, while it's held for the next key
  function dropMods() {
    for (const [code, b] of mods) { press(code, false); b.classList.remove('on'); }
    mods.clear();
  }
  for (const [label, code, mod] of STRIP) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('pointerdown', (e) => e.preventDefault()); // the soft keyboard stays up
    b.addEventListener('click', () => {
      tick();
      if (!mod) { tapKey(code); return dropMods(); }
      if (mods.has(code)) { mods.delete(code); b.classList.remove('on'); press(code, false); }
      else { mods.set(code, b); b.classList.add('on'); press(code, true); }
    });
    $('keys').append(b);
  }

  // The soft keyboard: characters, as the keys that type them (US layout); a modifier held from
  // the strip goes with the next one (Ctrl + c).
  const kbd = $('kbd');
  let kbdOn = false;
  $('b-kbd').addEventListener('pointerdown', (e) => e.preventDefault());
  $('b-kbd').onclick = () => {
    kbdOn = !kbdOn;
    $('b-kbd').classList.toggle('on', kbdOn);
    if (kbdOn) { kbd.value = ''; kbd.focus(); TD.event('keyboard'); } else { kbd.blur(); TD.event('keyboardOff'); }
  };
  kbd.addEventListener('blur', () => { kbdOn = false; $('b-kbd').classList.remove('on'); });
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
  function type(code, shift) {
    if (shift) press('ShiftLeft', true);
    tapKey(code);
    if (shift) press('ShiftLeft', false);
    dropMods();
  }
  kbd.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    if (e.inputType === 'deleteContentBackward') return type('Backspace', false);
    if (e.inputType === 'insertLineBreak') return type('Enter', false);
    for (const ch of e.data || '') {
      const k = keyFor(ch);
      if (k) type(k.code, k.shift);
    }
  });
  // A hardware keyboard on the phone: its keys as they are.
  window.addEventListener('keydown', (e) => {
    if (!e.code || e.keyCode === 229 || e.repeat) return; // composing on the soft keyboard: see beforeinput
    e.preventDefault();
    press(e.code, true);
  });
  window.addEventListener('keyup', (e) => {
    if (!e.code || e.keyCode === 229) return;
    e.preventDefault();
    press(e.code, false);
  });

  // ---- gamepad ----
  const padKey = (id) => (opts.pad && opts.pad[id]) || '';
  for (const el of document.querySelectorAll('#game button[data-id]')) holdable(el, () => padKey(el.dataset.id));

  // A stick: where the finger is from its middle, -1..1 each way.
  function stick(el, onMove) {
    const knob = el.querySelector('.knob');
    let id = null;
    const set = (e) => {
      const r = el.getBoundingClientRect();
      const rad = r.width / 2;
      let x = (e.clientX - (r.left + rad)) / rad;
      let y = (e.clientY - (r.top + rad)) / rad;
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      knob.style.transform = `translate(${x * rad * 0.6}px, ${y * rad * 0.6}px)`;
      onMove(x, y);
    };
    el.addEventListener('pointerdown', (e) => {
      if (id != null) return;
      e.preventDefault();
      id = e.pointerId;
      el.setPointerCapture(id);
      el.classList.add('active');
      set(e);
    });
    el.addEventListener('pointermove', (e) => { if (e.pointerId === id) set(e); });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      el.classList.remove('active');
      knob.style.transform = '';
      onMove(0, 0);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // Left stick: four keys (WASD unless set otherwise); a diagonal presses two.
  const lsHeld = {}; // control id -> the key it pressed
  function lsSet(id, on) {
    if (on === (id in lsHeld)) return;
    if (on) { lsHeld[id] = padKey(id); press(lsHeld[id], true); } else { press(lsHeld[id], false); delete lsHeld[id]; }
  }
  stick($('ls'), (x, y) => {
    const T = 0.4;
    lsSet('lsUp', y < -T);
    lsSet('lsDown', y > T);
    lsSet('lsLeft', x < -T);
    lsSet('lsRight', x > T);
  });

  // Right stick: the mouse, every frame while it's pushed, faster the further (fine aim near the middle).
  let rs = { x: 0, y: 0 };
  let rsFrame = 0;
  function rsStep() {
    rsFrame = 0;
    const len = Math.hypot(rs.x, rs.y);
    if (len < 0.12) return;
    const k = opts.speed * 12 * len; // pixels a frame: about 720 px/s pushed all the way at speed 1
    move(rs.x * k, rs.y * k);
    rsFrame = requestAnimationFrame(rsStep);
  }
  stick($('rs'), (x, y) => {
    rs = { x, y };
    if (!rsFrame && Math.hypot(x, y) >= 0.12) rsFrame = requestAnimationFrame(rsStep);
  });

  render();
  TD.ready();
})();

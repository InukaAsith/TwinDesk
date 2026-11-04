// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Remote page (RemoteActivity): this device as the computer's touchpad and keyboard, or a
// gamepad whose sticks and buttons press the computer's keys. Everything goes out as remote.*
// (relative, like the computers' own mouse and keyboard sharing); the computer answers
// remote.state (whether it takes input from here). opts come from Remote.kt.
//   touchpad  slide = move (never clicks) · tap = left click ("Tap to click", on unless switched off)
//             hold = right click · two fingers = scroll · two-finger tap = right click
//   gamepad   left stick = four keys (WASD) · right stick = the mouse · buttons = their keys; or, when
//             the computer takes it as a real gamepad (remote.state pad: Remote › Real gamepad there),
//             the sticks, triggers and buttons as they are (remote.pad); or, while a computer is
//             connected to this device as a Bluetooth gamepad (opts.bt: BtPad.kt), as HID reports (TD.pad)
'use strict';

(() => {
  const send = (m) => TD.send(JSON.stringify(m));
  // Moves and wheel steps straight to the socket (WebHost's TD.move): no object or JSON per frame.
  const hot = typeof TD.move === 'function';
  const tick = () => { try { TD.tick(); } catch (_) { /* older app */ } };
  const $ = (id) => document.getElementById(id);
  let opts = { mode: 'pad', name: 'the computer', me: 'this device', connected: true, os: '', ble: false, speed: 1, tap: true, smooth: true, pad: {}, controls: [], keys: [] };
  let allowed = null; // the computer's remote.state
  let why = ''; // …and why it doesn't take it now
  let off = false; // …because its Remote is off: Turn on, here
  let real = false; // the computer takes the gamepad as a real one (remote.pad)
  let canText = false; // the computer types characters no key there types (remote.state text: remote.text)
  const asPad = () => opts.bt === true || real; // the gamepad as a real one, here or through Bluetooth

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
    padRelease();
  }

  // ---- what the page shows ----
  function render() {
    const game = opts.mode === 'gamepad';
    document.body.classList.toggle('gamepad', game);
    document.body.classList.toggle('pad', !game);
    $('name').textContent = game && opts.bt ? `Bluetooth gamepad · ${opts.btName || 'connected'}`
      : `${game ? (real ? 'Gamepad (real)' : 'Gamepad') : 'Touchpad'} · ${opts.name}`;
    const note = game && opts.bt ? ''
      : !opts.connected ? `Not connected to ${opts.name}. Connect from TwinDesk’s Overview.`
      : allowed === false && off ? `Remote is off on ${opts.name}.`
      : allowed === false ? (why || `${opts.name} doesn’t take input from ${opts.me}. On ${opts.name}, turn on Remote in TwinDesk.`)
        : allowed === null && (opts.os === 'mac' || opts.os === 'linux') ? `${opts.name} doesn’t answer the remote: update TwinDesk there.`
          : '';
    $('note-text').textContent = note;
    $('note').hidden = !note;
    $('note-on').hidden = !(note && allowed === false && off && opts.connected);
    // A real controller: what the computer sees it as.
    const sees = !game ? ''
      : opts.bt ? `${opts.btName || 'The computer'} sees ${opts.me} as “TwinDesk Gamepad”, a Bluetooth game controller`
        : real && opts.os === 'win' ? `Windows sees it as an Xbox 360 Controller: games take it as one (joy.cpl lists it under Game Controllers)`
          : real && opts.os === 'linux' ? `${opts.name} sees it as “TwinDesk Gamepad”, an Xbox 360 controller`
            : real ? `${opts.name} sees it as a game controller` : '';
    $('pad-note').textContent = sees;
    $('pad-note').hidden = !sees;
    if (!$('map').hidden) mapFill();
  }

  // ---- the gamepad's keys (Keys): what each control presses when it isn't a real controller ----
  function mapFill() {
    const list = $('map-list');
    list.textContent = '';
    for (const [id, label] of opts.controls || []) {
      const row = document.createElement('label');
      const sel = document.createElement('select');
      for (const [code, name] of opts.keys || []) sel.add(new Option(name, code));
      sel.value = padKey(id);
      sel.onchange = () => TD.setPad(id, sel.value);
      row.append(label, sel);
      list.append(row);
    }
    $('map-hint').textContent = asPad()
      ? 'It’s a real controller now: these keys are what it presses when it isn’t (Real gamepad off on the computer, not as a Bluetooth gamepad).'
      : 'What each control presses on the computer. The left stick is four keys; the right stick moves the mouse.';
  }
  $('b-map').onclick = () => { releaseAll(); mapFill(); $('map').hidden = false; };
  $('map-done').onclick = () => { $('map').hidden = true; };
  $('map-reset').onclick = () => TD.event('padReset');

  window.tdRecv = (m) => {
    if (m.t === 'opts') {
      if ((m.bt === true) !== (opts.bt === true)) releaseAll(); // what's held goes the old way
      opts = { ...opts, ...m };
      if (!opts.connected && !opts.bt) { allowed = null; releaseAll(); }
      if (opts.bt || !opts.connected) canText = false; // a Bluetooth keyboard has only keys
    } else if (m.t === 'remote.state') {
      allowed = m.allowed === true;
      why = typeof m.why === 'string' ? m.why : '';
      off = m.off === true;
      canText = m.text === true && !opts.bt;
      if (!allowed) releaseAll();
      if ((m.pad === true) !== real) { releaseAll(); real = m.pad === true; } // what's held goes the old way
    } else return;
    render();
  };

  $('b-close').onclick = () => { releaseAll(); TD.event('close'); };
  // The computer's Remote switch, turned on from here: our out is its in (pair.sync, its pairsync.js).
  $('note-on').onclick = () => send({ t: 'pair.sync', feature: 'remote', dir: 'out', on: true });
  // The touchpad held sideways (or upright again): the activity turns, the page follows.
  $('b-rotate').onclick = () => TD.event('rotate');
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
      if (hot) TD.move(0, dx, dy, opts.smooth !== false);
      else send({ t: 'remote.mm', dx, dy, smooth: opts.smooth !== false });
    }
    const sx = Math.round(wx), sy = Math.round(wy);
    if (sx || sy) {
      wx -= sx; wy -= sy;
      if (hot) TD.move(1, sx, sy, false);
      else send({ t: 'remote.wh', dx: sx, dy: sy });
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
  // the strip goes with the next one (Ctrl + c). Characters no key types (Cyrillic, accents, emoji)
  // go as they are (remote.text), where the computer takes them; elsewhere they don't go.
  const kbd = $('kbd');
  let kbdOn = false;
  $('b-kbd').addEventListener('pointerdown', (e) => e.preventDefault());
  $('b-kbd').onclick = () => {
    kbdOn = !kbdOn;
    $('b-kbd').classList.toggle('on', kbdOn);
    if (kbdOn) { kbd.value = ''; sent = ''; kbd.focus(); TD.event('keyboard'); } else { kbd.blur(); TD.event('keyboardOff'); }
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
  // The soft keyboard composes in the field (Gboard, Samsung Keyboard: "h", "he", "hel", then
  // autocorrect), and composing can't be prevented: what's sent is the difference between the field
  // and what was sent before (Backspaces for what went, then what came), and the field is emptied
  // once nothing is being composed.
  let sent = '';
  let composing = false;
  const asText = (ch) => canText && !keyFor(ch) && !/\p{Cc}/u.test(ch);
  function sync() {
    const v = kbd.value;
    let i = 0;
    while (i < sent.length && i < v.length && sent[i] === v[i]) i++;
    const low = (c) => /[\udc00-\udfff]/.test(c || '');
    while (i > 0 && (low(v[i]) || low(sent[i]))) i--; // not inside a surrogate pair (emoji)
    for (const ch of sent.slice(i)) if (keyFor(ch) || asText(ch)) type('Backspace', false);
    let text = '';
    const flush = () => {
      if (text) send({ t: 'remote.text', text });
      text = '';
    };
    for (const ch of v.slice(i)) {
      const k = keyFor(ch);
      if (k) {
        flush();
        type(k.code, k.shift);
      } else if (asText(ch)) text += ch;
    }
    flush();
    if ([...v.slice(i)].some(asText)) dropMods(); // a strip modifier goes with the next one only
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
  // A hardware keyboard on the phone (and the soft keyboard's Backspace or Enter on an empty field):
  // its keys as they are; the field doesn't change, so nothing is sent twice.
  const keyCode = (e) => e.code || ({ Backspace: 'Backspace', Enter: 'Enter' })[e.key] || '';
  window.addEventListener('keydown', (e) => {
    if (!keyCode(e) || e.keyCode === 229 || e.isComposing || e.repeat) return; // composing: see input
    e.preventDefault();
    press(keyCode(e), true);
  });
  window.addEventListener('keyup', (e) => {
    if (!keyCode(e) || e.keyCode === 229 || e.isComposing) return;
    e.preventDefault();
    press(keyCode(e), false);
  });

  // ---- gamepad ----
  const padKey = (id) => (opts.pad && opts.pad[id]) || '';

  // As a real gamepad: its whole state (remote.pad) on change, at most every 8 ms (33 through Bluetooth).
  const BIT = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, back: 6, start: 7, l3: 8, r3: 9, up: 10, down: 11, left: 12, right: 13 };
  const gp = { b: 0, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 };
  let padSent = 0, padTimer = 0;
  function padSend() {
    if (padTimer) return;
    const wait = (opts.ble && !opts.bt ? BLE_MS : 8) - (performance.now() - padSent);
    if (wait > 0) { padTimer = setTimeout(() => { padTimer = 0; padSend(); }, wait); return; }
    padSent = performance.now();
    if (opts.bt) TD.pad(gp.b, gp.lx, gp.ly, gp.rx, gp.ry, gp.lt, gp.rt);
    else send({ t: 'remote.pad', ...gp });
  }
  function padSet(k, v, k2, v2) { // one value, or a stick's two
    if (gp[k] === v && (!k2 || gp[k2] === v2)) return;
    gp[k] = v;
    if (k2) gp[k2] = v2;
    padSend();
  }
  function padRelease() {
    if (!gp.b && !gp.lx && !gp.ly && !gp.rx && !gp.ry && !gp.lt && !gp.rt) return;
    Object.assign(gp, { b: 0, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 });
    padSend();
  }
  function padButton(id, down) {
    if (id === 'lt' || id === 'rt') return padSet(id, down ? 1 : 0);
    if (id in BIT) padSet('b', down ? gp.b | (1 << BIT[id]) : gp.b & ~(1 << BIT[id]));
  }

  // A button: its key, or as a real gamepad's button; let go the way it was pressed.
  for (const el of document.querySelectorAll('#game button[data-id]')) {
    const id = el.dataset.id;
    let pressed = null; // the key, or true (the real gamepad's)
    const up = () => {
      if (pressed == null) return;
      el.classList.remove('down');
      if (pressed === true) padButton(id, false); else press(pressed, false);
      pressed = null;
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      if (pressed != null) return;
      pressed = asPad() ? true : padKey(id);
      el.classList.add('down');
      if (pressed === true) padButton(id, true); else press(pressed, true);
      tick();
    });
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

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
    if (asPad()) return padSet('lx', x, 'ly', y);
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
    if (asPad()) { rs = { x: 0, y: 0 }; return padSet('rx', x, 'ry', y); }
    rs = { x, y };
    if (!rsFrame && Math.hypot(x, y) >= 0.12) rsFrame = requestAnimationFrame(rsStep);
  });

  render();
  TD.ready();
})();

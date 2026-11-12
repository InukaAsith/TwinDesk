// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Remote page (RemoteActivity): this device as the computer's touchpad and keyboard, or a
// gamepad whose sticks and buttons press the computer's keys. Everything goes out as remote.*
// (relative, like the computers' own mouse and keyboard sharing); the computer answers
// remote.state (whether it takes input from here). opts come from Remote.kt.
//   touchpad  slide = move (never clicks) · tap = left click ("Tap to click", on unless switched off)
//             hold = right click · two fingers = scroll · two-finger tap = right click · three-finger tap = middle click
//   gamepad   left stick = four keys (WASD) · right stick = the mouse · buttons = their keys; or, when
//             the computer takes it as a real gamepad (remote.state pad: Remote › Real gamepad there),
//             the sticks, triggers and buttons as they are (remote.pad); or, while a computer is
//             connected to this device as a Bluetooth gamepad (opts.bt: BtPad.kt), as HID reports (TD.pad)
//   air mouse hold the big area and point: the pointer follows the phone as it turns (the gyroscope)
//             · a quick tap = left click · Left click held + turning = a drag · the strip = scroll
//   present   Next / Previous (Page Down / Page Up, which every slideshow app takes; Android's volume
//             keys too) · Start, Black screen, End · Hold to point: the pointer follows the phone
// The phone's motion: the app's own sensors (TD.motion → window.tdMotion), or the browser's
// (devicemotion and deviceorientation) where there's no app (TwinDesk Web).
'use strict';

(() => {
  // Voice typing's keys and text say so: the computer takes them by its Keyboard switch, not Remote's.
  const send = (m) => TD.send(JSON.stringify(opts.mode === 'voice' && /^remote\.(kd|ku|text)$/.test(m.t) ? { ...m, voice: true } : m));
  // Moves and wheel steps straight to the socket (WebHost's TD.move): no object or JSON per frame.
  const hot = typeof TD.move === 'function';
  const tick = () => { try { TD.tick(); } catch (_) { /* older app */ } };
  const $ = (id) => document.getElementById(id);
  // The app's language (I18n.kt through TD.tr): {name} parts filled from vars, English without the app.
  const t = (text, vars = {}) => (typeof TD.tr === 'function' ? TD.tr(text, JSON.stringify(vars))
    : text.replace(/^[^|]*\|/, '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)));
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n || e.textContent);
  for (const e of document.querySelectorAll('[aria-label]')) e.setAttribute('aria-label', t(e.getAttribute('aria-label')));
  for (const e of document.querySelectorAll('[placeholder]')) e.placeholder = t(e.placeholder);
  let opts = { mode: 'pad', name: t('the computer'), me: t('this device'), connected: true, os: '', ble: false, speed: 1, tap: true, smooth: true, pad: {}, controls: [], keys: [] };
  let allowed = null; // the computer's remote.state
  let why = ''; // …and why it doesn't take it now
  let off = false; // …because its Remote is off: Turn on, here
  let real = false; // the computer takes the gamepad as a real one (remote.pad)
  let canText = false; // the computer types characters no key there types (remote.state text: remote.text)
  let voiceOk = null; // the computer takes voice typing (its Keyboard switch; remote.state voice), null: it doesn't say (older)
  let voiceWhy = ''; // …and why not
  const keyboardOff = () => voiceOk === false && /^Keyboard is off/.test(voiceWhy);
  const voiceBlocked = () => !opts.connected || (voiceOk === null ? allowed === false : !voiceOk);
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
    clutch.clear();
    for (const code of [...held.keys()]) { held.set(code, 1); press(code, false); }
    dropMods();
    padRelease();
  }

  // ---- what the page shows ----
  function render() {
    const game = opts.mode === 'gamepad';
    const voice = opts.mode === 'voice';
    const air = opts.mode === 'air';
    const present = opts.mode === 'present';
    document.body.classList.toggle('gamepad', game);
    document.body.classList.toggle('voice', voice);
    document.body.classList.toggle('air', air);
    document.body.classList.toggle('present', present);
    document.body.classList.toggle('pad', !game && !voice && !air && !present);
    const name = opts.name, me = opts.me;
    $('name').textContent = game && opts.bt ? t('Bluetooth gamepad · {name}', { name: opts.btName || t('connected') })
      : `${game ? (real ? t('Gamepad (real)') : t('Gamepad')) : voice ? t('Voice typing') : air ? t('Air mouse') : present ? t('Presentation') : t('Touchpad')} · ${name}`;
    if (voice) voiceStatus();
    motionWant(air || present);
    const note = game && opts.bt ? ''
      : !opts.connected ? t('Not connected to {name}. Connect from TwinDesk’s Overview.', { name })
      : air && motionNone ? t('This device has no gyroscope, which the air mouse needs. Use the touchpad instead.')
      : present && motionNone ? t('This device has no gyroscope, so Hold to point doesn’t move the pointer. Next and Previous work.')
      : voice && keyboardOff() ? t('Keyboard is off on {name}: voice typing types there with it. Turn it on in TwinDesk’s Keyboard page there, or here.', { name })
      : voice && voiceOk === false ? (voiceWhy || t('Not typing on {name}.', { name }))
      : voice && voiceOk === true ? ''
      : allowed === false && off ? t('Remote is off on {name}.', { name })
      : allowed === false ? (why || t('{name} doesn’t take input from {me}. On {name}, turn on Remote in TwinDesk.', { name, me }))
        : allowed === null && (opts.os === 'mac' || opts.os === 'linux') ? t('{name} doesn’t answer the remote: update TwinDesk there.', { name })
          : '';
    $('note-text').textContent = note;
    $('note').hidden = !note;
    const turnOn = voice && voiceOk !== null ? keyboardOff() : allowed === false && off;
    $('note-on').textContent = voice && voiceOk !== null ? t('Turn on Keyboard') : t('Turn on Remote');
    $('note-on').hidden = !(note && turnOn && opts.connected);
    // A real controller: what the computer sees it as.
    const sees = !game ? ''
      : opts.bt ? t('{name} sees {me} as “TwinDesk Gamepad”, a Bluetooth game controller', { name: opts.btName || t('The computer'), me })
        : real && opts.os === 'win' ? t('Windows sees it as an Xbox 360 Controller: games take it as one (joy.cpl lists it under Game Controllers)')
          : real && opts.os === 'linux' ? t('{name} sees it as “TwinDesk Gamepad”, an Xbox 360 controller', { name })
            : real ? t('{name} sees it as a game controller', { name }) : '';
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
      ? t('It’s a real controller now: these keys are what it presses when it isn’t (Real gamepad off on the computer, not as a Bluetooth gamepad).')
      : t('What each control presses on the computer. The left stick is four keys; the right stick moves the mouse.');
  }
  $('b-map').onclick = () => { releaseAll(); editEnd(); mapFill(); $('map').hidden = false; };
  $('map-done').onclick = () => { $('map').hidden = true; };
  $('map-reset').onclick = () => TD.event('padReset');

  window.tdRecv = (m) => {
    if (m.t === 'opts') {
      if ((m.bt === true) !== (opts.bt === true)) releaseAll(); // what's held goes the old way
      opts = { ...opts, ...m };
      if (m.layout && !layoutIn) { layoutIn = true; layoutApply(m.layout); }
      if (!opts.connected && !opts.bt) { allowed = null; voiceOk = null; releaseAll(); }
      if (opts.bt || !opts.connected) canText = false; // a Bluetooth keyboard has only keys
    } else if (m.t === 'remote.state') {
      allowed = m.allowed === true;
      why = typeof m.why === 'string' ? m.why : '';
      off = m.off === true;
      canText = m.text === true && !opts.bt;
      voiceOk = typeof m.voice === 'boolean' ? m.voice : null;
      voiceWhy = typeof m.voiceWhy === 'string' ? m.voiceWhy : '';
      if (opts.mode === 'voice' ? voiceBlocked() : !allowed) releaseAll();
      if ((m.pad === true) !== real) { releaseAll(); real = m.pad === true; } // what's held goes the old way
    } else if (m.t === 'volkey') { // Android's volume keys on the presentation remote: Previous (up) and Next (down)
      if (opts.mode === 'present') slide(m.dir > 0 ? -1 : 1);
      return;
    } else return;
    render();
  };

  $('b-close').onclick = () => { releaseAll(); TD.event('close'); };
  // The computer's Remote switch, turned on from here: our out is its in (pair.sync, its pairsync.js).
  $('note-on').onclick = () => send(opts.mode === 'voice' && voiceOk !== null ? { t: 'pair.sync', key: 'keyboard', value: true } // Share Keyboard: one switch for both sides
    : { t: 'pair.sync', feature: 'remote', dir: 'out', on: true });
  // The touchpad held sideways (or upright again): the activity turns, the page follows.
  $('b-rotate').onclick = () => TD.event('rotate');
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); render(); });
  window.addEventListener('contextmenu', (e) => { if (e.target !== vbox) e.preventDefault(); }); // the voice box keeps its own (select, paste)

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
      two = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, t0: performance.now(), moved: false, n: 2 };
    } else if (two) two.n = Math.max(two.n, fingers.size); // a third finger: a middle click if it's a tap
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
      // A two-finger tap: a right click; three fingers: a middle click.
      if (!two.moved && performance.now() - two.t0 < 350) { tapKey(two.n >= 3 ? 'Mouse2' : 'Mouse1'); tick(); }
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
  // ---- voice typing: the keyboard's own dictation (Gboard's microphone, iOS Dictation) writes into
  // a real box, and the box is mirrored on the computer as it changes: the same difference as the
  // keyboard above (Backspaces for what went, then what came), so a word the dictation fixes is fixed
  // there too, letter by letter. The box keeps its words (they're what the next change is measured
  // against) until Clear, which starts afresh without touching what the computer has. ----
  const vbox = $('voice');
  let vsent = '';
  let vlast = 0;
  function voiceSync() {
    const v = vbox.value;
    let i = 0;
    while (i < vsent.length && i < v.length && vsent[i] === v[i]) i++;
    const low = (c) => /[\udc00-\udfff]/.test(c || '');
    while (i > 0 && (low(v[i]) || low(vsent[i]))) i--;
    let gone = 0;
    for (const ch of vsent.slice(i)) if (keyFor(ch) || asText(ch)) gone++;
    for (let k = 0; k < gone; k++) type('Backspace', false);
    let text = '';
    const flush = () => { if (text) send({ t: 'remote.text', text }); text = ''; };
    for (const ch of v.slice(i)) {
      const k = keyFor(ch);
      if (k) { flush(); type(k.code, k.shift); } else if (asText(ch)) { text += ch; if (text.length >= 60) flush(); }
    }
    flush();
    if (v !== vsent) { vlast = Date.now(); tick(); }
    vsent = v;
    voiceStatus();
  }
  function voiceClear() { vbox.value = ''; vsent = ''; voiceStatus(); vbox.focus(); }
  function voiceStatus() {
    const dot = $('voice-dot');
    const hint = $('voice-hint');
    if (!dot) return;
    const blocked = voiceBlocked();
    const live = !blocked && Date.now() - vlast < 1500;
    dot.className = blocked ? 'bad' : live ? 'live' : '';
    const words = vbox.value.trim() ? vbox.value.trim().split(/\s+/).length : 0;
    const name = opts.name;
    hint.textContent = blocked ? (keyboardOff() ? t('Keyboard is off on {name}', { name }) : t('Not typing on {name}', { name })) : live ? t('Typing on {name}…', { name })
      : words === 1 ? t('1 word typed on {name}', { name }) : words ? t('{count} words typed on {name}', { count: words, name })
        : t('Click where you want to type on {name}, then speak', { name });
  }
  setInterval(() => { if (opts.mode === 'voice') voiceStatus(); }, 700);
  vbox.addEventListener('input', voiceSync);
  vbox.addEventListener('compositionend', voiceSync);
  // A key the box can't send by changing: Backspace with nothing left in it goes to the computer.
  vbox.addEventListener('keydown', (e) => {
    if ((e.key === 'Backspace' || e.keyCode === 8) && !vbox.value) { e.preventDefault(); type('Backspace', false); }
  });
  const vkey = (id, fn) => {
    $(id).addEventListener('pointerdown', (e) => e.preventDefault()); // the keyboard (and its microphone) stays up
    $(id).addEventListener('click', () => { tick(); fn(); });
  };
  // Enter: sent, and the box starts afresh (a message sent, a line done).
  vkey('v-enter', () => { voiceSync(); type('Enter', false); vbox.value = ''; vsent = ''; voiceStatus(); });
  vkey('v-space', () => { vbox.setRangeText(' ', vbox.selectionStart, vbox.selectionEnd, 'end'); voiceSync(); });
  vkey('v-tab', () => type('Tab', false));
  // The last word, here and there.
  vkey('v-word', () => {
    if (!vbox.value) { press('ControlLeft', true); tapKey('Backspace'); press('ControlLeft', false); return; }
    vbox.value = vbox.value.replace(/\S*\s*$/, '');
    voiceSync();
  });
  vkey('v-clear', voiceClear);
  // Opened (the Overview's Voice typing): the box takes the keyboard straight away.
  setTimeout(() => { if (opts.mode === 'voice') { vbox.focus(); TD.event('keyboard'); } }, 250);

  // A hardware keyboard on the phone (and the soft keyboard's Backspace or Enter on an empty field):
  // its keys as they are; the field doesn't change, so nothing is sent twice.
  const keyCode = (e) => e.code || ({ Backspace: 'Backspace', Enter: 'Enter' })[e.key] || '';
  window.addEventListener('keydown', (e) => {
    if (editing || e.target === vbox) return; // typing a button's label (Edit), or into the voice box (its own changes go)
    if (!keyCode(e) || e.keyCode === 229 || e.isComposing || e.repeat) return; // composing: see input
    e.preventDefault();
    press(keyCode(e), true);
  });
  window.addEventListener('keyup', (e) => {
    if (editing || e.target === vbox) return; // typing a button's label (Edit), or into the voice box
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

  // A button: its key, or as a real gamepad's button; let go the way it was pressed. A button of
  // the person's own (Edit › + Button) presses its key either way.
  function bindButton(el) {
    const id = el.dataset.id;
    const custom = el.classList.contains('custom');
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
      pressed = custom ? (el.dataset.key || '') : asPad() ? true : padKey(id);
      el.classList.add('down');
      if (pressed === true) padButton(id, true); else press(pressed, true);
      tick();
    });
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
  for (const el of document.querySelectorAll('#game button[data-id]')) bindButton(el);

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

  // ---- editing the gamepad (Edit): move, size, hide, rename and set the key of any control; add
  // buttons of your own. The layout: {items: {id: {x, y, s, hide, label}}, custom: [{id, label, key, x, y, s, hide}]},
  // x and y the control's middle as a share of the screen (kept by Remote.kt, TD.setLayout). ----
  const UNITS = { lt: 'LT', lb: 'LB', rb: 'RB', rt: 'RT', back: t('gamepad|Back'), start: t('gamepad|Start'), ls: t('Left stick'), rs: t('Right stick'), dpad: t('D-pad'), abxy: 'A B X Y', l3: 'L3', r3: 'R3' };
  const KEYED = ['lt', 'lb', 'rb', 'rt', 'back', 'start', 'l3', 'r3']; // one button, one key
  let layout = { items: {}, custom: [] };
  let layoutIn = false; // the saved one is applied once (opts come again on every change)
  let editing = false;
  let sel = null; // the selected control's id
  const unitEl = (id) => $(`g-${id}`) || $(id) || document.querySelector(`#game [data-unit="${id}"]`);
  for (const id of Object.keys(UNITS)) {
    const el = unitEl(id);
    el.dataset.unit = id;
    el.dataset.def = el.textContent;
  }
  const isCustom = (id) => layout.custom.some((c) => c.id === id);
  const itemOf = (id) => layout.custom.find((c) => c.id === id) || (layout.items[id] = layout.items[id] || {});
  const clamp = (v) => Math.max(0.02, Math.min(0.98, v));

  function place(el, it) {
    const at = typeof it.x === 'number' && typeof it.y === 'number';
    el.style.left = at ? `${clamp(it.x) * 100}vw` : '';
    el.style.top = at ? `${clamp(it.y) * 100}vh` : '';
    el.style.right = at ? 'auto' : '';
    el.style.bottom = at ? 'auto' : '';
    const s = Number(it.s) || 1;
    el.style.transform = `${at ? 'translate(-50%, -50%) ' : ''}${s !== 1 ? `scale(${s})` : ''}`.trim();
    el.classList.toggle('off', it.hide === true);
    if (el.tagName === 'BUTTON' && !(el.id === 'dpad' || el.id === 'abxy')) el.textContent = (typeof it.label === 'string' && it.label) || el.dataset.def || '';
  }

  function makeCustom(c) {
    const el = document.createElement('button');
    el.className = 'g custom';
    el.dataset.id = c.id;
    el.dataset.unit = c.id;
    el.dataset.key = c.key || '';
    el.dataset.def = 'Btn';
    $('game').append(el);
    bindButton(el);
    place(el, c);
    return el;
  }

  function layoutApply(l) {
    for (const el of document.querySelectorAll('#game .custom')) el.remove();
    const items = l && typeof l.items === 'object' && l.items ? l.items : {};
    const custom = Array.isArray(l && l.custom) ? l.custom.filter((c) => c && typeof c.id === 'string').slice(0, 24) : [];
    layout = { items: {}, custom };
    for (const id of Object.keys(UNITS)) {
      layout.items[id] = typeof items[id] === 'object' && items[id] ? items[id] : {};
      place(unitEl(id), layout.items[id]);
    }
    for (const c of custom) makeCustom(c);
  }
  const save = () => { try { TD.setLayout(JSON.stringify(layout)); } catch (_) { /* older app */ } };

  // The bar under a selected control: its size, key, label, Hide (or Show), Delete (one of yours).
  function select(id) {
    for (const el of document.querySelectorAll('#game [data-unit].sel')) el.classList.remove('sel');
    sel = id;
    $('edit-bar').hidden = !id;
    if (!id) return;
    const el = unitEl(id);
    el.classList.add('sel');
    const it = itemOf(id);
    const custom = isCustom(id);
    $('edit-name').textContent = custom ? (it.label || t('Button')) : UNITS[id];
    $('edit-size').value = String(Number(it.s) || 1);
    const keyed = custom || KEYED.includes(id);
    $('edit-key-row').hidden = !keyed;
    $('edit-label-row').hidden = !keyed;
    if (keyed) {
      const k = $('edit-key');
      if (!k.options.length) for (const [code, name] of opts.keys || []) k.add(new Option(name, code));
      k.value = custom ? (it.key || '') : padKey(id);
      $('edit-label').value = (typeof it.label === 'string' && it.label) || el.dataset.def || '';
    }
    $('edit-hide').textContent = it.hide ? t('Show') : t('Hide');
    $('edit-del').hidden = !custom;
  }

  $('edit-size').oninput = () => {
    if (!sel) return;
    const it = itemOf(sel);
    it.s = Number($('edit-size').value) || 1;
    place(unitEl(sel), it);
  };
  $('edit-size').onchange = save;
  $('edit-key').onchange = () => {
    if (!sel) return;
    const code = $('edit-key').value;
    if (isCustom(sel)) { itemOf(sel).key = code; unitEl(sel).dataset.key = code; save(); }
    else { TD.setPad(sel, code); opts.pad = { ...opts.pad, [sel]: code }; }
  };
  $('edit-label').oninput = () => {
    if (!sel) return;
    const it = itemOf(sel);
    it.label = $('edit-label').value.slice(0, 12);
    place(unitEl(sel), it);
    if (isCustom(sel)) $('edit-name').textContent = it.label || t('Button');
  };
  $('edit-label').onchange = save;
  $('edit-hide').onclick = () => {
    if (!sel) return;
    const it = itemOf(sel);
    it.hide = !it.hide;
    place(unitEl(sel), it);
    $('edit-hide').textContent = it.hide ? t('Show') : t('Hide');
    save();
  };
  $('edit-del').onclick = () => {
    if (!sel || !isCustom(sel)) return;
    unitEl(sel).remove();
    layout.custom = layout.custom.filter((c) => c.id !== sel);
    select(null);
    save();
  };
  $('edit-add').onclick = () => {
    if (layout.custom.length >= 24) return;
    const c = { id: `c${Date.now().toString(36)}`, label: 'Btn', key: '', x: 0.5, y: 0.55, s: 1 };
    layout.custom.push(c);
    makeCustom(c);
    select(c.id);
    save();
  };
  $('edit-reset').onclick = () => {
    layoutApply({ items: {}, custom: [] });
    select(null);
    save();
  };

  function editStart() {
    releaseAll();
    $('map').hidden = true;
    editing = true;
    document.body.classList.add('editing');
    $('edit-top').hidden = false;
  }
  function editEnd() {
    if (!editing) return;
    editing = false;
    select(null);
    document.body.classList.remove('editing');
    $('edit-top').hidden = true;
    $('edit-bar').hidden = true;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }
  $('b-edit').onclick = editStart;
  $('edit-done').onclick = editEnd;

  // While editing, a touch on a control moves it (or, without moving, selects it) and presses nothing:
  // caught on its way down to the control, before the control's own handlers.
  const game = $('game');
  let drag = null; // {id, el, pid, sx, sy, cx, cy, moved}
  game.addEventListener('pointerdown', (e) => {
    if (!editing) return;
    e.stopPropagation();
    e.preventDefault();
    if (drag) return;
    const el = e.target.closest('[data-unit]');
    if (!el) return select(null);
    const r = el.getBoundingClientRect();
    drag = { id: el.dataset.unit, el, pid: e.pointerId, sx: e.clientX, sy: e.clientY, cx: r.left + r.width / 2, cy: r.top + r.height / 2, moved: false };
    try { game.setPointerCapture(e.pointerId); } catch (_) { /* gone */ }
  }, true);
  game.addEventListener('pointermove', (e) => {
    if (!editing) return;
    e.stopPropagation();
    if (!drag || e.pointerId !== drag.pid) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    const it = itemOf(drag.id);
    it.x = clamp((drag.cx + dx) / window.innerWidth);
    it.y = clamp((drag.cy + dy) / window.innerHeight);
    place(drag.el, it);
  }, true);
  const dragEnd = (e) => {
    if (!editing) return;
    e.stopPropagation();
    if (!drag || e.pointerId !== drag.pid) return;
    const d = drag;
    drag = null;
    if (d.moved) { save(); if (sel !== d.id) select(d.id); } else select(d.id);
  };
  game.addEventListener('pointerup', dragEnd, true);
  game.addEventListener('pointercancel', dragEnd, true);

  // ---- the phone's motion: how far it turned, as the pointer's move ----
  // tdMotion(ax, ay, az, ux, uy, uz): radians turned about the device's x, y and z since the last call,
  // and which way is up (a unit vector), in the device's frame (x to its right, y to its top, z out of
  // the screen); tdMotion(null): no gyroscope. Left and right is the turn about up, whichever way the
  // phone is held; up and down is the turn about the screen's horizontal (its right, made level).
  const nativeMotion = typeof TD.motion === 'function';
  const clutch = new Set(); // what holds the pointer to the phone now (the air area, a click, Hold to point)
  let motionOn = false;
  let motionNone = false; // no gyroscope here
  let motionSeen = false; // a reading came
  let motionAt = 0;
  let airDx = 0, airDy = 0; // the last smoothed move
  let turnPx = 0; // how far the pointer went while the air area was held (a tap moves it hardly at all)
  let up = [0, 0, 1];
  const AIR = 1100; // pixels a radian at speed 1, turned slowly; up to 2.4× turned fast
  function screenAngle() {
    const a = screen.orientation && typeof screen.orientation.angle === 'number' ? screen.orientation.angle : Number(window.orientation) || 0;
    return ((a % 360) + 360) % 360;
  }
  window.tdMotion = (ax, ay, az, ux, uy, uz) => {
    if (ax == null) { if (!motionNone) { motionNone = true; render(); } return; }
    if (!motionSeen) { motionSeen = true; if (motionNone) { motionNone = false; render(); } }
    if (ux != null) up = [ux, uy, uz];
    const now = performance.now();
    const dt = Math.max(0.004, Math.min(0.1, (now - motionAt) / 1000));
    motionAt = now;
    if (!clutch.size) { airDx = airDy = 0; return; }
    const [x, y, z] = up;
    const yaw = ax * x + ay * y + az * z; // + turning left
    const r = screenAngle() * Math.PI / 180;
    const rx = Math.cos(r), ry = -Math.sin(r); // the screen's right, in the device's frame
    const d = rx * x + ry * y;
    const hx = rx - d * x, hy = ry - d * y, hz = -d * z;
    const n = Math.hypot(hx, hy, hz);
    const pitch = n > 0.3 ? (ax * hx + ay * hy + az * hz) / n : ax * rx + ay * ry; // + the far end going up
    const rate = Math.hypot(yaw, pitch) / dt; // radians a second
    if (rate < 0.02) return; // a still hand: the sensor's own noise
    const soft = rate < 0.07 ? (rate - 0.02) / 0.05 : 1; // fine aim eases in
    const g = soft * opts.speed * AIR * (1 + Math.min(1.4, rate / 2.5));
    turnPx += Math.hypot(yaw, pitch) * g;
    // Smoothed by how fast it turns: a slow aim is steadied (the hand's tremor), a quick flick
    // passes almost as it is, so the pointer doesn't lag behind it.
    const k = Math.min(0.9, 0.3 + rate / 3);
    airDx += (-yaw * g - airDx) * k;
    airDy += (-pitch * g - airDy) * k;
    move(airDx, airDy);
  };

  // In a browser: rotationRate (degrees a second about z, x, y as alpha, beta, gamma) and the tilt
  // (beta, gamma) for which way is up. An iPhone asks first, from a tap (Allow motion).
  let webAt = 0;
  let webAsk = null;
  const onDM = (e) => {
    const r = e.rotationRate;
    if (!r || r.alpha == null) return;
    const t = e.timeStamp || performance.now();
    const dt = webAt ? Math.min(0.1, Math.max(0, (t - webAt) / 1000)) : 0;
    webAt = t;
    if (!dt) return;
    const k = (Math.PI / 180) * dt;
    window.tdMotion((r.beta || 0) * k, (r.gamma || 0) * k, (r.alpha || 0) * k);
  };
  const onDO = (e) => {
    if (e.beta == null || e.gamma == null) return;
    const b = (e.beta * Math.PI) / 180, g = (e.gamma * Math.PI) / 180;
    up = [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
  };
  function webStart() {
    webAt = 0;
    window.addEventListener('devicemotion', onDM);
    window.addEventListener('deviceorientation', onDO);
    clearTimeout(webAsk);
    webAsk = setTimeout(() => { // nothing came: it asks first (iPhone), or there's no gyroscope
      if (motionSeen || !motionOn) return;
      const DM = window.DeviceMotionEvent;
      if (DM && typeof DM.requestPermission === 'function') askMotion();
      else if (!motionNone) { motionNone = true; render(); }
    }, 900);
  }
  function webStop() {
    clearTimeout(webAsk);
    window.removeEventListener('devicemotion', onDM);
    window.removeEventListener('deviceorientation', onDO);
  }
  function askMotion() {
    $('motion-ask-text').textContent = t('The air mouse turns the pointer as you turn this device. Allow it to read the device’s motion.');
    $('motion-ask').hidden = false;
  }
  $('motion-ok').onclick = async () => {
    $('motion-ask').hidden = true;
    try {
      const a = await window.DeviceMotionEvent.requestPermission();
      if (window.DeviceOrientationEvent && typeof window.DeviceOrientationEvent.requestPermission === 'function') await window.DeviceOrientationEvent.requestPermission().catch(() => {});
      if (a !== 'granted') { motionNone = true; render(); return; }
    } catch (_) { /* asked again on the next open */ }
    if (motionOn) { webStop(); webStart(); }
  };

  function motionWant(on) {
    on = on && !document.hidden;
    if (on === motionOn) return;
    motionOn = on;
    motionAt = performance.now();
    if (nativeMotion) { try { TD.motion(on); } catch (_) { /* older app */ } } else if (on) webStart(); else webStop();
    if (!on) { clutch.clear(); $('motion-ask').hidden = true; try { unlock(); } catch (_) { /* not set up yet */ } }
  }

  // Held, the pointer follows the phone; let go, it stays where it is. It takes hold only after
  // `wait` ms with the finger still down, so a tap (onUp with tap = true) never moves the pointer.
  function hold(el, key, onUp, wait = 0) {
    let id = null, t0 = 0, timer = 0, on = false;
    const grab = () => { timer = 0; if (id == null) return; on = true; turnPx = 0; motionAt = performance.now(); clutch.add(key); el.classList.add('live'); };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (id != null) return;
      id = e.pointerId;
      try { el.setPointerCapture(id); } catch (_) { /* gone */ }
      t0 = performance.now();
      on = false;
      if (wait > 0) { el.classList.add('touch'); timer = setTimeout(grab, wait); } else grab();
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      clearTimeout(timer); timer = 0;
      clutch.delete(key);
      el.classList.remove('live', 'touch');
      if (onUp && e.type === 'pointerup') onUp(performance.now() - t0, !on);
      on = false;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // ---- air mouse ----
  // The big area: a tap clicks where the pointer is; held a moment, the pointer follows the phone.
  // Left click: a tap clicks; held, it locks down (a drag: hold the big area and point to select),
  // and a tap on it or on the big area lets go. Right click: a tap. The buttons never move the pointer.
  const AIR_WAIT = 180;
  let leftLocked = false;
  const unlock = () => { if (!leftLocked) return false; leftLocked = false; press('Mouse0', false); $('a-left').classList.remove('on'); render(); return true; };
  hold($('air'), 'air', (ms, tap) => { if (tap && ms < TAP_MS) { if (!unlock()) tapKey('Mouse0'); tick(); } }, AIR_WAIT);
  (() => {
    const el = $('a-left');
    let id = null, timer = 0, locked = false;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (id != null) return;
      id = e.pointerId;
      try { el.setPointerCapture(id); } catch (_) { /* gone */ }
      el.classList.add('down');
      locked = false;
      if (!leftLocked) timer = setTimeout(() => { timer = 0; locked = true; leftLocked = true; press('Mouse0', true); el.classList.add('on'); tick(); render(); }, HOLD_MS);
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      el.classList.remove('down');
      clearTimeout(timer); timer = 0;
      if (e.type !== 'pointerup' || locked) return;
      if (!unlock()) tapKey('Mouse0');
      tick();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  })();
  $('a-right').addEventListener('pointerdown', (e) => { e.preventDefault(); $('a-right').classList.add('down'); });
  $('a-right').addEventListener('pointerup', () => { $('a-right').classList.remove('down'); tapKey('Mouse1'); tick(); });
  $('a-right').addEventListener('pointercancel', () => $('a-right').classList.remove('down'));
  // The strip: slide to scroll (the page follows the finger, as on the touchpad).
  (() => {
    const w = $('air-wheel');
    let id = null, ly = 0;
    w.addEventListener('pointerdown', (e) => { e.preventDefault(); if (id != null) return; id = e.pointerId; ly = e.clientY; try { w.setPointerCapture(id); } catch (_) { /* gone */ } w.classList.add('live'); });
    w.addEventListener('pointermove', (e) => { if (e.pointerId !== id) return; scroll(0, (ly - e.clientY) * 3); ly = e.clientY; });
    const end = (e) => { if (e.pointerId === id) { id = null; w.classList.remove('live'); } };
    w.addEventListener('pointerup', end);
    w.addEventListener('pointercancel', end);
  })();

  // ---- presentation remote ----
  // Start: F5 (PowerPoint, LibreOffice Impress); on a Mac ⌥⌘P (Keynote's Play).
  let timerFrom = 0; // when the talk started (the timer), 0: not started
  function timerShow() {
    const el = $('p-timer');
    const s = timerFrom ? Math.floor((Date.now() - timerFrom) / 1000) : 0;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    el.textContent = `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(sec).padStart(2, '0')}`;
    el.classList.toggle('idle', !timerFrom);
  }
  const timerGo = () => { if (!timerFrom) { timerFrom = Date.now(); timerShow(); } };
  setInterval(() => { if (opts.mode === 'present' && timerFrom) timerShow(); }, 1000);
  $('p-timer').onclick = () => { timerFrom = 0; timerShow(); tick(); }; // tap: back to 0:00
  function slide(dir) {
    timerGo();
    tapKey(dir > 0 ? 'PageDown' : 'PageUp');
    tick();
  }
  function combo(mods, code) {
    for (const m of mods) press(m, true);
    tapKey(code);
    for (const m of [...mods].reverse()) press(m, false);
  }
  const pkey = (id, fn) => $(id).addEventListener('click', () => { tick(); fn(); });
  pkey('p-start', () => { timerGo(); if (opts.os === 'mac') combo(['MetaLeft', 'AltLeft'], 'KeyP'); else tapKey('F5'); });
  pkey('p-black', () => tapKey('KeyB'));
  pkey('p-exit', () => tapKey('Escape'));
  for (const [id, dir] of [['p-next', 1], ['p-prev', -1]]) {
    const b = $(id);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.classList.add('down'); slide(dir); });
    const up = () => b.classList.remove('down');
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  }
  hold($('p-point'), 'point');
  // Laser (on unless turned off; kept on this device): while pointing, the computer shows a red dot
  // that follows the pointer (remote.laser), gone again when the finger lifts.
  let laser = true;
  try { laser = localStorage.getItem('remote.laser') !== '0'; } catch (_) { /* default */ }
  let lasing = false;
  const laserTo = (on) => { if (on === lasing) return; lasing = on; send({ t: 'remote.laser', on }); };
  const laserShow = () => { $('p-laser').classList.toggle('on', laser); $('p-point').textContent = laser ? t('Hold to point the laser') : t('Hold to point'); };
  $('p-laser').addEventListener('click', () => {
    laser = !laser;
    try { localStorage.setItem('remote.laser', laser ? '1' : '0'); } catch (_) { /* this session */ }
    laserShow();
    tick();
  });
  laserShow();
  $('p-point').addEventListener('pointerdown', () => { $('p-point').classList.add('down'); TD.haptic(); if (laser) laserTo(true); });
  for (const ev of ['pointerup', 'pointercancel']) $('p-point').addEventListener(ev, () => { $('p-point').classList.remove('down'); laserTo(false); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) laserTo(false); });
  timerShow();

  render();
  TD.ready();
})();

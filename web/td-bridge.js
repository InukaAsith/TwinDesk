// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Stands in for the TwinDesk phone app inside its own screen viewer and remote pages
// (android/app/src/main/assets/web: viewer.html, remote.html), which TwinDesk Web shows in a frame:
// what they ask the app (window.TD) goes to the page around them (window.parent.TDHost), and what the
// app would tell them (window.tdRecv) comes from it. Loaded before their own script.
'use strict';

(() => {
  const host = () => (window.parent !== window && window.parent.TDHost) || null;
  const kind = /remote/.test(location.pathname) ? 'remote' : 'viewer';
  // A tap felt: Android vibrates; an iPhone has no vibrate for pages, but toggling a switch
  // (<input type=checkbox switch>, Safari 18) taps its haptic engine, inside the touch that asked.
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  function haptic() {
    try {
      if (navigator.vibrate && !IOS) return void navigator.vibrate(8);
      if (!IOS) return;
      const label = document.createElement('label');
      label.setAttribute('aria-hidden', 'true');
      label.style.display = 'none';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      label.append(input);
      document.head.append(label);
      label.click();
      label.remove();
    } catch (_) {}
  }
  const call = (fn, ...a) => { const h = host(); if (h && typeof h[fn] === 'function') return h[fn](kind, ...a); };
  window.TD = {
    send: (json) => call('send', json),
    ready: () => call('ready', window),
    event: (name) => call('event', name),
    playing: (w, h) => call('playing', w, h),
    setPad: (id, code) => call('setPad', id, code),
    pad() {}, // a Bluetooth gamepad: only the Android app
    tick() {},
    haptic: () => haptic(),
  };
  // iOS plays sound only after a touch: the first one on the page starts it (and a pill asks for it).
  if (kind === 'viewer') {
    const pill = document.createElement('button');
    pill.id = 'td-sound';
    pill.textContent = '🔊 Tap for sound';
    pill.hidden = true;
    const kick = () => {
      const a = document.getElementById('audio');
      if (a && a.srcObject && !a.muted) a.play().then(() => { pill.hidden = true; }, () => {});
    };
    pill.onclick = kick;
    addEventListener('pointerdown', kick, true);
    addEventListener('DOMContentLoaded', () => document.body.append(pill));
    setInterval(() => {
      const a = document.getElementById('audio');
      pill.hidden = !(a && a.srcObject && !a.muted && a.paused);
    }, 1000);
  }
})();

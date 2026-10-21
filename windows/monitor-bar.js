// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Monitor 2 toolbar, as on the Mac's viewer: top centre, in when the pointer reaches the top edge.
// The other computer's Extend/Mirror and Stop (its screen.state: usable when it lets us), frame
// generation and full screen here. The pointer on it stays here: never sent to the other computer.
(function () {
  const api = window.monitor;
  const bar = document.getElementById('bar');
  const btn = (id) => document.getElementById(id);
  const EDGE_PX = 48;
  const HIDE_MS = 2000;

  // r = null: not told (an older app), only what works here.
  api.onRemote((r) => {
    const can = !!(r && r.remote && r.on);
    let modes = 0;
    for (const m of ['extend', 'mirror']) {
      const b = btn('b-' + m);
      b.hidden = !(r && (r.modes || []).includes(m));
      b.disabled = !can;
      b.classList.toggle('on', !!(r && r.on && r.mode === m));
      if (!b.hidden) modes++;
    }
    btn('sep-mode').hidden = !modes;
    btn('b-stop').hidden = btn('sep-stop').hidden = !(r && r.on);
    btn('b-stop').disabled = !can;
  });
  api.onPacing((p) => btn('b-fg').classList.toggle('on', !!(p && p.framegen)));

  btn('b-extend').onclick = () => api.ctl({ mode: 'extend' });
  btn('b-mirror').onclick = () => api.ctl({ mode: 'mirror' });
  btn('b-stop').onclick = () => api.ctl({ share: false });
  btn('b-fg').onclick = () => api.ctl({ framegen: !btn('b-fg').classList.contains('on') });
  btn('b-full').onclick = () => api.ctl({ fullScreen: true });

  let timer = null;
  function later() {
    clearTimeout(timer);
    timer = setTimeout(() => !bar.matches(':hover') && bar.classList.remove('show'), HIDE_MS);
  }
  // Not while a button is held (a drag over there that reaches the top).
  window.addEventListener('mousemove', (e) => {
    if (e.buttons || e.clientY > EDGE_PX) return;
    bar.classList.add('show');
    later();
  });
  bar.addEventListener('mouseleave', later);
  // monitor-input.js listens on the window; ups go through (a drag that started over there ends there).
  for (const ev of ['mousedown', 'mousemove', 'wheel']) bar.addEventListener(ev, (e) => e.stopPropagation());
  bar.addEventListener('mousedown', (e) => e.preventDefault()); // no focus: keys keep going over
})();

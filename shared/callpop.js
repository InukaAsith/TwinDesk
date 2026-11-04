// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The call window (callwin.js): ringing — who, Answer and Decline; in a call — the time, Mute,
// where the sound is (this computer or the phone, over Bluetooth) and End; then "Call ended".
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const i18n = window.PlayerI18n;
  const SVG = 'http://www.w3.org/2000/svg';
  const ICONS = {
    answer: 'M6 3l2.5 0 1.2 3.2-1.7 1.3a9 9 0 0 0 4.5 4.5l1.3-1.7L17 13.5V16a1 1 0 0 1-1 1A13 13 0 0 1 3 4a1 1 0 0 1 1-1z',
    end: 'M2.5 11.5c4.5-4 10.5-4 15 0l-1.8 2.3-3-1.2v-2a8 8 0 0 0-5.4 0v2l-3 1.2z',
    mute: 'M10 3a2 2 0 0 1 2 2v5a2 2 0 0 1-4 0V5a2 2 0 0 1 2-2z M5.5 9.5a4.5 4.5 0 0 0 9 0 M10 14v3',
    muted: 'M10 3a2 2 0 0 1 2 2v5a2 2 0 0 1-4 0V5a2 2 0 0 1 2-2z M5.5 9.5a4.5 4.5 0 0 0 9 0 M10 14v3 M3.5 3.5l13 13',
    here: 'M3 4h14v9H3z M7 17h6 M10 13v4',
    phone: 'M6.5 2.5h7a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z M9 15h2',
    silence: 'M4 8h3l4-3.5v11L7 12H4z M13.5 8l4 4 M17.5 8l-4 4',
    hold: 'M7 4.5v11 M13 4.5v11',
    resume: 'M6.5 4.5v11l9-5.5z',
  };
  const icon = (name) => {
    const s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 20 20');
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', ICONS[name]);
    s.append(p);
    return s;
  };
  const set = (b, name, title) => {
    if (b.dataset.icon !== name) { b.replaceChildren(icon(name)); b.dataset.icon = name; }
    b.title = i18n.t(title);
    b.setAttribute('aria-label', i18n.t(title));
  };
  set($('answer'), 'answer', 'Answer');
  set($('decline'), 'end', 'Decline');
  set($('end'), 'end', 'End');

  let st = null;
  const time = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function render() {
    const c = st && st.call;
    const e = st && st.ended;
    const show = c || e;
    if (!show) return;
    if (show.name || show.number) i18n.literal($('who'), show.name || show.number);
    else i18n.text($('who'), 'Unknown number');
    const a = $('avatar');
    if (show.photo) { a.style.backgroundImage = `url("${show.photo}")`; a.textContent = ''; } else { a.style.backgroundImage = ''; a.textContent = (show.name || '#').trim().charAt(0).toUpperCase(); }
    const bt = st.audio && st.audio.state === 'ready';
    if (!c) i18n.text($('sub'), e.missed ? 'Missed call' : 'Call ended');
    else if (c.state === 'ringing') {
      if (show.name && show.number) i18n.text($('sub'), 'Incoming · {number}', { number: show.number });
      else i18n.text($('sub'), st.phone ? 'Incoming call on {phone}' : 'Incoming call', { phone: st.phone });
    } else i18n.text($('sub'), c.dir === 'out' ? 'Calling · {time}' : 'On a call · {time}', { time: time(Date.now() - c.since) }); // where the sound is: the button says
    document.body.classList.toggle('missed', !c && !!e.missed);
    $('answer').hidden = !c || c.state !== 'ringing';
    $('decline').hidden = !c || c.state !== 'ringing';
    $('end').hidden = !c || c.state === 'ringing';
    $('mute').hidden = !c || c.state === 'ringing';
    const can = (c && c.can) || [];
    $('silence').hidden = !c || c.state !== 'ringing' || !can.includes('silence') || !!c.silenced;
    set($('silence'), 'silence', 'Silence');
    $('hold').hidden = !c || c.state === 'ringing' || !can.includes('hold');
    if (c) set($('hold'), c.held ? 'resume' : 'hold', c.held ? 'Resume' : 'Hold');
    $('hold').classList.toggle('on', !!(c && c.held));
    set($('mute'), st.muted ? 'muted' : 'mute', st.muted ? 'Unmute' : 'Mute');
    $('mute').classList.toggle('on', !!st.muted);
    $('where').hidden = !c || c.state === 'ringing' || !bt || st.audio.canMove === false;
    if (bt) set($('where'), st.audio.here ? 'phone' : 'here', st.audio.here ? 'Move the sound to the phone' : 'Move the sound here');
  }

  $('answer').onclick = () => window.callpop.act({ do: 'call', a: 'answer' });
  $('decline').onclick = () => window.callpop.act({ do: 'call', a: 'end' });
  $('end').onclick = () => window.callpop.act({ do: 'call', a: 'end' });
  $('silence').onclick = () => window.callpop.act({ do: 'call', a: 'silence' });
  $('hold').onclick = () => window.callpop.act({ do: 'call', a: 'hold', on: !(st && st.call && st.call.held) });
  $('mute').onclick = () => window.callpop.act({ do: 'call', a: 'mute', on: !(st && st.muted) });
  $('where').onclick = () => window.callpop.act({ do: 'audio', a: st && st.audio && st.audio.here ? 'phone' : 'here' });
  $('close').onclick = () => window.callpop.close();
  document.querySelector('.cp-text').onclick = () => window.callpop.open();

  window.callpop.onState((s) => { st = s; render(); });
  window.callpop.state().then((s) => { st = s; render(); });
  i18n.onChange(render);
  setInterval(() => st && st.call && st.call.state !== 'ringing' && render(), 1000); // the timer
})();

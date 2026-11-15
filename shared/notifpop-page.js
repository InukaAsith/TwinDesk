// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A notification window (notifpop.js): the phone's notification with its picture, progress, Copy
// for a one-time code, its own buttons and Reply. Clicking the text opens it (as clicking a system
// notification does); × only closes this window, "Clear" also clears it on the phone.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.notifpop;
  const i18n = window.PlayerI18n;
  const t = (k, v) => (i18n ? i18n.t(k, v) : k);
  let st = null;
  let replying = false;

  const initial = (s) => { const c = String(s || '').trim(); return /^[+\d]/.test(c) || !c ? '#' : c.charAt(0).toUpperCase(); };
  const clock = (at) => {
    const s = Math.round((Date.now() - at) / 1000);
    if (s < 60) return t('now');
    return new Date(at).toLocaleTimeString(i18n ? i18n.locale : [], { hour: 'numeric', minute: '2-digit' });
  };
  const button = (label, fn, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'npop-btn' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  };

  function render() {
    if (!st) return;
    $('icon').style.backgroundImage = st.icon ? `url("${st.icon}")` : '';
    $('icon').classList.toggle('none', !st.icon);
    $('app').textContent = [st.app, st.from].filter(Boolean).join(' · ');
    $('time').textContent = clock(st.at);
    const av = $('avatar');
    av.hidden = !st.avatar;
    if (st.avatar) av.style.backgroundImage = `url("${st.avatar}")`;
    $('title').textContent = st.title;
    $('body').textContent = [st.subtitle, st.body].filter(Boolean).join('\n');
    $('body').hidden = !$('body').textContent;
    const pic = $('pic');
    pic.hidden = !st.pic;
    if (st.pic && pic.getAttribute('src') !== st.pic) pic.src = st.pic;
    // The progress bar: filled to v of max, or moving with no known end; full once done.
    const l = st.live;
    $('live').hidden = !l;
    if (l) {
      const k = l.done ? 1 : l.max > 0 ? l.v / l.max : 0;
      $('live').classList.toggle('ind', !!l.ind && !l.done);
      $('fill').style.width = l.ind && !l.done ? '' : (k * 100).toFixed(1) + '%';
      $('pct').textContent = l.done ? t('Done') : l.ind ? '' : Math.round(k * 100) + '%';
    }
    const row = $('buttons');
    const btns = [];
    if (st.code) {
      const copy = button(t('Copy {code}', { code: st.code }), () => {
        api.copy();
        copy.textContent = t('Copied');
        copy.classList.add('done');
      }, 'primary');
      btns.push(copy);
    }
    st.actions.forEach((a, i) => btns.push(button(a, () => api.act(i))));
    if (st.reply) btns.push(button(t('Reply'), () => openReply(), st.code ? '' : 'primary'));
    row.replaceChildren(...btns);
    row.hidden = !btns.length || replying;
    $('replyRow').hidden = !replying;
    size();
  }

  function openReply() {
    replying = true;
    render();
    api.typing();
    setTimeout(() => $('replyBox').focus(), 30);
  }

  const size = () => requestAnimationFrame(() => api.size(Math.ceil($('card').getBoundingClientRect().height) + 2));

  $('replyRow').onsubmit = (e) => {
    e.preventDefault();
    const text = $('replyBox').value.trim();
    if (text) api.reply(text);
  };
  $('replyBox').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { replying = false; render(); }
  });
  $('main').onclick = () => api.open();
  $('x').onclick = (e) => { e.stopPropagation(); api.close(); };
  $('x').oncontextmenu = (e) => { e.preventDefault(); api.dismiss(); }; // right click: clear it on the phone too
  document.addEventListener('mouseenter', () => api.hover(true));
  document.addEventListener('mouseleave', () => api.hover(false));
  $('pic').onload = size;
  if (i18n) { i18n.translate(document.body); i18n.onChange(() => { i18n.translate(document.body); render(); }); }
  api.onState((s) => { st = s; render(); });
  api.get().then((s) => { if (s) { st = s; render(); } });
  setInterval(() => st && ($('time').textContent = clock(st.at)), 30000);
})();

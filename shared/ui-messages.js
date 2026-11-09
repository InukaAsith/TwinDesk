// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Messages page (Mac, PC and Linux): the phone's conversations on the left, one on the right with
// its texts and pictures, and a box to answer (the phone sends it). New messages come as they
// arrive while Messages is on; their alerts are the phone's own notifications (Notifications).
// A picture goes with a text (Attach, dropped or pasted): an MMS from phones that say
// messages.mms, which also answer group conversations; in a chat app, through the phone (chat.pic).
'use strict';

(() => {
  const tr = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);

// A picture picked here as a JPEG data: URL, at most 1600 px and about 4 MB (the phone makes it
// fit the carrier's MMS limit). On white: a transparent PNG's clear parts don't turn black.
const shrink = (file) => new Promise((resolve, reject) => {
  if (!file || !/^image\//.test(file.type || '')) return reject(new Error('not a picture'));
  const r = new FileReader();
  r.onerror = () => reject(new Error('unreadable'));
  r.onload = () => {
    const img = new Image();
    img.onerror = () => reject(new Error('unreadable'));
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      let q = 0.85;
      let d = c.toDataURL('image/jpeg', q);
      while (d.length > 4500000 && q > 0.4) { q -= 0.15; d = c.toDataURL('image/jpeg', q); }
      resolve(d);
    };
    img.src = String(r.result);
  };
  r.readAsDataURL(file);
});
const imageOf = (list) => [...(list || [])].find((f) => f && /^image\//.test(f.type || ''));

// A compose row's picture: the Attach button, the picture waiting to go (with ×), and drops and
// pastes onto `zone`. enabled(): whether a picture can go to this conversation now.
function attacher({ el, button }, zone, box, enabled) {
  let data = '';
  const input = el('input', { type: 'file', attrs: { accept: 'image/*', hidden: '' } });
  const thumb = el('img', { class: 'hub-attach-img', alt: '' });
  const remove = el('button', { class: 'hub-attach-x', text: '×', attrs: { 'aria-label': tr('Remove picture') } });
  const chip = el('div', { class: 'hub-attach' }, [thumb, remove]);
  chip.hidden = true;
  const btn = button('+', () => input.click(), 'small');
  btn.classList.add('hub-attach-btn');
  btn.title = tr('Attach a picture');
  btn.setAttribute('aria-label', tr('Attach a picture'));
  const set = (d) => { data = d || ''; thumb.src = data; chip.hidden = !data; };
  const take = (file) => {
    if (!file || !enabled()) return;
    shrink(file).then((d) => { set(d); box.focus(); }).catch(() => {});
  };
  input.onchange = () => { take(imageOf(input.files)); input.value = ''; };
  remove.onclick = () => set('');
  zone.addEventListener('dragover', (e) => { if (enabled() && [...(e.dataTransfer.items || [])].some((i) => /^image\//.test(i.type))) { e.preventDefault(); zone.classList.add('hub-drop'); } });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('hub-drop'); });
  zone.addEventListener('drop', (e) => { zone.classList.remove('hub-drop'); const f = imageOf(e.dataTransfer.files); if (f && enabled()) { e.preventDefault(); take(f); } });
  box.addEventListener('paste', (e) => { const f = imageOf(e.clipboardData && e.clipboardData.files); if (f && enabled()) { e.preventDefault(); take(f); } });
  return { btn, chip, input, get: () => data, clear: () => set(''), show(on) { btn.hidden = !on; if (!on) set(''); } };
}

UI.tab({
  id: 'messages',
  group: 'Phone',
  order: 6,
  title: tr('Messages'),
  icon: 'message',
  color: 'linear-gradient(#64d2ff, #0a84ff)',
  desc: tr('Read and send your phone’s texts here.'),
  for: ['android'], // iOS gives no app its calls or texts (shared/ui-kinds.js)
  master: { get: (s) => !!(s.hub && s.hub.messages), set: (v) => UI.api.hub({ do: 'set', what: 'messages', on: v }) },
  badge: (s) => (s.hub && s.hub.messages ? (s.hub.unread ? String(s.hub.unread) : 'on') : ''),
  build(body, page) {
    const { el, api } = UI;
    const top = UI.hubTop('messages');
    const list = el('div', { class: 'hub-threads' });
    const newBtn = UI.button(tr('New message'), () => openNew(), 'small');
    const head = el('div', { class: 'hub-conv-head', attrs: { 'data-literal': '' } });
    const scroll = el('div', { class: 'hub-conv-scroll' });
    const more = UI.button(tr('Earlier messages'), () => loadThread(openId, true), 'small');
    const bubbles = el('div', { class: 'hub-bubbles', attrs: { 'data-literal': '' } });
    scroll.append(more, bubbles);
    const to = el('input', { type: 'text', class: 'hub-input hub-to', placeholder: tr('To: a number'), spellcheck: false, attrs: { 'aria-label': tr('To') } });
    const box = el('textarea', { class: 'hub-compose', rows: 1, placeholder: tr('Text message'), attrs: { 'aria-label': tr('Message') } });
    const send = UI.button(tr('Send'), () => sendNow(), 'primary');
    const groupNote = el('div', { class: 'hint hub-group-note', text: tr('Answer group conversations on the phone.') });
    // Two SIMs or more on the phone: which one the text goes out on ('' is the phone's default).
    const simPick = UI.select([{ value: '', label: tr('Default SIM') }], () => {});
    simPick.el.setAttribute('aria-label', tr('SIM'));
    simPick.el.hidden = true;
    const conv = el('div', { class: 'hub-conv' });
    const mmsOk = () => !!(UI.state && UI.state.hub && UI.state.hub.perm && UI.state.hub.perm.messages && UI.state.hub.perm.messages.mms);
    const pic = attacher(UI, conv, box, () => mmsOk() && !box.disabled);
    const compose = el('div', { class: 'hub-compose-row' }, [simPick.el, pic.btn, el('div', { class: 'hub-compose-col' }, [pic.chip, box]), send, pic.input]);
    conv.append(head, scroll, groupNote, compose);
    const empty = el('div', { class: 'hub-empty hub-conv-empty', text: tr('Choose a conversation') });
    const layout = el('div', { class: 'card hub-msgs' }, [el('div', { class: 'hub-side' }, [el('div', { class: 'hub-side-head' }, [newBtn]), list]), conv, empty]);
    // ---- chat apps in one inbox (the switch here, settings.ui.chats): pills on top ----
    // Texts are the phone's SMS and MMS (above); the chat apps are their conversations as the phone
    // sends them (s.chats: shared/chats.js), kept here, or with an older phone their notifications
    // (Notifications on). Answered with their own Reply (notif.reply). All: everything.
    const CHAT = [['all', tr('All')], ['texts', tr('Texts')], ['whatsapp', 'WhatsApp'], ['instagram', 'Instagram'], ['telegram', 'Telegram'], ['messenger', 'Messenger'], ['signal', 'Signal'], ['other', tr('Other apps')]];
    const OPTIONAL = ['messenger', 'signal', 'other']; // their pill only once one of their chats is here
    const appOf = (pkg) => (/^com\.whatsapp/.test(pkg) ? 'whatsapp' : /^(?:org\.telegram|org\.thunderdog\.challegram)/.test(pkg) ? 'telegram' : /^com\.instagram/.test(pkg) ? 'instagram'
      : pkg === 'com.facebook.orca' ? 'messenger' : pkg === 'org.thoughtcrime.securesms' ? 'signal'
      : pkg === 'com.google.android.apps.messaging' || pkg === 'com.samsung.android.messaging' ? 'rcs' : '');
    const APP_NAME = { whatsapp: 'WhatsApp', telegram: 'Telegram', instagram: 'Instagram', messenger: 'Messenger', signal: 'Signal', rcs: tr('Messages (RCS)') };
    let pill = 'texts';
    const pills = el('div', { class: 'msg-pills', attrs: { role: 'tablist' } });
    const pillBtns = CHAT.map(([id, label]) => {
      const b = el('button', { class: 'msg-pill', text: label, attrs: { role: 'tab' } });
      b.onclick = () => { pill = id; chatOpen = ''; chatKey = ''; paintChats(UI.state); if (UI.state) layout.hidden = pill !== 'texts' || !UI.hubReady(UI.state, 'messages'); };
      pills.append(b);
      return [id, b];
    });
    const chatsSw = UI.switch((v) => api.setChats && api.setChats(v), { label: tr('Chat apps in Messages') });
    const chatsRow = UI.row(tr('Chat apps in Messages'), tr('WhatsApp, Instagram, Telegram and Messenger next to your texts. Reply from here.'), [chatsSw]);
    const chatsCard = UI.card('', [chatsRow]);
    chatsCard.hidden = !api.setChats;
    const chatList = el('div', { class: 'hub-threads' });
    const chatHead = el('div', { class: 'hub-conv-head', attrs: { 'data-literal': '' } });
    const chatScroll = el('div', { class: 'hub-conv-scroll' });
    const chatBubbles = el('div', { class: 'hub-bubbles', attrs: { 'data-literal': '' } });
    chatScroll.append(chatBubbles);
    const chatBox = el('textarea', { class: 'hub-compose', rows: 1, placeholder: tr('Reply'), attrs: { 'aria-label': tr('Reply') } });
    const chatSend = UI.button(tr('Send'), () => chatReply(), 'primary');
    chatBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatReply(); } });
    const chatNote = el('div', { class: 'hint hub-group-note' });
    const chatConv = el('div', { class: 'hub-conv' });
    const chatPicOk = () => { const t = chatThreads(UI.state).find((x) => x.key === chatOpen); return !!(t && t.msgs && t.pic); };
    const chatPic = attacher(UI, chatConv, chatBox, chatPicOk);
    const chatCompose = el('div', { class: 'hub-compose-row' }, [chatPic.btn, el('div', { class: 'hub-compose-col' }, [chatPic.chip, chatBox]), chatSend, chatPic.input]);
    chatConv.append(chatHead, chatScroll, chatNote, chatCompose);
    const chatEmpty = el('div', { class: 'hub-empty hub-conv-empty', text: tr('Choose a conversation') });
    const chatLayout = el('div', { class: 'card hub-msgs' }, [el('div', { class: 'hub-side' }, [chatList]), chatConv, chatEmpty]);
    let chatOpen = ''; // app|title
    let chatKey = '';
    // The conversations: the phone's own (s.chats), else from the notifications, one per app and
    // title (the sender or the group).
    const synced = (s) => !!(s && Array.isArray(s.chats));
    function chatThreads(s) {
      const own = synced(s) ? s.chats.map((c) => ({ key: c.key, app: appOf(c.app) || 'other', name: appOf(c.app) ? c.name || c.appName : [c.name, c.appName].filter(Boolean).join(' · '), group: !!c.group, reply: !!c.reply, pic: !!c.pic, at: c.at, msgs: c.items || [] })) : [];
      const by = new Map();
      for (const h of ((s && s.notifs) || {}).history || []) {
        const app = appOf(h.app);
        if (!app || (synced(s) && app !== 'rcs')) continue; // synced: only RCS from notifications
        const key = app + '|' + (h.title || h.appName);
        const t = by.get(key) || { key, app, name: h.title || h.appName, items: [], at: 0 };
        t.items.push(h);
        t.at = Math.max(t.at, h.at);
        by.set(key, t);
      }
      return own.concat([...by.values()]).sort((a, b) => b.at - a.at);
    }
    function chatReply() {
      const t = chatThreads(UI.state).find((x) => x.key === chatOpen);
      const text = chatBox.value.trim();
      const image = chatPic.get();
      if (t && t.msgs && t.pic && image && api.notifReply) {
        api.notifReply({ chat: t.key, text, image });
        chatBox.value = '';
        chatPic.clear();
        return;
      }
      if (!t || !text || !api.notifReply) return;
      if (t.msgs) {
        if (!t.reply) return;
        api.notifReply({ chat: t.key, text });
      } else {
        const last = t.items.find((h) => h.reply);
        if (!last) return;
        api.notifReply({ id: last.id, text });
      }
      chatBox.value = '';
    }
    const threadRow = (name, at, snippet, active, onClick) => {
      const b = el('button', { class: `hub-thread${active ? ' active' : ''}`, attrs: { 'data-literal': '' } }, [UI.avatar(name), el('span', { class: 'hub-thread-text' }, [
        el('span', { class: 'hub-thread-top' }, [el('span', { class: 'hub-thread-name', text: name }), el('span', { class: 'hub-thread-time', text: UI.clock(at) })]),
        el('span', { class: 'hub-thread-snippet', text: snippet }),
      ])]);
      b.onclick = onClick;
      return b;
    };
    function paintChats(s) {
      if (!s) return;
      const on = !!(s.ui && s.ui.chats);
      chatsSw.set(on);
      pills.hidden = !on;
      chatsCard.hidden = on || !api.setChats;
      if (!on && pill !== 'texts') pill = 'texts';
      const all = chatThreads(s);
      for (const [id, b] of pillBtns) {
        b.classList.toggle('on', id === pill);
        b.setAttribute('aria-selected', String(id === pill));
        b.hidden = OPTIONAL.includes(id) && id !== pill && !all.some((t) => t.app === id);
      }
      chatLayout.hidden = pill === 'texts';
      if (pill === 'texts') return;
      const shown = all.filter((t) => pill === 'all' || t.app === pill);
      const sum = (t) => (t.msgs ? [t.msgs.length, t.reply, t.pic, t.msgs.map((m) => m.pic || '').join()] : [t.items.length, t.items.map((h) => (h.replies || []).length)]);
      const k = JSON.stringify([pill, chatOpen, shown.map((t) => [t.key, t.at, sum(t)]), pill === 'all' ? threads.map((t) => t.id + t.at) : 0, (s.notifs || {}).receive, synced(s)]);
      if (k === chatKey) return;
      chatKey = k;
      // The list: chats, and in All the texts too (opening one goes to Texts).
      const snippet = (t) => {
        if (!t.msgs) return t.items[0].body || '';
        const m = t.msgs[t.msgs.length - 1];
        return m ? m.me ? tr('You: {message}', { message: m.text }) : t.group && m.from ? tr('{sender}: {message}', { sender: m.from, message: m.text }) : m.text : '';
      };
      const rows = shown.map((t) => ({ at: t.at, el: threadRow(t.name, t.at, (APP_NAME[t.app] || '') + ' · ' + snippet(t), t.key === chatOpen, () => { chatOpen = t.key; paintChats(UI.state); }) }));
      if (pill === 'all') {
        for (const t of threads) {
          rows.push({ at: t.at || 0, el: threadRow(t.name || (t.addrs || []).join(', '), t.at, tr('Text · {message}', { message: t.snippet || '' }), false, () => { pill = 'texts'; paintChats(UI.state); layout.hidden = false; openThread(t.id); }) });
        }
      }
      rows.sort((a, b) => b.at - a.at);
      chatList.replaceChildren(...rows.map((r) => r.el));
      if (!rows.length) chatList.append(el('div', { class: 'hub-empty', text: !synced(s) && !(s.notifs || {}).receive ? tr('Turn on Notifications to see chats here') : tr('No chats yet. They show here as messages arrive.') }));
      const t = shown.find((x) => x.key === chatOpen);
      chatConv.hidden = !t;
      chatEmpty.hidden = !!t;
      if (!t) return;
      chatHead.replaceChildren(UI.avatar(t.name), el('div', {}, [el('div', { class: 'hub-conv-name', text: t.name }), el('div', { class: 'hint', text: t.group ? tr('{app} · Group', { app: APP_NAME[t.app] || '' }) : (APP_NAME[t.app] || '') })]));
      const msgs = [];
      let lastDay = '';
      for (const m of t.msgs || []) {
        const day = new Date(m.at).toDateString();
        if (day !== lastDay) { lastDay = day; msgs.push(el('div', { class: 'hub-day', text: UI.clock(m.at) })); }
        msgs.push(el('div', { class: `hub-bubble ${m.me ? 'out' : 'in'}`, title: new Date(m.at).toLocaleString() }, [
          t.group && !m.me && m.from ? el('div', { class: 'hub-from', text: m.from }) : null,
          m.pic ? el('div', { class: 'hub-text', text: tr('Picture') }) : null,
          m.text ? el('div', { class: 'hub-text', text: m.text }) : null,
          m.pic && m.pic !== 'sent' ? el('div', { class: 'hub-status', text: m.pic === 'sending' ? tr('Sending…') : m.pic === 'opened' ? tr('Open on the phone: tap Send there') : m.error ? tr('Not sent: {error}', { error: tr(m.error) }) : tr('Not sent') }) : null,
        ]));
      }
      for (const h of t.msgs ? [] : t.items.slice().reverse()) {
        msgs.push(el('div', { class: 'hub-bubble in' }, [el('div', { text: h.body || h.subtitle || '' }), el('div', { class: 'hub-status', text: UI.clock(h.at) })]));
        for (const r of h.replies || []) msgs.push(el('div', { class: 'hub-bubble out' }, [el('div', { text: r.text }), el('div', { class: 'hub-status', text: UI.clock(r.at) })]));
      }
      chatBubbles.replaceChildren(...msgs);
      chatScroll.scrollTop = chatScroll.scrollHeight;
      const canReply = (t.msgs ? t.reply || t.pic : t.items.some((h) => h.reply)) && !!api.notifReply;
      chatCompose.hidden = !canReply;
      chatNote.hidden = canReply;
      chatPic.show(!!(t.msgs && t.pic));
      chatNote.textContent = t.msgs ? tr('Reply here once the phone shows this chat’s notification again.') : tr('Answer this one on the phone: its notification has no Reply.');
    }

    body.append(top.el, pills, layout, chatLayout, chatsCard); // the messages first, the setting under them
    chatLayout.hidden = true;

    let threads = [];
    let openId = null; // the conversation shown ('' = a new one)
    let items = []; // its messages, oldest first
    let hasMore = false;
    const parts = new Map(); // MMS picture id -> data: URL
    let pending = []; // sent from here, not yet seen in the phone's store: {ref, body, at, status}
    let refCount = 0;

    const thread = () => threads.find((t) => t.id === openId);

    function renderList() {
      list.replaceChildren(...threads.map((t) => {
        const b = el('button', { class: `hub-thread${t.id === openId ? ' active' : ''}${t.unread ? ' unread' : ''}`, attrs: { 'data-literal': '' } }, [
          UI.avatar(t.name),
          el('span', { class: 'hub-thread-text' }, [
            el('span', { class: 'hub-thread-top' }, [el('span', { class: 'hub-thread-name', text: t.name || (t.addrs || []).join(', ') }), el('span', { class: 'hub-thread-time', text: UI.clock(t.at) })]),
            el('span', { class: 'hub-thread-snippet', text: t.snippet || '' }),
          ]),
        ]);
        b.onclick = () => openThread(t.id);
        return b;
      }));
      if (!threads.length) list.append(el('div', { class: 'hub-empty', text: tr('No conversations') }));
    }

    function renderConv() {
      const t = thread();
      const isNew = openId === '';
      conv.hidden = openId === null;
      empty.hidden = openId !== null;
      to.hidden = !isNew;
      head.replaceChildren(...(isNew ? [to] : t ? [el('div', { class: 'hub-conv-name', text: t.name || t.addrs.join(', ') }), el('div', { class: 'hint', text: t.name ? t.addrs.join(', ') : '' })] : []));
      const group = !!(t && t.addrs && t.addrs.length > 1);
      groupNote.hidden = !group || mmsOk(); // a phone that sends MMS answers groups too
      pic.show(mmsOk());
      const sims = (UI.state && UI.state.hub && UI.state.hub.perm && UI.state.hub.perm.messages && UI.state.hub.perm.messages.sims) || [];
      simPick.options([{ value: '', label: tr('Default SIM') }, ...sims.map((x) => ({ value: String(x.id), label: x.label }))]);
      simPick.el.hidden = sims.length < 2;
      compose.hidden = group && !mmsOk();
      more.hidden = !hasMore || isNew;
      const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
      const shown = items.concat(pending.filter((p) => p.thread === openId).map((p) => ({ id: p.ref, body: p.body, at: p.at, out: true, status: p.status, error: p.error, image: p.image })));
      let lastDay = '';
      const nodes = [];
      for (const m of shown) {
        const day = new Date(m.at).toDateString();
        if (day !== lastDay) { lastDay = day; nodes.push(el('div', { class: 'hub-day', text: UI.clock(m.at) })); }
        const pics = m.image ? [el('img', { class: 'hub-pic', alt: '', src: m.image })] : (m.parts || []).map((p) => {
          const img = el('img', { class: 'hub-pic', alt: '' });
          if (parts.has(p.id)) img.src = parts.get(p.id);
          else { parts.set(p.id, ''); UI.hubAsk({ t: 'sms.part', id: p.id }); }
          img.dataset.part = p.id;
          return img;
        });
        nodes.push(el('div', { class: `hub-bubble ${m.out ? 'out' : 'in'}${m.status === 'failed' ? ' failed' : ''}`, title: new Date(m.at).toLocaleString() }, [
          group && !m.out && (m.fromName || m.from) ? el('div', { class: 'hub-from', text: m.fromName || m.from }) : null,
          ...pics,
          m.body ? el('div', { class: 'hub-text', text: m.body }) : null,
          m.status ? el('div', { class: 'hub-status', text: m.status === 'sending' ? tr('Sending…') : m.status === 'failed' ? m.error ? tr('Not sent: {error}', { error: tr(m.error) }) : tr('Not sent') : '' }) : null,
        ]));
      }
      bubbles.replaceChildren(...nodes);
      if (atBottom || loadingFirst) scroll.scrollTop = scroll.scrollHeight;
      loadingFirst = false;
    }

    let loadingFirst = false;
    function openThread(id) {
      openId = id;
      items = [];
      hasMore = false;
      loadingFirst = true;
      renderList();
      renderConv();
      loadThread(id, false);
      box.focus();
    }

    function openNew() {
      openId = '';
      items = [];
      hasMore = false;
      renderList();
      renderConv();
      to.value = '';
      to.focus();
    }

    function loadThread(id, earlier) {
      if (!id) return;
      UI.hubAsk({ t: 'sms.thread', id, before: earlier && items.length ? items[0].at : 0, n: 50 });
    }

    function sendNow() {
      const text = box.value.trim();
      const image = pic.get();
      if (!text && !image) return;
      const t = thread();
      // Everyone in it: a group conversation, or numbers typed with commas (MMS only).
      const addrs = openId === '' ? to.value.split(/[,;]/).map((x) => x.trim()).filter(Boolean) : (t && t.addrs) || [];
      const dest = addrs[0];
      if (!dest) return to.focus();
      if ((addrs.length > 1 || image) && !mmsOk()) return;
      const ref = `r${Date.now()}-${refCount++}`;
      pending.push({ ref, body: text, at: Date.now(), status: 'sending', thread: openId, to: dest, image });
      const sim = simPick.el.hidden || simPick.el.value === '' ? undefined : Number(simPick.el.value);
      UI.hubAsk({ t: 'sms.send', to: dest, body: text, ref, sim, ...(addrs.length > 1 ? { addrs: addrs.slice(0, 20) } : {}), ...(image ? { image } : {}) });
      box.value = '';
      pic.clear();
      autosize();
      renderConv();
      scroll.scrollTop = scroll.scrollHeight;
    }

    const autosize = () => { box.style.height = 'auto'; box.style.height = `${Math.min(140, box.scrollHeight)}px`; };
    box.oninput = autosize;
    box.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendNow(); }
    };

    UI.hubOn('sms.threads', (m) => {
      threads = (m.items || []).filter((t) => t && t.id);
      renderList();
      if (openId) renderConv();
    });
    UI.hubOn('sms.thread', (m) => {
      if (m.id !== openId) return;
      const older = (m.items || []).slice().reverse();
      const before = Number(m.before) || 0;
      if (before) {
        const h = scroll.scrollHeight;
        items = older.concat(items);
        hasMore = !!m.more;
        renderConv();
        scroll.scrollTop = scroll.scrollHeight - h; // stay where you were reading
      } else {
        items = older;
        hasMore = !!m.more;
        loadingFirst = true;
        renderConv();
      }
    });
    UI.hubOn('sms.part', (m) => {
      if (!m.data) return;
      parts.set(m.id, m.data);
      for (const img of bubbles.querySelectorAll('img[data-part]')) if (img.dataset.part === m.id) img.src = m.data;
    });
    UI.hubOn('sms.sent', (m) => {
      const p = pending.find((x) => x.ref === m.ref);
      if (!p) return;
      if (m.ok) p.status = 'sent';
      else { p.status = 'failed'; p.error = m.error || ''; }
      // A new conversation: the phone's store has it now.
      if (p.thread === '' && m.ok) setTimeout(() => UI.hubAsk({ t: 'sms.threads', n: 80 }), 800);
      if (openId === p.thread) renderConv();
    });
    let threadsTimer = 0;
    // The phone's copy of one sent from here: the same text, and a picture if it had one.
    const sameAs = (p, msg) => p.body.trim() === String(msg.body || '').trim() && !!p.image === !!(msg.parts && msg.parts.length);
    UI.hubOn('sms.new', (m) => {
      const msg = m.msg || {};
      if (m.thread === openId && !items.some((x) => x.id === msg.id)) {
        if (msg.out) {
          const i = pending.findIndex((p) => p.thread === openId && sameAs(p, msg) && p.status !== 'failed');
          if (i >= 0) pending.splice(i, 1);
        }
        items.push(msg);
        renderConv();
      }
      if (openId === '' && msg.out) { // the new conversation we just started
        const p = pending.find((x) => x.thread === '' && sameAs(x, msg));
        if (p) { pending = pending.filter((x) => x !== p); openId = m.thread; loadThread(openId, false); }
      }
      clearTimeout(threadsTimer);
      threadsTimer = setTimeout(() => UI.hubAsk({ t: 'sms.threads', n: 80 }), 400);
      if (!page.hidden) api.hub({ do: 'seen' });
    });

    let loaded = false;
    let loadedAt = 0;
    const load = () => {
      loaded = true;
      if (Date.now() - loadedAt < 2000) return; // shown and rendered at once: asked once
      loadedAt = Date.now();
      UI.hubAsk({ t: 'sms.threads', n: 80 });
      if (openId) loadThread(openId, false);
    };
    UI.onShown(page, (shown) => {
      if (!shown) return;
      api.hub({ do: 'seen' });
      if (UI.hubReady(UI.state, 'messages')) load();
    });
    renderList();
    renderConv();
    UI.onDeviceChange(() => { // another device: its conversations, not the previous one's
      threads = [];
      openId = null;
      items = [];
      hasMore = false;
      pending = [];
      pic.clear();
      chatPic.clear();
      loaded = false;
      loadedAt = 0;
      renderList();
      renderConv();
      if (!page.hidden && UI.hubReady(UI.state, 'messages')) load();
    });

    return (s) => {
      top.render(s);
      paintChats(s);
      const ready = UI.hubReady(s, 'messages');
      layout.hidden = !ready || pill !== 'texts';
      if (!ready) { loaded = false; return; }
      if (!loaded) load();
      const canSend = !(s.hub.perm.messages.missing || []).includes('send');
      send.disabled = !canSend;
      box.disabled = !canSend;
      box.placeholder = canSend ? tr('Text message') : tr('Allow sending on the phone to answer here');
    };
  },
});

})();

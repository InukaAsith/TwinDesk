// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Messages page (Mac, PC and Linux): the phone's conversations on the left, one on the right with
// its texts and pictures, and a box to answer (the phone sends it). New messages come as they
// arrive while Messages is on; their alerts are the phone's own notifications (Notifications).
'use strict';

UI.tab({
  id: 'messages',
  group: 'Phone',
  order: 6,
  title: 'Messages',
  icon: 'message',
  color: 'linear-gradient(#64d2ff, #0a84ff)',
  desc: 'Read and send your phone’s texts here.',
  hidden: (s) => !UI.isPhone(s), // only while a phone is connected
  master: { get: (s) => !!(s.hub && s.hub.messages), set: (v) => UI.api.hub({ do: 'set', what: 'messages', on: v }) },
  badge: (s) => (s.hub && s.hub.messages ? (s.hub.unread ? String(s.hub.unread) : 'on') : ''),
  build(body, page) {
    const { el, api } = UI;
    const top = UI.hubTop('messages');
    const list = el('div', { class: 'hub-threads' });
    const newBtn = UI.button('New message', () => openNew(), 'small');
    const head = el('div', { class: 'hub-conv-head' });
    const scroll = el('div', { class: 'hub-conv-scroll' });
    const more = UI.button('Earlier messages', () => loadThread(openId, true), 'small');
    const bubbles = el('div', { class: 'hub-bubbles' });
    scroll.append(more, bubbles);
    const to = el('input', { type: 'text', class: 'hub-input hub-to', placeholder: 'To: a number', spellcheck: false, attrs: { 'aria-label': 'To' } });
    const box = el('textarea', { class: 'hub-compose', rows: 1, placeholder: 'Text message', attrs: { 'aria-label': 'Message' } });
    const send = UI.button('Send', () => sendNow(), 'primary');
    const groupNote = el('div', { class: 'hint hub-group-note', text: 'Answer group conversations on the phone.' });
    const compose = el('div', { class: 'hub-compose-row' }, [box, send]);
    const conv = el('div', { class: 'hub-conv' }, [head, scroll, groupNote, compose]);
    const empty = el('div', { class: 'hub-empty hub-conv-empty', text: 'Choose a conversation' });
    const layout = el('div', { class: 'card hub-msgs' }, [el('div', { class: 'hub-side' }, [el('div', { class: 'hub-side-head' }, [newBtn]), list]), conv, empty]);
    body.append(top.el, layout);

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
        const b = el('button', { class: `hub-thread${t.id === openId ? ' active' : ''}${t.unread ? ' unread' : ''}` }, [
          UI.avatar(t.name),
          el('span', { class: 'hub-thread-text' }, [
            el('span', { class: 'hub-thread-top' }, [el('span', { class: 'hub-thread-name', text: t.name || (t.addrs || []).join(', ') }), el('span', { class: 'hub-thread-time', text: UI.clock(t.at) })]),
            el('span', { class: 'hub-thread-snippet', text: t.snippet || '' }),
          ]),
        ]);
        b.onclick = () => openThread(t.id);
        return b;
      }));
      if (!threads.length) list.append(el('div', { class: 'hub-empty', text: 'No conversations' }));
    }

    function renderConv() {
      const t = thread();
      const isNew = openId === '';
      conv.hidden = openId === null;
      empty.hidden = openId !== null;
      to.hidden = !isNew;
      head.replaceChildren(...(isNew ? [to] : t ? [el('div', { class: 'hub-conv-name', text: t.name || t.addrs.join(', ') }), el('div', { class: 'hint', text: t.name ? t.addrs.join(', ') : '' })] : []));
      const group = !!(t && t.addrs && t.addrs.length > 1);
      groupNote.hidden = !group;
      compose.hidden = group;
      more.hidden = !hasMore || isNew;
      const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
      const shown = items.concat(pending.filter((p) => p.thread === openId).map((p) => ({ id: p.ref, body: p.body, at: p.at, out: true, status: p.status })));
      let lastDay = '';
      const nodes = [];
      for (const m of shown) {
        const day = new Date(m.at).toDateString();
        if (day !== lastDay) { lastDay = day; nodes.push(el('div', { class: 'hub-day', text: UI.clock(m.at) })); }
        const pics = (m.parts || []).map((p) => {
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
          m.status ? el('div', { class: 'hub-status', text: m.status === 'sending' ? 'Sending…' : m.status === 'failed' ? `Not sent${m.error ? `: ${m.error}` : ''}` : '' }) : null,
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
      if (!text) return;
      const t = thread();
      const dest = openId === '' ? to.value.trim() : t && t.addrs && t.addrs[0];
      if (!dest) return to.focus();
      const ref = `r${Date.now()}-${refCount++}`;
      pending.push({ ref, body: text, at: Date.now(), status: 'sending', thread: openId, to: dest });
      UI.hubAsk({ t: 'sms.send', to: dest, body: text, ref });
      box.value = '';
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
    UI.hubOn('sms.new', (m) => {
      const msg = m.msg || {};
      if (m.thread === openId && !items.some((x) => x.id === msg.id)) {
        if (msg.out) {
          const i = pending.findIndex((p) => p.thread === openId && p.body.trim() === String(msg.body || '').trim() && p.status !== 'failed');
          if (i >= 0) pending.splice(i, 1);
        }
        items.push(msg);
        renderConv();
      }
      if (openId === '' && msg.out) { // the new conversation we just started
        const p = pending.find((x) => x.thread === '' && x.body.trim() === String(msg.body || '').trim());
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
      loaded = false;
      loadedAt = 0;
      renderList();
      renderConv();
      if (!page.hidden && UI.hubReady(UI.state, 'messages')) load();
    });

    return (s) => {
      top.render(s);
      const ready = UI.hubReady(s, 'messages');
      layout.hidden = !ready;
      if (!ready) { loaded = false; return; }
      if (!loaded) load();
      const canSend = !(s.hub.perm.messages.missing || []).includes('send');
      send.disabled = !canSend;
      box.disabled = !canSend;
      box.placeholder = canSend ? 'Text message' : 'Allow sending on the phone to answer here';
    };
  },
});

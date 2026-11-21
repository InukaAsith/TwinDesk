// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Activity (Windows and Linux, one-to-one and Multi-device): clipboard, notifications, files and
// calls already in this window's state, newest first. Nothing is fetched. Kept history is opened
// only when this page is actually on screen (the same rule as shared/ui-history.js).
// The Mac page is mac/ui-timeline.js (Show in Finder). This one says Explorer or the file manager.
'use strict';

UI.tab({
  id: 'activity',
  group: 'Share',
  order: 39,
  icon: 'activity',
  title: I18n.t('Activity'),
  desc: I18n.t('Clipboard, notifications, files and calls, newest first.'),
  color: 'linear-gradient(#bf5af2, #5e5ce6)',
  build(body, page) {
    const TL = window.TDTimeline;
    const { el, api } = UI;
    const t = (s, v) => I18n.t(s, v);
    const asked = { clip: false, notifs: false };
    let category = 'all';
    let query = '';
    let lastKey = '';

    const search = el('input', {
      type: 'search', class: 'tl-search',
      attrs: { placeholder: t('Search activity'), 'aria-label': t('Search activity'), autocomplete: 'off', spellcheck: 'false' },
    });
    const chips = {};
    const CATS = [['all', 'All'], ['clip', 'Clipboard'], ['notif', 'Notifications'], ['file', 'Files'], ['call', 'Calls']];
    const chipRow = el('div', { class: 'tl-chips', attrs: { role: 'radiogroup', 'aria-label': t('Activity') } });
    for (const [id, label] of CATS) {
      const count = el('span', { class: 'tl-count', attrs: { 'data-literal': '' }, text: '0' });
      const b = el('button', { type: 'button', attrs: { role: 'radio', 'aria-checked': id === 'all' ? 'true' : 'false' } }, [
        el('span', { text: t(label) }), ' ', count,
      ]);
      b.onclick = () => { category = id; paint(); };
      chips[id] = { b, count };
      chipRow.append(b);
    }
    const bar = el('div', { class: 'tl-bar' }, [search, chipRow]);
    const list = el('div', { class: 'history tl-list' });
    const empty = el('div', { class: 'tl-empty', text: t('No activity yet') });
    body.append(UI.card('', [bar, list, empty]));

    // oninput, not a listener added later: a state push never rebuilds this input, so the caret stays.
    search.oninput = () => {
      query = search.value;
      paint();
    };

    const KIND = { clip: 'Clipboard', notif: 'Notifications', file: 'Files', call: 'Calls' };
    const CALL = { in: 'Incoming', out: 'Outgoing', missed: 'Missed', rejected: 'Declined', blocked: 'Blocked', voicemail: 'Voicemail', ringing: 'Incoming', offhook: 'On a call' };
    // Windows Explorer, otherwise the file manager. Never a path in the label.
    const revealLabel = () => {
      const p = (typeof navigator !== 'undefined' && navigator.platform) || '';
      return /Win/.test(p) ? 'Show in Explorer' : 'Show in folder';
    };

    function shown() {
      return !!(page && page.isConnected && page.hidden === false && page.offsetParent !== null);
    }

    // Keep history: the keychain is read only while this page is open, once a session.
    function maybeUnlock(s) {
      const h = s && s.history;
      if (!h || h.save !== true) { asked.clip = false; asked.notifs = false; return; }
      if (!h.open || !shown()) return;
      for (const what of ['clip', 'notifs']) {
        if (h.open[what] || asked[what]) continue;
        asked[what] = true;
        if (api && typeof api.history === 'function') api.history({ do: 'unlock', what });
      }
    }

    function titleOf(it) {
      const m = it.meta || {};
      if (it.kind === 'clip' && m.image) {
        const label = t(m.shot ? 'Screenshot' : 'Picture');
        return m.w && m.h ? `${label} · ${m.w} × ${m.h}` : label;
      }
      if (it.kind === 'clip' && m.blank) return t('(whitespace)');
      if (it.kind === 'file' && !it.title && m.files) return t(m.files === 1 ? '{count} file' : '{count} files', { count: m.files });
      if (it.kind === 'call' && !it.title) return t('Unknown number');
      if (it.kind === 'notif') return [it.title, it.subtitle, it.body].filter(Boolean).join(' — ');
      return it.title || it.body || it.subtitle || '';
    }

    function literalTitle(it) {
      const m = it.meta || {};
      if (it.kind === 'clip') return !(m.image || m.blank);
      if (it.kind === 'file') return !!(it.title || (!m.files && (it.body || it.subtitle)));
      if (it.kind === 'call') return !!it.title;
      return true;
    }

    function extraLabel(it) {
      const m = it.meta || {};
      if (it.kind === 'call') {
        if (m.live && m.dir === 'out') return t('Calling');
        if (m.live) return t(m.type === 'ringing' ? 'Incoming' : 'On a call');
        if (m.missed || m.type === 'missed') return t('Missed');
        if (CALL[m.type]) return t(CALL[m.type]);
        if (m.dir === 'out') return t('Outgoing');
        if (m.dir === 'in') return t('Incoming');
        return '';
      }
      if (it.kind === 'file') {
        if (m.waiting) return t(m.state === 'paused' ? 'Paused' : 'Waiting to send');
        if (m.ok === false) return t('Failed');
        if (m.dir === 'out') return t('Sent');
        return '';
      }
      if (m.dir === 'out') return t('Sent');
      return '';
    }

    function literalDetail(it) {
      const m = it.meta || {};
      if (it.kind === 'file') return it.path || it.subtitle || it.peer || (m.ok === false ? it.body : '');
      if (it.kind === 'call') return it.body && it.body !== it.title ? it.body : '';
      if (it.peer && it.peer !== it.title) return it.peer;
      return '';
    }

    function copyItem(it) {
      if (!api) return;
      const m = it.meta || {};
      if (it.kind === 'clip' && typeof api.copyHistory === 'function' && UI.state && UI.state.clipboard && Array.isArray(UI.state.clipboard.history)) {
        const hist = UI.state.clipboard.history;
        const i = hist.findIndex((h) => h && h.at === it.at && (m.image ? !!h.image : typeof h.text === 'string' && (h.text === it.copyText || (it.copyText && h.text.startsWith(it.copyText.slice(0, 48))))));
        if (i >= 0 && (!m.image || m.copy !== false)) { api.copyHistory(i); return; }
      }
      const text = it.copyText;
      if (typeof text !== 'string' || !text) return;
      if (typeof api.copyLiteral === 'function') api.copyLiteral(text);
      else if (typeof api.copyText === 'function' && text.length < 200) api.copyText(text);
    }

    function row(it) {
      const m = it.meta || {};
      const title = titleOf(it);
      const titleEl = el('div', { class: 'hist-preview selectable', text: title });
      if (literalTitle(it)) titleEl.setAttribute('data-literal', '');
      const bits = [el('span', { text: t(KIND[it.kind] || 'Activity') })];
      const extra = extraLabel(it);
      if (extra) bits.push(el('span', { text: ' · ' + extra }));
      const detail = literalDetail(it);
      if (detail) bits.push(el('span', { attrs: { 'data-literal': '' }, text: ' · ' + detail }));
      const when = typeof UI.ago === 'function' ? UI.ago(it.at) : '';
      if (when) bits.push(el('span', { text: ' · ' + when }));
      const canCopy = it.kind !== 'file' && ((it.kind === 'clip' && m.image && m.copy !== false) || (typeof it.copyText === 'string' && it.copyText.length > 0));
      const canReveal = it.kind === 'file' && !!it.path && m.dir === 'in' && m.ok !== false;
      return el('div', { class: 'hist-item' }, [
        el('span', { class: `tl-kind ${it.kind}`, attrs: { 'aria-hidden': 'true' } }, [UI.icon(it.kind === 'notif' ? 'bell' : it.kind === 'call' ? 'call' : it.kind === 'file' ? 'files' : 'clipboard')]),
        el('div', { class: 'hist-text' }, [titleEl, el('div', { class: 'hint' }, bits)]),
        canCopy ? UI.button(t('Copy'), () => copyItem(it), 'small') : null,
        canReveal ? UI.button(t(revealLabel()), () => TL.revealItem(it, UI.state, api), 'small') : null,
      ]);
    }

    function paint() {
      if (!TL) return;
      const items = TL.build(UI.state || {});
      const c = TL.counts(items, query.trim());
      for (const [id] of CATS) {
        chips[id].count.textContent = String(c[id] || 0);
        chips[id].b.classList.toggle('on', id === category);
        chips[id].b.setAttribute('aria-checked', id === category ? 'true' : 'false');
      }
      const q = query.trim();
      const shownItems = TL.filter(items, { category, query: q }).slice(0, 400);
      const key = category + '\n' + q + '\n' + shownItems.map((it) => it.id + ':' + it.at + ':' + ((it.meta && it.meta.state) || '')).join('|') + '\n' + Math.floor(Date.now() / 15000);
      const none = !shownItems.length;
      empty.hidden = !none;
      list.hidden = none;
      if (none) empty.textContent = !q && category === 'all' && !items.length ? t('No activity yet') : t('No matching items');
      if (key === lastKey) return;
      lastKey = key;
      list.replaceChildren(...shownItems.map(row));
    }

    paint();
    return (s) => {
      UI.state = s;
      maybeUnlock(s);
      paint();
    };
  },
});

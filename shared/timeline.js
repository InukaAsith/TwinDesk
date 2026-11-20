// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Activity timeline (Mac): one chronological list from state the control window already has.
// No protocol, no disk, no network. Clipboard, notifications, files and calls are normalized,
// deduped and filtered here so the page and the tests share one result.
// CommonJS in tests, a plain <script> in renderers (window.TDTimeline).
'use strict';

(function () {
  const KINDS = ['clip', 'notif', 'file', 'call'];
  const PREVIEW = 180; // one line in the list
  const BODY = 400;
  const COPY = 8000; // what Copy puts on the clipboard, still bounded
  const PATH = 1024;
  const PER_SOURCE = 500;

  function str(v, max) {
    let s;
    if (typeof v === 'string') s = v;
    else if (typeof v === 'number' && Number.isFinite(v)) s = String(v);
    else if (typeof v === 'boolean') s = v ? 'true' : 'false';
    else return '';
    if (max && s.length > max) s = s.slice(0, max);
    return s;
  }

  // Missing, negative, or non-finite times sort as oldest (0). Never throws.
  function atOf(v) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n;
  }

  function oneLine(v, max) {
    return str(v, max || PREVIEW).replace(/\s+/g, ' ').trim().slice(0, max || PREVIEW);
  }

  function baseName(p) {
    const s = str(p, PATH);
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function finite(v) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function metaOf(m) {
    const out = {};
    if (!m || typeof m !== 'object' || Array.isArray(m)) return out;
    for (const [k, v] of Object.entries(m)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,20}$/.test(k)) continue;
      if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
      else if (typeof v === 'string') out[k] = v.length > 200 ? v.slice(0, 200) : v;
    }
    return out;
  }

  // Strings are copied through unchanged apart from the length cap (no HTML parsing).
  function item(partial) {
    const kind = KINDS.includes(partial.kind) ? partial.kind : 'clip';
    const at = atOf(partial.at);
    const title = oneLine(partial.title, PREVIEW);
    const subtitle = oneLine(partial.subtitle, PREVIEW);
    const body = oneLine(partial.body, BODY);
    const peer = oneLine(partial.peer, 200);
    const path = str(partial.path, PATH);
    const copyText = str(partial.copyText, COPY);
    const id = str(partial.id, 300) || `${kind}:${at}:${title.slice(0, 40)}`;
    return { id, kind, at, title, subtitle, body, peer, path, copyText, meta: metaOf(partial.meta) };
  }

  function useful(it) {
    if (!it) return false;
    if (it.title || it.subtitle || it.body || it.path || it.peer || it.copyText) return true;
    const m = it.meta;
    return !!(m.image || m.file || m.waiting || m.live || m.missed || m.files);
  }

  function take(list, fn, out) {
    if (!Array.isArray(list)) return;
    const n = Math.min(list.length, PER_SOURCE);
    for (let i = 0; i < n; i++) {
      let it;
      try { it = fn(list[i], i); } catch (_) { it = null; }
      if (useful(it)) out.push(it);
    }
  }

  function fromClip(h, i) {
    if (!h || typeof h !== 'object') return null;
    const at = atOf(h.at);
    const dir = h.dir === 'out' || h.dir === 'in' ? h.dir : '';
    const peer = h.from || h.peer || '';
    const image = h.image && typeof h.image === 'object' ? h.image : null;
    if (image) {
      return item({
        id: `clip:image:${at}:${i}:${finite(image.w)}x${finite(image.h)}:${image.shot ? 1 : 0}`,
        kind: 'clip', at, title: '', peer, copyText: '',
        meta: { image: true, shot: !!image.shot, w: finite(image.w), h: finite(image.h), copy: image.copy !== false, dir },
      });
    }
    const file = h.file && typeof h.file === 'object' ? h.file : null;
    const text = typeof h.text === 'string' ? h.text : (typeof h.text === 'number' || typeof h.text === 'boolean' ? String(h.text) : '');
    const path = str((file && file.path) || (typeof h.path === 'string' ? h.path : ''), PATH);
    if (file || (path && !text)) {
      const name = (file && file.name) || baseName(path) || text;
      return item({
        id: `clip:file:${at}:${i}:${oneLine(name, 80)}`,
        kind: 'clip', at, title: name, path, peer, copyText: text || name,
        meta: { file: true, dir },
      });
    }
    return item({
      id: `clip:${dir}:${at}:${i}:${text.slice(0, 48)}`,
      kind: 'clip', at, title: text.trim() ? text : '', peer,
      copyText: text.length > COPY ? text.slice(0, COPY) : text,
      meta: { blank: !String(text).trim(), dir },
    });
  }

  function fromNotif(n, i) {
    if (!n || typeof n !== 'object') return null;
    const at = atOf(n.at);
    const title = typeof n.title === 'string' ? n.title : '';
    const subtitle = typeof n.subtitle === 'string' ? n.subtitle : '';
    const body = typeof n.body === 'string' ? n.body : '';
    const idRaw = typeof n.id === 'string' || typeof n.id === 'number' ? String(n.id) : '';
    return item({
      id: idRaw ? `notif:${idRaw}` : `notif:${at}:${i}`,
      kind: 'notif', at, title, subtitle, body,
      peer: n.appName || n.app || n.peer || '',
      copyText: [title, subtitle, body].filter(Boolean).join('\n'),
    });
  }

  function fromFile(r, dir, i, waiting) {
    if (!r || typeof r !== 'object') return null;
    const at = atOf(r.at);
    const name = typeof r.name === 'string' ? r.name : '';
    const path = dir === 'in' && typeof r.path === 'string' ? r.path : '';
    const title = name || (path ? baseName(path) : '');
    const where = typeof r.where === 'string' ? r.where : '';
    const files = finite(r.files);
    const id = waiting && (typeof r.id === 'string' || typeof r.id === 'number')
      ? `file:wait:${String(r.id).slice(0, 80)}`
      : `file:${dir}:${at}:${name}:${path}`;
    return item({
      id, kind: 'file', at, title, subtitle: where, body: typeof r.error === 'string' ? r.error : '',
      peer: r.peerName || r.from || r.peer || '', path, copyText: '',
      meta: {
        dir, ok: r.ok !== false, waiting: !!waiting,
        state: typeof r.state === 'string' ? r.state : '',
        files: files ? Math.round(files) : 0,
      },
    });
  }

  function fromCall(c, i, live) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    const name = typeof c.name === 'string' ? c.name : '';
    const number = typeof c.number === 'string' ? c.number : (typeof c.number === 'number' && Number.isFinite(c.number) ? String(c.number) : '');
    const type = typeof c.type === 'string' ? c.type : (typeof c.state === 'string' ? c.state : '');
    const at = atOf(c.at != null ? c.at : c.since);
    const dir = c.dir === 'out' || c.dir === 'in' ? c.dir : '';
    const missed = c.missed === true || type === 'missed';
    const id = typeof c.id === 'string' || typeof c.id === 'number'
      ? `call:${c.id}`
      : `call:${live ? 'live' : 'log'}:${at}:${number}:${type}:${name}`;
    return item({
      id, kind: 'call', at, title: name || number, body: number && number !== (name || number) ? number : '',
      peer: name, copyText: [name, number].filter(Boolean).join('\n'),
      meta: { type, dir, missed, live: !!live, dur: finite(c.dur) },
    });
  }

  function callLists(hub) {
    const out = [];
    if (!hub || typeof hub !== 'object') return out;
    if (Array.isArray(hub.calls)) out.push(hub.calls);
    else if (hub.calls && typeof hub.calls === 'object') {
      if (Array.isArray(hub.calls.items)) out.push(hub.calls.items);
      if (Array.isArray(hub.calls.recent)) out.push(hub.calls.recent);
      if (Array.isArray(hub.calls.history)) out.push(hub.calls.history);
    }
    if (Array.isArray(hub.callLog)) out.push(hub.callLog);
    if (Array.isArray(hub.recentCalls)) out.push(hub.recentCalls);
    return out;
  }

  // state: the control-window state (only the fields already there). Missing pieces are empty.
  function fromState(state) {
    const s = state && typeof state === 'object' ? state : {};
    const out = [];
    const clip = s.clipboard && typeof s.clipboard === 'object' ? s.clipboard : {};
    const notifs = s.notifs && typeof s.notifs === 'object' ? s.notifs : {};
    const files = s.files && typeof s.files === 'object' ? s.files : {};
    const drop = s.drop && typeof s.drop === 'object' ? s.drop : {};
    const hub = s.hub && typeof s.hub === 'object' ? s.hub : {};
    take(clip.history, fromClip, out);
    take(notifs.history, fromNotif, out);
    take(notifs.active, fromNotif, out);
    take(notifs.items, fromNotif, out);
    take(files.recent, (r, i) => fromFile(r, 'in', i, false), out);
    take(drop.recent, (r, i) => fromFile(r, 'in', i, false), out);
    take(Array.isArray(s.received) ? s.received : null, (r, i) => fromFile(r, 'in', i, false), out);
    take(files.sent, (r, i) => fromFile(r, 'out', i, false), out);
    take(drop.sent, (r, i) => fromFile(r, 'out', i, false), out);
    take(files.outbox, (r, i) => fromFile(r, 'out', i, true), out);
    take(Array.isArray(s.outbox) ? s.outbox : null, (r, i) => fromFile(r, 'out', i, true), out);
    take(drop.outbox, (r, i) => fromFile(r, 'out', i, true), out);
    for (const list of callLists(hub)) take(list, (c, i) => fromCall(c, i, false), out);
    if (Array.isArray(s.calls)) take(s.calls, (c, i) => fromCall(c, i, false), out);
    if (hub.call && typeof hub.call === 'object') {
      const it = fromCall(hub.call, 0, true);
      if (useful(it)) out.push(it);
    }
    if (hub.ended && typeof hub.ended === 'object') {
      const it = fromCall(hub.ended, 0, false);
      if (useful(it)) out.push(it);
    }
    return out;
  }

  // Same id twice (a file in both files.recent and drop.recent, a notification in history and active):
  // keep the newer one, else the one seen first.
  function dedupeSort(list) {
    const best = new Map();
    (list || []).forEach((it, seq) => {
      if (!it || typeof it !== 'object') return;
      const prev = best.get(it.id);
      if (!prev || it.at > prev.at || (it.at === prev.at && seq < prev.seq)) best.set(it.id, { it, seq });
    });
    return [...best.values()].sort((a, b) => b.it.at - a.it.at || a.seq - b.seq).map((x) => x.it);
  }

  function blob(it) {
    return [it.title, it.subtitle, it.body, it.peer, it.path, baseName(it.path)].join('\n').toLowerCase();
  }

  // Every whitespace-separated token must occur, case-insensitive. Empty query matches all.
  function matchQuery(it, query) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return true;
    const hay = blob(it);
    return q.split(/\s+/).every((tok) => hay.includes(tok));
  }

  function filter(items, { category = 'all', query = '' } = {}) {
    const cat = category === 'all' || KINDS.includes(category) ? category : 'all';
    return (items || []).filter((it) => it && (cat === 'all' || it.kind === cat) && matchQuery(it, query));
  }

  function counts(items, query) {
    const c = { all: 0, clip: 0, notif: 0, file: 0, call: 0 };
    for (const it of items || []) {
      if (!it || !matchQuery(it, query)) continue;
      c.all++;
      if (c[it.kind] != null) c[it.kind]++;
    }
    return c;
  }

  function build(state) {
    return dedupeSort(fromState(state));
  }

  const API = { KINDS, PREVIEW, BODY, COPY, fromState, build, dedupeSort, filter, counts, matchQuery, atOf, str, baseName };
  if (typeof module === 'object' && module.exports) module.exports = API;
  else window.TDTimeline = API;
})();

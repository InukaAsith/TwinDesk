// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Photos page (Mac, PC and Linux): the phone's photos and videos, newest first, a page at a
// time; small pictures only for the tiles on screen; click one to see it big; Save copies the
// files here (into Downloads, as Send does). On USB, Wi-Fi or Wi-Fi Direct; over Bluetooth it says
// so and loads nothing (thumbnails there slowed everything else down).
'use strict';

UI.tab({
  id: 'media',
  group: 'Phone',
  order: 7,
  title: 'Photos',
  icon: 'photo',
  color: 'linear-gradient(#ffd60a, #ff9f0a)',
  desc: 'See your phone’s photos and videos and copy them here.',
  hidden: (s) => !UI.isPhone(s), // only while a phone is connected
  wifiOnly: true, // pictures are too big for Bluetooth: Connect with Wi-Fi Direct on top, nothing loads
  master: { get: (s) => !!(s.hub && s.hub.media), set: (v) => UI.api.hub({ do: 'set', what: 'media', on: v }) },
  badge: (s) => (s.hub && s.hub.media ? 'on' : ''),
  build(body, page) {
    const { el } = UI;
    const top = UI.hubTop('media');
    let kind = 'all';
    const filter = UI.segmented([
      { value: 'all', label: 'All' }, { value: 'photos', label: 'Photos' }, { value: 'videos', label: 'Videos' }, { value: 'screenshots', label: 'Screenshots' },
    ], (v) => { kind = v; filter.set(v); reset(); });
    filter.set(kind);
    const selectBtn = UI.button('Select', () => { selecting = !selecting; if (!selecting) chosen.clear(); paint(); }, 'small');
    const saveBtn = UI.button('Save', () => save([...chosen]), 'primary small');
    const status = el('span', { class: 'hint hub-media-status' });
    const bar = el('div', { class: 'hub-media-bar' }, [filter.el, el('span', { class: 'hub-grow' }), status, saveBtn, selectBtn]);
    const grid = el('div', { class: 'hub-grid' });
    const sentinel = el('div', { class: 'hub-sentinel' });
    const wrap = el('div', { class: 'hub-media' }, [bar, grid, sentinel]);

    // The viewer: one big, with its name and Save.
    const bigImg = el('img', { class: 'hub-big', alt: '' });
    const bigName = el('div', { class: 'hub-big-name' });
    const bigSub = el('div', { class: 'hint' });
    const prev = UI.button('‹', () => step(-1));
    const next = UI.button('›', () => step(1));
    const bigSave = UI.button('Save', () => viewing && save([viewing.id]), 'primary');
    const closeBtn = UI.button('Close', () => view(null));
    const viewer = el('div', { class: 'hub-viewer', hidden: true }, [
      el('div', { class: 'hub-viewer-stage' }, [prev, bigImg, next]),
      el('div', { class: 'hub-viewer-bar' }, [el('div', { class: 'hub-grow' }, [bigName, bigSub]), bigSave, closeBtn]),
    ]);
    body.append(top.el, wrap, viewer);

    let items = []; // {id, video, at, w, h, size, name, dur, album}
    let nextKey = '';
    let more = false;
    let asking = false;
    let selecting = false;
    const chosen = new Set();
    const thumbs = new Map(); // id -> data: URL ('' asked)
    const tiles = new Map(); // id -> tile element
    let viewing = null;

    function tile(it) {
      const img = el('img', { alt: '', draggable: false });
      if (thumbs.get(it.id)) img.src = thumbs.get(it.id);
      const t = el('button', { class: 'hub-tile', title: `${it.name}\n${new Date(it.at).toLocaleString()}` }, [img,
        it.video ? el('span', { class: 'hub-dur', text: it.dur ? UI.duration(it.dur / 1000) : 'Video' }) : null,
        el('span', { class: 'hub-check' })]);
      t.dataset.id = it.id;
      t.onclick = () => {
        if (!selecting) return view(it);
        if (chosen.has(it.id)) chosen.delete(it.id); else chosen.add(it.id);
        paint();
      };
      tiles.set(it.id, t);
      seen.observe(t);
      return t;
    }

    function paint() {
      wrap.classList.toggle('selecting', selecting);
      selectBtn.textContent = selecting ? 'Done' : 'Select';
      saveBtn.hidden = !selecting;
      saveBtn.disabled = !chosen.size;
      saveBtn.textContent = chosen.size ? `Save ${chosen.size} to ${UI.fill('{me}')}` : 'Save';
      for (const [id, t] of tiles) t.classList.toggle('chosen', chosen.has(id));
      status.textContent = items.length ? `${items.length}${more ? '+' : ''} ${kind === 'videos' ? 'videos' : kind === 'all' ? 'items' : kind}` : '';
    }

    // The tiles on screen get their pictures, those first (what scrolled past is dropped).
    const visible = new Set();
    let thumbTimer = 0;
    const seen = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.add(e.target.dataset.id); else visible.delete(e.target.dataset.id);
      }
      clearTimeout(thumbTimer);
      thumbTimer = setTimeout(() => {
        if (UI.onBle(UI.state)) return; // over Bluetooth: none
        const ids = [...visible].filter((id) => !thumbs.has(id));
        // A little ahead too: the next row or two below.
        const last = items.findIndex((x) => x.id === [...visible].pop());
        if (last >= 0) for (const x of items.slice(last + 1, last + 13)) if (!thumbs.has(x.id) && !ids.includes(x.id)) ids.push(x.id);
        for (const id of ids) thumbs.set(id, '');
        if (ids.length) UI.hubAsk({ t: 'media.thumb', ids });
      }, 120);
    }, { root: document.getElementById('content'), rootMargin: '200px 0px' });

    const end = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && more && !asking) page1();
    }, { root: document.getElementById('content'), rootMargin: '600px 0px' });
    end.observe(sentinel);

    function page1() {
      if (UI.onBle(UI.state)) return;
      asking = true;
      UI.hubAsk({ t: 'media.list', kind, before: nextKey, n: 120 });
    }

    function reset() {
      items = [];
      nextKey = '';
      more = false;
      chosen.clear();
      for (const t of tiles.values()) seen.unobserve(t);
      tiles.clear();
      visible.clear();
      grid.replaceChildren();
      paint();
      if (UI.hubReady(UI.state, 'media') && !UI.onBle(UI.state)) page1();
    }

    function save(ids) {
      if (!ids.length) return;
      UI.hubAsk({ t: 'media.save', ids });
      status.textContent = `Saving ${ids.length} to ${UI.fill('{me}')}’s Downloads…`;
      if (selecting) { selecting = false; chosen.clear(); }
      paint();
    }

    function view(it) {
      viewing = it;
      viewer.hidden = !it;
      if (!it) return;
      if (thumbs.get(it.id)) bigImg.src = thumbs.get(it.id); else bigImg.removeAttribute('src');
      bigName.textContent = it.name;
      bigSub.textContent = [new Date(it.at).toLocaleString(), it.w && it.h ? `${it.w} × ${it.h}` : '', UI.bytes(it.size || 0), it.album].filter(Boolean).join(' · ');
      if (!UI.onBle(UI.state)) UI.hubAsk({ t: 'media.view', id: it.id });
      const i = items.indexOf(it);
      prev.disabled = i <= 0;
      next.disabled = i < 0 || i >= items.length - 1;
    }

    function step(d) {
      const i = items.indexOf(viewing);
      const it = items[i + d];
      if (it) view(it);
      if (i + d >= items.length - 6 && more && !asking) page1();
    }

    document.addEventListener('keydown', (e) => {
      if (viewer.hidden || page.hidden) return;
      if (e.key === 'Escape') view(null);
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    });

    UI.hubOn('media.list', (m) => {
      if (m.kind !== kind || (m.before || '') !== nextKey) return; // an answer for an older filter
      asking = false;
      const fresh = (m.items || []).filter((x) => x && x.id && !tiles.has(x.id));
      items = items.concat(fresh);
      more = !!m.more;
      nextKey = m.next || nextKey;
      grid.append(...fresh.map(tile));
      if (!items.length) grid.replaceChildren(el('div', { class: 'hub-empty', text: kind === 'all' ? 'No photos or videos' : `No ${kind}` }));
      paint();
    });
    UI.hubOn('media.thumb', (m) => {
      if (!m.data) return;
      thumbs.set(m.id, m.data);
      const t = tiles.get(m.id);
      if (t) t.querySelector('img').src = m.data;
      if (viewing && viewing.id === m.id && !bigImg.getAttribute('src')) bigImg.src = m.data;
    });
    UI.hubOn('media.view', (m) => {
      if (!viewing || viewing.id !== m.id || !m.data) return;
      bigImg.src = m.data;
    });

    let loaded = false;
    UI.onShown(page, (shown) => {
      if (!shown) view(null);
      else if (UI.hubReady(UI.state, 'media') && !UI.onBle(UI.state) && !loaded) { loaded = true; reset(); }
    });
    paint();

    return (s) => {
      top.render(s);
      bigSave.textContent = `Save to ${UI.fill('{me}')}`;
      const ready = UI.hubReady(s, 'media') && !UI.onBle(s); // over Bluetooth: the Wi-Fi Direct note only
      wrap.hidden = !ready;
      if (!ready) { loaded = false; view(null); return; }
      if (!loaded) { loaded = true; reset(); }
    };
  },
});

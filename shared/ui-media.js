// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Photos page (Mac, PC and Linux): the phone's photos and videos, newest first, a page at a
// time; small pictures only for the tiles on screen; click one to see it big; Save copies the
// files here (into Downloads, as Send does); Remove deletes them from the phone (asks once more
// here; without All files access the phone shows Android's own confirmation too). On USB, Wi-Fi or Wi-Fi Direct; over Bluetooth it says
// so and loads nothing (thumbnails there slowed everything else down).
'use strict';

(() => {
  const tr = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);

UI.tab({
  id: 'media',
  group: 'Phone',
  order: 7,
  title: tr('Photos'),
  icon: 'photo',
  color: 'linear-gradient(#ffd60a, #ff9f0a)',
  desc: tr('See your phone’s photos and videos and copy them here.'),
  hidden: (s) => !UI.isPhone(s) || !!s.activeWebDevice, // only while a phone is connected
  wifiOnly: true, // pictures are too big for Bluetooth: Connect with Wi-Fi Direct on top, nothing loads
  master: { get: (s) => !!(s.hub && s.hub.media), set: (v) => UI.api.hub({ do: 'set', what: 'media', on: v }) },
  badge: (s) => (s.hub && s.hub.media ? 'on' : ''),
  build(body, page) {
    const { el } = UI;
    const top = UI.hubTop('media');
    let kind = 'all';
    const filter = UI.segmented([
      { value: 'all', label: tr('All') }, { value: 'photos', label: tr('Photos') }, { value: 'videos', label: tr('Videos') }, { value: 'screenshots', label: tr('Screenshots') },
    ], (v) => { kind = v; filter.set(v); reset(); });
    filter.set(kind);
    const selectBtn = UI.button(tr('Select'), () => { selecting = !selecting; if (!selecting) chosen.clear(); paint(); }, 'small');
    const saveBtn = UI.button(tr('Save'), () => save([...chosen]), 'primary small');
    // Remove asks once more (its label turns into the question), as Files' Delete does.
    let confirmRemove = false;
    const removeBtn = UI.button(tr('Remove'), () => {
      if (!confirmRemove) { confirmRemove = true; return paint(); }
      remove([...chosen]);
    }, 'small');
    const canRemove = () => !!(UI.state && UI.state.hub && UI.state.hub.perm && UI.state.hub.perm.media && UI.state.hub.perm.media.remove);
    const status = el('span', { class: 'hint hub-media-status', attrs: { 'data-literal': '' } });
    const bar = el('div', { class: 'hub-media-bar' }, [filter.el, el('span', { class: 'hub-grow' }), status, removeBtn, saveBtn, selectBtn]);
    const grid = el('div', { class: 'hub-grid' });
    const sentinel = el('div', { class: 'hub-sentinel' });
    const wrap = el('div', { class: 'hub-media' }, [bar, grid, sentinel]);

    // The viewer: one big, with its name and Save.
    const bigImg = el('img', { class: 'hub-big', alt: '' });
    const bigName = el('div', { class: 'hub-big-name', attrs: { 'data-literal': '' } });
    const bigSub = el('div', { class: 'hint', attrs: { 'data-literal': '' } });
    const prev = UI.button('‹', () => step(-1));
    const next = UI.button('›', () => step(1));
    const bigSave = UI.button(tr('Save'), () => viewing && save([viewing.id]), 'primary');
    let confirmBig = false;
    const bigRemove = UI.button(tr('Remove'), () => {
      if (!viewing) return;
      if (!confirmBig) { confirmBig = true; bigRemove.textContent = tr('Remove from the phone?'); bigRemove.classList.add('danger'); return; }
      remove([viewing.id]);
    });
    const closeBtn = UI.button(tr('Close'), () => view(null));
    const viewer = el('div', { class: 'hub-viewer', hidden: true }, [
      el('div', { class: 'hub-viewer-stage' }, [prev, bigImg, next]),
      el('div', { class: 'hub-viewer-bar' }, [el('div', { class: 'hub-grow' }, [bigName, bigSub]), bigRemove, bigSave, closeBtn]),
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
      const t = el('button', { class: 'hub-tile', attrs: { 'data-literal': '' }, title: `${it.name}\n${new Date(it.at).toLocaleString()}` }, [img,
        it.video ? el('span', { class: 'hub-dur', text: it.dur ? UI.duration(it.dur / 1000) : tr('Video') }) : null,
        el('span', { class: 'hub-check' })]);
      t.dataset.id = it.id;
      t.onclick = () => {
        if (!selecting) return view(it);
        if (chosen.has(it.id)) chosen.delete(it.id); else chosen.add(it.id);
        confirmRemove = false;
        paint();
      };
      tiles.set(it.id, t);
      seen.observe(t);
      return t;
    }

    function paint() {
      wrap.classList.toggle('selecting', selecting);
      if (!selecting || !chosen.size) confirmRemove = false;
      removeBtn.hidden = !selecting || !canRemove();
      removeBtn.disabled = !chosen.size;
      removeBtn.textContent = confirmRemove ? tr(chosen.size === 1 ? 'Remove 1 item from the phone?' : 'Remove {count} items from the phone?', { count: chosen.size }) : tr('Remove');
      removeBtn.classList.toggle('danger', confirmRemove);
      selectBtn.textContent = selecting ? tr('Done') : tr('Select');
      saveBtn.hidden = !selecting;
      saveBtn.disabled = !chosen.size;
      saveBtn.textContent = chosen.size ? tr('Save {count} to {me}', { count: chosen.size, me: UI.fill('{me}') }) : tr('Save');
      for (const [id, t] of tiles) t.classList.toggle('chosen', chosen.has(id));
      status.textContent = items.length ? tr(kind === 'videos' ? '{count} videos' : kind === 'photos' ? '{count} photos' : kind === 'screenshots' ? '{count} screenshots' : '{count} items', { count: `${items.length}${more ? '+' : ''}` }) : '';
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
      status.textContent = tr('Saving {count} to {me}’s {folder}…', { count: ids.length, me: UI.fill('{me}'), folder: UI.receivedName(UI.state) });
      if (selecting) { selecting = false; chosen.clear(); }
      paint();
    }

    // Off the phone: the ones gone leave the grid when it answers (media.delete).
    function remove(ids) {
      if (!ids.length || !canRemove()) return;
      UI.hubAsk({ t: 'media.delete', ids });
      confirmRemove = false;
      if (selecting) { selecting = false; chosen.clear(); }
      paint();
      status.textContent = tr('Removing {count}…', { count: ids.length });
    }

    function drop(ids) {
      const gone = new Set(ids);
      if (!gone.size) return;
      if (viewing && gone.has(viewing.id)) {
        const i = items.indexOf(viewing);
        const nextIt = items.slice(i + 1).find((x) => !gone.has(x.id)) || items.slice(0, i).reverse().find((x) => !gone.has(x.id));
        view(nextIt || null);
      }
      items = items.filter((x) => !gone.has(x.id));
      for (const id of gone) {
        const t = tiles.get(id);
        if (t) { seen.unobserve(t); t.remove(); }
        tiles.delete(id);
        thumbs.delete(id);
        visible.delete(id);
        chosen.delete(id);
      }
      if (!items.length && !more) grid.replaceChildren(el('div', { class: 'hub-empty', text: tr(kind === 'all' ? 'No photos or videos' : kind === 'videos' ? 'No videos' : kind === 'screenshots' ? 'No screenshots' : 'No photos') }));
      if (viewing) view(viewing); // its ‹ › again
    }

    function view(it) {
      viewing = it;
      viewer.hidden = !it;
      confirmBig = false;
      bigRemove.textContent = tr('Remove');
      bigRemove.classList.remove('danger');
      bigRemove.hidden = !canRemove();
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
      if (!items.length) grid.replaceChildren(el('div', { class: 'hub-empty', text: tr(kind === 'all' ? 'No photos or videos' : kind === 'videos' ? 'No videos' : kind === 'screenshots' ? 'No screenshots' : 'No photos') }));
      paint();
    });
    UI.hubOn('media.thumb', (m) => {
      if (!m.data) return;
      thumbs.set(m.id, m.data);
      const t = tiles.get(m.id);
      if (t) t.querySelector('img').src = m.data;
      if (viewing && viewing.id === m.id && !bigImg.getAttribute('src')) bigImg.src = m.data;
    });
    UI.hubOn('media.delete', (m) => {
      drop(Array.isArray(m.ids) ? m.ids.filter((x) => typeof x === 'string') : []);
      paint();
      const notes = [];
      if (m.confirm > 0) notes.push(tr('Tap the notification on the phone to remove {count} more', { count: m.confirm }));
      if (m.failed > 0) notes.push(tr('{count} couldn’t be removed', { count: m.failed }));
      if (notes.length) status.textContent = notes.join(' · ');
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
    UI.onDeviceChange(() => { // another device: its photos, not the previous one's
      loaded = false;
      view(null);
      if (!page.hidden && UI.hubReady(UI.state, 'media') && !UI.onBle(UI.state)) { loaded = true; reset(); }
    });

    return (s) => {
      top.render(s);
      bigSave.textContent = tr('Save to {me}', { me: UI.fill('{me}') });
      const ready = UI.hubReady(s, 'media') && !UI.onBle(s); // over Bluetooth: the Wi-Fi Direct note only
      wrap.hidden = !ready;
      if (!ready) { loaded = false; view(null); return; }
      if (!loaded) { loaded = true; reset(); }
    };
  },
});

})();

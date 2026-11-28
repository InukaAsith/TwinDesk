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
  for: ['android', 'ios'], // a phone's: Android, iPhone or iPad (shared/ui-kinds.js)
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
    const selectBtn = UI.button(tr('Select'), () => { selecting = !selecting; anchor = ''; if (!selecting) chosen.clear(); paint(); }, 'small');
    const saveBtn = UI.button(tr('Save'), () => save([...chosen]), 'primary small');
    // Remove asks once more (its label turns into the question), as Files' Delete does.
    let confirmRemove = false;
    const removeBtn = UI.button(tr('Remove'), () => {
      if (!confirmRemove) { confirmRemove = true; return paint(); }
      remove([...chosen]);
    }, 'small');
    const canRemove = () => !!(UI.state && UI.state.hub && UI.state.hub.perm && UI.state.hub.perm.media && UI.state.hub.perm.media.remove);
    const status = el('span', { class: 'hint hub-media-status', attrs: { 'data-literal': '' } });
    const folderBtn = UI.saveFolderButton();
    const bar = el('div', { class: 'hub-media-bar' }, [filter.el, el('span', { class: 'hub-grow' }), status, folderBtn, removeBtn, saveBtn, selectBtn]);
    const grid = el('div', { class: 'hub-grid' });
    const sentinel = el('div', { class: 'hub-sentinel' });
    // Albums (a phone that lists them: media.albums): All, then each with its cover and count. The
    // filters above work inside the one picked.
    let album = ''; // '' all; else the album's id
    let albums = []; // {id, name, n, cover}
    const covers = new Set(); // cover ids still to get
    const albumList = el('div', { class: 'hub-albums', hidden: true, attrs: { role: 'listbox', 'aria-label': tr('Albums') } });
    const main = el('div', { class: 'hub-media-main' }, [bar, grid, sentinel]);
    const wrap = el('div', { class: 'hub-media' }, [albumList, main]);
    function paintAlbums() {
      albumList.hidden = !albums.length;
      wrap.classList.toggle('with-albums', !!albums.length);
      if (!albums.length) return;
      const total = albums.reduce((a, x) => a + x.n, 0);
      const row = (id, name, n, cover) => {
        const pic = el('span', { class: 'hub-album-pic' + (cover ? '' : ' all') });
        if (cover && thumbs.get(cover)) pic.style.backgroundImage = `url("${thumbs.get(cover)}")`;
        if (cover) pic.dataset.cover = cover;
        const b = el('button', { class: 'hub-album' + (album === id ? ' on' : ''), attrs: { role: 'option', 'aria-selected': String(album === id), 'data-literal': '' } }, [
          pic, el('span', { class: 'hub-album-text' }, [el('span', { class: 'hub-album-name', text: name }), el('span', { class: 'hub-album-n', text: String(n) })]),
        ]);
        b.onclick = () => { if (album === id) return; album = id; paintAlbums(); reset(); };
        return b;
      };
      albumList.replaceChildren(row('', tr('All'), total, ''), ...albums.map((a) => row(a.id, a.name, a.n, a.cover)));
    }

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
    // Copy and Share: the picture shown (the phone's large one, up to 1600 px), once it's here.
    let bigData = ''; // that picture, a data: URL ('' while it comes)
    const bigCopy = UI.button(tr('Copy'), () => {
      if (!viewing || !bigData) return;
      Promise.resolve(UI.api.hub({ do: 'copyImage', data: bigData })).then(() => {
        bigCopy.textContent = tr('Copied');
        setTimeout(() => { bigCopy.textContent = tr('Copy'); }, 1500);
      }).catch(() => {});
    });
    const bigShare = UI.button(tr('Share'), () => {
      if (!viewing || !bigData) return;
      UI.api.hub({ do: 'shareImage', data: bigData, name: viewing.name });
    });
    // Open: in this computer's own app for pictures; on Windows also Open with (its list of apps).
    const bigOpen = UI.button(tr('Open'), () => viewing && bigData && UI.api.hub({ do: 'openImage', data: bigData, name: viewing.name }));
    bigOpen.title = tr('Open it in this computer’s app for pictures');
    const winPc = /Win/.test(navigator.platform || navigator.userAgent);
    const bigOpenWith = UI.button(tr('Open with…'), () => viewing && bigData && UI.api.hub({ do: 'openImage', data: bigData, name: viewing.name, with: true }));
    const closeBtn = UI.button(tr('Close'), () => view(null));
    const viewer = el('div', { class: 'hub-viewer', hidden: true }, [
      el('div', { class: 'hub-viewer-stage' }, [prev, bigImg, next]),
      el('div', { class: 'hub-viewer-bar' }, [el('div', { class: 'hub-grow' }, [bigName, bigSub]), bigRemove, bigCopy, bigOpen, bigOpenWith, bigShare, bigSave, closeBtn]),
    ]);
    body.append(top.el, wrap, viewer);

    let items = []; // {id, video, at, w, h, size, name, dur, album}
    let nextKey = '';
    let more = false;
    let asking = false;
    let selecting = false;
    const chosen = new Set();
    let anchor = ''; // the id last chosen or let go: Shift-click does the same to every tile from it (#319)
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
      t.onclick = (e) => {
        if (!selecting) return view(it);
        const on = !chosen.has(it.id);
        const a = e.shiftKey && anchor ? items.findIndex((x) => x.id === anchor) : -1;
        const b = items.indexOf(it);
        for (const x of a >= 0 && b >= 0 ? items.slice(Math.min(a, b), Math.max(a, b) + 1) : [it]) if (on) chosen.add(x.id); else chosen.delete(x.id);
        anchor = it.id;
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
        for (const id of covers) if (!thumbs.get(id) && !ids.includes(id)) ids.push(id); // the albums' covers too, till they come
        for (const id of ids) if (!thumbs.has(id)) thumbs.set(id, '');
        if (ids.length) UI.hubAsk({ t: 'media.thumb', ids });
      }, 120);
    }, { root: document.getElementById('content'), rootMargin: '200px 0px' });
    const askCovers = () => {
      if (UI.onBle(UI.state) || !covers.size) return;
      const ids = [...visible].filter((id) => !thumbs.get(id)).concat([...covers].filter((id) => !thumbs.get(id)));
      if (ids.length) UI.hubAsk({ t: 'media.thumb', ids });
    };

    const end = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && more && !asking) page1();
    }, { root: document.getElementById('content'), rootMargin: '600px 0px' });
    end.observe(sentinel);

    function page1() {
      if (UI.onBle(UI.state)) return;
      asking = true;
      UI.hubAsk({ t: 'media.list', kind, before: nextKey, n: 120, ...(album ? { album } : {}) });
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
      bigData = '';
      paintBig();
      if (!it) return;
      if (thumbs.get(it.id)) bigImg.src = thumbs.get(it.id); else bigImg.removeAttribute('src');
      bigName.textContent = it.name;
      bigSub.textContent = [new Date(it.at).toLocaleString(), it.w && it.h ? `${it.w} × ${it.h}` : '', UI.bytes(it.size || 0), it.album].filter(Boolean).join(', ');
      if (!UI.onBle(UI.state)) UI.hubAsk({ t: 'media.view', id: it.id });
      const i = items.indexOf(it);
      prev.disabled = i <= 0;
      next.disabled = i < 0 || i >= items.length - 1;
    }

    // Copy and Share: photos only (a video's is a still), Share where this computer has one.
    function paintBig() {
      const photo = !!viewing && !viewing.video;
      bigCopy.hidden = bigOpen.hidden = !photo;
      bigOpenWith.hidden = !photo || !winPc;
      bigOpen.disabled = bigOpenWith.disabled = !bigData;
      bigShare.hidden = !photo || !(UI.state && UI.state.hub && UI.state.hub.shareSheet);
      bigCopy.disabled = bigShare.disabled = !bigData;
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
      if (m.kind !== kind || (m.before || '') !== nextKey || (m.album || '') !== album) return; // an answer for an older filter or album
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
      if (covers.delete(m.id)) for (const p of albumList.querySelectorAll('[data-cover]')) if (p.dataset.cover === m.id) p.style.backgroundImage = `url("${m.data}")`;
      const t = tiles.get(m.id);
      if (t) t.querySelector('img').src = m.data;
      if (viewing && viewing.id === m.id && !bigImg.getAttribute('src')) bigImg.src = m.data;
    });
    UI.hubOn('media.albums', (m) => {
      albums = (Array.isArray(m.items) ? m.items : []).filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string')
        .map((a) => ({ id: a.id.slice(0, 24), name: a.name.slice(0, 100), n: Math.max(0, Number(a.n) || 0), cover: typeof a.cover === 'string' ? a.cover.slice(0, 40) : '' }));
      if (album && !albums.some((a) => a.id === album)) { album = ''; reset(); }
      for (const a of albums) if (a.cover && !thumbs.get(a.cover)) covers.add(a.cover);
      paintAlbums();
      askCovers();
    });
    UI.hubOn('media.delete', (m) => {
      drop(Array.isArray(m.ids) ? m.ids.filter((x) => typeof x === 'string') : []);
      paint();
      const notes = [];
      if (m.confirm > 0) notes.push(tr('Tap the notification on the phone to remove {count} more', { count: m.confirm }));
      if (m.failed > 0) notes.push(tr('{count} couldn’t be removed', { count: m.failed }));
      if (notes.length) status.textContent = notes.join(', ');
      if (albums.length) UI.hubAsk({ t: 'media.albums' }); // their counts
    });
    UI.hubOn('media.view', (m) => {
      if (!viewing || viewing.id !== m.id || !m.data) return;
      bigImg.src = m.data;
      bigData = m.data;
      paintBig();
    });

    let loaded = false;
    UI.onShown(page, (shown) => {
      if (!shown) view(null);
      else if (UI.hubReady(UI.state, 'media') && !UI.onBle(UI.state) && !loaded) { loaded = true; reset(); UI.hubAsk({ t: 'media.albums' }); }
    });
    paint();
    UI.onDeviceChange(() => { // another device: its photos, not the previous one's
      loaded = false;
      view(null);
      album = '';
      albums = [];
      covers.clear();
      paintAlbums();
      if (!page.hidden && UI.hubReady(UI.state, 'media') && !UI.onBle(UI.state)) { loaded = true; reset(); UI.hubAsk({ t: 'media.albums' }); }
    });

    return (s) => {
      top.render(s);
      folderBtn.update(s);
      bigSave.textContent = tr('Save to {me}', { me: UI.fill('{me}') });
      const ready = UI.hubReady(s, 'media') && !UI.onBle(s); // over Bluetooth: the Wi-Fi Direct note only
      wrap.hidden = !ready;
      if (!ready) { loaded = false; view(null); return; }
      if (!loaded) { loaded = true; reset(); UI.hubAsk({ t: 'media.albums' }); }
    };
  },
});

})();

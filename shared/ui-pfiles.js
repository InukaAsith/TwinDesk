// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Phone Files page (Mac, PC and Linux): the phone's storage, folder by folder, through TwinDesk on
// the phone with All files access (Hub.kt, FsBrowse.kt there), so no ADB: Mount is the drive in the
// file manager, through ADB. Open a folder, Save files and folders here (into Downloads, as Send
// does), Upload into the folder that's open (or drop files on it), New folder, Rename, Delete.
// On USB, Wi-Fi or Wi-Fi Direct; over Bluetooth it says so, with Connect with Wi-Fi Direct.
// Shared folders (shared/foldershare.js), both ways: the folder the phone shares opens here in the
// file manager, and a folder here shows in the phone's Files app.
'use strict';

UI.tab({
  id: 'pfiles',
  group: 'Phone',
  order: 8,
  title: 'Phone Files',
  icon: 'folder',
  color: 'linear-gradient(#64d2ff, #0a84ff)',
  desc: 'Browse your phone’s storage, copy files both ways. No ADB: TwinDesk on the phone does it.',
  hidden: (s) => !UI.isPhone(s), // only while a phone is connected
  wifiOnly: true, // files are too big for Bluetooth: Connect with Wi-Fi Direct on top, nothing loads
  master: { get: (s) => !!(s.hub && s.hub.files), set: (v) => UI.api.hub({ do: 'set', what: 'files', on: v }) },
  badge: (s) => (s.hub && s.hub.files ? 'on' : ''),
  build(body, page) {
    const { el, api } = UI;
    const top = UI.hubTop('files');

    let cwd = '';
    let items = []; // {name, dir, size, at, n}
    let hidden = false;
    let asking = '';
    const chosen = new Set(); // names in cwd
    let confirmDelete = false;
    let renaming = ''; // the name being renamed
    let refs = 0;

    const crumbs = el('div', { class: 'hub-crumbs' });
    const upBtn = UI.button('‹', () => cwd && open(cwd.split('/').slice(0, -1).join('/')), 'small');
    upBtn.title = 'Up';
    const refreshBtn = UI.button('Refresh', () => open(cwd), 'small');
    const hiddenBtn = UI.button('Hidden', () => { hidden = !hidden; hiddenBtn.classList.toggle('on', hidden); open(cwd); }, 'small');
    hiddenBtn.title = 'Show files whose names start with a dot';
    const mkdirBtn = UI.button('New Folder', () => { newRow.hidden = false; newName.value = 'New Folder'; newName.select(); newName.focus(); }, 'small');
    const uploadBtn = UI.button('Upload…', () => api.hub({ do: 'upload', path: cwd }), 'small primary');
    const bar = el('div', { class: 'hub-media-bar' }, [upBtn, crumbs, el('span', { class: 'hub-grow' }), hiddenBtn, refreshBtn, mkdirBtn, uploadBtn]);

    // What's chosen: Save, Rename (one), Delete (asks once more).
    const selText = el('span', { class: 'hint' });
    const saveBtn = UI.button('Save', () => save([...chosen]), 'small primary');
    const renameBtn = UI.button('Rename', () => { renaming = [...chosen][0]; paint(); }, 'small');
    const deleteBtn = UI.button('Delete', () => {
      if (!confirmDelete) { confirmDelete = true; return paint(); }
      act({ a: 'delete', path: cwd, paths: [...chosen].map(join) });
      chosen.clear();
      confirmDelete = false;
      paint();
    }, 'small');
    const clearBtn = UI.button('Done', () => { chosen.clear(); confirmDelete = false; paint(); }, 'small');
    const selBar = el('div', { class: 'hub-media-bar hub-fs-sel' }, [selText, el('span', { class: 'hub-grow' }), saveBtn, renameBtn, deleteBtn, clearBtn]);

    // A new folder, named here.
    const newName = el('input', { class: 'hub-input hub-grow', type: 'text', attrs: { 'aria-label': 'Folder name', maxlength: '255' } });
    const newRow = el('div', { class: 'hub-media-bar hub-fs-new', hidden: true }, [UI.icon('folder', 'hub-fs-ico'), newName,
      UI.button('Create', () => mkdir(), 'small primary'), UI.button('Cancel', () => { newRow.hidden = true; }, 'small')]);
    newName.addEventListener('keydown', (e) => { if (e.key === 'Enter') mkdir(); else if (e.key === 'Escape') newRow.hidden = true; });

    const list = el('div', { class: 'hub-list hub-fs-list' });
    const status = el('div', { class: 'hint hub-fs-status' });
    const listCard = UI.card('', [list]);
    const wrap = el('div', { class: 'hub-fs' }, [bar, selBar, newRow, listCard, status]);
    // Shared folders, both ways (not behind the switch above: they need no All files access here).
    const fm = navigator.platform.startsWith('Mac') ? 'Finder' : navigator.platform.startsWith('Win') ? 'Explorer' : 'the file manager';
    const openBtn = UI.button('Open', () => api.hub({ do: 'share', a: 'open' }), 'small primary');
    const ejectBtn = UI.button('Eject', () => api.hub({ do: 'share', a: 'unmount' }), 'small');
    const autoSw = UI.switch((v) => api.hub({ do: 'share', a: 'auto', on: v }), { label: 'Open the phone’s shared folder when it shares one' });
    const phoneRow = UI.row('The phone’s shared folder', '', [openBtn, ejectBtn, autoSw]);
    const chooseBtn = UI.button('Choose…', () => api.hub({ do: 'share', a: 'choose' }), 'small');
    const defaultBtn = UI.button('Default', () => api.hub({ do: 'share', a: 'default' }), 'small');
    const serveSw = UI.switch((v) => api.hub({ do: 'share', a: 'serve', on: v }), { label: 'Share a folder with the phone' });
    const mineRow = UI.row('Share a folder with the phone', '', [chooseBtn, defaultBtn, serveSw]);
    const shareCard = UI.card('Shared folders', [phoneRow, mineRow]);
    body.append(top.el, shareCard, wrap);
    const tilde = (p) => String(p || '').replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Z]:\\Users\\[^\\]+)/, '~');
    function renderShare(s) {
      const sh = s.hub && s.hub.share;
      shareCard.hidden = !sh; // over Bluetooth too: Open moves the session onto Wi-Fi Direct first
      if (shareCard.hidden) return;
      const ph = UI.phoneName(s);
      const p = sh.phone;
      phoneRow.label.textContent = `${ph}’s shared folder`;
      autoSw.set(p.auto);
      openBtn.hidden = !p.offered;
      openBtn.disabled = !!p.busy;
      openBtn.textContent = p.mounted ? `Show in ${fm === 'the file manager' ? 'Files' : fm}` : 'Open';
      ejectBtn.hidden = !p.mounted;
      phoneRow.setHint(p.message || (p.busy === 'mounting' ? 'Opening…' : p.busy === 'wifi' ? 'Connecting with Wi-Fi Direct…'
        : p.wifi ? `“${p.name}”: Open connects with Wi-Fi Direct and shows it in ${fm}`
        : !p.offered ? `None shared: on ${ph}, TwinDesk › File access › Share a folder`
          : p.mounted ? `“${p.name}”, in ${fm}${fm === 'Finder' ? ' under Locations' : ''}` : `“${p.name}”: Open shows it in ${fm}`));
      phoneRow.hint.classList.toggle('bad', !!p.message);
      const m = sh.mine;
      mineRow.label.textContent = `Share a folder with ${ph}`;
      serveSw.set(m.on);
      mineRow.setHint(m.error ? `Couldn’t share: ${m.error}` : `${tilde(m.folder)}${m.on ? `: in ${ph}’s Files app and file pickers${UI.onBle(s) ? ', over Wi-Fi Direct (Open on the phone connects it)' : ''}` : ''}`);
      mineRow.hint.classList.toggle('bad', !!m.error);
    }

    const join = (name) => (cwd ? `${cwd}/${name}` : name);
    const ref = () => `fs${++refs}`;
    const act = (m) => UI.hubAsk({ t: 'fs.do', ref: ref(), ...m });

    function open(path) {
      cwd = path;
      asking = path;
      chosen.clear();
      confirmDelete = false;
      renaming = '';
      newRow.hidden = true;
      UI.hubAsk({ t: 'fs.list', path, hidden });
      paint();
    }

    function mkdir() {
      const name = newName.value.trim();
      if (!name || /[/\\]/.test(name)) return newName.focus();
      act({ a: 'mkdir', path: cwd, name });
      newRow.hidden = true;
    }

    function save(names) {
      if (!names.length) return;
      UI.hubAsk({ t: 'fs.save', paths: names.map(join) });
      status.textContent = `Saving ${names.length === 1 ? names[0] : `${names.length} items`} to ${UI.fill('{me}')}’s Downloads…`;
      chosen.clear();
      paint();
    }

    function row(it) {
      const check = el('input', { type: 'checkbox', class: 'hub-fs-check', attrs: { 'aria-label': `Choose ${it.name}` } });
      check.checked = chosen.has(it.name);
      check.onchange = () => { if (check.checked) chosen.add(it.name); else chosen.delete(it.name); confirmDelete = false; paint(); };
      const when = it.at ? UI.clock(it.at) : '';
      const hint = it.dir ? [it.n != null ? `${it.n} item${it.n === 1 ? '' : 's'}` : 'Folder', when] : [UI.bytes(it.size || 0), when];
      let r;
      if (renaming === it.name) {
        const input = el('input', { class: 'hub-input hub-grow', type: 'text', value: it.name, attrs: { 'aria-label': 'New name', maxlength: '255' } });
        const done = (ok) => {
          const name = input.value.trim();
          renaming = '';
          if (ok && name && name !== it.name && !/[/\\]/.test(name)) { act({ a: 'rename', path: join(it.name), name }); chosen.clear(); }
          paint();
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
        r = UI.row('', '', [UI.button('Rename', () => done(true), 'small primary'), UI.button('Cancel', () => done(false), 'small')]);
        r.querySelector('.text').replaceChildren(input);
        setTimeout(() => { input.focus(); input.setSelectionRange(0, it.dir ? it.name.length : it.name.replace(/\.[^.]*$/, '').length || it.name.length); });
      } else {
        r = UI.row(it.name, hint.filter(Boolean).join(' · '), it.dir ? [el('span', { class: 'chev', text: '›' })] : [UI.button('Save', () => save([it.name]), 'small')], {
          onClick: () => (it.dir ? open(join(it.name)) : (check.checked = !check.checked, check.onchange())),
        });
      }
      if (renaming !== it.name) { r.label.textContent = it.name; delete r.label.dataset.peer; } // a name as it is, braces too
      r.classList.add('hub-fs-row');
      r.classList.toggle('chosen', chosen.has(it.name));
      r.prepend(check, UI.icon(it.dir ? 'folder' : 'doc', `hub-fs-ico${it.dir ? ' dir' : ''}`));
      return r;
    }

    function paint() {
      const parts = cwd ? cwd.split('/') : [];
      crumbs.replaceChildren(...[{ label: 'Storage', path: '' }].concat(parts.map((p, i) => ({ label: p, path: parts.slice(0, i + 1).join('/') })))
        .flatMap((c, i, all) => {
          const b = el('button', { class: 'hub-crumb', text: c.label });
          b.disabled = i === all.length - 1;
          b.onclick = () => open(c.path);
          return i ? [el('span', { class: 'hub-crumb-sep', text: '›' }), b] : [b];
        }));
      upBtn.disabled = !cwd;
      list.replaceChildren(...items.map(row));
      if (!items.length) list.append(el('div', { class: 'hub-empty', text: asking === cwd ? 'Loading…' : 'This folder is empty' }));
      selBar.hidden = !chosen.size;
      selText.textContent = `${chosen.size} chosen`;
      saveBtn.textContent = `Save to ${UI.fill('{me}')}`;
      renameBtn.hidden = chosen.size !== 1;
      deleteBtn.textContent = confirmDelete ? `Delete ${chosen.size === 1 ? [...chosen][0] : `${chosen.size} items`}?` : 'Delete';
      deleteBtn.classList.toggle('danger', confirmDelete);
    }

    UI.hubOn('fs.list', (m) => {
      if ((m.path || '') !== cwd) return; // an answer for a folder left since
      asking = '';
      if (m.error) {
        items = [];
        status.textContent = m.error;
      } else {
        items = (m.items || []).filter((x) => x && typeof x.name === 'string' && x.name)
          .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        for (const n of [...chosen]) if (!items.some((x) => x.name === n)) chosen.delete(n);
        const gb = (n) => `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} GB`;
        status.textContent = m.total ? `${gb(m.free || 0)} free of ${gb(m.total)}` : '';
      }
      paint();
    });
    UI.hubOn('fs.done', (m) => {
      if (!m.ok) status.textContent = m.error || 'That didn’t work';
      if ((m.path || '') === cwd) UI.hubAsk({ t: 'fs.list', path: cwd, hidden });
    });

    // Files dropped on the page go into the folder that's open.
    wrap.addEventListener('dragover', (e) => {
      if (!UI.hubReady(UI.state, 'files') || !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      wrap.classList.add('over');
    });
    wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('over'); });
    wrap.addEventListener('drop', (e) => {
      wrap.classList.remove('over');
      if (!UI.hubReady(UI.state, 'files')) return;
      e.preventDefault();
      const paths = api.pathsOf ? api.pathsOf(e.dataTransfer.files) : [];
      if (paths.length) {
        api.hub({ do: 'upload', path: cwd, paths });
        status.textContent = `Sending ${paths.length === 1 ? 'a file' : `${paths.length} items`} to ${cwd || 'Storage'}…`;
      }
    });

    let loaded = false;
    UI.onShown(page, (shown) => {
      if (shown && UI.hubReady(UI.state, 'files') && !UI.onBle(UI.state) && !loaded) { loaded = true; open(cwd); }
    });
    paint();

    return (s) => {
      top.render(s);
      renderShare(s);
      const ready = UI.hubReady(s, 'files') && !UI.onBle(s); // over Bluetooth: the Wi-Fi Direct note only
      wrap.hidden = !ready;
      if (!ready) { loaded = false; return; }
      uploadBtn.textContent = `Upload from ${UI.fill('{me}')}…`;
      if (!loaded && !page.hidden) { loaded = true; open(cwd); }
    };
  },
});

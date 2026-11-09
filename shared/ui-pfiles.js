// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Phone Files page (Mac, PC and Linux): the phone's storage, folder by folder, through TwinDesk on
// the phone with All files access (Hub.kt, FsBrowse.kt there), so no ADB: Mount is the drive in the
// file manager, through ADB. Open a folder, Save files and folders here (into Downloads, as Send
// does), Upload into the folder that's open (or drop files on it), New folder, Rename, Delete.
// On USB, Wi-Fi or Wi-Fi Direct; over Bluetooth it says so, with Connect with Wi-Fi Direct.
// Shared folders (shared/foldershare.js), both ways: the folder the phone shares opens here in the
// file manager, and a folder here shows in the phone's Files app.
'use strict';

(() => {
  const tr = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);

UI.tab({
  id: 'pfiles',
  group: 'Phone',
  order: 8,
  title: tr('Phone Files'),
  icon: 'folder',
  color: 'linear-gradient(#64d2ff, #0a84ff)',
  desc: tr('Browse the phone’s storage and copy files both ways. No wireless debugging needed.'),
  for: ['android', 'ios'], // a phone's: Android, iPhone or iPad (shared/ui-kinds.js)
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

    const crumbs = el('div', { class: 'hub-crumbs', attrs: { 'data-literal': '' } });
    const upBtn = UI.button('‹', () => cwd && open(cwd.split('/').slice(0, -1).join('/')), 'small');
    upBtn.title = tr('Up');
    const refreshBtn = UI.button(tr('Refresh'), () => open(cwd), 'small');
    const hiddenBtn = UI.button(tr('Hidden'), () => { hidden = !hidden; hiddenBtn.classList.toggle('on', hidden); open(cwd); }, 'small');
    hiddenBtn.title = tr('Show files whose names start with a dot');
    const mkdirBtn = UI.button(tr('New Folder'), () => { newRow.hidden = false; newName.value = tr('New Folder'); newName.select(); newName.focus(); }, 'small');
    const uploadBtn = UI.button(tr('Upload…'), () => api.hub({ do: 'upload', path: cwd }), 'small primary');
    const bar = el('div', { class: 'hub-media-bar' }, [upBtn, crumbs, el('span', { class: 'hub-grow' }), hiddenBtn, refreshBtn, mkdirBtn, uploadBtn]);

    // What's chosen: Save, Rename (one), Delete (asks once more).
    const selText = el('span', { class: 'hint' });
    const saveBtn = UI.button(tr('Save'), () => save([...chosen]), 'small primary');
    const renameBtn = UI.button(tr('Rename'), () => { renaming = [...chosen][0]; paint(); }, 'small');
    const deleteBtn = UI.button(tr('Delete'), () => {
      if (!confirmDelete) { confirmDelete = true; return paint(); }
      act({ a: 'delete', path: cwd, paths: [...chosen].map(join) });
      chosen.clear();
      confirmDelete = false;
      paint();
    }, 'small');
    const clearBtn = UI.button(tr('Done'), () => { chosen.clear(); confirmDelete = false; paint(); }, 'small');
    const selBar = el('div', { class: 'hub-media-bar hub-fs-sel' }, [selText, el('span', { class: 'hub-grow' }), saveBtn, renameBtn, deleteBtn, clearBtn]);

    // A new folder, named here.
    const newName = el('input', { class: 'hub-input hub-grow', type: 'text', attrs: { 'aria-label': tr('Folder name'), maxlength: '255' } });
    const newRow = el('div', { class: 'hub-media-bar hub-fs-new', hidden: true }, [UI.icon('folder', 'hub-fs-ico'), newName,
      UI.button(tr('Create'), () => mkdir(), 'small primary'), UI.button(tr('Cancel'), () => { newRow.hidden = true; }, 'small')]);
    newName.addEventListener('keydown', (e) => { if (e.key === 'Enter') mkdir(); else if (e.key === 'Escape') newRow.hidden = true; });

    const list = el('div', { class: 'hub-list hub-fs-list' });
    const status = el('div', { class: 'hint hub-fs-status', attrs: { 'data-literal': '' } });
    const listCard = UI.card('', [list]);
    const wrap = el('div', { class: 'hub-fs' }, [bar, selBar, newRow, listCard, status]);
    // Shared folders, both ways (not behind the switch above: they need no All files access here).
    const fm = navigator.platform.startsWith('Mac') ? 'Finder' : navigator.platform.startsWith('Win') ? tr('Explorer') : tr('the file manager');
    const openBtn = UI.button(tr('Open'), () => api.hub({ do: 'share', a: 'open' }), 'small primary');
    const ejectBtn = UI.button(tr('Eject'), () => api.hub({ do: 'share', a: 'unmount' }), 'small');
    const autoSw = UI.switch((v) => api.hub({ do: 'share', a: 'auto', on: v }), { label: tr('Open the phone’s shared folder when it shares one') });
    const phoneRow = UI.row(tr('The phone’s shared folder'), '', [openBtn, ejectBtn, autoSw], { literal: true });
    const chooseBtn = UI.button(tr('Choose…'), () => api.hub({ do: 'share', a: 'choose' }), 'small');
    const defaultBtn = UI.button(tr('Default'), () => api.hub({ do: 'share', a: 'default' }), 'small');
    const serveSw = UI.switch((v) => api.hub({ do: 'share', a: 'serve', on: v }), { label: tr('Share a folder with the phone') });
    const mineRow = UI.row(tr('Share a folder with the phone'), '', [chooseBtn, defaultBtn, serveSw], { literal: true });
    const shareCard = UI.card(tr('Shared folders'), [phoneRow, mineRow]);
    // Explorer's Import from phone (Windows: right-click a folder › TwinDesk): Save goes there.
    const importRow = UI.row('', tr('Choose files on the phone, then Import. They go into this folder.'), [UI.button(tr('Cancel'), () => api.importCancel && api.importCancel(), 'small')]);
    importRow.label.setAttribute('data-literal', '');
    const importCard = UI.card('', [importRow], { cls: 'import-card' });
    importCard.hidden = true;
    let importTo = null;
    body.append(top.el, importCard, wrap, shareCard); // the files first, the shared folders' settings under them
    const tilde = (p) => String(p || '').replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Z]:\\Users\\[^\\]+)/, '~');
    function renderShare(s) {
      const sh = s.hub && s.hub.share;
      shareCard.hidden = !sh; // over Bluetooth too: Open moves the session onto Wi-Fi Direct first
      if (shareCard.hidden) return;
      const ph = UI.phoneName(s);
      const p = sh.phone;
      phoneRow.label.textContent = tr('{phone}’s shared folder', { phone: ph });
      autoSw.set(p.auto);
      openBtn.hidden = !p.offered;
      openBtn.disabled = !!p.busy;
      openBtn.textContent = p.mounted ? tr('Show in {manager}', { manager: fm === tr('the file manager') ? tr('Files') : tr(fm) }) : tr('Open');
      ejectBtn.hidden = !p.mounted;
      phoneRow.setHint(tr(p.message || '') || (p.busy === 'mounting' ? tr('Opening…') : p.busy === 'wifi' ? tr('Connecting with Wi-Fi Direct…')
        : p.wifi ? tr('“{folder}”: Open connects with Wi-Fi Direct and shows it in {manager}', { folder: p.name, manager: tr(fm) })
        : !p.offered ? tr('None shared: on {phone}, TwinDesk › File access › Share a folder', { phone: ph })
          : p.mounted ? tr(fm === 'Finder' ? '“{folder}”, in {manager} under Locations' : '“{folder}”, in {manager}', { folder: p.name, manager: tr(fm) }) : tr('“{folder}”: Open shows it in {manager}', { folder: p.name, manager: tr(fm) })));
      phoneRow.hint.classList.toggle('bad', !!p.message);
      const m = sh.mine;
      mineRow.label.textContent = tr('Share a folder with {phone}', { phone: ph });
      serveSw.set(m.on);
      mineRow.setHint(m.error ? tr('Couldn’t share: {error}', { error: m.error }) : m.on ? tr(UI.onBle(s) ? '{folder}: in {phone}’s Files app and file pickers, over Wi-Fi Direct (Open on the phone connects it)' : '{folder}: in {phone}’s Files app and file pickers', { folder: tilde(m.folder), phone: ph }) : tilde(m.folder));
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
      status.textContent = tr(names.length === 1 ? 'Saving {file} to {me}’s {folder}…' : 'Saving {count} items to {me}’s {folder}…', { file: names[0], count: names.length, me: UI.fill('{me}'), folder: UI.receivedName(UI.state) });
      chosen.clear();
      paint();
    }

    function row(it) {
      const check = el('input', { type: 'checkbox', class: 'hub-fs-check', attrs: { 'data-literal': '', 'aria-label': tr('Choose {file}', { file: it.name }) } });
      check.checked = chosen.has(it.name);
      check.onchange = () => { if (check.checked) chosen.add(it.name); else chosen.delete(it.name); confirmDelete = false; paint(); };
      const when = it.at ? UI.clock(it.at) : '';
      const hint = it.dir ? [it.n != null ? tr(it.n === 1 ? '{count} item' : '{count} items', { count: it.n }) : tr('Folder'), when] : [UI.bytes(it.size || 0), when];
      let r;
      if (renaming === it.name) {
        const input = el('input', { class: 'hub-input hub-grow', type: 'text', value: it.name, attrs: { 'aria-label': tr('New name'), maxlength: '255' } });
        const done = (ok) => {
          const name = input.value.trim();
          renaming = '';
          if (ok && name && name !== it.name && !/[/\\]/.test(name)) { act({ a: 'rename', path: join(it.name), name }); chosen.clear(); }
          paint();
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
        r = UI.row('', '', [UI.button(tr('Rename'), () => done(true), 'small primary'), UI.button(tr('Cancel'), () => done(false), 'small')]);
        r.querySelector('.text').replaceChildren(input);
        setTimeout(() => {
 input.focus(); input.setSelectionRange(0, it.dir ? it.name.length : it.name.replace(/\.[^.]*$/, '').length || it.name.length); });
      } else {
        r = UI.row(it.name, hint.filter(Boolean).join(' · '), it.dir ? [el('span', { class: 'chev', text: '›' })] : [UI.button(tr('Save'), () => save([it.name]), 'small')], {
          literal: true,
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
      crumbs.replaceChildren(...[{ label: tr('Storage'), path: '' }].concat(parts.map((p, i) => ({ label: p, path: parts.slice(0, i + 1).join('/') })))
        .flatMap((c, i, all) => {
          const b = el('button', { class: 'hub-crumb', text: c.label });
          b.disabled = i === all.length - 1;
          b.onclick = () => open(c.path);
          return i ? [el('span', { class: 'hub-crumb-sep', text: '›' }), b] : [b];
        }));
      upBtn.disabled = !cwd;
      list.replaceChildren(...items.map(row));
      if (!items.length) list.append(el('div', { class: 'hub-empty', text: asking === cwd ? tr('Loading…') : tr('This folder is empty') }));
      selBar.hidden = !chosen.size;
      selText.textContent = tr('{count} chosen', { count: chosen.size });
      saveBtn.setAttribute('data-literal', '');
      deleteBtn.setAttribute('data-literal', '');
      saveBtn.textContent = importTo ? tr('Import to {folder}', { folder: importTo.name }) : tr('Save to {me}', { me: UI.fill('{me}') });
      renameBtn.hidden = chosen.size !== 1;
      deleteBtn.textContent = confirmDelete ? tr(chosen.size === 1 ? 'Delete {file}?' : 'Delete {count} items?', { file: [...chosen][0], count: chosen.size }) : tr('Delete');
      deleteBtn.classList.toggle('danger', confirmDelete);
    }

    UI.hubOn('fs.list', (m) => {
      if ((m.path || '') !== cwd) return; // an answer for a folder left since
      asking = '';
      if (m.error) {
        items = [];
        status.textContent = tr(m.error);
      } else {
        items = (m.items || []).filter((x) => x && typeof x.name === 'string' && x.name)
          .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        for (const n of [...chosen]) if (!items.some((x) => x.name === n)) chosen.delete(n);
        const gb = (n) => `${(n / 1e9).toFixed(n >= 1e11 ? 0 : 1)} GB`;
        status.textContent = m.total ? tr('{free} free of {total}', { free: gb(m.free || 0), total: gb(m.total) }) : '';
      }
      paint();
    });
    UI.hubOn('fs.done', (m) => {
      if (!m.ok) status.textContent = tr(m.error || 'That didn’t work');
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
      // As an array: a FileList reaches the preload as a plain object, which can't be iterated.
      const paths = api.pathsOf ? api.pathsOf([...e.dataTransfer.files]) : [];
      if (paths.length) {
        api.hub({ do: 'upload', path: cwd, paths });
        status.textContent = tr(paths.length === 1 ? 'Sending a file to {folder}…' : 'Sending {count} items to {folder}…', { count: paths.length, folder: cwd || tr('Storage') });
      }
    });

    let loaded = false;
    UI.onShown(page, (shown) => {
      if (shown && UI.hubReady(UI.state, 'files') && !UI.onBle(UI.state) && !loaded) { loaded = true; open(cwd); }
    });
    paint();
    UI.onDeviceChange(() => { // another device: its folders, from the top
      cwd = '';
      items = [];
      chosen.clear();
      loaded = false;
      paint();
      if (!page.hidden && UI.hubReady(UI.state, 'files') && !UI.onBle(UI.state)) { loaded = true; open(cwd); }
    });

    return (s) => {
      top.render(s);
      renderShare(s);
      const imp = (s.files && s.files.importTo) || null;
      importCard.hidden = !imp;
      if (imp) {
        importRow.label.textContent = tr(imp.why === 'capture' ? 'Capturing into {folder}' : 'Importing into {folder}', { folder: imp.name });
        importRow.setHint(imp.why === 'capture' ? tr('Take photos with the phone’s camera. Each one comes into this folder.') : tr('Choose files on the phone, then Import. They go into this folder.'));
      }
      if (JSON.stringify(imp) !== JSON.stringify(importTo)) { importTo = imp; if (loaded) paint(); }
      const ready = UI.hubReady(s, 'files') && !UI.onBle(s); // over Bluetooth: the Wi-Fi Direct note only
      wrap.hidden = !ready;
      if (!ready) { loaded = false; return; }
      uploadBtn.setAttribute('data-literal', '');
      uploadBtn.textContent = tr('Upload from {me}…', { me: UI.fill('{me}') });
      if (!loaded && !page.hidden) { loaded = true; open(cwd); }
    };
  },
});

})();

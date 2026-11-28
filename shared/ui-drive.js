// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// File Sharing (Mac, Windows, Linux; docs/drive.md), two separate features:
//   - TwinDesk Drive: one folder kept in sync on every device that turns it on (state `drive`:
//     shared/drive-host.js view(), or {on: false, folder} while it isn't loaded).
//   - Shared folders: up to 10 folders, each with the devices chosen for it (state `folders`:
//     shared/folders-host.js view()), and the folders other computers offer.
// The file manager's Share folder opens the "Share <folder>" pop-up (folders.sheet).
//   const drive = UI.driveCard(api, {tilde, manager: 'Finder'});
//   body.append(drive.card, drive.folders, drive.invites); drive.update(s);
// api: setDrive(on), pickDriveFolder(), resetDriveFolder(), openDriveFolder(); folderShare({path, devices}),
// folderSheet(null), folderAdd(), folderRemove(id), folderDevices({id, devices}), folderAccept(id), folderDecline(id), folderOpen(id).
'use strict';

(function () {
  UI.driveCard = (api, { tilde = (p) => p, manager = '' } = {}) => {
    const t = (k, v) => I18n.t(k, v);
    const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(0, Math.round(n / 1e3))} KB`);
    const showLabel = manager ? t('Show in {app}', { app: manager }) : t('Open');

    // ---- TwinDesk Drive ----
    const sw = UI.switch((v) => api.setDrive(v), { label: t('TwinDesk Drive') });
    const mainRow = UI.row(t('TwinDesk Drive'), '', [sw], { literalHint: true });
    const openBtn = UI.button(showLabel, () => api.openDriveFolder(), 'small');
    const chooseBtn = UI.button(t('Change…'), () => api.pickDriveFolder(), 'small');
    const resetBtn = UI.button(t('Default'), () => api.resetDriveFolder(), 'small');
    const folderRow = UI.row(t('Location'), '', [resetBtn, chooseBtn, openBtn], { literalHint: true });
    const note = UI.note('warn', '', { literal: true });
    const card = UI.card(t('TwinDesk Drive'), [mainRow, folderRow, note], { cls: 'keep-on' });

    // ---- Shared folders: the list; Edit, Share a folder and the file manager's Share folder open a pop-up ----
    const OSNAME = { mac: 'macOS', win: 'Windows', windows: 'Windows', linux: 'Linux', android: 'Android', ios: 'iOS', ipados: 'iPadOS' };
    const addBtn = UI.button(t('Share a folder'), () => api.folderAdd && api.folderAdd(), 'small primary');
    const box = UI.el('div', { class: 'sf-list' });
    const listCard = UI.card(t('Shared folders'), [box], { actions: [addBtn], cls: 'keep-on' });
    const folders = UI.el('div', { class: 'sf-wrap' }, [listCard]);
    folders.hidden = true;
    // Invitations: folders other computers share with this one, a section of their own.
    const inviteBox = UI.el('div', { class: 'sf-list' });
    const invites = UI.card(t('Shared with you'), [inviteBox], { cls: 'keep-on' });
    invites.hidden = true;
    let editing = null; // {id?, path, name, sel}: the folder open in the side panel
    let foldersKey = '';
    let last = null;

    const devLabel = (fv, id) => ((fv.devices || []).find((d) => d.id === id) || { name: id.slice(0, 8) }).name;
    const folderState = (f) => (f.error ? t('Error: {error}', { error: f.error })
      : f.moving ? t(f.moving === 1 ? 'Syncing {count} file' : 'Syncing {count} files', { count: f.moving })
        : f.connected ? t('Up to date') : '');
    const chip = (text, cls = '') => UI.el('span', { class: 'sf-chip' + (cls ? ' ' + cls : ''), text });

    // The editor: All devices, or a tick per device; buttons by what it's for.
    // o: {title, path, sel, existing, onSave(sel), onCancel(), onStop()}
    function editor(fv, o) {
      const devs = fv.devices || [];
      let sel = o.sel;
      const wrap = UI.el('div', { class: 'sf-editor', attrs: { 'data-literal': '' } });
      const listBox = UI.el('div', { class: 'sf-devs' });
      const box2 = (checked, onChange, label) => {
        const c = UI.el('input', { type: 'checkbox', attrs: { 'aria-label': label } });
        c.checked = checked;
        c.onchange = () => onChange(c.checked);
        return c;
      };
      const all = Array.isArray(sel) ? false : true;
      const allRow = UI.el('label', { class: 'sf-all' }, [
        box2(all, (v) => { sel = v ? 'all' : devs.map((d) => d.id); draw(); }, t('All devices')),
        UI.el('span', {}, [UI.el('b', { text: t('All devices') }), UI.el('small', { text: t('Includes devices added later') })]),
      ]);
      const saveBtn = UI.button(o.existing ? t('Save') : t('Share'), () => o.onSave(sel), 'primary');
      function draw() {
        listBox.textContent = '';
        allRow.querySelector('input').checked = !Array.isArray(sel);
        if (Array.isArray(sel)) {
          for (const d of devs) {
            const side2 = d.connected === false ? t('Not connected, syncs later') : (OSNAME[d.os] || '');
            listBox.append(UI.el('label', { class: 'sf-dev' }, [
              box2(sel.includes(d.id), (v) => { sel = v ? [...new Set([...sel, d.id])] : sel.filter((x) => x !== d.id); draw(); }, d.name),
              UI.el('span', { class: 'sf-dev-name', text: d.name }),
              UI.el('span', { class: 'sf-dev-os', text: side2 }),
            ]));
          }
        }
        saveBtn.disabled = !devs.length || (Array.isArray(sel) && !sel.length);
      }
      draw();
      wrap.append(UI.el('h2', { text: o.title }), UI.el('div', { class: 'sf-where', text: tilde(o.path) }));
      if (!devs.length) wrap.append(UI.note('info', t('No paired devices')));
      else wrap.append(allRow, listBox);
      wrap.append(UI.el('div', { class: 'sf-foot' }, [
        ...(o.onStop ? [UI.button(t('Stop sharing'), o.onStop, 'danger')] : []),
        UI.el('span', { class: 'sf-grow' }),
        UI.button(t('Cancel'), o.onCancel),
        saveBtn,
      ]));
      return wrap;
    }

    let shade = null, shadeKey = '';
    function drawPopup(fv) {
      const key = editing ? JSON.stringify([editing.path, editing.id || '', fv.devices]) : '';
      if (key === shadeKey) return;
      shadeKey = key;
      if (shade) { if (shade.open) shade.close(); shade.remove(); shade = null; }
      if (!editing) return;
      const e = editing;
      const done = () => { editing = null; if (e.fromSheet) api.folderSheet(null); foldersKey = ''; drawFolders(fv); };
      const panel = UI.el('div', { class: 'sf-sheet', attrs: { role: 'dialog', 'aria-modal': 'true' } }, [editor(fv, {
        title: t('Share “{name}” with', { name: e.name }), path: e.path, sel: e.sel, existing: !!e.id,
        onSave: (sel) => { if (e.id) api.folderDevices({ id: e.id, devices: sel }); else api.folderShare({ path: e.path, devices: sel }); editing = null; foldersKey = ''; drawFolders(fv); },
        onCancel: done,
        onStop: e.id ? () => { api.folderRemove(e.id); editing = null; foldersKey = ''; drawFolders(fv); } : null,
      })]);
      // The browser's modal dialog: drawn above the whole page (top layer), Esc closes it.
      shade = UI.el('dialog', { class: 'sf-dialog' }, [panel]);
      shade.addEventListener('cancel', (ev) => { ev.preventDefault(); done(); });
      shade.addEventListener('click', (ev) => { if (ev.target === shade) done(); });
      document.body.append(shade);
      shade.showModal();
    }

    function drawFolders(fv) {
      const key = JSON.stringify([fv.list, fv.offers, fv.devices, editing && editing.path]);
      if (key === foldersKey) return;
      foldersKey = key;
      box.textContent = '';
      const list = fv.list || [];
      const offers = fv.offers || [];
      if (!list.length) box.append(UI.el('div', { class: 'sf-empty', text: t('No shared folders') }));
      for (const f of list) {
        const chips = Array.isArray(f.devices) ? (f.devices.length ? f.devices.map((id) => chip(devLabel(fv, id))) : [chip(t('No devices'), 'muted')]) : [chip(t('All devices'))];
        const st = folderState(f);
        const item = UI.el('div', { class: 'sf-item' + (editing && editing.id === f.id ? ' sel' : ''), attrs: { 'data-literal': '' } }, [
          UI.el('div', { class: 'sf-tile' }, [UI.icon('folder')]),
          UI.el('div', { class: 'sf-text' }, [
            UI.el('div', { class: 'sf-title' }, [UI.el('b', { text: f.name }), UI.el('span', { class: 'sf-path', text: tilde(f.path) })]),
            UI.el('div', { class: 'sf-chips' }, [UI.el('span', { class: 'sf-label', text: t('Access') }), ...chips, ...(st ? [UI.el('span', { class: 'sf-state', text: st })] : [])]),
          ]),
          UI.button(showLabel, () => api.folderOpen(f.id), 'small'),
          UI.button(t('Edit'), () => { editing = { id: f.id, path: f.path, name: f.name, sel: f.devices }; foldersKey = ''; drawFolders(fv); }, 'small'),
        ]);
        box.append(item);
      }
      inviteBox.textContent = '';
      invites.hidden = !offers.length;
      for (const o of offers) {
        inviteBox.append(UI.el('div', { class: 'sf-item offer', attrs: { 'data-literal': '' } }, [
          UI.el('div', { class: 'sf-tile' }, [UI.icon('folder')]),
          UI.el('div', { class: 'sf-text' }, [
            UI.el('div', { class: 'sf-title' }, [UI.el('b', { text: o.name })]),
            UI.el('div', { class: 'sf-chips' }, [UI.el('span', { class: 'sf-state', text: t('Shared by {devices}', { devices: (o.from || []).join(', ') }) })]),
          ]),
          UI.button(t('Decline'), () => api.folderDecline(o.f), 'small'),
          UI.button(t('Accept'), () => api.folderAccept(o.f), 'small primary'),
        ]));
      }
      addBtn.disabled = list.length >= (fv.max || 10);
      drawPopup(fv);
    }

    // ---- a sheet from the app (Share a folder's picker, or the file manager's Share folder) ----
    let sheetKey = '';
    function drawSheet(fv) {
      const sh = fv && fv.sheet;
      const key = sh ? JSON.stringify(sh) : '';
      if (key === sheetKey) return;
      sheetKey = key;
      if (!sh) { if (editing && editing.fromSheet) { editing = null; foldersKey = ''; } return; }
      editing = { path: sh.path, name: sh.name, sel: sh.shared || ((fv.devices || []).length === 1 ? [fv.devices[0].id] : 'all'), fromSheet: true };
      foldersKey = '';
    }
    // Its look: .sf-* in shared/ui-look.css (the pages' policy allows no inline style sheet).

    const update = (s) => {
      folders.hidden = !s.folders;
      if (s.folders) { last = s.folders; drawSheet(s.folders); drawFolders(s.folders); }
      const d = s.drive;
      card.hidden = !d;
      if (!d) return;
      sw.set(d.on);
      folderRow.setHint(tilde(d.folder));
      resetBtn.hidden = !d.custom;
      openBtn.disabled = !d.on;
      let hint;
      if (!d.on) hint = t('One folder, synced across your devices');
      else if (d.error) hint = t('Error: {error}', { error: d.error });
      else if (d.state === 'starting' || d.state === 'scanning') hint = t('Scanning…');
      else if (d.moving) hint = t(d.moving === 1 ? 'Syncing {count} file' : 'Syncing {count} files', { count: d.moving });
      else if (d.connected) hint = t('Up to date · {count} files, {size}', { count: d.files, size: size(d.bytes) });
      else hint = t('Waiting for devices · {count} files, {size}', { count: d.files, size: size(d.bytes) });
      mainRow.setHint(hint);
      mainRow.hint.classList.toggle('bad', !!(d.on && d.error));
      note.set(d.on && d.skipped ? t(d.skipped === 1 ? '{count} file skipped: name not supported here' : '{count} files skipped: names not supported here', { count: d.skipped }) : '');
    };
    return { card, folders, invites, update };
  };
})();

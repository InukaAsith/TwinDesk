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

    // ---- Shared folders ----
    const addBtn = UI.button(t('Add folder…'), () => api.folderAdd && api.folderAdd(), 'small');
    const box = UI.el('div');
    const folders = UI.card(t('Shared folders'), [box], { actions: [addBtn], cls: 'keep-on' });
    folders.hidden = true;
    // Invitations: folders other computers share with this one.
    const inviteBox = UI.el('div');
    const invites = UI.card(t('Shared with you'), [inviteBox], { cls: 'keep-on' });
    invites.hidden = true;
    const open = new Set(); // folders whose device list is shown
    let foldersKey = '';

    // Device switches: All, then each device. sel: 'all' or [ids]; onPick(next).
    function ticks(devs, sel, onPick) {
      const all = !Array.isArray(sel);
      const wrap = UI.el('div', { class: 'sf-ticks' });
      const allSw = UI.switch((v) => onPick(v ? 'all' : devs.map((d) => d.id)), { label: t('All devices') });
      allSw.set(all);
      wrap.append(UI.row(t('All devices'), t('Includes devices added later'), [allSw]));
      if (all) return wrap; // each device only once All is off
      for (const d of devs) {
        const one = UI.switch((v) => {
          const cur = all ? devs.map((x) => x.id) : sel.slice();
          onPick(v ? [...new Set([...cur, d.id])] : cur.filter((x) => x !== d.id));
        }, { label: d.name });
        one.set(all || sel.includes(d.id));
        wrap.append(UI.row(d.name, '', [UI.osIcon(d.os), one], { literal: true }));
      }
      return wrap;
    }
    const devLabel = (fv, sel) => {
      if (!Array.isArray(sel)) return t('All devices');
      if (!sel.length) return t('No devices');
      return sel.map((id) => ((fv.devices || []).find((d) => d.id === id) || { name: id.slice(0, 8) }).name).join(', ');
    };
    const folderState = (f) => (f.error ? t('Error: {error}', { error: f.error })
      : f.moving ? t(f.moving === 1 ? 'Syncing {count} file' : 'Syncing {count} files', { count: f.moving })
        : f.connected ? t('Up to date') : '');

    function drawFolders(fv) {
      const key = JSON.stringify([fv.list, fv.offers, fv.devices, [...open]]);
      if (key === foldersKey) return;
      foldersKey = key;
      box.textContent = '';
      const list = fv.list || [];
      if (!list.length) box.append(UI.row(t('No shared folders'), '', []));
      for (const f of list) {
        const shown = open.has(f.id);
        box.append(UI.row(f.name, [devLabel(fv, f.devices), tilde(f.path), folderState(f)].filter(Boolean).join(', '), [
          UI.button(shown ? t('Done') : t('Devices'), () => { shown ? open.delete(f.id) : open.add(f.id); foldersKey = ''; drawFolders(fv); }, 'small'),
          UI.button(showLabel, () => api.folderOpen(f.id), 'small'),
          UI.button(t('Stop sharing'), () => api.folderRemove(f.id), 'small'),
        ], { literal: true }));
        if (shown) box.append(ticks(fv.devices || [], f.devices, (next) => api.folderDevices({ id: f.id, devices: next })));
      }
      inviteBox.textContent = '';
      invites.hidden = !(fv.offers || []).length;
      for (const o of fv.offers || []) {
        inviteBox.append(UI.row(o.name, t('Shared by {devices}', { devices: (o.from || []).join(', ') }), [
          UI.button(t('Decline'), () => api.folderDecline(o.f), 'small'),
          UI.button(t('Accept'), () => api.folderAccept(o.f), 'small primary'),
        ], { literal: true }));
      }
      addBtn.disabled = list.length >= (fv.max || 10);
    }

    // ---- the pop-up: Share <folder> (the file manager's Share folder) ----
    let shade = null, sheetKey = '';
    function drawSheet(fv) {
      const sh = fv && fv.sheet;
      const key = sh ? JSON.stringify([sh, fv.devices]) : '';
      if (key === sheetKey) return;
      sheetKey = key;
      if (shade) { shade.remove(); shade = null; }
      if (!sh) return;
      const devs = fv.devices || [];
      let sel = sh.shared || (devs.length === 1 ? [devs[0].id] : 'all');
      const close = () => api.folderSheet(null);
      const inner = UI.el('div');
      const draw = () => {
        inner.textContent = '';
        if (!devs.length) inner.append(UI.note('info', t('No paired devices')));
        else if (devs.length === 1) inner.append(UI.row(t('With {device}', { device: devs[0].name }), '', [UI.osIcon(devs[0].os)], { literal: true }));
        else inner.append(ticks(devs, sel, (next) => { sel = next; draw(); }));
      };
      draw();
      const share = UI.button(t('Share'), () => api.folderShare({ path: sh.path, devices: sel }), 'primary');
      share.disabled = !devs.length;
      const panel = UI.el('div', { class: 'sf-sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'data-literal': '' } }, [
        UI.el('h2', { text: t('Share “{name}”', { name: sh.name }) }),
        UI.el('div', { class: 'sf-where', text: tilde(sh.path) }),
        inner,
        UI.el('div', { class: 'sf-foot' }, [UI.button(t('Cancel'), close), share]),
      ]);
      shade = UI.el('div', { class: 'sf-shade' }, [panel]);
      shade.addEventListener('click', (e) => { if (e.target === shade) close(); });
      document.body.append(shade);
    }
    // Its look: .sf-* in shared/ui-look.css (the pages' policy allows no inline style sheet).

    const update = (s) => {
      folders.hidden = !s.folders;
      if (!s.folders) invites.hidden = true;
      if (s.folders) { drawFolders(s.folders); drawSheet(s.folders); }
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

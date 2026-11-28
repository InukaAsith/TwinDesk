// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The TwinDesk Shared folders card on the File Sharing page (Mac, Windows, Linux; docs/drive.md; it was
// TwinDesk Drive): the main folder's switch, where it is and how it's doing, then the shared folders,
// each with its own devices (shared/folders-host.js), the ones other computers offer, and Add folder.
// The "Share <folder> with…" sheet (the file manager's Share folder) is here too. The app's state
// carries `drive` (shared/drive-host.js view(), or {on: false, folder} while it isn't loaded) and
// `folders` (folders-host.js view()); a state without them hides them.
// api for the folders: folderShare({path, devices}), folderSheet(null), folderAdd(), folderRemove(id),
// folderDevices({id, devices}), folderAccept(id), folderOpen(id).
//   const drive = UI.driveCard(api, {tilde, manager: 'Finder'}); body.append(drive.card); drive.update(s);
// api: setDrive(on), pickDriveFolder(), resetDriveFolder(), openDriveFolder().
'use strict';

(function () {
  UI.driveCard = (api, { tilde = (p) => p, manager = '' } = {}) => {
    const t = (k, v) => I18n.t(k, v);
    const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(0, Math.round(n / 1e3))} KB`);
    const sw = UI.switch((v) => api.setDrive(v), { label: t('TwinDesk Shared folders') });
    const mainRow = UI.row(t('Keep a folder the same on your devices'), '', [sw], { literalHint: true });
    const openBtn = UI.button(manager ? t('Show in {app}', { app: manager }) : t('Open'), () => api.openDriveFolder(), 'small');
    const chooseBtn = UI.button(t('Choose…'), () => api.pickDriveFolder(), 'small');
    const resetBtn = UI.button(t('Default'), () => api.resetDriveFolder(), 'small');
    const folderRow = UI.row(t('Folder'), '', [resetBtn, chooseBtn, openBtn], { literalHint: true });
    const note = UI.note('info', '', { literal: true });
    // ---- the shared folders ----
    const box = UI.el('div', { class: 'sf-list' });
    const addBtn = UI.button(t('Add folder…'), () => api.folderAdd && api.folderAdd(), 'small');
    const addRow = UI.row(t('Shared folders'), t('Each folder with the devices you choose. Phones see theirs in the Files app'), [addBtn]);
    const card = UI.card(t('TwinDesk Shared folders'), [mainRow, folderRow, addRow, box, note], { cls: 'keep-on' });
    let foldersKey = '';
    const openTicks = new Set(); // folders whose device ticks are shown

    // Ticks: All, then each device. sel: 'all' or [ids]; onPick(next).
    function ticks(devs, sel, onPick) {
      const all = !Array.isArray(sel);
      const wrap = UI.el('div', { class: 'sf-ticks' });
      const allSw = UI.switch((v) => onPick(v ? 'all' : devs.map((d) => d.id)), { label: t('All devices') });
      allSw.set(all);
      wrap.append(UI.row(t('All devices'), t('Devices paired later too'), [allSw]));
      for (const d of devs) {
        const one = UI.switch((v) => {
          const cur = all ? devs.map((x) => x.id) : sel.slice();
          onPick(v ? [...new Set([...cur, d.id])] : cur.filter((x) => x !== d.id));
        }, { label: d.name });
        one.set(all || sel.includes(d.id));
        const r = UI.row(d.name, '', [UI.osIcon(d.os), one], { literal: true });
        wrap.append(r);
      }
      return wrap;
    }

    const devLabel = (fv, sel) => {
      if (!Array.isArray(sel)) return t('All devices');
      if (!sel.length) return t('No devices');
      return sel.map((id) => ((fv.devices || []).find((d) => d.id === id) || { name: id.slice(0, 8) }).name).join(', ');
    };

    function drawFolders(fv) {
      const key = JSON.stringify([fv, [...openTicks]]);
      if (key === foldersKey) return;
      foldersKey = key;
      box.textContent = '';
      for (const f of fv.list || []) {
        const st = f.moving ? t(f.moving === 1 ? 'Syncing {count} file' : 'Syncing {count} files', { count: f.moving })
          : f.error ? t('Couldn’t use the folder: {error}', { error: f.error }) : f.connected ? t('Up to date with {device}', { device: f.peer }) : '';
        const row = UI.row(f.name, [devLabel(fv, f.devices), tilde(f.path), st].filter(Boolean).join(' · '), [
          UI.button(openTicks.has(f.id) ? t('Done') : t('Devices…'), () => { openTicks.has(f.id) ? openTicks.delete(f.id) : openTicks.add(f.id); foldersKey = ''; drawFolders(fv); }, 'small'),
          UI.button(manager ? t('Show in {app}', { app: manager }) : t('Open'), () => api.folderOpen(f.id), 'small'),
          UI.button(t('Stop sharing'), () => api.folderRemove(f.id), 'small'),
        ], { literal: true });
        box.append(row);
        if (openTicks.has(f.id)) box.append(ticks(fv.devices || [], f.devices, (next) => api.folderDevices({ id: f.id, devices: next })));
      }
      for (const o of fv.offers || []) {
        box.append(UI.row(o.name, t('{devices} shares it with this computer', { devices: (o.from || []).join(', ') }), [UI.button(t('Add'), () => api.folderAccept(o.f), 'small')], { literal: true }));
      }
      addBtn.disabled = (fv.list || []).length >= (fv.max || 10);
    }

    // ---- the sheet: Share <folder> with… ----
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
      const panel = UI.el('div', { class: 'sf-sheet', attrs: { role: 'dialog', 'aria-modal': 'true' } });
      const title = UI.el('h2', { text: t('Share {name} with…', { name: sh.name }), attrs: { 'data-literal': '' } });
      const where = UI.el('div', { class: 'sf-where', text: tilde(sh.path), attrs: { 'data-literal': '' } });
      const body2 = UI.el('div', { class: 'sf-body' });
      const draw = () => {
        body2.textContent = '';
        if (!devs.length) body2.append(UI.note('info', t('No device is paired yet. Pair one, then share the folder with it.')));
        else if (devs.length === 1) body2.append(UI.note('info', t('Share {name} with {device}? Its files stay the same on both.', { name: sh.name, device: devs[0].name }), { literal: true }));
        else body2.append(ticks(devs, sel, (next) => { sel = next; draw(); }));
      };
      draw();
      const share = UI.button(t('Share'), () => api.folderShare({ path: sh.path, devices: sel }), 'primary');
      share.disabled = !devs.length;
      const foot = UI.el('div', { class: 'sf-foot' }, [UI.button(t('Cancel'), close), share]);
      panel.append(title, where, body2, foot);
      shade = UI.el('div', { class: 'sf-shade' }, [panel]);
      shade.addEventListener('click', (e) => { if (e.target === shade) close(); });
      document.body.append(shade);
    }
    if (!document.getElementById('sf-style')) {
      const st = document.createElement('style');
      st.id = 'sf-style';
      st.textContent = '.sf-shade{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.42);display:flex;align-items:center;justify-content:center;padding:24px}'
        + '.sf-sheet{width:min(480px,100%);max-height:100%;overflow:auto;border-radius:14px;background:#fff;color:var(--text);box-shadow:0 24px 64px rgba(0,0,0,.35),0 0 0 1px var(--line);padding:18px 18px 14px}'
        + '@media (prefers-color-scheme: dark){.sf-sheet{background:#252527}}'
        + '.sf-sheet h2{margin:0 0 2px;font-size:16px;font-weight:600}.sf-where{color:var(--muted);font-size:12px;margin-bottom:12px;word-break:break-all}'
        + '.sf-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}.sf-ticks{padding-left:12px}';
      document.head.append(st);
    }

    const update = (s) => {
      if (s.folders) { drawFolders(s.folders); drawSheet(s.folders); }
      const d = s.drive;
      card.hidden = !d;
      if (!d) return;
      const peer = d.peer || (UI.peer ? UI.peer(s).name : '');
      sw.set(d.on);
      folderRow.setHint(tilde(d.folder) || t('TwinDesk Drive in your home folder'));
      resetBtn.hidden = !d.custom;
      openBtn.disabled = !d.on;
      let hint;
      if (!d.on) hint = t('One folder, the same on every device that turns this on, and any folder you share. Each keeps its own copy, so it works offline.');
      else if (d.error) hint = t('Couldn’t use the folder: {error}', { error: d.error });
      else if (d.state === 'starting' || d.state === 'scanning') hint = t('Looking for changes…');
      else if (d.connected && d.moving) hint = t(d.moving === 1 ? 'Syncing {count} file with {device}' : 'Syncing {count} files with {device}', { count: d.moving, device: peer });
      else if (d.connected) hint = t('Up to date with {device} · {count} files, {size}', { device: peer, count: d.files, size: size(d.bytes) });
      else hint = t('{count} files, {size} · syncs when a device with TwinDesk Shared folders on connects', { count: d.files, size: size(d.bytes) });
      mainRow.setHint(hint);
      mainRow.hint.classList.toggle('bad', !!(d.on && d.error));
      const notes = [];
      if (d.on) notes.push(t('Changed on two devices at once? Both are kept: one as “(conflict from …)”. Deleted files go to the Trash or Recycle Bin.'));
      if (d.on && d.skipped) notes.push(t(d.skipped === 1 ? '{count} file has a name this computer can’t hold: it stays on the other devices' : '{count} files have names this computer can’t hold: they stay on the other devices', { count: d.skipped }));
      note.set(notes.join(' '));
    };
    return { card, update };
  };
})();

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The TwinDesk Drive card on the File Sharing page (Mac, Windows, Linux; docs/drive.md): the switch,
// the folder and how it's doing. The app's state carries `drive` (shared/drive-host.js view(), or
// {on: false, folder} while it isn't loaded); a state without it hides it.
//   const drive = UI.driveCard(api, {tilde, manager: 'Finder'}); body.append(drive.card); drive.update(s);
// api: setDrive(on), pickDriveFolder(), resetDriveFolder(), openDriveFolder().
'use strict';

(function () {
  UI.driveCard = (api, { tilde = (p) => p, manager = '' } = {}) => {
    const t = (k, v) => I18n.t(k, v);
    const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(0, Math.round(n / 1e3))} KB`);
    const sw = UI.switch((v) => api.setDrive(v), { label: t('TwinDesk Drive') });
    const mainRow = UI.row(t('Keep a folder the same on your devices'), '', [sw], { literalHint: true });
    const openBtn = UI.button(manager ? t('Show in {app}', { app: manager }) : t('Open'), () => api.openDriveFolder(), 'small');
    const chooseBtn = UI.button(t('Choose…'), () => api.pickDriveFolder(), 'small');
    const resetBtn = UI.button(t('Default'), () => api.resetDriveFolder(), 'small');
    const folderRow = UI.row(t('Folder'), '', [resetBtn, chooseBtn, openBtn], { literalHint: true });
    const note = UI.note('info', '', { literal: true });
    const card = UI.card(t('TwinDesk Drive'), [mainRow, folderRow, note], { cls: 'keep-on' });

    const update = (s) => {
      const d = s.drive;
      card.hidden = !d;
      if (!d) return;
      const peer = d.peer || (UI.peer ? UI.peer(s).name : '');
      sw.set(d.on);
      folderRow.setHint(tilde(d.folder) || t('TwinDesk Drive in your home folder'));
      resetBtn.hidden = !d.custom;
      openBtn.disabled = !d.on;
      let hint;
      if (!d.on) hint = t('One folder, the same on every device that turns this on. Each keeps its own copy, so it works offline.');
      else if (d.error) hint = t('Couldn’t use the folder: {error}', { error: d.error });
      else if (d.state === 'starting' || d.state === 'scanning') hint = t('Looking for changes…');
      else if (d.connected && d.moving) hint = t(d.moving === 1 ? 'Syncing {count} file with {device}' : 'Syncing {count} files with {device}', { count: d.moving, device: peer });
      else if (d.connected) hint = t('Up to date with {device} · {count} files, {size}', { device: peer, count: d.files, size: size(d.bytes) });
      else hint = t('{count} files, {size} · syncs when a device with TwinDesk Drive on connects', { count: d.files, size: size(d.bytes) });
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

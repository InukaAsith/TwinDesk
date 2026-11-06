// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files tab: Send files (drop zone + Choose…) and copy/paste files with shortcuts,
// then two direction cards — files and the Mac's folder coming here, files and
// this PC's folder going to the Mac — then transfers. Drags across the edge,
// Monitor 2 drops, network drives in one switch each.
'use strict';

UI.tab({
  id: 'files',
  order: 50,
  title: I18n.t('File Sharing'),
  icon: 'globe',
  heading: I18n.t('File Sharing'),
  color: 'linear-gradient(#64d2ff, #0a84ff)',
  desc: I18n.t('Send files and folders between your devices, or share a folder.'),
  badge: (s) => (s.files.dropToMac || s.files.acceptFromMac ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const sw = (label, set) => UI.switch(set, { label });
    const mount = sw(I18n.t('{Name}’s folder here'), (v) => api.setFiles({ mountMac: v }));
    const openBtn = UI.button(I18n.t('Open'), () => api.openMacDrive(), 'small');
    const macDrive = UI.row(I18n.t('Open {name}’s shared folder'), '', [openBtn, mount]);
    const share = sw(I18n.t('{me}’s folder on {name}'), (v) => api.setShareOn(v));
    const chooseBtn = UI.button(I18n.t('Choose…'), () => api.chooseShareFolder(), 'small');
    const sharePill = el('span', { class: 'pill' });
    const pcShare = UI.row(I18n.t('Share a folder with {name}'), '', [sharePill, chooseBtn, share]);
    const pair = UI.dirCards(
      { on: { get: (s) => s.files.acceptFromMac, set: (v) => api.setFiles({ acceptFromMac: v }) }, label: I18n.t('Take files from {name} on {me}'), rows: [
        macDrive,
      ] },
      { on: { get: (s) => s.files.dropToMac, set: (v) => api.setFiles({ dropToMac: v }) }, label: I18n.t('Send files from {me} to {name}'), rows: [
        pcShare,
      ] },
    );
    // Send files: drop zone + Choose…
    const zoneText = el('div', { class: 'big', text: I18n.t('Drop files or folders here') });
    const zoneHint = el('div', { class: 'hint', text: '' });
    const zone = el('div', { class: 'dropzone' }, [el('div', {}, [zoneText, zoneHint])]);
    const sendBtn = UI.button(I18n.t('Choose…'), () => api.chooseSendFiles(), 'small');
    const sendRow = UI.row(I18n.t('Send files'), '', [sendBtn], { literal: true });
    const sendBar = el('div', { class: 'bar' }, [el('span')]);
    sendBar.hidden = true;
    sendRow.querySelector('.text').append(sendBar);
    let canSend = false;
    zone.ondragover = (e) => { e.preventDefault(); if (canSend) zone.classList.add('over'); };
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      // As an array: a FileList reaches the preload as a plain object, which can't be iterated.
      if (canSend) api.sendFiles(api.pathsOf([...e.dataTransfer.files]));
    };
    // Dropping anywhere else in the window must not open the file.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    // Copy and paste files with shortcuts
    const keysSw = sw(I18n.t('Copy and paste files with shortcuts'), (v) => api.setFiles({ shortcuts: v }));
    const copyRec = UI.keyRecorder((v) => api.setFiles({ copyKeys: v }));
    const pasteRec = UI.keyRecorder((v) => api.setFiles({ pasteKeys: v }));
    const keysRow = UI.row(I18n.t('Copy and paste files'), '', [keysSw], { literal: true });
    const copyRow = UI.row(I18n.t('Copy'), I18n.t('Select files in File Explorer first'), [copyRec]);
    const pasteRow = UI.row(I18n.t('Paste'), '', [pasteRec], { literal: true });

    const edgeDrag = sw(I18n.t('Drag files across the screen edge'), (v) => api.setFiles({ edgeDrag: v }));
    const edgeRow = UI.row(I18n.t('Drag files between computers'), '', [edgeDrag]);
    // Unencrypted file transfers (shared/fastfile.js fxPlain): the switch is on while they're encrypted.
    const encrypt = sw(I18n.t('Encrypt file transfers'), (v) => api.setFiles({ plain: !v }));
    const encryptRow = UI.row(I18n.t('Encrypt file transfers'), '', [encrypt]);
    const cancelBtn = UI.button(I18n.t('Cancel'), () => api.cancelDrop(), 'small');
    const outRow = UI.row('', '', [cancelBtn], { literal: true });
    const inRow = UI.row('', '', [], { literal: true });
    body.append(
      UI.card('', [sendRow, zone], { cls: 'keep-on' }),
      UI.card('', [keysRow, copyRow, pasteRow], { cls: 'keep-on' }),
      pair.el,
      UI.card('', [edgeRow, encryptRow]),
      UI.card(I18n.t('Recent'), [outRow, inRow]),
    );
    const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
    return (s) => {
      const f = s.files;
      const m = f.smb;
      const p = UI.peer(s);
      pair.update(s);
      // Send files
      canSend = s.link.state === 'connected' || !!s.activeWebDevice;
      zone.classList.toggle('off', !canSend);
      zoneText.textContent = canSend ? I18n.t('Drop files or folders here') : I18n.t('Connect to send files');
      zoneHint.textContent = !canSend ? '' : p.phone ? I18n.t('They go to {device}’s Downloads', { device: p.the })
        : I18n.t('They go to {device}’s Downloads, or the folder chosen there for received files', { device: p.the });
      sendBtn.disabled = !canSend;
      const b = f.batch;
      sendBar.hidden = !b;
      if (b) sendBar.firstChild.style.width = Math.floor((100 * b.sent) / Math.max(1, b.bytes)) + '%';
      sendRow.setHint(b ? I18n.t(b.kind === 'paste' ? 'Pasting {file} to {device}{progress}' : 'Sending {file} to {device}{progress}', { file: b.name, device: p.the, progress: b.files > 1 ? I18n.t(' · {index} of {count}', { index: b.index + 1, count: b.files }) : '' }) : canSend ? I18n.t('To {device}', { device: p.the }) : '');
      // Shortcuts
      const ck = f.clip;
      keysSw.set(f.shortcuts);
      copyRec.set(f.copyKeys);
      pasteRec.set(f.pasteKeys);
      keysRow.setHint(ck.error ? I18n.t(ck.error) : I18n.t('Select files, press {copy}, then {paste} on {device}', { copy: UI.keysLabel(f.copyKeys), paste: UI.keysLabel(f.pasteKeys), device: p.the }));
      keysRow.hint.classList.toggle('bad', !!ck.error);
      copyRow.hidden = pasteRow.hidden = !f.shortcuts;
      pasteRow.setHint(ck.pasting ? I18n.t('Pasting…')
        : ck.incoming ? I18n.t('{device} copied {items} · press {keys}', { device: p.them, items: ck.incoming.name || I18n.t('{count} items', { count: ck.incoming.items }), keys: UI.keysLabel(f.pasteKeys) })
          : I18n.t('Into the app in front (a chat, a mail…), or the File Explorer folder in front, else the Desktop'));
      edgeDrag.set(f.edgeDrag);
      encrypt.set(f.plain !== true);
      encryptRow.setHint(f.plain === true ? I18n.t('Off: files cross the network unencrypted, so others on it can read them (changes are still caught). Turn it off on both computers; a phone follows its computer.') : I18n.t('Files are encrypted on the way, like everything else'));
      encryptRow.hint.classList.toggle('bad', f.plain === true);
      edgeRow.setHint(f.edgeDrag && f.macDrags === false ? I18n.t('Turned off on {name}') : f.edgeDrag ? I18n.t('Drag through the screen edge and drop anywhere') : '');
      mount.set(f.mountMac);
      openBtn.hidden = !m.drive && !m.wifi;
      macDrive.setHint(m.mountMessage ? I18n.t(m.mountMessage) : (!f.mountMac ? '' : m.drive ? I18n.t('Drive {drive}', { drive: m.drive }) : m.busy === 'mount' ? I18n.t('Connecting…')
        : m.wifi ? I18n.t('Over Bluetooth: Open connects it with Wi-Fi Direct') : I18n.t('Waiting for {name} to share one')));
      share.set(f.shareOn);
      const busy = m.busy === 'setup' ? I18n.t('Setting up…') : m.busy === 'remove' ? I18n.t('Removing…') : '';
      sharePill.hidden = !f.shareOn && !busy;
      sharePill.textContent = busy || (m.peer && m.peer.mounted ? I18n.t('On {name}') : m.peer && m.peer.error ? I18n.t('Problem') : I18n.t('Shared'));
      sharePill.className = 'pill ' + (busy ? 'muted' : m.peer && m.peer.mounted ? 'good' : m.peer && m.peer.error ? 'bad' : 'muted');
      chooseBtn.disabled = !!m.busy;
      pcShare.setHint(m.message ? I18n.t(m.message) : m.peer && m.peer.error ? I18n.t(m.peer.error) : m.folder);

      cancelBtn.hidden = !f.current;
      if (f.current) {
        const c = f.current;
        outRow.label.textContent = I18n.t('Sending {file}{progress}', { file: c.name, progress: c.count > 1 ? I18n.t(' ({index} of {count})', { index: c.index + 1, count: c.count }) : '' });
        outRow.setHint(I18n.t('{sent} of {size}{waiting}', { sent: mb(c.sent), size: mb(c.size), waiting: f.queued ? I18n.t(' · {count} more waiting', { count: f.queued }) : '' }));
      } else {
        outRow.label.textContent = f.last ? I18n.t(f.last.ok ? 'Sent {file}' : 'Not sent: {file}', { file: f.last.name || '' }) : I18n.t('Nothing sent');
        outRow.setHint(f.last ? I18n.t(f.last.text, p) + ' · ' + UI.ago(f.last.at) : '');
      }
      const inc = f.incoming;
      const dr = f.drag;
      if (dr.state) {
        inRow.label.textContent = I18n.t(dr.state === 'copying' ? 'Copying {file}' : 'Dragging {file}', { file: dr.name });
        inRow.setHint(dr.state === 'copying' ? '' : I18n.t('Esc cancels'));
        return;
      }
      if (dr.last && (!inc.last || dr.last.at > inc.last.at)) {
        inRow.label.textContent = dr.last.ok ? I18n.t('Received from {name}', { name: p.name }) : I18n.t('Not received');
        inRow.setHint(I18n.t(dr.last.text, p) + ' · ' + UI.ago(dr.last.at));
        return;
      }
      inRow.label.textContent = inc.receiving ? I18n.t(inc.receiving === 1 ? 'Receiving {count} file from {name}' : 'Receiving {count} files from {name}', { count: inc.receiving, name: p.name })
        : inc.last ? I18n.t(inc.last.ok ? 'Received {file}' : 'Not received: {file}', { file: inc.last.name }) : I18n.t('Nothing received');
      inRow.setHint(inc.receiving ? '' : inc.last ? I18n.t(inc.last.text, p) + ' · ' + UI.ago(inc.last.at) : '');
    };
  },
});

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files tab (copy of windows/ui-files.js): Send files (drop zone + Choose…) and copy/paste files
// with shortcuts, then two direction cards — files and the other computer's folder coming here,
// files and this computer's folder going there — then transfers. Drags across the edge, Monitor 2
// drops, network folders in one switch each.
'use strict';

UI.tab({
  id: 'files',
  order: 50,
  title: 'Files',
  color: 'linear-gradient(#64d2ff, #0a84ff)',
  desc: 'Drag files between your computers, or share a folder.',
  badge: (s) => (s.files.dropToMac || s.files.acceptFromMac ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const sw = (label, set) => UI.switch(set, { label });
    const mount = sw('{Name}’s folder here', (v) => api.setFiles({ mountMac: v }));
    const openBtn = UI.button('Open', () => api.openMacDrive(), 'small');
    const macDrive = UI.row('Open {name}’s shared folder', '', [openBtn, mount]);
    const share = sw('{me}’s folder on {name}', (v) => api.setShareOn(v));
    const chooseBtn = UI.button('Choose…', () => api.chooseShareFolder(), 'small');
    const sharePill = el('span', { class: 'pill' });
    const pcShare = UI.row('Share a folder with {name}', '', [sharePill, chooseBtn, share]);
    const pair = UI.dirCards(
      { on: { get: (s) => s.files.acceptFromMac, set: (v) => api.setFiles({ acceptFromMac: v }) }, label: 'Take files from {name} on {me}', rows: [
        macDrive,
      ] },
      { on: { get: (s) => s.files.dropToMac, set: (v) => api.setFiles({ dropToMac: v }) }, label: 'Send files from {me} to {name}', rows: [
        pcShare,
      ] },
    );
    // Send files: drop zone + Choose…
    const zoneText = el('div', { class: 'big', text: 'Drop files or folders here' });
    const zoneHint = el('div', { class: 'hint', text: '' });
    const zone = el('div', { class: 'dropzone' }, [el('div', {}, [zoneText, zoneHint])]);
    const sendBtn = UI.button('Choose…', () => api.chooseSendFiles(), 'small');
    const sendRow = UI.row('Send files', '', [sendBtn]);
    const sendBar = el('div', { class: 'bar' }, [el('span')]);
    sendBar.hidden = true;
    sendRow.querySelector('.text').append(sendBar);
    let canSend = false;
    zone.ondragover = (e) => { e.preventDefault(); if (canSend) zone.classList.add('over'); };
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      if (canSend) api.sendFiles(api.pathsOf(e.dataTransfer.files));
    };
    // Dropping anywhere else in the window must not open the file.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    // Copy and paste files with shortcuts
    const keysSw = sw('Copy and paste files with shortcuts', (v) => api.setFiles({ shortcuts: v }));
    const copyRec = UI.keyRecorder((v) => api.setFiles({ copyKeys: v }));
    const pasteRec = UI.keyRecorder((v) => api.setFiles({ pasteKeys: v }));
    const keysRow = UI.row('Copy and paste files', '', [keysSw]);
    const copyRow = UI.row('Copy', 'Select files in the file manager first', [copyRec]);
    const pasteRow = UI.row('Paste', '', [pasteRec]);

    const edgeDrag = sw('Drag files across the screen edge', (v) => api.setFiles({ edgeDrag: v }));
    const edgeRow = UI.row('Drag files between computers', '', [edgeDrag]);
    const cancelBtn = UI.button('Cancel', () => api.cancelDrop(), 'small');
    const outRow = UI.row('', '', [cancelBtn]);
    const inRow = UI.row('', '');
    body.append(
      UI.card('', [sendRow, zone], { cls: 'keep-on' }),
      UI.card('', [keysRow, copyRow, pasteRow], { cls: 'keep-on' }),
      pair.el,
      UI.card('', [edgeRow]),
      UI.card('Recent', [outRow, inRow]),
    );
    const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
    return (s) => {
      const f = s.files;
      const m = f.smb;
      const p = UI.peer(s);
      pair.update(s);
      // Send files
      canSend = s.link.state === 'connected';
      zone.classList.toggle('off', !canSend);
      zoneText.textContent = canSend ? 'Drop files or folders here' : 'Connect to send files';
      zoneHint.textContent = canSend ? 'They go to ' + p.the + '’s Downloads' : '';
      sendBtn.disabled = !canSend;
      const b = f.batch;
      sendBar.hidden = !b;
      if (b) sendBar.firstChild.style.width = Math.floor((100 * b.sent) / Math.max(1, b.bytes)) + '%';
      sendRow.setHint(b ? (b.kind === 'paste' ? 'Pasting ' : 'Sending ') + b.name + ' to ' + p.the + (b.files > 1 ? ' · ' + (b.index + 1) + ' of ' + b.files : '') : canSend ? 'To ' + p.the + ', or right-click files › Send to in the file manager' : '');
      // Shortcuts
      const ck = f.clip;
      keysSw.set(f.shortcuts);
      copyRec.set(f.copyKeys);
      pasteRec.set(f.pasteKeys);
      keysRow.setHint(ck.error || 'Select files, press ' + UI.keysLabel(f.copyKeys) + ', then ' + UI.keysLabel(f.pasteKeys) + ' on ' + p.the);
      keysRow.hint.classList.toggle('bad', !!ck.error);
      copyRow.hidden = pasteRow.hidden = !f.shortcuts;
      pasteRow.setHint(ck.pasting ? 'Pasting…'
        : ck.incoming ? p.them + ' copied ' + (ck.incoming.name || ck.incoming.items + ' items') + ' · press ' + UI.keysLabel(f.pasteKeys)
          : 'Into the file manager window in front, else Downloads');
      edgeDrag.set(f.edgeDrag);
      edgeRow.setHint(f.edgeDrag && f.macDrags === false ? 'Turned off on {name}'
        : !f.edgeDrag ? '' : f.session === 'wayland' ? 'From ' + p.the + ': drop on a folder or the desktop. From here: needs an Xorg session'
          : 'Drag through the screen edge. Here, drop on a folder or the desktop');
      mount.set(f.mountMac);
      openBtn.hidden = !m.drive && !m.wifi;
      macDrive.setHint(m.mountMessage || (!f.mountMac ? '' : m.drive ? 'In the file manager’s sidebar' : m.busy === 'mount' ? 'Connecting…'
        : m.wifi ? 'Over Bluetooth: Open connects it with Wi-Fi Direct' : 'Waiting for {name} to share one'));
      share.set(f.shareOn);
      const busy = m.busy === 'setup' ? 'Setting up Samba…' : m.busy === 'remove' ? 'Removing…' : '';
      sharePill.hidden = !f.shareOn && !busy;
      sharePill.textContent = busy || (m.peer && m.peer.mounted ? 'On {name}' : m.peer && m.peer.error ? 'Problem' : 'Shared');
      sharePill.className = 'pill ' + (busy ? 'muted' : m.peer && m.peer.mounted ? 'good' : m.peer && m.peer.error ? 'bad' : 'muted');
      chooseBtn.disabled = !!m.busy;
      pcShare.setHint(m.message || (m.peer && m.peer.error) || (f.shareOn ? m.folder : m.folder + ' · Shares it with Samba (asks for your password once)'));

      cancelBtn.hidden = !f.current;
      if (f.current) {
        const c = f.current;
        outRow.label.textContent = 'Sending ' + c.name + (c.count > 1 ? ' (' + (c.index + 1) + ' of ' + c.count + ')' : '');
        outRow.setHint(mb(c.sent) + ' of ' + mb(c.size) + (f.queued ? ' · ' + f.queued + ' more waiting' : ''));
      } else {
        outRow.label.textContent = f.last ? (f.last.ok ? 'Sent ' : 'Not sent: ') + (f.last.name || '') : 'Nothing sent';
        outRow.setHint(f.last ? f.last.text + ' · ' + UI.ago(f.last.at) : '');
      }
      const inc = f.incoming;
      const dr = f.drag;
      if (dr.state) {
        inRow.label.textContent = (dr.state === 'copying' ? 'Copying ' : 'Dragging ') + dr.name;
        inRow.setHint(dr.state === 'copying' ? '' : 'Esc cancels');
        return;
      }
      if (dr.last && (!inc.last || dr.last.at > inc.last.at)) {
        inRow.label.textContent = dr.last.ok ? 'Received from {name}' : 'Not received';
        inRow.setHint(dr.last.text + ' · ' + UI.ago(dr.last.at));
        return;
      }
      inRow.label.textContent = inc.receiving ? 'Receiving ' + inc.receiving + ' file' + (inc.receiving > 1 ? 's' : '') + ' from {name}'
        : inc.last ? (inc.last.ok ? 'Received ' : 'Not received: ') + inc.last.name : 'Nothing received';
      inRow.setHint(inc.receiving ? '' : inc.last ? inc.last.text + ' · ' + UI.ago(inc.last.at) : '');
    };
  },
});

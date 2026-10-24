// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files tab: drag and drop and network drives, both directions in equal places.
'use strict';

UI.tab({
  id: 'files',
  group: 'Share',
  order: 50,
  title: 'Files',
  desc: 'Drag files between your computers, or share a folder.',
  color: 'linear-gradient(#64d2ff, #0a84ff)',
  badge: (s) => (s.files && s.files.acceptDrops ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const tilde = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');

    // Mac -> PC
        const shareSw = UI.switch((v) => api.setShareMac(v), { label: 'Share a folder' });
    const chooseBtn = UI.button('Choose…', () => api.chooseShareFolder(), 'small');
    const shareRow = UI.row('Share a folder with {name}', '', [chooseBtn, shareSw]);
    // PC -> Mac
    const acceptSw = UI.switch((v) => api.setFiles({ acceptDrops: v }), { label: 'Accept files' });
    const acceptRow = UI.row('Accept files from {name}', '', [acceptSw]);
    const pcSw = UI.switch((v) => api.setSmb({ connectPc: v }), { label: 'Connect the shared folder' });
    const openBtn = UI.button('Open', () => api.openPcShare(), 'small');
    const pcRow = UI.row('Open {name}’s shared folder', '', [openBtn, pcSw]);
    // shared
    const dragSw = UI.switch((v) => api.setFiles({ dragEdge: v }), { label: 'Drag files across the screen edge' });
    const dragRow = UI.row('Drag files between computers', 'Drag through the screen edge and drop anywhere', [dragSw]);
    const reveal = UI.switch((v) => api.setFiles({ reveal: v }), { label: 'Show in Finder' });
    const folderRow = UI.row('Save to', '', [UI.button('Choose…', () => api.pickDropFolder(), 'small'), UI.button('Downloads', () => api.resetDropFolder(), 'small')]);
    const progress = el('div');
    const list = el('div', { class: 'history' });

    // Send files: drop zone + Choose…
    const zoneText = el('div', { class: 'big', text: 'Drop files or folders here' });
    const zone = el('div', { class: 'dropzone' }, [el('div', {}, [zoneText, el('div', { class: 'hint', text: 'They go to the other computer’s Downloads' })])]);
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
      // As an array: a FileList reaches the preload as a plain object, which can't be iterated.
      if (canSend) api.sendFiles(api.pathsOf([...e.dataTransfer.files]));
    };
    // Dropping anywhere else in the window must not open the file.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    // Copy and paste files with shortcuts
    const keysSw = UI.switch((v) => api.setFiles({ shortcuts: v }), { label: 'Copy and paste files with shortcuts' });
    const copyRec = UI.keyRecorder((v) => api.setFiles({ copyKeys: v }));
    const pasteRec = UI.keyRecorder((v) => api.setFiles({ pasteKeys: v }));
    const keysRow = UI.row('Copy and paste files', '', [keysSw]);
    const copyRow = UI.row('Copy', 'Select files in Finder first', [copyRec]);
    const pasteRow = UI.row('Paste', '', [pasteRec]);

    body.append(
      UI.card('', [sendRow, zone], { cls: 'keep-on' }),
      UI.card('', [keysRow, copyRow, pasteRow], { cls: 'keep-on' }),
      UI.pair(
        UI.dir('m2w', [shareRow]),
        UI.dir('w2m', [acceptRow, pcRow]),
      ),
      UI.card('', [dragRow], { cls: 'keep-on' }),
      progress,
      UI.card('Arriving files', [
        folderRow,
        UI.row('Show in Finder', '', [reveal]),
      ]),
      UI.card('Recent', [list]),
    );

    let key = '';
    return (s) => {
      const f = s.files;
      const m = s.smb;
      if (!f || !m) return;
      const pc = UI.peer(s).name;
      // Send files
      canSend = !!s.client;
      zone.classList.toggle('off', !canSend);
      zoneText.textContent = canSend ? 'Drop files or folders here' : 'Connect to send files';
      sendBtn.disabled = !canSend;
      const out = f.sending.reduce((a, r) => [a[0] + r.sent, a[1] + r.size], [0, 0]);
      sendBar.hidden = !f.sending.length;
      sendBar.firstChild.style.width = `${Math.floor((100 * out[0]) / Math.max(1, out[1]))}%`;
      sendRow.setHint(f.sending.length ? `Sending ${f.sending.length} file${f.sending.length === 1 ? '' : 's'} to ${pc}` : canSend ? `To ${pc}` : '');
      // Shortcuts
      const ck = f.clip || {};
      keysSw.set(f.shortcuts !== false);
      copyRec.set(f.copyKeys);
      pasteRec.set(f.pasteKeys);
      keysRow.setHint(ck.error || `Select files, press ${UI.keysLabel(f.copyKeys)}, then ${UI.keysLabel(f.pasteKeys)} on ${pc}`);
      keysRow.hint.classList.toggle('bad', !!ck.error);
      pasteRow.setHint(ck.pasting ? 'Pasting…'
        : ck.incoming ? `${pc} copied ${ck.incoming.name || `${ck.incoming.items} items`} · press ${UI.keysLabel(f.pasteKeys)}`
          : 'Into the Finder window in front, else the Desktop');
      dragSw.set(f.dragEdge !== false);
      dragRow.setHint(f.dragEdge !== false && !f.peerDrag ? `Turned off on ${pc}` : 'Drag through the screen edge and drop anywhere');
      shareSw.set(m.sharing);
      shareSw.disable(m.shareBusy);
      chooseBtn.disabled = m.shareBusy;
      shareRow.setHint(m.shareBusy ? 'Waiting for your password…'
        : m.shareError ? `Couldn’t share: ${m.shareError}`
          : tilde(m.folder || m.defaultFolder));
      acceptSw.set(f.acceptDrops);
      pcSw.set(m.connectPc);
      openBtn.hidden = !m.mounted && !m.wifi;
      pcRow.setHint(!m.connectPc ? ''
        : m.mounted ? 'In Finder’s sidebar'
          : m.mounting ? 'Connecting…'
            : m.wifi ? 'Over Bluetooth: Open connects it with Wi-Fi Direct'
            : m.mountError ? `Couldn’t connect: ${m.mountError}`
              : `Waiting for ${pc} to share a folder`);
      reveal.set(f.reveal);
      folderRow.setHint(tilde(f.folder || f.defaultFolder));
      progress.replaceChildren(
        ...f.receiving.map((r) => UI.note('info', `Receiving ${r.name}  ${Math.floor((100 * r.got) / Math.max(1, r.size))}%`)),
        ...f.sending.map((r) => UI.note('info', `Sending ${r.name}  ${Math.floor((100 * r.sent) / Math.max(1, r.size))}%`)),
      );
      const items = [...f.recent.map((r) => ({ ...r, dir: 'in' })), ...f.sent.map((r) => ({ ...r, dir: 'out' }))].sort((a, b) => b.at - a.at).slice(0, 30);
      const k = JSON.stringify(items.map((r) => r.at)) + Math.floor(Date.now() / 15000);
      if (k === key) return;
      key = k;
      list.replaceChildren(...(items.length
        ? items.map((r) => el('div', { class: 'hist-item' }, [
          el('span', { class: `hist-dir ${r.dir}`, title: UI.fill(r.dir === 'out' ? 'Sent to {name}' : 'From {name}') }, [UI.icon(r.dir === 'out' ? 'up' : 'down')]),
          el('div', { class: 'hist-text' }, [
            el('div', { class: 'hist-preview', text: r.name }),
            el('div', { class: 'hint', text: `${r.ok ? (r.dir === 'in' ? tilde(r.path) : r.where || pc) : `Failed: ${r.error}`} · ${UI.ago(r.at)}` }),
          ]),
          r.dir === 'in' && r.ok ? UI.button('Show', () => api.revealDrop(f.recent.indexOf(f.recent.find((x) => x.at === r.at))), 'small') : null,
        ]))
        : [UI.row('Nothing yet', '')]));
    };
  },
});

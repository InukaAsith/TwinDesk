// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files tab: drag and drop and network drives, both directions in equal places.
'use strict';

UI.tab({
  id: 'files',
  group: 'Share',
  order: 50,
  title: I18n.t('File Sharing'),
  icon: 'globe',
  desc: I18n.t('Drag files between your computers, or share a folder.'),
  color: 'linear-gradient(#64d2ff, #0a84ff)',
  badge: (s) => (s.files && s.files.acceptDrops ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const tilde = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');

    // Mac -> PC
        const shareSw = UI.switch((v) => api.setShareMac(v), { label: I18n.t('Share a folder') });
    const chooseBtn = UI.button(I18n.t('Choose…'), () => api.chooseShareFolder(), 'small');
    const shareRow = UI.row(I18n.t('Share a folder with {name}'), '', [chooseBtn, shareSw], { literalHint: true });
    // PC -> Mac
    const acceptSw = UI.switch((v) => api.setFiles({ acceptDrops: v }), { label: I18n.t('Accept files') });
    const acceptRow = UI.row(I18n.t('Accept files from {name}'), '', [acceptSw]);
    const pcSw = UI.switch((v) => api.setSmb({ connectPc: v }), { label: I18n.t('Connect the shared folder') });
    const openBtn = UI.button(I18n.t('Open'), () => api.openPcShare(), 'small');
    const pcRow = UI.row(I18n.t('Open {name}’s shared folder'), '', [openBtn, pcSw], { literalHint: true });
    // shared
    const dragSw = UI.switch((v) => api.setFiles({ dragEdge: v }), { label: I18n.t('Drag files across the screen edge') });
    const dragRow = UI.row(I18n.t('Drag files between computers'), I18n.t('Drag through the screen edge and drop anywhere'), [dragSw], { literalHint: true });
    // Unencrypted file transfers (shared/fastfile.js fxPlain): the switch is on while they're encrypted.
    const encryptSw = UI.switch((v) => api.setFiles({ plain: !v }), { label: I18n.t('Encrypt file transfers') });
    const encryptRow = UI.row(I18n.t('Encrypt file transfers'), '', [encryptSw], { literalHint: true });
    const reveal = UI.switch((v) => api.setFiles({ reveal: v }), { label: I18n.t('Show in Finder') });
    const folderRow = UI.row(I18n.t('Save to'), '', [UI.button(I18n.t('Choose…'), () => api.pickDropFolder(), 'small'), UI.button(I18n.t('Downloads'), () => api.resetDropFolder(), 'small')], { literalHint: true });
    const progress = el('div');
    const list = el('div', { class: 'history' });

    // Send files: drop zone + Choose…
    const zoneText = el('div', { class: 'big', text: I18n.t('Drop files or folders here') });
    const zone = el('div', { class: 'dropzone' }, [el('div', {}, [zoneText, el('div', { class: 'hint', text: I18n.t('They go to the other computer’s Downloads') })])]);
    const sendBtn = UI.button(I18n.t('Choose…'), () => api.chooseSendFiles(), 'small');
    const sendRow = UI.row(I18n.t('Send files'), '', [sendBtn], { literalHint: true });
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
    const keysSw = UI.switch((v) => api.setFiles({ shortcuts: v }), { label: I18n.t('Copy and paste files with shortcuts') });
    const copyRec = UI.keyRecorder((v) => api.setFiles({ copyKeys: v }));
    const pasteRec = UI.keyRecorder((v) => api.setFiles({ pasteKeys: v }));
    const keysRow = UI.row(I18n.t('Copy and paste files'), '', [keysSw], { literalHint: true });
    const copyRow = UI.row(I18n.t('Copy'), I18n.t('Select files in Finder first'), [copyRec]);
    const pasteRow = UI.row(I18n.t('Paste'), '', [pasteRec], { literalHint: true });

    body.append(
      UI.card('', [sendRow, zone], { cls: 'keep-on' }),
      UI.card('', [keysRow, copyRow, pasteRow], { cls: 'keep-on' }),
      UI.pair(
        UI.dir('m2w', [shareRow]),
        UI.dir('w2m', [acceptRow, pcRow]),
      ),
      UI.card('', [dragRow, encryptRow], { cls: 'keep-on' }),
      progress,
      UI.card(I18n.t('Arriving files'), [
        folderRow,
        UI.row(I18n.t('Show in Finder'), '', [reveal]),
      ]),
      UI.card(I18n.t('Recent'), [list]),
    );

    let key = '';
    let progressKey = '';
    return (s) => {
      const f = s.files;
      const m = s.smb;
      if (!f || !m) return;
      const pc = s.activeWebDevice ? s.activeWebDevice.name : UI.peer(s).name;
      // Send files
      canSend = !!(s.client || s.activeWebDevice);
      zone.classList.toggle('off', !canSend);
      zoneText.textContent = canSend ? I18n.t('Drop files or folders here') : I18n.t('Connect to send files');
      sendBtn.disabled = !canSend;
      // A batch is one entry (mac/filesend.js): its files left and its bytes.
      const outB = f.outBatches || [];
      const out = outB.reduce((a, b) => [a[0] + b.sent, a[1] + b.bytes], f.sending.reduce((a, r) => [a[0] + r.sent, a[1] + r.size], [0, 0]));
      const outCount = f.sending.length + (f.sendingMore || 0) + outB.reduce((n, b) => n + b.left, 0);
      sendBar.hidden = !outCount;
      sendBar.firstChild.style.width = `${Math.floor((100 * out[0]) / Math.max(1, out[1]))}%`;
      sendRow.setHint(outCount ? I18n.t(outCount === 1 ? 'Sending {count} file to {device}' : 'Sending {count} files to {device}', { count: outCount, device: pc }) : canSend ? I18n.t('To {device}', { device: pc }) : '');
      // Shortcuts
      const ck = f.clip || {};
      keysSw.set(f.shortcuts !== false);
      copyRec.set(f.copyKeys);
      pasteRec.set(f.pasteKeys);
      keysRow.setHint(ck.error || I18n.t('Select files, press {copy}, then {paste} on {device}', { copy: UI.keysLabel(f.copyKeys), paste: UI.keysLabel(f.pasteKeys), device: pc }));
      keysRow.hint.classList.toggle('bad', !!ck.error);
      pasteRow.setHint(ck.pasting ? I18n.t('Pasting…')
        : ck.incoming ? I18n.t('{device} copied {items} · press {keys}', { device: pc, items: ck.incoming.name || I18n.t('{count} items', { count: ck.incoming.items }), keys: UI.keysLabel(f.pasteKeys) })
          : I18n.t('Into the app in front (a chat, a mail…), or the Finder folder in front, else the Desktop'));
      dragSw.set(f.dragEdge !== false);
      encryptSw.set(f.plain !== true);
      encryptRow.setHint(f.plain === true ? I18n.t('Off: files cross the network unencrypted, so others on it can read them (changes are still caught). Turn it off on both computers; a phone follows its computer.') : I18n.t('Files are encrypted on the way, like everything else'));
      encryptRow.hint.classList.toggle('bad', f.plain === true);
      dragRow.setHint(f.dragEdge !== false && !f.peerDrag ? I18n.t('Turned off on {device}', { device: pc }) : I18n.t('Drag through the screen edge and drop anywhere'));
      shareSw.set(m.sharing);
      shareSw.disable(m.shareBusy);
      chooseBtn.disabled = m.shareBusy;
      shareRow.setHint(m.shareBusy ? I18n.t('Waiting for your password…')
        : m.shareError ? I18n.t('Couldn’t share: {error}', { error: m.shareError })
          : tilde(m.folder || m.defaultFolder));
      acceptSw.set(f.acceptDrops);
      pcSw.set(m.connectPc);
      openBtn.hidden = !m.mounted && !m.wifi;
      pcRow.setHint(!m.connectPc ? ''
        : m.mounted ? I18n.t('In Finder’s sidebar')
          : m.mounting ? I18n.t('Connecting…')
            : m.wifi ? I18n.t('Over Bluetooth: Open connects it with Wi-Fi Direct')
            : m.mountError ? I18n.t('Couldn’t connect: {error}', { error: m.mountError })
              : I18n.t('Waiting for {device} to share a folder', { device: pc }));
      reveal.set(f.reveal);
      folderRow.setHint(tilde(f.folder || f.defaultFolder));
      // Files on their way: a batch as one line, a few single files, the rest counted. Redrawn only
      // when a line changes (10,000 small files made it jump for each one).
      const pctOf = (n, of) => Math.min(99, Math.floor((100 * n) / Math.max(1, of)));
      const lines = [
        ...(f.inBatches || []).map((b) => I18n.t(b.kind === 'paste' ? (b.count === 1 ? 'Pasting {count} file from {name} · {percent} %' : 'Pasting {count} files from {name} · {percent} %')
          : b.count === 1 ? 'Receiving {count} file from {name} · {percent} %' : 'Receiving {count} files from {name} · {percent} %',
        { count: b.count, name: pc, percent: b.bytes ? pctOf(b.got, b.bytes) : pctOf(b.done, b.count) })),
        ...f.receiving.map((r) => I18n.t('Receiving {file}  {progress}%', { file: r.name, progress: pctOf(r.got, r.size) })),
        ...(f.receivingMore ? [I18n.t('{count} more files waiting', { count: f.receivingMore })] : []),
        ...outB.map((b) => I18n.t('Sending {file} to {name} · {percent} %', { file: b.items > 1 ? I18n.t('{count} items', { count: b.items }) : b.name, name: pc, percent: pctOf(b.sent, b.bytes) })),
        ...f.sending.map((r) => I18n.t('Sending {file}  {progress}%', { file: r.name, progress: pctOf(r.sent, r.size) })),
        ...(f.sendingMore ? [I18n.t('{count} more files waiting', { count: f.sendingMore })] : []),
      ];
      const pk = lines.join('\n');
      if (pk !== progressKey) {
        progressKey = pk;
        progress.replaceChildren(...lines.map((l) => UI.note('info', l, { literal: true })));
      }
      const items = [...f.recent.map((r) => ({ ...r, dir: 'in' })), ...f.sent.map((r) => ({ ...r, dir: 'out' }))].sort((a, b) => b.at - a.at).slice(0, 30);
      const k = JSON.stringify(items.map((r) => r.at)) + Math.floor(Date.now() / 15000);
      if (k === key) return;
      key = k;
      list.replaceChildren(...(items.length
        ? items.map((r) => el('div', { class: 'hist-item' }, [
          el('span', { class: `hist-dir ${r.dir}`, title: UI.fill(r.dir === 'out' ? I18n.t('Sent to {name}') : I18n.t('From {name}')) }, [UI.icon(r.dir === 'out' ? 'up' : 'down')]),
          el('div', { class: 'hist-text' }, [
            el('div', { class: 'hist-preview', text: r.name }),
            el('div', { class: 'hint', text: `${r.ok ? (r.dir === 'in' ? tilde(r.path) : r.where || pc) : I18n.t('Failed: {error}', { error: r.error })} · ${UI.ago(r.at)}` }),
          ]),
          r.dir === 'in' && r.ok ? UI.button(I18n.t('Show'), () => api.revealDrop(f.recent.indexOf(f.recent.find((x) => x.at === r.at))), 'small') : null,
        ]))
        : [UI.row(I18n.t('Nothing yet'), '')]));
    };
  },
});

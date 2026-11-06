// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Drop tab: real-time drop stream, text injection, files, and clipboard push with web clients.
'use strict';

(() => {
  const tr = (text, vars) => (window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => (vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m)));

  UI.tab({
    id: 'drop',
    group: 'Share',
    order: 41,
    title: tr('Drop'),
    icon: 'message',
    color: 'linear-gradient(#bf5af2, #5e5ce6)',
    desc: tr('Instant drops, clipboard push and file exchange with web companion devices.'),
    hidden: (s) => !s.activeWebDevice && !(s.webDevices && s.webDevices.length),
    build(body) {
      const { el, api } = UI;

      // 1. Drop Zone Card
      const zoneText = el('div', { class: 'big', text: tr('Drop files or folders here') });
      const zoneHint = el('div', { class: 'hint', text: tr('Files are sent immediately to the web companion device') });
      const zone = el('div', { class: 'dropzone' }, [el('div', {}, [zoneText, zoneHint])]);

      const chooseBtn = UI.button(tr('Choose files…'), () => api.chooseSendFiles(), 'small');
      const dropRow = UI.row(tr('Drop to device'), '', [chooseBtn], { literalHint: true });

      let canSend = true;
      zone.ondragover = (e) => {
        e.preventDefault();
        if (canSend) zone.classList.add('over');
      };
      zone.ondragleave = () => zone.classList.remove('over');
      zone.ondrop = (e) => {
        e.preventDefault();
        zone.classList.remove('over');
        if (!canSend) return;
        const files = e.dataTransfer ? e.dataTransfer.files : [];
        const paths = api.pathsOf ? api.pathsOf(files) : [...files].map((f) => f.path).filter(Boolean);
        if (paths.length && api.sendFiles) {
          api.sendFiles(paths);
        }
      };

      const dropCard = UI.card(tr('Send Files'), [dropRow, zone]);

      // 2. Real-time Activity / Message Stream Card
      const stream = el('div', { class: 'hub-bubbles', style: 'padding: 12px 14px; max-height: 380px; overflow-y: auto; min-height: 120px;' });
      const emptyHint = el('div', { class: 'hub-empty', text: tr('No drop activity yet. Dropped files and messages will appear here.') });
      stream.append(emptyHint);

      // Input bar
      const input = el('input', {
        type: 'text',
        class: 'hub-input',
        placeholder: tr('Type message or drop text to send…'),
        style: 'flex: 1; padding: 7px 12px; font-size: 13px;',
      });

      let pushClipboard = false;
      const clipSw = UI.switch((v) => { pushClipboard = !!v; }, { label: tr('Copy to device clipboard') });
      const clipOption = UI.row(tr('Copy directly to device clipboard'), tr('Pushes the sent text straight into the companion device pasteboard'), [clipSw]);

      const sendBtn = UI.button(tr('Send'), () => doSend(), 'primary small');

      const composeBar = el('div', { style: 'display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); align-items: center;' }, [
        input,
        sendBtn,
      ]);

      function doSend() {
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        if (api.sendWebChat) {
          api.sendWebChat(text, pushClipboard);
        }
      }

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          doSend();
        }
      });

      const activityCard = UI.card(tr('Activity & Drops'), [
        stream,
        clipOption,
        composeBar,
      ]);

      body.append(dropCard, activityCard);

      let lastChatCount = -1;

      return (s) => {
        const dev = s.activeWebDevice || (s.webDevices && s.webDevices[0]);
        const devName = dev ? dev.name : tr('Web Device');
        canSend = !!dev;

        dropRow.setHint(tr('Sending to {name}', { name: devName }));
        zoneHint.textContent = tr('Files go straight to {name}’s browser downloads', { name: devName });
        zone.classList.toggle('off', !canSend);

        const chats = s.webChats || [];
        if (chats.length === lastChatCount) return;
        lastChatCount = chats.length;

        if (!chats.length) {
          stream.replaceChildren(emptyHint);
          return;
        }

        const nodes = chats.map((c) => {
          const isOut = c.from === 'host';
          const bubble = el('div', { class: `hub-bubble ${isOut ? 'out' : 'in'}` });

          const textEl = el('div', { text: c.text });
          bubble.append(textEl);

          const meta = el('div', { class: 'hub-status', style: 'display: flex; gap: 6px; justify-content: flex-end; align-items: center; font-size: 10px; margin-top: 2px;' });
          if (c.toClipboard) {
            const clipPill = el('span', { class: 'pill muted', text: tr('Clipboard'), style: 'font-size: 9px; padding: 1px 4px;' });
            meta.append(clipPill);
          }
          if (c.time) {
            const timeStr = UI.ago ? UI.ago(c.time) : new Date(c.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            meta.append(el('span', { text: timeStr }));
          }
          bubble.append(meta);
          return bubble;
        });

        stream.replaceChildren(...nodes);
        stream.scrollTop = stream.scrollHeight;
      };
    },
  });
})();

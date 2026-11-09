// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Terminal tab: shells both ways as two direction cards, with any computer. The other computer →
// here: it opens a shell here (Windows' OpenSSH Server, sshd.js). Here → the other computer: a
// shell there (terminal.js), also as `ssh twindesk` in any terminal.
'use strict';

UI.tab({
  id: 'terminal',
  wifiOnly: true, // over Bluetooth it can't work and doesn't move the session onto Wi-Fi: says so, with Connect with Wi-Fi Direct
  for: ['computer'], // another computer's (shared/ui-kinds.js)
  order: 60,
  title: I18n.t('Terminal'),
  color: 'linear-gradient(#3a3a3c, #1c1c1e)',
  desc: I18n.t('Open a terminal on the other computer.'),
  badge: (s) => (s.terminal.status === 'unavailable' || s.terminal.status === 'error' ? 'warn' : s.terminal.status === 'ready' || (s.terminal.server.info && s.terminal.server.info.enabled) ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    // Mac → PC (server here)
    const srvPill = el('span', { class: 'pill' });
    const setupBtn = UI.button(I18n.t('Set up'), () => api.setupSshd(), 'small primary');
    const srvRow = UI.row(I18n.t('SSH server'), '', [srvPill, setupBtn]);
    const macRow = UI.row('', '');
    // PC → Mac (client here)
    const pill = el('span', { class: 'pill' });
    const openBtn = UI.button(I18n.t('Open Terminal'), () => api.openTerminal(), 'small primary');
    const status = UI.row(I18n.t('Shell on {name}'), '', [pill, openBtn]);
    const cmdRow = UI.row(I18n.t('In any terminal'), '', [el('code', { class: 'mono', text: 'ssh twindesk' })]);
    const pair = UI.dirCards(
      { on: { get: (s) => s.terminal.allowMac, set: (v) => api.setTerminal({ allowMac: v }) }, label: I18n.t('Let {name} open a terminal on {me}'), rows: [
        srvRow,
        macRow,
      ] },
      { on: { get: (s) => s.terminal.enabled, set: (v) => api.setTerminal({ enabled: v }) }, label: I18n.t('Open a terminal on {name} from {me}'), rows: [
        status,
        cmdRow,
      ] },
    );
    body.append(pair.el);
    const TEXT = { off: I18n.t('Off'), no_mac: I18n.t('Waiting for {name}'), waiting: I18n.t('Asking {name}…'), ready: I18n.t('Ready'), unavailable: I18n.t('Not available'), error: I18n.t('Problem') };
    const SRV = { running: I18n.t('Running'), stopped: I18n.t('Stopped'), missing: I18n.t('Not installed'), unknown: '' };
    return (s) => {
      const t = s.terminal;
      const v = t.server;
      pair.update(s);
      srvPill.textContent = v.busy ? I18n.t('Setting up…') : SRV[v.service] || v.service;
      srvPill.className = 'pill ' + (v.service === 'running' ? 'good' : v.busy ? 'muted' : 'bad');
      setupBtn.hidden = v.service === 'running' || v.busy || !t.allowMac;
      srvRow.setHint(v.message ? I18n.t(v.message) : (v.service === 'running' ? '' : I18n.t('Asks for administrator rights once')));
      macRow.hidden = !t.allowMac;
      macRow.label.textContent = v.info && v.info.enabled ? I18n.t('Ready') : v.macAsked ? I18n.t('Not ready yet') : I18n.t('Waiting for {name}');
      macRow.setHint(v.macAsked && !(v.info && v.info.enabled) && v.service !== 'running' ? I18n.t('Set up the SSH server first') : '');

      pill.textContent = TEXT[t.status] || t.status;
      pill.className = 'pill ' + (t.status === 'ready' ? 'good' : t.status === 'unavailable' || t.status === 'error' ? 'bad' : 'muted');
      openBtn.disabled = t.status !== 'ready';
      status.setHint(t.message ? I18n.t(t.message) : (t.status === 'ready' ? I18n.t('As {user}', { user: t.user }) : t.status === 'unavailable' ? (UI.peer(s).os === 'mac' ? I18n.t('Turn on Remote Login on {name}') : I18n.t('Set up the SSH server on {name}')) : ''));
      cmdRow.hidden = t.status !== 'ready';
    };
  },
});

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Terminal tab: shells both ways, no passwords — keys travel over the paired link.
'use strict';

UI.tab({
  id: 'terminal',
  wifiOnly: true, // over Bluetooth it can't work and doesn't move the session onto Wi-Fi: says so, with Connect with Wi-Fi Direct
  for: ['computer'], // another computer's (shared/ui-kinds.js)
  group: 'More',
  order: 60,
  title: I18n.t('Terminal'),
  desc: I18n.t('Open a shell on the other computer. No passwords needed.'),
  color: 'linear-gradient(#3a3a3c, #1c1c1e)',
  badge: (s) => (s.terminal && (s.terminal.allowPc || s.terminal.connectPc) ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const outSw = UI.switch((v) => api.setTerminal({ connectPc: v }), { label: I18n.t('Open shells there') });
    const shellBtn = UI.button(I18n.t('Open'), () => api.openPcShell(), 'small');
    const outRow = UI.row(I18n.t('Open shells on {name} from {me}'), '', [outSw], { literalHint: true });
    const cmdRow = UI.row(I18n.t('In Terminal'), '', [el('code', { class: 'mono', text: 'ssh twindesk' }), shellBtn]);
    const inSw = UI.switch((v) => api.setTerminal({ allowPc: v }), { label: I18n.t('Allow shells here') });
    const inRow = UI.row(I18n.t('Let {name} open shells on {me}'), '', [inSw], { literalHint: true });
    const rl = UI.row(I18n.t('Remote Login'), '', [UI.button(I18n.t('Settings'), () => api.openSharingSettings(), 'small')]);
    const how = UI.row(I18n.t('On {name}'), '', [el('code', { class: 'mono', text: 'ssh twindesk' })]);
    body.append(
      UI.pair(
        UI.dir('m2w', [outRow, cmdRow]),
        UI.dir('w2m', [inRow, rl, how]),
      ),
    );
    return (s) => {
      const t = s.terminal;
      if (!t) return;
      const pc = UI.peer(s).name;
      const o = t.toPc || {};
      outSw.set(t.connectPc);
      shellBtn.hidden = !o.ready;
      const WHY = { waiting: I18n.t('Waiting for {device}…', { device: pc }), not_allowed: I18n.t('Turned off on {device}', { device: pc }), remote_login_off: UI.peer(s).os === 'mac' ? I18n.t('Turn on Remote Login on {device}', { device: pc }) : I18n.t('Set up the SSH server in TwinDesk on {device}', { device: pc }),
        bluetooth: I18n.t('The terminal doesn’t work over Bluetooth. Connect with Wi-Fi Direct, or join {device}’s network.', { device: pc }) };
      outRow.setHint(!t.connectPc ? '' : o.ready ? I18n.t('Ready, signed in as {user}', { user: o.user }) : WHY[o.why] || (o.why ? I18n.t('Not ready: {why}', { why: o.why }) : I18n.t('Waiting for {device}', { device: pc })));
      cmdRow.setHint('');
      inSw.set(t.allowPc);
      inRow.setHint(!t.allowPc ? '' : t.installed ? I18n.t('Ready') : I18n.t('Turn on Terminal in TwinDesk on {device}', { device: pc }));
      rl.setHint(t.remoteLogin ? I18n.t('On') : t.remoteLogin === false ? I18n.t('Off. Turn it on in Sharing settings.') : '');
    };
  },
});

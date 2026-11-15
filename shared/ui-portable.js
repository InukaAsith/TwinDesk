// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Portable (windows/portable.js): a pill beside the name, as Multi-device's MESH, saying
// PORTABLE · LIMITED (without administrator rights) or PORTABLE · FULL (as administrator), and a card
// on General with what this run can and can't do. The state's `portable` is null in an installed app:
// then there's no pill and no card.
//   UI.portablePill(state)                      (app.js, every state)
//   const p = UI.portableCard(); p.card; p.update(state)   (ui-general.js)
'use strict';

(function () {
  const t = (...a) => (typeof I18n === 'undefined' ? a[0] : I18n.t(...a));

  let pill = null;
  UI.portablePill = (s) => {
    const p = s && s.portable;
    const name = document.querySelector('.app-name');
    if (!name) return;
    if (!p) { if (pill) pill.hidden = true; return; }
    if (!pill) {
      pill = UI.el('span', { class: 'mesh-pill portable-pill' }, [UI.el('span', { class: 'portable-word', text: t('PORTABLE') }), UI.el('span', { class: 'portable-level' })]);
      name.append(pill);
    }
    pill.hidden = false;
    const full = p.level === 'full';
    pill.classList.toggle('limited', !full);
    pill.lastChild.textContent = ' · ' + (full ? t('FULL') : t('LIMITED'));
    pill.title = full ? t('TwinDesk Portable, running as administrator: everything it can do without installing')
      : t('TwinDesk Portable, without administrator rights: what needs an administrator is off');
  };

  // What each level does (windows/portable.js and ps.js decide; this says it).
  const NEEDS_ADMIN = ['Fix the firewall for TwinDesk', 'Share a folder with the Mac (SMB)', 'Wake on LAN', 'SSH keys of administrator accounts'];
  const NEVER = ['Virtual display', 'Virtual camera', 'Real gamepad', 'Installing OpenSSH Server', 'Calls’ sound on this PC', 'Full KVM', 'Updating itself'];

  UI.portableCard = () => {
    const level = UI.row(t('TwinDesk Portable'), '', [], { literal: true });
    const admin = UI.row(t('Needs administrator'), '', [], { literal: true });
    const never = UI.row(t('Needs the installed TwinDesk'), NEVER.map((x) => t(x)).join(' · '), [], { literal: true });
    const card = UI.card(t('Portable'), [level, admin, never]);
    card.hidden = true;
    return {
      card,
      update(s) {
        const p = s && s.portable;
        card.hidden = !p;
        if (!p) return;
        const full = p.level === 'full';
        level.setHint(full
          ? t('Running as administrator: everything that works without installing, the steps that need an administrator included')
          : t('Running without administrator rights. Everything else works; to use what needs an administrator, close TwinDesk and run it again with Run as administrator'));
        admin.setHint((full ? t('On') : t('Off')) + ' · ' + NEEDS_ADMIN.map((x) => t(x)).join(' · '));
      },
    };
  };
})();

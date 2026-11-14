// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Full KVM tab (docs/full-kvm.md), the Full KVM build only: loaded by ../edload.js when the
// build's own preload (linux/fullkvm/preload.js, windows/fullkvm/preload.js) gave window.tdFullKvm.
// Off, Signed in (the service: lock screen, UAC or polkit prompts, Ctrl+Alt+Del, admin windows) or
// Always (also the login screen, with a machine copy of this computer's pairings). Each change asks
// for an administrator once.
'use strict';

(function () {
  const api = window.tdFullKvm;
  if (!api) return;

  UI.tab({
    id: 'fullkvm',
    order: 96,
    for: ['computer', 'android'],
    title: 'Full KVM',
    color: 'linear-gradient(#5e5ce6, #3634a3)',
    desc: 'The mouse and keyboard on the lock screen, admin prompts and the login screen.',
    build(body) {
      const t = (...a) => I18n.t(...a);
      let st = null;
      let busy = false;
      let asked = 0;

      const seg = UI.segmented([
        { value: 'off', label: t('Off') },
        { value: 'simple', label: t('Signed in') },
        { value: 'system', label: t('Always') },
      ], (mode) => choose(mode));
      const modeRow = UI.row(t('Where the mouse and keyboard reach'), '', [seg]);
      const statusRow = UI.row(t('Service'), '', []);
      const err = UI.note('warn', '');
      const warn = UI.note('info', '');

      body.append(
        UI.card(t('Full KVM'), [modeRow, statusRow, err]),
        UI.card(t('What each one does'), [
          UI.row(t('Off'), t('As in TwinDesk: the pointer stops at the lock screen, admin prompts and windows run as administrator'), []),
          UI.row(t('Signed in'), t('A system service carries the mouse and keyboard to the lock screen, admin prompts (UAC, polkit), Ctrl+Alt+Del and windows run as administrator, while someone is signed in'), []),
          UI.row(t('Always'), t('Also the login screen, after a restart or sign-out: the service keeps this computer in the mesh with a copy of its pairings, so the others can sign in on it'), []),
        ]),
        warn,
      );
      warn.set(t('Anyone paired with this computer can then approve admin prompts and type on the lock screen. Turn it on only with devices you trust.'));

      const HINT = {
        off: 'Not installed',
        simple: 'Signed in: the lock screen, admin prompts and admin windows',
        system: 'Always: the login screen too',
      };

      function show() {
        if (!st) return;
        seg.set(st.mode);
        modeRow.setHint(t(HINT[st.mode] || ''));
        const parts = [];
        if (busy) parts.push(t('Waiting for the administrator’s approval…'));
        else if (st.mode === 'off') parts.push(t('Not installed'));
        else {
          parts.push(st.active ? t('Running') : t('Installed, not running'));
          parts.push(st.connected ? t('this app’s mouse and keyboard go through it') : t('not connected to this app yet'));
        }
        statusRow.setHint(parts.join(' · '));
        err.set(st.error ? t(st.error) : '');
      }

      async function refresh() {
        try { st = await api.state(); } catch (_) { return; }
        show();
      }

      async function choose(mode) {
        if (busy || !st || mode === st.mode) return;
        busy = true;
        show();
        try { st = await api.set(mode); } catch (e) { st = { ...st, error: String(e && e.message || e) }; }
        busy = false;
        show();
      }

      refresh();
      return () => {
        const now = Date.now();
        if (now - asked > 2000 && !busy) { asked = now; refresh(); } // the service's state isn't pushed: asked now and then
      };
    },
  });
})();

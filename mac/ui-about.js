// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// About tab (same cards on all three apps): the app icon and version, update checks, the
// maker, this computer, the app's build and the licence. Facts come from shared/about.js.
'use strict';

UI.tab({
  id: 'about',
  order: 110,
  title: I18n.t('About'),
  color: 'linear-gradient(#64d2ff, #0a84ff)',
  desc: '',
  bottom: true,
  badge: (s) => (s.updates && s.updates.available ? '1' : ''),
  build(body) {
    const { el, api } = UI;
    const t = (...args) => I18n.t(...args);
    const link = (label, key) => UI.button(label, () => api.openLink(key), 'small');
    // A card of label → value rows; set({label: text}) fills them and hides the empty ones.
    const facts = (title, labels) => {
      const vals = {};
      const rows = labels.map((label) => {
        vals[label] = el('span', { class: 'value selectable', attrs: { 'data-literal': '' } });
        return UI.row(t(label), '', [vals[label]]);
      });
      const card = UI.card(title, rows, { cls: 'keep-on' });
      card.set = (map) => labels.forEach((label, i) => {
        const t = map[label];
        vals[label].textContent = t == null ? '' : String(t);
        rows[i].hidden = t == null || t === '';
      });
      return card;
    };
    const nameEl = el('div', { class: 'about-name', text: 'TwinDesk', attrs: { 'data-literal': '' } });
    const verEl = el('div', { class: 'about-ver', attrs: { 'data-literal': '' } });
    const hero = el('div', { class: 'card about-hero keep-on' }, [
      el('div', { class: 'about-icon', attrs: { role: 'img', 'aria-label': t('TwinDesk icon') } }),
      nameEl,
      verEl,
      el('div', { class: 'about-tag', text: t('Use two computers as one desk') }),
    ]);

    // Updates: new releases of TwinDesk on GitHub.
    const updStatus = el('span', { class: 'value', attrs: { 'data-literal': '' } });
    const updCheck = UI.button(t('Check now'), () => api.checkUpdates(), 'small');
    const updNotes = UI.button(t('What’s New'), () => window.UpdaterModal && window.UpdaterModal.show(), 'small');
    const updUnskip = UI.button(t('Don’t skip'), () => api.unskipUpdate && api.unskipUpdate(), 'small');
    const updGet = UI.button(t('Download'), () => api.openUpdate(), 'small primary');
    const updRow = UI.row('TwinDesk', '', [updStatus, updNotes, updUnskip, updGet, updCheck], { literal: true });
    const updAuto = UI.switch((v) => api.setUpdates({ auto: v }), { label: t('Check for updates automatically') });

    const pc = facts(t('This computer'), ['Computer name', 'System', 'Kernel', 'Processor', 'Memory', 'Architecture']);
    const build = facts(t('This app'), ['Version', 'Built for', 'Electron', 'Chromium', 'Node.js']);
    const thanksRow = UI.row(t('Thanks'), '', [], { literal: true });

    body.append(
      hero,
      UI.card(t('Updates'), [
        updRow,
        UI.row(t('Check automatically'), t('Looks for new releases on GitHub every few hours'), [updAuto]),
      ], { cls: 'keep-on' }),
      UI.card(t('Made by'), [
        UI.row('Inuka Asith', 'inukaasith.vercel.app', [link(t('Portfolio'), 'portfolio')]),
        UI.row(t('Source code'), 'github.com/InukaAsith/TwinDesk', [link('GitHub', 'github')]),
        UI.row(t('All releases'), t('Downloads for macOS, Windows and Linux'), [link(t('Releases'), 'releases')]),
        UI.row(t('Log files'), t('What TwinDesk did and any crash, to attach to a bug report'), [link(t('Open log folder'), 'logs')]),
      ], { cls: 'keep-on' }),
      pc,
      build,
      UI.card(t('Licence'), [
        UI.row(t('GNU General Public License v3'), t('Free and open source. Copyright © 2026 inukaasith'), [link(t('Read'), 'licence')]),
        thanksRow,
        UI.row('Crafted with ☕ and ❤️ in Sri Lanka 🇱🇰', '', [], { literal: true }),
      ], { cls: 'keep-on' }),
    );

    return (s) => {
      const a = s.about || { app: {}, pc: {} };
      nameEl.textContent = a.app.name || 'TwinDesk';
      verEl.textContent = t('Version {version}', { version: a.app.version || s.version || '' });
      thanksRow.setHint(a.app.thanks || '');
      thanksRow.hidden = !a.app.thanks;
      pc.set({
        'Computer name': a.pc.host,
        System: a.pc.os,
        Kernel: a.pc.kernel,
        Processor: a.pc.cpu ? a.pc.cpu + (a.pc.cores ? t(' · {count} cores', { count: a.pc.cores }) : '') : '',
        Memory: a.pc.memory,
        Architecture: a.pc.arch,
      });
      build.set({ Version: a.app.version, 'Built for': a.app.arch, Electron: a.app.electron, Chromium: a.app.chrome, 'Node.js': a.app.node });
      const u = s.updates;
      if (u) {
        updAuto.set(u.auto);
        updCheck.disabled = u.checking;
        updGet.hidden = !u.available;
        updNotes.hidden = !u.available;
        updUnskip.hidden = !u.available || !u.skipped;
        updStatus.textContent = u.checking ? t('Checking…')
          : u.available
            ? t(u.skipped ? '{version} is available (skipped)' : '{version} is available', { version: u.latest })
            : u.checkedAt ? t('Up to date') : '';
        const action = u.download ? t('Download {file}', { file: u.download.name }) : t('Opens the release page');
        const checked = u.checkedAt ? t(' · checked {time}', { time: new Date(u.checkedAt).toLocaleTimeString(I18n.locale, { hour: 'numeric', minute: '2-digit' }) }) : '';
        updRow.setHint(u.error ? t('Couldn’t check: {error}', { error: u.error })
          : u.available ? t('You have {version}. {action}', { version: u.current, action })
            : u.noReleases ? t('Version {version}. No releases published yet', { version: u.current })
              : t('Version {version}{checked}', { version: u.current, checked }));
      }
    };
  },
});

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
    const link = (label, key) => UI.button(label, () => api.openLink(key), 'small');
    // A card of label → value rows; set({label: text}) fills them and hides the empty ones.
    const facts = (title, labels) => {
      const vals = {};
      const rows = labels.map((label) => {
        vals[label] = el('span', { class: 'value selectable', attrs: { 'data-literal': '' } });
        return UI.row(I18n.t(label), '', [vals[label]]);
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
      el('div', { class: 'about-icon', attrs: { role: 'img', 'aria-label': I18n.t('TwinDesk icon') } }),
      nameEl,
      verEl,
      el('div', { class: 'about-tag', text: I18n.t('Use two computers as one desk') }),
    ]);

    // Updates: new releases of TwinDesk on GitHub.
    const updStatus = el('span', { class: 'value' });
    const updCheck = UI.button(I18n.t('Check now'), () => api.checkUpdates(), 'small');
    const updNotes = UI.button(I18n.t('What’s New'), () => window.UpdaterModal && window.UpdaterModal.show(), 'small');
    const updUnskip = UI.button(I18n.t('Don’t skip'), () => api.unskipUpdate && api.unskipUpdate(), 'small');
    const updGet = UI.button(I18n.t('Download'), () => api.openUpdate(), 'small primary');
    const updRow = UI.row('TwinDesk', '', [updStatus, updNotes, updUnskip, updGet, updCheck], { literal: true });
    const updAuto = UI.switch((v) => api.setUpdates({ auto: v }), { label: I18n.t('Check for updates automatically') });

    const pc = facts(I18n.t('This computer'), ['Computer name', 'System', 'Kernel', 'Processor', 'Memory', 'Architecture']);
    const build = facts(I18n.t('This app'), ['Version', 'Built for', 'Electron', 'Chromium', 'Node.js']);
    const thanksRow = UI.row(I18n.t('Thanks'), '');

    body.append(
      hero,
      UI.card(I18n.t('Updates'), [
        updRow,
        UI.row(I18n.t('Check automatically'), I18n.t('Looks for new releases on GitHub every few hours'), [updAuto]),
      ], { cls: 'keep-on' }),
      UI.card(I18n.t('Made by'), [
        UI.row('Inuka Asith', 'inukaasith.vercel.app', [link(I18n.t('Portfolio'), 'portfolio')]),
        UI.row(I18n.t('Source code'), 'github.com/InukaAsith/TwinDesk', [link('GitHub', 'github')]),
        UI.row(I18n.t('All releases'), I18n.t('Downloads for macOS, Windows and Linux'), [link(I18n.t('Releases'), 'releases')]),
        UI.row(I18n.t('Log files'), I18n.t('What TwinDesk did and any crash, to attach to a bug report'), [link(I18n.t('Open log folder'), 'logs')]),
      ], { cls: 'keep-on' }),
      pc,
      build,
      UI.card(I18n.t('Licence'), [
        UI.row(I18n.t('GNU General Public License v3'), I18n.t('Free and open source. Copyright © 2026 inukaasith'), [link(I18n.t('Read'), 'licence')]),
        thanksRow,
        UI.row('Crafted with ☕ and ❤️ in Sri Lanka 🇱🇰', '', [], { literal: true }),
      ], { cls: 'keep-on' }),
    );

    return (s) => {
      const a = s.about || { app: {}, pc: {} };
      nameEl.textContent = a.app.name || 'TwinDesk';
      verEl.textContent = I18n.t('Version {version}', { version: a.app.version || s.version || '' });
      thanksRow.setHint(a.app.thanks || '');
      thanksRow.hidden = !a.app.thanks;
      pc.set({
        'Computer name': a.pc.host,
        System: a.pc.os,
        Kernel: a.pc.kernel,
        Processor: a.pc.cpu ? a.pc.cpu + (a.pc.cores ? I18n.t(' · {count} cores', { count: a.pc.cores }) : '') : '',
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
        updStatus.textContent = u.checking ? I18n.t('Checking…')
          : u.available
            ? I18n.t(u.skipped ? '{version} is available (skipped)' : '{version} is available', { version: u.latest })
            : u.checkedAt ? I18n.t('Up to date') : '';
        updRow.setHint(u.error ? I18n.t('Couldn’t check: {error}', { error: I18n.t(u.error) })
          : u.available ? I18n.t('You have {version}. {action}', { version: u.current, action: u.download ? I18n.t('Download {file}', { file: u.download.name }) : I18n.t('Opens the release page') })
            : u.noReleases ? I18n.t('Version {version}. No releases published yet', { version: u.current })
              : I18n.t('Version {version}{checked}', { version: u.current, checked: u.checkedAt ? I18n.t(' · checked {time}', { time: new Date(u.checkedAt).toLocaleTimeString(I18n.locale, { hour: 'numeric', minute: '2-digit' }) }) : '' }));
      }
    };
  },
});

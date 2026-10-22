// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// About tab (same cards on all three apps): the app icon and version, update checks, this
// computer, the app's build, the maker and the licence. Facts come from shared/about.js.
'use strict';

UI.tab({
  id: 'about',
  order: 110,
  title: 'About',
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
        vals[label] = el('span', { class: 'value selectable' });
        return UI.row(label, '', [vals[label]]);
      });
      const card = UI.card(title, rows, { cls: 'keep-on' });
      card.set = (map) => labels.forEach((label, i) => {
        const t = map[label];
        vals[label].textContent = t == null ? '' : String(t);
        rows[i].hidden = t == null || t === '';
      });
      return card;
    };
    const nameEl = el('div', { class: 'about-name', text: 'TwinDesk Mesh' });
    const verEl = el('div', { class: 'about-ver' });
    const hero = el('div', { class: 'card about-hero keep-on' }, [
      el('div', { class: 'about-icon', attrs: { role: 'img', 'aria-label': 'TwinDesk icon' } }),
      nameEl,
      verEl,
      el('div', { class: 'about-tag', text: 'Use two computers as one desk' }),
    ]);

    // Updates: new releases of TwinDesk on GitHub.
    const updStatus = el('span', { class: 'value' });
    const updCheck = UI.button('Check now', () => api.checkUpdates(), 'small');
    let updCan = false;
    const updGet = UI.button('Update now', () => (updCan ? api.installUpdate() : api.openUpdate()), 'small primary');
    const updRow = UI.row('TwinDesk Mesh', '', [updStatus, updGet, updCheck]);
    const updAuto = UI.switch((v) => api.setUpdates({ auto: v }), { label: 'Check for updates automatically' });
    const updBeta = UI.switch((v) => api.setUpdates({ channel: v ? 'beta' : 'stable' }), { label: 'Include beta releases' });
    const updSelf = UI.switch((v) => api.setUpdates({ install: v ? 'auto' : 'ask' }), { label: 'Install updates automatically' });
    const updSrc = UI.row('Update source', '', []);

    const pc = facts('This computer', ['Computer name', 'System', 'Kernel', 'Processor', 'Memory', 'Architecture']);
    const build = facts('This app', ['Version', 'Built for', 'Electron', 'Chromium', 'Node.js']);
    const thanksRow = UI.row('Thanks', '');

    body.append(
      hero,
      UI.card('Updates', [
        updRow,
        UI.row('Check automatically', 'Looks for new releases on GitHub every few hours', [updAuto]),
        UI.row('Beta releases', 'Pre-releases from the same project, to try changes early', [updBeta]),
        UI.row('Install automatically', 'Downloads and restarts TwinDesk by itself when nothing is being shared. Your settings and permissions stay', [updSelf]),
        updSrc,
      ], { cls: 'keep-on' }),
      pc,
      build,
      UI.card('Made by', [
        UI.row('Inuka Asith', 'inukaasith.vercel.app', [link('Portfolio', 'portfolio')]),
        UI.row('Source code', 'github.com/InukaAsith/TwinDesk', [link('GitHub', 'github')]),
        UI.row('All releases', 'Downloads for macOS, Windows and Linux', [link('Releases', 'releases')]),
      ], { cls: 'keep-on' }),
      UI.card('Licence', [
        UI.row('GNU General Public License v3', 'Free and open source. Copyright © 2026 inukaasith', [link('Read', 'licence')]),
        thanksRow,
      ], { cls: 'keep-on' }),
    );

    return (s) => {
      const a = s.about || { app: {}, pc: {} };
      nameEl.textContent = a.app.name || 'TwinDesk Mesh';
      verEl.textContent = 'Version ' + (a.app.version || s.version || '');
      thanksRow.setHint(a.app.thanks || '');
      thanksRow.hidden = !a.app.thanks;
      pc.set({
        'Computer name': a.pc.host,
        System: a.pc.os,
        Kernel: a.pc.kernel,
        Processor: a.pc.cpu ? a.pc.cpu + (a.pc.cores ? ' · ' + a.pc.cores + ' cores' : '') : '',
        Memory: a.pc.memory,
        Architecture: a.pc.arch,
      });
      build.set({ Version: a.app.version, 'Built for': a.app.arch, Electron: a.app.electron, Chromium: a.app.chrome, 'Node.js': a.app.node });
      const u = s.updates;
      if (u) {
        updCan = !!u.canInstall;
        updAuto.set(u.auto);
        updBeta.set(u.channel === 'beta');
        updSelf.set(u.install === 'auto');
        updSrc.setHint('github.com/' + u.repo + ' · ' + (u.channel === 'beta' ? 'beta' : 'stable') + ' channel');
        const busy = u.state === 'downloading' || u.state === 'installing';
        updCheck.disabled = u.checking || busy;
        updGet.disabled = busy;
        updGet.hidden = !u.available;
        updStatus.textContent = u.state === 'downloading' ? 'Downloading… ' + Math.round((u.progress || 0) * 100) + '%'
          : u.state === 'installing' ? 'Restarting…'
            : u.checking ? 'Checking…' : u.available ? u.latest + (u.prerelease ? ' (beta)' : '') + ' is available' : u.checkedAt ? 'Up to date' : '';
        updRow.setHint(u.error ? 'Couldn’t update: ' + u.error
          : u.available ? 'You have ' + u.current + '. ' + (u.canInstall && u.download ? 'Updates in place and restarts; your settings and permissions stay' : u.download ? 'Download ' + u.download.name : 'Opens the release page')
            : u.noReleases ? 'Version ' + u.current + '. No releases published yet'
              : 'Version ' + u.current + (u.checkedAt ? ' · checked ' + new Date(u.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''));
      }
    };
  },
});

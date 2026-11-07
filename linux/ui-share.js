// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Share screen (copy of windows/ui-share.js): this computer's screen in a window on the
// other computer, controlled from there. Mirror shows an existing monitor; Extend adds an extra
// (virtual) screen (vdd.js: Mutter's on GNOME Wayland, a spare output on X11, which needs the
// helper Install puts in once). On Wayland the desktop asks which screen to share each time sharing starts.
'use strict';

UI.tab({
  id: 'pc-mac',
  group: 'Display',
  order: 11,
  title: 'Share screen',
  heading: '{me}’s screen on {name}',
  icon: 'display',
  color: 'linear-gradient(#5ac8fa, #0a84ff)',
  desc: 'See {me} in a window on the other computer.',
  master: { get: (s) => s.pcScreen.mode !== 'off', set: (v) => UI.api.setPcScreenMode(v ? 'last' : 'off') },
  badge: (s) => (s.pcScreen.status === 'live' ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const t = (...args) => I18n.t(...args);
    const driverMessage = (message) => {
      const prefixes = ['Couldn’t check the display driver: ', 'Installing the display driver failed: ', 'Removing the display driver failed: ', 'Couldn’t switch the virtual monitor: '];
      const prefix = prefixes.find((value) => (message || '').startsWith(value));
      return prefix ? t(prefix + '{error}', { error: message.slice(prefix.length) }) : t(message || '');
    };
    const set = (partial) => api.setPcScreen(partial);
    const mode = UI.segmented([
      { value: 'off', label: t('Off') },
      { value: 'extend', label: t('Extend') },
      { value: 'mirror', label: t('Mirror') },
    ], (v) => api.setPcScreenMode(v));
    const monitor = UI.select([], (v) => set({ monitor: v }));
    const extendSize = UI.select([
      { value: 'mac', label: t('Same as the other screen') },
      { value: '1920x1080', label: '1920 × 1080' },
      { value: '2560x1440', label: '2560 × 1440' },
      { value: '3840x2160', label: '3840 × 2160' },
    ], (v) => set({ extendSize: v }));
    const streamSize = UI.select([
      { value: 1080, label: t('1080p (1920 × 1080), fastest') },
      { value: 1440, label: t('1440p (2560 × 1440), sharper') },
      { value: 2160, label: t('4K (3840 × 2160), sharpest') },
      { value: 0, label: t('Full size') },
    ], (v) => set({ maxHeight: Number(v) }));
    const quality = UI.select([
      { value: 10, label: t('Low, 10 Mbps') },
      { value: 20, label: t('Medium, 20 Mbps') },
      { value: 30, label: t('High, 30 Mbps') },
      { value: 50, label: t('Best, 50 Mbps (wired)') },
      { value: 80, label: t('Max, 80 Mbps (wired)') },
    ], (v) => set({ mbps: Number(v) }));
    const paceRow = UI.paceRow(); // One Playback setting, synced with the other computer
    // Frame rate: the monitor's refresh rate unless capped (pcscreen.js; a change starts a new session).
    const frameRate = UI.select([
      { value: 0, label: t('Match the display') },
      { value: 60, label: t('60 fps') },
      { value: 30, label: t('30 fps, lighter') },
    ], (v) => set({ fps: Number(v) }));
    const codecRow = UI.codecRow((v) => set({ codec: v })); // Encoder (shared/screencodec.js)
    const sound = UI.switch((v) => set({ sound: v }), { label: t('Include sound') });
    const input = UI.switch((v) => set({ input: v }), { label: t('Receive input') });
    const inputRow = UI.row(t('Receive input'), '', [input], { literal: true }); // "Receive input from Mac" / "from PC2"
    const remote = UI.switch((v) => set({ remote: v }), { label: t('Remote start') });
    const remoteRow = UI.row(t('Let the other computer start and switch this screen'), '', [remote], { literal: true }); // screen.ctl

    const monitorRow = UI.row(t('Display'), '', [monitor], { literal: true });
    const extendRow = UI.row(t('Size'), '', [extendSize]);
    const details = UI.details(['Status', 'Display', 'Picture', 'Speed', 'Round trip', 'Codec', 'Encoder', 'Frames dropped']);

    const note = UI.note('info', '', { literal: true });
    // X11: Extend's screen is a spare output switched on through a small root helper (vdd.js).
    const installBtn = UI.button(t('Install'), () => api.installVdd(), 'small primary');
    const removeBtn = UI.button(t('Remove'), () => api.removeVdd(), 'small');
    const driver = UI.row(t('TwinDesk virtual display'), '', [installBtn, removeBtn]);
    const driverCard = UI.card('', [driver], { cls: 'keep-on' });

    body.append(
      UI.card(t('Screen'), [UI.row(t('Mode'), '', [mode]), monitorRow, extendRow]),
      UI.card(t('screen.picture'), [UI.row(t('Resolution'), '', [streamSize]), UI.row(t('Quality'), '', [quality]), UI.row(t('Frame rate'), '', [frameRate]), paceRow, codecRow], { cls: 'keep-on' }),
      UI.card(t('Sound and control'), [UI.row(t('Include sound'), '', [sound]), inputRow], { cls: 'keep-on' }),
      UI.card(t('Remote'), [remoteRow], { cls: 'keep-on' }),
      details,
      driverCard,
      note,
    );

    return (s) => {
      const p = s.pcScreen;
      const connected = s.link.state === 'connected';
      mode.set(p.mode);
      const v = p.vdd;
      mode.el.querySelectorAll('button').forEach((b, i) => { b.disabled = p.busy || (i === 1 && !v.installed); });
      monitor.options(p.monitors.map((m) => ({ value: m.id, label: UI.monitorLabel(m.label) })));
      monitor.set(p.monitor || (p.monitors.find((m) => /\(main\)$/.test(m.label)) || p.monitors[0] || { id: '' }).id);
      monitorRow.hidden = p.mode === 'extend';
      extendRow.hidden = p.mode !== 'extend';
      extendSize.set(p.extendSize);
      extendRow.setHint(p.extendSize === 'mac' ? p.extendPx[0] + ' × ' + p.extendPx[1] : '');
      streamSize.set(p.maxHeight);
      quality.set(p.mbps);
      frameRate.set(p.fps || 0);
      paceRow.render(s);
      codecRow.render(p.codec);
      sound.set(p.sound);
      input.set(p.input);
      remote.set(p.remote);

      const on = p.mode !== 'off';
      const st = p.status === 'live' && p.stats;
      const who = UI.peer(s).the;
      const mon = p.monitors.find((m) => m.id === p.monitor) || p.monitors.find((m) => /\(main\)$/.test(m.label)) || p.monitors[0];
      details.set({
        Status: (!on ? t('Off') : p.busy ? t('Starting the extra screen…') : p.status === 'live' ? t('On {device}', { device: who })
          : !connected ? t('Waiting for {device}', { device: who }) : !p.mac.accept ? t('Ready, starts when {device} opens it', { device: who }) : t('Connecting…')) + (p.error ? ': ' + t(p.error) : ''),
        Display: !on ? '' : p.mode === 'extend' ? t('Virtual monitor, {width} × {height}', { width: p.extendPx[0], height: p.extendPx[1] }) : mon ? UI.monitorLabel(mon.label) : '',
        Picture: st ? `${st.width} × ${st.height}, ${st.fps} fps` : '',
        Speed: st ? (st.targetMbps ? t('{mbps} Mbps sent, network allows {targetMbps}', { mbps: st.mbps, targetMbps: st.targetMbps }) : t('{mbps} Mbps sent', { mbps: st.mbps })) : '',
        'Round trip': st && st.rttMs != null ? st.rttMs + ' ms' : '',
        Codec: st && st.codec ? st.codec.toUpperCase() : '',
        Encoder: st && st.encoder ? UI.codecImpl(st.encoder, st.hw) : '',
        'Frames dropped': st ? st.dropped || 0 : '',
      });

      inputRow.label.textContent = t('Receive input from {device}', { device: UI.peer(s).them });
      remoteRow.label.textContent = t('Let {device} start and switch this screen', { device: UI.peer(s).the });
      remoteRow.setHint(p.remote ? t('Opening the screen window there starts sharing; Extend and Mirror can be switched from there.') : '');
      const wayland = s.session && s.session.type === 'wayland';
      monitorRow.hidden = wayland || p.mode === 'extend';
      driverCard.hidden = !(v.setup || v.removable || v.busy);
      installBtn.hidden = !v.setup;
      installBtn.disabled = !!v.busy;
      installBtn.textContent = v.busy === 'install' ? t('Installing…') : t('Install');
      removeBtn.hidden = !v.removable;
      removeBtn.disabled = !!v.busy || p.mode === 'extend';
      driver.setHint(v.busy === 'remove' ? t('Removing…') : v.busy === 'install' ? t('Installing…') : v.hint ? t(v.hint) : v.removable ? t('Installed. Adds the extra screen for Extend.')
        : t('Adds an extra screen for Extend by switching on a spare display output. Installs a small helper and asks for your password once.'));
      const extend = !v.checked || (v.setup && !v.message) ? '' : !v.installed ? t(v.message || 'Extend isn’t available on this desktop') + '.'
        : v.message ? t(v.message) + '.' : '';
      note.set([
        wayland ? (p.mode === 'extend' ? t('Wayland: your desktop asks which screen to share each time sharing starts, choose “Virtual remote monitor”.') : t('Wayland: your desktop asks which screen to share each time sharing starts.'))
          + (s.session.input === 'uinput' ? '' : ' ' + t('Input from {device} needs input access (General).', { device: UI.peer(s).the })) : '',
        extend,
      ].filter(Boolean).join(' '));
    };
  },
});

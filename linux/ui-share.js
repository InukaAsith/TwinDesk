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
  master: { get: (s) => s.pcScreen.mode !== 'off', set: (v) => UI.api.setPcScreenMode(v ? 'mirror' : 'off') },
  badge: (s) => (s.pcScreen.status === 'live' ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const set = (partial) => api.setPcScreen(partial);
    const mode = UI.segmented([
      { value: 'off', label: 'Off' },
      { value: 'extend', label: 'Extend' },
      { value: 'mirror', label: 'Mirror' },
    ], (v) => api.setPcScreenMode(v));
    const monitor = UI.select([], (v) => set({ monitor: v }));
    const extendSize = UI.select([
      { value: 'mac', label: 'Same as the other screen' },
      { value: '1920x1080', label: '1920 × 1080' },
      { value: '2560x1440', label: '2560 × 1440' },
      { value: '3840x2160', label: '3840 × 2160' },
    ], (v) => set({ extendSize: v }));
    const streamSize = UI.select([
      { value: 1080, label: '1080p (1920 × 1080), fastest' },
      { value: 1440, label: '1440p (2560 × 1440), sharper' },
      { value: 0, label: 'Full size' },
    ], (v) => set({ maxHeight: Number(v) }));
    const quality = UI.select([
      { value: 10, label: 'Low, 10 Mbps' },
      { value: 20, label: 'Medium, 20 Mbps' },
      { value: 30, label: 'High, 30 Mbps' },
      { value: 50, label: 'Best, 50 Mbps (wired)' },
    ], (v) => set({ mbps: Number(v) }));
    const paceRow = UI.paceRow(); // One Playback setting, synced with the other computer
    const sound = UI.switch((v) => set({ sound: v }), { label: 'Include sound' });
    const input = UI.switch((v) => set({ input: v }), { label: 'Receive input' });
    const inputRow = UI.row('Receive input', '', [input]); // "Receive input from Mac" / "from PC2"
    const remote = UI.switch((v) => set({ remote: v }), { label: 'Remote start' });
    const remoteRow = UI.row('Let the other computer start and switch this screen', '', [remote]); // screen.ctl

    const monitorRow = UI.row('Display', '', [monitor]);
    const extendRow = UI.row('Size', '', [extendSize]);
    const details = UI.details(['Status', 'Display', 'Picture', 'Speed', 'Round trip', 'Codec', 'Encoder', 'Frames dropped']);

    const note = UI.note('info', '');
    // X11: Extend's screen is a spare output switched on through a small root helper (vdd.js).
    const installBtn = UI.button('Install', () => api.installVdd(), 'small primary');
    const removeBtn = UI.button('Remove', () => api.removeVdd(), 'small');
    const driver = UI.row('TwinDesk virtual display', '', [installBtn, removeBtn]);
    const driverCard = UI.card('', [driver], { cls: 'keep-on' });

    body.append(
      UI.card('Screen', [UI.row('Mode', '', [mode]), monitorRow, extendRow]),
      UI.card('Picture', [UI.row('Resolution', '', [streamSize]), UI.row('Quality', '', [quality]), paceRow], { cls: 'keep-on' }),
      UI.card('Sound and control', [UI.row('Include sound', '', [sound]), inputRow], { cls: 'keep-on' }),
      UI.card('Remote', [remoteRow], { cls: 'keep-on' }),
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
      monitor.options(p.monitors.map((m) => ({ value: m.id, label: m.label })));
      monitor.set(p.monitor || (p.monitors.find((m) => /\(main\)$/.test(m.label)) || p.monitors[0] || { id: '' }).id);
      monitorRow.hidden = p.mode === 'extend';
      extendRow.hidden = p.mode !== 'extend';
      extendSize.set(p.extendSize);
      extendRow.setHint(p.extendSize === 'mac' ? p.extendPx[0] + ' × ' + p.extendPx[1] : '');
      streamSize.set(p.maxHeight);
      quality.set(p.mbps);
      paceRow.render(s);
      sound.set(p.sound);
      input.set(p.input);
      remote.set(p.remote);

      const on = p.mode !== 'off';
      const st = p.status === 'live' && p.stats;
      const who = UI.peer(s).the;
      const mon = p.monitors.find((m) => m.id === p.monitor) || p.monitors.find((m) => /\(main\)$/.test(m.label)) || p.monitors[0];
      details.set({
        Status: (!on ? 'Off' : p.busy ? 'Starting the extra screen…' : p.status === 'live' ? 'On ' + who
          : !connected ? 'Waiting for ' + who : !p.mac.accept ? 'Ready, starts when ' + who + ' opens it' : 'Connecting…') + (p.error ? ': ' + p.error : ''),
        Display: !on ? '' : p.mode === 'extend' ? `Virtual monitor, ${p.extendPx[0]} × ${p.extendPx[1]}` : mon ? mon.label : '',
        Picture: st ? `${st.width} × ${st.height}, ${st.fps} fps` : '',
        Speed: st ? `${st.mbps} Mbps sent` + (st.targetMbps ? `, network allows ${st.targetMbps}` : '') : '',
        'Round trip': st && st.rttMs != null ? st.rttMs + ' ms' : '',
        Codec: st && st.codec ? st.codec.toUpperCase() : '',
        Encoder: st && st.encoder ? UI.codecImpl(st.encoder, st.hw) : '',
        'Frames dropped': st ? st.dropped || 0 : '',
      });

      inputRow.label.textContent = 'Receive input from ' + UI.peer(s).them;
      remoteRow.label.textContent = 'Let ' + UI.peer(s).the + ' start and switch this screen';
      remoteRow.setHint(p.remote ? 'Opening the screen window there starts sharing; Extend and Mirror can be switched from there.' : '');
      const wayland = s.session && s.session.type === 'wayland';
      monitorRow.hidden = wayland || p.mode === 'extend';
      driverCard.hidden = !(v.setup || v.removable || v.busy);
      installBtn.hidden = !v.setup;
      installBtn.disabled = !!v.busy;
      installBtn.textContent = v.busy === 'install' ? 'Installing…' : 'Install';
      removeBtn.hidden = !v.removable;
      removeBtn.disabled = !!v.busy || p.mode === 'extend';
      driver.setHint(v.busy === 'remove' ? 'Removing…' : v.busy === 'install' ? 'Installing…' : v.hint ? v.hint : v.removable ? 'Installed. Adds the extra screen for Extend.'
        : 'Adds an extra screen for Extend by switching on a spare display output. Installs a small helper and asks for your password once.');
      const extend = !v.checked || (v.setup && !v.message) ? '' : !v.installed ? (v.message || 'Extend isn’t available on this desktop') + '.'
        : v.message ? v.message + '.' : '';
      note.set([
        wayland ? 'Wayland: your desktop asks which screen to share each time sharing starts' + (p.mode === 'extend' ? ', choose “Virtual remote monitor”.' : '.')
          + (s.session.input === 'uinput' ? '' : ' Input from ' + UI.peer(s).the + ' needs input access (General).') : '',
        extend,
      ].filter(Boolean).join(' '));
    };
  },
});

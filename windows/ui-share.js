// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Display › PC → Mac: this PC's screen in a window on the Mac, controlled from there.
// Mirror shows an existing monitor; Extend adds an extra (virtual) screen (vdd.js).
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

    const installBtn = UI.button('Install', () => api.installVdd(), 'small primary');
    const removeBtn = UI.button('Remove', () => api.removeVdd(), 'small');
    const driver = UI.row('TwinDesk virtual display', '', [installBtn, removeBtn]); // Extend's screen, from the Virtual Display Driver (vdd.js)
    const note = UI.note('bad', '');
    // No driver: Extend is greyed out; say why, with Install right there.
    const missingBtn = UI.button('Install', () => api.installVdd(), 'small primary');
    const missing = el('div', { class: 'note warn' }, [el('span', { text: 'Virtual display driver not installed. Install it to use Extend.' }), missingBtn]);
    missing.style.alignItems = 'center';
    missing.style.justifyContent = 'space-between';

    // This PC's monitors as the OS arranges them (boxes), and what each connected device gets.
    const map = el('div', { class: 'screen-map' });
    map.style.cssText = 'position:relative;height:120px;margin:8px 0';
    const targetsBox = el('div', { class: 'screen-targets' });
    let targetsKey = '';
    const drawMap = (displays, targets) => {
      map.textContent = '';
      if (!displays.length) return;
      const x0 = Math.min(...displays.map((d) => d.x)), y0 = Math.min(...displays.map((d) => d.y));
      const w = Math.max(...displays.map((d) => d.x + d.w)) - x0, h = Math.max(...displays.map((d) => d.y + d.h)) - y0;
      const k = Math.min(100 / h, 100 / w * (map.clientWidth || 480) / 100, 1);
      for (const d of displays) {
        const who = targets.filter((t) => t.mode === 'mirror' && t.monitor === d.id).map((t) => t.name);
        const box = el('div', { text: [d.name + (d.primary ? ' (main)' : ''), d.w + ' × ' + d.h].concat(who.length ? ['→ ' + who.join(', ')] : []).join(String.fromCharCode(10)) });
        box.style.cssText = `position:absolute;box-sizing:border-box;border:1px solid var(--accent,#0a84ff);border-radius:4px;font-size:11px;white-space:pre;overflow:hidden;padding:2px 4px;opacity:${who.length ? 1 : 0.6};`
          + `left:${(d.x - x0) * k}px;top:${(d.y - y0) * k}px;width:${d.w * k}px;height:${d.h * k}px`;
        map.append(box);
      }
      map.style.height = h * k + 'px';
    };
    const drawTargets = (p) => {
      const key = JSON.stringify([p.targets, p.monitors, p.vdd.installed]);
      if (key === targetsKey) return;
      targetsKey = key;
      targetsBox.textContent = '';
      for (const t of p.targets) {
        const seg = UI.segmented([{ value: 'off', label: 'Off' }, { value: 'extend', label: 'Extend' }, { value: 'mirror', label: 'Mirror' }],
          (v) => api.setPcScreenTarget(t.id, { mode: v, displayId: t.monitor || undefined }));
        seg.set(t.mode);
        seg.el.querySelectorAll('button').forEach((b, i) => { b.disabled = t.busy || (i === 1 && !p.vdd.installed); });
        const sel = UI.select(p.monitors.map((m) => ({ value: m.id, label: m.label })), (v) => api.setPcScreenTarget(t.id, { mode: 'mirror', displayId: v }));
        sel.set(t.monitor || (p.monitors.find((m) => /\(main\)$/.test(m.label)) || p.monitors[0] || { id: '' }).id);
        sel.el.hidden = t.mode !== 'mirror';
        targetsBox.append(UI.row(t.name, t.error || '', [seg, sel]));
      }
    };
    const screens = UI.card('Displays', [map, targetsBox]);

    body.append(
      missing,
      screens,
      UI.card('Screen', [UI.row('Mode', '', [mode]), monitorRow, extendRow]),
      UI.card('Picture', [UI.row('Resolution', '', [streamSize]), UI.row('Quality', '', [quality]), paceRow], { cls: 'keep-on' }),
      UI.card('Sound and control', [UI.row('Include sound', '', [sound]), inputRow], { cls: 'keep-on' }),
      UI.card('Remote', [remoteRow], { cls: 'keep-on' }),
      details,
      UI.card('', [driver, note], { cls: 'keep-on' }),
    );

    return (s) => {
      const p = s.pcScreen;
      const v = p.vdd;
      const connected = s.link.state === 'connected';
      screens.hidden = !(p.displays && p.displays.length);
      drawMap(p.displays || [], p.targets || []);
      targetsBox.hidden = !p.targets || p.targets.length < 2; // one device: the Screen card below does it all
      if (!targetsBox.hidden) drawTargets(p);
      mode.set(p.mode);
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
        Display: !on ? '' : p.mode === 'extend' ? `TwinDesk virtual display, ${p.extendPx[0]} × ${p.extendPx[1]}` : mon ? mon.label : '',
        Picture: st ? `${st.width} × ${st.height}, ${st.fps} fps` : '',
        Speed: st ? `${st.mbps} Mbps sent` + (st.targetMbps ? `, network allows ${st.targetMbps}` : '') : '',
        'Round trip': st && st.rttMs != null ? st.rttMs + ' ms' : '',
        Codec: st && st.codec ? st.codec.toUpperCase() : '',
        Encoder: st && st.encoder ? UI.codecImpl(st.encoder, st.hw) : '',
        'Frames dropped': st ? st.dropped || 0 : '',
      });

      missing.hidden = !v.checked || v.installed;
      missingBtn.disabled = !!v.busy;
      missingBtn.textContent = v.busy === 'install' ? 'Installing…' : 'Install';
      installBtn.hidden = v.installed;
      installBtn.disabled = !!v.busy || !v.checked;
      installBtn.textContent = v.busy === 'install' ? 'Installing…' : 'Install';
      removeBtn.hidden = !v.installed;
      removeBtn.disabled = !!v.busy || p.mode === 'extend';
      driver.setHint(v.busy === 'remove' ? 'Removing…' : v.busy === 'install' ? 'Installing…' : v.installed ? 'Installed. Adds the extra screen for Extend.' : 'Adds an extra screen for Extend. Installs a display driver and asks for administrator rights once.');
      inputRow.label.textContent = 'Receive input from ' + UI.peer(s).them;
      remoteRow.label.textContent = 'Let ' + UI.peer(s).the + ' start and switch this screen';
      remoteRow.setHint(p.remote ? 'Opening the screen window there starts sharing; Extend and Mirror can be switched from there.' : '');
      note.set(v.message);
    };
  },
});

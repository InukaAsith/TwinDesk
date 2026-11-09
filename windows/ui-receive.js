// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Display › Mac → PC: the Mac's screen in the Monitor 2 window; this PC owns the window, the screen
// sound volume and F11/F9. When the other computer lets us (its screen.state `remote`),
// Open and the switch start/stop its sharing there and Extend | Mirror switches it (screen.ctl).
// No "Open automatically" — the other computer sends nothing until Open here.
'use strict';

UI.tab({
  id: 'mac-pc',
  for: ['computer'], // another computer's (shared/ui-kinds.js)
  group: 'Display',
  order: 10,
  title: 'Receive screen',
  heading: '{Name}’s screen on {me}',
  icon: 'receive',
  color: 'linear-gradient(#5ac8fa, #0a84ff)',
  desc: 'See the other computer’s screen in a window here.',
  master: {
    get: (s) => s.stream.state === 'on' || !!(s.stream.remote && s.stream.remote.on),
    set: (v) => (v ? UI.api.openMonitor() : UI.api.remoteScreen({ share: false })),
    disabled: (s) => s.link.state !== 'connected' || !(s.stream.remote && s.stream.remote.remote),
  },
  badge: (s) => (s.stream.state === 'on' || (s.stream.remote && s.stream.remote.on) ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const t = (...args) => I18n.t(...args);
    const openBtn = UI.button(t('Open'), () => api.openMonitor(), 'primary');
    const winRow = UI.row(t('Screen window'), '', [openBtn], { literal: true });
    // (as the Mac): one control, the same three choices as on the other computer itself,
    // kept in step by its screen.state; choosing sends screen.ctl.
    const mode = UI.segmented([
      { value: 'off', label: t('Off') },
      { value: 'mirror', label: t('Mirror') },
      { value: 'extend', label: t('Extend') },
    ], (v) => api.remoteScreen(v === 'off' ? { share: false } : { share: true, mode: v }));
    const modeRow = UI.row(t('{Name} shares'), '', [mode]);
    const volume = UI.slider({ min: 0, max: 1, step: 0.05, format: (v) => Math.round(v * 100) + '%' }, (v) => api.setMonitor({ volume: v }));
    const mute = UI.switch((v) => api.setMonitor({ mute: !v }), { label: t('Play sound') });
    const paceRow = UI.paceRow(); // One Playback setting, synced with the other computer
    const framegen = UI.switch((v) => api.setMonitor({ framegen: v }), { label: t('Frame generation') });

    const details = UI.details(['Status', 'Display', 'Picture', 'Speed', 'Round trip', 'Codec', 'Decoder', 'Delay', 'Frames dropped', 'Freezes']);

    // A Mac can also mirror here by itself, with AirPlay (shared/ui-web.js; Receive AirPlay on).
    const airplayTip = UI.airplayMacTip ? UI.airplayMacTip() : null;
    body.append(
      ...(airplayTip ? [airplayTip.el] : []),
      UI.card('', [
        winRow,
        modeRow,
        paceRow,
        UI.row(t('Frame generation'), t('Fills in late or dropped frames, and adds in-between frames when this screen is faster than the stream'), [framegen]),
        UI.row(t('Sound'), '', [mute, volume]),
        UI.row(t('Full screen'), '', [el('kbd', { text: 'F11' })]),
      ], { cls: 'keep-on' }),
      details,
    );

    return (s) => {
      if (airplayTip) airplayTip.update(s);
      const st = s.stream;
      const on = st.state === 'on';
      const connected = s.link.state === 'connected';
      openBtn.disabled = !connected;
      openBtn.textContent = st.watching ? t('Show') : t('Open');
      const who = UI.peer(s).the;
      const sharing = on || !!(st.remote && st.remote.on); // on over there, maybe paused while nobody watches
      const r = st.remote;
      winRow.setHint(!connected ? t('Waiting for {device}', { device: who }) : on ? t('Showing {screen}', { screen: st.name }) : sharing ? t('Sharing on {device}. Open to watch.', { device: who })
        : r && r.remote ? t('Open starts sharing on {device}', { device: who }) : t('Turn on sharing on {device}', { device: who }));
      mode.set(r ? (r.on ? r.mode : 'off') : '');
      const MODES = ['off', 'mirror', 'extend'];
      mode.el.querySelectorAll('button').forEach((b, i) => { b.disabled = !connected || !r || !r.remote || (i > 0 && !(r.modes || []).includes(MODES[i])); });
      modeRow.setHint(!connected ? t('Connect to choose from here')
        : !r ? t('Update TwinDesk on the other computer to choose from here')
          : !r.remote ? t('The other computer doesn’t allow choosing from here')
            : r.on ? (r.mode === 'extend' ? t('An extra screen for it, shown here') : t('Its main screen, shown here')) : t('Pick Mirror or Extend, or just press Open'));
      mute.set(!s.monitor.mute);
      volume.set(s.monitor.volume);
      paceRow.render(s);
      framegen.set(s.monitor.framegen);
      const x = on && st.stats;
      details.set({
        Status: !connected ? t('Not connected') : !on ? (sharing ? t('Paused, nobody watching') : t('Off')) : s.macInput ? t('Live') : t('Live, view only'),
        Display: on ? st.name + (st.width ? ', ' + st.width + ' × ' + st.height : x ? ', ' + x.width + ' × ' + x.height : '') : '',
        Picture: x ? x.width + ' × ' + x.height + ', ' + x.fps + ' fps' : '',
        Speed: x ? t('{mbps} Mbps received', { mbps: x.mbps }) : '',
        'Round trip': x && x.rttMs != null ? x.rttMs + ' ms' : '',
        Codec: x ? x.codec.toUpperCase() : '',
        Decoder: x && x.decoder ? UI.codecImpl(x.decoder, x.hw) : '',
        Delay: x ? x.delayMs + ' ms' : '',
        'Frames dropped': x ? x.dropped : '',
        Freezes: x ? x.freezes || 0 : '',
      });
    };
  },
});

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Display › PC → Mac: the PC's screen in a window on this Mac. Same structure as
// Mac → PC; the PC picks what it shares (Off / Mirror / Extend), this Mac picks how it shows it.
'use strict';

UI.tab({
  id: 'receive',
  for: ['computer'], // another computer's (shared/ui-kinds.js)
  group: 'Display',
  order: 11,
  title: I18n.t('Receive screen'),
  heading: I18n.t('{name} on {me}'),
  icon: 'receive',
  desc: I18n.t('See its screen in a window here.'),
  color: 'linear-gradient(#5ac8fa, #0a84ff)',
  // The switch is the screen window (open = watching = the other side sends).
  master: { get: (s) => !!(s.receive && s.receive.open), set: (v) => (v ? UI.api.showPcView() : UI.api.closePcView()) },
  badge: (s) => (s.receive && s.receive.status === 'live' ? 'on' : ''),
  build(body) {
    const { el, api } = UI;
    const STATUS = { off: I18n.t('Off'), connecting: I18n.t('Connecting…'), new: I18n.t('Connecting…'), live: I18n.t('Live'), disconnected: I18n.t('Reconnecting…'), failed: I18n.t('Waiting for {name}…'), stopped: I18n.t('Stopped on the other computer'), closed: I18n.t('Closed') };

    const fullSw = UI.switch((v) => api.setReceive({ fullScreen: v }), { label: I18n.t('Open full screen') });
    const inputSw = UI.switch((v) => api.setReceive({ input: v }), { label: I18n.t('Control it') });
    const ctlRow = UI.row(I18n.t('Control {name} from its window'), '', [inputSw]);
    const showBtn = UI.button(I18n.t('Open'), () => api.showPcView(), 'primary');
    const winRow = UI.row(I18n.t('Screen window'), '', [showBtn], { literalHint: true });
    // Run the other computer's sharing from here (screen.ctl), when it allows that.
    // One control, the same three choices as on the PC itself, kept in step (screen.state).
    const rMode = UI.segmented([
      { value: 'off', label: I18n.t('Off') },
      { value: 'mirror', label: I18n.t('Mirror') },
      { value: 'extend', label: I18n.t('Extend') },
    ], (v) => api.remoteScreen(v === 'off' ? { share: false } : { share: true, mode: v }));
    const rRow = UI.row(I18n.t('{name} shares'), '', [rMode]);
    rRow.label.dataset.peer = I18n.t('{name} shares');
    const paceRow = UI.paceRow();
    const fgSw = UI.switch((v) => api.setReceive({ framegen: v }), { label: I18n.t('Frame generation') });
    const fgRow = UI.row(I18n.t('Frame generation'), I18n.t('Fills in late or dropped frames, and adds in-between frames when this screen is faster than the stream'), [fgSw]);

    const live = {
      status: UI.row(I18n.t('Status'), ''), picture: UI.row(I18n.t('screen.picture'), ''), rate: UI.row(I18n.t('Speed'), ''), rtt: UI.row(I18n.t('Round trip'), ''),
      codec: UI.row(I18n.t('Codec'), ''), decoder: UI.row(I18n.t('Decoder'), ''), delay: UI.row(I18n.t('Delay'), ''), smooth: UI.row(I18n.t('Smoothness'), ''),
    };
    const vals = Object.fromEntries(Object.entries(live).map(([k, r]) => {
      const v = el('span', { class: 'value' });
      r.querySelector('.controls').append(v);
      return [k, v];
    }));

    body.append(
      UI.card('', [
        winRow,
        rRow,
        UI.row(I18n.t('Open full screen'), I18n.t('Ctrl ⌘ F switches'), [fullSw]),
        ctlRow,
        paceRow,
        fgRow,
      ], { cls: 'keep-on' }),
      UI.card(I18n.t('Details'), Object.values(live), { cls: 'keep-on' }),
    );

    return (s) => {
      const r = s.receive;
      if (!r) return;
      fullSw.set(r.fullScreen);
      paceRow.render(s);
      fgSw.set(!!r.framegen);
      const rs = r.remote;
      rMode.set(rs ? (rs.on ? rs.mode : 'off') : '');
      rMode.disable(!s.client || !rs || !rs.remote);
      rRow.setHint(!s.client ? I18n.t('Connect to choose from here')
        : !rs ? I18n.t('Update TwinDesk on the other computer to choose from here')
          : !rs.remote ? I18n.t('The other computer doesn’t allow choosing from here')
            : rs.on ? (rs.mode === 'extend' ? I18n.t('An extra screen for it, shown here') : I18n.t('Its main screen, shown here')) : I18n.t('Pick Mirror or Extend — or just press Open'));
      inputSw.set(r.input);
      const p = UI.peer(s);
      const pc = p.name;
      showBtn.textContent = r.open ? I18n.t('Show') : I18n.t('Open');
      const canStart = r.remote && r.remote.remote;
      winRow.setHint(!s.client ? I18n.t('Waiting for {device}', { device: pc })
        : r.session ? I18n.t('Showing {device}', { device: pc }) : canStart ? I18n.t('Open starts it on {device}', { device: pc }) : I18n.t('Choose what to share in TwinDesk on {device}', { device: pc }));
      const st = r.stats;
      const isLive = r.status === 'live' && st;
      vals.status.textContent = UI.fill(STATUS[r.status] || r.status);
      vals.picture.textContent = isLive ? `${st.width} × ${st.height} · ${st.fps} fps` : '';
      vals.rate.textContent = isLive ? `${st.mbps} Mbps` : '';
      vals.rtt.textContent = s.client && s.client.rttMs != null ? `${s.client.rttMs} ms` : '';
      vals.codec.textContent = isLive && st.codec ? st.codec : '';
      vals.decoder.textContent = isLive && st.decoder ? st.decoder.endsWith(' (hw)') ? UI.codecImpl(st.decoder.slice(0, -5), true) : st.decoder : '';
      vals.delay.textContent = isLive && st.bufferMs != null ? I18n.t('{buffer} ms buffer · {decode} ms decode', { buffer: st.bufferMs, decode: st.decodeMs }) : '';
      vals.smooth.textContent = isLive ? I18n.t('{dropped} dropped · {freezes} freezes', { dropped: st.dropped || 0, freezes: st.freezes || 0 }) + (st.framegen ? I18n.t(' · frame generation on') : '') : '';
      for (const k of ['picture', 'rate', 'rtt', 'codec', 'decoder', 'delay', 'smooth']) live[k].hidden = !vals[k].textContent;
    };
  },
});

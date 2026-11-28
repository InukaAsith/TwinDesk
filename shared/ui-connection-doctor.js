// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Connection troubleshooter (PR #289's Connection Doctor) reads the selected link's existing state. It never starts checks or changes settings.
'use strict';

UI.connectionDoctor = (platform) => {
  const { el } = UI;
  const t = window.I18n.t;
  const mac = platform === 'mac', linux = platform === 'linux';
  const row = (label) => UI.row(label, '');
  const linkRow = row(t('Transport'));
  const discoveryRow = row(t('Discovery'));
  const networkRow = mac ? row(t('Local Network')) : row(t('Firewall'));
  const platformRow = mac ? row(t('Screen Recording')) : linux ? row(t('Desktop session')) : null;
  const accessRow = mac ? row(t('mac.accessibility')) : linux ? row(t('Input')) : null;
  const adbRow = row(t('Wireless debugging'));
  const streamRow = row(t('Screen sharing'));
  const rows = el('div', { attrs: { id: 'connection-doctor-rows' }, hidden: true },
    [linkRow, discoveryRow, networkRow, platformRow, accessRow, adbRow, streamRow]);
  const toggle = UI.button(t('Show'), () => {
    rows.hidden = !rows.hidden;
    toggle.textContent = rows.hidden ? t('Show') : t('Hide');
    toggle.setAttribute('aria-expanded', String(!rows.hidden));
    if (!rows.hidden && last) render(last);
  }, 'small');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'connection-doctor-rows');
  const card = UI.card(t('Connection troubleshooter'), [rows], { actions: [toggle] });
  let last = null;
  const permission = (allowed) => allowed === true ? t('Allowed') : allowed === false ? t('Not allowed') : t('Unknown');

  function render(s) {
    const link = mac ? s.guest?.status : s.link;
    const peer = mac ? s.client : linux ? s.peerSession : s.session;
    const connected = !!peer && (mac || link?.state === 'connected');
    const phone = s.phone?.connected;
    const phoneSelected = connected && !!peer.id && peer.id === phone?.id;
    if (connected) {
      const transport = phoneSelected && phone.usb ? t('USB cable')
        : UI.onBle(s) || s.net?.onGroup || s.net?.lan ? UI.via(s) : 'IP';
      const rtt = mac ? peer.rttMs : link.rtt;
      linkRow.setHint(Number.isFinite(rtt) && rtt >= 0 ? `${transport}, ${t('Round-trip time')} ${rtt} ms` : transport);
    } else {
      const status = link?.state;
      linkRow.setHint(s.phone?.returning || status === 'reconnecting' ? t('Reconnecting…')
        : s.pairing || (mac && s.guest?.pairing) ? t('Pairing…')
          : status === 'connecting' ? t('Connecting…')
            : status === 'identity_changed' ? t('Identity could not be verified') : t('Not connected'));
    }

    discoveryRow.setHint(s.discovery?.on === true ? t('On') : s.discovery?.on === false ? t('Off') : t('Unknown'));
    if (mac) {
      networkRow.setHint(permission(s.discovery?.localNetwork));
      const screen = s.permissions?.screen;
      platformRow.setHint(permission(screen === 'granted' ? true : ['denied', 'restricted', 'not-determined'].includes(screen) ? false : null));
      accessRow.setHint(permission(s.permissions?.accessibility));
    } else {
      const firewall = s.firewall;
      networkRow.setHint(firewall?.checking ? t('Checking…')
        : firewall?.error || firewall?.unread || firewall?.ok == null || (linux && !firewall.tool) ? t('Unknown') : firewall.ok ? t('Ready') : t('Problem'));
      if (linux) {
        platformRow.setHint(s.session?.type === 'wayland' ? 'Wayland' : s.session?.type === 'x11' ? 'X11' : t('Unknown'));
        accessRow.hidden = s.session?.access?.uinput == null && !s.session?.helperError;
        if (!accessRow.hidden) accessRow.setHint(s.session.helperError ? t('Problem') : permission(s.session.access.uinput));
      }
    }

    adbRow.hidden = !phoneSelected || (mac ? peer?.os : phone.os) !== 'android';
    if (!adbRow.hidden) {
      const adb = s.phone.bridge;
      adbRow.setHint(adb?.state === 'ready' ? adb.inputBlocked ? t('Touch blocked') : t('Ready')
        : adb?.state === 'needsPair' ? t('Not paired') : adb?.state === 'waitingWifi' ? t('Waiting for Wi-Fi')
          : adb?.state === 'error' || adb?.state === 'missing' ? t('Problem') : t('Not in use'));
    }

    const candidate = mac ? s.stream : s.pcScreen;
    // Explicit identities are supplied by Mac and Windows Multi-device senders.
    const scoped = candidate && (mac
      ? (candidate.deviceId ? candidate.deviceId === peer?.id : !s.mesh)
      : (!s.mesh || linux || (candidate.deviceId && candidate.deviceId === peer?.id)));
    const stream = scoped ? candidate : null;
    const on = mac ? !!s.sharing?.on : !!stream && stream.mode !== 'off';
    const stats = mac ? stream : stream?.stats;
    const status = typeof stream?.status === 'string' ? stream.status : '';
    // A ready transport does not imply frames. Dimensions here need measured sender output.
    if (connected && on && status === 'live' && (mac || stream.sending) && stats &&
        stats.fps > 0 && stats.width > 0 && stats.height > 0) {
      const video = [`${stats.width} × ${stats.height}`, t('{value} fps', { value: stats.fps })];
      if (stats.mbps > 0) video.push(t('{value} Mb/s', { value: stats.mbps }));
      streamRow.setHint(video.join(', '));
    } else {
      streamRow.setHint(mac && s.sharing?.on === false ? t('Off') : !connected ? t('Not connected')
        : !mac && !scoped ? t('Unknown') : !on ? t('Off')
        : status.startsWith('error') || status === 'failed' ? t('Problem')
          : status === 'live' ? t('Ready') : status === 'waiting for Wi-Fi' ? t('Waiting for Wi-Fi')
            : t('Waiting for the picture…'));
    }
  }
  return {
    el: card,
    update(s) {
      last = s;
      if (!rows.hidden) render(s);
    },
  };
};

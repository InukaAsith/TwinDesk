// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Camera tab (Mac, PC and Linux): its switch at the top turns Camera on (off: nothing of it is
// loaded or runs, and nothing is shared); Start runs the other device's camera here. A
// phone's, back or front, through wireless debugging (phoneview.js openCamera, Android 12 or later;
// the phone's own Camera page starts it too); the other computer's, which it shares only with
// "Let … see this camera" on there (camshare.js). Its picture shows on the page (turned with
// Rotate), in a window with Window (or a click on the picture), and with Virtual camera on, in a
// camera every app here can pick ("TwinDesk Camera", shared/vcam.js), installed the first time
// it's turned on. This computer's own camera goes to the other one the same way.
'use strict';

(() => {
  const tr = (text, vars) => window.I18n ? window.I18n.t(text, vars)
    : text.replace(/\{(\w+)\}/g, (m, k) => vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);

  let cur = null; // the last state, for the switch at the top
  let facing = 'back'; // a phone's camera to start with

  // An Android phone's camera comes through wireless debugging; an iPhone shares its own as a
  // computer does (its app sends it: camshare.js), so it is treated as one here.
  const adbPhone = (s) => UI.deviceKind(s) === 'android'; // shared/ui-kinds.js (s.client is the Mac's alone: the PC and Linux sent an iPhone's through ADB)
  const phoneCam = (s) => ((s.phone && s.phone.bridge && s.phone.bridge.windows) || []).find((w) => w.kind === 'camera') || null;
  const running = (s) => (adbPhone(s) ? !!phoneCam(s) : !!(s.camera && s.camera.viewing));

  // Why it can't start now ('' when it can).
  function blocked(s) {
    const c = s.camera || {};
    if (adbPhone(s)) {
      const ph = s.phone || {};
      if (!ph.connected) return tr('Not connected');
      if (!ph.bridge || ph.bridge.state !== 'ready') return tr('Needs wireless debugging: set it up on the Phone page');
      return '';
    }
    if (!c.connected) return tr('Not connected');
    if (c.ble) return tr('Through Bluetooth a camera can’t go across: connect over Wi-Fi or a cable');
    if (!c.peerShares && !c.viewing) return tr('Turn on “Let {me} see this camera” on {name} first');
    return '';
  }

  function start(on, show = false) {
    const s = cur;
    if (!s) return;
    if (adbPhone(s)) UI.api.phoneCamera(on, on ? { facing, show } : undefined);
    else UI.api.camera({ do: on ? 'view' : 'close', show });
  }

  UI.tab({
    id: 'camera',
    group: 'More',
    order: 75,
    title: tr('Camera'),
    icon: 'camera',
    color: 'linear-gradient(#bf5af2, #8944ab)',
    desc: tr('The other device’s camera here, and as a camera other apps can pick.'),
    badge: (s) => (s.camera && s.camera.sending ? 'warn' : running(s) ? 'on' : ''),
    master: {
      get: (s) => !!(s.camera && s.camera.on),
      set: (v) => UI.api.camera({ do: 'on', on: v }),
    },
    build(body) {
      const { api, el } = UI;
      const cam = (m) => api.camera(m);

      // The picture: what the camera's window sends (a JPEG, about 12 a second). A click opens the window.
      const img = el('img', { alt: '' });
      Object.assign(img.style, { width: '100%', height: '100%', objectFit: 'contain', display: 'block' });
      const said = el('div', { attrs: { 'data-literal': '' } });
      Object.assign(said.style, { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', textAlign: 'center', padding: '0 24px', color: '#a1a1a6' });
      const box = el('div', { title: tr('Open it in a window') }, [img, said]);
      Object.assign(box.style, { position: 'relative', aspectRatio: '16 / 9', background: '#000', borderRadius: '8px', overflow: 'hidden', cursor: 'pointer', margin: '12px' });
      box.onclick = () => cur && running(cur) && start(true, true);
      let url = '';
      if (api.onCamPreview) {
        api.onCamPreview((buf) => {
          if (!cur || !running(cur)) return;
          const next = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
          img.onload = () => { if (url && url !== next) URL.revokeObjectURL(url); url = next; };
          img.src = next;
        });
      }

      const facingSeg = UI.segmented([{ value: 'back', label: window.I18n ? tr('camera.back') : 'Back' }, { value: 'front', label: window.I18n ? tr('camera.front') : 'Front' }], (v) => {
        facing = v;
        facingSeg.set(v);
        if (cur && running(cur)) api.phoneCamera(true, { facing: v }); // switches in the same window
      });
      facingSeg.set(facing);
      const rotate = UI.button(tr('Rotate'), () => cam({ do: 'rotate' }));
      rotate.title = tr('A quarter turn clockwise: here, in its window and in the virtual camera');
      const windowBtn = UI.button(tr('Window'), () => start(true, true));
      windowBtn.title = tr('Open it in a window');
      const startBtn = UI.button(tr('Start'), () => cur && start(!running(cur)));
      const controls = UI.row(tr('{name}’s camera'), '', [startBtn, facingSeg, rotate, windowBtn]);
      // More for the picture: mirrored (here, its window and the virtual camera), and for a phone's
      // camera its quality, light and zoom; Snapshot saves the picture as it shows here.
      const mirror = UI.switch((v) => cam({ do: 'mirror', on: v }), { label: tr('Mirror') });
      const mirrorRow = UI.row(tr('Mirror'), tr('Flipped left to right, as in a mirror: here, in its window and in the virtual camera'), [mirror]);
      const quality = UI.segmented([{ value: '1280', label: '720p' }, { value: '1920', label: '1080p' }, { value: '3840', label: '4K' }], (v) => { qual = Number(v); api.phoneCamera(true, { quality: qual }); });
      let qual = 1920;
      const qualityRow = UI.row(tr('Quality'), tr('The phone picks its nearest size. Higher needs a good connection'), [quality.el]);
      const light = UI.button(tr('Light'), () => api.phoneCamera(true, { do: 'torch' }));
      const zoomOut = UI.button('−', () => api.phoneCamera(true, { do: 'zoomOut' }));
      zoomOut.title = tr('Zoom out');
      const zoomIn = UI.button('+', () => api.phoneCamera(true, { do: 'zoomIn' }));
      zoomIn.title = tr('Zoom in');
      const snap = UI.button(tr('Snapshot'), () => {
        if (!img.src || img.hidden) return;
        const a = el('a', { attrs: { href: img.src, download: `Camera ${new Date().toISOString().slice(0, 19).replace(/:/g, '.')}.jpg` } });
        a.click();
      });
      snap.title = tr('Save the picture as it shows here');
      const phoneRow = UI.row(tr('Light and zoom'), '', [light, zoomOut, zoomIn, snap]);
      const picCard = UI.card('', [box, controls, mirrorRow, qualityRow, phoneRow]);

      // Virtual camera: the picture also goes to a camera other apps can pick.
      const virtual = UI.switch((v) => cam({ do: 'virtual', on: v }), { label: tr('Virtual camera') });
      const vRemove = UI.button(tr('Remove'), () => cam({ do: 'vcamRemove' }));
      const vRow = UI.row(tr('Virtual camera'), '', [vRemove, virtual], { literal: true });
      // Which camera it feeds, where there's a choice (the Mac: TwinDesk Camera or OBS Virtual Camera).
      const vTarget = UI.select([], (t) => cam({ do: 'vcamTarget', target: t }));
      const vTargetRow = UI.row(tr('Send to'), tr('The camera other apps pick'), [vTarget]);
      const vCard = UI.card(tr('Virtual camera'), [vTargetRow, vRow]);

      // This computer's camera there.
      const share = UI.switch((v) => cam({ do: 'share', on: v }), { label: tr('Share this camera') });
      const shareRow = UI.row(tr('Let {name} see this camera'), '', [share]);
      const device = UI.select([{ value: '', label: tr('The default camera') }], (v) => cam({ do: 'device', id: v }));
      const deviceRow = UI.row(tr('Camera'), tr('Which of {me}’s cameras it shows'), [device]);
      const stop = UI.button(tr('Stop'), () => cam({ do: 'stop' }), 'danger');
      const liveRow = UI.row(tr('{name} is viewing it now'), tr('The camera is on while it’s running there'), [stop]);
      const ourCard = UI.card(tr('{me}’s camera'), [shareRow, deviceRow, liveRow]);

      const note = UI.note('info', '');
      note.setAttribute('data-literal', '');
      // Take a photo / scan a document with the phone (shared/phonephoto.js). Each row is there
      // only where that action is wired, so a window without it never calls a missing API.
      const photoBtn = UI.button(tr('Take a photo'), () => api.takePhoto && api.takePhoto());
      const photoRow = UI.row(tr('Take a photo with the phone'), tr('Its camera opens. The photo comes here, copied and ready to paste, and is kept with received files'), [photoBtn]);
      const scanBtn = UI.button(tr('Scan document'), () => api.scanDocument && api.scanDocument());
      const scanRow = UI.row(tr('Scan a document with the phone'), tr('The phone’s camera scans pages into a PDF. It arrives with received files'), [scanBtn]);
      const photoCard = UI.card('', [photoRow, scanRow]);
      body.append(photoCard, picCard, vCard, ourCard, note);

      let listed = false;
      return (s) => {
        cur = s;
        const c = s.camera || {};
        const v = s.vcam || {};
        const phone = adbPhone(s);
        const on = running(s);
        const vName = `“${v.name || 'TwinDesk Camera'}”`;
        const w = phone ? phoneCam(s) : null;
        if (w && w.facing && w.facing !== facing) {
          facing = w.facing; // started or switched elsewhere (the phone's Camera page)
          facingSeg.set(facing);
        }

        // The picture, or what it's waiting for.
        const why = blocked(s);
        let text = '';
        if (!c.on) text = tr('Off: turn on Camera at the top');
        else if (!on) text = UI.fill(why || tr('Press Start to run {name}’s camera here'));
        else if (phone && w && w.error) text = tr('It stopped: {error}', { error: w.error });
        else if (!phone && c.viewStatus === 'refused') text = UI.fill(tr('Turn on “Let {me} see this camera” on {name}'));
        else if (!phone && c.viewStatus === 'failed') text = tr('It didn’t start: {error}', { error: c.viewError || tr('unknown') });
        else if (!phone && c.viewStatus === 'ended') text = UI.fill(tr('{name} stopped its camera'));
        else if (!v.picture) text = phone ? tr('Starting the phone’s camera…') : UI.fill(tr('Asking {name} for its camera…'));
        said.textContent = text;
        said.hidden = !text;
        img.hidden = !on || !!text;
        if (!on && url) {
          URL.revokeObjectURL(url);
          url = '';
          img.removeAttribute('src');
        }
        startBtn.textContent = on ? tr('Stop') : tr('Start');
        startBtn.disabled = !c.on || (!on && !!why);
        startBtn.title = !on && why ? UI.fill(why) : '';
        facingSeg.el.hidden = !phone;
        const phoneHere = !!(phone && s.phone && s.phone.connected);
        photoRow.hidden = !(phoneHere && api.takePhoto);
        scanRow.hidden = !(phoneHere && api.scanDocument);
        photoCard.hidden = photoRow.hidden && scanRow.hidden;
        rotate.disabled = !on;
        mirror.set(!!v.mirror);
        qualityRow.hidden = !phone;
        quality.set(String((w && w.quality) || qual));
        light.hidden = zoomOut.hidden = zoomIn.hidden = !phone;
        light.disabled = zoomOut.disabled = zoomIn.disabled = snap.disabled = !on || !!text;
        light.textContent = w && w.torch ? tr('Light ✓') : tr('Light');
        phoneRow.hidden = !on;
        phoneRow.label.textContent = phone ? tr('Light and zoom') : tr('Snapshot');
        windowBtn.disabled = !on;
        windowBtn.textContent = (phone ? w && w.shown : c.viewShown) ? tr('Window ✓') : tr('Window');
        controls.setHint(on ? tr('Turned {degrees}°. Click the picture or Window for a window of its own', { degrees: v.rotate || 0 }) : '');

        // Virtual camera.
        virtual.set(!!v.on);
        virtual.disable(v.supported === false || !!v.busy);
        vRemove.hidden = !v.installed || !!v.on || !!v.busy || v.removable === false;
        vTargetRow.hidden = !(v.targets && v.targets.length > 1);
        if (!vTargetRow.hidden) {
          vTarget.options(v.targets);
          vTarget.set(v.target || v.targets[0].value);
          vTarget.el.disabled = !!v.busy;
        }
        vRow.setHint(!v.checked ? tr('Checking…')
          : v.supported === false ? tr(v.message || '')
            : v.busy === 'install' ? tr(v.message || 'Installing…')
              : v.busy === 'remove' ? tr('Removing…')
                : v.ready && v.live ? tr('Sharing now: in Zoom, Teams, the browser…, choose only {camera} as the camera', { camera: vName })
                  : v.ready ? tr('Ready: the camera running here goes to {camera}. Choose only that one in the app you call from', { camera: vName })
                    : v.on ? tr(v.message || 'Not installed')
                      : tr(v.message || '') || tr('Off: the picture stays in TwinDesk. On: it’s also {camera}, a camera other apps can pick', { camera: vName }));

        // This computer's own camera (not with a phone).
        ourCard.hidden = phone;
        if (!phone) {
          share.set(!!c.share);
          shareRow.setHint(tr(c.shareError || '') || (c.share ? tr('{name} can run it there. A popup says so here when it does') : tr('Off: nobody sees it')));
          device.options([{ value: '', label: tr('The default camera') }, ...(c.devices || []).map((d) => ({ value: d.id, label: d.label }))]);
          device.set(c.device || '');
          deviceRow.hidden = !c.share;
          liveRow.hidden = !c.sending;
          if (c.share && !listed) {
            listed = true;
            cam({ do: 'devices' });
          }
        }

        const message = v.ready
          ? tr(phone ? 'Apps here see it as {camera}: pick that one, not {me}’s own camera.' : 'Apps here see it as {camera}: pick that one, not {me}’s own camera. The picture goes straight between the two computers.', { camera: vName, me: UI.fill('{me}') })
          : tr(phone ? 'Turn on Virtual camera to use it as a real camera in other apps (Zoom, Teams, the browser…).' : 'Turn on Virtual camera to use it as a real camera in other apps (Zoom, Teams, the browser…). The picture goes straight between the two computers.');
        note.textContent = message;
        note.hidden = !message;
      };
    },
  });
})();

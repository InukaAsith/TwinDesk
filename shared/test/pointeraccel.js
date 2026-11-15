// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// linux/pointeraccel.js: the desktop's mouse acceleration and touchpad (tap, natural scrolling) read
// from KDE's, Sway's and niri's settings.
'use strict';

const assert = require('assert');
const { parseKde, parseSway, parseNiri, read } = require('../../linux/pointeraccel.js');

(async () => {
  // KDE: the mouse's group, not the touchpad's; 1 is flat.
  const rc = [
    '[Libinput][1267][12608][ELAN0501:00 04F3:3140 Touchpad]',
    'PointerAcceleration=0.8',
    '',
    '[Libinput][1133][49271][Logitech USB Optical Mouse]',
    'PointerAccelerationProfile=1',
    'PointerAcceleration=-0.200',
    '',
    '[Mouse]',
    'X11LibInputXAccelProfileFlat=false',
  ].join('\n');
  const PAD = { padTap: true, padNatural: false };
  assert.deepStrictEqual(parseKde(rc), { accelProfile: 'flat', accelSpeed: -0.2, ...PAD });
  assert.deepStrictEqual(parseKde('[Libinput][1][2][Mouse]\nPointerAcceleration=0.5\n'), { accelProfile: 'adaptive', accelSpeed: 0.5, ...PAD });
  assert.deepStrictEqual(parseKde('[Mouse]\ncursorTheme=breeze\n'), { accelProfile: 'adaptive', accelSpeed: 0, ...PAD }, 'nothing set: the default');
  assert.deepStrictEqual(parseKde(rc.replace('PointerAcceleration=0.8', 'TapToClick=false\nNaturalScroll=true')), { accelProfile: 'flat', accelSpeed: -0.2, padTap: false, padNatural: true }, 'the touchpad group: tap and natural scrolling');
  assert.deepStrictEqual(parseKde('[Libinput][1][2][Mouse]\nPointerAcceleration=7\n'), { accelProfile: 'adaptive', accelSpeed: 1, ...PAD }, 'kept within -1..1');

  // Sway: the first pointer.
  const inputs = JSON.stringify([
    { type: 'keyboard', libinput: {} },
    { type: 'touchpad', libinput: { accel_profile: 'adaptive', accel_speed: 0.9, tap: 'enabled', natural_scroll: 'enabled' } },
    { type: 'pointer', libinput: { accel_profile: 'flat', accel_speed: 0.3 } },
  ]);
  assert.deepStrictEqual(parseSway(inputs), { accelProfile: 'flat', accelSpeed: 0.3, padTap: true, padNatural: true });
  assert.strictEqual(parseSway('not json'), null);

  // Another desktop: libinput's default.
  assert.deepStrictEqual(await read({ XDG_CURRENT_DESKTOP: 'XFCE' }), { accelProfile: 'adaptive', accelSpeed: 0, ...PAD });

  // niri: the touchpad block of config.kdl, commented lines left out.
  const kdl = 'input {\n    touchpad {\n        tap\n        // natural-scroll\n        accel-speed 0.2\n    }\n    mouse {\n        natural-scroll\n    }\n}\n';
  assert.deepStrictEqual(parseNiri(kdl), { accelProfile: 'adaptive', accelSpeed: 0.2, padTap: true, padNatural: false });
  assert.deepStrictEqual(parseNiri(kdl.replace('// natural-scroll', 'natural-scroll').replace('        tap\n', '')), { accelProfile: 'adaptive', accelSpeed: 0.2, padTap: false, padNatural: true });

  console.log('pointeraccel: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

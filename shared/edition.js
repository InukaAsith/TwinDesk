// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Which TwinDesk this is. The Full KVM build (docs/full-kvm.md) carries shared/fullkvm/ (and its
// platform's fullkvm/); the normal builds leave those folders out (linux/installer/build.js,
// windows/installer/build.js), so every hook that asks fullKvm() is off there, as if it weren't written.
// TWINDESK_NO_FULLKVM=1: off in the Full KVM build too (tests, a dev checkout that wants the normal app).
'use strict';

const fs = require('fs');
const path = require('path');

let full = null;

function fullKvm() {
  if (full === null) full = process.env.TWINDESK_NO_FULLKVM !== '1' && fs.existsSync(path.join(__dirname, 'fullkvm', 'svc-link.js'));
  return full;
}

module.exports = { fullKvm };

// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
// A packaged copy may have a different bundle ID from the installed app. Never reset another app's
// privacy grants if the copy's identity cannot be read and validated.
'use strict';

const path = require('path');

function resetMissing(bundle, services, execFile, done) {
  if (!services.length) return done(null);
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  execFile('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], (err, out) => {
    const id = typeof out === 'string' ? out.trim() : '';
    if (err || !/^(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/.test(id)) {
      return done(new Error('could not determine this app’s bundle identifier'));
    }
    let left = services.length, failure = null;
    for (const service of services) execFile('/usr/bin/tccutil', ['reset', service, id], (resetErr) => {
      if (resetErr && !failure) failure = resetErr;
      if (--left === 0) done(failure);
    });
  });
}

module.exports = { resetMissing };

// The Android app's package id, in ONE place. The fork ships as com.twindesk.mesh so it installs
// next to upstream TwinDesk (com.twindesk.android); the desktop prefers the Mesh app and falls back
// to the upstream one when only that is installed on the phone.
const APP_ID = 'com.twindesk.mesh';
const LEGACY_APP_IDS = ['com.twindesk.android'];
const ALL_APP_IDS = [APP_ID, ...LEGACY_APP_IDS];

// Parses `pm list packages` output and returns the id to use: the first installed of ALL_APP_IDS
// (Mesh first), or APP_ID when none shows (not installed yet: the new id is what gets installed).
function pickAppId(pmListOutput) {
  const have = new Set(String(pmListOutput || '').split(/\r?\n/).map((l) => l.replace(/^package:/, '').trim()).filter(Boolean));
  return ALL_APP_IDS.find((id) => have.has(id)) || APP_ID;
}

// Classes keep the Kotlin namespace (com.twindesk.android) whatever the applicationId is, so a
// component name is <applicationId>/<namespace>.<Class>, never the relative `.Class` form.
const CLASS_PKG = 'com.twindesk.android';
const comp = (appId, cls) => `${appId}/${CLASS_PKG}.${cls}`;

// Which of our apps is on the phone: asks `pm list packages` through shell(serial, cmd, opts).
async function resolveAppId(shell, serial) {
  try {
    const r = await shell(serial, 'pm list packages twindesk', { timeout: 5000 });
    return pickAppId(r && r.out);
  } catch (e) {
    return APP_ID;
  }
}

module.exports = { APP_ID, LEGACY_APP_IDS, ALL_APP_IDS, CLASS_PKG, comp, pickAppId, resolveAppId };

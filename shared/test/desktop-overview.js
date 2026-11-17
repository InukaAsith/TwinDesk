// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Mac viewer still has its old controls. The sheet shows a still of a desktop, or says it has none.
// Run with: node shared/test/desktop-overview.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const viewer = read('android/app/src/main/java/com/twindesk/android/ViewerActivity.kt');
const sheet = read('android/app/src/main/java/com/twindesk/android/DesktopOverview.kt');
const web = read('android/app/src/main/java/com/twindesk/android/Web.kt');
const gestures = read('android/app/src/main/assets/web/viewer.js');

for (const label of ['tr("Mirror")', 'tr("Extend")', 'tr("Previous desktop")', 'tr("Next desktop")', 'tr("Displays & desktops")']) {
  assert.ok(viewer.includes(label), label);
}
assert.ok(viewer.includes('MacDisplayPick('));
assert.ok(viewer.includes('s.space("prev")'));
assert.ok(viewer.includes('s.space("next")'));
assert.ok(viewer.includes('heightIn(min = 48.dp)'));

assert.ok(sheet.includes('tr("Done")'));
assert.ok(sheet.includes('tr("Not previewed yet")'));
assert.ok(sheet.includes('tr("Last seen this session")'));
assert.ok(sheet.includes('tr("Current preview")'));
assert.ok(sheet.includes('tr("Current")'));
assert.ok(sheet.includes('tr("Last seen")'));
assert.ok(sheet.includes('tr("No preview")'));
assert.ok(sheet.includes('tr("Desktop previews need macOS 14.")'));
assert.ok(sheet.includes('tr("Desktop previews need Screen Recording.")'));
assert.ok(!sheet.includes('Illustration only'));
assert.ok(!sheet.includes('They are not windows from the Mac'));
assert.ok(!sheet.includes('desktopCapturer'));
assert.ok(!sheet.includes('getSources'));
assert.ok(!sheet.includes('Brush.linearGradient'));
assert.ok(sheet.includes('if (bitmap == null) DesktopPreview.Status.NONE'));
assert.ok(sheet.includes('minHeight = 48.dp'));
assert.ok(sheet.includes('height(48.dp)'));
assert.ok(sheet.includes('contentAlignment = Alignment.Center'));
assert.ok(sheet.includes('widthIn(max = 720.dp)'));
assert.ok(sheet.includes('BackHandler(onBack = onDone)'));
assert.ok(sheet.includes('LazyColumn'));
assert.ok(sheet.includes('deskColumnCount'));
assert.ok(sheet.includes('fontScale'));
assert.ok(sheet.includes('withContext(Dispatchers.Default)'));
assert.ok(sheet.includes('inJustDecodeBounds = true'));
assert.ok(sheet.includes('previewIntrinsicOk'));
const boundsAt = sheet.indexOf('inJustDecodeBounds = true');
const pixelsAt = sheet.indexOf('inSampleSize = sample');
assert.ok(boundsAt > 0 && pixelsAt > boundsAt, 'intrinsic bounds are known before pixels are allocated');
assert.ok(sheet.includes('indication = ripple('));
assert.ok(!sheet.includes('indication = null, role = Role.Button'));
assert.ok(!sheet.includes('remember(shot'));

assert.ok(gestures.includes('function reportVideo'));
assert.ok(gestures.includes('function requireCurrentFrame'));
assert.ok(gestures.includes('let videoOwner'));
assert.ok(gestures.includes('viewerGeneration'));

assert.ok(web.includes('result.action is DesktopSelect.Action.Space'));
assert.ok(web.includes('pending = previous'));
assert.ok(web.includes('"spaceId" to action.spaceId'));
assert.ok(web.includes('"rev" to action.rev'));
assert.ok(web.includes('control(share = true, displayId = action.displayId)'));
assert.ok(web.includes('fun space(dir: String)'));
assert.ok(web.includes('DesktopSelect.cancelReason'));
assert.ok(web.includes('fun refreshDesktops'));
assert.ok(web.includes('"screen.desktops"'));
assert.ok(web.includes('if (!followUp) refreshFollowups = 0'));
assert.ok(web.includes('refreshFollowups < 1'));
assert.ok(web.includes('refreshDesktops(followUp = true)'));
assert.ok(web.includes('if (epoch != refreshEpoch) return true'));
assert.ok(web.includes('frameFor()'));
assert.ok(web.includes('if (!on) cancelDesktopWait()'));
assert.ok(web.includes('if (!inputOn)'));
assert.ok(web.includes('core.link.ownsVideoSession(videoMarker)')); // #303: the session's own socket, connected, not parting
assert.ok(web.includes('fun videoState'));
assert.ok(!web.includes('fun lockChanged'));
assert.ok(!web.includes('viewGestures'));
assert.ok(!web.includes('lockView'));
const screenSrc = web.slice(web.indexOf('class Screen'), web.indexOf('class MacSound'));
const welcomeAt = screenSrc.indexOf('override fun onWelcome');
const welcome = screenSrc.slice(welcomeAt, screenSrc.indexOf('override fun onClosed', welcomeAt));
assert.ok(welcome.includes('sessionEpoch++'));
assert.ok(welcome.includes('cancelDesktopWait()'));
assert.ok(welcome.includes('endPreviewSession()'));
assert.ok(welcome.includes('previewEpoch++'));
assert.ok(welcome.includes('DesktopPreview.empty(session)'));
const closed = web.slice(web.indexOf('override fun onClosed'), web.indexOf('override fun onMessage'));
assert.ok(closed.includes('cancelDesktopWait()'));
assert.ok(closed.includes('endPreviewSession()'));
const inputOff = web.slice(web.indexOf('"stream.input"'), web.indexOf('"screen.space.result"'));
assert.ok(inputOff.includes('if (!inputOn)'));
assert.ok(inputOff.includes('cancelDesktopWait()'));
assert.ok(inputOff.includes('endPreviewSession()'));
const resultAt = web.indexOf('"screen.space.result"');
const result = web.slice(resultAt, web.indexOf('"screen.desktops"', resultAt));
assert.ok(result.includes('refreshDesktops()'));

assert.ok(sheet.includes('onDisplay(display.id)'));
assert.ok(sheet.includes('val marked = desk.current'));
assert.ok(sheet.includes('selected = marked'));
assert.ok(sheet.includes('val viewingThis = marked && display.id == viewingId'));
assert.ok(!sheet.includes('val current = desk.current && display.id == viewingId'));

assert.ok(viewer.includes('val sheetReady'));
assert.ok(viewer.includes('if (!sheetReady)'));
assert.ok(viewer.includes('!sheetReady && s.remote && s.displays.size > 1'));
assert.ok(viewer.includes('!sheetReady && s.spaces && s.sharing && s.inputOn'));
assert.ok(!viewer.includes('showLogin'));
assert.ok(!viewer.includes('lockView'));
assert.ok(viewer.includes('LaunchedEffect(overview)'));
assert.ok(viewer.includes('s.refreshDesktops()'));
assert.ok(viewer.includes('onDisplay = { id -> if (id != desks.viewing && id != s.pendingDisplayId) s.selectDisplay(id) }'));
assert.ok(viewer.includes('MacDisplayPick(s.displays, if (s.sharing && s.mode != "extend") s.displayId else "", onDark = true) { s.pickDisplay(it); bar = true }'));
assert.ok(sheet.includes('tr("Switching")'));
assert.ok(sheet.includes('val switching = !viewing && display.id == pendingDisplayId'));
const pickAt = web.indexOf('fun pickDisplay(id: String)');
const pick = web.slice(pickAt, web.indexOf('fun keyboard(on: Boolean)', pickAt));
assert.ok(pick.includes('control(share = true, displayId = id)'));
assert.ok(!pick.includes('switchDisplay'));
assert.ok(!pick.includes('screen.space'));
const chosenAt = web.indexOf('fun selectDisplay(id: String)');
const chosen = web.slice(chosenAt, web.indexOf('fun selectDesktop', chosenAt));
assert.ok(chosen.includes('DesktopSelect.switchDisplay'));
assert.ok(!chosen.includes('screen.space'));
assert.ok(!chosen.includes('spaceId'));
assert.ok(viewer.includes('tr("Stop")'));
assert.ok(viewer.includes('previews = s.desktopPreviews'));
assert.ok(web.includes('"screen.preview"'));
assert.ok(web.includes('screen.preview.want'));
assert.ok(web.includes('fun previewSheet'));
assert.ok(web.includes('DesktopPreview.reduce'));
assert.ok(web.includes('DesktopPreview.retain'));
assert.ok(viewer.includes('s.previewSheet(overview && sheetReady && started)'));
assert.ok(viewer.includes('screen.previewSheet(false)'));
const state = web.slice(web.indexOf('"screen.state"'), web.indexOf('"stream.input"'));
assert.ok(state.includes('endPreviewSession()'));
assert.ok(state.includes('DesktopPreview.retain'));

for (const file of ['mac/services.js', 'mac/mesh/services.js']) {
  const src = read(file);
  assert.ok(src.includes('DesktopRefresh'), file);
  assert.ok(src.includes('SCREEN_DESKTOPS'), file);
}
assert.ok(read('mac/main.js').includes('spaceLook.refresh({'));
assert.ok(read('mac/mesh/main.js').includes('spaceLook.refresh({'));

for (const file of ['windows/main.js', 'windows/mesh/main.js', 'linux/main.js', 'linux/mesh/main.js']) {
  assert.ok(!read(file).includes('desktopCatalog'), file);
}

console.log('desktop-overview: controls, honest preview labels, and no Windows or Linux catalog.');

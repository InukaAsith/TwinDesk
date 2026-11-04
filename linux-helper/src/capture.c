// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// XInput2 raw events on the root window: edge push at home, the return edge, the hotkey, and
// capture (pointer/keyboard grabs, the pointer hidden and parked) with the safety rules.
// Port of windows-helper/src/Capture.cs (itself adapted from Beamer, GPL-3.0; see
// THIRD_PARTY_NOTICES). Raw events reach us even while another
// client (or we) hold a grab, and give deltas while the pointer is stuck at an edge.
#include "helper.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <X11/XKBlib.h>
#include <X11/extensions/XInput2.h>
#include <X11/extensions/Xfixes.h>
#include <X11/extensions/Xrandr.h>

// config (kvmConfig)
static int side = SIDE_NONE;          // crossing side of this computer
static double resistancePx = 120;
static int hotkeyEvs[2] = { 100, -1 }; // Right Alt (evdev); "Alt" = both sides
static int driveOther;                // edge detection on
static int edgeKeyboard = 1;          // an edge crossing also captures the keyboard
static double deadmanMs = 1500, doubleTapMs = 400;

// capture state
static int capturing, capMouse, capKeys;
static int ptrGrabbed, kbGrabbed, cursorHidden;
static int savedX, savedY;
static unsigned char heldKeys[256], swallowKeys[256];
static unsigned char heldButtons[32], swallowButtons[32];
static double swallowSince;
static double lastCmd;

// edge push (home) and return edge (driven)
static double push, lastPush, pushSince;
static int retArmed, retSide = SIDE_NONE;
static double retResistance, retPush, retLast, retSince;
// A push crosses once it went the resistance outward and lasted dwellMs (kvmConfig dwellMs,
// KVM_EDGE_DWELL_MS; none with no resistance): the end of a quick flick that reaches the edge is
// over by then, a push meant to cross goes on.
static double dwellMs = 150;
static int dwelt(double resistance, double since, double now) { return resistance <= 0 || now - since >= dwellMs; }
// No new crossing within cooldownMs of the last one, either way (kvmConfig cooldownMs,
// KVM_CROSS_COOLDOWN_MS). After arriving, the edge it came through only counts once the pointer
// moved 8 px inward or GUARD_MS passed, so the end of a flick doesn't bounce straight back.
#define GUARD_MS 500
static double cooldownMs = 250, lastCross;
static int arrivalSide = SIDE_NONE;
static double arrivalAt, arrivalInward;
// Where along the side the other computer's monitors touch ours (shared/kvm-geom.js zones): the edge
// and the way back only cross inside them. -1: anywhere.
static double edgeZ[8][2], retZ[8][2];
static int nEdgeZ = -1, nRetZ = -1;

#ifdef MULTI
// Multi-device's helper (macshare-linuxhelper-multi, built with -DMULTI, docs/multi-device.md):
// several watched edges on X11, each pushed through on its own, and the edge and return events say
// which side. `side` stays the first one (the file-drag strip, drop.c). The lists come as sideList
// ("left,top"): our JSON reader skips arrays. Without MULTI, the one-side code below is all there is.
static int sides[4], nsides;                 // the edges watched at home
static double pushBy[4], lastPushBy[4], pushSinceBy[4]; // the push per side (indexed by SIDE_*)
static int retSides[4], nret;                // the edges watched while driven
static double retPushBy[4], retLastBy[4], retSinceBy[4];

// "left,top" -> out (valid, no repeats); none given: the one side `fallback`, if any.
static int parse_sides(const char *list, int fallback, int *out) {
  int n = 0;
  if (!list) {
    if (fallback != SIDE_NONE) out[n++] = fallback;
    return n;
  }
  char buf[64];
  snprintf(buf, sizeof buf, "%s", list);
  for (char *tok = strtok(buf, ","); tok && n < 4; tok = strtok(NULL, ",")) {
    int s = side_of(tok);
    int dup = 0;
    for (int i = 0; i < n; i++) if (out[i] == s) dup = 1;
    if (s != SIDE_NONE && !dup) out[n++] = s;
  }
  return n;
}
#endif

// key repeat while capturing: raw events carry none (X repeats inside XKB), the PC forwards
// repeats as more k.kd, so the last key held repeats here at X's own rate
static int repeatEv = -1;
static double repeatAt, repeatDelay = 500, repeatInterval = 33;

// a file drag crossing (drop.c): capturing while the file manager's drag still holds the pointer
// and keyboard grabs; a barrier keeps the pointer on the strip until the real button-up, then
// capture takes its grabs (softUp)
static int soft, softUp, leftDown;
static int watchRel; // capture_watch_release: say `released` at our next left button-up at home
static double softSince;
static PointerBarrier bars[3];
static int nbars;

// hotkey double-tap
static int hkDown;
static double lastTapUp = -1;
// Held back while capturing: a hotkey press is sent only when another key
// or a click follows (a shortcut); a plain tap never reaches the other computer.
static int hkPending = -1;
static unsigned char hkRemote[256];

// devices: XTest slaves (our own injection, rule 4) and absolute pointers
#define MAX_DEV 256
static unsigned char isXtest[MAX_DEV];
typedef struct { int abs; double min[2], max[2], last[2]; int has[2]; } Dev;
static Dev devs[MAX_DEV];
static int acceptXtest; // dev only: MACSHARE_HELPER_TEST_XTEST=1 lets xdotool drive the capture side

static int xiOpcode, rrEvent;

double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1000.0 + t.tv_nsec / 1e6;
}

static void forward(const char *k) { // k: a built k.* object
#ifdef TDFAST
  char fbuf[4200];
  k = lane_fence(k, fbuf, sizeof fbuf); // a click, key or wheel: its event number and fence (lane.c)
#endif
  JOut o;
  jo_begin(&o);
  jo_str(&o, "event", "ev");
  jo_raw(&o, "ev", k);
  emit(jo_end(&o));
}

static void load_devices(void) {
  int n = 0;
  memset(isXtest, 0, sizeof isXtest);
  memset(devs, 0, sizeof devs);
  XIDeviceInfo *info = XIQueryDevice(dpy_ev, XIAllDevices, &n);
  if (!info) return;
  for (int i = 0; i < n; i++) {
    int id = info[i].deviceid;
    if (id < 0 || id >= MAX_DEV) continue;
    if (strstr(info[i].name, "XTEST")) isXtest[id] = 1;
    for (int c = 0; c < info[i].num_classes; c++) {
      if (info[i].classes[c]->type != XIValuatorClass) continue;
      XIValuatorClassInfo *v = (XIValuatorClassInfo *)info[i].classes[c];
      if (v->number > 1) continue;
      if (v->mode == XIModeAbsolute) devs[id].abs = 1;
      devs[id].min[v->number] = v->min;
      devs[id].max[v->number] = v->max;
    }
  }
  XIFreeDeviceInfo(info);
}

int capture_init(void) {
  int ev, err, major = 2, minor = 2;
  if (!XQueryExtension(dpy_ev, "XInputExtension", &xiOpcode, &ev, &err)) return 0;
  if (XIQueryVersion(dpy_ev, &major, &minor) != Success) return 0;
  acceptXtest = getenv("MACSHARE_HELPER_TEST_XTEST") && !strcmp(getenv("MACSHARE_HELPER_TEST_XTEST"), "1");
  load_devices();

  unsigned char bits[XIMaskLen(XI_LASTEVENT)] = { 0 };
  XIEventMask m = { XIAllMasterDevices, sizeof bits, bits };
  XISetMask(bits, XI_RawMotion);
  XISetMask(bits, XI_RawButtonPress);
  XISetMask(bits, XI_RawButtonRelease);
  XISetMask(bits, XI_RawKeyPress);
  XISetMask(bits, XI_RawKeyRelease);
  XISelectEvents(dpy_ev, root_ev, &m, 1);
  unsigned char hbits[XIMaskLen(XI_LASTEVENT)] = { 0 };
  XIEventMask hm = { XIAllDevices, sizeof hbits, hbits };
  XISetMask(hbits, XI_HierarchyChanged);
  XISelectEvents(dpy_ev, root_ev, &hm, 1);

  int rrErr;
  unsigned delay, interval;
  if (XkbGetAutoRepeatRate(dpy_ev, XkbUseCoreKbd, &delay, &interval) && delay && interval) { repeatDelay = delay; repeatInterval = interval; }

  if (XRRQueryExtension(dpy_ev, &rrEvent, &rrErr)) XRRSelectInput(dpy_ev, root_ev, RRScreenChangeNotifyMask);
  else rrEvent = -1;
  int fxEv, fxErr;
  if (!XFixesQueryExtension(dpy_ev, &fxEv, &fxErr)) fprintf(stderr, "no XFixes: the pointer stays visible while driving\n");
  XFlush(dpy_ev);
  lastCmd = now_ms();
  return 1;
}

void capture_config(const JObj *c) {
  side = side_of(jstr(c, "side", NULL));
  resistancePx = jnum(c, "resistancePx", 120);
  // "AltRight" / "AltLeft" / "Alt" (either side), same for Control, Shift, Meta (P.HOTKEYS)
  const char *hk = jstr(c, "hotkey", "AltRight");
  char l[24], r[24];
  snprintf(l, sizeof l, "%sLeft", hk);
  snprintf(r, sizeof r, "%sRight", hk);
  int one = key_evdev(hk), left = key_evdev(l), right = key_evdev(r);
  if (one > 0) { hotkeyEvs[0] = one; hotkeyEvs[1] = -1; }
  else if (left > 0 && right > 0) { hotkeyEvs[0] = left; hotkeyEvs[1] = right; }
  else { hotkeyEvs[0] = 100; hotkeyEvs[1] = -1; }
  driveOther = jbool(c, "driveOther", 0);
  edgeKeyboard = jbool(c, "keyboard", 1);
  deadmanMs = jnum(c, "deadmanMs", 1500);
  doubleTapMs = jnum(c, "doubleTapMs", 400);
  cooldownMs = jnum(c, "cooldownMs", 250);
  dwellMs = jnum(c, "dwellMs", 150);
  nEdgeZ = zones_parse(jstr(c, "zones", NULL), edgeZ, 8);
  shortcut_config(c);
  drop_config(c);
#ifdef MULTI
  nsides = parse_sides(jstr(c, "sideList", NULL), side, sides);
  memset(pushBy, 0, sizeof pushBy);
#endif
}

void capture_touch(void) { lastCmd = now_ms(); }

// The pointer came to this computer (back home, or placed by the driver) through `s`, or by the
// hotkey (SIDE_NONE): starts the cooldown and the arrival guard, and clears every push.
void capture_arrived(int s) {
  lastCross = now_ms();
  arrivalSide = s; arrivalAt = lastCross; arrivalInward = 0;
  push = retPush = 0;
#ifdef MULTI
  memset(pushBy, 0, sizeof pushBy);
  memset(retPushBy, 0, sizeof retPushBy);
#endif
}

// 0 while a crossing through `s` has to wait (cooldown, arrival guard). `outward`: this move's
// outward part for that side (negative = inward).
static int may_cross(int s, double outward) {
  double now = now_ms();
  if (now - lastCross < cooldownMs) return 0;
  if (arrivalSide != SIDE_NONE && arrivalSide == s) {
    if (outward < 0) arrivalInward -= outward;
    if (now - arrivalAt < GUARD_MS && arrivalInward < 8) return 0;
    arrivalSide = SIDE_NONE;
  }
  return 1;
}

// The sides where an injected move stops at the edge rather than jump onto a monitor past it.
int capture_return_stops(int *out) {
  if (!retArmed) return 0;
#ifdef MULTI
  for (int i = 0; i < nret; i++) out[i] = retSides[i];
  return nret;
#else
  out[0] = retSide;
  return 1;
#endif
}
int capture_active(void) { return capturing; }

static void query(int *x, int *y, unsigned *mask) {
  Window rr, cr;
  int wx, wy;
  unsigned m = 0;
  *x = *y = 0;
  XQueryPointer(dpy_in, root_in, &rr, &cr, x, y, &wx, &wy, &m);
  if (mask) *mask = m;
}

// ---- grabs ----
// Taken on the injection connection: the X server sends raw events to the grabbing client only
// through the grab's own XI2 mask, but to every other client as usual (XI 2.1+). So the capture
// connection keeps reading raw events while this one holds the grab. Its core events are
// drained in main.c.

static int grab_pointer(void) {
  if (ptrGrabbed) return 1;
  for (int i = 0; i < 5; i++) { // a menu closing may still hold its grab for a moment
    if (XGrabPointer(dpy_in, root_in, False, 0,
          GrabModeAsync, GrabModeAsync, None, None, CurrentTime) == GrabSuccess) return ptrGrabbed = 1;
    usleep(10000);
  }
  return 0;
}

static int grab_keyboard(void) {
  if (kbGrabbed) return 1;
  for (int i = 0; i < 5; i++) {
    if (XGrabKeyboard(dpy_in, root_in, False, GrabModeAsync, GrabModeAsync, CurrentTime) == GrabSuccess) return kbGrabbed = 1;
    usleep(10000);
  }
  return 0;
}

static int any(const unsigned char *a, int n) {
  for (int i = 0; i < n; i++) if (a[i]) return 1;
  return 0;
}

// Grabs end once nothing pressed remotely is still held here (rule 5 on X: keeping the grab is
// how a later release stays swallowed).
static void release_grabs(void) {
  if (kbGrabbed && !(capturing && capKeys) && !any(swallowKeys, 256)) { XUngrabKeyboard(dpy_in, CurrentTime); kbGrabbed = 0; }
  if (ptrGrabbed && !(capturing && capMouse) && !any(swallowButtons, 32)) { XUngrabPointer(dpy_in, CurrentTime); ptrGrabbed = 0; }
  XFlush(dpy_in);
}

// ---- capture on/off ----

int capture_begin(int mouse, int keys) {
  if (capturing) { capMouse = mouse; capKeys = keys; return 1; }
  if (mouse && !grab_pointer()) { release_grabs(); return 0; }
  if (keys && !grab_keyboard()) { release_grabs(); return 0; }
  capturing = 1; capMouse = mouse; capKeys = keys;
  memset(heldKeys, 0, sizeof heldKeys);
  memset(heldButtons, 0, sizeof heldButtons);
  capture_touch();
  if (mouse) {
    query(&savedX, &savedY, NULL);
    if (!cursorHidden) { XFixesHideCursor(dpy_ev, root_ev); cursorHidden = 1; }
    // Parked in the middle while driving; motion is read from raw events, not the position.
    int cx, cy;
    screens_center(&cx, &cy);
    XWarpPointer(dpy_ev, None, root_ev, 0, 0, 0, 0, cx, cy);
  }
  XFlush(dpy_ev);
  push = 0;
#ifdef MULTI
  memset(pushBy, 0, sizeof pushBy);
#endif
  lastCross = now_ms();
  arrivalSide = SIDE_NONE;
  return 1;
}

static void drop_barriers(void) {
  for (int i = 0; i < nbars; i++) XFixesDestroyPointerBarrier(dpy_in, bars[i]);
  nbars = 0;
  XFlush(dpy_in);
}

// hasSide == 0: put the pointer back where capture began.
void capture_stop(int toSide, double offset, int hasSide) {
  if (!capturing) return;
  capturing = 0;
  if (soft) { soft = softUp = 0; drop_barriers(); }
  // Rule 5: whatever is still held was pressed remotely; its release stays swallowed here.
  for (int i = 0; i < 256; i++) if (heldKeys[i]) swallowKeys[i] = 1;
  for (int i = 0; i < 32; i++) if (heldButtons[i]) swallowButtons[i] = 1;
  memset(heldKeys, 0, sizeof heldKeys);
  memset(heldButtons, 0, sizeof heldButtons);
  hkPending = -1;
  memset(hkRemote, 0, sizeof hkRemote); // a sent hotkey's release is in swallowKeys now
  swallowSince = now_ms();
  if (capMouse) {
    int x = savedX, y = savedY;
    if (hasSide && toSide != SIDE_NONE) screens_edge_point(toSide, offset, &x, &y);
    XWarpPointer(dpy_ev, None, root_ev, 0, 0, 0, 0, x, y);
    if (cursorHidden) { XFixesShowCursor(dpy_ev, root_ev); cursorHidden = 0; }
  }
  release_grabs();
  capture_arrived(hasSide ? toSide : SIDE_NONE);
}

void capture_return_zones(const char *text) { nRetZ = zones_parse(text, retZ, 8); }

void capture_arm_return(int on, int s, double resistance) {
  local_watch(on);
  retArmed = on && s != SIDE_NONE;
  retSide = s;
  retResistance = resistance;
  retPush = 0;
}

#ifdef MULTI
// armReturn with sideList: every edge with a device behind it (fallback: the one side).
void capture_arm_return_list(int on, const char *list, int fallback, double resistance) {
  local_watch(on);
  nret = on ? parse_sides(list, fallback, retSides) : 0;
  retArmed = nret > 0;
  retSide = nret ? retSides[0] : SIDE_NONE;
  retResistance = resistance;
  memset(retPushBy, 0, sizeof retPushBy);
}
#endif

static void repeat_tick(double now);

// The drag crossed: capture now without grabs (the file manager holds them), the pointer held on
// the strip (sx… : its rectangle), and tell main `edge {offset, drag:{paths}}`.
void capture_drag_cross(const char *paths, int x, int y, int sx, int sy, int sw, int sh) {
  if (capturing || !driveOther || side == SIDE_NONE) return;
  capturing = 1; capMouse = 1; capKeys = edgeKeyboard;
  soft = 1; softUp = 0; softSince = now_ms();
  memset(heldKeys, 0, sizeof heldKeys);
  memset(heldButtons, 0, sizeof heldButtons); // the left button's release goes over: it drops there
  capture_touch();
  push = 0;
#ifdef MULTI
  memset(pushBy, 0, sizeof pushBy);
#endif
  lastCross = now_ms();
  arrivalSide = SIDE_NONE;
  savedX = x < sx ? sx : x > sx + sw - 1 ? sx + sw - 1 : x;
  savedY = y < sy ? sy : y > sy + sh - 1 ? sy + sh - 1 : y;
  XWarpPointer(dpy_in, None, root_in, 0, 0, 0, 0, savedX, savedY);
  // Barriers let the pointer move along the strip but not off it (directions = where it may pass).
  int r = sx + sw, b = sy + sh;
  nbars = 0;
  if (side == SIDE_LEFT || side == SIDE_RIGHT) {
    int bx = side == SIDE_RIGHT ? sx : r;
    bars[nbars++] = XFixesCreatePointerBarrier(dpy_in, root_in, bx, sy, bx, b, side == SIDE_RIGHT ? BarrierPositiveX : BarrierNegativeX, 0, NULL);
    bars[nbars++] = XFixesCreatePointerBarrier(dpy_in, root_in, sx, sy, r, sy, 0, 0, NULL);
    bars[nbars++] = XFixesCreatePointerBarrier(dpy_in, root_in, sx, b, r, b, 0, 0, NULL);
  } else {
    int by = side == SIDE_BOTTOM ? sy : b;
    bars[nbars++] = XFixesCreatePointerBarrier(dpy_in, root_in, sx, by, r, by, side == SIDE_BOTTOM ? BarrierPositiveY : BarrierNegativeY, 0, NULL);
    bars[nbars++] = XFixesCreatePointerBarrier(dpy_in, root_in, sx, sy, sx, b, 0, 0, NULL);
    bars[nbars++] = XFixesCreatePointerBarrier(dpy_in, root_in, r, sy, r, b, 0, 0, NULL);
  }
  if (!cursorHidden) { XFixesHideCursor(dpy_ev, root_ev); cursorHidden = 1; }
  XFlush(dpy_in);
  XFlush(dpy_ev);
  size_t cap = strlen(paths) + 128;
  char *line = malloc(cap);
  snprintf(line, cap, "{\"event\":\"edge\",\"offset\":%.4f,\"drag\":{\"paths\":%s}}", screens_offset(x, y, side), paths);
  emit(line);
  free(line);
}

// A file drag caught on the way back (drop.c, while driven): the input goes home with its files
// (`return {offset, drag:{paths}}`), and the driver's button that holds it here is let go on the
// strip, where the drop does nothing.
void capture_drag_return(const char *paths, int x, int y, int s) {
  if (!retArmed || capturing) return;
  retArmed = 0;
#ifdef MULTI
  memset(retPushBy, 0, sizeof retPushBy);
#endif
  lastCross = now_ms();
  size_t cap = strlen(paths) + 160;
  char *line = malloc(cap);
#ifdef MULTI
  snprintf(line, cap, "{\"event\":\"return\",\"side\":\"%s\",\"offset\":%.4f,\"drag\":{\"paths\":%s}}", side_name(s), screens_offset(x, y, s), paths);
#else
  snprintf(line, cap, "{\"event\":\"return\",\"offset\":%.4f,\"drag\":{\"paths\":%s}}", screens_offset(x, y, s), paths);
#endif
  emit(line);
  free(line);
  inject_button_up(0);
}

void capture_watch_release(int on) { watchRel = on; }

// The file manager's drag ended on the strip (drop.c): take the grabs as soon as it lets go.
void capture_drag_dropped(void) {
  if (soft) softUp = 1;
}

// One try each tick: the file manager gives its grabs back right after the drop.
static void soft_tick(double now) {
  if (!soft || (!softUp && now - softSince < 60000)) return;
  if (!ptrGrabbed && XGrabPointer(dpy_in, root_in, False, 0, GrabModeAsync, GrabModeAsync, None, None, CurrentTime) == GrabSuccess) ptrGrabbed = 1;
  if (capKeys && !kbGrabbed && XGrabKeyboard(dpy_in, root_in, False, GrabModeAsync, GrabModeAsync, CurrentTime) == GrabSuccess) kbGrabbed = 1;
  if (!ptrGrabbed || (capKeys && !kbGrabbed)) {
    if (now - softSince > 65000) capture_stop(SIDE_NONE, 0, 0); // never let go: give everything back
    return;
  }
  soft = softUp = 0;
  drop_barriers();
  int cx, cy;
  screens_center(&cx, &cy); // parked in the middle, like any capture
  XWarpPointer(dpy_ev, None, root_ev, 0, 0, 0, 0, cx, cy);
  XFlush(dpy_ev);
}

void capture_tick(void) {
  double now = now_ms();
  repeat_tick(now);
  shortcut_tick();
  soft_tick(now);
  drop_tick(capturing, side, driveOther, leftDown, retArmed ? retSide : SIDE_NONE);
  if (capturing && now - lastCmd > deadmanMs) {
    capture_stop(SIDE_NONE, 0, 0); // rule 1: a hung main or a dead link never keeps the user's input
    JOut o;
    jo_begin(&o);
    jo_str(&o, "event", "captureEnded");
    jo_str(&o, "reason", "deadman");
    emit(jo_end(&o));
  }
  // A swallowed release that never comes (key still held): give the grab back after a while.
  if (!capturing && (kbGrabbed || ptrGrabbed) && now - swallowSince > 3000) {
    memset(swallowKeys, 0, sizeof swallowKeys);
    memset(swallowButtons, 0, sizeof swallowButtons);
    release_grabs();
  }
}

void capture_shutdown(void) {
  if (capturing) capture_stop(SIDE_NONE, 0, 0);
  drop_shutdown();
  memset(swallowKeys, 0, sizeof swallowKeys);
  memset(swallowButtons, 0, sizeof swallowButtons);
  release_grabs();
  if (cursorHidden) { XFixesShowCursor(dpy_ev, root_ev); cursorHidden = 0; }
  XFlush(dpy_ev);
}

// ---- hotkey ----

static int is_hotkey(int ev) {
  return ev == hotkeyEvs[0] || ev == hotkeyEvs[1];
}

// Two clean taps (down+up, no other key between) within doubleTapMs, in every mode.
static int detect_hotkey(int ev, int down) {
  double now = now_ms();
  if (!is_hotkey(ev)) {
    if (down) lastTapUp = -1;
    return 0;
  }
  if (down) { hkDown = 1; return 0; }
  if (!hkDown) return 0;
  hkDown = 0;
  if (lastTapUp >= 0 && now - lastTapUp <= doubleTapMs) { lastTapUp = -1; return 1; }
  lastTapUp = now;
  return 0;
}

// Rule 2: stop capturing in the helper first, then tell main.
static void fire_hotkey(void) {
  int was = capturing;
  if (capturing) capture_stop(SIDE_NONE, 0, 0);
  JOut o;
  jo_begin(&o);
  jo_str(&o, "event", "hotkey");
  jo_bool(&o, "wasCapturing", was);
  emit(jo_end(&o));
}

static void send_key(int ev, int down) {
  const char *code = key_code(ev);
  if (!code) return;
  JOut k;
  jo_begin(&k);
  jo_str(&k, "t", down ? "k.kd" : "k.ku");
  jo_str(&k, "code", code);
  forward(jo_end(&k));
}

static int is_modifier(int ev) {
  return ev == 29 || ev == 97 || ev == 42 || ev == 54 || ev == 56 || ev == 100 || ev == 125 || ev == 126 || ev == 58;
}

static void repeat_tick(double now) {
  if (repeatEv < 0) return;
  if (!capturing || !capKeys || !heldKeys[repeatEv]) { repeatEv = -1; return; }
  if (now < repeatAt) return;
  repeatAt = now + repeatInterval;
  send_key(repeatEv, 1);
}

// The held hotkey turned out to be part of a shortcut: send its press now, before the key.
static void flush_hotkey(void) {
  int ev = hkPending;
  hkPending = -1;
  if (ev < 0 || !capturing || !capKeys) return;
  hkRemote[ev] = 1;
  heldKeys[ev] = 1;
  send_key(ev, 1);
}

static void on_key(int ev, int down) {
  if (ev < 0 || ev > 255) return;
  shortcut_key(ev, down, !capturing, !(capturing && capKeys));
  int hot = detect_hotkey(ev, down);
  if (!down && swallowKeys[ev]) { swallowKeys[ev] = 0; release_grabs(); if (hot) fire_hotkey(); return; }
  if (capturing && capKeys) {
    if (is_hotkey(ev)) {
      if (down) { if (!hkRemote[ev]) hkPending = ev; } // wait: a shortcut sends it
      else if (hkRemote[ev]) { hkRemote[ev] = 0; heldKeys[ev] = 0; send_key(ev, 0); }
      else if (hkPending == ev) hkPending = -1; // a plain tap: never sent
      if (hot) fire_hotkey();
      return;
    }
    if (down) flush_hotkey();
    heldKeys[ev] = (unsigned char)down;
    send_key(ev, down);
    if (down) { repeatEv = is_modifier(ev) ? -1 : ev; repeatAt = now_ms() + repeatDelay; }
    else if (ev == repeatEv) repeatEv = -1;
    if (hot) fire_hotkey();
    return;
  }
  if (hot) fire_hotkey();
}

// X buttons: 1 left, 2 middle, 3 right, 4/5 wheel up/down, 6/7 wheel left/right, 8/9 back/forward.
static void on_button(int xb, int down) {
  if (xb < 0 || xb >= 32) return;
  if (xb == 1) { leftDown = down; if (!down && soft) softUp = 1; }
  if (xb == 1 && !down && wins_move_eat_up()) return; // Move windows' grab had the press (wins.c)
  if (xb == 1 && !down && watchRel && !capturing) { watchRel = 0; emit("{\"event\":\"released\"}"); }
  if (!down && swallowButtons[xb]) { swallowButtons[xb] = 0; release_grabs(); return; }
  if (down && !capturing && xb >= 1 && xb <= 3 && local_note(0, 0, 1)) retArmed = 0; // a click here while driven
  if (!capturing || !capMouse) return;
  if (xb >= 4 && xb <= 7) {
    if (!down) return;
    JOut k;
    jo_begin(&k);
    jo_str(&k, "t", "k.wh");
    jo_num(&k, "dx", xb == 6 ? -1 : xb == 7 ? 1 : 0);
    jo_num(&k, "dy", xb == 4 ? -1 : xb == 5 ? 1 : 0);
    jo_str(&k, "mode", "line");
    forward(jo_end(&k));
    return;
  }
  int b = xb == 1 ? 0 : xb == 3 ? 1 : xb == 2 ? 2 : xb == 8 ? 3 : xb == 9 ? 4 : -1;
  if (b < 0) return;
  if (down) flush_hotkey(); // Ctrl-click with the hotkey key
  heldButtons[xb] = (unsigned char)down;
  JOut k;
  jo_begin(&k);
  jo_str(&k, "t", down ? "k.md" : "k.mu");
  jo_num(&k, "b", b);
  forward(jo_end(&k));
}

// The owner's hand reaching the return edge: local raw motion and injected moves both come here.
#ifdef MULTI
// Every armed side counts, summed on its own; the first through says which side it left by.
void capture_feed_return(int x, int y, double dx, double dy) {
  if (!retArmed || drop_holding()) return;
  double now = now_ms();
  for (int i = 0; i < nret; i++) {
    int s = retSides[i];
    double outward = screens_outward(s, dx, dy);
    if (!may_cross(s, outward)) { retPushBy[s] = 0; continue; }
    if (outward <= 0 || !screens_on_outer_edge(x, y, s) || !zones_contain(retZ, nRetZ, x, y, s)) { retPushBy[s] = 0; continue; }
    if (now - retLastBy[s] > 300) retPushBy[s] = 0;
    retLastBy[s] = now;
    if (retPushBy[s] == 0) retSinceBy[s] = now;
    retPushBy[s] += outward;
    if (retPushBy[s] < retResistance || !dwelt(retResistance, retSinceBy[s], now)) continue;
    retArmed = 0;
    memset(retPushBy, 0, sizeof retPushBy);
    lastCross = now;
    JOut o;
    jo_begin(&o);
    jo_str(&o, "event", "return");
    { unsigned long mw = wins_move_take(0); if (mw) jo_num(&o, "moving", (double)mw); } // a grabbed window goes along
    jo_str(&o, "side", side_name(s));
    jo_num(&o, "offset", round(screens_offset(x, y, s) * 10000) / 10000);
    emit(jo_end(&o));
    return;
  }
}

// At home: the first watched side pushed through takes the pointer there (`edge` names the side).
static void multi_edge_push(int x, int y, unsigned mask, double rdx, double rdy) {
  if (!driveOther || !nsides || ((mask & (Button1Mask | Button2Mask | Button3Mask)) && !wins_grabbing())) { memset(pushBy, 0, sizeof pushBy); return; } // rule 6 (a grabbed window may cross)
  double now = now_ms();
  for (int i = 0; i < nsides; i++) {
    int s = sides[i];
    double outward = screens_outward(s, rdx, rdy);
    if (!may_cross(s, outward)) { pushBy[s] = 0; continue; }
    if (outward <= 0 || !screens_on_outer_edge(x, y, s) || !zones_contain(edgeZ, nEdgeZ, x, y, s)) { pushBy[s] = 0; continue; }
    if (now - lastPushBy[s] > 300) pushBy[s] = 0;
    lastPushBy[s] = now;
    if (pushBy[s] == 0) pushSinceBy[s] = now;
    pushBy[s] += outward;
    if (pushBy[s] < resistancePx || !dwelt(resistancePx, pushSinceBy[s], now)) continue;
    double offset = screens_offset(x, y, s);
    // Start capturing at once so no motion leaks, then tell main.
    if (!capture_begin(1, edgeKeyboard)) { memset(pushBy, 0, sizeof pushBy); return; }
    savedX = x; savedY = y;
    JOut o;
    jo_begin(&o);
    jo_str(&o, "event", "edge");
    { unsigned long mw = wins_move_take(1); if (mw) jo_num(&o, "moving", (double)mw); } // a grabbed window goes along
    jo_str(&o, "side", side_name(s));
    jo_num(&o, "offset", round(offset * 10000) / 10000);
    emit(jo_end(&o));
    return;
  }
}
#else
void capture_feed_return(int x, int y, double dx, double dy) {
  if (!retArmed || drop_holding()) return;
  double outward = screens_outward(retSide, dx, dy);
  if (!may_cross(retSide, outward)) { retPush = 0; return; }
  if (outward <= 0 || !screens_on_outer_edge(x, y, retSide) || !zones_contain(retZ, nRetZ, x, y, retSide)) { retPush = 0; return; }
  double now = now_ms();
  if (now - retLast > 300) retPush = 0;
  retLast = now;
  if (retPush == 0) retSince = now;
  retPush += outward;
  if (retPush < retResistance || !dwelt(retResistance, retSince, now)) return;
  retArmed = 0;
  lastCross = now;
  JOut o;
  jo_begin(&o);
  jo_str(&o, "event", "return");
  { unsigned long mw = wins_move_take(0); if (mw) jo_num(&o, "moving", (double)mw); } // a grabbed window goes along
  jo_num(&o, "offset", round(screens_offset(x, y, retSide) * 10000) / 10000);
  emit(jo_end(&o));
}
#endif

// dx/dy: accelerated (what the pointer would do), rdx/rdy: unaccelerated (edge push).
static void on_motion(double dx, double dy, double rdx, double rdy) {
  if (capturing) {
    if (!capMouse || (dx == 0 && dy == 0)) return;
    JOut k;
    jo_begin(&k);
    jo_str(&k, "t", "k.mm");
    jo_num(&k, "dx", round(dx * 100) / 100);
    jo_num(&k, "dy", round(dy * 100) / 100);
#ifdef TDFAST
    if (!lane_move(dx, dy, &k)) // on the input lane (lane.c), nothing is written
#endif
      forward(jo_end(&k));
    shake_feed(dx, dy); // after it went: shaken, the pointer comes home (shake.c)
    return;
  }
  int x, y;
  unsigned mask;
  if (local_note(rdx, rdy, 0)) { retArmed = 0; return; }
  query(&x, &y, &mask);
  if (retArmed) { capture_feed_return(x, y, rdx, rdy); return; }
#ifdef MULTI
  multi_edge_push(x, y, mask, rdx, rdy);
#else
  if (!driveOther || side == SIDE_NONE || ((mask & (Button1Mask | Button2Mask | Button3Mask)) && !wins_grabbing())) { push = 0; return; } // rule 6 (a grabbed window may cross)
  double outward = screens_outward(side, rdx, rdy);
  if (!may_cross(side, outward)) { push = 0; return; }
  if (outward <= 0 || !screens_on_outer_edge(x, y, side) || !zones_contain(edgeZ, nEdgeZ, x, y, side)) { push = 0; return; }
  double now = now_ms();
  if (now - lastPush > 300) push = 0;
  lastPush = now;
  if (push == 0) pushSince = now;
  push += outward;
  if (push < resistancePx || !dwelt(resistancePx, pushSince, now)) return;
  double offset = screens_offset(x, y, side);
  // Start capturing at once so no motion leaks, then tell main.
  if (!capture_begin(1, edgeKeyboard)) { push = 0; return; }
  savedX = x; savedY = y;
  JOut o;
  jo_begin(&o);
  jo_str(&o, "event", "edge");
  { unsigned long mw = wins_move_take(1); if (mw) jo_num(&o, "moving", (double)mw); } // a grabbed window goes along
  jo_num(&o, "offset", round(offset * 10000) / 10000);
  emit(jo_end(&o));
#endif
}

static void raw_motion(XIRawEvent *r) {
  double v[2] = { 0, 0 }, rv[2] = { 0, 0 };
  int has[2] = { 0, 0 };
  int idx = 0;
  for (int i = 0; i < r->valuators.mask_len * 8; i++) {
    if (!XIMaskIsSet(r->valuators.mask, i)) continue;
    if (i < 2) { v[i] = r->valuators.values[idx]; rv[i] = r->raw_values[idx]; has[i] = 1; }
    idx++;
  }
  int id = r->sourceid;
  if (id >= 0 && id < MAX_DEV && devs[id].abs) {
    // Absolute pointer (tablet, VM mouse): deltas from the last position, in screen pixels.
    int bx, by, bw, bh;
    screens_box(&bx, &by, &bw, &bh);
    Dev *d = &devs[id];
    for (int a = 0; a < 2; a++) {
      if (!has[a]) { v[a] = rv[a] = 0; continue; }
      double span = d->max[a] - d->min[a];
      double cur = rv[a];
      double delta = d->has[a] ? (cur - d->last[a]) * (span > 0 ? (a ? bh : bw) / span : 1) : 0;
      d->last[a] = cur;
      d->has[a] = 1;
      v[a] = rv[a] = delta;
    }
  }
  if (v[0] != 0 || v[1] != 0 || rv[0] != 0 || rv[1] != 0) on_motion(v[0], v[1], rv[0], rv[1]);
}

void capture_xevent(XEvent *e) {
  if (rrEvent >= 0 && e->type == rrEvent + RRScreenChangeNotify) {
    XRRUpdateConfiguration(e);
    screens_refresh();
    return;
  }
  if (e->xcookie.type != GenericEvent || e->xcookie.extension != xiOpcode) return;
  if (!XGetEventData(dpy_ev, &e->xcookie)) return;
  int type = e->xcookie.evtype;
  if (type == XI_HierarchyChanged) {
    load_devices();
  } else {
    XIRawEvent *r = e->xcookie.data;
    int own = r->sourceid >= 0 && r->sourceid < MAX_DEV && isXtest[r->sourceid] && !acceptXtest; // rule 4
    if (!own) {
      switch (type) {
        case XI_RawMotion: raw_motion(r); break;
        case XI_RawButtonPress: on_button(r->detail, 1); break;
        case XI_RawButtonRelease: on_button(r->detail, 0); break;
        case XI_RawKeyPress: on_key(r->detail - 8, 1); break;
        case XI_RawKeyRelease: on_key(r->detail - 8, 0); break;
      }
    }
  }
  XFreeEventData(dpy_ev, &e->xcookie);
}

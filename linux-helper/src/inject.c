// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// XTest injection of k.* events. Moves are absolute
// (current position + delta, clamped to the desktop), so X's pointer acceleration isn't applied a
// second time. XTest events come from the XTest slave device, which capture.c skips (rule 4).
// Held keys and buttons are tracked for releaseAll.
#include "helper.h"
#include <math.h>
#include <string.h>
#include <time.h>
#include <X11/extensions/XTest.h>
#include <X11/extensions/dpms.h>

static unsigned char heldKeys[256], heldButtons[16];
static double fx, fy;        // sub-pixel remainder of moves
static double vrem, hrem;    // remainder of wheel clicks

static const int XBUTTON[] = { 1, 3, 2, 8, 9 }; // left, right, middle, back, forward

void inject_move_to(int x, int y) {
  XTestFakeMotionEvent(dpy_in, -1, x, y, CurrentTime);
  XFlush(dpy_in);
}

static void move(double dx, double dy) {
  Window rr, cr;
  int cx, cy, wx, wy;
  unsigned mask;
  if (!XQueryPointer(dpy_in, root_in, &rr, &cr, &cx, &cy, &wx, &wy, &mask)) return;
  double tx = cx + fx + dx, ty = cy + fy + dy;
  int ix = (int)lround(tx), iy = (int)lround(ty), px, py, stops[4];
  screens_walk(ix, iy, cx, cy, stops, capture_return_stops(stops), &px, &py);
  if (px != ix || py != iy) { fx = 0; fy = 0; } // stopped by an edge: drop the remainder
  else { fx = tx - ix; fy = ty - iy; }
  if (px != cx || py != cy) inject_move_to(px, py);
  capture_feed_return(px, py, dx, dy); // the owner's hand reaching the return edge
}

static void button(int b, int down) {
  if (b < 0 || b > 4) return;
  heldButtons[b] = (unsigned char)down;
  XTestFakeButtonEvent(dpy_in, (unsigned)XBUTTON[b], down, CurrentTime);
  XFlush(dpy_in);
}

void inject_button(int b, int down) { button(b, down); }

void inject_button_up(int b) {
  if (b >= 0 && b <= 4 && heldButtons[b]) button(b, 0);
}

static void click(unsigned b) {
  XTestFakeButtonEvent(dpy_in, b, True, CurrentTime);
  XTestFakeButtonEvent(dpy_in, b, False, CurrentTime);
}

// DOM sign: positive dy = content further down = button 5; positive dx = right = button 7.
// One click per line; pixel deltas accumulate (40 px a click, like the PC's 3 units per px).
static void wheel(double dx, double dy, int pixel) {
  double k = pixel ? 1.0 / 40 : 1.0;
  vrem += dy * k;
  hrem += dx * k;
  while (vrem >= 1) { click(5); vrem -= 1; }
  while (vrem <= -1) { click(4); vrem += 1; }
  while (hrem >= 1) { click(7); hrem -= 1; }
  while (hrem <= -1) { click(6); hrem += 1; }
  XFlush(dpy_in);
}

static void key(const char *code, int down) {
  int ev = key_evdev(code);
  if (ev < 0 || ev + 8 > 255) return;
  heldKeys[ev] = (unsigned char)down;
  XTestFakeKeyEvent(dpy_in, (unsigned)(ev + 8), down, CurrentTime);
  XFlush(dpy_in);
}

void inject_release_all(void) {
  for (int i = 0; i < 256; i++) if (heldKeys[i]) { heldKeys[i] = 0; XTestFakeKeyEvent(dpy_in, (unsigned)(i + 8), False, CurrentTime); }
  for (int b = 0; b < 5; b++) if (heldButtons[b]) { heldButtons[b] = 0; XTestFakeButtonEvent(dpy_in, (unsigned)XBUTTON[b], False, CurrentTime); }
  vrem = hrem = 0;
  XFlush(dpy_in);
}

// XTest input doesn't always end the screen saver or DPMS blanking: reset them on remote input,
// at most once a second.
static void wake(void) {
  static double last;
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  double now = ts.tv_sec + ts.tv_nsec / 1e9;
  if (last && now - last < 1) return;
  last = now;
  XResetScreenSaver(dpy_in);
  int ev, err;
  CARD16 level;
  BOOL on;
  if (DPMSQueryExtension(dpy_in, &ev, &err) && DPMSInfo(dpy_in, &level, &on) && on && level != DPMSModeOn)
    DPMSForceLevel(dpy_in, DPMSModeOn);
  XFlush(dpy_in);
}

// A relative move from the input lane (lane.c): straight to the move, no JSON per move.
void inject_move(double dx, double dy) {
  wake();
  move(dx, dy);
}

// A k.* event from the owner (main already applied speed, key mapping and reverse scroll).
void inject_apply(const JObj *ev) {
  wake();
  const char *t = jstr(ev, "t", "");
  if (!strcmp(t, "k.mm")) move(jnum(ev, "dx", 0), jnum(ev, "dy", 0));
  else if (!strcmp(t, "k.md")) button((int)jnum(ev, "b", -1), 1);
  else if (!strcmp(t, "k.mu")) button((int)jnum(ev, "b", -1), 0);
  else if (!strcmp(t, "k.wh")) wheel(jnum(ev, "dx", 0), jnum(ev, "dy", 0), !strcmp(jstr(ev, "mode", "line"), "pixel"));
  else if (!strcmp(t, "k.kd")) key(jstr(ev, "code", NULL), 1);
  else if (!strcmp(t, "k.ku")) key(jstr(ev, "code", NULL), 0);
}

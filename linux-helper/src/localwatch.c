// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Driven (armReturn on): the first input from this computer's own mouse or touchpad takes it back
// (`local`): main sends the input home, so the driver gets its own pointer again where it left and
// the two pointers stay apart. Both backends (capture.c on X11, wl.c on Wayland) feed it their
// physical input only (never our injected moves). A move counts once it went LOCAL_PX (not a
// resting palm), and nothing counts in the first LOCAL_GRACE_MS after the watch began.
#include "helper.h"
#include <math.h>

#define LOCAL_PX 6.0
#define LOCAL_GRACE_MS 300.0

static int watching, takeBack = 1;
static double since, at, acc;

// kvmConfig takeBack (off with Sync touchpads): our own input never takes it back, the return
// watch stays on and either mouse crosses.
void local_allow(int on) {
  takeBack = on;
  if (!on) watching = 0;
}

void local_watch(int on) {
  watching = on && takeBack;
  since = now_ms();
  acc = 0;
}

int local_note(double dx, double dy, int click) {
  if (!watching) return 0;
  double now = now_ms();
  if (now - since < LOCAL_GRACE_MS) return 0;
  if (!click) {
    if (now - at > 300) acc = 0;
    at = now;
    acc += fabs(dx) + fabs(dy);
    if (acc < LOCAL_PX) return 0;
  }
  watching = 0;
  emit("{\"event\":\"local\"}");
  return 1;
}

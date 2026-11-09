// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A viewer's fingers (the `touch` command: in.tc, shared/protocol.js P.touchesOf) as a touch screen,
// on X11 and Wayland alike: a uinput multitouch device (protocol B, INPUT_PROP_DIRECT, 10 slots)
// that libinput hands the desktop as a touch screen, so a swipe scrolls and a pinch zooms where apps
// take touch. Its area is the whole desktop (screens_box), like pen.c's tablet; a Wayland compositor
// with several screens may map it onto one of them. Without /dev/uinput the first finger is the mouse.
#include "helper.h"
#include <fcntl.h>
#include <linux/uinput.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define TMAXV 65535
#define SLOTS 10

static int fd = -1, tried;
static double bornAt;
static int downs[SLOTS]; // 1: that slot touches now
static int tracking; // the next tracking id
static int mouseId = -1, mouseDown;

static void temit(int type, int code, int value) {
  struct input_event ie;
  memset(&ie, 0, sizeof ie);
  ie.type = (unsigned short)type;
  ie.code = (unsigned short)code;
  ie.value = value;
  if (write(fd, &ie, sizeof ie) < 0) { /* full: dropped */ }
}

static void abs_setup(int code, int max, int res) {
  struct uinput_abs_setup ab;
  memset(&ab, 0, sizeof ab);
  ab.code = (unsigned short)code;
  ab.absinfo.maximum = max;
  ab.absinfo.resolution = res;
  ioctl(fd, UI_ABS_SETUP, &ab);
}

static int ready(void) {
  if (tried) return fd >= 0;
  tried = 1;
  fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) { fprintf(stderr, "touch: no /dev/uinput, a finger is the mouse\n"); return 0; }
  ioctl(fd, UI_SET_EVBIT, EV_KEY);
  ioctl(fd, UI_SET_EVBIT, EV_ABS);
  ioctl(fd, UI_SET_EVBIT, EV_SYN);
  ioctl(fd, UI_SET_KEYBIT, BTN_TOUCH);
  int axes[] = { ABS_X, ABS_Y, ABS_MT_SLOT, ABS_MT_TRACKING_ID, ABS_MT_POSITION_X, ABS_MT_POSITION_Y };
  for (unsigned i = 0; i < sizeof axes / sizeof *axes; i++) ioctl(fd, UI_SET_ABSBIT, axes[i]);
  ioctl(fd, UI_SET_PROPBIT, INPUT_PROP_DIRECT);
  struct uinput_setup us;
  memset(&us, 0, sizeof us);
  us.id.bustype = BUS_VIRTUAL;
  us.id.vendor = 0x1209;
  us.id.product = 0x7d04;
  snprintf(us.name, sizeof us.name, "TwinDesk virtual touchscreen"); // "TwinDesk virtual": not read back (wl.c)
  if (ioctl(fd, UI_DEV_SETUP, &us) < 0) goto fail;
  abs_setup(ABS_X, TMAXV, 200); // libinput needs a size: about 33 cm wide
  abs_setup(ABS_Y, TMAXV, 200);
  abs_setup(ABS_MT_POSITION_X, TMAXV, 200);
  abs_setup(ABS_MT_POSITION_Y, TMAXV, 200);
  abs_setup(ABS_MT_SLOT, SLOTS - 1, 0);
  abs_setup(ABS_MT_TRACKING_ID, 65535, 0);
  if (ioctl(fd, UI_DEV_CREATE) < 0) goto fail;
  bornAt = now_ms();
  return 1;
fail:
  fprintf(stderr, "touch: no uinput touch screen, a finger is the mouse\n");
  close(fd);
  fd = -1;
  return 0;
}

// "id,x,y;id,x,y" (desktop px, as moveTo) into ids/xs/ys; returns how many.
static int parse(const char *p, int *ids, int *xs, int *ys) {
  int n = 0;
  while (p && *p && n < SLOTS) {
    char *e;
    long id = strtol(p, &e, 10);
    if (*e != ',') break;
    long x = strtol(e + 1, &e, 10);
    if (*e != ',') break;
    long y = strtol(e + 1, &e, 10);
    if (id >= 0 && id < SLOTS) { ids[n] = (int)id; xs[n] = (int)x; ys[n] = (int)y; n++; }
    p = *e == ';' ? e + 1 : NULL;
  }
  return n;
}

static void mouse(int wl, int n, const int *ids, const int *xs, const int *ys) {
  for (int i = 0; i < n; i++) if (ids[i] == mouseId) {
    if (wl) wl_move_to(xs[i], ys[i]); else inject_move_to(xs[i], ys[i]);
    return;
  }
  if (mouseDown) { mouseDown = 0; if (wl) wl_button(0, 0); else inject_button(0, 0); }
  mouseId = -1;
  if (!n) return;
  mouseId = ids[0];
  if (wl) wl_move_to(xs[0], ys[0]); else inject_move_to(xs[0], ys[0]);
  mouseDown = 1;
  if (wl) wl_button(0, 1); else inject_button(0, 1);
}

// Every finger touching now (`p`, "" = none).
void touch_set(int wl, const char *p) {
  int ids[SLOTS], xs[SLOTS], ys[SLOTS];
  int n = parse(p, ids, xs, ys);
  if (!ready()) { mouse(wl, n, ids, xs, ys); return; }
  if (now_ms() - bornAt < 300) return; // the desktop opens a new device a moment later
  int bx, by, bw, bh;
  screens_box(&bx, &by, &bw, &bh);
  int now[SLOTS] = { 0 };
  int any = 0;
  for (int i = 0; i < n; i++) {
    int s = ids[i];
    int ax = (int)lround((xs[i] - bx) * (double)TMAXV / (bw > 1 ? bw - 1 : 1));
    int ay = (int)lround((ys[i] - by) * (double)TMAXV / (bh > 1 ? bh - 1 : 1));
    ax = ax < 0 ? 0 : ax > TMAXV ? TMAXV : ax;
    ay = ay < 0 ? 0 : ay > TMAXV ? TMAXV : ay;
    temit(EV_ABS, ABS_MT_SLOT, s);
    if (!downs[s]) temit(EV_ABS, ABS_MT_TRACKING_ID, tracking++ & 0xffff);
    temit(EV_ABS, ABS_MT_POSITION_X, ax);
    temit(EV_ABS, ABS_MT_POSITION_Y, ay);
    if (!any) { temit(EV_ABS, ABS_X, ax); temit(EV_ABS, ABS_Y, ay); }
    now[s] = 1;
    any = 1;
  }
  int was = 0;
  for (int s = 0; s < SLOTS; s++) {
    if (downs[s]) was = 1;
    if (downs[s] && !now[s]) { temit(EV_ABS, ABS_MT_SLOT, s); temit(EV_ABS, ABS_MT_TRACKING_ID, -1); }
    downs[s] = now[s];
  }
  if (any != was) temit(EV_KEY, BTN_TOUCH, any);
  temit(EV_SYN, SYN_REPORT, 0);
}

// Lift every finger (a session ended, releaseAll).
void touch_leave(int wl) {
  int was = mouseDown;
  for (int s = 0; s < SLOTS; s++) was |= downs[s];
  if (was) touch_set(wl, "");
}

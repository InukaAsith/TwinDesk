// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Dev only (pad-test.js): a fake multi-touch touchpad through /dev/uinput, for the helper's touchpad
// gestures (wl.c pad_frame, #222). Reads frames on stdin, one per line:
//   f <fingers> <x0> <y0> <x1> <y1>    fingers 0 = all lifted; pad units, 40 per mm (100 × 62 mm)
// Build: gcc -O2 -o bin/fakepad dev/fakepad.c ; run as a user who may open /dev/uinput.
#include <fcntl.h>
#include <linux/uinput.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

static int fd, tracking = 1, was;

static void ev(int type, int code, int value) {
  struct input_event ie;
  memset(&ie, 0, sizeof ie);
  ie.type = (unsigned short)type;
  ie.code = (unsigned short)code;
  ie.value = value;
  if (write(fd, &ie, sizeof ie) < 0) perror("write");
}

static void axis(int code, int max) {
  struct uinput_abs_setup a;
  memset(&a, 0, sizeof a);
  a.code = (unsigned short)code;
  a.absinfo.maximum = max;
  a.absinfo.resolution = code == ABS_MT_SLOT || code == ABS_MT_TRACKING_ID ? 0 : 40;
  ioctl(fd, UI_ABS_SETUP, &a);
}

int main(void) {
  fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
  if (fd < 0) { perror("/dev/uinput"); return 1; }
  ioctl(fd, UI_SET_EVBIT, EV_KEY);
  ioctl(fd, UI_SET_EVBIT, EV_ABS);
  int keys[] = { BTN_LEFT, BTN_TOUCH, BTN_TOOL_FINGER, BTN_TOOL_DOUBLETAP, BTN_TOOL_TRIPLETAP };
  for (unsigned i = 0; i < sizeof keys / sizeof *keys; i++) ioctl(fd, UI_SET_KEYBIT, keys[i]);
  int abs[] = { ABS_X, ABS_Y, ABS_MT_SLOT, ABS_MT_TRACKING_ID, ABS_MT_POSITION_X, ABS_MT_POSITION_Y };
  for (unsigned i = 0; i < sizeof abs / sizeof *abs; i++) ioctl(fd, UI_SET_ABSBIT, abs[i]);
  ioctl(fd, UI_SET_PROPBIT, INPUT_PROP_POINTER);
  ioctl(fd, UI_SET_PROPBIT, INPUT_PROP_BUTTONPAD);
  axis(ABS_X, 4000); axis(ABS_Y, 2500); axis(ABS_MT_POSITION_X, 4000); axis(ABS_MT_POSITION_Y, 2500);
  axis(ABS_MT_SLOT, 1); axis(ABS_MT_TRACKING_ID, 65535);
  struct uinput_setup s;
  memset(&s, 0, sizeof s);
  s.id.bustype = BUS_VIRTUAL;
  snprintf(s.name, sizeof s.name, "fake touchpad");
  ioctl(fd, UI_DEV_SETUP, &s);
  ioctl(fd, UI_DEV_CREATE);
  printf("ready\n");
  fflush(stdout);
  char line[128];
  int n, x[2], y[2];
  while (fgets(line, sizeof line, stdin)) {
    if (sscanf(line, "f %d %d %d %d %d", &n, &x[0], &y[0], &x[1], &y[1]) != 5) continue;
    for (int sl = 0; sl < 2; sl++) {
      ev(EV_ABS, ABS_MT_SLOT, sl);
      if (n > sl) {
        if (was <= sl) ev(EV_ABS, ABS_MT_TRACKING_ID, tracking++);
        ev(EV_ABS, ABS_MT_POSITION_X, x[sl]);
        ev(EV_ABS, ABS_MT_POSITION_Y, y[sl]);
      } else if (was > sl) ev(EV_ABS, ABS_MT_TRACKING_ID, -1);
    }
    if (n) { ev(EV_ABS, ABS_X, x[0]); ev(EV_ABS, ABS_Y, y[0]); }
    if ((n > 0) != (was > 0)) ev(EV_KEY, BTN_TOUCH, n > 0);
    if ((n == 1) != (was == 1)) ev(EV_KEY, BTN_TOOL_FINGER, n == 1);
    if ((n == 2) != (was == 2)) ev(EV_KEY, BTN_TOOL_DOUBLETAP, n == 2);
    if ((n == 3) != (was == 3)) ev(EV_KEY, BTN_TOOL_TRIPLETAP, n == 3);
    ev(EV_SYN, SYN_REPORT, 0);
    was = n;
  }
  ioctl(fd, UI_DEV_DESTROY);
  return 0;
}

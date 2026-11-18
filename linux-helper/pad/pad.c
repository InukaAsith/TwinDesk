// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// twindesk-pad: Remote › Real gamepad on Linux (linux/gamepad.js). A uinput gamepad, "TwinDesk
// Gamepad", with an Xbox 360 controller's ids and layout (the kernel's xpad driver's), so games and
// SDL map it as one. Pad states come on stdin, 12 bytes each, little-endian: u16 buttons (A B X Y
// LB RB Back Start L3 R3 Up Down Left Right, bits 0..13), i16 lx ly rx ry (y down), u8 lt rt. The
// gamepad is there until stdin closes. Exit 2: /dev/uinput can't be opened.
// twindesk-pad ds4: a PlayStation DualShock 4 instead (#266), with Sony's ids and the layout of the
// kernel's hid-playstation driver (Cross Circle Square Triangle, L2/R2 as buttons too), for games
// that only take a PlayStation controller.
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <linux/uinput.h>

static const int KEYS[10] = { BTN_A, BTN_B, BTN_X, BTN_Y, BTN_TL, BTN_TR, BTN_SELECT, BTN_START, BTN_THUMBL, BTN_THUMBR };
// DualShock 4: A B X Y are Cross Circle Square Triangle (Square on the left, as X), Back Share, Start Options.
static const int DS4_KEYS[10] = { BTN_SOUTH, BTN_EAST, BTN_WEST, BTN_NORTH, BTN_TL, BTN_TR, BTN_SELECT, BTN_START, BTN_THUMBL, BTN_THUMBR };

static int fd = -1;

static void emit(int type, int code, int value) {
  struct input_event ev;
  memset(&ev, 0, sizeof ev);
  ev.type = type;
  ev.code = code;
  ev.value = value;
  if (write(fd, &ev, sizeof ev) < 0) { /* the device went: stdin closing ends it */ }
}

static int axis(int code, int min, int max, int flat) {
  struct uinput_abs_setup a;
  memset(&a, 0, sizeof a);
  a.code = code;
  a.absinfo.minimum = min;
  a.absinfo.maximum = max;
  a.absinfo.flat = flat;
  a.absinfo.fuzz = code == ABS_Z || code == ABS_RZ || code == ABS_HAT0X || code == ABS_HAT0Y ? 0 : 16;
  return ioctl(fd, UI_ABS_SETUP, &a);
}

static int readAll(uint8_t *buf, size_t n) {
  size_t got = 0;
  while (got < n) {
    ssize_t r = read(0, buf + got, n - got);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return 0;
    got += (size_t)r;
  }
  return 1;
}

int main(int argc, char **argv) {
  const int ds4 = argc > 1 && strcmp(argv[1], "ds4") == 0;
  const int *keys = ds4 ? DS4_KEYS : KEYS;
  fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
  if (fd < 0) { fprintf(stderr, "twindesk-pad: /dev/uinput: %s\n", strerror(errno)); return 2; }
  ioctl(fd, UI_SET_EVBIT, EV_KEY);
  ioctl(fd, UI_SET_EVBIT, EV_ABS);
  for (int i = 0; i < 10; i++) ioctl(fd, UI_SET_KEYBIT, keys[i]);
  ioctl(fd, UI_SET_KEYBIT, BTN_MODE);
  if (ds4) { ioctl(fd, UI_SET_KEYBIT, BTN_TL2); ioctl(fd, UI_SET_KEYBIT, BTN_TR2); }
  int abs[] = { ABS_X, ABS_Y, ABS_RX, ABS_RY, ABS_Z, ABS_RZ, ABS_HAT0X, ABS_HAT0Y };
  for (size_t i = 0; i < sizeof abs / sizeof abs[0]; i++) ioctl(fd, UI_SET_ABSBIT, abs[i]);
  if (axis(ABS_X, -32768, 32767, 128) || axis(ABS_Y, -32768, 32767, 128) || axis(ABS_RX, -32768, 32767, 128) || axis(ABS_RY, -32768, 32767, 128)
      || axis(ABS_Z, 0, 255, 0) || axis(ABS_RZ, 0, 255, 0) || axis(ABS_HAT0X, -1, 1, 0) || axis(ABS_HAT0Y, -1, 1, 0)) {
    fprintf(stderr, "twindesk-pad: UI_ABS_SETUP: %s\n", strerror(errno));
    return 2;
  }
  struct uinput_setup setup;
  memset(&setup, 0, sizeof setup);
  setup.id.bustype = BUS_USB;
  setup.id.vendor = ds4 ? 0x054c : 0x045e; // Sony : Microsoft
  setup.id.product = ds4 ? 0x09cc : 0x028e; // DualShock 4 (second model) : Xbox 360 Controller
  setup.id.version = ds4 ? 0x8111 : 0x0110; // hid-playstation's, as SDL's mapping for it expects
  snprintf(setup.name, UINPUT_MAX_NAME_SIZE, ds4 ? "TwinDesk Wireless Controller" : "TwinDesk Gamepad");
  if (ioctl(fd, UI_DEV_SETUP, &setup) || ioctl(fd, UI_DEV_CREATE)) {
    fprintf(stderr, "twindesk-pad: uinput: %s\n", strerror(errno));
    return 2;
  }

  uint8_t b[12];
  while (readAll(b, sizeof b)) {
    unsigned bits = b[0] | b[1] << 8;
    for (int i = 0; i < 10; i++) emit(EV_KEY, keys[i], !!(bits & (1u << i)));
    if (ds4) { emit(EV_KEY, BTN_TL2, b[10] > 0); emit(EV_KEY, BTN_TR2, b[11] > 0); }
    emit(EV_ABS, ABS_X, (int16_t)(b[2] | b[3] << 8));
    emit(EV_ABS, ABS_Y, (int16_t)(b[4] | b[5] << 8));
    emit(EV_ABS, ABS_RX, (int16_t)(b[6] | b[7] << 8));
    emit(EV_ABS, ABS_RY, (int16_t)(b[8] | b[9] << 8));
    emit(EV_ABS, ABS_Z, b[10]);
    emit(EV_ABS, ABS_RZ, b[11]);
    emit(EV_ABS, ABS_HAT0X, (bits >> 13 & 1) - (bits >> 12 & 1)); // Right - Left
    emit(EV_ABS, ABS_HAT0Y, (bits >> 11 & 1) - (bits >> 10 & 1)); // Down - Up
    emit(EV_SYN, SYN_REPORT, 0);
  }
  ioctl(fd, UI_DEV_DESTROY);
  close(fd);
  return 0;
}

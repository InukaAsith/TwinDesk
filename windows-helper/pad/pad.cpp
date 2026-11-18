// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// twindesk-pad.exe (windows/gamepad.js): the phone's gamepad as a real Xbox 360 controller, through
// the ViGEmBus driver (ViGEmClient, MIT, in vigem\). Spawned only while Real gamepad is on.
//   twindesk-pad status   prints {"bus":true|false}: whether ViGEmBus is there
//   twindesk-pad feed ds4 the same as a PlayStation DualShock 4 (#266): A B X Y are Cross Circle
//                         Square Triangle, Back Share, Start Options
//   twindesk-pad feed     plugs in the controller, then reads pad states from stdin (12 bytes each,
//                         little-endian: u16 buttons, i16 lx ly rx ry with y down, u8 lt rt; the
//                         buttons A B X Y LB RB Back Start L3 R3 Up Down Left Right are bits 0..13)
//                         until stdin closes, then unplugs it. Exit 2: no ViGEmBus; 3: not plugged in.
#include <windows.h>
#include <cstdio>
#include <cstdint>
#include "ViGEm/Client.h"

static const USHORT XUSB_BITS[14] = {
  XUSB_GAMEPAD_A, XUSB_GAMEPAD_B, XUSB_GAMEPAD_X, XUSB_GAMEPAD_Y,
  XUSB_GAMEPAD_LEFT_SHOULDER, XUSB_GAMEPAD_RIGHT_SHOULDER, XUSB_GAMEPAD_BACK, XUSB_GAMEPAD_START,
  XUSB_GAMEPAD_LEFT_THUMB, XUSB_GAMEPAD_RIGHT_THUMB,
  XUSB_GAMEPAD_DPAD_UP, XUSB_GAMEPAD_DPAD_DOWN, XUSB_GAMEPAD_DPAD_LEFT, XUSB_GAMEPAD_DPAD_RIGHT,
};

// Up is positive in XInput: the phone's y (down) turned over, kept in range.
static SHORT up(int16_t v) { return v == -32768 ? 32767 : (SHORT)-v; }

static bool readAll(HANDLE in, uint8_t* buf, DWORD n) {
  DWORD got = 0;
  while (got < n) {
    DWORD r = 0;
    if (!ReadFile(in, buf + got, n - got, &r, nullptr) || r == 0) return false;
    got += r;
  }
  return true;
}

int main(int argc, char** argv) {
  const char* cmd = argc > 1 ? argv[1] : "";
  PVIGEM_CLIENT client = vigem_alloc();
  if (!client) return 1;
  bool bus = VIGEM_SUCCESS(vigem_connect(client));
  if (strcmp(cmd, "status") == 0) {
    printf("{\"bus\":%s}\n", bus ? "true" : "false");
    vigem_free(client);
    return 0;
  }
  if (strcmp(cmd, "feed") != 0) { fprintf(stderr, "usage: twindesk-pad status|feed\n"); return 1; }
  if (!bus) { vigem_free(client); return 2; }

  const bool ds4 = argc > 2 && strcmp(argv[2], "ds4") == 0;
  PVIGEM_TARGET pad = ds4 ? vigem_target_ds4_alloc() : vigem_target_x360_alloc();
  if (!VIGEM_SUCCESS(vigem_target_add(client, pad))) {
    vigem_target_free(pad);
    vigem_disconnect(client);
    vigem_free(client);
    return 3;
  }
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  uint8_t b[12];
  while (readAll(in, b, sizeof b)) {
    uint16_t bits = (uint16_t)(b[0] | b[1] << 8);
    auto axis = [&](int i) { return (int16_t)(b[i] | b[i + 1] << 8); };
    XUSB_REPORT r = {};
    for (int i = 0; i < 14; i++) if (bits & (1u << i)) r.wButtons |= XUSB_BITS[i];
    r.sThumbLX = axis(2);
    r.sThumbLY = up(axis(4));
    r.sThumbRX = axis(6);
    r.sThumbRY = up(axis(8));
    r.bLeftTrigger = b[10];
    r.bRightTrigger = b[11];
    if (ds4) {
      DS4_REPORT d;
      DS4_REPORT_INIT(&d);
      static const USHORT DS4_BITS[10] = {
        DS4_BUTTON_CROSS, DS4_BUTTON_CIRCLE, DS4_BUTTON_SQUARE, DS4_BUTTON_TRIANGLE,
        DS4_BUTTON_SHOULDER_LEFT, DS4_BUTTON_SHOULDER_RIGHT, DS4_BUTTON_SHARE, DS4_BUTTON_OPTIONS,
        DS4_BUTTON_THUMB_LEFT, DS4_BUTTON_THUMB_RIGHT,
      };
      for (int i = 0; i < 10; i++) if (bits & (1u << i)) d.wButtons |= DS4_BITS[i];
      if (b[10]) d.wButtons |= DS4_BUTTON_TRIGGER_LEFT;
      if (b[11]) d.wButtons |= DS4_BUTTON_TRIGGER_RIGHT;
      d.bTriggerL = b[10];
      d.bTriggerR = b[11];
      // Sticks 0..255 with y down, as the phone sends them (128 is the middle).
      auto byte = [](int16_t v) { return (BYTE)((v + 32768) >> 8); };
      d.bThumbLX = byte(axis(2));
      d.bThumbLY = byte(axis(4));
      d.bThumbRX = byte(axis(6));
      d.bThumbRY = byte(axis(8));
      bool u = bits & (1u << 10), dn = bits & (1u << 11), l = bits & (1u << 12), rt = bits & (1u << 13);
      DS4_DPAD_DIRECTIONS dir = DS4_BUTTON_DPAD_NONE;
      if (u && rt) dir = DS4_BUTTON_DPAD_NORTHEAST; else if (rt && dn) dir = DS4_BUTTON_DPAD_SOUTHEAST;
      else if (dn && l) dir = DS4_BUTTON_DPAD_SOUTHWEST; else if (l && u) dir = DS4_BUTTON_DPAD_NORTHWEST;
      else if (u) dir = DS4_BUTTON_DPAD_NORTH; else if (rt) dir = DS4_BUTTON_DPAD_EAST;
      else if (dn) dir = DS4_BUTTON_DPAD_SOUTH; else if (l) dir = DS4_BUTTON_DPAD_WEST;
      DS4_SET_DPAD(&d, dir);
      vigem_target_ds4_update(client, pad, d);
      continue;
    }
    vigem_target_x360_update(client, pad, r);
  }
  vigem_target_remove(client, pad);
  vigem_target_free(pad);
  vigem_disconnect(client);
  vigem_free(client);
  return 0;
}

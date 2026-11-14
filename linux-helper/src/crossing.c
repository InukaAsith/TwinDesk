// TwinDesk — Copyright (C) 2026 inukaasith, pengusto. GPL-3.0, see LICENSE.
// Hold a key to cross (kvmConfig crossingModifier, #230) and the emergency return shortcut
// (kvmConfig emergencyKeys, #178), as the Mac and Windows helpers have them, for both backends.
// Crossing bits (k.mod flags, the edge's crossingFlags): 1 Super, 2 Control, 4 Alt, 8 Shift.
#include "helper.h"
#include <stdio.h>
#include <string.h>

static int need;            // the bit to hold to leave at the edge, 0: cross as before
static int retRequire;      // driven by a peer that reports its keys: the way back needs it too
static int remoteBits;      // the driver's held modifiers
static unsigned char mods[256]; // modifiers down here, by evdev code
static int watch, sent = -1;
static int emEv = 1, emBits = 7; // Control+Alt+Super+Escape
static int active;          // a session is on
static int gate;            // 0 open, 1 stopping (until the session ends), 2 until a new one starts
static unsigned char emHeld[256];

static int bit_of(int ev) {
  switch (ev) {
    case 125: case 126: return 1;
    case 29: case 97: return 2;
    case 56: case 100: return 4;
    case 42: case 54: return 8;
  }
  return 0;
}

int crossing_bits(void) {
  int b = 0;
  for (int i = 0; i < 256; i++) if (mods[i]) b |= bit_of(i);
  return b;
}

static int allows(int bits) { return !need || (bits & need); }
int crossing_edge_ok(void) { return allows(crossing_bits()); }
int crossing_return_ok(void) { return !retRequire || allows(remoteBits | crossing_bits()); }
void crossing_require_return(int on) { retRequire = on; }
void crossing_remote(int bits) { remoteBits = bits & 15; }
int crossing_blocked(void) { return gate == 1; }

// "Control+Alt+Command+Escape" (shared/crossing.js already checked it; anything off is the default)
static void parse_emergency(const char *v) {
  emEv = 1; emBits = 7;
  if (!v || strlen(v) > 60) return;
  char buf[64];
  snprintf(buf, sizeof buf, "%s", v);
  int bits = 0;
  char *last = strrchr(buf, '+');
  char *key = last ? last + 1 : buf;
  if (last) {
    *last = 0;
    for (char *t = strtok(buf, "+"); t; t = strtok(NULL, "+")) {
      int b = !strcmp(t, "Command") ? 1 : !strcmp(t, "Control") ? 2 : !strcmp(t, "Alt") ? 4 : !strcmp(t, "Shift") ? 8 : 0;
      if (!b) return;
      bits |= b;
    }
  }
  char code[80];
  size_t n = strlen(key);
  if (n == 1 && key[0] >= 'A' && key[0] <= 'Z') snprintf(code, sizeof code, "Key%s", key);
  else if (n == 1 && key[0] >= '0' && key[0] <= '9') snprintf(code, sizeof code, "Digit%s", key);
  else if (!strcmp(key, "Up") || !strcmp(key, "Down") || !strcmp(key, "Left") || !strcmp(key, "Right")) snprintf(code, sizeof code, "Arrow%s", key);
  else snprintf(code, sizeof code, "%s", key);
  int ev = key_evdev(code);
  if (ev <= 0) return;
  emEv = ev; emBits = bits;
}

void crossing_config(const JObj *c) {
  const char *m = jstr(c, "crossingModifier", "");
  need = !strcmp(m, "Command") ? 1 : !strcmp(m, "Control") ? 2 : !strcmp(m, "Alt") ? 4 : !strcmp(m, "Shift") ? 8 : 0;
  parse_emergency(jstr(c, "emergencyKeys", NULL));
}

static void send_bits(void (*fwd)(const char *)) {
  int b = crossing_bits();
  if (b == sent || !fwd) return;
  sent = b;
  JOut k;
  jo_begin(&k);
  jo_str(&k, "t", "k.mod");
  jo_num(&k, "flags", b);
  fwd(jo_end(&k));
}

// A compatible peer accepted: it hears our modifiers from now on, while we drive it.
void crossing_watch(int capturingMouse, void (*fwd)(const char *)) {
  if (!capturingMouse) return;
  watch = 1; sent = -1;
  send_bits(fwd);
}
void crossing_reset(void) { watch = 0; sent = -1; }

void crossing_session(int on) {
  active = on;
  if (!on && gate == 1) gate = 2;
  else if (on && gate == 2) gate = 0;
}

// Every key, first. value: 1 down, 0 up, 2 repeat. Returns 0 (go on), 1 (swallow: the emergency
// key's repeat or release), 2 (the emergency shortcut: the backend stops, then crossing_emergency).
int crossing_key(int ev, int value, int capturing, int capturingMouse, void (*fwd)(const char *)) {
  if (ev < 0 || ev > 255) return 0;
  if (emHeld[ev]) { if (value == 0) emHeld[ev] = 0; return 1; }
  if (value != 2 && bit_of(ev)) {
    mods[ev] = (unsigned char)value;
    if (capturingMouse && watch) send_bits(fwd);
  }
  if (value != 1 || !(active || capturing)) return 0;
  if (ev != emEv || crossing_bits() != emBits) return 0;
  gate = 1;
  emHeld[ev] = 1;
  return 2;
}

// After the backend stopped capturing (or let go of what it injected).
void crossing_emergency(void) {
  active = 0;
  crossing_reset();
  emit("{\"event\":\"emergency\"}");
}

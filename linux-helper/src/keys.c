// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// DOM KeyboardEvent.code <-> Linux evdev key codes (linux/input-event-codes.h). X keycode =
// evdev + 8 with the evdev/libinput drivers. Same keys as windows-helper/src/Keys.cs.
#include "helper.h"
#include <string.h>
#include <X11/XKBlib.h>
#include <X11/extensions/XTest.h>

typedef struct { const char *code; int ev; } Key;

static const Key KEYS[] = {
  { "Escape", 1 },
  { "Digit1", 2 }, { "Digit2", 3 }, { "Digit3", 4 }, { "Digit4", 5 }, { "Digit5", 6 },
  { "Digit6", 7 }, { "Digit7", 8 }, { "Digit8", 9 }, { "Digit9", 10 }, { "Digit0", 11 },
  { "Minus", 12 }, { "Equal", 13 }, { "Backspace", 14 }, { "Tab", 15 },
  { "KeyQ", 16 }, { "KeyW", 17 }, { "KeyE", 18 }, { "KeyR", 19 }, { "KeyT", 20 },
  { "KeyY", 21 }, { "KeyU", 22 }, { "KeyI", 23 }, { "KeyO", 24 }, { "KeyP", 25 },
  { "BracketLeft", 26 }, { "BracketRight", 27 }, { "Enter", 28 }, { "ControlLeft", 29 },
  { "KeyA", 30 }, { "KeyS", 31 }, { "KeyD", 32 }, { "KeyF", 33 }, { "KeyG", 34 },
  { "KeyH", 35 }, { "KeyJ", 36 }, { "KeyK", 37 }, { "KeyL", 38 },
  { "Semicolon", 39 }, { "Quote", 40 }, { "Backquote", 41 }, { "ShiftLeft", 42 }, { "Backslash", 43 },
  { "KeyZ", 44 }, { "KeyX", 45 }, { "KeyC", 46 }, { "KeyV", 47 }, { "KeyB", 48 },
  { "KeyN", 49 }, { "KeyM", 50 },
  { "Comma", 51 }, { "Period", 52 }, { "Slash", 53 }, { "ShiftRight", 54 },
  { "NumpadMultiply", 55 }, { "AltLeft", 56 }, { "Space", 57 }, { "CapsLock", 58 },
  { "F1", 59 }, { "F2", 60 }, { "F3", 61 }, { "F4", 62 }, { "F5", 63 },
  { "F6", 64 }, { "F7", 65 }, { "F8", 66 }, { "F9", 67 }, { "F10", 68 },
  { "NumLock", 69 }, { "ScrollLock", 70 },
  { "Numpad7", 71 }, { "Numpad8", 72 }, { "Numpad9", 73 }, { "NumpadSubtract", 74 },
  { "Numpad4", 75 }, { "Numpad5", 76 }, { "Numpad6", 77 }, { "NumpadAdd", 78 },
  { "Numpad1", 79 }, { "Numpad2", 80 }, { "Numpad3", 81 }, { "Numpad0", 82 }, { "NumpadDecimal", 83 },
  { "IntlBackslash", 86 }, { "F11", 87 }, { "F12", 88 }, { "IntlRo", 89 },
  { "Convert", 92 }, { "KanaMode", 93 }, { "NonConvert", 94 },
  { "NumpadEnter", 96 }, { "ControlRight", 97 }, { "NumpadDivide", 98 }, { "PrintScreen", 99 },
  { "AltRight", 100 }, { "Home", 102 }, { "ArrowUp", 103 }, { "PageUp", 104 },
  { "ArrowLeft", 105 }, { "ArrowRight", 106 }, { "End", 107 }, { "ArrowDown", 108 },
  { "PageDown", 109 }, { "Insert", 110 }, { "Delete", 111 },
  { "AudioVolumeMute", 113 }, { "AudioVolumeDown", 114 }, { "AudioVolumeUp", 115 },
  { "NumpadEqual", 117 }, { "Pause", 119 }, { "NumpadComma", 121 },
  { "Lang1", 122 }, { "Lang2", 123 }, { "IntlYen", 124 },
  { "MetaLeft", 125 }, { "MetaRight", 126 }, { "ContextMenu", 127 },
  { "MediaTrackNext", 163 }, { "MediaPlayPause", 164 }, { "MediaTrackPrevious", 165 }, { "MediaStop", 166 },
  { "MediaRewind", 168 }, { "MediaFastForward", 208 }, { "BrightnessDown", 224 }, { "BrightnessUp", 225 },
  { "KbdIllumToggle", 228 }, { "KbdIllumDown", 229 }, { "KbdIllumUp", 230 },
  { "F13", 183 }, { "F14", 184 }, { "F15", 185 }, { "F16", 186 }, { "F17", 187 }, { "F18", 188 },
  { "F19", 189 }, { "F20", 190 }, { "F21", 191 }, { "F22", 192 }, { "F23", 193 }, { "F24", 194 },
};

#define NKEYS (int)(sizeof KEYS / sizeof KEYS[0])

int key_evdev(const char *code) {
  if (!code) return -1;
  for (int i = 0; i < NKEYS; i++) if (!strcmp(KEYS[i].code, code)) return KEYS[i].ev;
  return -1;
}

const char *key_code(int ev) {
  for (int i = 0; i < NKEYS; i++) if (KEYS[i].ev == ev) return KEYS[i].code;
  return NULL;
}

// Keys that type a character: letters, digits, punctuation.
static int typing(const char *code) {
  static const char *PUNCT[] = { "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon",
    "Quote", "Backquote", "Comma", "Period", "Slash", "IntlBackslash", NULL };
  if (!strncmp(code, "Key", 3) || !strncmp(code, "Digit", 5)) return 1;
  for (int i = 0; PUNCT[i]; i++) if (!strcmp(code, PUNCT[i])) return 1;
  return 0;
}

static void utf8(unsigned cp, char *out) {
  if (cp < 0x80) { out[0] = (char)cp; out[1] = 0; }
  else if (cp < 0x800) { out[0] = (char)(0xc0 | cp >> 6); out[1] = (char)(0x80 | (cp & 0x3f)); out[2] = 0; }
  else if (cp < 0x10000) { out[0] = (char)(0xe0 | cp >> 12); out[1] = (char)(0x80 | (cp >> 6 & 0x3f)); out[2] = (char)(0x80 | (cp & 0x3f)); out[3] = 0; }
  else { out[0] = (char)(0xf0 | cp >> 18); out[1] = (char)(0x80 | (cp >> 12 & 0x3f)); out[2] = (char)(0x80 | (cp >> 6 & 0x3f)); out[3] = (char)(0x80 | (cp & 0x3f)); out[4] = 0; }
}

// What each of those keys types in the current X layout (its active group) at a level: 0 alone,
// lower case ({"KeyY":"z",…} with a German layout), 1 with Shift, as it is (Sinhala's ඛ on the ක key).
// Latin-1 and Unicode keysyms.
static const char *layout_level(Display *dpy, int group, int level) {
  static JOut map; // jo_end's result lives in it until the next call
  jo_begin(&map);
  for (int i = 0; i < NKEYS; i++) {
    if (!typing(KEYS[i].code)) continue;
    KeySym ks = XkbKeycodeToKeysym(dpy, (KeyCode)(KEYS[i].ev + 8), group, level);
    unsigned cp = 0;
    if ((ks >= 0x20 && ks <= 0x7e) || (ks >= 0xa0 && ks <= 0xff)) cp = (unsigned)ks;
    else if ((ks & 0xff000000) == 0x01000000) cp = (unsigned)(ks & 0xffffff);
    if (!cp) continue;
    if (!level && ((cp >= 'A' && cp <= 'Z') || (cp >= 0xc0 && cp <= 0xde && cp != 0xd7))) cp += 32;
    char u[8];
    utf8(cp, u);
    jo_str(&map, KEYS[i].code, u);
  }
  return jo_end(&map);
}

// keyLayout: what each key types alone and with Shift (shared/keylayout.js); on Wayland (no X
// display here) nothing.
void keys_layout(double id, Display *dpy) {
  JOut o;
  jo_begin(&o);
  jo_num(&o, "id", id);
  jo_bool(&o, "ok", 1);
  XkbStateRec st;
  int group = 0;
  if (dpy && XkbGetState(dpy, XkbUseCoreKbd, &st) == Success) group = st.group;
  if (dpy) {
    jo_raw(&o, "layout", layout_level(dpy, group, 0));
    jo_raw(&o, "shift", layout_level(dpy, group, 1));
  } else {
    jo_raw(&o, "layout", "{}");
  }
  jo_bool(&o, "type", dpy != NULL); // it takes "type" (keys_type)
  emit(jo_end(&o));
}

// One UTF-8 character at *p: its code point, *p past it (0 at a bad byte).
static unsigned next_cp(const unsigned char **p) {
  const unsigned char *s = *p;
  unsigned cp;
  int n;
  if (s[0] < 0x80) { cp = s[0]; n = 1; }
  else if ((s[0] & 0xe0) == 0xc0) { cp = s[0] & 0x1f; n = 2; }
  else if ((s[0] & 0xf0) == 0xe0) { cp = s[0] & 0x0f; n = 3; }
  else if ((s[0] & 0xf8) == 0xf0) { cp = s[0] & 0x07; n = 4; }
  else { *p = s + 1; return 0; }
  for (int i = 1; i < n; i++) {
    if ((s[i] & 0xc0) != 0x80) { *p = s + i; return 0; }
    cp = cp << 6 | (s[i] & 0x3f);
  }
  *p = s + n;
  return cp;
}

// type: text as it is, whatever the X layout: a letter of another alphabet from the other computer's
// layout (shared/keylayout.js) or the phone Remote's keyboard. Each character goes on a spare key code
// (one with no keysym), mapped to it for the press as xdotool does; a few spare ones in turn, so a key
// event an app hasn't read yet is never read with the next character's mapping. X11 only.
void keys_type(Display *dpy, const char *text) {
  static int spare[8], nspare = -1, next = 0;
  if (!dpy || !text) return;
  if (nspare < 0) {
    nspare = 0;
    int lo, hi, per;
    XDisplayKeycodes(dpy, &lo, &hi);
    KeySym *m = XGetKeyboardMapping(dpy, (KeyCode)lo, hi - lo + 1, &per);
    for (int kc = hi; m && kc >= lo && nspare < 8; kc--) { // from the top: far from the real keys
      int empty = 1;
      for (int j = 0; j < per; j++) if (m[(kc - lo) * per + j] != NoSymbol) empty = 0;
      if (empty) spare[nspare++] = kc;
    }
    if (m) XFree(m);
  }
  if (!nspare) return;
  const unsigned char *p = (const unsigned char *)text;
  for (int n = 0; *p && n < 64; n++) {
    unsigned cp = next_cp(&p);
    if (cp < 0x20 || cp == 0x7f) continue;
    KeySym ks = (cp <= 0x7e || (cp >= 0xa0 && cp <= 0xff)) ? (KeySym)cp : (KeySym)(0x01000000 | cp);
    KeySym both[2] = { ks, ks }; // Shift may be held: the same character
    int kc = spare[next++ % nspare];
    XChangeKeyboardMapping(dpy, kc, 2, both, 1);
    XSync(dpy, False);
    XTestFakeKeyEvent(dpy, (unsigned)kc, True, CurrentTime);
    XTestFakeKeyEvent(dpy, (unsigned)kc, False, CurrentTime);
    XSync(dpy, False);
  }
}

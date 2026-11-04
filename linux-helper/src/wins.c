// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Top-level windows for Apps (linux/pcapps.js, the same commands as windows-helper): `windows`
// lists the desktop's app windows (EWMH _NET_CLIENT_LIST) and the menus / pop-ups on screen
// (override-redirect windows), with their process, class, title and place in physical pixels;
// `winRaise` / `winClose` ask the window manager (_NET_ACTIVE_WINDOW / _NET_CLOSE_WINDOW),
// `winSize` resizes, `winMove` puts the pointer at a point given 0–1 over the window. X11 only.
#include "helper.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>
#include <X11/keysym.h>

static Atom atom(const char *n) { return XInternAtom(dpy_in, n, False); }

// One CARDINAL / WINDOW / ATOM list property; returns the count (at most max).
static int prop_longs(Window w, Atom prop, Atom type, unsigned long *out, int max) {
  Atom at;
  int fmt;
  unsigned long n = 0, after;
  unsigned char *data = NULL;
  if (XGetWindowProperty(dpy_in, w, prop, 0, max, False, type, &at, &fmt, &n, &after, &data) != Success || !data) return 0;
  int k = 0;
  if (fmt == 32) for (unsigned long i = 0; i < n && k < max; i++) out[k++] = ((unsigned long *)data)[i];
  XFree(data);
  return k;
}

// A text property (UTF8_STRING, else STRING); caller frees.
static char *prop_text(Window w, Atom prop) {
  Atom at;
  int fmt;
  unsigned long n = 0, after;
  unsigned char *data = NULL;
  if (XGetWindowProperty(dpy_in, w, prop, 0, 1024, False, AnyPropertyType, &at, &fmt, &n, &after, &data) != Success || !data) return NULL;
  if (fmt != 8) { XFree(data); return NULL; }
  char *s = malloc(n + 1);
  memcpy(s, data, n);
  s[n] = 0;
  XFree(data);
  return s;
}

// Append s as a JSON string (escaped, control characters dropped).
static void put_str(char **buf, size_t *len, size_t *cap, const char *s) {
  size_t need = *len + strlen(s ? s : "") * 6 + 4;
  if (need > *cap) { *cap = need * 2; *buf = realloc(*buf, *cap); }
  char *o = *buf + *len;
  *o++ = '"';
  for (const unsigned char *p = (const unsigned char *)(s ? s : ""); *p; p++) {
    if (*p == '"' || *p == '\\') { *o++ = '\\'; *o++ = (char)*p; }
    else if (*p >= 0x20) *o++ = (char)*p;
  }
  *o++ = '"';
  *len = (size_t)(o - *buf);
}

static void put_raw(char **buf, size_t *len, size_t *cap, const char *s) {
  size_t n = strlen(s);
  if (*len + n + 1 > *cap) { *cap = (*len + n + 1) * 2; *buf = realloc(*buf, *cap); }
  memcpy(*buf + *len, s, n);
  *len += n;
}

static int geometry(Window w, int *x, int *y, int *ww, int *hh, int *viewable, int *override) {
  XWindowAttributes a;
  if (!XGetWindowAttributes(dpy_in, w, &a)) return 0;
  Window child;
  XTranslateCoordinates(dpy_in, w, root_in, 0, 0, x, y, &child);
  *ww = a.width;
  *hh = a.height;
  *viewable = a.map_state == IsViewable;
  *override = a.override_redirect;
  return 1;
}

// The invisible border a window draws around itself (a GTK window's shadow, client-side
// decorations): left, right, top, bottom. Places and sizes here are of what's inside it, as the
// window manager shows it; the capture is cut to it (linux/pcapps.js `inset`).
static void extents(Window w, int *l, int *r, int *t, int *b) {
  unsigned long e[4] = { 0 };
  if (prop_longs(w, atom("_GTK_FRAME_EXTENTS"), XA_CARDINAL, e, 4) != 4) e[0] = e[1] = e[2] = e[3] = 0;
  *l = (int)e[0]; *r = (int)e[1]; *t = (int)e[2]; *b = (int)e[3];
}

static int has_type(Window w, const char **names) {
  unsigned long t[8];
  int n = prop_longs(w, atom("_NET_WM_WINDOW_TYPE"), XA_ATOM, t, 8);
  for (int i = 0; i < n; i++) for (const char **p = names; *p; p++) if (t[i] == atom(*p)) return 1;
  return 0;
}

static int hidden(Window w) {
  unsigned long st[16];
  int n = prop_longs(w, atom("_NET_WM_STATE"), XA_ATOM, st, 16);
  for (int i = 0; i < n; i++) if (st[i] == atom("_NET_WM_STATE_HIDDEN")) return 1;
  return 0;
}

static void entry(char **buf, size_t *len, size_t *cap, int *first, Window w, int popup, Window owner) {
  int x, y, ww, hh, viewable, ovr;
  if (!geometry(w, &x, &y, &ww, &hh, &viewable, &ovr) || !viewable || ww < 2 || hh < 2) return;
  int l, r, t, b;
  extents(w, &l, &r, &t, &b);
  if (l + r >= ww - 1 || t + b >= hh - 1) l = r = t = b = 0;
  unsigned long pid = 0;
  prop_longs(w, atom("_NET_WM_PID"), XA_CARDINAL, &pid, 1);
  char *title = prop_text(w, atom("_NET_WM_NAME"));
  if (!title) title = prop_text(w, XA_WM_NAME);
  XClassHint ch = { 0 };
  XGetClassHint(dpy_in, w, &ch);
  char head[320];
  snprintf(head, sizeof head, "%s{\"wid\":%lu,\"pid\":%lu,\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d,\"inset\":[%d,%d,%d,%d],\"popup\":%s,\"owner\":%lu,\"scale\":1,\"title\":",
    *first ? "" : ",", (unsigned long)w, pid, x + l, y + t, ww - l - r, hh - t - b, l, r, t, b, popup ? "true" : "false", (unsigned long)owner);
  put_raw(buf, len, cap, head);
  put_str(buf, len, cap, title);
  put_raw(buf, len, cap, ",\"cls\":");
  put_str(buf, len, cap, ch.res_class);
  put_raw(buf, len, cap, ",\"inst\":");
  put_str(buf, len, cap, ch.res_name);
  put_raw(buf, len, cap, "}");
  *first = 0;
  free(title);
  if (ch.res_class) XFree(ch.res_class);
  if (ch.res_name) XFree(ch.res_name);
}

// {"id":n,"ok":true,"windows":[…]}: app windows first, then pop-ups (each with `owner` when the
// window says whose it is: WM_TRANSIENT_FOR).
void wins_list(double id) {
  size_t cap = 8192, len = 0;
  char *buf = malloc(cap);
  char head[64];
  snprintf(head, sizeof head, "{\"id\":%.0f,\"ok\":true,\"windows\":[", id);
  put_raw(&buf, &len, &cap, head);
  int first = 1;
  static const char *SKIP[] = { "_NET_WM_WINDOW_TYPE_DOCK", "_NET_WM_WINDOW_TYPE_DESKTOP", NULL };
  static const char *POP[] = { "_NET_WM_WINDOW_TYPE_DROPDOWN_MENU", "_NET_WM_WINDOW_TYPE_POPUP_MENU", "_NET_WM_WINDOW_TYPE_MENU",
    "_NET_WM_WINDOW_TYPE_COMBO", "_NET_WM_WINDOW_TYPE_TOOLTIP", NULL };
  unsigned long list[512];
  int n = prop_longs(root_in, atom("_NET_CLIENT_LIST"), XA_WINDOW, list, 512);
  for (int i = 0; i < n; i++) {
    Window w = (Window)list[i];
    if (has_type(w, SKIP) || hidden(w)) continue;
    entry(&buf, &len, &cap, &first, w, 0, 0);
  }
  // Menus and pop-ups: override-redirect children of the root.
  Window rr, pr, *kids = NULL;
  unsigned nk = 0;
  if (XQueryTree(dpy_in, root_in, &rr, &pr, &kids, &nk)) {
    for (unsigned i = 0; i < nk; i++) {
      XWindowAttributes a;
      if (!XGetWindowAttributes(dpy_in, kids[i], &a) || !a.override_redirect || a.map_state != IsViewable) continue;
      unsigned long pid = 0;
      if (!has_type(kids[i], POP) && !prop_longs(kids[i], atom("_NET_WM_PID"), XA_CARDINAL, &pid, 1)) continue;
      Window owner = 0;
      XGetTransientForHint(dpy_in, kids[i], &owner);
      entry(&buf, &len, &cap, &first, kids[i], 1, owner);
    }
    if (kids) XFree(kids);
  }
  put_raw(&buf, &len, &cap, "]}");
  buf[len] = 0;
  emit(buf);
  free(buf);
}

static void client_message(Window w, const char *type, long a0, long a1) {
  XEvent e;
  memset(&e, 0, sizeof e);
  e.xclient.type = ClientMessage;
  e.xclient.window = w;
  e.xclient.message_type = atom(type);
  e.xclient.format = 32;
  e.xclient.data.l[0] = a0;
  e.xclient.data.l[1] = a1;
  XSendEvent(dpy_in, root_in, False, SubstructureRedirectMask | SubstructureNotifyMask, &e);
  XFlush(dpy_in);
}

void wins_raise(unsigned long wid) {
  client_message((Window)wid, "_NET_ACTIVE_WINDOW", 2, CurrentTime); // 2 = a pager / tool asked
  XRaiseWindow(dpy_in, (Window)wid);
  XFlush(dpy_in);
}

void wins_close(unsigned long wid) { client_message((Window)wid, "_NET_CLOSE_WINDOW", CurrentTime, 2); }

void wins_size(unsigned long wid, int w, int h) {
  int l, r, t, b;
  extents((Window)wid, &l, &r, &t, &b);
  XResizeWindow(dpy_in, (Window)wid, (unsigned)(w + l + r), (unsigned)(h + t + b));
  XFlush(dpy_in);
}

// x, y: 0–1 over the window's content.
void wins_move(unsigned long wid, double x, double y) {
  int wx, wy, ww, hh, v, o;
  if (!geometry((Window)wid, &wx, &wy, &ww, &hh, &v, &o)) return;
  int l, r, t, b;
  extents((Window)wid, &l, &r, &t, &b);
  if (l + r < ww - 1 && t + b < hh - 1) { wx += l; wy += t; ww -= l + r; hh -= t + b; }
  inject_move_to(wx + (int)(x * (ww - 1) + 0.5), wy + (int)(y * (hh - 1) + 0.5));
}

// The app window holding w (w itself, or the child with WM_STATE under a window manager's frame).
static Window client_of(Window w, int depth) {
  Atom at;
  int fmt;
  unsigned long n = 0, after;
  unsigned char *data = NULL;
  if (XGetWindowProperty(dpy_in, w, atom("WM_STATE"), 0, 0, False, AnyPropertyType, &at, &fmt, &n, &after, &data) == Success && at != None) {
    if (data) XFree(data);
    return w;
  }
  if (data) XFree(data);
  if (depth > 4) return 0;
  Window rr, pr, *kids = NULL;
  unsigned nk = 0;
  Window found = 0;
  if (XQueryTree(dpy_in, w, &rr, &pr, &kids, &nk)) {
    for (unsigned i = nk; i-- > 0 && !found;) found = client_of(kids[i], depth + 1); // topmost first
    if (kids) XFree(kids);
  }
  return found;
}

// `activeWindow` / `windowAt` (under the pointer): which app window it is, for linux/fm.js (the
// file manager's folder for pastes and drops). GTK apps name their D-Bus window object.
void wins_info(double id, int atPointer) {
  Window w = 0;
  if (atPointer) {
    Window rr, child = 0;
    int rx, ry, wx, wy;
    unsigned m;
    XQueryPointer(dpy_in, root_in, &rr, &child, &rx, &ry, &wx, &wy, &m);
    if (child) w = client_of(child, 0);
    if (!w) w = child; // no window manager (or an override-redirect window): the top-level itself
  } else {
    unsigned long a = 0;
    if (prop_longs(root_in, atom("_NET_ACTIVE_WINDOW"), XA_WINDOW, &a, 1)) w = (Window)a;
  }
  size_t cap = 2048, len = 0;
  char *buf = malloc(cap);
  char head[96];
  snprintf(head, sizeof head, "{\"id\":%.0f,\"ok\":true,\"wid\":%lu", id, (unsigned long)w);
  put_raw(&buf, &len, &cap, head);
  if (w) {
    static const char *DESK[] = { "_NET_WM_WINDOW_TYPE_DESKTOP", NULL };
    char *title = prop_text(w, atom("_NET_WM_NAME"));
    if (!title) title = prop_text(w, XA_WM_NAME);
    char *object = prop_text(w, atom("_GTK_WINDOW_OBJECT_PATH"));
    char *bus = prop_text(w, atom("_GTK_UNIQUE_BUS_NAME"));
    char *app = prop_text(w, atom("_GTK_APPLICATION_ID"));
    XClassHint ch = { 0 };
    XGetClassHint(dpy_in, w, &ch);
    put_raw(&buf, &len, &cap, has_type(w, DESK) ? ",\"desktop\":true" : ",\"desktop\":false");
    const char *keys[] = { "title", "object", "bus", "app", "cls", "inst" };
    const char *vals[] = { title, object, bus, app, ch.res_class, ch.res_name };
    for (int i = 0; i < 6; i++) {
      put_raw(&buf, &len, &cap, ",\"");
      put_raw(&buf, &len, &cap, keys[i]);
      put_raw(&buf, &len, &cap, "\":");
      put_str(&buf, &len, &cap, vals[i]);
    }
    free(title); free(object); free(bus); free(app);
    if (ch.res_class) XFree(ch.res_class);
    if (ch.res_name) XFree(ch.res_name);
  }
  put_raw(&buf, &len, &cap, "}");
  buf[len] = 0;
  emit(buf);
  free(buf);
}

// ---- moving a window to another computer (linux/pcapps.js, shared/movewin.js) ----
// Apps › Move windows: the move key held (Right Ctrl unless another is chosen), a click
// on a window grabs it. A passive button grab on the root window with the key's modifier catches the
// click; if the exact key (left or right) isn't the one held, the click is replayed to the app as if
// nothing happened. While grabbed, the window follows the pointer (_NET_MOVERESIZE_WINDOW, which the
// window managers honour); crossing to another computer meanwhile takes it along (capture.c adds
// `moving`). Clicks injected from the other computer (XTest) trigger the grab the same way. X11 only.

static int mvKey;            // the move key's X keycode; 0: moving is off
static unsigned mvMod;       // its modifier mask (the passive grab)
static Window mvGrab;        // the app window following the pointer
static int mvDx, mvDy;       // the pointer's place in it (its client window)
static int mvUp;             // the left button's release is not passed on (its press wasn't)

static const unsigned MV_IGNORED[] = { 0, LockMask, Mod2Mask, LockMask | Mod2Mask }; // Caps Lock, Num Lock

static void mv_grabs(int on) {
  for (unsigned i = 0; i < sizeof MV_IGNORED / sizeof *MV_IGNORED; i++) {
    if (on) XGrabButton(dpy_in, Button1, mvMod | MV_IGNORED[i], root_in, False, ButtonPressMask | ButtonReleaseMask | PointerMotionMask, GrabModeSync, GrabModeAsync, None, None);
    else XUngrabButton(dpy_in, Button1, mvMod | MV_IGNORED[i], root_in);
  }
  XFlush(dpy_in);
}

// `moveWin {key}`: "ControlRight" … "MetaLeft", "" = off.
void wins_move_key(const char *key) {
  if (mvKey) mv_grabs(0);
  mvKey = 0;
  mvGrab = 0;
  if (!key || !*key) return;
  KeySym ks = 0;
  if (!strcmp(key, "ControlRight")) ks = XK_Control_R, mvMod = ControlMask;
  else if (!strcmp(key, "ControlLeft")) ks = XK_Control_L, mvMod = ControlMask;
  else if (!strcmp(key, "ShiftRight")) ks = XK_Shift_R, mvMod = ShiftMask;
  else if (!strcmp(key, "ShiftLeft")) ks = XK_Shift_L, mvMod = ShiftMask;
  else if (!strcmp(key, "AltRight")) ks = XK_ISO_Level3_Shift, mvMod = Mod5Mask; // AltGr on most layouts
  else if (!strcmp(key, "AltLeft")) ks = XK_Alt_L, mvMod = Mod1Mask;
  else if (!strcmp(key, "MetaRight")) ks = XK_Super_R, mvMod = Mod4Mask;
  else if (!strcmp(key, "MetaLeft")) ks = XK_Super_L, mvMod = Mod4Mask;
  if (!ks) return;
  if (!strcmp(key, "AltRight") && !XKeysymToKeycode(dpy_in, ks)) ks = XK_Alt_R, mvMod = Mod1Mask;
  mvKey = XKeysymToKeycode(dpy_in, ks);
  if (mvKey) mv_grabs(1);
}

static int mv_key_held(void) {
  char keys[32];
  XQueryKeymap(dpy_in, keys);
  return (keys[mvKey / 8] >> (mvKey % 8)) & 1;
}

// The client window's top left (root coordinates) to x, y: StaticGravity means the client itself.
static void mv_to(Window w, int x, int y) {
  XEvent e;
  memset(&e, 0, sizeof e);
  e.xclient.type = ClientMessage;
  e.xclient.window = w;
  e.xclient.message_type = atom("_NET_MOVERESIZE_WINDOW");
  e.xclient.format = 32;
  e.xclient.data.l[0] = StaticGravity | (1 << 8) | (1 << 9) | (2 << 12); // x and y, from a pager / tool
  e.xclient.data.l[1] = x;
  e.xclient.data.l[2] = y;
  XSendEvent(dpy_in, root_in, False, SubstructureRedirectMask | SubstructureNotifyMask, &e);
  XFlush(dpy_in);
}

int wins_grabbing(void) { return mvGrab != 0; }

// A core event on dpy_in (main.c). True: it was the move grab's.
int wins_move_xevent(XEvent *e) {
  if (!mvKey) return 0;
  if (e->type == ButtonPress && e->xbutton.button == Button1 && e->xbutton.root == root_in) {
    Window c = e->xbutton.subwindow ? client_of(e->xbutton.subwindow, 0) : 0;
    int wx, wy, ww, hh, v, o;
    if (!capture_active() && c && mv_key_held() && geometry(c, &wx, &wy, &ww, &hh, &v, &o)) {
      static const char *desk[] = { "_NET_WM_WINDOW_TYPE_DESKTOP", "_NET_WM_WINDOW_TYPE_DOCK", NULL };
      if (!has_type(c, desk)) {
        mvGrab = c;
        mvDx = e->xbutton.x_root - wx;
        mvDy = e->xbutton.y_root - wy;
        mvUp = 1;
        client_message(c, "_NET_ACTIVE_WINDOW", 2, CurrentTime);
        XAllowEvents(dpy_in, AsyncPointer, e->xbutton.time); // ours: the app never sees the click
        XFlush(dpy_in);
        return 1;
      }
    }
    XAllowEvents(dpy_in, ReplayPointer, e->xbutton.time); // not a move: the click goes to the app
    XFlush(dpy_in);
    return 1;
  }
  if (e->type == MotionNotify && mvGrab) {
    mv_to(mvGrab, e->xmotion.x_root - mvDx, e->xmotion.y_root - mvDy);
    return 1;
  }
  if (e->type == ButtonRelease && e->xbutton.button == Button1 && (mvGrab || mvUp)) {
    mvGrab = 0;
    mvUp = 0;
    return 1;
  }
  return 0;
}

// The left button's raw release (capture.c): true while the grab holds it, so it isn't passed on.
int wins_move_eat_up(void) {
  if (!mvUp) return 0;
  mvUp = 0;
  mvGrab = 0;
  return 1;
}

// Crossing with a grabbed window: its id (capture.c adds `moving`), and the grab ends. keepUp: the
// button is still down here (the home side), its release comes later and is not passed on.
unsigned long wins_move_take(int keepUp) {
  Window w = mvGrab;
  mvGrab = 0;
  if (!keepUp) mvUp = 0;
  return (unsigned long)w;
}

// `winPark`: as far past the screens as the window manager lets it (still mapped: a minimized
// window has no picture to send).
void wins_park(unsigned long wid) {
  int w = DisplayWidth(dpy_in, DefaultScreen(dpy_in));
  mv_to((Window)wid, w + 200, 40);
}

// `winPlace {x, y}`: back with its visible part's top left at x, y (as `windows` lists them), raised.
void wins_place(unsigned long wid, int x, int y) {
  int l, r, t, b;
  extents((Window)wid, &l, &r, &t, &b);
  mv_to((Window)wid, x - l, y - t);
  wins_raise(wid);
}

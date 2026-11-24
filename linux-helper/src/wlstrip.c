// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Drag files across the edge on Wayland (drop.c is X11's): a Wayland desktop lets no client see the
// pointer, take a drag or place a window where it wants, but XWayland still can, and the compositor
// hands a Wayland app's drag (Dolphin's) to an XWayland window that it manages: an override-redirect
// one never got it (KWin, tried). So the strip is a dock window of ours on XWayland, fully transparent,
// along the edge, an XDND drop target: a file drag that enters it is read at once (XDND lets a target
// ask for the data before the drop), and then it crosses.
//   wl.c says when and where to show it (the left button held near an edge whose device takes drags,
//   or the way back while driven), and crosses with what it catches: wl_strip_caught().
//   With Full KVM the helper that does that is the service's (root, no X display of ours): it says it
//   as `dragStrip` events, main (shared/fullkvm/route.js) has this one, the user's own helper, show it
//   (the `dragStrip` command: relay), and what it catches goes back as a `dragCross` event, which
//   main sends the service.
// The pointer and the button over it stay the compositor's: wl.c lets the button go there through
// its own virtual mouse once it crosses (the drop lands here, on the strip, which does nothing), and
// the real button, grabbed, goes to the other computer and drops the files there.
#include "helper.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>

static Display *dpy;
static int tried, relay;
static Window win, source;
static int shown, sx, sy, sw, sh, stripSide = SIDE_NONE, stripBack;
static int hasUris, requested, taken;
static double takenAt;
static Atom A_AWARE, A_ENTER, A_POSITION, A_STATUS, A_LEAVE, A_DROP, A_FINISHED, A_SELECTION, A_TYPELIST, A_COPY, A_URIS, A_PROP;

static Atom atom(const char *n) { return XInternAtom(dpy, n, False); }

static int open_x(void) {
  if (dpy) return 1;
  if (tried) return 0;
  tried = 1;
  if (!getenv("DISPLAY")) return 0; // the service's helper (root): main shows ours instead
  dpy = XOpenDisplay(NULL);
  if (!dpy) { fprintf(stderr, "[drag] no X display for the drag strip (XWayland)\n"); return 0; }
  A_AWARE = atom("XdndAware"); A_ENTER = atom("XdndEnter"); A_POSITION = atom("XdndPosition"); A_STATUS = atom("XdndStatus");
  A_LEAVE = atom("XdndLeave"); A_DROP = atom("XdndDrop"); A_FINISHED = atom("XdndFinished"); A_SELECTION = atom("XdndSelection");
  A_TYPELIST = atom("XdndTypeList"); A_COPY = atom("XdndActionCopy"); A_URIS = atom("text/uri-list"); A_PROP = atom("TWINDESK_DROP");
  return 1;
}

int wlstrip_fd(void) { return dpy ? ConnectionNumber(dpy) : -1; }
int wlstrip_available(void) { return open_x(); }

static void make(void) {
  if (win) return;
  Window root = DefaultRootWindow(dpy);
  XVisualInfo vi;
  XSetWindowAttributes a;
  memset(&a, 0, sizeof a);
  unsigned long mask = CWBorderPixel | CWBackPixel;
  Visual *visual = CopyFromParent;
  int depth = CopyFromParent;
  if (XMatchVisualInfo(dpy, DefaultScreen(dpy), 32, TrueColor, &vi)) { // transparent: nothing to see
    visual = vi.visual;
    depth = 32;
    a.colormap = XCreateColormap(dpy, root, vi.visual, AllocNone);
    mask |= CWColormap;
  }
  a.background_pixel = 0;
  a.border_pixel = 0;
  win = XCreateWindow(dpy, root, 0, 0, 1, 1, 0, depth, InputOutput, visual, mask, &a);
  long version = 5;
  XChangeProperty(dpy, win, A_AWARE, XA_ATOM, 32, PropModeReplace, (unsigned char *)&version, 1);
  // Managed, as a dock: no frame, where we put it, above the windows (and the compositor gives it drags).
  Atom dock = atom("_NET_WM_WINDOW_TYPE_DOCK");
  XChangeProperty(dpy, win, atom("_NET_WM_WINDOW_TYPE"), XA_ATOM, 32, PropModeReplace, (unsigned char *)&dock, 1);
  Atom st[3] = { atom("_NET_WM_STATE_ABOVE"), atom("_NET_WM_STATE_SKIP_TASKBAR"), atom("_NET_WM_STATE_SKIP_PAGER") };
  XChangeProperty(dpy, win, atom("_NET_WM_STATE"), XA_ATOM, 32, PropModeReplace, (unsigned char *)st, 3);
  XStoreName(dpy, win, "TwinDesk drop edge");
}

static void place(int x, int y, int w, int h) {
  XSizeHints *hints = XAllocSizeHints();
  hints->flags = PPosition | PSize | USPosition | USSize;
  hints->x = x; hints->y = y; hints->width = w; hints->height = h;
  XSetWMNormalHints(dpy, win, hints);
  XFree(hints);
  XMoveResizeWindow(dpy, win, x, y, (unsigned)w, (unsigned)h);
}

static void reset(void) {
  source = 0;
  hasUris = requested = taken = 0;
}

// x… : the strip's rectangle (logical px, XWayland's root, unscaled); side: the edge it covers;
// back: as the way back (driven). fromMain: the `dragStrip` command (relay: what it catches goes to main).
void wlstrip_show(int x, int y, int w, int h, int side, int back, int fromMain) {
  if (!open_x()) return;
  relay = fromMain;
  make();
  if (taken) return; // the drag it caught is over it still
  if (!shown || x != sx || y != sy || w != sw || h != sh) {
    sx = x; sy = y; sw = w; sh = h;
    place(x, y, w, h);
  }
  if (!shown) {
    XMapRaised(dpy, win);
    shown = 1;
    fprintf(stderr, "[drag] strip on the %s edge (%s), %d,%d %dx%d (XWayland%s)\n", side_name(side), back ? "the way back" : "out", x, y, w, h, relay ? ", for the Full KVM service" : "");
  }
  stripSide = side;
  stripBack = back;
  XFlush(dpy);
}

void wlstrip_hide(void) {
  if (!dpy || !shown || source) return; // a drag still over it keeps it until it leaves or drops
  XUnmapWindow(dpy, win);
  XFlush(dpy);
  shown = 0;
}

static void reply(Window to, Atom type, long l1, long l4) {
  XEvent e;
  memset(&e, 0, sizeof e);
  e.xclient.type = ClientMessage;
  e.xclient.display = dpy;
  e.xclient.window = to;
  e.xclient.message_type = type;
  e.xclient.format = 32;
  e.xclient.data.l[0] = (long)win;
  e.xclient.data.l[1] = l1;
  if (type == A_FINISHED) e.xclient.data.l[2] = l4;
  else e.xclient.data.l[4] = l4;
  XSendEvent(dpy, to, False, NoEventMask, &e);
  XFlush(dpy);
}

// file:///a%20b → /a b; other schemes are skipped. Paths one per line into text.
static void uris_to_lines(const char *s, size_t n, char *text, size_t cap, int *count) {
  size_t len = 0;
  const char *end = s + n;
  *count = 0;
  text[0] = 0;
  while (s < end) {
    const char *nl = memchr(s, '\n', (size_t)(end - s));
    const char *e = nl ? nl : end;
    size_t l = (size_t)(e - s);
    while (l && (s[l - 1] == '\r' || s[l - 1] == 0)) l--;
    if (l > 7 && s[0] != '#' && !strncmp(s, "file://", 7)) {
      const char *p = memchr(s + 7, '/', l - 7); // after the (usually empty) host
      if (p && len + (size_t)(s + l - p) + 2 < cap) {
        if (*count) text[len++] = '\n';
        for (; p < s + l; p++) {
          int c = (unsigned char)*p;
          if (c == '%' && s + l - p > 2) {
            char hex[3] = { p[1], p[2], 0 };
            c = (int)strtol(hex, NULL, 16);
            p += 2;
          }
          if (c >= 0x20) text[len++] = (char)c;
        }
        (*count)++;
      }
    }
    s = nl ? nl + 1 : end;
  }
  text[len] = 0;
}

static void got_uris(void) {
  Atom type;
  int fmt;
  unsigned long n = 0, after;
  unsigned char *data = NULL;
  if (XGetWindowProperty(dpy, win, A_PROP, 0, 1 << 20, True, AnyPropertyType, &type, &fmt, &n, &after, &data) != Success || !data) return;
  if (fmt != 8 || type == atom("INCR")) { XFree(data); return; } // a list too big for one property: not taken
  size_t cap = n + 16;
  char *text = malloc(cap);
  int count = 0;
  uris_to_lines((const char *)data, n, text, cap, &count);
  XFree(data);
  if (count && !taken) {
    taken = 1;
    takenAt = now_ms();
    fprintf(stderr, "[drag] strip: %d item(s) caught%s\n", count, relay ? ", handed to the Full KVM service" : "");
    if (relay) {
      // main sends it to the service (route.js), whose helper crosses with it (wl_drag_cross).
      size_t lc = strlen(text) * 2 + 128;
      char *line = malloc(lc);
      JOut o;
      jo_begin(&o);
      jo_str(&o, "event", "dragCross");
      jo_str(&o, "side", side_name(stripSide));
      jo_bool(&o, "back", stripBack);
      const char *head = jo_end(&o); // {"event":…,"back":…}
      size_t hl = strlen(head);
      memcpy(line, head, hl - 1); // without the closing brace
      size_t len = hl - 1;
      len += (size_t)snprintf(line + len, lc - len, ",\"pathsText\":\"");
      for (const char *p = text; *p && len + 4 < lc; p++) {
        if (*p == '\n') { line[len++] = '\\'; line[len++] = 'n'; }
        else if (*p == '"' || *p == '\\') { line[len++] = '\\'; line[len++] = *p; }
        else line[len++] = *p;
      }
      snprintf(line + len, lc - len, "\"}");
      emit(line);
      free(line);
    } else {
      wl_strip_caught(text, stripSide, stripBack);
    }
  }
  free(text);
}

void wlstrip_read(void) {
  if (!dpy) return;
  while (XPending(dpy)) {
    XEvent e;
    XNextEvent(dpy, &e);
    if (!win) continue;
    if (e.type == SelectionNotify && e.xselection.requestor == win) {
      if (e.xselection.property != None) got_uris();
      continue;
    }
    if (e.type != ClientMessage || e.xclient.window != win) continue;
    Atom t = e.xclient.message_type;
    long *l = e.xclient.data.l;
    if (t == A_ENTER) {
      reset();
      source = (Window)l[0];
      if (l[1] & 1) { // more than three types: the list is on the source
        Atom type, *list = NULL;
        int fmt;
        unsigned long n = 0, after;
        if (XGetWindowProperty(dpy, source, A_TYPELIST, 0, 256, False, XA_ATOM, &type, &fmt, &n, &after, (unsigned char **)&list) == Success && list) {
          for (unsigned long i = 0; i < n; i++) if (list[i] == A_URIS) hasUris = 1;
          XFree(list);
        }
      } else {
        for (int i = 2; i < 5; i++) if ((Atom)l[i] == A_URIS) hasUris = 1;
      }
      if (!hasUris) fprintf(stderr, "[drag] strip: a drag came that isn't files\n");
    } else if (t == A_POSITION) {
      if ((Window)l[0] != source) continue;
      if (hasUris && !requested && !taken) {
        XConvertSelection(dpy, A_SELECTION, A_URIS, A_PROP, win, (Time)l[3]);
        requested = 1;
      }
      reply(source, A_STATUS, hasUris ? 1 : 0, hasUris ? (long)A_COPY : 0); // never Move: the source would delete the files
    } else if (t == A_LEAVE) {
      if (!taken) { reset(); wlstrip_hide(); }
    } else if (t == A_DROP) {
      Window src = (Window)l[0];
      int was = taken;
      reply(src, A_FINISHED, was ? 1 : 0, was ? (long)A_COPY : 0);
      reset();
      wlstrip_hide();
    }
  }
}

// Each tick: a drag that was caught and never dropped here (or not taken) lets the strip go after a while.
void wlstrip_tick(void) {
  if (!dpy || !taken) return;
  if (now_ms() - takenAt > 60000) { reset(); wlstrip_hide(); }
}

void wlstrip_shutdown(void) {
  if (dpy && win) { XDestroyWindow(dpy, win); win = 0; shown = 0; XFlush(dpy); }
}

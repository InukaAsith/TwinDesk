// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// macshare-linuxhelper: JSON lines on stdin (commands) / stdout (replies and events),
// "Helper interface", the same commands and events as windows-helper. One thread: poll() on
// stdin and the capture connection; X queues input for us, so nothing here can block the
// desktop's input (rule 3) and no event callback has a deadline like a Windows hook. Logs go to
// stderr; stdout is JSON only. Exits (after releaseAll and ungrab) when stdin closes.
// Two backends: X11 (XInput2 + XTest, capture.c / inject.c) and, in a Wayland session or with
// MACSHARE_HELPER_BACKEND=uinput, evdev + uinput (wl.c). `ready` says which.
#include "helper.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <X11/extensions/XTest.h>

Display *dpy_ev, *dpy_in;
Window root_ev, root_in;
static int wl; // the Wayland backend

static pthread_mutex_t out_mu = PTHREAD_MUTEX_INITIALIZER; // ble.c writes from its threads too

void emit(const char *line) {
  pthread_mutex_lock(&out_mu);
  fputs(line, stdout);
  fputc('\n', stdout);
  fflush(stdout);
  pthread_mutex_unlock(&out_mu);
}

static void reply(const JObj *c, const char *error, const char *extra) {
  if (!jhas(c, "id")) return;
  JOut o;
  jo_begin(&o);
  jo_num(&o, "id", jnum(c, "id", 0));
  jo_bool(&o, "ok", error == NULL);
  if (error) jo_str(&o, "error", error);
  // extra: already-built `"k":v,...` fields
  if (extra && !error) {
    o.len += (size_t)snprintf(o.buf + o.len, sizeof o.buf - o.len, ",%s", extra);
  }
  emit(jo_end(&o));
}

static void dispatch(const char *line) {
  capture_touch(); // any command resets the dead-man timer
  if (ble_handle(line)) return; // Bluetooth: ble.c's thread, both backends
  JObj *c = json_parse(line);
  if (!c) return;
  const char *cmd = jstr(c, "cmd", "");
  const char *error = NULL;
  char extra[200] = "";
  if (!strcmp(cmd, "clipFiles")) { // both backends: an X client of its own (xclip.c)
    xclip_files(jnum(c, "id", 0));
    json_free(c);
    return;
  }
  if (wl) {
    wl_touch();
    if (!strcmp(cmd, "ping") || !strcmp(cmd, "keepalive")) {
    } else if (!strcmp(cmd, "kvmConfig")) {
      wl_config(c);
    } else if (!strcmp(cmd, "screens")) {
      screens_set(jstr(c, "list", ""));
    } else if (!strcmp(cmd, "capture")) {
      if (jbool(c, "on", 0)) wl_capture_begin(jbool(c, "mouse", 1), jbool(c, "keyboard", 1));
      else wl_capture_stop(side_of(jstr(c, "side", NULL)), jnum(c, "offset", 0), jhas(c, "offset"));
    } else if (!strcmp(cmd, "place")) {
      int x, y;
      if (jbool(c, "center", 0)) screens_center(&x, &y);
      else screens_edge_point(side_of(jstr(c, "side", "left")) < 0 ? SIDE_LEFT : side_of(jstr(c, "side", "left")), jnum(c, "offset", 0.5), &x, &y);
      wl_move_to(x, y);
    } else if (!strcmp(cmd, "armReturn")) {
      wl_arm_return(jbool(c, "on", 0), side_of(jstr(c, "side", NULL)), jnum(c, "resistancePx", 120));
    } else if (!strcmp(cmd, "inject")) {
      JObj *ev = jobj(c, "ev");
      if (ev) wl_inject(ev);
    } else if (!strcmp(cmd, "releaseAll")) {
      wl_release_all();
    } else if (!strcmp(cmd, "moveTo")) {
      wl_move_to((int)jnum(c, "x", 0), (int)jnum(c, "y", 0));
    } else if (!strcmp(cmd, "info")) {
      int x, y;
      wl_position(&x, &y);
      snprintf(extra, sizeof extra, "\"cursor\":[%d,%d],\"capturing\":%s,\"devices\":%d", x, y, wl_active() ? "true" : "false", wl_devices());
    } else {
      error = "unknown command";
    }
    reply(c, error, extra[0] ? extra : NULL);
    json_free(c);
    return;
  }

  if (!strcmp(cmd, "ping") || !strcmp(cmd, "keepalive")) {
  } else if (!strcmp(cmd, "kvmConfig")) {
    capture_config(c);
  } else if (!strcmp(cmd, "screens")) {
    // X11: XRandR knows better
  } else if (!strcmp(cmd, "windows")) {
    wins_list(jnum(c, "id", 0)); // its own (long) reply
    json_free(c);
    return;
  } else if (!strcmp(cmd, "activeWindow") || !strcmp(cmd, "windowAt")) {
    wins_info(jnum(c, "id", 0), !strcmp(cmd, "windowAt")); // its own reply
    json_free(c);
    return;
  } else if (!strcmp(cmd, "winRaise")) {
    wins_raise((unsigned long)jnum(c, "wid", 0));
  } else if (!strcmp(cmd, "winClose")) {
    wins_close((unsigned long)jnum(c, "wid", 0));
  } else if (!strcmp(cmd, "winSize")) {
    wins_size((unsigned long)jnum(c, "wid", 0), (int)jnum(c, "w", 0), (int)jnum(c, "h", 0));
  } else if (!strcmp(cmd, "winMove")) {
    wins_move((unsigned long)jnum(c, "wid", 0), jnum(c, "x", 0), jnum(c, "y", 0));
  } else if (!strcmp(cmd, "capture")) {
    if (jbool(c, "on", 0)) {
      if (!capture_begin(jbool(c, "mouse", 1), jbool(c, "keyboard", 1))) {
        error = "grab failed";
        JOut o;
        jo_begin(&o);
        jo_str(&o, "event", "captureEnded");
        jo_str(&o, "reason", "grab");
        emit(jo_end(&o));
      }
    } else {
      capture_stop(side_of(jstr(c, "side", NULL)), jnum(c, "offset", 0), jhas(c, "offset"));
    }
  } else if (!strcmp(cmd, "place")) {
    int x, y;
    if (jbool(c, "center", 0)) screens_center(&x, &y);
    else screens_edge_point(side_of(jstr(c, "side", "left")) < 0 ? SIDE_LEFT : side_of(jstr(c, "side", "left")), jnum(c, "offset", 0.5), &x, &y);
    inject_move_to(x, y);
  } else if (!strcmp(cmd, "armReturn")) {
    capture_arm_return(jbool(c, "on", 0), side_of(jstr(c, "side", NULL)), jnum(c, "resistancePx", 120));
  } else if (!strcmp(cmd, "inject")) {
    JObj *ev = jobj(c, "ev");
    if (ev) inject_apply(ev);
  } else if (!strcmp(cmd, "releaseAll")) {
    inject_release_all();
  } else if (!strcmp(cmd, "moveTo")) {
    inject_move_to((int)jnum(c, "x", 0), (int)jnum(c, "y", 0));
  } else if (!strcmp(cmd, "info")) {
    Window rr, cr;
    int x = 0, y = 0, wx, wy;
    unsigned m;
    XQueryPointer(dpy_in, root_in, &rr, &cr, &x, &y, &wx, &wy, &m);
    snprintf(extra, sizeof extra, "\"cursor\":[%d,%d],\"capturing\":%s", x, y, capture_active() ? "true" : "false");
  } else {
    error = "unknown command";
  }
  reply(c, error, extra[0] ? extra : NULL);
  json_free(c);
}

static void quit(int code) {
  ble_shutdown();
  if (wl) {
    wl_shutdown();
    exit(code);
  }
  capture_shutdown();
  inject_release_all();
  XSync(dpy_ev, False);
  XSync(dpy_in, False);
  exit(code);
}

static int xerror(Display *d, XErrorEvent *e) {
  char text[120];
  XGetErrorText(d, e->error_code, text, sizeof text);
  fprintf(stderr, "X error: %s (request %d)\n", text, e->request_code);
  return 0;
}

static int xio(Display *d) {
  (void)d;
  fprintf(stderr, "X connection lost\n");
  _exit(2); // the server is gone: nothing left to give back
}

static char inbuf[1 << 20]; // bleSend: up to 64 KB as base64
static size_t inlen;

static void read_stdin(void) {
  for (;;) {
    ssize_t n = read(0, inbuf + inlen, sizeof inbuf - 1 - inlen);
    if (n == 0) quit(0); // stdin closed: main is gone; give the user their input back
    if (n < 0) {
      if (errno == EAGAIN || errno == EINTR) break;
      quit(0);
    }
    inlen += (size_t)n;
    inbuf[inlen] = 0;
    char *start = inbuf, *nl;
    while ((nl = strchr(start, '\n'))) {
      *nl = 0;
      if (nl > start) dispatch(start);
      start = nl + 1;
    }
    inlen = strlen(start);
    memmove(inbuf, start, inlen + 1);
    if (inlen >= sizeof inbuf - 1) inlen = 0; // a line too long for us: drop it
  }
}

static void on_signal(int sig) {
  (void)sig;
  quit(0);
}

static int run_wayland(void) {
  wl = 1;
  screens_refresh(); // a default until main sends `screens`
  if (!wl_init()) return 1;
  fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK);
  signal(SIGTERM, on_signal);
  signal(SIGINT, on_signal);
  emit("{\"event\":\"ready\",\"backend\":\"uinput\"}");
  for (;;) {
    struct pollfd p[40];
    p[0] = (struct pollfd){ 0, POLLIN, 0 };
    int n = 1 + wl_fds(p + 1, 39);
    poll(p, (nfds_t)n, 20);
    if (p[0].revents & (POLLIN | POLLHUP | POLLERR)) read_stdin();
    wl_read(p + 1, n - 1);
    wl_tick();
  }
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  const char *b = getenv("MACSHARE_HELPER_BACKEND");
  const char *st = getenv("XDG_SESSION_TYPE");
  if ((b && !strcmp(b, "uinput")) || (!(b && !strcmp(b, "x11")) && st && !strcmp(st, "wayland"))) return run_wayland();
  XInitThreads();
  XSetErrorHandler(xerror);
  XSetIOErrorHandler(xio);
  dpy_ev = XOpenDisplay(NULL);
  dpy_in = XOpenDisplay(NULL);
  if (!dpy_ev || !dpy_in) {
    fprintf(stderr, "cannot open the X display (DISPLAY=%s)\n", getenv("DISPLAY") ? getenv("DISPLAY") : "");
    return 1;
  }
  root_ev = DefaultRootWindow(dpy_ev);
  root_in = DefaultRootWindow(dpy_in);
  int ev, err, maj, min;
  if (!XTestQueryExtension(dpy_in, &ev, &err, &maj, &min)) { fprintf(stderr, "no XTest extension\n"); return 1; }
  XTestGrabControl(dpy_in, True); // injection keeps working while another client grabs the server
  screens_refresh();
  if (!capture_init()) { fprintf(stderr, "no XInput 2.2\n"); return 1; }

  fcntl(0, F_SETFL, fcntl(0, F_GETFL) | O_NONBLOCK);
  emit("{\"event\":\"ready\",\"backend\":\"x11\"}");

  int xfd = ConnectionNumber(dpy_ev);
  for (;;) {
    while (XPending(dpy_ev)) {
      XEvent e;
      XNextEvent(dpy_ev, &e);
      capture_xevent(&e);
    }
    while (XPending(dpy_in)) { // core events delivered to the grab (capture.c): not used; drop.c's XDND
      XEvent e;
      XNextEvent(dpy_in, &e);
      drop_xevent(&e);
    }
    struct pollfd p[3] = { { 0, POLLIN, 0 }, { xfd, POLLIN, 0 }, { ConnectionNumber(dpy_in), POLLIN, 0 } };
    poll(p, 3, 20);
    if (p[0].revents & (POLLIN | POLLHUP | POLLERR)) read_stdin();
    capture_tick();
  }
}

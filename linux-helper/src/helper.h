// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// macshare-linuxhelper: shared declarations. JSON lines on stdin/stdout, the same commands and
// events as windows-helper.
#ifndef MACSHARE_HELPER_H
#define MACSHARE_HELPER_H

#include <stddef.h>
#include <X11/Xlib.h>

// Two X connections: one for capture (raw events, grabs), one for injection and
// queries, so injection never waits behind event reading.
extern Display *dpy_ev, *dpy_in;
extern Window root_ev, root_in;

// ---- json.c: our flat messages (one nested object: "ev") ----
enum { J_NULL, J_BOOL, J_NUM, J_STR, J_OBJ, J_OTHER };
typedef struct JObj JObj;
typedef struct { int type; double num; char *str; JObj *obj; } JVal;
#define J_MAX 32
struct JObj { int n; char *keys[J_MAX]; JVal vals[J_MAX]; };

JObj *json_parse(const char *s);
void json_free(JObj *o);
int jhas(const JObj *o, const char *k);
const char *jstr(const JObj *o, const char *k, const char *def);
double jnum(const JObj *o, const char *k, double def);
int jbool(const JObj *o, const char *k, int def);
JObj *jobj(const JObj *o, const char *k);

typedef struct { char buf[4096]; size_t len; int first; } JOut; // keyLayout's two maps of Sinhala (3 UTF-8 bytes each) need ~2 KB
void jo_begin(JOut *o);
void jo_str(JOut *o, const char *k, const char *v);
void jo_num(JOut *o, const char *k, double v);
void jo_bool(JOut *o, const char *k, int v);
void jo_raw(JOut *o, const char *k, const char *json); // an already-built value
const char *jo_end(JOut *o);

void emit(const char *line); // one line to stdout (the only writer)

// ---- keys.c: DOM code <-> evdev (X keycode = evdev + 8) ----
int key_evdev(const char *code);   // -1 if unknown
const char *key_code(int evdev);   // NULL if unknown
void keys_layout(double id, Display *dpy); // keyLayout's reply: what each key types alone (NULL dpy: nothing)
void keys_type(Display *dpy, const char *text); // text as it is, on spare key codes (NULL dpy: nothing)

// ---- screens.c: XRandR monitors (physical px) ----
enum { SIDE_NONE = -1, SIDE_LEFT, SIDE_RIGHT, SIDE_TOP, SIDE_BOTTOM };
int side_of(const char *s);
const char *side_name(int side);
void screens_refresh(void);
int screens_contains(int x, int y);
int screens_on_outer_edge(int x, int y, int side);
double screens_outward(int side, double dx, double dy);
double screens_offset(int x, int y, int side);
void screens_edge_point(int side, double offset, int *x, int *y);
void screens_center(int *x, int *y);
void screens_clamp(int x, int y, int fromX, int fromY, int *ox, int *oy);
int zones_parse(const char *text, double z[][2], int max);
int zones_contain(double z[][2], int n, int x, int y, int side);
void screens_walk(int x, int y, int fromX, int fromY, const int *stops, int nstops, int *ox, int *oy);
void screens_box(int *x, int *y, int *w, int *h);
void screens_set(const char *list);
int screens_monitor(int x, int y, int *mx, int *my, int *mw, int *mh);

// ---- capture.c: XInput2 raw events, edge, hotkey, grabs, dead-man ----
int capture_init(void);
void capture_config(const JObj *c);
int capture_begin(int mouse, int keys);
void capture_stop(int side, double offset, int hasSide);
void capture_touch(void);
void capture_tick(void);
void capture_arm_return(int on, int side, double resistance);
#ifdef MULTI
void capture_arm_return_list(int on, const char *list, int fallback, double resistance); // several edges
#endif
void capture_feed_return(int x, int y, double dx, double dy);
void capture_arrived(int side);
void capture_return_zones(const char *text);
int capture_return_stops(int *out); // out: room for 4
void capture_xevent(XEvent *e);
int capture_active(void);
void capture_shutdown(void);

// ---- shortcut.c: the copy/paste-files shortcuts at home and the cursor lock key (both backends) ----
void shortcut_config(const JObj *c);
void shortcut_key(int ev, int down, int detect, int detectLock);
void shortcut_tick(void);

// ---- drop.c: file drags across the edge, out (X11): the edge strip, an XDND drop target ----
void drop_config(const JObj *c);
void drop_tick(int capturing, int side, int driveOther, int leftDown, int backSide);
void drop_xevent(XEvent *e);
void drop_shutdown(void);
int drop_holding(void); // a file drag is being caught on the way back: no plain return meanwhile
// capture.c, called by drop.c: the drag crossed (paths: a built JSON array) / the source let go /
// a drag caught on the way back while driven
void capture_drag_cross(const char *paths, int x, int y, int sx, int sy, int sw, int sh);
void capture_drag_dropped(void);
void capture_drag_return(const char *paths, int x, int y, int side);
void capture_watch_release(int on); // `released` at our next left button-up at home
void inject_button_up(int b);       // inject.c: an injected button's release (0 left)

// ---- xclip.c: the files on the clipboard, as an X client (XWayland on Wayland) ----
void xclip_files(double id);

// ---- inject.c: XTest ----
void inject_apply(const JObj *ev);
void inject_move(double dx, double dy); // the input lane's moves (lane.c)
void inject_move_to(int x, int y);
void inject_release_all(void);
void inject_button(int b, int down);

// ---- wins.c: top-level windows for Apps (X11) ----
void wins_list(double id);
void wins_raise(unsigned long wid);
void wins_close(unsigned long wid);
void wins_size(unsigned long wid, int w, int h);
void wins_move(unsigned long wid, double x, double y);
void wins_info(double id, int atPointer);
void wins_move_key(const char *key);     // Move windows: the key held to grab a window, "" = off
int wins_move_xevent(XEvent *e);         // the grab's core events (main.c's dpy_in loop)
int wins_grabbing(void);                 // a window follows the pointer
int wins_move_eat_up(void);              // the grab's left-button release: not passed on
unsigned long wins_move_take(int keepUp); // crossing: the grabbed window (0: none); the grab ends
void wins_park(unsigned long wid);
void wins_place(unsigned long wid, int x, int y);

// ---- wl.c: Wayland backend (evdev + uinput) ----
struct pollfd;
int wl_init(void);
int wl_fds(struct pollfd *p, int max);
void wl_read(struct pollfd *p, int n);
void wl_tick(void);
void wl_config(const JObj *c);
int wl_capture_begin(int mouse, int keys);
void wl_capture_stop(int side, double offset, int hasSide);
void wl_arrived(int side);
void wl_return_zones(const char *text);
void wl_arm_return(int on, int side, double resistance);
void wl_inject(const JObj *ev);
void wl_move_rel(double dx, double dy);
void wl_move_to(int x, int y);
void wl_button(int b, int down);
void wl_pen_moved(int x, int y); // the pen put the pointer there (pen.c)
void wl_release_all(void);
void wl_watch_release(int on); // `released` at our next left button-up at home
void wl_touch(void);
int wl_active(void);
void wl_position(int *x, int *y);
void wl_shutdown(void);
int wl_devices(void);

// ---- pen.c: a phone's stylus as a uinput tablet pen (both backends; wl: on Wayland) ----
void pen_at(int wl, int x, int y, const JObj *pen);
void pen_leave(int wl);
// ---- touch.c: a viewer's fingers as a uinput touch screen (both backends) ----
void touch_set(int wl, const char *p);
void touch_leave(int wl);

// ---- ble.c: Bluetooth LE through BlueZ (Ble.cs's commands and events), its own thread ----
int ble_handle(const char *line); // 1: a ble*/blp* command, taken
void ble_shutdown(void);

double now_ms(void);
void shake_feed(double dx, double dy); // shake.c: a shake while capturing emits {"event":"shake"}

// ---- localwatch.c: driven, this computer's own mouse or touchpad takes it back (`local`) ----
void local_allow(int on); // kvmConfig takeBack
void local_watch(int on);
int local_note(double dx, double dy, int click); // 1: it took it back (the return watch stops)

// ---- lane.c: the input lane in the helper (native/tdfast; only with -DTDFAST) ----
#ifdef TDFAST
int lane_fd(void); // the main loop polls it: moves from the lane's thread
void lane_drain(void (*inject)(double dx, double dy));
void lane_handle(const JObj *c, const char **error, char *extra, size_t n, void (*inject)(double dx, double dy));
int lane_move(double dx, double dy, JOut *k);
const char *lane_fence(const char *k, char *buf, size_t n);
#endif

#endif

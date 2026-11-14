// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Monitors from XRandR (physical pixels), outer edges, offsets along a side (
// "Words"), landing points and clamping. Port of windows-helper/src/Screens.cs.
#include "helper.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <X11/extensions/Xrandr.h>

typedef struct { int x, y, w, h; } Rect;

#define MAX_MON 16
static Rect mons[MAX_MON];
static int nmon, primary;

static const char *SIDES[] = { "left", "right", "top", "bottom" };

int side_of(const char *s) {
  if (!s) return SIDE_NONE;
  for (int i = 0; i < 4; i++) if (!strcmp(s, SIDES[i])) return i;
  return SIDE_NONE;
}

const char *side_name(int side) { return side >= 0 && side < 4 ? SIDES[side] : NULL; }

// Wayland backend (wl.c): the monitors as main sees them, "x,y,w,h,primary;…" in the
// compositor's logical pixels (no X server to ask).
void screens_set(const char *list) {
  int n = 0, p = 0;
  Rect r[MAX_MON];
  for (const char *s = list; s && *s && n < MAX_MON;) {
    int x, y, w, h, pr, used = 0;
    if (sscanf(s, "%d,%d,%d,%d,%d%n", &x, &y, &w, &h, &pr, &used) != 5 || used <= 0) break;
    if (w > 0 && h > 0) { r[n] = (Rect){ x, y, w, h }; if (pr) p = n; n++; }
    s += used;
    if (*s == ';') s++;
  }
  if (!n) return;
  memcpy(mons, r, sizeof(Rect) * (size_t)n);
  nmon = n;
  primary = p;
}

void screens_refresh(void) {
  int n = 0;
  nmon = 0;
  primary = 0;
  if (!dpy_in) { // Wayland backend before main's first `screens`
    mons[0] = (Rect){ 0, 0, 1920, 1080 };
    nmon = 1;
    return;
  }
  XRRMonitorInfo *m = XRRGetMonitors(dpy_in, root_in, True, &n);
  if (m) {
    for (int i = 0; i < n && nmon < MAX_MON; i++) {
      if (m[i].width <= 0 || m[i].height <= 0) continue;
      mons[nmon] = (Rect){ m[i].x, m[i].y, m[i].width, m[i].height };
      if (m[i].primary) primary = nmon;
      nmon++;
    }
    XRRFreeMonitors(m);
  }
  if (!nmon) {
    Screen *s = DefaultScreenOfDisplay(dpy_in);
    mons[0] = (Rect){ 0, 0, WidthOfScreen(s), HeightOfScreen(s) };
    nmon = 1;
  }
}

static int in_rect(const Rect *r, int x, int y) { return x >= r->x && x < r->x + r->w && y >= r->y && y < r->y + r->h; }

int screens_contains(int x, int y) {
  for (int i = 0; i < nmon; i++) if (in_rect(&mons[i], x, y)) return 1;
  return 0;
}

static const Rect *monitor_at(int x, int y) {
  for (int i = 0; i < nmon; i++) if (in_rect(&mons[i], x, y)) return &mons[i];
  return NULL;
}

void screens_box(int *x, int *y, int *w, int *h) {
  int l = mons[0].x, t = mons[0].y, r = l + mons[0].w, b = t + mons[0].h;
  for (int i = 1; i < nmon; i++) {
    if (mons[i].x < l) l = mons[i].x;
    if (mons[i].y < t) t = mons[i].y;
    if (mons[i].x + mons[i].w > r) r = mons[i].x + mons[i].w;
    if (mons[i].y + mons[i].h > b) b = mons[i].y + mons[i].h;
  }
  *x = l; *y = t; *w = r - l; *h = b - t;
}

// On the outer edge of `side` (within 1 px) with no other monitor continuing beyond it.
int screens_on_outer_edge(int x, int y, int side) {
  const Rect *m = monitor_at(x, y);
  if (!m) return 0;
  int right = m->x + m->w, bottom = m->y + m->h;
  switch (side) {
    case SIDE_LEFT: return x <= m->x + 1 && !screens_contains(m->x - 1, y);
    case SIDE_RIGHT: return x >= right - 2 && !screens_contains(right, y);
    case SIDE_TOP: return y <= m->y + 1 && !screens_contains(x, m->y - 1);
    case SIDE_BOTTOM: return y >= bottom - 2 && !screens_contains(x, bottom);
  }
  return 0;
}

// Outward component of a motion for `side` (positive = pushing through it).
double screens_outward(int side, double dx, double dy) {
  switch (side) {
    case SIDE_LEFT: return -dx;
    case SIDE_RIGHT: return dx;
    case SIDE_TOP: return -dy;
    case SIDE_BOTTOM: return dy;
  }
  return 0;
}

// 0–1 along the side, on the bounding box of all monitors.
double screens_offset(int x, int y, int side) {
  int bx, by, bw, bh;
  screens_box(&bx, &by, &bw, &bh);
  double v = side == SIDE_LEFT || side == SIDE_RIGHT
    ? (y - by) / (double)(bh > 2 ? bh - 1 : 1)
    : (x - bx) / (double)(bw > 2 ? bw - 1 : 1);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

static int outer(const Rect *r, int side) {
  switch (side) {
    case SIDE_LEFT: return -r->x;
    case SIDE_RIGHT: return r->x + r->w;
    case SIDE_TOP: return -r->y;
    default: return r->y + r->h;
  }
}

// A point 2 px inside the outer edge of `side` at `offset`.
void screens_edge_point(int side, double offset, int *x, int *y) {
  int bx, by, bw, bh;
  screens_box(&bx, &by, &bw, &bh);
  int vertical = side == SIDE_LEFT || side == SIDE_RIGHT;
  int along = vertical ? by + (int)lround(offset * (bh - 1)) : bx + (int)lround(offset * (bw - 1));
  const Rect *best = NULL;
  int bestDist = 1 << 30;
  for (int i = 0; i < nmon; i++) {
    const Rect *r = &mons[i];
    int lo = vertical ? r->y : r->x, hi = (vertical ? r->y + r->h : r->x + r->w) - 1;
    int dist = along < lo ? lo - along : along > hi ? along - hi : 0;
    // Prefer the monitor whose span contains the point, then the outermost one.
    if (dist < bestDist || (dist == bestDist && best && outer(r, side) > outer(best, side))) { best = r; bestDist = dist; }
  }
  if (!best) { *x = 0; *y = 0; return; }
  int lo = vertical ? best->y : best->x, hi = (vertical ? best->y + best->h : best->x + best->w) - 1;
  int a = along < lo ? lo : along > hi ? hi : along;
  switch (side) {
    case SIDE_LEFT: *x = best->x + 2; *y = a; break;
    case SIDE_RIGHT: *x = best->x + best->w - 3; *y = a; break;
    case SIDE_TOP: *x = a; *y = best->y + 2; break;
    default: *x = a; *y = best->y + best->h - 3; break;
  }
}

void screens_center(int *x, int *y) {
  const Rect *p = &mons[primary];
  *x = p->x + p->w / 2;
  *y = p->y + p->h / 2;
}

// Keep a target on the desktop: if it falls outside every monitor, clamp it to the monitor the
// pointer is on now (avoids the dead zones between monitors of different sizes).
void screens_clamp(int x, int y, int fromX, int fromY, int *ox, int *oy) {
  if (screens_contains(x, y)) { *ox = x; *oy = y; return; }
  const Rect *m = monitor_at(fromX, fromY);
  if (!m) m = &mons[primary];
  *ox = x < m->x ? m->x : x > m->x + m->w - 1 ? m->x + m->w - 1 : x;
  *oy = y < m->y ? m->y : y > m->y + m->h - 1 ? m->y + m->h - 1 : y;
}

// Where a relative move from (fromX, fromY) to (x, y) ends: like screens_clamp, but it follows the
// path monitor by monitor and stops on the edge of a `stops` side where it is an outer edge, so a
// large jump can't land on a monitor past the return edge (the rest counts toward the resistance).
void screens_walk(int x, int y, int fromX, int fromY, const int *stops, int nstops, int *ox, int *oy) {
  double px = fromX, py = fromY;
  for (int i = 0; nstops > 0 && i < 8; i++) {
    const Rect *d = monitor_at((int)px, (int)py);
    if (!d) break;
    if (monitor_at(x, y) == d) { *ox = x; *oy = y; return; }
    int r = d->x + d->w, b = d->y + d->h, s = SIDE_NONE;
    double vx = x - px, vy = y - py, t = 1, k;
    if (vx > 0 && x >= r && (k = (r - px) / vx) < t) { t = k; s = SIDE_RIGHT; }
    if (vx < 0 && x < d->x && (k = (d->x - px) / vx) < t) { t = k; s = SIDE_LEFT; }
    if (vy > 0 && y >= b && (k = (b - py) / vy) < t) { t = k; s = SIDE_BOTTOM; }
    if (vy < 0 && y < d->y && (k = (d->y - py) / vy) < t) { t = k; s = SIDE_TOP; }
    if (s == SIDE_NONE) break;
    int ex = (int)lround(px + vx * t), ey = (int)lround(py + vy * t);
    ex = ex < d->x ? d->x : ex > r - 1 ? r - 1 : ex;
    ey = ey < d->y ? d->y : ey > b - 1 ? b - 1 : ey;
    for (int j = 0; j < nstops; j++)
      if (stops[j] == s && screens_on_outer_edge(ex, ey, s)) { *ox = ex; *oy = ey; return; }
    // Step just over the edge, onto the next monitor (or off the desktop: clamp below).
    int nx = s == SIDE_RIGHT ? r : s == SIDE_LEFT ? d->x - 1 : ex;
    int ny = s == SIDE_BOTTOM ? b : s == SIDE_TOP ? d->y - 1 : ey;
    if (!screens_contains(nx, ny)) break;
    px = nx; py = ny;
  }
  screens_clamp(x, y, fromX, fromY, ox, oy);
}

// kvmConfig / armReturn `zones` (shared/kvm-geom.js zonesText, shared/layout-world.js): "0.1-0.5,0.7-1"
// (a little wider, for rounding) or "none" (0 zones: nothing crosses). An entry may name its side,
// "top:0.56-0.94" (the Multi-device monitor map, #225): it counts only there. Missing or unreadable:
// -1 (the whole side). z[i][2]: the entry's side, SIDE_NONE for every side.
int zones_parse(const char *text, double z[][3], int max) {
  if (!text) return -1;
  if (!strcmp(text, "none")) return 0;
  int n = 0;
  const char *p = text;
  while (*p && n < max) {
    int side = SIDE_NONE;
    const char *colon = strchr(p, ':'), *comma = strchr(p, ',');
    if (colon && (!comma || colon < comma)) {
      char name[16] = "";
      size_t len = (size_t)(colon - p);
      if (len >= sizeof name) break;
      memcpy(name, p, len);
      side = side_of(name);
      if (side == SIDE_NONE) break;
      p = colon + 1;
    }
    char *end;
    double a = strtod(p, &end);
    if (end == p || *end != '-') break;
    p = end + 1;
    double b = strtod(p, &end);
    if (end == p || a > b) break;
    z[n][0] = a - 0.002; z[n][1] = b + 0.002; z[n][2] = side; n++;
    p = *end == ',' ? end + 1 : end;
  }
  return n ? n : -1;
}

// Inside one of the zones along `side` (n < 0: anywhere). Entries of another side don't count.
int zones_contain(double z[][3], int n, int x, int y, int side) {
  if (n < 0) return 1;
  double o = screens_offset(x, y, side);
  for (int i = 0; i < n; i++) if (((int)z[i][2] == SIDE_NONE || (int)z[i][2] == side) && o >= z[i][0] && o <= z[i][1]) return 1;
  return 0;
}

// The monitor under a point (drop.c's edge strip); 0 when none.
int screens_monitor(int x, int y, int *mx, int *my, int *mw, int *mh) {
  const Rect *m = monitor_at(x, y);
  if (!m) return 0;
  *mx = m->x; *my = m->y; *mw = m->w; *mh = m->h;
  return 1;
}

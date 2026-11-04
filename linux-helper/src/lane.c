// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The input lane in the helper (native/tdfast, docs/protocol.md), as mac-helper's Lane.swift:
// Node out of the move path on both ends. Driving: the capture's moves go straight onto the lane
// (td_move) and nothing is written to stdout; clicks, keys and wheel carry their event number and
// fence for Node. Driven: the lane's moves are injected here (deduplicated, speed applied, after the
// event they wait for); its events go to Node as {"event":"laneEv"} and come back as `inject` in order.
// Command `lane {op: bind | start | stop | active | route | event | driven | hold | fence | done}`.
// Built only when build.sh found cargo (-DTDFAST); without it, `lane` is an unknown command and Node
// keeps its own lane (shared/inputlane.js), which speaks the same wire.
#include "helper.h"
#ifdef TDFAST
#include "tdfast.h"
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int driving, started;
// The lane's thread hands moves to the main loop (where all injection happens) through a pipe.
static int qpipe[2] = { -1, -1 };

// A move the pipe had no room for (#132): the lane already counted it (its totals moved on), so it
// is kept here, on the lane's thread, and goes with the next write. 16 bytes is under PIPE_BUF, so a
// write is all or nothing.
static double held_dx, held_dy;

static void hand_over(void) {
  if (qpipe[1] < 0 || (held_dx == 0 && held_dy == 0)) return;
  double m[2] = { held_dx, held_dy };
  if (write(qpipe[1], m, sizeof m) == (ssize_t)sizeof m) held_dx = held_dy = 0;
}

static void callback(void *ctx, int32_t kind, double dx, double dy, const uint8_t *json, size_t len) {
  (void)ctx;
  if (kind == TD_MOVE) {
    held_dx += dx;
    held_dy += dy;
    hand_over();
  } else if (kind == TD_EVENT) {
    hand_over(); // a click goes after the moves before it
    if (!json || len == 0 || len > 3000) return;
    char line[3100];
    snprintf(line, sizeof line, "{\"event\":\"laneEv\",\"msg\":%.*s}", (int)len, (const char *)json);
    emit(line); // emit() is thread-safe
  } else if (kind == TD_UP) {
    char line[80];
    snprintf(line, sizeof line, "{\"event\":\"lane\",\"up\":true,\"rtt\":%.3f}", dx);
    emit(line);
  } else if (kind == TD_DOWN) {
    held_dx = held_dy = 0; // that session is gone: its moves with it
    emit("{\"event\":\"lane\",\"up\":false}");
  }
}

int lane_fd(void) {
  if (qpipe[0] < 0 && pipe(qpipe) == 0) {
    fcntl(qpipe[0], F_SETFL, fcntl(qpipe[0], F_GETFL) | O_NONBLOCK);
    fcntl(qpipe[1], F_SETFL, fcntl(qpipe[1], F_GETFL) | O_NONBLOCK);
  }
  return qpipe[0];
}

void lane_drain(void (*inject)(double dx, double dy)) {
  if (qpipe[0] < 0) return;
  double m[2];
  while (read(qpipe[0], m, sizeof m) == (ssize_t)sizeof m) inject(m[0], m[1]);
}

static uint32_t u32(const JObj *c, const char *k) {
  double v = jnum(c, k, 0);
  if (v < 0) return 0;
  if (v > 4294967295.0) return 4294967295u;
  return (uint32_t)(v + 0.5);
}

// error: set on a bad op; extra: reply fields. inject: a fence's move, on this (main) thread.
void lane_handle(const JObj *c, const char **error, char *extra, size_t n, void (*inject)(double dx, double dy)) {
  const char *op = jstr(c, "op", "");
  if (!strcmp(op, "bind")) {
    lane_fd();
    uint16_t port = td_bind();
    if (!port) { *error = "no lane socket"; return; }
    snprintf(extra, n, "\"port\":%u", (unsigned)port);
  } else if (!strcmp(op, "start")) {
    const char *key = jstr(c, "key", NULL), *ip = jstr(c, "ip", NULL);
    if (!key || !ip) { *error = "bad lane start"; return; }
    int role = !strcmp(jstr(c, "role", ""), "host") ? 0 : 1;
    double port = jnum(c, "port", 0);
    started = td_start(role, key, ip, (uint16_t)(port > 0 && port < 65536 ? port : 0), callback, NULL) == 1;
    driving = 0;
    snprintf(extra, n, "\"ok\":%s", started ? "true" : "false");
  } else if (!strcmp(op, "stop")) {
    td_stop();
    started = driving = 0;
    held_dx = held_dy = 0; // the lane thread is gone
  } else if (!strcmp(op, "active")) {
    td_active(jbool(c, "on", 0));
  } else if (!strcmp(op, "route")) {
    uint32_t r = u32(c, "route");
    td_drive_reset(r);
    driving = started && r != 0;
  } else if (!strcmp(op, "event")) {
    const char *json = jstr(c, "json", NULL); // Node sends the event as JSON text for us
    if (json) td_send_event((const uint8_t *)json, strlen(json), u32(c, "es"));
  } else if (!strcmp(op, "driven")) {
    td_driven(u32(c, "route"), jnum(c, "speed", 1));
  } else if (!strcmp(op, "hold")) {
    td_hold(jbool(c, "on", 0));
  } else if (!strcmp(op, "fence")) {
    double dx = 0, dy = 0;
    if (td_fence_apply(u32(c, "route"), u32(c, "mn"), jnum(c, "cx", 0), jnum(c, "cy", 0), &dx, &dy) == 1) inject(dx, dy);
  } else if (!strcmp(op, "done")) {
    td_done(u32(c, "es"));
  } else {
    *error = "unknown lane op";
  }
}

// A move from the capture: 1 when it went on the lane (write nothing); else 0, with the totals added
// to k while the lane is down.
int lane_move(double dx, double dy, JOut *k) {
  if (!driving) return 0;
  uint32_t r = 0, mn = 0;
  double cx = 0, cy = 0;
  int32_t got = td_move(dx, dy, &r, &mn, &cx, &cy);
  if (got == 1) return 1;
  if (got == 0) {
    char mc[80];
    jo_num(k, "route", r);
    jo_num(k, "mn", mn);
    snprintf(mc, sizeof mc, "[%.17g,%.17g]", cx, cy);
    jo_raw(k, "mc", mc);
  }
  return 0;
}

// A click, key or wheel (k: a built k.* object, "t" first): numbered, with where the moves before it
// took the pointer. Returns k, or buf with the fence added.
const char *lane_fence(const char *k, char *buf, size_t n) {
  static const char *fenced[] = { "k.md", "k.mu", "k.wh", "k.kd", "k.ku", "k.ge" };
  if (!driving || strncmp(k, "{\"t\":\"", 6)) return k;
  int hit = 0;
  for (size_t i = 0; i < sizeof fenced / sizeof *fenced; i++)
    if (!strncmp(k + 6, fenced[i], 4) && k[10] == '"') hit = 1;
  size_t len = strlen(k);
  if (!hit || len < 2 || k[len - 1] != '}') return k;
  uint32_t r = 0, mn = 0;
  double cx = 0, cy = 0;
  uint32_t es = td_fence(&r, &mn, &cx, &cy);
  if (!es) return k;
  int w = snprintf(buf, n, "%.*s,\"es\":%u,\"route\":%u,\"mn\":%u,\"mc\":[%.17g,%.17g]}", (int)(len - 1), k, es, r, mn, cx, cy);
  return w > 0 && (size_t)w < n ? buf : k;
}
#endif

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Shake to bring the pointer home: while capturing, a quick left-right shake of this computer's
// mouse or touchpad emits {"event":"shake"} and Node takes the input back here (kvm.js,
// kvm.shakeHome). Fed after the move has gone (lane or stdout), so it adds nothing in front of it:
// a few compares, no allocation. Same rules as mac-helper Shake.swift and windows-helper Shake.cs:
// a stroke is STROKE px one way before it turns; REVERSALS turns within WINDOW_MS is a shake; a
// pause of GAP_MS or a short wiggle starts over; after one, COOLDOWN_MS of the rest doesn't count.
#include "helper.h"
#include <math.h>

#define STROKE 40.0
#define REVERSALS 4
#define WINDOW_MS 800.0
#define GAP_MS 200.0
#define COOLDOWN_MS 1000.0

static double turns[REVERSALS]; // a ring of the last REVERSALS turns
static int dir, nturns, head;
static double run, last, quiet;

static void reset(void) {
  dir = 0;
  run = 0;
  nturns = 0;
}

void shake_feed(double dx, double dy) {
  double now = now_ms();
  if (now < quiet) return;
  if (now - last >= GAP_MS) reset();
  last = now;
  double ax = fabs(dx);
  if (ax < 1 || fabs(dy) > ax * 2) return; // mostly up or down: not a shake
  int d = dx > 0 ? 1 : -1;
  if (d == dir) {
    run += ax;
    return;
  }
  if (dir && run >= STROKE) {
    turns[head] = now;
    head = (head + 1) % REVERSALS;
    if (nturns < REVERSALS) nturns++;
  } else if (dir) nturns = 0;
  dir = d;
  run = ax;
  // full ring: turns[head] is the oldest of the last REVERSALS
  if (nturns == REVERSALS && now - turns[head] <= WINDOW_MS) {
    reset();
    quiet = now + COOLDOWN_MS;
    emit("{\"event\":\"shake\"}");
  }
}

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Shake to bring the pointer home: while capturing, a quick left-right shake of this PC's mouse or
// touchpad emits {"event":"shake"} and Node takes the input back here (kvm.js, kvm.shakeHome).
// Fed after the move has gone (lane or stdout), so it adds nothing in front of it: a few compares,
// no allocation. Same rules as mac-helper Shake.swift and linux-helper shake.c:
// a stroke is Stroke px one way before it turns; Reversals turns within WindowMs is a shake; a
// pause of GapMs or a short wiggle starts over; after one, CooldownMs of the rest doesn't count.
using System;
using System.Collections.Generic;

namespace MacShare
{
    static class Shake
    {
        const double Stroke = 40;
        const int Reversals = 4, WindowMs = 800, GapMs = 200, CooldownMs = 1000;
        static readonly int[] turns = new int[Reversals]; // a ring of the last Reversals turns
        static int dir, nTurns, head, last, quiet;
        static double run;
        static bool quieting;

        static void Reset() { dir = 0; run = 0; nTurns = 0; }

        // On the hook's thread, with the capture's emit.
        public static void Feed(double dx, double dy, Action<Dictionary<string, object>> emit)
        {
            int now = Environment.TickCount; // wraps: compared by difference only
            if (quieting) { if (unchecked(now - quiet) < 0) return; quieting = false; }
            if (unchecked(now - last) >= GapMs) Reset();
            last = now;
            double ax = Math.Abs(dx);
            if (ax < 1 || Math.Abs(dy) > ax * 2) return; // mostly up or down: not a shake
            int d = dx > 0 ? 1 : -1;
            if (d == dir) { run += ax; return; }
            if (dir != 0 && run >= Stroke)
            {
                turns[head] = now;
                head = (head + 1) % Reversals;
                if (nTurns < Reversals) nTurns++;
            }
            else if (dir != 0) nTurns = 0;
            dir = d;
            run = ax;
            // full ring: turns[head] is the oldest of the last Reversals
            if (nTurns == Reversals && unchecked(now - turns[head]) <= WindowMs)
            {
                Reset();
                quiet = unchecked(now + CooldownMs);
                quieting = true;
                Dictionary<string, object> e = new Dictionary<string, object>();
                e["event"] = "shake";
                emit(e);
            }
        }
    }
}

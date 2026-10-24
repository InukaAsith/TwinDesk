// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Smooth pointer motion for the phone's Remote (its touchpad and right stick: k.mm with smooth).
// The phone sends a move about every 16 ms and Wi-Fi bunches them, so instead of jumping, each
// one is given out in small steps on a 2 ms clock, easing out over about one frame (TauMs): the
// pointer glides, about a frame later. Windows' timer runs at 1 ms only while there is movement.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace MacShare
{
    class Smoother
    {
        const double TauMs = 14; // how quickly pending movement is given out (about one 60 Hz frame)
        const int StepMs = 2;
        const int IdleMs = 250;  // nothing left for this long: the timer goes back to normal
        readonly object gate = new object();
        readonly Action<double, double> move; // gives out a step (Program: on the UI thread, like every other move)
        double px, py;                        // movement not given out yet (logical px)
        Thread thread;

        [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
        [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint ms);

        public Smoother(Action<double, double> move)
        {
            this.move = move;
        }

        public void Add(double dx, double dy)
        {
            lock (gate)
            {
                px += dx;
                py += dy;
                if (thread == null)
                {
                    thread = new Thread(Run);
                    thread.IsBackground = true;
                    thread.Start();
                }
                Monitor.Pulse(gate);
            }
        }

        // Everything still pending, at once (before a click or a key, so it lands where the pointer ends up).
        public void Flush(Action<double, double> now)
        {
            double x, y;
            lock (gate)
            {
                x = px;
                y = py;
                px = 0;
                py = 0;
            }
            if (x != 0 || y != 0) now(x, y);
        }

        // Drop what's pending (the remote let go of everything).
        public void Clear()
        {
            lock (gate)
            {
                px = 0;
                py = 0;
            }
        }

        void Run()
        {
            Stopwatch clock = Stopwatch.StartNew();
            while (true)
            {
                lock (gate)
                {
                    while (px == 0 && py == 0) Monitor.Wait(gate);
                }
                timeBeginPeriod(1);
                try
                {
                    double last = clock.Elapsed.TotalMilliseconds, busy = last;
                    while (true)
                    {
                        Thread.Sleep(StepMs);
                        double now = clock.Elapsed.TotalMilliseconds;
                        double dt = Math.Min(50, now - last);
                        last = now;
                        double sx, sy;
                        lock (gate)
                        {
                            double k = 1 - Math.Exp(-dt / TauMs);
                            sx = px * k;
                            sy = py * k;
                            if (Math.Abs(px - sx) < 0.05 && Math.Abs(py - sy) < 0.05) { sx = px; sy = py; } // the last bit at once
                            px -= sx;
                            py -= sy;
                        }
                        if (sx != 0 || sy != 0) { move(sx, sy); busy = now; }
                        else if (now - busy > IdleMs) break;
                    }
                }
                finally { timeEndPeriod(1); }
            }
        }
    }
}

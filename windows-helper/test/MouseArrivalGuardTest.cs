// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
using System;
using MacShare;

class MouseArrivalGuardTest
{
    static void Check(bool actual, bool expected, string name)
    {
        if (actual != expected) throw new Exception(name);
    }
    static void Main()
    {
        Check(MouseArrivalGuard.IsStale(999, 1000, 1010), true, "queued move");
        Check(MouseArrivalGuard.IsStale(1000, 1000, 1010), true, "same clock tick");
        Check(MouseArrivalGuard.IsStale(1001, 1000, 1010), false, "new movement");
        Check(MouseArrivalGuard.IsStale(999, 1000, 1501), false, "expired guard");
        Check(MouseArrivalGuard.IsStale(0xffffffff, 1, 10), true, "clock wrap");
        Check(MouseArrivalGuard.IsStale(2, 0xffffffff, 10), false, "new move after clock wrap");
        // parked at (1280, 720), home at the bottom edge (1000, 1437)
        Check(MouseArrivalGuard.FromPark(1290, 700, 1280, 720, 1000, 1437, 1000, 1050), true, "move from the parked spot");
        Check(MouseArrivalGuard.FromPark(1005, 1430, 1280, 720, 1000, 1437, 1000, 1050), false, "move from home");
        Check(MouseArrivalGuard.FromPark(1290, 700, 1280, 720, 1000, 1437, 1000, 1200), false, "after the window");
        Check(MouseArrivalGuard.FromPark(1290, 700, 1280, 720, 1300, 800, 1000, 1050), false, "home next to the parked spot");
        Console.WriteLine("MouseArrivalGuard: passed");
    }
}

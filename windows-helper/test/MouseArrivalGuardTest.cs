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
        Console.WriteLine("MouseArrivalGuard: passed");
    }
}

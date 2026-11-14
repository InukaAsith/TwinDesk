// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Ignore mouse moves generated before a capture ended: their coordinates were computed while
// the local pointer was parked and must not overwrite the arrival position.
namespace MacShare
{
    static class MouseArrivalGuard
    {
        public const uint WindowMs = 500; // how long after the pointer came home the guard looks
        public const uint ParkMs = 150; // how long a move at the parked spot still counts as from before
        public const int ParkPx = 150;

        public static bool IsStale(uint eventTime, uint stoppedAt, uint now)
        {
            // Windows input timestamps and TickCount share a 32-bit millisecond clock. Limit the
            // guard to 500 ms so an idle mouse and clock wrap cannot suppress a later movement.
            return unchecked(now - stoppedAt) <= WindowMs && unchecked((int)(eventTime - stoppedAt)) <= 0;
        }

        // A move that lands next to where the pointer was parked (the middle of the primary monitor),
        // just after it came home somewhere else: worked out from the parked spot before the pointer
        // was put at its edge (the clock is too coarse to tell it by its time alone; a fast flick
        // queues many). Let through, it threw the pointer back to the middle.
        public static bool FromPark(int x, int y, int parkX, int parkY, int homeX, int homeY, uint stoppedAt, uint now)
        {
            if (unchecked(now - stoppedAt) > ParkMs) return false;
            if (Near(homeX, homeY, parkX, parkY, 2 * ParkPx)) return false; // came home next to the parked spot: can't tell
            return Near(x, y, parkX, parkY, ParkPx);
        }

        static bool Near(int x, int y, int ax, int ay, int px)
        {
            return System.Math.Abs(x - ax) <= px && System.Math.Abs(y - ay) <= px;
        }
    }
}

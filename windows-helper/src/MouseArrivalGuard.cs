// Ignore mouse moves generated before a capture ended: their coordinates were computed while
// the local pointer was parked and must not overwrite the arrival position.
namespace MacShare
{
    static class MouseArrivalGuard
    {
        public static bool IsStale(uint eventTime, uint stoppedAt, uint now)
        {
            // Windows input timestamps and TickCount share a 32-bit millisecond clock. Limit the
            // guard to 500 ms so an idle mouse and clock wrap cannot suppress a later movement.
            return unchecked(now - stoppedAt) <= 500 && unchecked((int)(eventTime - stoppedAt)) <= 0;
        }
    }
}

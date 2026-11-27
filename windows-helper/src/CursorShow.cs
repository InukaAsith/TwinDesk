// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The other computer's mouse here and Windows shows no pointer (#329: a Mac's mouse on a PC). Checked
// while driven (at most every 2 s): when Windows says the cursor isn't showing, the user's scheme is
// loaded again (a blank one left by a crash while this PC drove another, #238), and the reason goes to
// the log once per drive. Windows hides the pointer when no mouse of its own is plugged in (a desktop
// with only a keyboard, a tablet after touch): that one needs Mouse Keys on, which isn't switched on from
// here (an accessibility setting a crash could leave behind), so the log says where it is.
using System;
using System.Runtime.InteropServices;

namespace MacShare
{
    static class CursorShow
    {
        [StructLayout(LayoutKind.Sequential)]
        struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public Native.POINT pt; }
        [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO pci);
        [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, IntPtr value, uint winIni);

        const int CURSOR_SHOWING = 1, CURSOR_SUPPRESSED = 2, SM_MOUSEPRESENT = 19;
        static int last;
        static bool said, reloaded;

        // A new drive (home, or another computer): told again, reloaded again if it needs it.
        public static void Reset() { said = false; reloaded = false; }

        public static void Check()
        {
            int now = Environment.TickCount;
            if (last != 0 && unchecked(now - last) < 2000) return;
            last = now;
            CURSORINFO ci = new CURSORINFO();
            ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
            if (!GetCursorInfo(ref ci) || (ci.flags & CURSOR_SHOWING) != 0) return;
            bool mouse = Native.GetSystemMetrics(SM_MOUSEPRESENT) != 0;
            if (!said)
            {
                said = true;
                Console.Error.WriteLine("[cursor] driven, and Windows shows no pointer (" + ((ci.flags & CURSOR_SUPPRESSED) != 0 ? "suppressed after touch or pen" : "hidden")
                    + ", a mouse " + (mouse ? "is" : "isn't") + " plugged in here)" + (mouse ? "" : ": with none, Windows hides it; Settings > Accessibility > Mouse > Mouse keys shows it"));
            }
            if (!reloaded) // the user's scheme again, once per drive
            {
                reloaded = true;
                SystemParametersInfo(0x0057 /* SPI_SETCURSORS */, 0, IntPtr.Zero, 0x02 /* SPIF_SENDCHANGE */);
            }
        }
    }
}

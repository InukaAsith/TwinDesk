// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The pointer is hidden on this PC while it drives the Mac ("Crossing between the
// computers"): every system cursor is swapped for a blank one, and the user's own cursors are
// reloaded from their settings when it comes back. Also reloaded when the helper starts or crashes,
// in case they were ever left blank (the installer reloads them too, after stopping the helper).
using System;
using System.Runtime.InteropServices;

namespace MacShare
{
    static class HideCursor
    {
        [DllImport("user32.dll")] static extern IntPtr CreateCursor(IntPtr inst, int x, int y, int w, int h, byte[] and, byte[] xor);
        [DllImport("user32.dll")] static extern bool SetSystemCursor(IntPtr cursor, uint id);
        [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, IntPtr value, uint winIni);

        // OCR_NORMAL, IBEAM, WAIT, CROSS, UP, SIZENWSE, SIZENESW, SIZEWE, SIZENS, SIZEALL, NO, HAND, APPSTARTING, HELP, PIN, PERSON
        static readonly uint[] Ids = { 32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650, 32651, 32671, 32672 };
        static bool hidden;

        public static void Hide()
        {
            if (hidden) return;
            hidden = true;
            byte[] and = new byte[32 * 32 / 8], xor = new byte[32 * 32 / 8];
            for (int i = 0; i < and.Length; i++) and[i] = 0xFF; // transparent everywhere
            foreach (uint id in Ids)
            {
                IntPtr c = CreateCursor(IntPtr.Zero, 0, 0, 32, 32, and, xor);
                if (c != IntPtr.Zero) SetSystemCursor(c, id); // the system owns c from here
            }
        }

        public static void Show()
        {
            if (!hidden) return;
            hidden = false;
            Restore();
        }

        // Reloading can fail (a UAC prompt on the secure desktop, an elevated window in front): it
        // is tried again every tick (Retry) until it works, so a pointer is never left blank.
        static bool restorePending;

        public static void Restore()
        {
            restorePending = !SystemParametersInfo(0x0057 /* SPI_SETCURSORS */, 0, IntPtr.Zero, 0x02 /* SPIF_SENDCHANGE */);
        }

        public static void Retry()
        {
            if (restorePending && !hidden) Restore();
        }
    }
}

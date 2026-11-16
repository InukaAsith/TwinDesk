// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The pointer is hidden on this PC while it drives the Mac ("Crossing between the
// computers"). The blank replacements keep each cursor's size; coming back reloads the user's scheme.
// A crash guard reloads it too, only if blank cursors were left behind.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32;

namespace MacShare
{
    static partial class HideCursor
    {
#if !CURSOR_TEST
        [DllImport("user32.dll")] static extern IntPtr LoadCursor(IntPtr instance, IntPtr name);
        [DllImport("user32.dll")] static extern bool SetSystemCursor(IntPtr cursor, uint id);
        [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, IntPtr value, uint winIni);
        static string CursorPath(uint id)
        {
            int index = Array.IndexOf(Ids, id);
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Control Panel\Cursors"))
                    return key == null || index < 0 ? "" : key.GetValue(Names[index], "") as string;
            }
            catch (System.Security.SecurityException) { return ""; }
            catch (UnauthorizedAccessException) { return ""; }
        }
#endif

        // OCR_NORMAL, IBEAM, WAIT, CROSS, UP, SIZENWSE, SIZENESW, SIZEWE, SIZENS, SIZEALL, NO, HAND, APPSTARTING, HELP, PIN, PERSON
        static readonly uint[] Ids = { 32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650, 32651, 32671, 32672 };
        static readonly string[] Names = { "Arrow", "IBeam", "Wait", "Crosshair", "UpArrow", "SizeNWSE", "SizeNESW", "SizeWE", "SizeNS", "SizeAll", "No", "Hand", "AppStarting", "Help", "Pin", "Person" };
        static bool hidden;
        static readonly Dictionary<uint, IntPtr> saved = new Dictionary<uint, IntPtr>();
        static readonly Dictionary<uint, string> animations = new Dictionary<uint, string>();
        static EventWaitHandle recovery, guardReady;

        internal static string RecoveryName(int pid) { return @"Local\TwinDesk.CursorRecovery." + pid; }
        internal static string ReadyName(int pid) { return RecoveryName(pid) + ".Ready"; }
        internal static void PrepareRecovery()
        {
            try
            {
                int pid = Process.GetCurrentProcess().Id;
                recovery = new EventWaitHandle(false, EventResetMode.ManualReset, RecoveryName(pid));
                guardReady = new EventWaitHandle(false, EventResetMode.ManualReset, ReadyName(pid));
            }
            catch (Exception e) { Console.Error.WriteLine("Cursor hiding disabled: " + e.Message); }
        }
        internal static void WaitForGuard() { if (guardReady != null && !Unguarded) guardReady.WaitOne(1000); }
        // The Full KVM agent (Agent.cs) starts no guard: it hides the pointer without one, as it always has.
        internal static bool Unguarded;

        static IntPtr Copy(uint id, IntPtr cursor)
        {
            string file;
            if (!animations.TryGetValue(id, out file)) return CursorImages.CopyIcon(cursor);
            // Both copy APIs flatten .ani files. Reload their frames at the captured size.
            CursorImages.Shape original, copy;
            if (!CursorImages.Read(cursor, out original)) return IntPtr.Zero;
            IntPtr image = CursorImages.LoadImage(IntPtr.Zero, file, 2 /* IMAGE_CURSOR */, original.Width, original.Height, 0x10 /* LR_LOADFROMFILE */);
            if (image == IntPtr.Zero) return IntPtr.Zero;
            if (CursorImages.Read(image, out copy) && copy.Width == original.Width && copy.Height == original.Height && copy.HotX == original.HotX && copy.HotY == original.HotY) return image;
            CursorImages.DestroyCursor(image);
            return IntPtr.Zero;
        }

        static void DiscardSaved()
        {
            foreach (IntPtr cursor in saved.Values) CursorImages.DestroyCursor(cursor);
            saved.Clear();
            animations.Clear();
        }

        public static void Hide()
        {
            if (hidden || saved.Count != 0 || (!Unguarded && (recovery == null || guardReady == null || !guardReady.WaitOne(0)))) return;
            foreach (uint id in Ids)
            {
                string path = CursorPath(id);
                // An unspecified busy cursor may be animated; keep its role if no source can be restored.
                if (String.IsNullOrEmpty(path) && (id == 32514 || id == 32650)) continue;
                IntPtr cursor = LoadCursor(IntPtr.Zero, new IntPtr(id));
                if (cursor == IntPtr.Zero) continue;
                if (String.Equals(Path.GetExtension(path), ".ani", StringComparison.OrdinalIgnoreCase))
                    animations[id] = Environment.ExpandEnvironmentVariables(path);
                CursorImages.Shape shape;
                if (!CursorImages.Read(cursor, out shape) || shape.Blank) { DiscardSaved(); return; }
                // Preserve the image size and hotspot, including enlarged cursors.
                IntPtr copy = Copy(id, cursor);
                if (copy == IntPtr.Zero) { DiscardSaved(); return; }
                saved.Add(id, copy);
            }
            if (saved.Count == 0) return;
            if (recovery != null) recovery.Set(); // the guard must know before the first system-wide replacement
            foreach (uint id in saved.Keys)
            {
                CursorImages.Shape shape;
                if (!CursorImages.Read(saved[id], out shape)) { Restore(); return; }
                IntPtr blank = CursorImages.Blank(shape);
                if (blank == IntPtr.Zero || !SetSystemCursor(blank, id)) { Restore(); return; }
            }
            hidden = true;
            Console.Error.WriteLine("[cursor] hidden (driving the other computer)");
        }

        // Back home: reloaded even if this process doesn't think it hid them (a helper restarted
        // meanwhile, a hide another build left), and again twice in the next 2 s (Retry): a reload that
        // reported success while Windows still drew the blank arrow left the pointer invisible (#238).
        public static void Show()
        {
            bool was = hidden;
            hidden = false;
            // Hidden here, or a restore still pending: the scheme reloaded. Not hidden by this process: only if the arrow is blank.
            if (was || restorePending || saved.Count != 0) Restore(); else Recover();
            again = 2;
            againAt = Environment.TickCount + 400;
            Console.Error.WriteLine("[cursor] " + (restorePending ? "restore failed, trying again" : "restored") + (was ? "" : " (it wasn't hidden here)"));
        }
        static int again, againAt;

        // Keep the originals across a failed restore (secure desktop/UAC); Retry tries them again.
        static bool restorePending;
        public static bool Pending { get { return restorePending; } }

        // Reload the user's scheme (SPI_SETCURSORS), never our copies: on Windows 10 with an enlarged
        // accessibility pointer, putting a CopyIcon copy back with SetSystemCursor left the arrow as a
        // black 64×64 masked-color block. The reload rebuilds the cursors at the configured size.
        public static void Restore()
        {
            hidden = false;
            if (saved.Count == 0 && !restorePending) return;
            restorePending = !SystemParametersInfo(0x0057 /* SPI_SETCURSORS */, 0, IntPtr.Zero, 0x02 /* SPIF_SENDCHANGE */);
            if (!restorePending)
            {
                DiscardSaved();
                if (recovery != null) recovery.Reset();
            }
        }

        internal static void Recover()
        {
            restorePending = false;
            foreach (uint id in Ids)
            {
                IntPtr cursor = LoadCursor(IntPtr.Zero, new IntPtr(id));
                if (cursor == IntPtr.Zero) continue;
                CursorImages.Shape shape;
                if (!CursorImages.Read(cursor, out shape)) { restorePending = true; continue; }
                if (shape.Blank)
                {
                    restorePending = !SystemParametersInfo(0x0057 /* SPI_SETCURSORS */, 0, IntPtr.Zero, 0x02 /* SPIF_SENDCHANGE */);
                    return;
                }
            }
        }

        internal static void RecoverIfAlone()
        {
            int own = Process.GetCurrentProcess().Id;
            foreach (string name in new[] { "macshare-winhelper", "macshare-winhelper-multi" })
                foreach (Process process in Process.GetProcessesByName(name))
                    using (process) if (process.Id != own) return;
            Recover();
        }

        public static void Retry()
        {
            if (hidden) return;
            if (restorePending) { if (saved.Count != 0) Restore(); else Recover(); if (!restorePending) Console.Error.WriteLine("[cursor] restored"); return; }
            // Twice more in the 2 s after coming home: still blank (a reload that said it worked), reloaded (#238).
            if (again > 0 && unchecked(Environment.TickCount - againAt) >= 0)
            {
                again--;
                againAt = Environment.TickCount + 1200;
                Recover();
            }
        }
    }
}

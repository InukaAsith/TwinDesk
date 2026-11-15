// Test private cursor handles only. The three system-wide APIs are replaced at compile time.
// Compile with /define:CURSOR_TEST alongside src/HideCursor.cs and src/CursorImages.cs.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using MacShare;

namespace MacShare
{
    static partial class HideCursor
    {
        internal static readonly Dictionary<uint, IntPtr> TestSystem = new Dictionary<uint, IntPtr>();
        internal static int Reloads, Replacements;
        internal static bool FailReplace;
        internal static string AnimationPath = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"Cursors\aero_busy.ani");
        static string CursorPath(uint id) { return id == 32514 ? AnimationPath : "test.cur"; }
        static IntPtr LoadCursor(IntPtr instance, IntPtr id)
        {
            IntPtr cursor; return TestSystem.TryGetValue((uint)id.ToInt64(), out cursor) ? cursor : IntPtr.Zero;
        }
        static bool SetSystemCursor(IntPtr cursor, uint id)
        {
            Replacements++;
            if (FailReplace) { CursorImages.DestroyCursor(cursor); return false; }
            if (TestSystem.ContainsKey(id)) CursorImages.DestroyCursor(TestSystem[id]);
            TestSystem[id] = cursor;
            return true;
        }
        // SPI_SETCURSORS: Windows rebuilds every role from the user's scheme.
        internal static readonly Dictionary<uint, Func<IntPtr>> Scheme = new Dictionary<uint, Func<IntPtr>>();
        internal static bool FailReload;
        static bool SystemParametersInfo(uint action, uint param, IntPtr value, uint winIni)
        {
            Reloads++;
            if (FailReload) return false;
            foreach (KeyValuePair<uint, Func<IntPtr>> role in Scheme)
            {
                if (TestSystem.ContainsKey(role.Key)) CursorImages.DestroyCursor(TestSystem[role.Key]);
                TestSystem[role.Key] = role.Value();
            }
            return true;
        }
        internal static void Ready() { PrepareRecovery(); guardReady.Set(); }
        internal static bool RecoveryNeeded { get { return recovery.WaitOne(0); } }
    }
}

class CursorRestoreTest
{
    [StructLayout(LayoutKind.Sequential)]
    struct ICONINFO { [MarshalAs(UnmanagedType.Bool)] public bool icon; public uint x, y; public IntPtr mask, color; }
    [DllImport("user32.dll")] static extern IntPtr CreateCursor(IntPtr instance, int x, int y, int width, int height, byte[] andMask, byte[] xorMask);
    [DllImport("gdi32.dll")] static extern IntPtr CreateBitmap(int width, int height, uint planes, uint bpp, byte[] bits);
    [DllImport("user32.dll")] static extern IntPtr CreateIconIndirect(ref ICONINFO info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadImage(IntPtr instance, string file, uint type, int width, int height, uint flags);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr bitmap);
    [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr cursor, int width, int height, uint step, IntPtr brush, uint flags);

    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static IntPtr Monochrome(int width, int height, int x, int y)
    {
        byte[] andMask = new byte[((width + 15) / 16) * 2 * height], xorMask = new byte[andMask.Length];
        xorMask[0] = 128;
        return CreateCursor(IntPtr.Zero, x, y, width, height, andMask, xorMask);
    }
    static IntPtr Color()
    {
        byte[] pixels = new byte[64 * 64 * 4];
        for (int i = 0; i < pixels.Length; i += 4) { pixels[i] = 40; pixels[i + 1] = 70; pixels[i + 2] = 110; pixels[i + 3] = 128; }
        ICONINFO icon = new ICONINFO { x = 7, y = 11, color = CreateBitmap(64, 64, 1, 32, pixels), mask = CreateBitmap(64, 64, 1, 1, new byte[64 * 64 / 8]) };
        try { return CreateIconIndirect(ref icon); }
        finally { DeleteObject(icon.color); DeleteObject(icon.mask); }
    }
    static string Pixels(IntPtr cursor, uint step = 0)
    {
        CursorImages.Shape shape; Check(CursorImages.Read(cursor, out shape), "read pixels");
        List<byte> pixels = new List<byte>();
        foreach (Color background in new[] { System.Drawing.Color.Black, System.Drawing.Color.White })
            using (Bitmap image = new Bitmap(shape.Width, shape.Height))
            using (Graphics graphics = Graphics.FromImage(image))
        {
            graphics.Clear(background);
            IntPtr dc = graphics.GetHdc();
            try { Check(DrawIconEx(dc, 0, 0, cursor, 0, 0, step, IntPtr.Zero, 3), "draw cursor"); }
            finally { graphics.ReleaseHdc(dc); }
            for (int y = 0; y < shape.Height; y++) for (int x = 0; x < shape.Width; x++)
            {
                Color pixel = image.GetPixel(x, y);
                pixels.Add(pixel.R); pixels.Add(pixel.G); pixels.Add(pixel.B);
            }
        }
        return Convert.ToBase64String(pixels.ToArray());
    }
    static void Shape(uint id, int width, int height, int x, int y, bool blank)
    {
        CursorImages.Shape shape;
        Check(CursorImages.Read(HideCursor.TestSystem[id], out shape), "cursor readable");
        Check(shape.Width == width && shape.Height == height && shape.HotX == x && shape.HotY == y && shape.Blank == blank, "dimensions, hotspot and transparency");
    }
    static void Main()
    {
        try { Run(); }
        catch (Exception e) { Console.Error.WriteLine(e.GetType().Name + ": " + e.Message); Environment.Exit(1); }
    }
    static void Run()
    {
        string animatedFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"Cursors\aero_busy.ani");
        HideCursor.Scheme[32512] = Color;
        HideCursor.Scheme[32513] = () => Monochrome(96, 96, 13, 17);
        HideCursor.Scheme[32649] = () => Monochrome(48, 48, 9, 5); // 1-bit rows have GDI padding
        HideCursor.Scheme[32515] = () => Monochrome(256, 256, 127, 191);
        HideCursor.Scheme[32514] = () => LoadImage(IntPtr.Zero, animatedFile, 2, 0, 0, 0x10 /* LR_LOADFROMFILE */);
        foreach (KeyValuePair<uint, Func<IntPtr>> role in HideCursor.Scheme) HideCursor.TestSystem[role.Key] = role.Value();
        Check(HideCursor.TestSystem[32514] != IntPtr.Zero, "Windows animated cursor fixture");
        try
        {
            string color = Pixels(HideCursor.TestSystem[32512]), mono = Pixels(HideCursor.TestSystem[32513]);
            string[] frames = new string[12];
            for (uint step = 0; step < frames.Length; step++) frames[step] = Pixels(HideCursor.TestSystem[32514], step);
            Check(Array.Exists(frames, frame => frame != frames[0]), "fixture contains distinct animation frames");
            HideCursor.Restore(); HideCursor.Recover();
            Check(HideCursor.Reloads == 0 && HideCursor.Replacements == 0, "normal startup must not reload or replace cursors");
            HideCursor.Ready();
            for (int i = 0; i < 3; i++)
            {
                HideCursor.Hide(); Check(HideCursor.RecoveryNeeded, "guard marked before hiding");
                Shape(32512, 64, 64, 0, 0, true); Shape(32513, 96, 96, 0, 0, true); Shape(32649, 48, 48, 0, 0, true);
                HideCursor.Show(); Check(!HideCursor.RecoveryNeeded, "normal restore clears guard state");
                Shape(32512, 64, 64, 7, 11, false); Shape(32513, 96, 96, 13, 17, false); Shape(32649, 48, 48, 9, 5, false);
                Shape(32515, 256, 256, 127, 191, false);
                for (uint step = 0; step < frames.Length; step++)
                    Check(Pixels(HideCursor.TestSystem[32514], step) == frames[step], "animated frame " + step + " retained");
                Check(Pixels(HideCursor.TestSystem[32512]) == color && Pixels(HideCursor.TestSystem[32513]) == mono, "restore pixel mismatch: color=" + (Pixels(HideCursor.TestSystem[32512]) == color) + ", mono=" + (Pixels(HideCursor.TestSystem[32513]) == mono));
            }
            Check(HideCursor.Reloads == 3, "each return reloads the user's scheme once, never our copies");
            int replacements = HideCursor.Replacements;
            HideCursor.AnimationPath = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString() + ".ani");
            HideCursor.Hide();
            Check(HideCursor.Replacements == replacements && !HideCursor.RecoveryNeeded, "missing animation source leaves every cursor unchanged");
            HideCursor.AnimationPath = "";
            HideCursor.Hide();
            for (uint step = 0; step < frames.Length; step++)
                Check(Pixels(HideCursor.TestSystem[32514], step) == frames[step], "unspecified animated role stays intact");
            HideCursor.Show(); HideCursor.AnimationPath = animatedFile;
            HideCursor.FailReplace = true; HideCursor.Hide(); HideCursor.FailReplace = false;
            Check(!HideCursor.Pending && !HideCursor.RecoveryNeeded && Pixels(HideCursor.TestSystem[32512]) == color, "failed hide keeps original images");
            HideCursor.Hide(); HideCursor.FailReload = true; HideCursor.Show();
            Check(HideCursor.Pending && HideCursor.RecoveryNeeded, "failed restore keeps the recovery marker");
            Shape(32512, 64, 64, 0, 0, true);
            HideCursor.FailReload = false; HideCursor.Retry();
            Check(!HideCursor.Pending && !HideCursor.RecoveryNeeded, "retry restores the scheme");
            Check(Pixels(HideCursor.TestSystem[32512]) == color, "retry restores the enlarged color cursor");
            HideCursor.Hide();
            HideCursor.Scheme[32512] = () => Monochrome(128, 128, 3, 4); // user changed the pointer while it was hidden
            HideCursor.Show(); Shape(32512, 128, 128, 3, 4, false);
            HideCursor.Scheme[32512] = Color;
            int reloads = HideCursor.Reloads;
            HideCursor.Recover(); HideCursor.Show(); HideCursor.Retry();
            Check(HideCursor.Reloads == reloads, "visible cursors are never reloaded");
            HideCursor.TestSystem[32512] = ReplaceWithBlank(HideCursor.TestSystem[32512]); HideCursor.Recover();
            Check(HideCursor.Reloads == reloads + 1 && !HideCursor.Pending && Pixels(HideCursor.TestSystem[32512]) == color, "orphaned blank cursors trigger one crash recovery");
            Console.WriteLine("Cursor restore: up to 256px, alpha pixels, hotspots, animation frames, padded masks, user changes and failed restore retries passed. No system cursors were modified.");
        }
        finally { foreach (IntPtr cursor in HideCursor.TestSystem.Values) CursorImages.DestroyCursor(cursor); }
    }
    static IntPtr ReplaceWithBlank(IntPtr cursor)
    {
        CursorImages.Shape shape; Check(CursorImages.Read(cursor, out shape), "blank source");
        IntPtr blank = CursorImages.Blank(shape); CursorImages.DestroyCursor(cursor); return blank;
    }
}

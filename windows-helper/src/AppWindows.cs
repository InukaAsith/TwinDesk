// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// PC apps on the Mac: the visible top-level windows with their process (path, parent,
// AppUserModelID), visible frame in physical px and whether they are a pop-up (menu, drop-down,
// owned caption-less window) with their owner; a "shown" event when a top-level window appears or
// goes (menus open fast); raise / close / resize one; a point inside one;
// and app icons up to 256 px as PNG (shell image factory, works for .lnk and shell:AppsFolder\<id>).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace MacShare
{
    static class AppWindows
    {
        delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }

        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int max);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
        [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr h, ref int len, StringBuilder s);
        [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32First(IntPtr snap, ref PROCESSENTRY32 e);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32Next(IntPtr snap, ref PROCESSENTRY32 e);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct PROCESSENTRY32
        {
            public int dwSize; public int cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID;
            public int cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public int dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
        }

        // Window property store: UWP frames carry their app's AppUserModelID here.
        [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, out IPropertyStore store);
        [StructLayout(LayoutKind.Sequential, Pack = 4)] struct PROPERTYKEY { public Guid fmtid; public uint pid; }
        [StructLayout(LayoutKind.Sequential)] struct PROPVARIANT { public ushort vt; ushort r1, r2, r3; public IntPtr p; IntPtr p2; }
        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IPropertyStore
        {
            [PreserveSig] int GetCount(out uint n);
            [PreserveSig] int GetAt(uint i, out PROPERTYKEY k);
            [PreserveSig] int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
            [PreserveSig] int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v);
            [PreserveSig] int Commit();
        }
        [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT v);

        const int GWL_STYLE = -16, GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, WS_CHILD = 0x40000000;
        const int DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;
        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, WM_CLOSE = 0x10, TH32CS_SNAPPROCESS = 2;
        const uint SWP_NOMOVE = 2, SWP_NOZORDER = 4, SWP_NOACTIVATE = 0x10;
        const int SW_RESTORE = 9;
        const byte VK_MENU = 0x12;
        static readonly HashSet<string> SkipClass = new HashSet<string> { "tooltips_class32", "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd" };
        static readonly HashSet<string> MenuClass = new HashSet<string> { "#32768", "ComboLBox" }; // menus, combo-box drop-downs
        const int WS_CAPTION = 0x00C00000;
        const uint GA_ROOTOWNER = 3, GA_ROOT = 2;
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
        [StructLayout(LayoutKind.Sequential)]
        struct GUITHREADINFO { public int cbSize, flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
        [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
        const int GUI_INMENUMODE = 4, GUI_SYSTEMMENUMODE = 8, GUI_POPUPMENUMODE = 0x10;

        // Is a menu of this window's thread open (menu bar, context or system menu)?
        static bool InMenu(IntPtr h)
        {
            uint pid;
            uint tid = GetWindowThreadProcessId(h, out pid);
            GUITHREADINFO g = new GUITHREADINFO();
            g.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
            return GetGUIThreadInfo(tid, ref g) && (g.flags & (GUI_INMENUMODE | GUI_SYSTEMMENUMODE | GUI_POPUPMENUMODE)) != 0;
        }

        // Win events: a top-level window was shown or hidden (EVENT_OBJECT_SHOW/HIDE, OBJID_WINDOW).
        delegate void WinEventProc(IntPtr hook, uint ev, IntPtr h, int obj, int child, uint thread, uint time);
        [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc fn, uint pid, uint thread, uint flags);
        static WinEventProc winEvent; // kept alive (the GC would collect it otherwise)
        static Action shown;
        static DateTime lastShown = DateTime.MinValue;

        // On the main (message-loop) thread. onShown is called at most every 30 ms.
        public static void Watch(Action onShown)
        {
            shown = onShown;
            winEvent = delegate (IntPtr hook, uint ev, IntPtr h, int obj, int child, uint thread, uint time)
            {
                if (obj != 0 || child != 0 || h == IntPtr.Zero || GetAncestor(h, GA_ROOT) != h) return;
                if ((DateTime.UtcNow - lastShown).TotalMilliseconds < 30) return;
                lastShown = DateTime.UtcNow;
                shown();
            };
            SetWinEventHook(0x8002, 0x8003, IntPtr.Zero, winEvent, 0, 0, 0); // WINEVENT_OUTOFCONTEXT
        }

        static string Text(IntPtr h, bool cls)
        {
            StringBuilder s = new StringBuilder(256);
            if (cls) GetClassName(h, s, s.Capacity); else GetWindowText(h, s, s.Capacity);
            return s.ToString();
        }

        static string WindowAumid(IntPtr h)
        {
            IPropertyStore store = null;
            try
            {
                Guid iid = typeof(IPropertyStore).GUID;
                if (SHGetPropertyStoreForWindow(h, ref iid, out store) != 0 || store == null) return "";
                PROPERTYKEY k = new PROPERTYKEY();
                k.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); // PKEY_AppUserModel_ID
                k.pid = 5;
                PROPVARIANT v;
                if (store.GetValue(ref k, out v) != 0) return "";
                string id = v.vt == 31 ? Marshal.PtrToStringUni(v.p) : ""; // VT_LPWSTR
                PropVariantClear(ref v);
                return id ?? "";
            }
            catch (Exception) { return ""; }
            finally { if (store != null) Marshal.ReleaseComObject(store); }
        }

        static void ProcessInfo(uint pid, out string exe, out string aumid)
        {
            exe = ""; aumid = "";
            IntPtr p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (p == IntPtr.Zero) return;
            try
            {
                StringBuilder s = new StringBuilder(1024);
                int n = s.Capacity;
                if (QueryFullProcessImageName(p, 0, s, ref n)) exe = s.ToString();
                StringBuilder a = new StringBuilder(256);
                int len = a.Capacity;
                if (GetApplicationUserModelId(p, ref len, a) == 0) aumid = a.ToString();
            }
            finally { CloseHandle(p); }
        }

        static Dictionary<uint, uint> Parents()
        {
            Dictionary<uint, uint> d = new Dictionary<uint, uint>();
            IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (snap == new IntPtr(-1)) return d;
            try
            {
                PROCESSENTRY32 e = new PROCESSENTRY32();
                e.dwSize = Marshal.SizeOf(typeof(PROCESSENTRY32));
                for (bool ok = Process32First(snap, ref e); ok; ok = Process32Next(snap, ref e)) d[e.th32ProcessID] = e.th32ParentProcessID;
            }
            finally { CloseHandle(snap); }
            return d;
        }

        static bool Frame(IntPtr h, out RECT r)
        {
            if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0) return true;
            return GetWindowRect(h, out r);
        }

        // [{wid, pid, ppid, exe, aumid, title, x, y, w, h, scale}] — visible, not minimized, not cloaked,
        // not tool windows, menus or the shell. Process details are cached per pid for this call.
        public static List<object> List()
        {
            List<object> list = new List<object>();
            Dictionary<uint, uint> parents = Parents();
            Dictionary<uint, string[]> procs = new Dictionary<uint, string[]>();
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                if (!IsWindowVisible(h) || IsIconic(h)) return true;
                int style = GetWindowLong(h, GWL_STYLE), ex = GetWindowLong(h, GWL_EXSTYLE);
                if ((style & WS_CHILD) != 0) return true;
                int cloaked;
                if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;
                string cls = Text(h, true);
                if (SkipClass.Contains(cls)) return true;
                IntPtr owner = GetAncestor(h, GA_ROOTOWNER);
                if (owner == h) owner = IntPtr.Zero;
                bool captioned = (style & WS_CAPTION) == WS_CAPTION;
                bool popup = MenuClass.Contains(cls) || (!captioned && (owner != IntPtr.Zero || (ex & WS_EX_TOOLWINDOW) != 0));
                if ((ex & WS_EX_TOOLWINDOW) != 0 && !popup && !captioned) return true;
                RECT r;
                if (!Frame(h, out r) || r.right - r.left < (popup ? 4 : 20) || r.bottom - r.top < (popup ? 4 : 20)) return true;
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                string[] pi;
                if (!procs.TryGetValue(pid, out pi))
                {
                    string exe, aumid;
                    ProcessInfo(pid, out exe, out aumid);
                    pi = procs[pid] = new string[] { exe, aumid };
                }
                uint ppid;
                parents.TryGetValue(pid, out ppid);
                string wa = WindowAumid(h);
                Dictionary<string, object> d = new Dictionary<string, object>();
                d["wid"] = h.ToInt64();
                d["pid"] = pid;
                d["ppid"] = ppid;
                d["exe"] = pi[0];
                d["aumid"] = wa.Length > 0 ? wa : pi[1];
                d["title"] = Text(h, false);
                d["popup"] = popup;
                d["owner"] = owner.ToInt64();
                d["x"] = r.left;
                d["y"] = r.top;
                d["w"] = r.right - r.left;
                d["h"] = r.bottom - r.top;
                uint dpi = 96;
                try { dpi = GetDpiForWindow(h); } catch (Exception) { }
                d["scale"] = Math.Round((dpi == 0 ? 96 : dpi) / 96.0, 2);
                list.Add(d);
                return true;
            }, IntPtr.Zero);
            return list;
        }

        static IntPtr Handle(double wid)
        {
            IntPtr h = new IntPtr((long)wid);
            if (!IsWindow(h)) throw new Exception("no such window");
            return h;
        }

        // Foreground, even from a background process: a tapped Alt (marked as ours) lifts the lock.
        public static void Raise(double wid)
        {
            IntPtr h = Handle(wid);
            if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
            IntPtr fg = GetForegroundWindow();
            if (fg == h) return;
            // A menu of that app is open: raising (Alt tap, foreground change) would close it.
            if (InMenu(h) || (fg != IntPtr.Zero && InMenu(fg))) return;
            // Already in that app (e.g. its menu is open): the Alt tap would close the menu.
            uint p1, p2;
            GetWindowThreadProcessId(h, out p1);
            GetWindowThreadProcessId(fg, out p2);
            if (fg != IntPtr.Zero && p1 == p2 && GetAncestor(fg, GA_ROOTOWNER) == GetAncestor(h, GA_ROOTOWNER)) return;
            keybd_event(VK_MENU, 0, 0, Native.MARK);
            keybd_event(VK_MENU, 0, 2, Native.MARK);
            BringWindowToTop(h);
            SetForegroundWindow(h);
        }

        public static void Close(double wid)
        {
            PostMessage(Handle(wid), WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        }

        // ---- moving a window to another computer (pcapps.js, Apps › Move windows) ----
        // The move key held (Right Ctrl unless another is chosen), a click on a window grabs it: the
        // click never reaches the app, and the window follows the pointer until the button is let go.
        // If the pointer crosses to another computer meanwhile, the window goes with it (the edge or
        // return event carries `moving`). Input injected from the other computer grabs the same way.

        const uint WM_CANCELMODE = 0x1F, SWP_NOSIZE = 1, SWP_ASYNCWINDOWPOS = 0x4000;

        [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Native.POINT p);
        [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
        [DllImport("user32.dll")] static extern IntPtr GetShellWindow();

        public static uint[] MoveVks = new uint[0]; // the move key's virtual keys; empty: moving is off
        public static string MoveKeyName = "";
        static IntPtr grab = IntPtr.Zero; // the window that follows the pointer
        static int grabDx, grabDy; // the pointer's place in it
        static int fromX, fromY; // its visible frame's top left when it was grabbed (where it goes back to)
        static bool grabUp; // the left button's release is swallowed (its press was)
        static readonly uint ownPid = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;

        public static bool Grabbing { get { return grab != IntPtr.Zero; } }
        public static bool GrabUpPending { get { return grabUp; } }

        static bool MoveKeyHeld()
        {
            foreach (uint vk in MoveVks) if ((Native.GetAsyncKeyState((int)vk) & 0x8000) != 0) return true;
            return false;
        }

        // The left button went down at x, y. True: a window was grabbed and the click is swallowed.
        public static bool TryGrab(int x, int y)
        {
            if (MoveVks.Length == 0 || grab != IntPtr.Zero || !MoveKeyHeld()) return false;
            IntPtr h = WindowFromPoint(new Native.POINT(x, y));
            if (h == IntPtr.Zero) return false;
            h = GetAncestor(h, GA_ROOT);
            if (h == IntPtr.Zero || h == GetShellWindow() || !IsWindowVisible(h)) return false;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid == ownPid) return false;
            StringBuilder cls = new StringBuilder(64);
            GetClassName(h, cls, 64);
            string c = cls.ToString();
            if (c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd" || c == "Progman" || c == "WorkerW" || c == "NotifyIconOverflowWindow") return false;
            if ((GetWindowLong(h, GWL_STYLE) & WS_CHILD) != 0) return false;
            RECT r;
            if (IsZoomed(h))
            {
                // A maximized window comes off the screen's size first; the pointer ends up on its title bar.
                ShowWindow(h, SW_RESTORE);
                GetWindowRect(h, out r);
                grabDx = (r.right - r.left) / 2;
                grabDy = 16;
            }
            else
            {
                GetWindowRect(h, out r);
                grabDx = x - r.left;
                grabDy = y - r.top;
            }
            RECT vis;
            if (!Frame(h, out vis)) vis = r;
            fromX = vis.left;
            fromY = vis.top;
            grab = h;
            grabUp = true;
            // A Windows key held for it (a Mac's Command): an unassigned key tapped now keeps its
            // release from opening Start.
            if ((Native.GetAsyncKeyState(0x5B) & 0x8000) != 0 || (Native.GetAsyncKeyState(0x5C) & 0x8000) != 0)
            {
                keybd_event(0xE8, 0, 0, Native.MARK);
                keybd_event(0xE8, 0, 2, Native.MARK);
            }
            SetForegroundWindow(h);
            GrabMove(x, y);
            return true;
        }

        // The pointer moved to x, y: the grabbed window follows (asynchronously: the hook never waits on the app).
        public static void GrabMove(int x, int y)
        {
            if (grab == IntPtr.Zero) return;
            if (!IsWindow(grab)) { grab = IntPtr.Zero; return; }
            SetWindowPos(grab, IntPtr.Zero, x - grabDx, y - grabDy, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
        }

        // The left button came up: the grab ends. True: the release is swallowed, as its press was.
        public static bool GrabUp()
        {
            bool was = grabUp;
            grab = IntPtr.Zero;
            grabUp = false;
            return was;
        }

        // The pointer crossed to another computer: a grabbed window goes in the event (main moves it),
        // and the grab ends. keepUp: the button is still down here (the home side, whose release comes
        // later and is swallowed); on the driven side the release never comes.
        public static void AddMoving(Dictionary<string, object> d, bool keepUp)
        {
            if (grab == IntPtr.Zero) return;
            d["moving"] = grab.ToInt64();
            d["fromX"] = fromX; // where it was grabbed: it comes back there, not to the edge it crossed at
            d["fromY"] = fromY;
            grab = IntPtr.Zero;
            if (!keepUp) grabUp = false;
        }

        // That drag ends where it is (a title-bar move loop leaves on WM_CANCELMODE).
        public static void EndMove(double wid)
        {
            PostMessage(Handle(wid), WM_CANCELMODE, IntPtr.Zero, IntPtr.Zero);
        }

        // Out of sight past every screen, still shown: a minimized window has no picture to send.
        public static void Park(double wid)
        {
            IntPtr h = Handle(wid);
            if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
            Rectangle vs = System.Windows.Forms.SystemInformation.VirtualScreen;
            SetWindowPos(h, IntPtr.Zero, vs.Right + 200, vs.Top + 40, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            // Some apps put themselves back on a screen: say so (the log shows which one).
            RECT r;
            if (GetWindowRect(h, out r) && r.left < vs.Right)
            {
                try { Console.Error.WriteLine("[move] window " + h.ToInt64() + " (" + Text(h, true) + ") stayed on a screen at " + r.left + "," + r.top); } catch (Exception) { }
            }
        }

        // Back with its visible frame's top left at x, y (physical px, as List gives them), in front.
        public static void Place(double wid, int x, int y)
        {
            IntPtr h = Handle(wid);
            RECT outer, vis;
            GetWindowRect(h, out outer);
            if (!Frame(h, out vis)) vis = outer;
            SetWindowPos(h, IntPtr.Zero, x - (vis.left - outer.left), y - (vis.top - outer.top), 0, 0, SWP_NOSIZE | SWP_NOZORDER);
            Raise(wid);
        }

        // w × h = the visible frame (as in List); the invisible resize borders are added back.
        public static void Resize(double wid, int w, int h)
        {
            IntPtr hw = Handle(wid);
            RECT outer, vis;
            GetWindowRect(hw, out outer);
            Frame(hw, out vis);
            int dw = (outer.right - outer.left) - (vis.right - vis.left), dh = (outer.bottom - outer.top) - (vis.bottom - vis.top);
            SetWindowPos(hw, IntPtr.Zero, 0, 0, Math.Max(100, w) + dw, Math.Max(60, h) + dh, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
        }

        // Physical screen point for x,y normalized over the window's picture (its visible frame).
        public static Point PointIn(double wid, double x, double y)
        {
            RECT r;
            Frame(Handle(wid), out r);
            x = Math.Min(1, Math.Max(0, x));
            y = Math.Min(1, Math.Max(0, y));
            return new Point((int)Math.Round(r.left + x * (r.right - r.left - 1)), (int)Math.Round(r.top + y * (r.bottom - r.top - 1)));
        }

        // ---- icons ----

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern int SHCreateItemFromParsingName(string path, IntPtr bind, ref Guid iid, out IShellItemImageFactory f);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
        [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
        [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr hbmp); }
        const int SIIGBF_BIGGERSIZEOK = 1, SIIGBF_ICONONLY = 4;

        // PNG data: URL of the item's icon at `size` px, or "".
        public static string Icon(string path, int size)
        {
            IShellItemImageFactory f = null;
            IntPtr hbmp = IntPtr.Zero;
            try
            {
                Guid iid = typeof(IShellItemImageFactory).GUID;
                if (SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out f) != 0 || f == null) return "";
                SIZE s = new SIZE();
                s.cx = s.cy = size;
                if (f.GetImage(s, SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK, out hbmp) != 0 || hbmp == IntPtr.Zero) return "";
                using (Bitmap raw = Image.FromHbitmap(hbmp))
                {
                    // FromHbitmap drops alpha: read the same bytes again as ARGB.
                    BitmapData data = raw.LockBits(new Rectangle(0, 0, raw.Width, raw.Height), ImageLockMode.ReadOnly, raw.PixelFormat);
                    try
                    {
                        using (Bitmap argb = new Bitmap(data.Width, data.Height, data.Stride, PixelFormat.Format32bppArgb, data.Scan0))
                        using (MemoryStream ms = new MemoryStream())
                        {
                            argb.Save(ms, ImageFormat.Png);
                            return "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
                        }
                    }
                    finally { raw.UnlockBits(data); }
                }
            }
            catch (Exception) { return ""; }
            finally
            {
                if (hbmp != IntPtr.Zero) DeleteObject(hbmp);
                if (f != null) Marshal.ReleaseComObject(f);
            }
        }
    }
}

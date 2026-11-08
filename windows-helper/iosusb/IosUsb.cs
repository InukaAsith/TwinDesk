// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// twindesk-iosusb.exe: an iPhone's or iPad's screen over its USB cable (shared/iosusb). Started only
// while wired mirroring is on, and gone after. It moves bytes and nothing else; the protocol
// (QuickTime's screen capture, as danielpaulus/quicktime_video_hack worked it out, MIT) is in
// shared/iosusb/qt.js.
//
// The phone is reached through libusb-win32's libusb0 as an upper filter on Apple's own USB driver
// (Apple Devices or iTunes): Apple's driver stays, the filter lets this program send control
// requests and use the screen-capture interface. shared/iosusb/host.js sets the filter up, once.
//
//   twindesk-iosusb status     → one JSON line: {lib, devices: [{id, name, filter}], usb: [{serial, qt}]}
//   twindesk-iosusb run [serial]
//     Turns on the phone's hidden screen-capture configuration (vendor request 0x52, index 2; the
//     phone comes back on the bus with one more configuration), picks it, claims the interface
//     (subclass 0x2a) and then:
//       stdout ← every byte the phone sends on its bulk IN endpoint, as it comes
//       stdin  → messages for the phone, each starting with its own u32 LE length (QuickTime's
//                framing), sent as one bulk OUT transfer each
//       stderr ← JSON lines: {"t":"ready",serial,name} | {"t":"error",why,detail}
//     At the end of stdin: the interface goes back, the configuration is turned off (index 0), the
//     usbmux one (subclass 0xfe) is picked again, and the phone is a normal iPhone again.
// C# 5 (the .NET Framework compiler): no string interpolation, no ?. .
using System;
using System.Collections.Generic;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

static class Usb0
{
    const string L = "libusb0.dll";
    [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr LoadLibrary(string path);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern void usb_init();
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_find_busses();
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_find_devices();
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr usb_get_busses();
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr usb_open(IntPtr dev);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_close(IntPtr h);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_control_msg(IntPtr h, int requesttype, int request, int value, int index, byte[] bytes, int size, int timeout);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_get_descriptor(IntPtr h, byte type, byte index, byte[] buf, int size);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_get_string_simple(IntPtr h, int index, byte[] buf, int buflen);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_set_configuration(IntPtr h, int configuration);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_claim_interface(IntPtr h, int iface);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_release_interface(IntPtr h, int iface);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_clear_halt(IntPtr h, uint ep);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_set_altinterface(IntPtr h, int alternate);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_bulk_write(IntPtr h, int ep, byte[] bytes, int size, int timeout);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_bulk_setup_async(IntPtr h, ref IntPtr context, byte ep);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_submit_async(IntPtr context, IntPtr bytes, int size);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_reap_async_nocancel(IntPtr context, int timeout);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_cancel_async(IntPtr context);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern int usb_free_async(ref IntPtr context);
    [DllImport(L, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr usb_strerror();

    public static string Err()
    {
        try { IntPtr p = usb_strerror(); return p == IntPtr.Zero ? "" : Marshal.PtrToStringAnsi(p); } catch (Exception) { return ""; }
    }
}

// A phone as libusb0 lists it: its struct usb_device (lusb0_usb.h, byte-packed: next, prev,
// filename[512], bus, then the device descriptor) and what its configurations hold.
class Dev
{
    public IntPtr Ptr;
    public ushort Vid, Pid;
    public byte SerialIndex, Configs;
    public string Serial = "";
    public int QtConfig = -1, QtIface = -1, EpIn = -1, EpOut = -1, Current = -1, MuxConfig = -1;
}

static class Program
{
    const int ETIMEDOUT = -116;
    static readonly int P = IntPtr.Size;

    static bool IsIos(ushort vid, ushort pid) { return vid == 0x05ac && pid >= 0x1290 && pid <= 0x12af; }

    static string Q(string s)
    {
        var b = new StringBuilder("\"");
        foreach (char c in s ?? "")
        {
            if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
            else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    static readonly object errLock = new object();
    // TWD_IOSUSB_DEBUG=1: each step, read and write on stderr.
    static readonly bool DEBUG = Environment.GetEnvironmentVariable("TWD_IOSUSB_DEBUG") == "1";
    static void Dbg(string text) { if (DEBUG) Say("{\"t\":\"debug\",\"text\":" + Q(text) + "}"); }
    static void Say(string json) { lock (errLock) { Console.Error.WriteLine(json); Console.Error.Flush(); } }
    static int Fail(string why, string detail)
    {
        Say("{\"t\":\"error\",\"why\":" + Q(why) + ",\"detail\":" + Q(detail) + "}");
        return 1;
    }

    // libusb0.dll from beside this program, the folder host.js unpacked it in (TWD_LIBUSB0), or System32.
    static bool LoadLib()
    {
        var tries = new List<string>();
        string env = Environment.GetEnvironmentVariable("TWD_LIBUSB0");
        if (!string.IsNullOrEmpty(env)) tries.Add(env);
        tries.Add(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "libusb0.dll"));
        tries.Add(Path.Combine(Environment.SystemDirectory, "libusb0.dll"));
        foreach (string p in tries)
        {
            if (File.Exists(p) && Usb0.LoadLibrary(p) != IntPtr.Zero)
            {
                try { Usb0.usb_init(); return true; } catch (Exception) { return false; }
            }
        }
        return false;
    }

    static List<Dev> Find()
    {
        var list = new List<Dev>();
        Usb0.usb_find_busses();
        Usb0.usb_find_devices();
        for (IntPtr bus = Usb0.usb_get_busses(); bus != IntPtr.Zero; bus = Marshal.ReadIntPtr(bus, 0))
        {
            for (IntPtr d = Marshal.ReadIntPtr(bus, 2 * P + 512); d != IntPtr.Zero; d = Marshal.ReadIntPtr(d, 0))
            {
                int o = 3 * P + 512; // the device descriptor
                var dev = new Dev
                {
                    Ptr = d,
                    Vid = (ushort)Marshal.ReadInt16(d, o + 8),
                    Pid = (ushort)Marshal.ReadInt16(d, o + 10),
                    SerialIndex = Marshal.ReadByte(d, o + 16),
                    Configs = Marshal.ReadByte(d, o + 17),
                };
                if (IsIos(dev.Vid, dev.Pid)) list.Add(dev);
            }
        }
        foreach (var dev in list) Inspect(dev);
        return list;
    }

    // Its serial, the configuration it's in, and where the screen-capture interface is, if it shows.
    static void Inspect(Dev dev)
    {
        IntPtr h = Usb0.usb_open(dev.Ptr);
        if (h == IntPtr.Zero) return;
        try
        {
            var sb = new byte[256];
            if (dev.SerialIndex > 0)
            {
                int n = Usb0.usb_get_string_simple(h, dev.SerialIndex, sb, sb.Length);
                if (n > 0) dev.Serial = Encoding.ASCII.GetString(sb, 0, n).TrimEnd('\0', ' ');
            }
            var one = new byte[1];
            if (Usb0.usb_control_msg(h, 0x80, 8, 0, 0, one, 1, 1000) == 1) dev.Current = one[0];
            for (int i = 0; i < dev.Configs; i++)
            {
                var head = new byte[9];
                if (Usb0.usb_get_descriptor(h, 2, (byte)i, head, 9) < 9) continue;
                int total = head[2] | (head[3] << 8);
                var all = new byte[Math.Max(total, 9)];
                int got = Usb0.usb_get_descriptor(h, 2, (byte)i, all, all.Length);
                if (got < 9) continue;
                Parse(dev, all, got);
            }
        }
        finally { Usb0.usb_close(h); }
    }

    static void Parse(Dev dev, byte[] b, int len)
    {
        int config = -1, iface = -1, epIn = -1, epOut = -1;
        bool qt = false, mux = false, anyQt = false;
        for (int p = 0; p + 2 <= len && b[p] >= 2; p += b[p])
        {
            int type = b[p + 1];
            if (type == 2 && p + 6 <= len) config = b[p + 5];
            else if (type == 4 && p + 8 <= len)
            {
                if (qt && epIn >= 0 && epOut >= 0) break;
                // As quicktime_video_hack (discovery.go): by subclass, 0x2a screen capture, 0xfe usbmux.
                qt = b[p + 6] == 0x2a;
                if (qt) anyQt = true;
                if (b[p + 6] == 0xfe) mux = true;
                iface = b[p + 2];
                epIn = epOut = -1;
            }
            else if (type == 5 && qt && p + 4 <= len && (b[p + 3] & 3) == 2)
            {
                if ((b[p + 2] & 0x80) != 0) epIn = b[p + 2]; else epOut = b[p + 2];
            }
        }
        if (mux && !anyQt && config >= 0) dev.MuxConfig = config;
        if (qt && epIn >= 0 && epOut >= 0)
        {
            dev.QtConfig = config;
            dev.QtIface = iface;
            dev.EpIn = epIn;
            dev.EpOut = epOut;
        }
    }

    // Apple's phones as Windows has them (also without the filter), and whether libusb0 is on each.
    static List<string[]> Present()
    {
        var list = new List<string[]>();
        try
        {
            using (var s = new ManagementObjectSearcher("SELECT DeviceID, Name FROM Win32_PnPEntity WHERE DeviceID LIKE 'USB\\\\VID_05AC&PID_12%'"))
            {
                foreach (ManagementObject m in s.Get())
                {
                    string id = Convert.ToString(m["DeviceID"]);
                    if (id.IndexOf("&MI_", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                    ushort pid;
                    int at = id.IndexOf("PID_", StringComparison.OrdinalIgnoreCase);
                    if (at < 0 || !ushort.TryParse(id.Substring(at + 4, 4), System.Globalization.NumberStyles.HexNumber, null, out pid) || !IsIos(0x05ac, pid)) continue;
                    bool filter = false;
                    try
                    {
                        using (var k = Registry.LocalMachine.OpenSubKey("SYSTEM\\CurrentControlSet\\Enum\\" + id))
                        {
                            var v = k == null ? null : k.GetValue("UpperFilters") as string[];
                            if (v != null) foreach (string f in v) if (string.Equals(f, "libusb0", StringComparison.OrdinalIgnoreCase)) filter = true;
                        }
                    }
                    catch (Exception) { }
                    list.Add(new[] { id, Convert.ToString(m["Name"]), filter ? "1" : "0" });
                }
            }
        }
        catch (Exception) { }
        return list;
    }

    static int Status()
    {
        bool lib = LoadLib();
        var b = new StringBuilder("{\"lib\":" + (lib ? "true" : "false") + ",\"devices\":[");
        bool first = true;
        foreach (var d in Present())
        {
            if (!first) b.Append(',');
            first = false;
            b.Append("{\"id\":").Append(Q(d[0])).Append(",\"name\":").Append(Q(d[1])).Append(",\"filter\":").Append(d[2] == "1" ? "true" : "false").Append('}');
        }
        b.Append("],\"usb\":[");
        if (lib)
        {
            first = true;
            foreach (var d in Find())
            {
                if (!first) b.Append(',');
                first = false;
                b.Append("{\"serial\":").Append(Q(d.Serial)).Append(",\"qt\":").Append(d.QtConfig >= 0 ? "true" : "false").Append('}');
            }
        }
        b.Append("]}");
        Console.Out.WriteLine(b.ToString());
        return 0;
    }

    // Each configuration's interfaces and endpoints, for diagnosing (twindesk-iosusb probe).
    static int Probe()
    {
        if (!LoadLib()) return Fail("nolib", "");
        foreach (var dev in Find())
        {
            Console.Out.WriteLine("device " + dev.Serial + " configs " + dev.Configs + " now " + dev.Current);
            IntPtr h = Usb0.usb_open(dev.Ptr);
            if (h == IntPtr.Zero) continue;
            for (int i = 0; i < dev.Configs; i++)
            {
                var all = new byte[4096];
                int got = Usb0.usb_get_descriptor(h, 2, (byte)i, all, all.Length);
                for (int p = 0; p + 2 <= got && all[p] >= 2; p += all[p])
                {
                    int t = all[p + 1];
                    if (t == 2) Console.Out.WriteLine(" config index " + i + " value " + all[p + 5] + " interfaces " + all[p + 4]);
                    else if (t == 4) Console.Out.WriteLine("  interface " + all[p + 2] + " alt " + all[p + 3] + " eps " + all[p + 4] + " class " + all[p + 5].ToString("x2") + "/" + all[p + 6].ToString("x2") + "/" + all[p + 7].ToString("x2"));
                    else if (t == 5) Console.Out.WriteLine("   endpoint 0x" + all[p + 2].ToString("x2") + " attr " + all[p + 3] + " max " + (all[p + 4] | (all[p + 5] << 8)));
                }
            }
            Usb0.usb_close(h);
        }
        return 0;
    }

    static Dev Pick(string serial)
    {
        foreach (var d in Find()) if (string.IsNullOrEmpty(serial) || d.Serial == serial) return d;
        return null;
    }

    static int Run(string serial)
    {
        if (!LoadLib()) return Fail("nolib", "libusb0.dll couldn't be loaded");
        Dev dev = Pick(serial);
        if (dev == null) return Fail(Present().Count > 0 ? "nofilter" : "nodevice", "");
        serial = dev.Serial;
        bool force = Environment.GetEnvironmentVariable("TWD_IOSUSB_FORCE") == "1";
        if (dev.QtConfig < 0 || force)
        {
            Dbg("enabling capture (had qt config " + dev.QtConfig + ")");
            // Turn on the screen-capture configuration: the phone drops off the bus and comes back.
            IntPtr h0 = Usb0.usb_open(dev.Ptr);
            if (h0 == IntPtr.Zero) return Fail("open", Usb0.Err());
            Usb0.usb_control_msg(h0, 0x40, 0x52, 0x00, 0x02, null, 0, 1000);
            Usb0.usb_close(h0);
            dev = null;
            if (force) Thread.Sleep(3000);
            for (int i = 0; i < 40 && (dev == null || dev.QtConfig < 0); i++)
            {
                Thread.Sleep(250);
                dev = Pick(serial);
            }
            if (dev == null || dev.QtConfig < 0) return Fail("noqt", "the phone didn't offer screen capture (is it unlocked and does it trust this computer?)");
        }
        IntPtr h = Usb0.usb_open(dev.Ptr);
        if (h == IntPtr.Zero) return Fail("open", Usb0.Err());
        Dbg("configs " + dev.Configs + ", now " + dev.Current + ", qt " + dev.QtConfig + " (interface " + dev.QtIface + ", in 0x" + dev.EpIn.ToString("x") + ", out 0x" + dev.EpOut.ToString("x") + "), usbmux " + dev.MuxConfig);
        // TWD_IOSUSB_MODE (testing): "trick" = in the usbmux configuration, interface 2's setting 1
        // (the same two endpoints) so Windows opens them, then the phone moved to screen capture with a
        // plain SET_CONFIGURATION; "alt" = setting 0 picked again after the claim.
        string mode = Environment.GetEnvironmentVariable("TWD_IOSUSB_MODE") ?? "";
        int r;
        if (mode == "trick")
        {
            int mux = dev.MuxConfig >= 0 ? dev.MuxConfig : 4;
            r = Usb0.usb_set_configuration(h, mux);
            Dbg("trick: set configuration " + mux + ": " + r);
            r = Usb0.usb_claim_interface(h, dev.QtIface);
            Dbg("trick: claim " + dev.QtIface + ": " + r);
            r = Usb0.usb_set_altinterface(h, 1);
            Dbg("trick: alt 1: " + r + " " + (r < 0 ? Usb0.Err() : ""));
            r = Usb0.usb_control_msg(h, 0x00, 9, dev.QtConfig, 0, null, 0, 1000);
            Dbg("trick: raw SET_CONFIGURATION " + dev.QtConfig + ": " + r);
            var c2 = new byte[1];
            Usb0.usb_control_msg(h, 0x80, 8, 0, 0, c2, 1, 1000);
            Dbg("trick: the phone says configuration " + c2[0]);
            Say("{\"t\":\"ready\",\"serial\":" + Q(serial) + "}");
            return Stream(h, dev);
        }
        // Always picked, as quicktime_video_hack does (usbadapter.go): the phone starts on it.
        r = Usb0.usb_set_configuration(h, dev.QtConfig);
        Dbg("set configuration " + dev.QtConfig + ": " + r + " " + (r < 0 ? Usb0.Err() : ""));
        var cur = new byte[1];
        int g = Usb0.usb_control_msg(h, 0x80, 8, 0, 0, cur, 1, 1000);
        Dbg("the phone says configuration " + (g == 1 ? cur[0].ToString() : "? (" + g + ")"));
        if (r < 0 && dev.Current != dev.QtConfig)
        {
            Usb0.usb_close(h);
            return Fail("config", r + " " + Usb0.Err());
        }
        if ((r = Usb0.usb_claim_interface(h, dev.QtIface)) < 0)
        {
            Usb0.usb_close(h);
            return Fail("claim", r + " " + Usb0.Err());
        }
        Dbg("claimed " + dev.QtIface);
        if (mode == "alt") { r = Usb0.usb_set_altinterface(h, 0); Dbg("alt 0: " + r + " " + (r < 0 ? Usb0.Err() : "")); }
        // No clear-halt here: on Windows, through Apple's driver, the working C++ port
        // (chotgpt/quicktime_video_hack_windows) leaves the endpoints as they are.
        Say("{\"t\":\"ready\",\"serial\":" + Q(serial) + "}");
        return Stream(h, dev);
    }

    static int Stream(IntPtr h, Dev dev)
    {
        int r;
        var stop = new ManualResetEvent(false);
        var reader = new Thread(() => Read(h, dev.EpIn, dev.EpOut, stop)) { IsBackground = true };
        reader.Start();
        Write(h, dev.EpOut, stop);
        stop.Set();
        reader.Join(3000);
        Usb0.usb_release_interface(h, dev.QtIface);
        // Screen capture off, and the usbmux configuration again (activator.go, usbadapter.go).
        r = Usb0.usb_control_msg(h, 0x40, 0x52, 0x00, 0x00, null, 0, 1000);
        Dbg("capture off: " + r + " " + (r < 0 ? Usb0.Err() : ""));
        int mux = dev.MuxConfig >= 0 ? dev.MuxConfig : 4;
        for (int i = 0; i < 3; i++)
        {
            r = Usb0.usb_set_configuration(h, mux);
            Dbg("set configuration " + mux + ": " + r);
            if (r >= 0) break;
            Thread.Sleep(200);
        }
        Usb0.usb_close(h);
        return 0;
    }

    // Three transfers in flight on the IN endpoint, reaped in order: what the phone sends, to stdout.
    // Bulk OUT from two threads (stdin's messages, Read's kick): one at a time.
    static readonly object outLock = new object();
    static int Out(IntPtr h, int ep, byte[] msg, int len)
    {
        lock (outLock) return Usb0.usb_bulk_write(h, ep, msg, len, 3000);
    }

    // A second with nothing from the phone: on Windows it can wait forever for the host. As the
    // C++ port does (QuickTime.cpp ReceiveLoop): vendor request 0x40 (0x6400, 0x6400), then a ping.
    static void Kick(IntPtr h, int epOut)
    {
        int c = Usb0.usb_control_msg(h, 0x40, 0x40, 0x6400, 0x6400, null, 0, 1000);
        var ping = new byte[] { 16, 0, 0, 0, 0x67, 0x6e, 0x69, 0x70, 0, 0, 0, 0, 1, 0, 0, 0 };
        int w = Out(h, epOut, ping, ping.Length);
        var cf = new byte[1];
        int g = Usb0.usb_control_msg(h, 0x80, 8, 0, 0, cf, 1, 1000);
        var alt = new byte[1];
        int ga = Usb0.usb_control_msg(h, 0x81, 10, 0, 2, alt, 1, 1000);
        var st = new byte[2];
        int gs = Usb0.usb_control_msg(h, 0x82, 0, 0, 0x86, st, 2, 1000);
        Dbg("kick: control " + c + ", ping " + w + ", config " + (g == 1 ? cf[0].ToString() : "?" + g) + ", alt " + (ga == 1 ? alt[0].ToString() : "?" + ga) + ", in-halt " + (gs == 2 ? st[0].ToString() : "?" + gs));
    }

    static void Read(IntPtr h, int ep, int epOut, ManualResetEvent stop)
    {
        const int N = 3, SIZE = 1 << 20;
        var ctx = new IntPtr[N];
        var buf = new IntPtr[N];
        var copy = new byte[SIZE];
        Stream o = Console.OpenStandardOutput();
        try
        {
            for (int i = 0; i < N; i++)
            {
                buf[i] = Marshal.AllocHGlobal(SIZE);
                if (Usb0.usb_bulk_setup_async(h, ref ctx[i], (byte)ep) < 0) { Fail("read", Usb0.Err()); return; }
                Usb0.usb_submit_async(ctx[i], buf[i], SIZE);
            }
            for (int i = 0; !stop.WaitOne(0); i = (i + 1) % N)
            {
                int n;
                int idle = 0;
                while ((n = Usb0.usb_reap_async_nocancel(ctx[i], 500)) == ETIMEDOUT)
                {
                    if (stop.WaitOne(0)) return;
                    if (++idle % 2 == 0) Kick(h, epOut);
                }
                if (n < 0) { Fail("read", n + " " + Usb0.Err()); return; }
                Dbg("read " + n);
                if (n > 0)
                {
                    Marshal.Copy(buf[i], copy, 0, n);
                    o.Write(copy, 0, n);
                    o.Flush();
                }
                Usb0.usb_submit_async(ctx[i], buf[i], SIZE);
            }
        }
        catch (IOException) { } // TwinDesk went away
        finally
        {
            stop.Set();
            for (int i = 0; i < N; i++)
            {
                if (ctx[i] != IntPtr.Zero) { Usb0.usb_cancel_async(ctx[i]); Usb0.usb_free_async(ref ctx[i]); }
                if (buf[i] != IntPtr.Zero) Marshal.FreeHGlobal(buf[i]);
            }
            // The phone or the cable went: the host hears it from the end of stdout.
            try { o.Close(); } catch (Exception) { }
        }
    }

    // stdin: one message at a time, each its own length first, each one bulk OUT transfer.
    static void Write(IntPtr h, int ep, ManualResetEvent stop)
    {
        Stream i = Console.OpenStandardInput();
        var head = new byte[4];
        while (!stop.WaitOne(0))
        {
            if (!Fill(i, head, 0, 4)) return;
            int len = head[0] | (head[1] << 8) | (head[2] << 16) | (head[3] << 24);
            if (len < 4 || len > (16 << 20)) return;
            var msg = new byte[len];
            Buffer.BlockCopy(head, 0, msg, 0, 4);
            if (!Fill(i, msg, 4, len - 4)) return;
            int r = Out(h, ep, msg, len);
            Dbg("write " + len + ": " + r);
            if (r < 0) { Fail("write", r + " " + Usb0.Err()); return; }
        }
    }

    static bool Fill(Stream s, byte[] b, int at, int n)
    {
        while (n > 0)
        {
            int got;
            try { got = s.Read(b, at, n); } catch (IOException) { return false; }
            if (got <= 0) return false;
            at += got;
            n -= got;
        }
        return true;
    }

    static int Main(string[] args)
    {
        try
        {
            string cmd = args.Length > 0 ? args[0] : "status";
            if (cmd == "status") return Status();
            if (cmd == "run") return Run(args.Length > 1 ? args[1] : "");
            if (cmd == "probe") return Probe();
            if (cmd == "on" || cmd == "off")
            {
                if (!LoadLib()) return Fail("nolib", "");
                Dev d = Pick(args.Length > 1 ? args[1] : "");
                if (d == null) return Fail("nodevice", "");
                IntPtr h0 = Usb0.usb_open(d.Ptr);
                if (h0 == IntPtr.Zero) return Fail("open", Usb0.Err());
                int rc = Usb0.usb_control_msg(h0, 0x40, 0x52, 0x00, cmd == "on" ? 2 : 0, null, 0, 1000);
                Usb0.usb_close(h0);
                Console.Out.WriteLine("{\"ok\":" + (rc >= 0 ? "true" : "false") + ",\"qt\":" + (d.QtConfig >= 0 ? "true" : "false") + "}");
                return rc >= 0 ? 0 : 1;
            }
            return Fail("usage", "twindesk-iosusb status | run [serial]");
        }
        catch (DllNotFoundException e) { return Fail("nolib", e.Message); }
        catch (Exception e) { return Fail("crash", e.ToString()); }
    }
}

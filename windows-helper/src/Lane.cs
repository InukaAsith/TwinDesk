// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The input lane in the helper (native/tdfast's tdfast.dll, docs/protocol.md), as mac-helper's
// Lane.swift: Node out of the move path on both ends. Driving: the hook's moves go straight onto the
// lane (td_move) and nothing is written to stdout; clicks, keys, wheel and gestures carry their event
// number and fence for Node. Driven: the lane's moves are injected here (deduplicated, speed applied,
// after the event they wait for); its events go to Node as {"event":"laneEv"} and come back as
// `inject` in order. Command `lane {op: bind | start | stop | active | route | event | driven | hold |
// fence | done}`. Without tdfast.dll next to the .exe, `lane` fails (DllNotFoundException) and Node
// keeps its own lane (shared/inputlane.js), which speaks the same wire.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace MacShare
{
    static class Lane
    {
        const int TD_MOVE = 1, TD_EVENT = 2, TD_UP = 3, TD_DOWN = 4;

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate void Callback(IntPtr ctx, int kind, double dx, double dy, IntPtr json, UIntPtr len);

        [DllImport("tdfast.dll", CallingConvention = CallingConvention.Cdecl)] static extern ushort td_bind();
        [DllImport("tdfast.dll", CallingConvention = CallingConvention.Cdecl)]
        static extern int td_start(int role, [MarshalAs(UnmanagedType.LPStr)] string keyHex, [MarshalAs(UnmanagedType.LPStr)] string ip, ushort port, Callback cb, IntPtr ctx);
        [DllImport("tdfast.dll", CallingConvention = CallingConvention.Cdecl)] static extern void td_stop();
        [DllImport("tdfast.dll", CallingConvention = CallingConvention.Cdecl)] static extern void td_active(int on);
        [DllImport("tdfast.dll", CallingConvention = CallingConvention.Cdecl)] static extern void td_drive_reset(uint route);
        [DllImport("tdfast.dll", CallingConvention = CallingConvention.Cdecl)] static extern int td_move(double dx, double dy, out uint route, out uint mn, out double cx, out double cy);
        [DllImport("tdfast.dll", CallingConvention = CallingConvention.Cdecl)] static extern uint td_fence(out uint route, out uint mn, out double cx, out double cy);
        [DllImport("tdfast.dll", CallingConvention = CallingConvention.Cdecl)] static extern void td_send_event(byte[] json, UIntPtr len, uint es);
        [DllImport("tdfast.dll", CallingConvention = CallingConvention.Cdecl)] static extern void td_driven(uint route, double speed);
        [DllImport("tdfast.dll", CallingConvention = CallingConvention.Cdecl)] static extern void td_hold(int on);
        [DllImport("tdfast.dll", CallingConvention = CallingConvention.Cdecl)] static extern int td_fence_apply(uint route, uint mn, double cx, double cy, out double dx, out double dy);
        [DllImport("tdfast.dll", CallingConvention = CallingConvention.Cdecl)] static extern void td_done(uint es);

        static readonly Callback callback = OnLane; // kept alive: the lane's thread calls it
        static readonly JavaScriptSerializer json = new JavaScriptSerializer();
        static readonly HashSet<string> fenced = new HashSet<string> { "k.md", "k.mu", "k.wh", "k.kd", "k.ku", "k.ge" };
        static Action<double, double> inject;
        static Action<Dictionary<string, object>> emit;
        static volatile bool driving;
        static bool started, loaded;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibraryW(string path);

        // On the UI thread, before Application.Run: the window that receives the lane's moves is its.
        public static void Init(Action<double, double> move, Action<Dictionary<string, object>> emitter)
        {
            inject = move;
            emit = emitter;
            sink = new Sink();
            if (Environment.GetEnvironmentVariable("TWINDESK_NO_TDFAST") != null) return;
            // bin\<arch>\tdfast.dll, loaded by its path: the DllImports below then find it by name.
            // PROCESSOR_ARCHITECTURE is this process's (AnyCPU: ARM64 on Windows on ARM).
            string arch = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") == "ARM64" ? "arm64" : "x64";
            loaded = LoadLibraryW(Path.Combine(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, arch), "tdfast.dll")) != IntPtr.Zero;
        }

        static uint U32(Dictionary<string, object> c, string k)
        {
            double v = Math.Round(Json.Num(c, k, 0));
            return v <= 0 ? 0 : v >= uint.MaxValue ? uint.MaxValue : (uint)v;
        }

        // On the UI thread. Reply fields go into c (Program copies "port").
        public static void Handle(Dictionary<string, object> c)
        {
            string op = Json.Str(c, "op", "");
            if (!loaded) throw new Exception("no tdfast.dll"); // Node keeps its own lane
            switch (op)
            {
                case "bind":
                    ushort port = td_bind();
                    if (port == 0) throw new Exception("no lane socket");
                    c["port"] = (int)port;
                    break;
                case "start":
                    string key = Json.Str(c, "key", null), ip = Json.Str(c, "ip", null);
                    if (key == null || ip == null) throw new Exception("bad lane start");
                    int role = Json.Str(c, "role", "") == "host" ? 0 : 1;
                    double p = Json.Num(c, "port", 0);
                    started = td_start(role, key, ip, (ushort)(p > 0 && p < 65536 ? p : 0), callback, IntPtr.Zero) == 1;
                    driving = false;
                    if (!started) throw new Exception("lane start failed");
                    break;
                case "stop": td_stop(); started = false; driving = false; break;
                case "active": td_active(Json.Bool(c, "on", false) ? 1 : 0); break;
                case "route":
                    uint r = U32(c, "route");
                    td_drive_reset(r);
                    driving = started && r != 0;
                    break;
                case "event":
                    string text = Json.Str(c, "json", null); // Node sends the event as JSON text for us
                    if (text == null) break;
                    byte[] b = Encoding.UTF8.GetBytes(text);
                    td_send_event(b, (UIntPtr)b.Length, U32(c, "es"));
                    break;
                case "driven": td_driven(U32(c, "route"), Json.Num(c, "speed", 1)); break;
                case "hold": td_hold(Json.Bool(c, "on", false) ? 1 : 0); break;
                case "fence":
                    double fx, fy;
                    if (td_fence_apply(U32(c, "route"), U32(c, "mn"), Json.Num(c, "cx", 0), Json.Num(c, "cy", 0), out fx, out fy) == 1) inject(fx, fy);
                    break;
                case "done": td_done(U32(c, "es")); break;
                default: throw new Exception("unknown lane op " + op);
            }
        }

        // A move from the hook while capturing, before anything is built for it: 1 when it went on the
        // lane (write nothing), 0 when the lane is down (route/mn/cx/cy are its totals: Totals), -1 when
        // this side isn't driving on the lane (the move goes as before).
        public static int Move(double dx, double dy, out uint route, out uint mn, out double cx, out double cy)
        {
            route = mn = 0;
            cx = cy = 0;
            if (!driving) return -1;
            try { return td_move(dx, dy, out route, out mn, out cx, out cy) == 1 ? 1 : 0; }
            catch (Exception) { driving = false; return -1; }
        }

        public static void Totals(Dictionary<string, object> k, uint route, uint mn, double cx, double cy)
        {
            k["route"] = (double)route;
            k["mn"] = (double)mn;
            k["mc"] = new double[] { cx, cy };
        }

        // A click, key, wheel or gesture: numbered, with where the moves before it took the pointer.
        public static void Fence(Dictionary<string, object> k)
        {
            object t;
            if (!driving || !k.TryGetValue("t", out t) || !fenced.Contains(t as string ?? "")) return;
            uint r, mn;
            double cx, cy;
            uint es;
            try { es = td_fence(out r, out mn, out cx, out cy); }
            catch (Exception) { return; }
            if (es == 0) return;
            k["es"] = (double)es;
            k["route"] = (double)r;
            k["mn"] = (double)mn;
            k["mc"] = new double[] { cx, cy };
        }

        // The lane's thread: moves are injected on the UI thread, in order with stdin's `inject` and `fence`.
        static void OnLane(IntPtr ctx, int kind, double dx, double dy, IntPtr ptr, UIntPtr len)
        {
            try
            {
                switch (kind)
                {
                    case TD_MOVE:
                        Queue(dx, dy);
                        break;
                    case TD_EVENT:
                        int n = (int)len.ToUInt32();
                        if (ptr == IntPtr.Zero || n <= 0 || n > 4096) return;
                        byte[] b = new byte[n];
                        Marshal.Copy(ptr, b, 0, n);
                        Dictionary<string, object> msg = json.DeserializeObject(Encoding.UTF8.GetString(b)) as Dictionary<string, object>;
                        if (msg == null) return;
                        Dictionary<string, object> ev = new Dictionary<string, object>();
                        ev["event"] = "laneEv";
                        ev["msg"] = msg;
                        emit(ev);
                        break;
                    case TD_UP:
                        Dictionary<string, object> up = new Dictionary<string, object>();
                        up["event"] = "lane"; up["up"] = true; up["rtt"] = dx;
                        emit(up);
                        break;
                    case TD_DOWN:
                        Dictionary<string, object> down = new Dictionary<string, object>();
                        down["event"] = "lane"; down["up"] = false;
                        emit(down);
                        break;
                }
            }
            catch (Exception) { /* never throw into the lane's thread */ }
        }

        // The lane's moves to the UI thread without allocating: a fixed ring, and one posted message
        // to a message-only window per batch (not a delegate per move, as BeginInvoke would be).
        const int RING = 1024;
        const uint WM_LANE = 0x8000 + 0x4C; // WM_APP + 'L'
        static readonly double[] ring = new double[RING * 2];
        static readonly object ringGate = new object();
        static int head, tail, posted;
        static Sink sink;
        static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);

        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

        class Sink : NativeWindow
        {
            public Sink()
            {
                CreateParams cp = new CreateParams();
                cp.Parent = HWND_MESSAGE;
                CreateHandle(cp);
            }
            protected override void WndProc(ref Message m)
            {
                if (m.Msg == (int)WM_LANE) { Drain(); return; }
                base.WndProc(ref m);
            }
        }

        static void Queue(double dx, double dy)
        {
            lock (ringGate)
            {
                if (head - tail < RING)
                {
                    int i = (head % RING) * 2;
                    ring[i] = dx;
                    ring[i + 1] = dy;
                    head++;
                }
                else // full (the UI thread is stuck): add to the newest, nothing is lost
                {
                    int i = ((head - 1) % RING) * 2;
                    ring[i] += dx;
                    ring[i + 1] += dy;
                }
            }
            if (sink != null && Interlocked.Exchange(ref posted, 1) == 0) PostMessage(sink.Handle, WM_LANE, IntPtr.Zero, IntPtr.Zero);
        }

        static void Drain()
        {
            Interlocked.Exchange(ref posted, 0); // a move from now on posts again
            for (;;)
            {
                double dx, dy;
                lock (ringGate)
                {
                    if (tail == head) return;
                    int i = (tail % RING) * 2;
                    dx = ring[i];
                    dy = ring[i + 1];
                    tail++;
                }
                inject(dx, dy);
            }
        }
    }
}

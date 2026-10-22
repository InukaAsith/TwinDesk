// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// macshare-winhelper: JSON lines on stdin (commands) / stdout (replies and events),
// "Helper interface". The main thread runs the WinForms message loop (hooks and raw input need
// it); a reader thread hands each line to it; one writer thread does all stdout I/O.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// The name Windows shows for this process: Location's prompt and its list of apps, Task Manager.
[assembly: AssemblyTitle("TwinDesk")]
[assembly: AssemblyProduct("TwinDesk")]

namespace MacShare
{
    static class Program
    {
        static readonly BlockingCollection<string> outbox = new BlockingCollection<string>();
        static Control invoker;
        static Capture capture;
        static Injector injector;
        static DropEdge dropEdge;
        static DragSession drag; // the drag from the Mac on this PC

        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length == 3 && args[0] == "--add-root-device") return Display.AddRootDevice(args[1], args[2]); // elevated, scripts\vdd-install.ps1
            // Per-monitor v2: every coordinate is in physical pixels.
            try { if (!Native.SetProcessDpiAwarenessContext(new IntPtr(-4))) Native.SetProcessDPIAware(); }
            catch (Exception) { Native.SetProcessDPIAware(); }
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);

            invoker = new Control();
            invoker.CreateControl();
            IntPtr force = invoker.Handle; // the handle must exist before BeginInvoke from other threads

            Native.NoThrottling(); // edge pushes and hooks keep their pace with the window hidden in the tray
            AppDomain.CurrentDomain.UnhandledException += delegate { HideCursor.Restore(); };
            capture = new Capture(Emit);
            injector = new Injector();
            injector.Moved = capture.FeedReturn;
            HideCursor.Restore(); // in case a crash left the cursors blank
            capture.Start();
            capture.Flash = new Flash();
            AppWindows.Watch(delegate { Dictionary<string, object> e = new Dictionary<string, object>(); e["event"] = "winShown"; Emit(e); }); // Menus
            dropEdge = new DropEdge(capture, Emit);
            Notifs.Emit = Emit; // // file drags across the edge (shown only while dragging)

            Thread writer = new Thread(WriteLoop);
            writer.IsBackground = true;
            writer.Start();
            Thread reader = new Thread(ReadLoop);
            reader.IsBackground = true;
            reader.Start();

            Dictionary<string, object> ready = new Dictionary<string, object>();
            ready["event"] = "ready";
            Emit(ready);
            Application.Run(new ApplicationContext());
            return 0;
        }

        public static void Emit(Dictionary<string, object> d)
        {
            outbox.Add(Json.Write(d));
        }

        static void WriteLoop()
        {
            foreach (string line in outbox.GetConsumingEnumerable())
            {
                Console.Out.Write(line + "\n");
                Console.Out.Flush();
            }
        }

        static void ReadLoop()
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                string l = line;
                if (l.Trim().Length == 0) continue;
                if (Net.Handle(l)) continue; // Bluetooth / Wi-Fi Direct: on this thread (Net.cs)
                invoker.BeginInvoke((MethodInvoker)delegate { Dispatch(l); });
            }
            // stdin closed: main is gone. Give the user their input back and exit.
            Net.Shutdown();
            invoker.BeginInvoke((MethodInvoker)delegate
            {
                capture.Shutdown();
                injector.ReleaseAll();
                Application.Exit();
            });
        }

        // Slow commands (shell, COM, many processes) run on their own thread so the hooks on the
        // main thread never wait; the reply is emitted from there.
        delegate void Work(Dictionary<string, object> reply);
        static void Async(Dictionary<string, object> c, Work work, bool sta = false)
        {
            Thread t = new Thread(delegate ()
            {
                Dictionary<string, object> reply = new Dictionary<string, object>();
                if (Json.Has(c, "id")) reply["id"] = c["id"];
                try { work(reply); reply["ok"] = true; }
                catch (Exception e) { reply["ok"] = false; reply["error"] = e.Message; }
                if (Json.Has(c, "id")) Emit(reply);
            });
            t.IsBackground = true;
            t.SetApartmentState(sta ? ApartmentState.STA : ApartmentState.MTA); // STA: the clipboard and Shell.Application
            t.Start();
        }

        static List<string> Strings(Dictionary<string, object> c, string key)
        {
            List<string> list = new List<string>();
            System.Collections.IList l = c.ContainsKey(key) ? c[key] as System.Collections.IList : null;
            if (l != null) foreach (object o in l) if (o != null) list.Add(Convert.ToString(o));
            return list;
        }

        // Hotkey name → virtual keys (low-level hooks see left and right apart): "AltRight",
        // "AltLeft", or "Alt" = either one; same for Control, Shift and Meta (the Windows key).
        static HashSet<uint> HotkeyVks(string code)
        {
            uint left, right;
            string kind = code.Replace("Left", "").Replace("Right", "");
            switch (kind)
            {
                case "Control": left = 0xA2; right = 0xA3; break;
                case "Shift": left = 0xA0; right = 0xA1; break;
                case "Meta": left = 0x5B; right = 0x5C; break;
                default: left = 0xA4; right = 0xA5; break; // Alt
            }
            HashSet<uint> vks = new HashSet<uint>();
            if (!code.EndsWith("Left")) vks.Add(right);
            if (!code.EndsWith("Right")) vks.Add(left);
            return vks;
        }

        static void Dispatch(string line)
        {
            Dictionary<string, object> c;
            try { c = Json.Parse(line); }
            catch (Exception) { return; }
            if (c == null) return;
            capture.Touch(); // any command resets the dead-man timer
            string cmd = Json.Str(c, "cmd", "");
            string error = null;
            try
            {
                switch (cmd)
                {
                    case "ping": case "keepalive": break;
                    case "kvmConfig":
                        // sides: every side that leads to a connected device; without it, the one side (older app).
                        List<string> sides = Json.Strs(c, "sides");
                        if (sides == null)
                        {
                            sides = new List<string>();
                            string one = Json.Str(c, "side", null);
                            if (one != null) sides.Add(one);
                        }
                        capture.SetSides(sides);
                        capture.ResistancePx = Json.Num(c, "resistancePx", 120);
                        capture.HotkeyVks = HotkeyVks(Json.Str(c, "hotkey", "AltRight"));
                        capture.DriveOther = Json.Bool(c, "driveOther", false);
                        capture.EdgeKeyboard = Json.Bool(c, "keyboard", true);
                        capture.DragFiles = Json.Bool(c, "dragFiles", true);
                        capture.DeadmanMs = (int)Json.Num(c, "deadmanMs", 1500);
                        capture.DoubleTapMs = (int)Json.Num(c, "doubleTapMs", 400);
                        capture.Gestures = Json.Bool(c, "gestures", true);
                        break;
                    case "capture":
                        if (Json.Bool(c, "on", false)) capture.Begin(Json.Bool(c, "mouse", true), Json.Bool(c, "keyboard", true));
                        else capture.Stop(Json.Has(c, "offset") ? Json.Str(c, "side", null) : null, Json.Num(c, "offset", 0));
                        break;
                    case "place":
                        bool center = Json.Bool(c, "center", false);
                        Point p = center ? Screens.Center() : Screens.EdgePoint(Json.Str(c, "side", "left"), Json.Num(c, "offset", 0.5));
                        Native.SetCursorPos(p.X, p.Y);
                        capture.Flash.Play(p, center ? null : Json.Str(c, "side", "left"), false); // the Mac arrives here
                        break;
                    case "armReturn":
                        // sides: every side with a device behind it; without it, the one side (older app).
                        List<string> retSides = Json.Strs(c, "sides");
                        if (retSides == null)
                        {
                            retSides = new List<string>();
                            string oneSide = Json.Str(c, "side", null);
                            if (oneSide != null) retSides.Add(oneSide);
                        }
                        capture.ArmReturn(Json.Bool(c, "on", false), retSides, Json.Num(c, "resistancePx", 120));
                        break;
                    case "inject":
                        Dictionary<string, object> ev = Json.Obj(c, "ev");
                        if (ev != null) injector.Apply(ev);
                        break;
                    case "releaseAll": injector.ReleaseAll(); break;
                    case "toastProgress": // a live toast with a progress bar (Toast.cs)
                        Toast.Progress(Json.Str(c, "aumid", ""), Json.Str(c, "tag", "files"), Json.Str(c, "title", ""), Json.Str(c, "status", ""), Json.Num(c, "value", -1), Json.Str(c, "label", ""));
                        break;
                    case "toastDone":
                        Toast.Done(Json.Str(c, "aumid", ""), Json.Str(c, "tag", "files"), Json.Str(c, "title", ""), Json.Str(c, "text", ""));
                        break;
                    case "moveTo": Injector.MoveTo((int)Json.Num(c, "x", 0), (int)Json.Num(c, "y", 0)); break; // The Mac's pointer on this PC's screen
                    case "displays": c["displays"] = Display.List(); break;
                    case "displayExtend": c["changed"] = Display.ExtendIfDuplicated(Json.Str(c, "monitor", "")); break;
                    // PC apps on the Mac
                    case "windows": Async(c, delegate (Dictionary<string, object> r) { r["windows"] = AppWindows.List(); }); return;
                    case "icons":
                        System.Collections.IList paths = c.ContainsKey("paths") ? c["paths"] as System.Collections.IList : null;
                        int size = (int)Json.Num(c, "size", 256);
                        Async(c, delegate (Dictionary<string, object> r)
                        {
                            List<string> icons = new List<string>();
                            if (paths != null) foreach (object o in paths) icons.Add(AppWindows.Icon(Convert.ToString(o), size));
                            r["icons"] = icons;
                        });
                        return;
                    // drag across the edge: a native drag of virtual files
                    case "dragStart":
                        if (drag != null) drag.CancelRequested = true;
                        drag = new DragSession();
                        drag.Id = Json.Str(c, "drag", "");
                        drag.Emit = Emit;
                        drag.Entries = new List<DragEntry>();
                        System.Collections.IList ents = c.ContainsKey("entries") ? c["entries"] as System.Collections.IList : null;
                        if (ents != null) foreach (object o in ents)
                        {
                            Dictionary<string, object> e = o as Dictionary<string, object>;
                            if (e == null) continue;
                            DragEntry de = new DragEntry();
                            de.Rel = Json.Str(e, "rel", "file").Replace('/', '\\');
                            de.Dir = Json.Bool(e, "dir", false);
                            de.Size = (long)Json.Num(e, "size", 0);
                            de.Temp = Json.Str(e, "temp", "");
                            drag.Entries.Add(de);
                        }
                        List<string> dnames = new List<string>();
                        System.Collections.IList nl = c.ContainsKey("names") ? c["names"] as System.Collections.IList : null;
                        if (nl != null) foreach (object o in nl) dnames.Add(Convert.ToString(o));
                        string into = Json.Str(c, "into", ""); // Paste = drop onto this folder
                        if (into != "") drag.DropDir = into;
                        drag.Start(dnames);
                        break;
                    case "dragFile":
                        if (drag != null && drag.Id == Json.Str(c, "drag", ""))
                        {
                            int di = (int)Json.Num(c, "index", -1);
                            if (di >= 0 && di < drag.Entries.Count) drag.Entries[di].State = Json.Str(c, "state", "") == "ok" ? 1 : -1;
                        }
                        break;
                    case "dragDrop": if (drag != null && drag.Id == Json.Str(c, "drag", "")) drag.DropRequested = true; break;
                    case "dragCancel":
                        if (drag != null && drag.Id == Json.Str(c, "drag", ""))
                        {
                            drag.CancelRequested = true;
                            Native2.Nudge(); // a 0-px move, so the drag loop asks again right away
                        }
                        break;
                    case "winRaise": AppWindows.Raise(Json.Num(c, "wid", 0)); break;
                    case "winClose": AppWindows.Close(Json.Num(c, "wid", 0)); break;
                    case "winSize": AppWindows.Resize(Json.Num(c, "wid", 0), (int)Json.Num(c, "w", 0), (int)Json.Num(c, "h", 0)); break;
                    case "winMove":
                        Point wp = AppWindows.PointIn(Json.Num(c, "wid", 0), Json.Num(c, "x", 0), Json.Num(c, "y", 0));
                        Injector.MoveTo(wp.X, wp.Y);
                        break;
                    case "displayMode":
                        c["changed"] = Display.SetMode(Json.Str(c, "name", ""), (int)Json.Num(c, "width", 0), (int)Json.Num(c, "height", 0));
                        break;
                    case "folderAt":
                        string folder; bool desktop;
                        Shell.FolderAt(out folder, out desktop);
                        c["path"] = folder;
                        c["desktop"] = desktop;
                        break;
                    // Notifications, copy/paste files
                    case "notifWatch":
                        bool nOn = Json.Bool(c, "on", false);
                        List<string> selfIds = Strings(c, "self");
                        Async(c, delegate (Dictionary<string, object> r) { r["readable"] = Notifs.Watch(nOn, selfIds); });
                        return;
                    case "fileSource": // the Explorer selection in front, else the files on the clipboard
                        Async(c, delegate (Dictionary<string, object> r)
                        {
                            bool front;
                            List<string> sel = new List<string>();
                            try { sel = Shell.FrontSelection(out front); } catch (Exception) { front = false; }
                            List<string> clip = new List<string>();
                            if (Clipboard.ContainsFileDropList()) foreach (string f in Clipboard.GetFileDropList()) clip.Add(f);
                            r["explorer"] = front;
                            r["selection"] = sel;
                            r["files"] = clip;
                        }, true);
                        return;
                    case "frontFolder":
                        Async(c, delegate (Dictionary<string, object> r)
                        {
                            string ff = null;
                            try { ff = Shell.FrontFolder(); } catch (Exception) { }
                            r["path"] = ff;
                        }, true);
                        return;
                    case "selectItems":
                        string selDir = Json.Str(c, "dir", "");
                        List<string> selNames = Strings(c, "names");
                        Async(c, delegate (Dictionary<string, object> r) { Shell.SelectIn(selDir, selNames); }, true);
                        return;
                    case "info":
                        Native.POINT cur;
                        Native.GetCursorPos(out cur);
                        c["cursor"] = new int[] { cur.x, cur.y };
                        c["capturing"] = capture.Capturing;
                        break;
                    default: error = "unknown command"; break;
                }
            }
            catch (Exception e) { error = e.Message; }

            if (!Json.Has(c, "id")) return;
            Dictionary<string, object> reply = new Dictionary<string, object>();
            reply["id"] = c["id"];
            reply["ok"] = error == null;
            if (error != null) reply["error"] = error;
            if (cmd == "info") { reply["cursor"] = c["cursor"]; reply["capturing"] = c["capturing"]; }
            if (cmd == "displays") reply["displays"] = c["displays"];
            if ((cmd == "displayMode" || cmd == "displayExtend") && error == null) reply["changed"] = c["changed"];
            if (cmd == "folderAt") { reply["path"] = c["path"]; reply["desktop"] = c["desktop"]; }
            Emit(reply);
        }
    }
}

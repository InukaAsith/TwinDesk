// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// macshare-winhelper: JSON lines on stdin (commands) / stdout (replies and events),
// "Helper interface". The main thread runs the WinForms message loop (hooks and raw input need
// it); a reader thread hands each line to it; one writer thread does all stdout I/O.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
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
        static Stylus stylus; // a phone's stylus (Stylus.cs)
        static Smoother smoother; // the phone Remote's moves, eased out (k.mm with smooth)
        static ClipWatch clipWatch; // "clipboard" events: something was copied (ClipWatch.cs)
        static DropEdge dropEdge;
        static DragSession drag; // the drag from the Mac on this PC

        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length == 3 && args[0] == "--add-root-device") return Display.AddRootDevice(args[1], args[2]); // elevated, scripts\vdd-install.ps1
            if (args.Length == 2 && args[0] == "--cursor-guard") return CursorGuard(args[1]);
            // Per-monitor v2: every coordinate is in physical pixels.
            try { if (!Native.SetProcessDpiAwarenessContext(new IntPtr(-4))) Native.SetProcessDPIAware(); }
            catch (Exception) { Native.SetProcessDPIAware(); }
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            // The mouse hook and the lane's injection run managed code: no blocking full collections
            // (background ones only), so a collection doesn't hold a move or a click.
            try { System.Runtime.GCSettings.LatencyMode = System.Runtime.GCLatencyMode.SustainedLowLatency; } catch (Exception) { }

            invoker = new Control();
            invoker.CreateControl();
            IntPtr force = invoker.Handle; // the handle must exist before BeginInvoke from other threads

            Native.NoThrottling(); // edge pushes and hooks keep their pace with the window hidden in the tray
            AppDomain.CurrentDomain.UnhandledException += delegate { HideCursor.Restore(); };
            capture = new Capture(Emit);
            injector = new Injector();
            stylus = new Stylus(injector);
            injector.Moved = capture.FeedReturn;
            injector.Stops = capture.ReturnStops;
            smoother = new Smoother(delegate (double x, double y) { invoker.BeginInvoke((MethodInvoker)delegate { injector.Move(x, y); }); });
            Action<double, double> laneMove = injector.Move; // one delegate, not one per move
            Lane.Init(delegate (double x, double y) { smoother.Flush(laneMove); laneMove(x, y); }, Emit); // the input lane (Lane.cs)
            HideCursor.Restore(); // in case a crash left the cursors blank
            StartCursorGuard();
            capture.Start();
            capture.Flash = new Flash();
            AppWindows.Watch(delegate { Dictionary<string, object> e = new Dictionary<string, object>(); e["event"] = "winShown"; Emit(e); }); // Menus
            dropEdge = new DropEdge(capture, Emit);
            try { clipWatch = new ClipWatch(Emit); } catch (Exception) { /* no clipboard events: clip.js polls */ }
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

        // The blank cursor (HideCursor.cs) is system-wide: it outlives this process. A clean exit and a
        // managed exception restore it here, but a hard kill can't (the app crashing takes us down with
        // it: Node's job object terminates its children). So a second copy of this exe waits for us to
        // end, however we end, and reloads the user's cursors then. Started with ShellExecute: it
        // inherits none of our handles (the app's pipes see us close at once) and, as Node's job allows
        // silent breakaway, it is outside that job and lives on when the job is killed.
        static void StartCursorGuard()
        {
            try
            {
                ProcessStartInfo si = new ProcessStartInfo(Application.ExecutablePath, "--cursor-guard " + Process.GetCurrentProcess().Id);
                si.UseShellExecute = true;
                si.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(si);
            }
            catch (Exception) { /* no guard: the next helper start still restores the cursors */ }
        }

        static int CursorGuard(string pidText)
        {
            int pid;
            if (!int.TryParse(pidText, out pid)) return 1;
            try { using (Process p = Process.GetProcessById(pid)) p.WaitForExit(); }
            catch (Exception) { /* already gone */ }
            HideCursor.Restore();
            // A UAC prompt or the lock screen in front: try again for a while, until it works.
            for (int i = 0; i < 120 && HideCursor.Pending; i++)
            {
                Thread.Sleep(500);
                HideCursor.Restore();
            }
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

        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);

        // Files onto the clipboard as Explorer's Copy puts them, then Ctrl+V into the window the
        // paste was asked in, once the shortcut's keys are let go (held, it would be Ctrl+Alt+V
        // again). On the STA thread Async gives it; the keys go through the injector on the UI thread.
        static void PasteFiles(List<string> paths, long hwnd)
        {
            System.Collections.Specialized.StringCollection list = new System.Collections.Specialized.StringCollection();
            foreach (string p in paths) if (File.Exists(p) || Directory.Exists(p)) list.Add(p);
            if (list.Count == 0) throw new Exception("nothing to paste");
            DataObject data = new DataObject();
            data.SetFileDropList(list);
            data.SetData("Preferred DropEffect", new MemoryStream(BitConverter.GetBytes(1))); // DROPEFFECT_COPY
            Clipboard.SetDataObject(data, true);
            int[] mods = { 0x10, 0x11, 0x12, 0x5B, 0x5C }; // Shift, Ctrl, Alt, both Windows keys
            for (int i = 0; i < 150 && Array.Exists(mods, k => (GetAsyncKeyState(k) & 0x8000) != 0); i++) Thread.Sleep(20);
            IntPtr w = new IntPtr(hwnd);
            if (hwnd != 0 && IsWindow(w) && GetForegroundWindow() != w) SetForegroundWindow(w);
            Thread.Sleep(80);
            invoker.Invoke((MethodInvoker)delegate
            {
                foreach (string[] k in new[] { new[] { "k.kd", "ControlLeft" }, new[] { "k.kd", "KeyV" }, new[] { "k.ku", "KeyV" }, new[] { "k.ku", "ControlLeft" } })
                {
                    Dictionary<string, object> ev = new Dictionary<string, object>();
                    ev["t"] = k[0];
                    ev["code"] = k[1];
                    injector.Apply(ev);
                }
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
                        capture.TakeBack = Json.Bool(c, "takeBack", true);
#if MULTI
                        // sides: every side that leads to a connected device (CaptureMulti.cs); without it, the one side.
                        List<string> sides = Json.Strs(c, "sides");
                        if (sides == null)
                        {
                            sides = new List<string>();
                            string one = Json.Str(c, "side", null);
                            if (one != null) sides.Add(one);
                        }
                        capture.SetSides(sides);
#else
                        capture.Side = Json.Str(c, "side", null);
#endif
                        capture.ResistancePx = Json.Num(c, "resistancePx", 120);
                        capture.CooldownMs = (int)Json.Num(c, "cooldownMs", 250);
                        capture.DwellMs = (int)Json.Num(c, "dwellMs", 150);
                        capture.EdgeZones = Capture.ParseZones(Json.Str(c, "zones", null));
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
                        capture.Arrived(center ? null : Json.Str(c, "side", "left"));
                        capture.Flash.Play(p, center ? null : Json.Str(c, "side", "left"), false); // the Mac arrives here
                        break;
                    case "armReturn":
                        capture.ReturnZones = Capture.ParseZones(Json.Str(c, "zones", null));
#if MULTI
                        // sides: every side with a device behind it; without it, the one side.
                        List<string> retSides = Json.Strs(c, "sides");
                        if (retSides == null)
                        {
                            retSides = new List<string>();
                            string oneSide = Json.Str(c, "side", null);
                            if (oneSide != null) retSides.Add(oneSide);
                        }
                        capture.ArmReturn(Json.Bool(c, "on", false), retSides, Json.Num(c, "resistancePx", 120));
#else
                        capture.ArmReturn(Json.Bool(c, "on", false), Json.Str(c, "side", null), Json.Num(c, "resistancePx", 120));
#endif
                        break;
                    case "inject":
                        Dictionary<string, object> ev = Json.Obj(c, "ev");
                        if (ev == null) break;
                        Injector.Wake();
                        if (Json.Str(ev, "t", "") == "k.mm" && Json.Bool(ev, "smooth", false)) { smoother.Add(Json.Num(ev, "dx", 0), Json.Num(ev, "dy", 0)); break; }
                        smoother.Flush(injector.Move); // a click or key lands where the pointer ends up
                        injector.Apply(ev);
                        break;
                    case "lane": Lane.Handle(c); break; // the input lane in the helper (Lane.cs)
                    case "releaseAll": smoother.Clear(); stylus.Leave(); injector.ReleaseAll(); break;
                    case "toastProgress": // a live toast with a progress bar (Toast.cs)
                        Toast.Progress(Json.Str(c, "aumid", ""), Json.Str(c, "tag", "files"), Json.Str(c, "title", ""), Json.Str(c, "status", ""), Json.Num(c, "value", -1), Json.Str(c, "label", ""));
                        break;
                    case "toastDone":
                        Toast.Done(Json.Str(c, "aumid", ""), Json.Str(c, "tag", "files"), Json.Str(c, "title", ""), Json.Str(c, "text", ""));
                        break;
                    case "moveTo": Injector.MoveTo((int)Json.Num(c, "x", 0), (int)Json.Num(c, "y", 0)); break; // The Mac's pointer on this PC's screen
                    case "pen": // a phone's stylus on this PC's screen (Stylus.cs)
                        Dictionary<string, object> st = Json.Obj(c, "pen");
                        if (st != null) stylus.At((int)Json.Num(c, "x", 0), (int)Json.Num(c, "y", 0), st);
                        break;
                    case "displays": c["displays"] = Display.List(); break;
                    case "wifiLowLatency": c["applied"] = Wlan.Set(Json.Bool(c, "on", false)); break; // Wlan.cs: media streaming mode, no background scans
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
                        if (Json.Bool(c, "home", false)) capture.Unswallow(0); // came home with our button held: its release drops it
                        drag.Start(dnames);
                        break;
                    case "dragLocal": // our own files, dragged back home with the button still held: Explorer's kind of drag of them
                        {
                            List<string> lp = new List<string>();
                            System.Collections.IList pl = c.ContainsKey("paths") ? c["paths"] as System.Collections.IList : null;
                            if (pl != null) foreach (object o in pl) lp.Add(Convert.ToString(o));
                            capture.Unswallow(0);
                            LocalDrag.Start(lp, Json.Str(c, "drag", "local"), Emit);
                        }
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
                    case "moveWin": // Apps › Move windows: the key held to grab a window, "" = off
                        {
                            string mk = Json.Str(c, "key", "");
                            AppWindows.MoveKeyName = mk;
                            // The key and its Ctrl/Win partner: a Mac's Right Command arrives as Right Ctrl with
                            // Ctrl/Cmd swapping on, else as the Windows key (Grab.swift does the same the other way).
                            HashSet<uint> mv = string.IsNullOrEmpty(mk) ? new HashSet<uint>() : HotkeyVks(mk);
                            string partner = mk == "ControlRight" ? "MetaRight" : mk == "MetaRight" ? "ControlRight" : mk == "ControlLeft" ? "MetaLeft" : mk == "MetaLeft" ? "ControlLeft" : "";
                            if (partner.Length > 0) mv.UnionWith(HotkeyVks(partner));
                            AppWindows.MoveVks = new List<uint>(mv).ToArray();
                        }
                        break;
                    case "winEndMove": AppWindows.EndMove(Json.Num(c, "wid", 0)); break;
                    case "winPark": AppWindows.Park(Json.Num(c, "wid", 0)); break;
                    case "winPlace": AppWindows.Place(Json.Num(c, "wid", 0), (int)Json.Num(c, "x", 0), (int)Json.Num(c, "y", 0)); break;
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
                            // An app in front instead (fclip.js pastes the files into it).
                            uint appPid = 0;
                            string appTitle = "";
                            long appWin = 0;
                            try { if (ff == null) appWin = Shell.FrontApp(out appPid, out appTitle); } catch (Exception) { appWin = 0; }
                            if (appWin != 0)
                            {
                                r["app"] = true;
                                r["hwnd"] = (double)appWin;
                                r["pid"] = (double)appPid;
                                r["title"] = appTitle;
                            }
                        }, true);
                        return;
                    case "frontActivity": // ReZume: the window in front, its address or document (Activity.cs)
                        Async(c, delegate (Dictionary<string, object> r) { Activity.Front(r); });
                        return;
                    case "pasteFiles": // files received for a paste into an app: onto the clipboard, then Ctrl+V there
                        List<string> pastePaths = Strings(c, "paths");
                        long pasteWin = (long)Json.Num(c, "hwnd", 0);
                        Async(c, delegate (Dictionary<string, object> r) { PasteFiles(pastePaths, pasteWin); }, true);
                        return;
                    case "selectItems":
                        string selDir = Json.Str(c, "dir", "");
                        List<string> selNames = Strings(c, "names");
                        Async(c, delegate (Dictionary<string, object> r) { Shell.SelectIn(selDir, selNames); }, true);
                        return;
                    case "keyLayout": // what each key types alone and with Shift in the layout in front (shared/keylayout.js); type: it takes "type"
                        c["layout"] = Keys.Layout();
                        c["shift"] = Keys.Layout(true);
                        c["type"] = true;
                        c["im"] = InputMethods.Current(); // typing with an input method: its language
                        break;
                    case "selectInput": // an input method of the other computer's language ({lang}), or back to ours ({restore}); in line: keys after it go to it
                        if (Json.Has(c, "restore")) InputMethods.Restore();
                        else c["found"] = InputMethods.Select(Json.Str(c, "lang", ""));
                        break;
                    case "type": // text as it is, whatever the layout
                        Injector.Wake();
                        smoother.Flush(injector.Move);
                        Injector.Type(Json.Str(c, "text", ""));
                        break;
                    case "caps": c["on"] = Native.Caps(Json.Has(c, "set") ? (bool?)Json.Bool(c, "set", false) : null); break; // Caps Lock, as the other computer's (#131)
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
            if (cmd == "caps" && c.ContainsKey("on")) reply["on"] = c["on"];
            if (cmd == "lane" && c.ContainsKey("port")) reply["port"] = c["port"];
            if (cmd == "wifiLowLatency" && c.ContainsKey("applied")) reply["applied"] = c["applied"];
            if ((cmd == "displayMode" || cmd == "displayExtend") && error == null) reply["changed"] = c["changed"];
            if (cmd == "folderAt") { reply["path"] = c["path"]; reply["desktop"] = c["desktop"]; }
            if (cmd == "keyLayout")
            {
                reply["layout"] = c["layout"]; reply["shift"] = c["shift"]; reply["type"] = c["type"]; reply["selectInput"] = true;
                if (c["im"] != null) reply["im"] = c["im"];
            }
            if (cmd == "selectInput" && c.ContainsKey("found")) reply["found"] = c["found"];
            Emit(reply);
        }
    }
}

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Portions adapted from Beamer (https://github.com/kalkman-code/beamer), Copyright (C) Kalkman Code,
// GPL-3.0. Changed: C# port of win_app/capture_win.py hooks and raw-mouse edge push.
// Low-level hooks (capture + hotkey), Raw Input (edge push at home, local return-edge motion),
// dead-man timer and the safety rules. Hook callbacks only decide and enqueue.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace MacShare
{
    class Capture
    {
        // config (kvmConfig)
        // Sides of this PC whose outer edge is watched for a crossing (kvmConfig sides; each one leads
        // to another device). The first one is also Side: the file-drag strip (DropEdge) uses it.
        public readonly List<string> Sides = new List<string>();
        public string Side { get { return Sides.Count > 0 ? Sides[0] : null; } }
        public double ResistancePx = 120;
        // kvmConfig hotkey: one key, or the left and right one ("both")
        public HashSet<uint> HotkeyVks = new HashSet<uint> { 0xA5 }; // Right Alt
        public bool DriveOther;      // edge detection on
        public bool EdgeKeyboard = true; // an edge crossing also captures the keyboard
        public bool DragFiles = true; // file drags at the edge go to the Mac (drag.policy + the Files switches)
        public int DeadmanMs = 1500, DoubleTapMs = 400;
        public bool Gestures = true; // Touchpad gestures go over as k.ge (Touchpad.cs)
        Touchpad pad;
        readonly HashSet<uint> padCtrl = new HashSet<uint>(); // Ctrl that Windows made from a pinch, swallowed

        // capture state
        bool capturing, capMouse, capKeys;
        Point saved, parked;
        readonly HashSet<uint> heldVks = new HashSet<uint>(), swallowVks = new HashSet<uint>();
        readonly HashSet<int> heldButtons = new HashSet<int>(), swallowButtons = new HashSet<int>();
        DateTime lastCmd = DateTime.UtcNow;

        // edge push (home) per watched side, and the return edge (driven)
        class EdgePush { public double Amount; public DateTime Last; }
        readonly Dictionary<string, EdgePush> pushes = new Dictionary<string, EdgePush>();
        // The return watch (this PC is driven): every side that has a device behind it, the push per side.
        readonly List<string> retSides = new List<string>();
        readonly Dictionary<string, EdgePush> retPushes = new Dictionary<string, EdgePush>();
        bool retArmed; double retResistance;
        DateTime lastEdgeNote = DateTime.MinValue, lastOuterNote = DateTime.MinValue;

        // hotkey double-tap
        bool hkDown; DateTime lastTapUp = DateTime.MinValue;
        // Held back while capturing: a hotkey press is sent only when another
        // key or a click follows (a shortcut); a plain tap never reaches the other computer.
        uint hkPending; string hkPendingCode;
        readonly HashSet<uint> hkLocal = new HashSet<uint>(), hkRemote = new HashSet<uint>(); // pressed at home / sent over

        readonly Action<Dictionary<string, object>> emit;
        Native.HookProc mouseProc, keyProc; // kept in fields so the GC never collects them
        IntPtr mouseHook, keyHook;
        RawWindow raw;
        readonly Timer timer = new Timer();
        public Flash Flash; // crossing animation (set by Program)
        ParkPad parkPad; // our own window under the parked pointer, for the wheel (ParkPad.cs)
        DateTime rawSinceHook = DateTime.MinValue, lastReinstall = DateTime.MinValue; // first raw motion no hook call followed
        bool secure; // a UAC prompt or the lock screen is the input desktop (Native.SecureDesktop)

        public Capture(Action<Dictionary<string, object>> emit)
        {
            this.emit = emit;
        }

        public void Start()
        {
            mouseProc = MouseHook;
            keyProc = KeyHook;
            Hook();
            parkPad = new ParkPad();
            pad = new Touchpad(OnGesture);
            raw = new RawWindow(OnRawMove, (buf, header) =>
            {
                pad.Active = capturing && capMouse && Gestures;
                pad.OnRaw(buf, header);
            });
            timer.Interval = 100;
            timer.Tick += delegate { Tick(); };
            timer.Start();
        }

        void Hook()
        {
            IntPtr mod = Native.GetModuleHandle(null);
            if (mouseHook != IntPtr.Zero) Native.UnhookWindowsHookEx(mouseHook);
            if (keyHook != IntPtr.Zero) Native.UnhookWindowsHookEx(keyHook);
            mouseHook = Native.SetWindowsHookEx(Native.WH_MOUSE_LL, mouseProc, mod, 0);
            keyHook = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, keyProc, mod, 0);
            rawSinceHook = DateTime.MinValue;
        }

        // Windows silently removes a low-level hook whose callback once took longer than
        // LowLevelHooksTimeout. Raw input keeps coming then, but the hook isn't called: put it back,
        // once the mouse has moved for half a second with no hook call (not merely after a pause).
        void Watchdog()
        {
            DateTime now = DateTime.UtcNow;
            if (rawSinceHook == DateTime.MinValue) { rawSinceHook = now; return; }
            if ((now - rawSinceHook).TotalMilliseconds < 500 || (now - lastReinstall).TotalMilliseconds < 1000) return;
            lastReinstall = now;
            Hook();
            emit(Ev("hooksReinstalled"));
        }

        public void Shutdown()
        {
            if (capturing) Stop(null, 0);
            HideCursor.Show();
            timer.Stop();
            if (mouseHook != IntPtr.Zero) Native.UnhookWindowsHookEx(mouseHook);
            if (keyHook != IntPtr.Zero) Native.UnhookWindowsHookEx(keyHook);
            mouseHook = keyHook = IntPtr.Zero;
        }

        public void Touch() { lastCmd = DateTime.UtcNow; }

        static Dictionary<string, object> Ev(string name)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["event"] = name;
            return d;
        }

        void Forward(Dictionary<string, object> k)
        {
            Dictionary<string, object> d = Ev("ev");
            d["ev"] = k;
            emit(d);
        }

        static Dictionary<string, object> K(string t)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["t"] = t;
            return d;
        }

        // A touchpad gesture recognised while capturing: over it goes, by meaning.
        void OnGesture(string g, string phase, double v)
        {
            if (!capturing || !capMouse || !Gestures) return;
            Dictionary<string, object> k = K("k.ge");
            k["g"] = g;
            if (phase != null) k["phase"] = phase;
            if (g == "zoom") k["v"] = v;
            Forward(k);
        }

        // ---- capture on/off ----

        // Watches these sides (valid names only, no repeats). Empty: no edge crossing.
        public void SetSides(IEnumerable<string> list)
        {
            Sides.Clear();
            foreach (string s in list)
                if ((s == "left" || s == "right" || s == "top" || s == "bottom") && !Sides.Contains(s)) Sides.Add(s);
        }

        // The watched side whose outer edge the point is on (null: none).
        string EdgeAt(int x, int y)
        {
            foreach (string s in Sides) if (Screens.OnOuterEdge(x, y, s)) return s;
            return null;
        }

        public void Begin(bool mouse, bool keys)
        {
            Begin(mouse, keys, null);
        }

        // edge: the side that was crossed (null: the pointer's own edge, or none), for the animation.
        public void Begin(bool mouse, bool keys, string edge)
        {
            if (capturing) { capMouse = mouse; capKeys = keys; return; }
            capturing = true; capMouse = mouse; capKeys = keys;
            heldVks.Clear(); heldButtons.Clear();
            hkPending = 0; hkRemote.Clear();
            Touch();
            if (mouse)
            {
                Native.POINT p;
                Native.GetCursorPos(out p);
                saved = new Point(p.x, p.y);
                // Leaving: the animation where it goes, then the pointer hides and stays put for
                // the eye (it is parked in the middle only to measure motion).
                if (Flash != null) Flash.Play(saved, edge ?? EdgeAt(p.x, p.y), true);
                HideCursor.Hide();
                // Park in the middle so outward motion isn't clamped by the screen edge.
                parked = Screens.Center();
                parkPad.Cover(parked);
                Native.SetCursorPos(parked.X, parked.Y);
            }
            pushes.Clear();
        }

        // side == null: put the pointer back where capture began.
        public void Stop(string side, double offset)
        {
            if (!capturing) return;
            capturing = false;
            // Rule 5: whatever is still held was pressed remotely; its release stays swallowed here.
            foreach (uint vk in heldVks) swallowVks.Add(vk);
            foreach (int b in heldButtons) swallowButtons.Add(b);
            heldVks.Clear(); heldButtons.Clear();
            hkPending = 0; hkRemote.Clear(); // a sent hotkey's release is in swallowVks (heldVks) now
            if (capMouse)
            {
                Point p = side != null ? Screens.EdgePoint(side, offset) : saved;
                parkPad.Uncover();
                Native.SetCursorPos(p.X, p.Y);
                HideCursor.Show();
                if (Flash != null) Flash.Play(p, side ?? EdgeAt(p.X, p.Y), false); // arriving
            }
            pushes.Clear();
        }

        public bool Capturing { get { return capturing; } }

        // Watches these sides for the pointer leaving this PC (valid names only, no repeats). Off, or none
        // given: nothing is watched.
        public void ArmReturn(bool on, IEnumerable<string> sides, double resistance)
        {
            retSides.Clear();
            retPushes.Clear();
            if (on && sides != null)
            {
                foreach (string s in sides)
                    if ((s == "left" || s == "right" || s == "top" || s == "bottom") && !retSides.Contains(s)) retSides.Add(s);
            }
            retArmed = retSides.Count > 0;
            retResistance = resistance;
        }

        void Tick()
        {
            HideCursor.Retry();
            // A UAC prompt or the lock screen: nothing can be injected or captured there, so the
            // input goes home on both sides (main sends a driven PC's owner home).
            bool now = Native.SecureDesktop();
            if (now != secure)
            {
                secure = now;
                if (secure && capturing)
                {
                    Stop(null, 0);
                    Dictionary<string, object> c = Ev("captureEnded");
                    c["reason"] = "secureDesktop";
                    emit(c);
                }
                Dictionary<string, object> e = Ev("secureDesktop");
                e["on"] = secure;
                emit(e);
            }
            if (capturing && (DateTime.UtcNow - lastCmd).TotalMilliseconds > DeadmanMs)
            {
                Stop(null, 0); // Rule 1: a hung main or a dead link never keeps the user's input
                Dictionary<string, object> d = Ev("captureEnded");
                d["reason"] = "deadman";
                emit(d);
            }
        }

        // ---- hooks ----

        IntPtr MouseHook(int nCode, IntPtr wParam, IntPtr lParam)
        {
            rawSinceHook = DateTime.MinValue;
            if (nCode < 0) return Native.CallNextHookEx(mouseHook, nCode, wParam, lParam);
            Native.MSLLHOOKSTRUCT m = (Native.MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.MSLLHOOKSTRUCT));
            if ((m.flags & Native.LLMHF_INJECTED) != 0 && m.dwExtraInfo == Native.MARK)
                return Native.CallNextHookEx(mouseHook, nCode, wParam, lParam); // Rule 4: our own
            int msg = wParam.ToInt32();
            int button = ButtonOf(msg, m.mouseData);
            bool down = msg == Native.WM_LBUTTONDOWN || msg == Native.WM_RBUTTONDOWN || msg == Native.WM_MBUTTONDOWN || msg == Native.WM_XBUTTONDOWN;
            bool up = msg == Native.WM_LBUTTONUP || msg == Native.WM_RBUTTONUP || msg == Native.WM_MBUTTONUP || msg == Native.WM_XBUTTONUP;

            if (up && button >= 0 && swallowButtons.Remove(button)) return (IntPtr)1;
            if (!capturing || !capMouse) return Native.CallNextHookEx(mouseHook, nCode, wParam, lParam);

            if (msg == Native.WM_MOUSEMOVE)
            {
                int dx = m.pt.x - parked.X, dy = m.pt.y - parked.Y;
                if (dx != 0 || dy != 0)
                {
                    double s = Screens.Scale(parked.X, parked.Y);
                    Dictionary<string, object> k = K("k.mm");
                    k["dx"] = Math.Round(dx / s, 2);
                    k["dy"] = Math.Round(dy / s, 2);
                    Forward(k);
                }
            }
            else if (button >= 0 && (down || up))
            {
                if (down) FlushHotkey(); // Ctrl-click with the hotkey key
                if (down) heldButtons.Add(button); else heldButtons.Remove(button);
                Dictionary<string, object> k = K(down ? "k.md" : "k.mu");
                k["b"] = button;
                Forward(k);
            }
            else if ((msg == Native.WM_MOUSEWHEEL || msg == Native.WM_MOUSEHWHEEL) && pad != null && (pad.Pinching || pad.Fingers >= 3))
            {
                // Windows' own wheel from a pinch or a three/four-finger swipe: the gesture goes as k.ge.
            }
            else if (msg == Native.WM_MOUSEWHEEL || msg == Native.WM_MOUSEHWHEEL)
            {
                double notches = (short)((m.mouseData >> 16) & 0xFFFF) / 120.0;
                Dictionary<string, object> k = K("k.wh");
                k["dx"] = msg == Native.WM_MOUSEHWHEEL ? notches : 0.0;
                k["dy"] = msg == Native.WM_MOUSEWHEEL ? -notches : 0.0;
                k["mode"] = "line";
                Forward(k);
            }
            return (IntPtr)1; // swallow: the pointer stays parked
        }

        static int ButtonOf(int msg, uint mouseData)
        {
            switch (msg)
            {
                case Native.WM_LBUTTONDOWN: case Native.WM_LBUTTONUP: return 0;
                case Native.WM_RBUTTONDOWN: case Native.WM_RBUTTONUP: return 1;
                case Native.WM_MBUTTONDOWN: case Native.WM_MBUTTONUP: return 2;
                case Native.WM_XBUTTONDOWN: case Native.WM_XBUTTONUP:
                    return ((mouseData >> 16) & 0xFFFF) == Native.XBUTTON1 ? 3 : 4;
            }
            return -1;
        }

        IntPtr KeyHook(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode < 0) return Native.CallNextHookEx(keyHook, nCode, wParam, lParam);
            Native.KBDLLHOOKSTRUCT k = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.KBDLLHOOKSTRUCT));
            if ((k.flags & Native.LLKHF_INJECTED) != 0 && k.dwExtraInfo == Native.MARK)
                return Native.CallNextHookEx(keyHook, nCode, wParam, lParam); // Rule 4: our own
            int msg = wParam.ToInt32();
            bool down = msg == Native.WM_KEYDOWN || msg == Native.WM_SYSKEYDOWN;
            string code = Keys.Code(k.vkCode, k.scanCode, (k.flags & Native.LLKHF_EXTENDED) != 0);
            // AltGr (Right Alt on many layouts) sends a fake Left Ctrl first, scan 0x21D: with Right Alt
            // as the hotkey it is part of the hotkey, so it neither breaks the double-tap nor goes over.
            // It is never a real Ctrl press, so it never counts for a Ctrl hotkey either.
            bool fakeCtrl = k.vkCode == 0xA2 && k.scanCode == 0x21D;
            bool altGrCtrl = fakeCtrl && HotkeyVks.Contains(0xA5);
            bool hotkey = !fakeCtrl && DetectHotkey(k.vkCode, down);

            if (!down && swallowVks.Remove(k.vkCode)) return (IntPtr)1;
            // The Ctrl Windows injects for a touchpad pinch (Ctrl+wheel) stays here.
            bool ctrl = k.vkCode == 0xA2 || k.vkCode == 0xA3 || k.vkCode == 0x11;
            if (ctrl && !down && padCtrl.Remove(k.vkCode)) return (IntPtr)1;
            if (ctrl && down && capturing && (k.flags & Native.LLKHF_INJECTED) != 0 && pad != null && pad.Pinching) { padCtrl.Add(k.vkCode); return (IntPtr)1; }

            bool isHk = HotkeyVks.Contains(k.vkCode);
            if (capturing && capKeys)
            {
                if (altGrCtrl) { if (hotkey) FireHotkey(); return (IntPtr)1; }
                if (isHk)
                {
                    IntPtr r = (IntPtr)1;
                    if (hkLocal.Contains(k.vkCode)) // pressed at home: it is released at home
                    {
                        if (!down) hkLocal.Remove(k.vkCode);
                        r = IntPtr.Zero;
                    }
                    else if (down)
                    {
                        if (!hkRemote.Contains(k.vkCode)) { hkPending = k.vkCode; hkPendingCode = code; } // wait: a shortcut sends it
                    }
                    else if (hkRemote.Remove(k.vkCode))
                    {
                        heldVks.Remove(k.vkCode);
                        if (code != null) { Dictionary<string, object> e = K("k.ku"); e["code"] = code; Forward(e); }
                    }
                    else if (hkPending == k.vkCode) hkPending = 0; // a plain tap: never sent
                    if (hotkey) FireHotkey();
                    return r == IntPtr.Zero ? Native.CallNextHookEx(keyHook, nCode, wParam, lParam) : r;
                }
                if (down) FlushHotkey();
                if (down) heldVks.Add(k.vkCode); else heldVks.Remove(k.vkCode);
                if (code != null) { Dictionary<string, object> e = K(down ? "k.kd" : "k.ku"); e["code"] = code; Forward(e); }
                if (hotkey) FireHotkey();
                return (IntPtr)1;
            }
            if (isHk) { if (down) hkLocal.Add(k.vkCode); else hkLocal.Remove(k.vkCode); }
            if (hotkey) FireHotkey();
            return Native.CallNextHookEx(keyHook, nCode, wParam, lParam);
        }

        // The held hotkey turned out to be part of a shortcut: send its press now, before the key.
        void FlushHotkey()
        {
            uint vk = hkPending;
            hkPending = 0;
            if (vk == 0 || !capturing || !capKeys || hkPendingCode == null) return;
            hkRemote.Add(vk);
            heldVks.Add(vk);
            Dictionary<string, object> e = K("k.kd");
            e["code"] = hkPendingCode;
            Forward(e);
        }

        // Two clean taps (down+up, no other key between) within DoubleTapMs, in every mode.
        bool DetectHotkey(uint vk, bool down)
        {
            DateTime now = DateTime.UtcNow;
            if (!HotkeyVks.Contains(vk))
            {
                if (down) lastTapUp = DateTime.MinValue;
                return false;
            }
            if (down) { hkDown = true; return false; }
            if (!hkDown) return false;
            hkDown = false;
            if (lastTapUp != DateTime.MinValue && (now - lastTapUp).TotalMilliseconds <= DoubleTapMs)
            {
                lastTapUp = DateTime.MinValue;
                return true;
            }
            lastTapUp = now;
            return false;
        }

        // Rule 2: stop capturing in the helper first, then tell main.
        void FireHotkey()
        {
            bool was = capturing;
            if (capturing) Stop(null, 0);
            Dictionary<string, object> d = Ev("hotkey");
            d["wasCapturing"] = was;
            emit(d);
        }

        // ---- raw input: edge push at home, local motion for the return edge ----

        static bool AnyButtonDown()
        {
            return (Native.GetAsyncKeyState(0x01) & 0x8000) != 0 || (Native.GetAsyncKeyState(0x02) & 0x8000) != 0 || (Native.GetAsyncKeyState(0x04) & 0x8000) != 0;
        }

        void OnRawMove(int dx, int dy)
        {
            Watchdog();
            if (capturing) return;
            Native.POINT p;
            Native.GetCursorPos(out p);
            if (retArmed) { FeedReturn(p.x, p.y, dx, dy); return; }
            // For the logs: a push against any outer edge of the desktop says whether it is watched and why nothing crossed.
            foreach (string any in new string[] { "left", "right", "top", "bottom" })
            {
                if (Screens.Outward(any, dx, dy) <= 0 || !Screens.OnOuterEdge(p.x, p.y, any) || (DateTime.UtcNow - lastOuterNote).TotalMilliseconds < 2000) continue;
                lastOuterNote = DateTime.UtcNow;
                Dictionary<string, object> n2 = Ev("edgeNote");
                n2["side"] = any; n2["x"] = p.x; n2["y"] = p.y; n2["monitors"] = Screens.Describe();
                n2["watched"] = string.Join(",", Sides.ToArray()); n2["driveOther"] = DriveOther; n2["button"] = AnyButtonDown(); n2["outer"] = true;
                emit(n2);
                break;
            }
            if (!DriveOther || Sides.Count == 0 || AnyButtonDown()) { pushes.Clear(); return; } // Rule 6: no crossing mid-drag
            foreach (string side in Sides)
            {
                double outward = Screens.Outward(side, dx, dy);
                // A push against a watched side's edge that is not the outer edge of the desktop crosses nothing: say so (once in a while) for the logs.
                if (outward > 0 && Screens.NearEdge(p.x, p.y, side, 8) && !Screens.OnOuterEdge(p.x, p.y, side) && (DateTime.UtcNow - lastEdgeNote).TotalMilliseconds > 2000)
                {
                    lastEdgeNote = DateTime.UtcNow;
                    Dictionary<string, object> note = Ev("edgeNote");
                    note["side"] = side; note["x"] = p.x; note["y"] = p.y; note["monitors"] = Screens.Describe();
                    emit(note);
                }
                if (outward <= 0 || !Screens.OnOuterEdge(p.x, p.y, side)) { pushes.Remove(side); continue; }
                DateTime now = DateTime.UtcNow;
                EdgePush e;
                if (!pushes.TryGetValue(side, out e)) { e = new EdgePush(); pushes[side] = e; }
                if ((now - e.Last).TotalMilliseconds > 300) e.Amount = 0;
                e.Last = now;
                e.Amount += outward;
                if (e.Amount < ResistancePx) continue;
                double offset = Screens.Offset(p.x, p.y, side);
                Begin(true, EdgeKeyboard, side); // start capturing at once so no motion leaks, then tell main
                saved = new Point(p.x, p.y);
                Dictionary<string, object> d = Ev("edge");
                d["offset"] = Math.Round(offset, 4);
                d["side"] = side;
                emit(d);
                return;
            }
        }

        // Injected moves report here too (Injector.Moved): the owner's hand reaches the edge.
        // The return event names the side it left by. Pushes are summed per side; the first side to reach
        // the resistance wins and the watch is off until main arms it again.
        public void FeedReturn(int x, int y, double dx, double dy)
        {
            if (!retArmed) return;
            DateTime now = DateTime.UtcNow;
            foreach (string side in retSides)
            {
                double outward = Screens.Outward(side, dx, dy);
                if (outward <= 0 || !Screens.OnOuterEdge(x, y, side)) { retPushes.Remove(side); continue; }
                EdgePush e;
                if (!retPushes.TryGetValue(side, out e)) { e = new EdgePush(); retPushes[side] = e; }
                if ((now - e.Last).TotalMilliseconds > 300) e.Amount = 0;
                e.Last = now;
                e.Amount += outward;
                if (e.Amount < retResistance) continue;
                retArmed = false;
                retPushes.Clear();
                if (Flash != null) Flash.Play(new Point(x, y), side, true); // leaving this PC for another device
                Dictionary<string, object> d = Ev("return");
                d["offset"] = Math.Round(Screens.Offset(x, y, side), 4);
                d["side"] = side;
                emit(d);
                return;
            }
        }

        // Message-only window that receives WM_INPUT for the mouse (usage page 1, usage 2) and, since
        // The precision touchpad (digitizer page 0x0D, usage 5) for Touchpad.cs.
        class RawWindow : NativeWindow
        {
            readonly Action<int, int> onMove;
            readonly Action<IntPtr, int> onTouchpad;

            public RawWindow(Action<int, int> onMove, Action<IntPtr, int> onTouchpad)
            {
                this.onMove = onMove;
                this.onTouchpad = onTouchpad;
                CreateParams cp = new CreateParams();
                cp.Parent = new IntPtr(-3); // HWND_MESSAGE
                CreateHandle(cp);
                Native.RAWINPUTDEVICE[] d = new Native.RAWINPUTDEVICE[2];
                d[0].usUsagePage = 1;
                d[0].usUsage = 2;
                d[0].dwFlags = Native.RIDEV_INPUTSINK;
                d[0].hwndTarget = Handle;
                d[1].usUsagePage = 0x0D;
                d[1].usUsage = 0x05;
                d[1].dwFlags = Native.RIDEV_INPUTSINK;
                d[1].hwndTarget = Handle;
                if (!Native.RegisterRawInputDevices(d, 2, (uint)Marshal.SizeOf(typeof(Native.RAWINPUTDEVICE))))
                    Native.RegisterRawInputDevices(d, 1, (uint)Marshal.SizeOf(typeof(Native.RAWINPUTDEVICE))); // the mouse at least
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == Native.WM_INPUT) Read(m.LParam);
                base.WndProc(ref m);
            }

            void Read(IntPtr hRaw)
            {
                const uint header = 24; // RAWINPUTHEADER on x64
                uint size = 0;
                Native.GetRawInputData(hRaw, Native.RID_INPUT, IntPtr.Zero, ref size, header);
                if (size < header + 8) return; // the smallest HID packet; a mouse one is checked below
                IntPtr buf = Marshal.AllocHGlobal((int)size);
                try
                {
                    if (Native.GetRawInputData(hRaw, Native.RID_INPUT, buf, ref size, header) == uint.MaxValue) return;
                    int type = Marshal.ReadInt32(buf, 0);
                    if (type == 2) { onTouchpad(buf, (int)header); return; } // RIM_TYPEHID: the touchpad
                    if (type != 0 || size < header + 24) return; // RIM_TYPEMOUSE, a whole RAWMOUSE
                    int rm = (int)header;
                    ushort flags = (ushort)Marshal.ReadInt16(buf, rm);
                    int lx = Marshal.ReadInt32(buf, rm + 12), ly = Marshal.ReadInt32(buf, rm + 16);
                    uint extra = (uint)Marshal.ReadInt32(buf, rm + 20);
                    if ((flags & 1) != 0 || extra == 0x4D530000) return; // absolute devices / our own
                    if (lx != 0 || ly != 0) onMove(lx, ly);
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
        }
    }
}

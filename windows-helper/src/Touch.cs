// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A viewer's fingers (the `touch` command: in.tc, shared/protocol.js P.touchesOf) as a Windows touch
// screen: a synthetic touch pointer device (InjectSyntheticPointerInput, Windows 10 1809 and later)
// with up to 10 contacts, so a swipe scrolls, a pinch zooms and a hold right-clicks the way this
// PC's own touch screen would. Each frame carries every contact; one going up is in it once more with
// POINTER_FLAG_UP. A contact that stays still is sent again every 100 ms (Windows cancels contacts
// it stops hearing about). Where pointer injection isn't there, the first finger is the mouse.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace MacShare
{
    class Touch
    {
        const uint PT_TOUCH = 2, POINTER_FEEDBACK_DEFAULT = 1, MAX = 10;
        const uint POINTER_FLAG_INRANGE = 0x2, POINTER_FLAG_INCONTACT = 0x4, POINTER_FLAG_PRIMARY = 0x2000,
            POINTER_FLAG_DOWN = 0x10000, POINTER_FLAG_UPDATE = 0x20000, POINTER_FLAG_UP = 0x40000;

        [StructLayout(LayoutKind.Sequential)]
        struct POINTER_INFO
        {
            public uint pointerType, pointerId, frameId, pointerFlags;
            public IntPtr sourceDevice, hwndTarget;
            public Native.POINT ptPixelLocation, ptHimetricLocation, ptPixelLocationRaw, ptHimetricLocationRaw;
            public uint dwTime, historyCount;
            public int InputData;
            public uint dwKeyStates;
            public ulong PerformanceCount;
            public int ButtonChangeType;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int left, top, right, bottom; }

        [StructLayout(LayoutKind.Sequential)]
        struct POINTER_TOUCH_INFO
        {
            public POINTER_INFO pointerInfo;
            public uint touchFlags, touchMask;
            public RECT rcContact, rcContactRaw;
            public uint orientation, pressure;
        }

        // POINTER_TYPE_INFO with its union's touch member (the larger one).
        [StructLayout(LayoutKind.Sequential)]
        struct POINTER_TYPE_INFO
        {
            public uint type;
            public POINTER_TOUCH_INFO touch;
        }

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr CreateSyntheticPointerDevice(uint pointerType, uint maxCount, uint mode);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool InjectSyntheticPointerInput(IntPtr device, [In] POINTER_TYPE_INFO[] info, uint count);

        readonly Injector injector;
        readonly object gate = new object();
        IntPtr device = IntPtr.Zero;
        bool tried, mouseDown;
        int mouseId = -1;
        // id -> where it is; the contacts touching now
        readonly SortedDictionary<int, Native.POINT> down = new SortedDictionary<int, Native.POINT>();
        Timer keep;
        int lastSent; // Environment.TickCount of the last frame

        public Touch(Injector injector)
        {
            this.injector = injector;
        }

        bool Ready()
        {
            if (!tried)
            {
                tried = true;
                try { device = CreateSyntheticPointerDevice(PT_TOUCH, MAX, POINTER_FEEDBACK_DEFAULT); }
                catch (EntryPointNotFoundException) { device = IntPtr.Zero; } // before Windows 10 1809
                if (device == IntPtr.Zero) Console.Error.WriteLine("touch: no synthetic pointer device (" + Marshal.GetLastWin32Error() + "), a finger is the mouse");
                else keep = new Timer(delegate { Refresh(); }, null, 100, 100);
            }
            return device != IntPtr.Zero;
        }

        // "id,x,y;id,x,y" (physical px on the virtual desktop): every finger touching now; "" = none.
        public void Set(string p)
        {
            Dictionary<int, Native.POINT> now = new Dictionary<int, Native.POINT>();
            foreach (string part in (p ?? "").Split(';'))
            {
                string[] f = part.Split(',');
                int id, x, y;
                if (f.Length != 3 || !int.TryParse(f[0], out id) || !int.TryParse(f[1], out x) || !int.TryParse(f[2], out y)) continue;
                if (id < 0 || id >= MAX || now.Count >= MAX) continue;
                now[id] = new Native.POINT(x, y);
            }
            lock (gate)
            {
                if (!Ready()) { Mouse(now); return; }
                List<POINTER_TYPE_INFO> frame = new List<POINTER_TYPE_INFO>();
                int primary = -1;
                foreach (int id in down.Keys) { primary = id; break; }
                foreach (KeyValuePair<int, Native.POINT> c in down)
                {
                    Native.POINT at;
                    if (now.TryGetValue(c.Key, out at)) frame.Add(Info(c.Key, at, POINTER_FLAG_UPDATE | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT, c.Key == primary));
                    else frame.Add(Info(c.Key, c.Value, POINTER_FLAG_UP, c.Key == primary));
                }
                foreach (KeyValuePair<int, Native.POINT> c in now)
                {
                    if (down.ContainsKey(c.Key)) continue;
                    frame.Add(Info(c.Key, c.Value, POINTER_FLAG_DOWN | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT, down.Count == 0 && frame.Count == 0));
                }
                down.Clear();
                foreach (KeyValuePair<int, Native.POINT> c in now) down[c.Key] = c.Value;
                Inject(frame);
            }
        }

        // Lift every finger (a session ended, releaseAll).
        public void Leave()
        {
            lock (gate) { if (down.Count == 0 && !mouseDown) return; } // nothing down (no device made for nothing)
            Set("");
        }

        // The contacts that stay still, again: Windows lets go of those it stops hearing about.
        void Refresh()
        {
            lock (gate)
            {
                if (down.Count == 0 || unchecked(Environment.TickCount - lastSent) < 90) return;
                List<POINTER_TYPE_INFO> frame = new List<POINTER_TYPE_INFO>();
                bool first = true;
                foreach (KeyValuePair<int, Native.POINT> c in down)
                {
                    frame.Add(Info(c.Key, c.Value, POINTER_FLAG_UPDATE | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT, first));
                    first = false;
                }
                Inject(frame);
            }
        }

        static POINTER_TYPE_INFO Info(int id, Native.POINT at, uint flags, bool primary)
        {
            POINTER_TYPE_INFO i = new POINTER_TYPE_INFO();
            i.type = PT_TOUCH;
            i.touch.pointerInfo.pointerType = PT_TOUCH;
            i.touch.pointerInfo.pointerId = (uint)id;
            i.touch.pointerInfo.pointerFlags = flags | (primary ? POINTER_FLAG_PRIMARY : 0);
            i.touch.pointerInfo.ptPixelLocation = at;
            return i;
        }

        void Inject(List<POINTER_TYPE_INFO> frame)
        {
            if (frame.Count == 0) return;
            lastSent = Environment.TickCount;
            if (!InjectSyntheticPointerInput(device, frame.ToArray(), (uint)frame.Count))
                Console.Error.WriteLine("touch: inject failed (" + Marshal.GetLastWin32Error() + ")");
            Injector.Wake();
        }

        // No touch injection: the first finger down is the mouse's left button.
        void Mouse(Dictionary<int, Native.POINT> now)
        {
            Native.POINT at;
            if (mouseId >= 0 && now.TryGetValue(mouseId, out at)) { Injector.MoveTo(at.x, at.y); return; }
            if (mouseDown) { mouseDown = false; injector.Button(0, false); }
            mouseId = -1;
            foreach (KeyValuePair<int, Native.POINT> c in now)
            {
                mouseId = c.Key;
                Injector.MoveTo(c.Value.x, c.Value.y);
                mouseDown = true;
                injector.Button(0, true);
                break;
            }
        }
    }
}

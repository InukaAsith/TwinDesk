// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// P/Invoke: SendInput, low-level hooks, raw input, cursor, monitors and DPI.
using System;
using System.Runtime.InteropServices;

namespace MacShare
{
    static class Native
    {
        public static readonly IntPtr MARK = new IntPtr(0x4D530000); // dwExtraInfo on everything we inject

        // ---- SendInput ----
        public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
        public const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004,
            MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010, MOUSEEVENTF_MIDDLEDOWN = 0x0020,
            MOUSEEVENTF_MIDDLEUP = 0x0040, MOUSEEVENTF_XDOWN = 0x0080, MOUSEEVENTF_XUP = 0x0100,
            MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000, MOUSEEVENTF_VIRTUALDESK = 0x4000,
            MOUSEEVENTF_ABSOLUTE = 0x8000;
        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_SCANCODE = 0x0008;
        public const uint XBUTTON1 = 1, XBUTTON2 = 2;

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public InputUnion u; }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        // ---- waking the display (Injector.Wake) ----
        public const uint ES_SYSTEM_REQUIRED = 0x1, ES_DISPLAY_REQUIRED = 0x2;
        [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);

        // ---- keyboard layout (Inject.NextLayout) ----
        public const uint WM_INPUTLANGCHANGEREQUEST = 0x0050;
        public const int INPUTLANGCHANGE_FORWARD = 0x0002, HKL_NEXT = 1;

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        // ---- cursor, metrics ----
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int x, y; public POINT(int x, int y) { this.x = x; this.y = y; } }

        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] public static extern short GetKeyState(int vk);
        [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);

        // Caps Lock (#131): on or off here; set != null turns it that way (a tap, marked ours).
        public static bool Caps(bool? set)
        {
            bool on = (GetKeyState(0x14) & 1) != 0;
            if (set.HasValue && set.Value != on)
            {
                keybd_event(0x14, 0x3A, 0, MARK);
                keybd_event(0x14, 0x3A, 2, MARK);
                on = set.Value;
            }
            return on;
        }
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
        public const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;

        // ---- DPI ----
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
        [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmon, int type, out uint dpiX, out uint dpiY);
        public const uint MONITOR_DEFAULTTONEAREST = 2;

        // ---- low-level hooks ----
        public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
        public const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14;
        public const int WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
        public const int WM_MOUSEMOVE = 0x200, WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202, WM_RBUTTONDOWN = 0x204,
            WM_RBUTTONUP = 0x205, WM_MBUTTONDOWN = 0x207, WM_MBUTTONUP = 0x208, WM_MOUSEWHEEL = 0x20A,
            WM_XBUTTONDOWN = 0x20B, WM_XBUTTONUP = 0x20C, WM_MOUSEHWHEEL = 0x20E;
        public const uint LLMHF_INJECTED = 0x01, LLKHF_EXTENDED = 0x01, LLKHF_INJECTED = 0x10;

        [StructLayout(LayoutKind.Sequential)]
        public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        public struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }

        // The hooks' structs read field by field: Marshal.PtrToStructure boxes one object per event,
        // and the hooks run for every mouse move (docs/protocol.md: nothing allocated per move).
        static readonly int MsExtra = Marshal.OffsetOf(typeof(MSLLHOOKSTRUCT), "dwExtraInfo").ToInt32();
        static readonly int KbExtra = Marshal.OffsetOf(typeof(KBDLLHOOKSTRUCT), "dwExtraInfo").ToInt32();
        public static MSLLHOOKSTRUCT ReadMouse(IntPtr p)
        {
            MSLLHOOKSTRUCT m;
            m.pt = new POINT(Marshal.ReadInt32(p, 0), Marshal.ReadInt32(p, 4));
            m.mouseData = (uint)Marshal.ReadInt32(p, 8);
            m.flags = (uint)Marshal.ReadInt32(p, 12);
            m.time = (uint)Marshal.ReadInt32(p, 16);
            m.dwExtraInfo = Marshal.ReadIntPtr(p, MsExtra);
            return m;
        }
        public static KBDLLHOOKSTRUCT ReadKey(IntPtr p)
        {
            KBDLLHOOKSTRUCT k;
            k.vkCode = (uint)Marshal.ReadInt32(p, 0);
            k.scanCode = (uint)Marshal.ReadInt32(p, 4);
            k.flags = (uint)Marshal.ReadInt32(p, 8);
            k.time = (uint)Marshal.ReadInt32(p, 12);
            k.dwExtraInfo = Marshal.ReadIntPtr(p, KbExtra);
            return k;
        }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, HookProc fn, IntPtr hMod, uint threadId);
        [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandle(string name);

        // The input desktop: none we may open while a UAC prompt (the secure desktop) or the lock
        // screen is showing. Input can't be injected there, nor hooked.
        [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
        public static bool SecureDesktop()
        {
            IntPtr d = OpenInputDesktop(0, false, 0x0001 /* DESKTOP_READOBJECTS */);
            if (d == IntPtr.Zero) return true;
            CloseDesktop(d);
            return false;
        }

        // Windows' power throttling (EcoQoS, Efficiency mode) slows a process it thinks is in the
        // background: this one only ever has hidden windows, but it carries the user's input.
        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_POWER_THROTTLING_STATE { public uint Version, ControlMask, StateMask; }
        [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll")] public static extern bool SetPriorityClass(IntPtr process, uint priorityClass);
        [DllImport("kernel32.dll")] public static extern bool SetProcessInformation(IntPtr process, int infoClass, ref PROCESS_POWER_THROTTLING_STATE info, int size);
        public static void NoThrottling()
        {
            IntPtr me = GetCurrentProcess();
            SetPriorityClass(me, 0x8000 /* ABOVE_NORMAL_PRIORITY_CLASS */);
            try
            {
                PROCESS_POWER_THROTTLING_STATE s = new PROCESS_POWER_THROTTLING_STATE();
                s.Version = 1;
                s.ControlMask = 0x1 /* EXECUTION_SPEED */ | 0x4 /* IGNORE_TIMER_RESOLUTION */;
                s.StateMask = 0; // controlled, and off
                SetProcessInformation(me, 4 /* ProcessPowerThrottling */, ref s, Marshal.SizeOf(typeof(PROCESS_POWER_THROTTLING_STATE)));
            }
            catch (EntryPointNotFoundException) { /* older Windows: no throttling either */ }
        }

        // ---- raw input ----
        public const int WM_INPUT = 0x00FF;
        public const uint RIDEV_INPUTSINK = 0x100, RID_INPUT = 0x10000003;

        [StructLayout(LayoutKind.Sequential)]
        public struct RAWINPUTDEVICE { public ushort usUsagePage, usUsage; public uint dwFlags; public IntPtr hwndTarget; }

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);
        [DllImport("user32.dll")]
        public static extern uint GetRawInputData(IntPtr hRawInput, uint command, IntPtr data, ref uint size, uint headerSize);
    }
}

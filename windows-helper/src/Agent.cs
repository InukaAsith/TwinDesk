// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Full KVM (docs/full-kvm.md), the Full KVM build only: compiled with FULLKVM into
// macshare-winhelper-agent.exe (build.cmd, TWINDESK_EDITION=full-kvm); the normal helpers have none of it.
//
// "--agent": this helper as the Full KVM service starts it (windows/fullkvm/service): as SYSTEM, in
// the console session, so its input reaches UAC prompts, the lock screen, Ctrl+Alt+Del's screen,
// the login screen and windows run as administrator. Every thread of a process starts on the desktop
// the process was started on, and a thread with windows or hooks can't change desktops, so the agent
// belongs to one: the service starts it on the input desktop (Default, Winlogon, Screen-saver). When
// the input desktop is another one (at its start, or later) it says which ("agentDesktop", want) and
// exits with DESKTOP_CHANGED; the service starts another there and gives it the last settings again,
// so the app never sees the switch.
// The parts that aren't the mouse and keyboard (the clipboard, windows, USB, notifications, the cursor
// guard) don't start here: the service only lets the mouse-and-keyboard commands through anyway.
#if FULLKVM
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace MacShare
{
    static class Agent
    {
        public const int DESKTOP_CHANGED = 3;
        public static bool On;
        public static string Desktop = "";

        const uint MAXIMUM_ALLOWED = 0x02000000;
        const int UOI_NAME = 2;
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int length, out int needed);

        // The input desktop's name ("Default", "Winlogon", "Screen-saver"), or "" when it can't be opened.
        public static string InputDesktop()
        {
            IntPtr d = OpenInputDesktop(0, false, MAXIMUM_ALLOWED);
            if (d == IntPtr.Zero) return "";
            try { return NameOf(d); }
            finally { CloseDesktop(d); }
        }

        static string NameOf(IntPtr d)
        {
            StringBuilder sb = new StringBuilder(256);
            int needed;
            return GetUserObjectInformation(d, UOI_NAME, sb, sb.Capacity * 2, out needed) ? sb.ToString() : "";
        }

        [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

        // Before any window or hook: on the input desktop, or off to it.
        public static void Start()
        {
            On = true;
            Desktop = NameOf(GetThreadDesktop(GetCurrentThreadId())); // not closed: the thread's own
            string want = MovedTo();
            if (want != null) Leave(want);
        }

        // The input desktop when it is another one now (a UAC prompt came, the screen was locked or
        // unlocked), else null.
        public static string MovedTo()
        {
            if (!On) return null;
            string now = InputDesktop();
            return now.Length > 0 && !string.Equals(now, Desktop, StringComparison.OrdinalIgnoreCase) ? now : null;
        }

        // Says where to (the service starts the next agent there) and exits. Desktop names are plain words.
        public static void Leave(string want)
        {
            try
            {
                Console.Out.Write("{\"event\":\"agentDesktop\",\"from\":\"" + Clean(Desktop) + "\",\"want\":\"" + Clean(want) + "\"}\n");
                Console.Out.Flush();
            }
            catch (Exception) { }
            System.Threading.Thread.Sleep(50);
            Environment.Exit(DESKTOP_CHANGED);
        }

        static string Clean(string s)
        {
            StringBuilder sb = new StringBuilder();
            foreach (char c in s) if (char.IsLetterOrDigit(c) || c == '-' || c == '_' || c == ' ') sb.Append(c);
            return sb.ToString();
        }
    }
}
#endif

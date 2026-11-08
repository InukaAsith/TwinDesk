// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// USB device plug/unplug events on Windows: RegisterDeviceNotification on a message-only window
// delivers WM_DEVICECHANGE when any USB interface comes or goes; a registry check then says whether
// an ADB phone (WinUSB, ssudadb, AndroidUsbDeviceClass driver) is now present, and
// {"event":"usbAdb","present":true/false} goes to Node. Answers "usbWatch" with the current state so
// shared/usbadb.js can drop its poll. Same interface as mac-helper's UsbWatch.swift.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace MacShare
{
    static class UsbWatch
    {
        const int WM_DEVICECHANGE = 0x0219;
        const int DBT_DEVICEARRIVAL = 0x8000;
        const int DBT_DEVICEREMOVECOMPLETE = 0x8004;
        const int DBT_DEVTYP_DEVICEINTERFACE = 5;

        [StructLayout(LayoutKind.Sequential)]
        struct DEV_BROADCAST_DEVICEINTERFACE
        {
            public int dbcc_size;
            public int dbcc_devicetype;
            public int dbcc_reserved;
            public Guid dbcc_classguid;
        }

        // Any USB device interface (plug/unplug of any USB device).
        static readonly Guid USB_CLASS = new Guid("{A5DCBF10-6530-11D2-901F-00C04FB951ED}");

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr RegisterDeviceNotification(IntPtr hRecipient, ref DEV_BROADCAST_DEVICEINTERFACE filter, int flags);

        static Action<Dictionary<string, object>> emit;
        static bool? last; // last reported value; null = not yet reported
        static readonly object gate = new object();

        // On the UI thread, before Application.Run.
        public static void Init(Action<Dictionary<string, object>> emitter)
        {
            emit = emitter;
            new Sink();
        }

        // Current state; cheap (registry read, no process).
        public static bool Present() { return AdbPresent(); }

        static bool AdbPresent()
        {
            foreach (string svc in new[] { "WinUSB", "ssudadb", "AndroidUsbDeviceClass" })
            {
                try
                {
                    using (RegistryKey k = Registry.LocalMachine.OpenSubKey(
                        @"SYSTEM\CurrentControlSet\Services\" + svc + @"\Enum"))
                    {
                        if (k == null) continue;
                        object v = k.GetValue("Count");
                        if (v != null && Convert.ToInt32(v) > 0) return true;
                    }
                }
                catch (Exception) { }
            }
            return false;
        }

        static void OnChange()
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                bool now = AdbPresent();
                lock (gate)
                {
                    if (last.HasValue && last.Value == now) return;
                    last = now;
                }
                Dictionary<string, object> ev = new Dictionary<string, object>();
                ev["event"] = "usbAdb";
                ev["present"] = now;
                emit(ev);
            });
        }

        class Sink : NativeWindow
        {
            public Sink()
            {
                CreateParams cp = new CreateParams();
                cp.Parent = new IntPtr(-3); // HWND_MESSAGE
                CreateHandle(cp);
                DEV_BROADCAST_DEVICEINTERFACE f = new DEV_BROADCAST_DEVICEINTERFACE();
                f.dbcc_size = Marshal.SizeOf(f);
                f.dbcc_devicetype = DBT_DEVTYP_DEVICEINTERFACE;
                f.dbcc_classguid = USB_CLASS;
                RegisterDeviceNotification(Handle, ref f, 0); // DEVICE_NOTIFY_WINDOW_HANDLE
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == WM_DEVICECHANGE)
                {
                    int w = m.WParam.ToInt32();
                    if (w == DBT_DEVICEARRIVAL || w == DBT_DEVICEREMOVECOMPLETE) OnChange();
                }
                base.WndProc(ref m);
            }
        }
    }
}

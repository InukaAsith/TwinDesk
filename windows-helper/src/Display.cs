// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The monitors as GDI sees them (name, adapter, physical rect) so main can tell the
// virtual PC monitor (Virtual Display Driver) apart, and setting a monitor's resolution.
// Also `--add-root-device <inf> <hwid>` (run elevated by scripts\vdd-install.ps1): creates a
// root-enumerated device and installs the driver on it, like `devcon install`.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace MacShare
{
    static class Display
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct DISPLAY_DEVICE
        {
            public int cb;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
            public int StateFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct DEVMODE
        {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
            public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
            public int dmFields;
            public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
            public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
            public short dmLogPixels;
            public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
            public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern bool EnumDisplayDevices(string device, int index, ref DISPLAY_DEVICE dd, int flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE dm);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern int ChangeDisplaySettingsEx(string device, ref DEVMODE dm, IntPtr hwnd, int flags, IntPtr param);
        [DllImport("user32.dll")]
        static extern int SetDisplayConfig(uint numPaths, IntPtr paths, uint numModes, IntPtr modes, uint flags);

        const int ATTACHED_TO_DESKTOP = 1, ENUM_CURRENT_SETTINGS = -1, CDS_UPDATEREGISTRY = 1;
        const int DM_PELSWIDTH = 0x80000, DM_PELSHEIGHT = 0x100000, DM_DISPLAYFREQUENCY = 0x400000, DM_DISPLAYORIENTATION = 0x80;
        const int DMDO_DEFAULT = 0, DMDO_90 = 1;

        static DEVMODE NewMode()
        {
            DEVMODE dm = new DEVMODE();
            dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
            return dm;
        }

        // Monitors on the desktop: [{name, adapter, monitor, x, y, width, height}] in physical px.
        public static List<object> List()
        {
            List<object> list = new List<object>();
            DISPLAY_DEVICE dd = new DISPLAY_DEVICE();
            dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
            for (int i = 0; EnumDisplayDevices(null, i, ref dd, 0); i++)
            {
                DEVMODE dm = NewMode();
                if ((dd.StateFlags & ATTACHED_TO_DESKTOP) != 0 && EnumDisplaySettings(dd.DeviceName, ENUM_CURRENT_SETTINGS, ref dm))
                {
                    DISPLAY_DEVICE mon = new DISPLAY_DEVICE();
                    mon.cb = dd.cb;
                    string monName = EnumDisplayDevices(dd.DeviceName, 0, ref mon, 0) ? mon.DeviceString : "";
                    Dictionary<string, object> d = new Dictionary<string, object>();
                    d["name"] = dd.DeviceName;
                    d["adapter"] = dd.DeviceString;
                    d["monitor"] = monName;
                    d["x"] = dm.dmPositionX;
                    d["y"] = dm.dmPositionY;
                    d["width"] = dm.dmPelsWidth;
                    d["height"] = dm.dmPelsHeight;
                    list.Add(d);
                }
                dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
            }
            return list;
        }

        // Set a monitor (GDI name) to width × height at its highest refresh rate. False if it has no such mode.
        // A portrait size (height > width) is the landscape mode turned 90°: monitors (the virtual one
        // too) only offer landscape modes, and Windows turns the picture.
        public static bool SetMode(string name, int width, int height)
        {
            DEVMODE cur = NewMode();
            if (!EnumDisplaySettings(name, ENUM_CURRENT_SETTINGS, ref cur)) throw new Exception("no such monitor");
            int orient = height > width ? DMDO_90 : DMDO_DEFAULT;
            if (cur.dmPelsWidth == width && cur.dmPelsHeight == height && cur.dmDisplayOrientation == orient) return true;
            int lw = Math.Max(width, height), lh = Math.Min(width, height); // the landscape mode
            int best = 0;
            DEVMODE m = NewMode();
            for (int i = 0; EnumDisplaySettings(name, i, ref m); i++)
            {
                // Modes are listed as the monitor is turned now: either way round.
                bool fits = (m.dmPelsWidth == lw && m.dmPelsHeight == lh) || (m.dmPelsWidth == lh && m.dmPelsHeight == lw);
                if (fits && m.dmDisplayFrequency > best) best = m.dmDisplayFrequency;
                m = NewMode();
            }
            if (best == 0) return false;
            cur.dmPelsWidth = width;
            cur.dmPelsHeight = height;
            cur.dmDisplayFrequency = best;
            cur.dmDisplayOrientation = orient;
            cur.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY | DM_DISPLAYORIENTATION;
            int r = ChangeDisplaySettingsEx(name, ref cur, IntPtr.Zero, CDS_UPDATEREGISTRY, IntPtr.Zero);
            if (r != 0) throw new Exception("ChangeDisplaySettingsEx " + r);
            return true;
        }

        // Windows remembers a topology per set of monitors, and one saved as Duplicate puts the
        // virtual monitor on another's picture (no desktop of its own, so List() doesn't show it).
        // If the monitor whose id has `monitorId` (its EDID's) shows another one's picture: Win+P ›
        // Extend. True if it did.
        const uint SDC_TOPOLOGY_EXTEND = 0x4, SDC_APPLY = 0x80;
        const int MONITOR_ACTIVE = 1;

        public static bool ExtendIfDuplicated(string monitorId)
        {
            if (string.IsNullOrEmpty(monitorId)) return false;
            DISPLAY_DEVICE dd = new DISPLAY_DEVICE();
            dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
            bool cloned = false;
            for (int i = 0; !cloned && EnumDisplayDevices(null, i, ref dd, 0); i++)
            {
                int active = 0;
                bool ours = false;
                DISPLAY_DEVICE mon = new DISPLAY_DEVICE();
                mon.cb = dd.cb;
                for (int j = 0; EnumDisplayDevices(dd.DeviceName, j, ref mon, 0); j++)
                {
                    if ((mon.StateFlags & MONITOR_ACTIVE) != 0)
                    {
                        active++;
                        if ((mon.DeviceID ?? "").IndexOf(monitorId, StringComparison.OrdinalIgnoreCase) >= 0) ours = true;
                    }
                    mon.cb = dd.cb;
                }
                cloned = ours && active > 1;
                dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
            }
            if (!cloned) return false;
            int r = SetDisplayConfig(0, IntPtr.Zero, 0, IntPtr.Zero, SDC_TOPOLOGY_EXTEND | SDC_APPLY);
            if (r != 0) throw new Exception("SetDisplayConfig " + r);
            return true;
        }

        // ---- root device (elevated, one-shot) ----

        [StructLayout(LayoutKind.Sequential)]
        struct SP_DEVINFO_DATA { public int cbSize; public Guid ClassGuid; public int DevInst; public IntPtr Reserved; }

        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool SetupDiGetINFClass(string inf, out Guid classGuid, StringBuilder className, int size, IntPtr required);
        [DllImport("setupapi.dll", SetLastError = true)]
        static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid classGuid, IntPtr hwnd);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool SetupDiCreateDeviceInfo(IntPtr set, string name, ref Guid classGuid, string desc, IntPtr hwnd, int flags, ref SP_DEVINFO_DATA data);
        [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool SetupDiSetDeviceRegistryProperty(IntPtr set, ref SP_DEVINFO_DATA data, int prop, byte[] buf, int size);
        [DllImport("setupapi.dll", SetLastError = true)]
        static extern bool SetupDiCallClassInstaller(int fn, IntPtr set, ref SP_DEVINFO_DATA data);
        [DllImport("setupapi.dll", SetLastError = true)]
        static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
        [DllImport("newdev.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool UpdateDriverForPlugAndPlayDevices(IntPtr hwnd, string hwid, string inf, int flags, out bool reboot);

        const int DICD_GENERATE_ID = 1, SPDRP_HARDWAREID = 1, DIF_REGISTERDEVICE = 0x19, DIF_REMOVE = 0x05, INSTALLFLAG_FORCE = 1;

        static Exception Win32(string what)
        {
            return new Exception(what + " failed (" + Marshal.GetLastWin32Error() + ")");
        }

        // Exit code 0 = installed. Errors go to stderr.
        public static int AddRootDevice(string inf, string hwid)
        {
            try
            {
                inf = System.IO.Path.GetFullPath(inf);
                Guid cls;
                StringBuilder clsName = new StringBuilder(64);
                if (!SetupDiGetINFClass(inf, out cls, clsName, clsName.Capacity, IntPtr.Zero)) throw Win32("SetupDiGetINFClass");
                IntPtr set = SetupDiCreateDeviceInfoList(ref cls, IntPtr.Zero);
                if (set == new IntPtr(-1)) throw Win32("SetupDiCreateDeviceInfoList");
                try
                {
                    SP_DEVINFO_DATA d = new SP_DEVINFO_DATA();
                    d.cbSize = Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
                    if (!SetupDiCreateDeviceInfo(set, clsName.ToString(), ref cls, null, IntPtr.Zero, DICD_GENERATE_ID, ref d)) throw Win32("SetupDiCreateDeviceInfo");
                    byte[] ids = Encoding.Unicode.GetBytes(hwid + "\0\0"); // REG_MULTI_SZ
                    if (!SetupDiSetDeviceRegistryProperty(set, ref d, SPDRP_HARDWAREID, ids, ids.Length)) throw Win32("SetupDiSetDeviceRegistryProperty");
                    if (!SetupDiCallClassInstaller(DIF_REGISTERDEVICE, set, ref d)) throw Win32("DIF_REGISTERDEVICE");
                    bool reboot;
                    if (!UpdateDriverForPlugAndPlayDevices(IntPtr.Zero, hwid, inf, INSTALLFLAG_FORCE, out reboot))
                    {
                        int err = Marshal.GetLastWin32Error();
                        Console.Error.WriteLine("UpdateDriverForPlugAndPlayDevices failed (" + err + ")");
                        SetupDiCallClassInstaller(DIF_REMOVE, set, ref d); // no half-installed device left behind
                        return err != 0 ? err : 1; // the exit code: vdd-install.ps1 names it (0x800B0109: signature refused)
                    }
                }
                finally { SetupDiDestroyDeviceInfoList(set); }
                return 0;
            }
            catch (Exception e)
            {
                Console.Error.WriteLine(e.Message);
                return 1;
            }
        }
    }
}

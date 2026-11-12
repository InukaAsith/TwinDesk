// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck's way into this PC (shared/deck-sys.js), all in this process: no other program is
// started for any of it (no shell, no script host), only Windows' own APIs.
//   deckAudio -> {outputs: [{id, name, on}], inputs: [...], volume, muted, micVolume, micMuted}
//   deckAudioDefault {id}: that output or input becomes the default (all three roles)
//   deckVolume {input, level?, mute?}: the default output's (or input's) level 0–1 and mute
//   deckBt -> {radio: true|false|null, devices: [{id, name, connected, audio}]}: paired devices
//   deckBtRadio {on}; deckBtConnect {id, on}: an audio device's services on or off (as Settings'
//     Connect and Disconnect do)
//   deckBright -> {displays: [{id, name, level, internal}]}; deckBrightSet {id, level} (id "" = all):
//     the built-in panel through the display driver, external monitors through DDC/CI
//   deckWinFront -> {wid}; deckMinWins -> {windows}: the minimized ones; deckWinFrame {wid, x, y, w, h}: restored, then to that visible frame;
//     deckWinOp {wid, op: min|max|close|restore}
//   deckSys {what: lock|sleep|screenoff|darkmode|dnd, on?}
//   deckApps -> {apps: [{id, name}]}: the Start menu's apps; deckAppOpen {id}: opened by the shell
// C# 5 (build.cmd).
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace MacShare
{
    static class DeckSys
    {
        // ---- Core Audio ----
        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }
        [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceEnumerator
        {
            [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IMMDeviceCollection devices);
            [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
        }
        [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceCollection
        {
            [PreserveSig] int GetCount(out int n);
            [PreserveSig] int Item(int i, out IMMDevice device);
        }
        [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDevice
        {
            [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
            [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
            [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        }
        [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IPropertyStore
        {
            [PreserveSig] int GetCount(out uint n);
            [PreserveSig] int GetAt(uint i, out PROPERTYKEY k);
            [PreserveSig] int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
        }
        [StructLayout(LayoutKind.Sequential, Pack = 4)] struct PROPERTYKEY { public Guid fmtid; public uint pid; }
        [StructLayout(LayoutKind.Sequential)] struct PROPVARIANT { public ushort vt; ushort r1, r2, r3; public IntPtr p; IntPtr p2; }
        [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT v);
        [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioEndpointVolume
        {
            [PreserveSig] int RegisterControlChangeNotify(IntPtr p);
            [PreserveSig] int UnregisterControlChangeNotify(IntPtr p);
            [PreserveSig] int GetChannelCount(out uint n);
            [PreserveSig] int SetMasterVolumeLevel(float db, ref Guid ctx);
            [PreserveSig] int SetMasterVolumeLevelScalar(float l, ref Guid ctx);
            [PreserveSig] int GetMasterVolumeLevel(out float db);
            [PreserveSig] int GetMasterVolumeLevelScalar(out float l);
            [PreserveSig] int SetChannelVolumeLevel(uint ch, float db, ref Guid ctx);
            [PreserveSig] int SetChannelVolumeLevelScalar(uint ch, float l, ref Guid ctx);
            [PreserveSig] int GetChannelVolumeLevel(uint ch, out float db);
            [PreserveSig] int GetChannelVolumeLevelScalar(uint ch, out float l);
            [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
            [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
        }
        // The default device: Windows' own policy interface (what the Sound settings use).
        [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")] class PolicyConfigCom { }
        [Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IPolicyConfig
        {
            [PreserveSig] int GetMixFormat(string id, IntPtr f);
            [PreserveSig] int GetDeviceFormat(string id, int d, IntPtr f);
            [PreserveSig] int ResetDeviceFormat(string id);
            [PreserveSig] int SetDeviceFormat(string id, IntPtr a, IntPtr b);
            [PreserveSig] int GetProcessingPeriod(string id, int d, IntPtr a, IntPtr b);
            [PreserveSig] int SetProcessingPeriod(string id, IntPtr p);
            [PreserveSig] int GetShareMode(string id, IntPtr m);
            [PreserveSig] int SetShareMode(string id, IntPtr m);
            [PreserveSig] int GetPropertyValue(string id, IntPtr k, IntPtr v);
            [PreserveSig] int SetPropertyValue(string id, IntPtr k, IntPtr v);
            [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
            [PreserveSig] int SetEndpointVisibility(string id, int visible);
        }
        const int eRender = 0, eCapture = 1, eMultimedia = 1, DEVICE_STATE_ACTIVE = 1, CLSCTX_ALL = 23;
        static readonly Guid FriendlyName = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0");

        static IMMDeviceEnumerator Enumerator() { return (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom()); }

        static string Name(IMMDevice d)
        {
            IPropertyStore s;
            if (d.OpenPropertyStore(0, out s) != 0 || s == null) return "";
            PROPERTYKEY k = new PROPERTYKEY();
            k.fmtid = FriendlyName;
            k.pid = 14;
            PROPVARIANT v;
            if (s.GetValue(ref k, out v) != 0) return "";
            string name = v.vt == 31 ? Marshal.PtrToStringUni(v.p) : "";
            PropVariantClear(ref v);
            return name ?? "";
        }

        static string IdOf(IMMDevice d) { string id; return d != null && d.GetId(out id) == 0 ? id : ""; }

        static IMMDevice Default(int flow)
        {
            IMMDevice d;
            return Enumerator().GetDefaultAudioEndpoint(flow, eMultimedia, out d) == 0 ? d : null;
        }

        static IAudioEndpointVolume Volume(IMMDevice d)
        {
            if (d == null) return null;
            Guid iid = typeof(IAudioEndpointVolume).GUID;
            object o;
            return d.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o) == 0 ? o as IAudioEndpointVolume : null;
        }

        static List<object> Endpoints(int flow)
        {
            List<object> list = new List<object>();
            IMMDeviceCollection c;
            if (Enumerator().EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, out c) != 0 || c == null) return list;
            string def = IdOf(Default(flow));
            int n;
            c.GetCount(out n);
            for (int i = 0; i < n; i++)
            {
                IMMDevice d;
                if (c.Item(i, out d) != 0 || d == null) continue;
                Dictionary<string, object> x = new Dictionary<string, object>();
                x["id"] = IdOf(d);
                x["name"] = Name(d);
                x["on"] = IdOf(d) == def;
                list.Add(x);
            }
            return list;
        }

        public static void Audio(Dictionary<string, object> r)
        {
            r["outputs"] = Endpoints(eRender);
            r["inputs"] = Endpoints(eCapture);
            IAudioEndpointVolume o = Volume(Default(eRender)), i = Volume(Default(eCapture));
            float l; bool m;
            if (o != null && o.GetMasterVolumeLevelScalar(out l) == 0) r["volume"] = Math.Round(l, 3);
            if (o != null && o.GetMute(out m) == 0) r["muted"] = m;
            if (i != null && i.GetMasterVolumeLevelScalar(out l) == 0) r["micVolume"] = Math.Round(l, 3);
            if (i != null && i.GetMute(out m) == 0) r["micMuted"] = m;
        }

        public static void AudioDefault(string id)
        {
            if (string.IsNullOrEmpty(id)) throw new Exception("No such sound device");
            IPolicyConfig p = (IPolicyConfig)(new PolicyConfigCom());
            for (int role = 0; role < 3; role++)
            {
                int hr = p.SetDefaultEndpoint(id, role);
                if (hr != 0) throw new Exception("Windows didn’t switch the sound device");
            }
        }

        public static void SetVolume(Dictionary<string, object> c)
        {
            IAudioEndpointVolume v = Volume(Default(Json.Bool(c, "input", false) ? eCapture : eRender));
            if (v == null) throw new Exception(Json.Bool(c, "input", false) ? "No microphone" : "No sound output");
            Guid ctx = Guid.Empty;
            if (Json.Has(c, "level")) v.SetMasterVolumeLevelScalar((float)Math.Max(0, Math.Min(1, Json.Num(c, "level", 0))), ref ctx);
            if (Json.Has(c, "mute")) v.SetMute(Json.Bool(c, "mute", false), ref ctx);
        }

        // ---- Bluetooth (classic): the paired devices and their services ----
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct SYSTEMTIME { public ushort y, mo, dw, d, h, mi, s, ms; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct BLUETOOTH_DEVICE_INFO
        {
            public int dwSize; public ulong Address; public uint ulClassofDevice;
            [MarshalAs(UnmanagedType.Bool)] public bool fConnected;
            [MarshalAs(UnmanagedType.Bool)] public bool fRemembered;
            [MarshalAs(UnmanagedType.Bool)] public bool fAuthenticated;
            public SYSTEMTIME stLastSeen, stLastUsed;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 248)] public string szName;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct BLUETOOTH_DEVICE_SEARCH_PARAMS
        {
            public int dwSize;
            [MarshalAs(UnmanagedType.Bool)] public bool fReturnAuthenticated, fReturnRemembered, fReturnUnknown, fReturnConnected, fIssueInquiry;
            public byte cTimeoutMultiplier; public IntPtr hRadio;
        }
        [DllImport("bthprops.cpl", SetLastError = true)] static extern IntPtr BluetoothFindFirstDevice(ref BLUETOOTH_DEVICE_SEARCH_PARAMS p, ref BLUETOOTH_DEVICE_INFO info);
        [DllImport("bthprops.cpl", SetLastError = true)] static extern bool BluetoothFindNextDevice(IntPtr find, ref BLUETOOTH_DEVICE_INFO info);
        [DllImport("bthprops.cpl")] static extern bool BluetoothFindDeviceClose(IntPtr find);
        [DllImport("bthprops.cpl")] static extern int BluetoothSetServiceState(IntPtr radio, ref BLUETOOTH_DEVICE_INFO info, ref Guid service, uint flags);
        // A2DP sink, AVRCP (both), hands-free and headset: what an audio device connects with.
        static readonly Guid[] AudioServices = {
            new Guid("0000110B-0000-1000-8000-00805F9B34FB"), new Guid("0000110E-0000-1000-8000-00805F9B34FB"),
            new Guid("0000110C-0000-1000-8000-00805F9B34FB"), new Guid("0000111E-0000-1000-8000-00805F9B34FB"),
            new Guid("00001108-0000-1000-8000-00805F9B34FB"),
        };

        static List<BLUETOOTH_DEVICE_INFO> Paired()
        {
            List<BLUETOOTH_DEVICE_INFO> list = new List<BLUETOOTH_DEVICE_INFO>();
            BLUETOOTH_DEVICE_SEARCH_PARAMS p = new BLUETOOTH_DEVICE_SEARCH_PARAMS();
            p.dwSize = Marshal.SizeOf(typeof(BLUETOOTH_DEVICE_SEARCH_PARAMS));
            p.fReturnAuthenticated = true; p.fReturnRemembered = true; p.fReturnConnected = true;
            BLUETOOTH_DEVICE_INFO info = new BLUETOOTH_DEVICE_INFO();
            info.dwSize = Marshal.SizeOf(typeof(BLUETOOTH_DEVICE_INFO));
            IntPtr f = BluetoothFindFirstDevice(ref p, ref info);
            if (f == IntPtr.Zero) return list;
            try
            {
                do
                {
                    if (info.fAuthenticated || info.fRemembered) list.Add(info);
                    info = new BLUETOOTH_DEVICE_INFO();
                    info.dwSize = Marshal.SizeOf(typeof(BLUETOOTH_DEVICE_INFO));
                } while (BluetoothFindNextDevice(f, ref info));
            }
            finally { BluetoothFindDeviceClose(f); }
            return list;
        }

        static bool IsAudio(uint cod) { return ((cod >> 8) & 0x1F) == 0x04; } // the major class Audio/Video

        public static void Bt(Dictionary<string, object> r)
        {
            List<object> devices = new List<object>();
            foreach (BLUETOOTH_DEVICE_INFO d in Paired())
            {
                Dictionary<string, object> x = new Dictionary<string, object>();
                x["id"] = d.Address.ToString("X12");
                x["name"] = d.szName ?? "";
                x["connected"] = d.fConnected;
                x["audio"] = IsAudio(d.ulClassofDevice);
                devices.Add(x);
            }
            r["devices"] = devices;
            r["radio"] = Radio();
        }

        public static void BtConnect(string id, bool on)
        {
            foreach (BLUETOOTH_DEVICE_INFO d in Paired())
            {
                if (d.Address.ToString("X12") != (id ?? "").ToUpperInvariant()) continue;
                BLUETOOTH_DEVICE_INFO info = d;
                int ok = 0;
                foreach (Guid g in AudioServices)
                {
                    Guid s = g;
                    if (BluetoothSetServiceState(IntPtr.Zero, ref info, ref s, on ? 1u : 0u) == 0) ok++;
                }
                if (ok == 0) throw new Exception(on ? "Windows couldn’t connect " + d.szName + " (is it on and nearby?)" : "Windows couldn’t disconnect " + d.szName);
                return;
            }
            throw new Exception("That Bluetooth device isn’t paired with this PC");
        }

        // The radio, through WinRT's Radio API (no administrator rights needed): null when there's none.
        static object Radio()
        {
            try
            {
                foreach (Windows.Devices.Radios.Radio r in Windows.Devices.Radios.Radio.GetRadiosAsync().AsTask().Result)
                    if (r.Kind == Windows.Devices.Radios.RadioKind.Bluetooth) return r.State == Windows.Devices.Radios.RadioState.On;
            }
            catch (Exception) { }
            return null;
        }

        public static void BtRadio(bool on)
        {
            foreach (Windows.Devices.Radios.Radio r in Windows.Devices.Radios.Radio.GetRadiosAsync().AsTask().Result)
            {
                if (r.Kind != Windows.Devices.Radios.RadioKind.Bluetooth) continue;
                Windows.Devices.Radios.RadioAccessStatus s = r.SetStateAsync(on ? Windows.Devices.Radios.RadioState.On : Windows.Devices.Radios.RadioState.Off).AsTask().Result;
                if (s != Windows.Devices.Radios.RadioAccessStatus.Allowed) throw new Exception("Windows didn’t allow turning Bluetooth " + (on ? "on" : "off"));
                return;
            }
            throw new Exception("This PC has no Bluetooth");
        }

        // ---- Brightness ----
        // The built-in panel: the display driver's brightness (\\.\LCD).
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool DeviceIoControl(IntPtr h, uint code, byte[] inBuf, int inSize, byte[] outBuf, int outSize, out int got, IntPtr ov);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        const uint IOCTL_QUERY_SUPPORTED = 0x23049C, IOCTL_QUERY = 0x230498, IOCTL_SET = 0x2304A4;
        static readonly IntPtr INVALID = new IntPtr(-1);

        static IntPtr Lcd() { return CreateFile("\\\\.\\LCD", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero); }

        // The levels the panel has (0–100 in steps it chooses); null without a built-in panel.
        static byte[] PanelLevels(IntPtr h)
        {
            byte[] buf = new byte[256];
            int got;
            if (!DeviceIoControl(h, IOCTL_QUERY_SUPPORTED, null, 0, buf, buf.Length, out got, IntPtr.Zero) || got == 0) return null;
            byte[] levels = new byte[got];
            Array.Copy(buf, levels, got);
            Array.Sort(levels);
            return levels;
        }

        static int PanelGet()
        {
            IntPtr h = Lcd();
            if (h == INVALID) return -1;
            try
            {
                if (PanelLevels(h) == null) return -1;
                byte[] o = new byte[3];
                int got;
                if (!DeviceIoControl(h, IOCTL_QUERY, null, 0, o, 3, out got, IntPtr.Zero)) return -1;
                return o[1]; // the AC level (the one in use on mains; DC on battery is o[2])
            }
            finally { CloseHandle(h); }
        }

        static void PanelSet(int level)
        {
            IntPtr h = Lcd();
            if (h == INVALID) throw new Exception("No built-in display");
            try
            {
                byte[] levels = PanelLevels(h);
                if (levels == null) throw new Exception("No built-in display");
                byte best = levels[0];
                foreach (byte b in levels) if (Math.Abs(b - level) < Math.Abs(best - level)) best = b;
                byte[] i = new byte[] { 3, best, best }; // both AC and DC
                int got;
                if (!DeviceIoControl(h, IOCTL_SET, i, 3, null, 0, out got, IntPtr.Zero)) throw new Win32Exception();
            }
            finally { CloseHandle(h); }
        }

        // External monitors: DDC/CI through dxva2 (VCP 0x10, luminance).
        delegate bool MonitorProc(IntPtr mon, IntPtr hdc, IntPtr rect, IntPtr data);
        [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorProc fn, IntPtr data);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct PHYSICAL_MONITOR { public IntPtr h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string desc; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct MONITORINFOEX { public int cbSize; public int l, t, r, b, wl, wt, wr, wb; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dev; }
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr mon, ref MONITORINFOEX info);
        [DllImport("dxva2.dll")] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr mon, out uint n);
        [DllImport("dxva2.dll")] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr mon, uint n, [Out] PHYSICAL_MONITOR[] arr);
        [DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitors(uint n, PHYSICAL_MONITOR[] arr);
        [DllImport("dxva2.dll")] static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr h, byte code, IntPtr type, out uint cur, out uint max);
        [DllImport("dxva2.dll")] static extern bool SetVCPFeature(IntPtr h, byte code, uint value);

        // Each monitor's physical monitors, with the display's device name ("\\.\DISPLAY2") as id.
        static void EachExternal(Action<string, int, PHYSICAL_MONITOR> fn)
        {
            List<IntPtr> mons = new List<IntPtr>();
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr m, IntPtr hdc, IntPtr rc, IntPtr d) { mons.Add(m); return true; }, IntPtr.Zero);
            foreach (IntPtr m in mons)
            {
                MONITORINFOEX mi = new MONITORINFOEX();
                mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
                GetMonitorInfo(m, ref mi);
                uint n;
                if (!GetNumberOfPhysicalMonitorsFromHMONITOR(m, out n) || n == 0) continue;
                PHYSICAL_MONITOR[] arr = new PHYSICAL_MONITOR[n];
                if (!GetPhysicalMonitorsFromHMONITOR(m, n, arr)) continue;
                try { for (int i = 0; i < arr.Length; i++) fn(mi.dev ?? "", i, arr[i]); }
                finally { DestroyPhysicalMonitors(n, arr); }
            }
        }

        public static void Bright(Dictionary<string, object> r)
        {
            List<object> list = new List<object>();
            int panel = PanelGet();
            if (panel >= 0)
            {
                Dictionary<string, object> x = new Dictionary<string, object>();
                x["id"] = "internal"; x["name"] = "Built-in display"; x["level"] = panel / 100.0; x["internal"] = true;
                list.Add(x);
            }
            EachExternal(delegate (string dev, int i, PHYSICAL_MONITOR pm)
            {
                uint cur, max;
                if (!GetVCPFeatureAndVCPFeatureReply(pm.h, 0x10, IntPtr.Zero, out cur, out max) || max == 0) return; // no DDC/CI (or it's off on the monitor)
                Dictionary<string, object> x = new Dictionary<string, object>();
                x["id"] = dev + "#" + i;
                x["name"] = string.IsNullOrEmpty(pm.desc) || pm.desc == "Generic PnP Monitor" ? "Display " + dev.Replace("\\\\.\\DISPLAY", "") : pm.desc;
                x["level"] = Math.Round((double)cur / max, 3);
                x["internal"] = false;
                list.Add(x);
            });
            r["displays"] = list;
        }

        public static void BrightSet(string id, double level)
        {
            int pct = (int)Math.Round(Math.Max(0, Math.Min(1, level)) * 100);
            bool any = false;
            if (string.IsNullOrEmpty(id) || id == "internal")
            {
                try { PanelSet(pct); any = true; } catch (Exception) { if (id == "internal") throw; }
            }
            if (id != "internal")
            {
                EachExternal(delegate (string dev, int i, PHYSICAL_MONITOR pm)
                {
                    if (!string.IsNullOrEmpty(id) && id != dev + "#" + i) return;
                    uint cur, max;
                    if (!GetVCPFeatureAndVCPFeatureReply(pm.h, 0x10, IntPtr.Zero, out cur, out max) || max == 0) return;
                    if (SetVCPFeature(pm.h, 0x10, (uint)Math.Round(pct / 100.0 * max))) any = true;
                });
            }
            if (!any) throw new Exception("No display here lets Windows change its brightness (turn on DDC/CI in the monitor’s menu)");
        }

        // ---- Windows ----
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }

        static IntPtr Win(double wid)
        {
            IntPtr h = wid == 0 ? GetAncestor(GetForegroundWindow(), 2) : new IntPtr((long)wid);
            if (h == IntPtr.Zero || !IsWindow(h)) throw new Exception("No window in front");
            return h;
        }

        public static long Front() { IntPtr h = GetAncestor(GetForegroundWindow(), 2); return h.ToInt64(); }

        // x, y, w, h: the visible frame (as AppWindows.List gives it); the invisible borders are added back.
        public static void Frame(double wid, int x, int y, int w, int h)
        {
            IntPtr hw = Win(wid);
            if (IsZoomed(hw) || IsIconic(hw)) ShowWindow(hw, 9); // SW_RESTORE: a maximized window doesn't move
            RECT outer, vis;
            GetWindowRect(hw, out outer);
            if (DwmGetWindowAttribute(hw, 9, out vis, Marshal.SizeOf(typeof(RECT))) != 0) vis = outer;
            int dl = vis.left - outer.left, dt = vis.top - outer.top, dr = outer.right - vis.right, db = outer.bottom - vis.bottom;
            SetWindowPos(hw, IntPtr.Zero, x - dl, y - dt, Math.Max(100, w) + dl + dr, Math.Max(60, h) + dt + db, 0x0004 | 0x0040); // NOZORDER, SHOWWINDOW
            AppWindows.Raise(hw.ToInt64());
        }

        public static void Op(double wid, string op)
        {
            IntPtr h = Win(wid);
            switch (op)
            {
                case "min": ShowWindow(h, 6); break;
                case "max": ShowWindow(h, IsZoomed(h) ? 9 : 3); break;
                case "restore": ShowWindow(h, 9); AppWindows.Raise(h.ToInt64()); break;
                case "close": PostMessage(h, 0x10, IntPtr.Zero, IntPtr.Zero); break;
                default: throw new Exception("Not a window action");
            }
        }

        // ---- System ----
        [DllImport("user32.dll")] static extern bool LockWorkStation();
        [DllImport("powrprof.dll")] static extern bool SetSuspendState(bool hibernate, bool force, bool wakeOff);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, string l, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
        const string Personalize = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
        const string Toasts = @"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings";

        public static void Sys(string what, Dictionary<string, object> c, Dictionary<string, object> r)
        {
            IntPtr res;
            switch (what)
            {
                case "lock": if (!LockWorkStation()) throw new Win32Exception(); break;
                case "sleep": SetSuspendState(false, false, false); break;
                case "screenoff": // the screens off until the mouse or a key wakes them
                    SendMessageTimeout(new IntPtr(0xFFFF), 0x0112, new IntPtr(0xF170), new IntPtr(2), 2, 1000, out res);
                    break;
                case "darkmode":
                    {
                        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(Personalize))
                        {
                            object v = k.GetValue("AppsUseLightTheme", 1);
                            int light = Convert.ToInt32(v) == 0 ? 1 : 0;
                            k.SetValue("AppsUseLightTheme", light, RegistryValueKind.DWord);
                            k.SetValue("SystemUsesLightTheme", light, RegistryValueKind.DWord);
                            r["on"] = light == 0;
                        }
                        SendMessageTimeout(new IntPtr(0xFFFF), 0x001A, IntPtr.Zero, "ImmersiveColorSet", 2, 1000, out res);
                        break;
                    }
                case "dnd":
                    using (RegistryKey k = Registry.CurrentUser.CreateSubKey(Toasts))
                    {
                        bool on = Json.Has(c, "on") ? Json.Bool(c, "on", false) : Convert.ToInt32(k.GetValue("NOC_GLOBAL_SETTING_TOASTS_ENABLED", 1)) != 0;
                        k.SetValue("NOC_GLOBAL_SETTING_TOASTS_ENABLED", on ? 0 : 1, RegistryValueKind.DWord);
                        r["on"] = on;
                    }
                    break;
                default: throw new Exception("Not on this PC");
            }
        }

        public static Dictionary<string, object> State()
        {
            Dictionary<string, object> r = new Dictionary<string, object>();
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(Personalize))
                r["dark"] = k != null && Convert.ToInt32(k.GetValue("AppsUseLightTheme", 1)) == 0;
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(Toasts))
                r["dnd"] = k != null && Convert.ToInt32(k.GetValue("NOC_GLOBAL_SETTING_TOASTS_ENABLED", 1)) == 0;
            return r;
        }

        // ---- Apps: the Start menu's, through the shell's own Apps folder (STA) ----
        public static List<object> Apps()
        {
            List<object> list = new List<object>();
            Type t = Type.GetTypeFromProgID("Shell.Application");
            object shell = Activator.CreateInstance(t);
            try
            {
                object folder = t.InvokeMember("NameSpace", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { "shell:AppsFolder" });
                if (folder == null) return list;
                object items = folder.GetType().InvokeMember("Items", System.Reflection.BindingFlags.InvokeMethod, null, folder, null);
                int n = (int)items.GetType().InvokeMember("Count", System.Reflection.BindingFlags.GetProperty, null, items, null);
                HashSet<string> seen = new HashSet<string>();
                for (int i = 0; i < n; i++)
                {
                    object it = items.GetType().InvokeMember("Item", System.Reflection.BindingFlags.InvokeMethod, null, items, new object[] { i });
                    if (it == null) continue;
                    string name = Convert.ToString(it.GetType().InvokeMember("Name", System.Reflection.BindingFlags.GetProperty, null, it, null));
                    string path = Convert.ToString(it.GetType().InvokeMember("Path", System.Reflection.BindingFlags.GetProperty, null, it, null));
                    if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(path) || !seen.Add(path)) continue;
                    if (path.StartsWith("http", StringComparison.OrdinalIgnoreCase)) continue; // web links in the Start menu
                    Dictionary<string, object> x = new Dictionary<string, object>();
                    x["id"] = path;
                    x["name"] = name;
                    list.Add(x);
                }
            }
            finally { Marshal.FinalReleaseComObject(shell); }
            list.Sort(delegate (object a, object b) { return string.Compare((string)((Dictionary<string, object>)a)["name"], (string)((Dictionary<string, object>)b)["name"], StringComparison.CurrentCultureIgnoreCase); });
            return list;
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr ShellExecute(IntPtr hwnd, string verb, string file, string args, string dir, int show);

        // One of Apps()' ids, opened by the shell as the Start menu opens it (only ids it lists).
        public static void AppOpen(string id)
        {
            bool known = false;
            foreach (object o in Apps()) if ((string)((Dictionary<string, object>)o)["id"] == id) { known = true; break; }
            if (!known) throw new Exception("No such app on this PC");
            if (ShellExecute(IntPtr.Zero, "open", "shell:AppsFolder\\" + id, null, null, 1).ToInt64() <= 32)
                throw new Exception("Windows couldn’t open it");
        }

        public static void Dispatch(string cmd, Dictionary<string, object> c, Dictionary<string, object> r)
        {
            switch (cmd)
            {
                case "deckAudio": Audio(r); break;
                case "deckAudioDefault": AudioDefault(Json.Str(c, "dev", "")); break;
                case "deckVolume": SetVolume(c); break;
                case "deckBt": Bt(r); break;
                case "deckBtRadio": BtRadio(Json.Bool(c, "on", true)); break;
                case "deckBtConnect": BtConnect(Json.Str(c, "dev", ""), Json.Bool(c, "on", true)); break;
                case "deckBright": Bright(r); break;
                case "deckBrightSet": BrightSet(Json.Str(c, "dev", ""), Json.Num(c, "level", 0.5)); break;
                case "deckWinFront": r["wid"] = Front(); break;
                case "deckMinWins": r["windows"] = AppWindows.List(true); break;
                case "deckWinFrame": Frame(Json.Num(c, "wid", 0), (int)Json.Num(c, "x", 0), (int)Json.Num(c, "y", 0), (int)Json.Num(c, "w", 800), (int)Json.Num(c, "h", 600)); break;
                case "deckWinOp": Op(Json.Num(c, "wid", 0), Json.Str(c, "op", "")); break;
                case "deckSys": Sys(Json.Str(c, "what", ""), c, r); break;
                case "deckState": foreach (KeyValuePair<string, object> kv in State()) r[kv.Key] = kv.Value; break;
                case "deckApps": r["apps"] = Apps(); break;
                case "deckAppOpen": AppOpen(Json.Str(c, "dev", "")); break;
                default: throw new Exception("unknown");
            }
        }
    }
}

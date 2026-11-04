// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Wi-Fi low-latency mode: while the cursor is shared or a screen is shown,
// Windows' media streaming mode is on and its background scans are off on every connected Wi-Fi
// adapter. A background scan takes the radio off the channel for tens of milliseconds, which is
// the lag spike every few seconds that Wi-Fi input has.
//   wifiLowLatency {on} -> {applied: adapters set}
// The settings belong to our WLAN handle: closing it (off, or the helper gone, even by a crash)
// gives Windows its own settings back. Errors are ignored (no Wi-Fi, the service off).
using System;
using System.Runtime.InteropServices;

namespace MacShare
{
    static class Wlan
    {
        const int OPCODE_BACKGROUND_SCAN = 2; // wlan_intf_opcode_background_scan_enabled
        const int OPCODE_MEDIA_STREAMING = 3; // wlan_intf_opcode_media_streaming_mode
        const int STATE_CONNECTED = 1; // wlan_interface_state_connected
        const int INFO_SIZE = 16 + 512 + 4; // WLAN_INTERFACE_INFO: GUID, WCHAR[256], state

        [DllImport("wlanapi.dll")]
        static extern int WlanOpenHandle(uint clientVersion, IntPtr reserved, out uint negotiated, out IntPtr handle);

        [DllImport("wlanapi.dll")]
        static extern int WlanCloseHandle(IntPtr handle, IntPtr reserved);

        [DllImport("wlanapi.dll")]
        static extern int WlanEnumInterfaces(IntPtr handle, IntPtr reserved, out IntPtr list);

        [DllImport("wlanapi.dll")]
        static extern int WlanSetInterface(IntPtr handle, ref Guid iface, int opCode, uint dataSize, IntPtr data, IntPtr reserved);

        [DllImport("wlanapi.dll")]
        static extern void WlanFreeMemory(IntPtr memory);

        static readonly object gate = new object();
        static IntPtr handle = IntPtr.Zero;

        // On: a handle with the settings on each connected adapter (again each time: a new network
        // since). Off: the handle closed, Windows' settings back. Returns how many adapters took it.
        public static int Set(bool on)
        {
            lock (gate)
            {
                if (!on)
                {
                    Close();
                    return 0;
                }
                try
                {
                    if (handle == IntPtr.Zero)
                    {
                        uint negotiated;
                        IntPtr h;
                        if (WlanOpenHandle(2, IntPtr.Zero, out negotiated, out h) != 0) return 0;
                        handle = h;
                    }
                    return Apply();
                }
                catch (Exception) // no wlanapi.dll (Server without the Wireless LAN service)
                {
                    Close();
                    return 0;
                }
            }
        }

        static int Apply()
        {
            IntPtr list;
            if (WlanEnumInterfaces(handle, IntPtr.Zero, out list) != 0 || list == IntPtr.Zero) return 0;
            int applied = 0;
            IntPtr on = Marshal.AllocHGlobal(4);
            IntPtr off = Marshal.AllocHGlobal(4);
            try
            {
                Marshal.WriteInt32(on, 1);
                Marshal.WriteInt32(off, 0);
                int n = Marshal.ReadInt32(list, 0);
                for (int i = 0; i < n; i++)
                {
                    IntPtr info = new IntPtr(list.ToInt64() + 8 + (long)i * INFO_SIZE);
                    if (Marshal.ReadInt32(info, 16 + 512) != STATE_CONNECTED) continue;
                    byte[] g = new byte[16];
                    Marshal.Copy(info, g, 0, 16);
                    Guid guid = new Guid(g);
                    bool ok = WlanSetInterface(handle, ref guid, OPCODE_MEDIA_STREAMING, 4, on, IntPtr.Zero) == 0;
                    ok = WlanSetInterface(handle, ref guid, OPCODE_BACKGROUND_SCAN, 4, off, IntPtr.Zero) == 0 || ok;
                    if (ok) applied++;
                }
            }
            finally
            {
                Marshal.FreeHGlobal(on);
                Marshal.FreeHGlobal(off);
                WlanFreeMemory(list);
            }
            return applied;
        }

        static void Close()
        {
            if (handle == IntPtr.Zero) return;
            try { WlanCloseHandle(handle, IntPtr.Zero); } catch (Exception) { }
            handle = IntPtr.Zero;
        }
    }
}

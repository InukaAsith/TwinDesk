// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A Wi-Fi network for the other device to join (files and screens for a session through Bluetooth,
// shared/netlink.js): Wi-Fi Direct's "legacy" access point, which any device joins like any Wi-Fi
// (a Mac, a phone, another PC) while this PC stays on its own Wi-Fi. Also for joining one (wifi.js):
// the Wi-Fi radio (on while hosting or joining), the network it's on, and Location (since Windows
// 11 24H2 netsh's Wi-Fi details need it, and netsh, in System32, never gets Windows' prompt for it).
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Windows.Devices.Enumeration;
using Windows.Devices.Radios;
using Windows.Devices.WiFi;
using Windows.Devices.WiFiDirect;
using Windows.Networking.Connectivity;
using Windows.Security.Credentials;

namespace MacShare
{
    class WfdHost
    {
        // Network adapters; Windows adds "Wi-Fi Direct Virtual Adapter" ones (…#vwifimp_wfd#…) only
        // for a Wi-Fi driver that does Wi-Fi Direct, and keeps them while Wi-Fi is off.
        // (WiFiDirectDevice.GetDeviceSelector() lists paired Wi-Fi Direct devices, not this PC's.)
        const string NetAdapters = "System.Devices.InterfaceClassGuid:=\"{CAC88484-7515-4C03-82E6-71A87ABAC361}\" AND System.Devices.InterfaceEnabled:=System.StructuredQueryType.Boolean#True";

        WiFiDirectAdvertisementPublisher pub;

        // host: it can host; wifi: it has Wi-Fi (joins).
        public async Task<Dictionary<string, object>> Caps()
        {
            bool wfd = false;
            try
            {
                foreach (DeviceInformation d in await DeviceInformation.FindAllAsync(NetAdapters))
                    if (d.Id.IndexOf("#vwifimp_wfd#", StringComparison.OrdinalIgnoreCase) >= 0) wfd = true;
            }
            catch (Exception e) { Net.Log("wfd adapters: " + e.Message); }
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["host"] = wfd;
            r["wifi"] = wfd || await WifiRadio() != null;
            return r;
        }

        static async Task<Radio> WifiRadio()
        {
            try
            {
                foreach (Radio r in await Radio.GetRadiosAsync()) if (r.Kind == RadioKind.WiFi) return r;
            }
            catch (Exception e) { Net.Log("radios: " + e.Message); }
            return null;
        }

        // Wi-Fi on or off (Windows' Wi-Fi switch): what it was, "on" | "off".
        public async Task<string> SetRadio(bool on)
        {
            Radio r = await WifiRadio();
            if (r == null) throw new Exception("this PC has no Wi-Fi");
            string was = r.State == RadioState.On ? "on" : "off";
            if ((r.State == RadioState.On) == on) return was;
            if (r.State == RadioState.Disabled) throw new Exception("Wi-Fi is switched off on this PC (its switch or key)");
            if (await Radio.RequestAccessAsync() != RadioAccessStatus.Allowed || await r.SetStateAsync(on ? RadioState.On : RadioState.Off) != RadioAccessStatus.Allowed)
                throw new Exception(on ? "Wi-Fi is off and Windows didn’t let TwinDesk switch it on" : "Windows didn’t let TwinDesk switch Wi-Fi off");
            for (int i = 0; i < 50 && (r.State == RadioState.On) != on; i++) await Task.Delay(100);
            if (on && r.State != RadioState.On) throw new Exception("Wi-Fi didn’t switch on");
            if (on) await Task.Delay(1500); // the adapter comes up after the radio
            Net.Log("wifi " + (on ? "on" : "off"));
            return was;
        }

        // Asks for Location for Wi-Fi (Windows' prompt, once per app): "allowed" | "denied" | "unspecified".
        public async Task<string> Location()
        {
            WiFiAccessStatus s = await WiFiAdapter.RequestAccessAsync();
            return s == WiFiAccessStatus.Allowed ? "allowed" : s == WiFiAccessStatus.Unspecified ? "unspecified" : "denied";
        }

        // The Wi-Fi network this PC is on ("" = none), which Windows tells without Location this way.
        public string Ssid()
        {
            foreach (ConnectionProfile p in NetworkInformation.GetConnectionProfiles())
            {
                if (!p.IsWlanConnectionProfile || p.GetNetworkConnectivityLevel() == NetworkConnectivityLevel.None) continue;
                string s = p.WlanConnectionProfileDetails.GetConnectedSsid();
                if (!string.IsNullOrEmpty(s)) return s;
            }
            return "";
        }

        public async Task Start(string ssid, string pass)
        {
            Stop();
            WiFiDirectAdvertisementPublisher p = new WiFiDirectAdvertisementPublisher();
            p.Advertisement.IsAutonomousGroupOwnerEnabled = true;
            p.Advertisement.LegacySettings.IsEnabled = true;
            p.Advertisement.LegacySettings.Ssid = ssid;
            PasswordCredential cred = new PasswordCredential();
            cred.Password = pass;
            p.Advertisement.LegacySettings.Passphrase = cred;
            TaskCompletionSource<string> started = new TaskCompletionSource<string>();
            p.StatusChanged += (s, e) =>
            {
                if (e.Status == WiFiDirectAdvertisementPublisherStatus.Started) started.TrySetResult(null);
                else if (e.Status == WiFiDirectAdvertisementPublisherStatus.Aborted) started.TrySetResult(e.Error == WiFiDirectError.RadioNotAvailable ? "Wi-Fi is off"
                    : e.Error == WiFiDirectError.ResourceInUse ? "Wi-Fi is busy (Mobile hotspot, or another Wi-Fi Direct link)" : "Wi-Fi Direct stopped (" + e.Error + ")");
            };
            pub = p;
            p.Start();
            Task done = await Task.WhenAny(started.Task, Task.Delay(10000));
            if (done != started.Task) { Stop(); throw new Exception("Wi-Fi Direct didn't start"); }
            if (started.Task.Result != null) { Stop(); throw new Exception(started.Task.Result); }
            Net.Log("hosting " + ssid);
        }

        public void Stop()
        {
            WiFiDirectAdvertisementPublisher p = pub;
            pub = null;
            if (p != null) try { p.Stop(); } catch (Exception) { }
        }
    }
}

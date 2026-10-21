// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// macshare-calls: this PC as the phone's Bluetooth hands-free (a headset, as a car is), so a call's
// sound plays on the PC. Windows' one way is PhoneLineTransportDevice, which it lets only an app
// with a package identity and the phone line capabilities use: this .exe gets one from a sparse
// package (AppxManifest.xml, registered by windows/callaudio.js) that its own manifest names
// (macshare-calls.manifest). Windows' Bluetooth then carries the call's sound itself. A process of
// its own, run by windows/callaudio.js only while Calls and its Bluetooth option are on with a phone
// connected: macshare-winhelper never touches the phone line.
//
// A call's sound stays here only while Windows has it on this PC (PhoneCall.AudioDevice): it takes
// back what the phone sends unless this app asked for it, so each call is moved here as it starts
// (or to the phone, as asked), and muted here as asked.
//
// JSON lines. In:  {"cmd": "info"} | {"cmd": "connect", "id"} | {"cmd": "unpair", "name"} (then info)
//                  {"cmd": "audio", "here"} (where calls' sound goes, this one and the next) | {"cmd": "mute", "on"}
// Out: {"ev": "info", "identity", "address", "power", "devices": [{id, name}], "error"?}
//      {"ev": "state", "state": "connecting"|"connected"|"disconnected", "access"?, "error"?}
//      (error "unregistered": Windows didn't let this app have the phone's line)
//      {"ev": "call", "status": "incoming"|"dialing"|"talking"|"held"|"ended"|"lost", "here", "muted"}
//      {"ev": "routing", "local"} (false: Windows can't play calls here: a Bluetooth headset is connected, or no microphone)
// stdin closed (TwinDesk gone, or the option off): the phone line is let go and this exits.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using Windows.ApplicationModel.Calls;
using Windows.Devices.Bluetooth;
using Windows.Devices.Enumeration;
using Windows.Devices.Radios;

[assembly: AssemblyTitle("TwinDesk")]
[assembly: AssemblyProduct("TwinDesk")]

namespace MacShare
{
    static class Calls
    {
        static readonly object gate = new object();
        static PhoneLineTransportDevice line; // the phone connected to, this app registered for it
        static PhoneLineWatcher watcher; // Windows' phone lines: the one through `line` carries its calls
        static readonly Dictionary<Guid, PhoneLine> lines = new Dictionary<Guid, PhoneLine>();
        static readonly Dictionary<string, PhoneCall> calls = new Dictionary<string, PhoneCall>(); // under way, by id
        static readonly HashSet<string> placed = new HashSet<string>(); // calls already moved where asked
        static volatile bool wantHere = true;
        static volatile bool wantMuted;
        static System.Threading.Timer poll; // looks for calls each second too, in case CallStateChanged doesn't come

        static int Main()
        {
            // A Windows app (build.cmd /target:winexe), with no console to set code pages on: its
            // pipes are TwinDesk's (windows/callaudio.js). Started by Windows itself for a call
            // (phoneCallActivation) it has none, reads nothing and goes at once, with no window.
            UTF8Encoding utf8 = new UTF8Encoding(false);
            TextReader input = new StreamReader(Console.OpenStandardInput(), utf8);
            Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), utf8));
            Console.SetError(new StreamWriter(Console.OpenStandardError(), utf8) { AutoFlush = true });
            string l;
            while ((l = input.ReadLine()) != null)
            {
                Dictionary<string, object> m;
                try { m = Json.Parse(l); } catch (Exception) { continue; }
                string cmd = Json.Str(m, "cmd", "");
                try
                {
                    if (cmd == "info") Info().Wait();
                    else if (cmd == "connect") Connect(Json.Str(m, "id", "")).Wait();
                    else if (cmd == "unpair") { Unpair(Json.Str(m, "name", "")).Wait(); Info().Wait(); }
                    else if (cmd == "audio") { wantHere = Json.Bool(m, "here", true); ApplyAll(); }
                    else if (cmd == "mute") { wantMuted = Json.Bool(m, "on", false); ApplyAll(); }
                }
                catch (Exception e) { Console.Error.WriteLine(cmd + ": " + e.Message); }
            }
            Release();
            return 0;
        }

        static void Emit(Dictionary<string, object> d)
        {
            lock (gate)
            {
                Console.Out.Write(Json.Write(d) + "\n");
                Console.Out.Flush();
            }
        }

        static Dictionary<string, object> State(string state, string access, string error)
        {
            Dictionary<string, object> o = new Dictionary<string, object>();
            o["ev"] = "state";
            o["state"] = state;
            if (access != null) o["access"] = access;
            if (error != null) o["error"] = error;
            return o;
        }

        // Started through the sparse package's identity (else Windows refuses the phone line).
        static bool HasIdentity()
        {
            try { return Windows.ApplicationModel.Package.Current != null; }
            catch (Exception) { return false; }
        }

        // 0x001122AABBCC -> "00:11:22:AA:BB:CC" (the phone's way of writing it).
        static string Colons(ulong a)
        {
            string h = a.ToString("X12");
            StringBuilder s = new StringBuilder();
            for (int i = 0; i < 12; i += 2) { if (i > 0) s.Append(':'); s.Append(h, i, 2); }
            return s.ToString();
        }

        // This PC's adapter and the phones Windows offers as hands-free gateways (paired, with HFP).
        static async Task Info()
        {
            Dictionary<string, object> o = new Dictionary<string, object>();
            o["ev"] = "info";
            o["identity"] = HasIdentity();
            o["address"] = "";
            o["power"] = false;
            List<object> devices = new List<object>();
            try
            {
                BluetoothAdapter a = await BluetoothAdapter.GetDefaultAsync();
                if (a != null)
                {
                    o["address"] = Colons(a.BluetoothAddress);
                    Radio r = await a.GetRadioAsync();
                    o["power"] = r != null && r.State == RadioState.On;
                }
            }
            catch (Exception e) { o["error"] = e.Message; }
            try
            {
                string sel = PhoneLineTransportDevice.GetDeviceSelector(PhoneLineTransport.Bluetooth);
                foreach (DeviceInformation d in await DeviceInformation.FindAllAsync(sel))
                {
                    Dictionary<string, object> x = new Dictionary<string, object>();
                    x["id"] = d.Id;
                    x["name"] = d.Name;
                    devices.Add(x);
                }
            }
            catch (Exception e) { o["error"] = e.Message; }
            o["devices"] = devices;
            Emit(o);
        }

        // Allowed, registered as the app for this phone line (in Phone Link's place), then the
        // hands-free link up: the phone lists this PC as a headset for calls.
        static async Task Connect(string id)
        {
            Emit(State("connecting", null, null));
            PhoneLineTransportDevice d;
            try { d = PhoneLineTransportDevice.FromId(id); }
            catch (Exception e) { Emit(State("disconnected", null, e.Message)); return; }
            if (d == null) { Emit(State("disconnected", null, "not found")); return; }
            DeviceAccessStatus acc;
            try { acc = await d.RequestAccessAsync(); }
            catch (Exception e) { Emit(State("disconnected", null, e.Message)); return; }
            if (acc != DeviceAccessStatus.Allowed) { Emit(State("disconnected", acc.ToString(), null)); return; }
            try
            {
                if (!d.IsRegistered()) d.RegisterApp();
                // Not taken without a word (another app has this phone's calls, or the package lacks
                // phoneCallActivation): Windows would drop the link at once, so not connected at all.
                if (!d.IsRegistered()) { Emit(State("disconnected", "Allowed", "unregistered")); return; }
                if (!await d.ConnectAsync()) { Emit(State("disconnected", "Allowed", "the phone didn't answer")); return; }
            }
            catch (Exception e) { Emit(State("disconnected", "Allowed", e.Message)); return; }
            if (line != null && line.DeviceId != d.DeviceId) Unregister(line);
            line = d;
            Emit(State("connected", null, null));
            try
            {
                Routing(d);
                d.AudioRoutingStatusChanged += (s, o) => Routing(s);
            }
            catch (Exception e) { Console.Error.WriteLine("audio routing: " + e.Message); }
            await Watch();
        }

        // Whether Windows can play this phone's calls here: only with a microphone and speakers that
        // aren't Bluetooth, and no Bluetooth headset connected at all (whatever the default devices).
        static void Routing(PhoneLineTransportDevice d)
        {
            Dictionary<string, object> o = new Dictionary<string, object>();
            o["ev"] = "routing";
            o["local"] = d.AudioRoutingStatus != TransportDeviceAudioRoutingStatus.CannotRouteToLocalDevice;
            Emit(o);
        }

        // ---- the calls through it ----

        static async Task Watch()
        {
            if (watcher != null) { lock (gate) lines.Clear(); watcher.Stop(); watcher = null; } // another phone: its lines again
            try
            {
                PhoneCallStore store = await PhoneCallManager.RequestStoreAsync();
                PhoneLineWatcher w = store.RequestLineWatcher();
                w.LineAdded += (s, e) => Line(e.LineId);
                w.LineUpdated += (s, e) => Line(e.LineId);
                w.LineRemoved += (s, e) => { lock (gate) lines.Remove(e.LineId); };
                w.Start();
                watcher = w;
            }
            catch (Exception e) { Console.Error.WriteLine("lines: " + e.Message); return; }
            PhoneCallManager.CallStateChanged -= OnCallState;
            PhoneCallManager.CallStateChanged += OnCallState;
            if (poll == null) poll = new System.Threading.Timer(o => Refresh(), null, 1000, 1000);
        }

        static void OnCallState(object s, object e)
        {
            Refresh();
        }

        // Its Bluetooth address, from either kind of id ("...&384A8081BFCF_C00000000#..."), to match a line to it.
        static string Addr(string id)
        {
            System.Text.RegularExpressions.Match m = System.Text.RegularExpressions.Regex.Match(id ?? "", "[&#_]([0-9A-Fa-f]{12})_");
            return m.Success ? m.Groups[1].Value.ToUpperInvariant() : "";
        }

        static async void Line(Guid id)
        {
            try
            {
                PhoneLine l = await PhoneLine.FromIdAsync(id);
                PhoneLineTransportDevice d = line;
                bool ours = l != null && d != null && l.Transport == PhoneLineTransport.Bluetooth
                    && (string.Equals(l.TransportDeviceId, d.DeviceId, StringComparison.OrdinalIgnoreCase)
                        || (Addr(l.TransportDeviceId).Length > 0 && Addr(l.TransportDeviceId) == Addr(d.DeviceId)));
                lock (gate) { if (ours) lines[id] = l; else lines.Remove(id); }
                if (ours) Refresh(); // a call already under way
            }
            catch (Exception e) { Console.Error.WriteLine("line: " + e.Message); }
        }

        static async void Refresh()
        {
            try
            {
                List<PhoneLine> mine;
                lock (gate) mine = new List<PhoneLine>(lines.Values);
                foreach (PhoneLine l in mine)
                {
                    PhoneCallsResult r = await l.GetAllActivePhoneCallsAsync();
                    if (r.OperationStatus != PhoneLineOperationStatus.Succeeded) continue;
                    foreach (PhoneCall c in r.AllActivePhoneCalls)
                        if (c.Status != PhoneCallStatus.Ended && c.Status != PhoneCallStatus.Lost) Track(c); // Windows lists the last one a while after
                }
            }
            catch (Exception e) { Console.Error.WriteLine("calls: " + e.Message); }
        }

        static void Track(PhoneCall c)
        {
            lock (gate)
            {
                if (calls.ContainsKey(c.CallId)) return;
                calls[c.CallId] = c;
            }
            c.StatusChanged += (s, o) => Changed(s);
            c.AudioDeviceChanged += (s, o) => Changed(s);
            c.IsMutedChanged += (s, o) => Changed(s);
            Changed(c);
        }

        // Moved where asked once, as it starts (the phone's own switch is the person's after that).
        static void Changed(PhoneCall c)
        {
            try
            {
                PhoneCallStatus st = c.Status;
                bool live = st != PhoneCallStatus.Ended && st != PhoneCallStatus.Lost;
                bool first = false;
                lock (gate)
                {
                    if (!live) { calls.Remove(c.CallId); placed.Remove(c.CallId); }
                    else if ((st == PhoneCallStatus.Dialing || st == PhoneCallStatus.Talking) && placed.Add(c.CallId)) first = true;
                }
                if (first) Apply(c);
                Dictionary<string, object> o = new Dictionary<string, object>();
                o["ev"] = "call";
                o["status"] = st.ToString().ToLowerInvariant();
                o["here"] = live && c.AudioDevice == PhoneCallAudioDevice.LocalDevice;
                o["muted"] = live && c.IsMuted;
                Emit(o);
            }
            catch (Exception e) { Console.Error.WriteLine("call: " + e.Message); }
        }

        static void ApplyAll()
        {
            List<PhoneCall> now;
            lock (gate) now = new List<PhoneCall>(calls.Values);
            foreach (PhoneCall c in now) Apply(c);
        }

        static void Apply(PhoneCall c)
        {
            try
            {
                PhoneCallStatus st = c.Status;
                if (st != PhoneCallStatus.Dialing && st != PhoneCallStatus.Talking && st != PhoneCallStatus.Held) return;
                PhoneCallAudioDevice want = wantHere ? PhoneCallAudioDevice.LocalDevice : PhoneCallAudioDevice.RemoteDevice;
                if (c.AudioDevice != want)
                {
                    PhoneCallOperationStatus r = c.ChangeAudioDevice(want);
                    if (r != PhoneCallOperationStatus.Succeeded) Console.Error.WriteLine("audio " + want + ": " + r);
                }
                if (c.IsMuted != wantMuted)
                {
                    PhoneCallOperationStatus r = wantMuted ? c.Mute() : c.Unmute();
                    if (r != PhoneCallOperationStatus.Succeeded) Console.Error.WriteLine("mute: " + r);
                }
            }
            catch (Exception e) { Console.Error.WriteLine("apply: " + e.Message); }
        }

        // The phone forgotten here: every paired Bluetooth device with its name, classic and LE (a
        // pairing over LE also leaves keys Windows uses for the phone's LE link, TwinDesk's own).
        static async Task Unpair(string name)
        {
            name = name.Trim();
            if (name.Length == 0) return;
            if (line != null) { Unregister(line); line = null; }
            foreach (string sel in new[] { BluetoothDevice.GetDeviceSelectorFromPairingState(true), BluetoothLEDevice.GetDeviceSelectorFromPairingState(true) })
            {
                foreach (DeviceInformation d in await DeviceInformation.FindAllAsync(sel))
                {
                    if (!string.Equals((d.Name ?? "").Trim(), name, StringComparison.OrdinalIgnoreCase)) continue;
                    DeviceUnpairingResult r = await d.Pairing.UnpairAsync();
                    Console.Error.WriteLine("unpair " + d.Name + ": " + r.Status);
                }
            }
        }

        // Off means off: this app no longer the phone line's (Phone Link takes it again when it runs).
        static void Release()
        {
            try { if (watcher != null) watcher.Stop(); } catch (Exception) { }
            if (line != null) Unregister(line);
            line = null;
        }

        static void Unregister(PhoneLineTransportDevice d)
        {
            try { if (d.IsRegistered()) d.UnregisterApp(); }
            catch (Exception e) { Console.Error.WriteLine("unregister: " + e.Message); }
        }
    }
}

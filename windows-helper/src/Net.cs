// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Bluetooth LE and Wi-Fi Direct commands (Ble.cs, Wfd.cs), for a device that isn't on this PC's
// network. Handled on the reader thread, not the main one: the session's bytes go through here and
// the hooks on the main thread never wait for them; bleSend keeps its order.
//   Host (this PC hosts the session): bleStart {info}, bleStop, bleSend {dev, data}, bleCtrl {dev, msg}
//     events ble.state, ble.guest, ble.open, ble.data, ble.close, ble.gone, ble.sent
//   Guest (this PC connects to a host): bleScan {on}, bleOpen {dev, hello}, bleSend, bleClose {dev}
//     events ble.state, ble.found {dev, info}, ble.invite, ble.opened, ble.data, ble.close, ble.gone, ble.sent
//   Phones (they advertise, we connect; the link stays up between pipes): blpScan {on},
//     blpLink {dev, hello}, blpOpen {dev}, blpEnd {dev}, blpSend {dev, data}, blpDrop {dev}
//     events blp.found {dev, info}, blp.linked, blp.want, blp.opened, blp.data, blp.close, blp.gone, blp.sent
//   Wi-Fi Direct (a network the other side joins while this PC stays on its own Wi-Fi):
//     wfdCaps -> {host, wifi}; wfdHost {ssid, pass}; wfdStop; and for joining (wifi.js) too:
//     wfdRadio {on} -> {was} (Wi-Fi on/off); wfdSsid -> {ssid}; wfdLocation -> {status}
// See shared/blepipe.js and shared/netlink.js for what main does with them.
using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace MacShare
{
    static class Net
    {
        static BleHost host;
        static BleGuest guest;
        static BleGuest phones;
        static WfdHost wfd;

        public static void Event(string name, string dev, string key, object value)
        {
            Dictionary<string, object> e = new Dictionary<string, object>();
            e["event"] = name;
            if (dev != null) e["dev"] = dev;
            if (key != null) e[key] = value;
            Program.Emit(e);
        }

        public static void Log(string s)
        {
            try { Console.Error.WriteLine("[net] " + s); } catch (Exception) { }
        }

        static void Reply(object id, Dictionary<string, object> fields)
        {
            if (id == null) return;
            Dictionary<string, object> r = fields ?? new Dictionary<string, object>();
            r["id"] = id;
            r["ok"] = true;
            Program.Emit(r);
        }

        static void Fail(object id, string error)
        {
            if (id == null) { Log(error); return; }
            Dictionary<string, object> r = new Dictionary<string, object>();
            r["id"] = id;
            r["ok"] = false;
            r["error"] = error;
            Program.Emit(r);
        }

        // Replies when the task ends (the reader thread never waits).
        static void Async(object id, Func<Task<Dictionary<string, object>>> work)
        {
            Task.Run(async () =>
            {
                try { Reply(id, await work()); }
                catch (Exception e) { Fail(id, e.Message); }
            });
        }

        // True when the line was one of ours.
        public static bool Handle(string line)
        {
            if (line.IndexOf("\"cmd\":\"ble", StringComparison.Ordinal) < 0 && line.IndexOf("\"cmd\":\"blp", StringComparison.Ordinal) < 0 && line.IndexOf("\"cmd\":\"wfd", StringComparison.Ordinal) < 0) return false;
            Dictionary<string, object> m;
            try { m = Json.Parse(line); }
            catch (Exception) { return true; }
            object id;
            m.TryGetValue("id", out id);
            string cmd = Json.Str(m, "cmd", "");
            string dev = Json.Str(m, "dev", "");
            try
            {
                if (host == null) { host = new BleHost(); guest = new BleGuest(BleIds.Service, "ble."); phones = new BleGuest(BleIds.PhoneService, "blp."); wfd = new WfdHost(); }
                switch (cmd)
                {
                    case "bleStart":
                        string info = Json.Str(m, "info", "{}");
                        Async(id, async () => { await host.Start(info); return null; });
                        break;
                    case "bleStop": host.Stop(); Reply(id, null); break;
                    case "bleCtrl": host.Ctrl(dev, Json.Str(m, "msg", "{}")); break;
                    case "bleSend":
                        byte[] data = Convert.FromBase64String(Json.Str(m, "data", ""));
                        if (!host.Send(dev, data)) guest.Send(dev, data);
                        break;
                    case "bleScan": guest.Scan(Json.Bool(m, "on", false)); Reply(id, null); break;
                    case "bleOpen": guest.Open(dev, Json.Str(m, "hello", "{}")); Reply(id, null); break;
                    case "bleClose": guest.Close(dev); Reply(id, null); break;
                    case "blpScan": phones.Scan(Json.Bool(m, "on", false)); Reply(id, null); break;
                    case "blpLink": phones.Open(dev, Json.Str(m, "hello", "{}"), false); Reply(id, null); break;
                    case "blpOpen": phones.OpenPipe(dev); Reply(id, null); break;
                    case "blpEnd": phones.EndPipe(dev); Reply(id, null); break;
                    case "blpDrop": phones.Close(dev); Reply(id, null); break;
                    case "blpSend": phones.Send(dev, Convert.FromBase64String(Json.Str(m, "data", ""))); break;
                    case "wfdCaps": Async(id, () => wfd.Caps()); break;
                    case "wfdRadio":
                        bool on = Json.Bool(m, "on", true);
                        Async(id, async () =>
                        {
                            Dictionary<string, object> r = new Dictionary<string, object>();
                            r["was"] = await wfd.SetRadio(on);
                            return r;
                        });
                        break;
                    case "wfdSsid":
                        Dictionary<string, object> ss = new Dictionary<string, object>();
                        ss["ssid"] = wfd.Ssid();
                        Reply(id, ss);
                        break;
                    case "wfdLocation":
                        Async(id, async () =>
                        {
                            Dictionary<string, object> r = new Dictionary<string, object>();
                            r["status"] = await wfd.Location();
                            return r;
                        });
                        break;
                    case "wfdHost":
                        string ssid = Json.Str(m, "ssid", "");
                        string pass = Json.Str(m, "pass", "");
                        Async(id, async () => { await wfd.Start(ssid, pass); return null; });
                        break;
                    case "wfdStop": wfd.Stop(); Reply(id, null); break;
                    default: Fail(id, "unknown cmd " + cmd); break;
                }
            }
            catch (Exception e) { Fail(id, e.Message); }
            return true;
        }

        public static void Shutdown()
        {
            try { if (host != null) host.Stop(); } catch (Exception) { }
            try { if (guest != null) guest.StopAll(); } catch (Exception) { }
            try { if (phones != null) phones.StopAll(); } catch (Exception) { }
            try { if (wfd != null) wfd.Stop(); } catch (Exception) { }
        }
    }
}

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The Deck's mixer and media on Windows (shared/deck-sys.js), in this process with Windows' own
// APIs: no other program is started (the media session used to be read through PowerShell; now
// it's here, so nothing an antivirus could mind runs).
//   deckMix -> {apps: [{id, name, level, muted}]}: each app playing sound on the default output
//     (Core Audio's sessions, one row per app however many sessions it has; "System sounds" too)
//   deckMixSet {dev, level?, mute?}: that app's level 0–1 and mute, as the Volume mixer sets them
//   deckMedia -> {playing: {id, app, title, artist, album, state, position, duration} | null,
//     sessions: [{id, app, title, state}]}: the system media session (what the media keys control)
//   deckMediaCtl {a: toggle|play|pause|next|prev|stop|shuffle|repeat, dev?, app?}: to that app's
//     session (dev: its id; app: its name, "Spotify"), else the current
// C# 5 (build.cmd). Read only when asked: nothing is watched in between.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Windows.Media.Control;

namespace MacShare
{
    static class DeckMix
    {
        // ---- Core Audio's sessions ----
        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }
        [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceEnumerator
        {
            [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
            [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
        }
        [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDevice
        {
            [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
        }
        [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioSessionManager2
        {
            [PreserveSig] int GetAudioSessionControl(IntPtr guid, int flags, out IntPtr ctl);
            [PreserveSig] int GetSimpleAudioVolume(IntPtr guid, int flags, out IntPtr vol);
            [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
        }
        [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioSessionEnumerator
        {
            [PreserveSig] int GetCount(out int n);
            [PreserveSig] int GetSession(int i, out IAudioSessionControl2 s);
        }
        [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioSessionControl2
        {
            // IAudioSessionControl
            [PreserveSig] int GetState(out int state);
            [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
            [PreserveSig] int SetDisplayName(string name, ref Guid ctx);
            [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
            [PreserveSig] int SetIconPath(string path, ref Guid ctx);
            [PreserveSig] int GetGroupingParam(out Guid g);
            [PreserveSig] int SetGroupingParam(ref Guid g, ref Guid ctx);
            [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
            [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
            // IAudioSessionControl2
            [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
            [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
            [PreserveSig] int GetProcessId(out uint pid);
            [PreserveSig] int IsSystemSoundsSession();
            [PreserveSig] int SetDuckingPreference(bool optOut);
        }
        [Guid("87CE5498-68D6-44E5-9215-6F5DE4BF94BB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface ISimpleAudioVolume
        {
            [PreserveSig] int SetMasterVolume(float level, ref Guid ctx);
            [PreserveSig] int GetMasterVolume(out float level);
            [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
            [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
        }
        const int eRender = 0, eMultimedia = 1, CLSCTX_ALL = 23, AudioSessionStateExpired = 2;

        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

        // The app's own name ("Spotify", "Google Chrome"), from its file; a session's own name first.
        static string AppName(uint pid, string display)
        {
            if (!string.IsNullOrEmpty(display) && !display.StartsWith("@")) return display;
            IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h == IntPtr.Zero) return "";
            try
            {
                StringBuilder sb = new StringBuilder(1024);
                int n = sb.Capacity;
                if (!QueryFullProcessImageName(h, 0, sb, ref n)) return "";
                string path = sb.ToString();
                string desc = "";
                try { desc = FileVersionInfo.GetVersionInfo(path).FileDescription; } catch { }
                return string.IsNullOrEmpty(desc) ? System.IO.Path.GetFileNameWithoutExtension(path) : desc.Trim();
            }
            finally { CloseHandle(h); }
        }

        // Each app's sessions on the default output: key "pid:<n>" (or "system"), all its volumes.
        class App { public string id, name; public List<ISimpleAudioVolume> vols = new List<ISimpleAudioVolume>(); }

        static List<App> Apps()
        {
            List<App> list = new List<App>();
            IMMDevice dev;
            IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
            if (en.GetDefaultAudioEndpoint(eRender, eMultimedia, out dev) != 0 || dev == null) return list;
            Guid iid = typeof(IAudioSessionManager2).GUID;
            object o;
            if (dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o) != 0) return list;
            IAudioSessionManager2 mgr = o as IAudioSessionManager2;
            IAudioSessionEnumerator se;
            if (mgr == null || mgr.GetSessionEnumerator(out se) != 0 || se == null) return list;
            int count;
            se.GetCount(out count);
            Dictionary<string, App> byId = new Dictionary<string, App>();
            for (int i = 0; i < count; i++)
            {
                IAudioSessionControl2 s;
                if (se.GetSession(i, out s) != 0 || s == null) continue;
                int state;
                if (s.GetState(out state) == 0 && state == AudioSessionStateExpired) continue;
                uint pid;
                s.GetProcessId(out pid);
                bool system = s.IsSystemSoundsSession() == 0;
                string id = system ? "system" : "pid:" + pid;
                ISimpleAudioVolume v = s as ISimpleAudioVolume;
                if (v == null) continue;
                App a;
                if (!byId.TryGetValue(id, out a))
                {
                    string display;
                    s.GetDisplayName(out display);
                    a = new App { id = id, name = system ? "System sounds" : AppName(pid, display) };
                    if (string.IsNullOrEmpty(a.name)) continue;
                    byId[id] = a;
                    list.Add(a);
                }
                a.vols.Add(v);
            }
            return list;
        }

        static void Mix(Dictionary<string, object> r)
        {
            List<object> apps = new List<object>();
            foreach (App a in Apps())
            {
                float level;
                bool muted;
                a.vols[0].GetMasterVolume(out level);
                a.vols[0].GetMute(out muted);
                Dictionary<string, object> d = new Dictionary<string, object>();
                d["id"] = a.id;
                d["name"] = a.name;
                d["level"] = Math.Round(level, 3);
                d["muted"] = muted;
                apps.Add(d);
            }
            r["apps"] = apps;
        }

        static void MixSet(Dictionary<string, object> c)
        {
            string id = Json.Str(c, "dev", "");
            Guid ctx = Guid.Empty;
            foreach (App a in Apps())
            {
                if (a.id != id) continue;
                foreach (ISimpleAudioVolume v in a.vols)
                {
                    if (Json.Has(c, "level")) v.SetMasterVolume((float)Math.Max(0, Math.Min(1, Json.Num(c, "level", 1))), ref ctx);
                    if (Json.Has(c, "mute")) v.SetMute(Json.Bool(c, "mute", false), ref ctx);
                }
                return;
            }
            throw new Exception("That app isn’t playing sound now");
        }

        // ---- The system media session ----

        static GlobalSystemMediaTransportControlsSessionManager Manager()
        {
            return GlobalSystemMediaTransportControlsSessionManager.RequestAsync().AsTask().Result;
        }

        static string State(GlobalSystemMediaTransportControlsSession s)
        {
            GlobalSystemMediaTransportControlsSessionPlaybackInfo p = s.GetPlaybackInfo();
            if (p == null) return "";
            switch (p.PlaybackStatus)
            {
                case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing: return "playing";
                case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused: return "paused";
                case GlobalSystemMediaTransportControlsSessionPlaybackStatus.Stopped: return "stopped";
                default: return "";
            }
        }

        // The app a session belongs to, as people know it ("Spotify.exe" → "Spotify").
        static string AppOf(string aumid)
        {
            string a = aumid ?? "";
            int bang = a.LastIndexOf('!');
            if (bang >= 0) a = a.Substring(bang + 1);
            if (a.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) a = a.Substring(0, a.Length - 4);
            int us = a.IndexOf('_');
            if (us > 0 && a.Contains(".")) a = a.Substring(0, us); // a packaged app's family name
            int dot = a.LastIndexOf('.');
            if (dot >= 0 && dot < a.Length - 1) a = a.Substring(dot + 1);
            return a;
        }

        static Dictionary<string, object> Describe(GlobalSystemMediaTransportControlsSession s, bool full)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["id"] = s.SourceAppUserModelId ?? "";
            d["app"] = AppOf(s.SourceAppUserModelId);
            d["state"] = State(s);
            try
            {
                GlobalSystemMediaTransportControlsSessionMediaProperties m = s.TryGetMediaPropertiesAsync().AsTask().Result;
                d["title"] = m.Title ?? "";
                if (full)
                {
                    d["artist"] = m.Artist ?? "";
                    d["album"] = m.AlbumTitle ?? "";
                }
            }
            catch { d["title"] = ""; }
            if (full)
            {
                try
                {
                    GlobalSystemMediaTransportControlsSessionTimelineProperties t = s.GetTimelineProperties();
                    d["position"] = Math.Round(t.Position.TotalSeconds, 1);
                    d["duration"] = Math.Round((t.EndTime - t.StartTime).TotalSeconds, 1);
                }
                catch { }
            }
            return d;
        }

        static void Media(Dictionary<string, object> r)
        {
            GlobalSystemMediaTransportControlsSessionManager m = Manager();
            GlobalSystemMediaTransportControlsSession cur = m.GetCurrentSession();
            r["playing"] = cur == null ? null : Describe(cur, true);
            List<object> list = new List<object>();
            foreach (GlobalSystemMediaTransportControlsSession s in m.GetSessions()) list.Add(Describe(s, false));
            r["sessions"] = list;
        }

        static void MediaCtl(Dictionary<string, object> c)
        {
            GlobalSystemMediaTransportControlsSessionManager m = Manager();
            string id = Json.Str(c, "dev", "");
            GlobalSystemMediaTransportControlsSession s = null;
            string app = Json.Str(c, "app", "");
            foreach (GlobalSystemMediaTransportControlsSession x in m.GetSessions())
                if ((id.Length > 0 && x.SourceAppUserModelId == id) || (app.Length > 0 && string.Equals(AppOf(x.SourceAppUserModelId), app, StringComparison.OrdinalIgnoreCase))) { s = x; break; }
            if (s == null && app.Length > 0) throw new Exception(app + " isn’t open");
            if (s == null) s = m.GetCurrentSession();
            if (s == null) throw new Exception("Nothing is playing");
            bool ok;
            switch (Json.Str(c, "a", "toggle"))
            {
                case "play": ok = s.TryPlayAsync().AsTask().Result; break;
                case "pause": ok = s.TryPauseAsync().AsTask().Result; break;
                case "next": ok = s.TrySkipNextAsync().AsTask().Result; break;
                case "prev": ok = s.TrySkipPreviousAsync().AsTask().Result; break;
                case "stop": ok = s.TryStopAsync().AsTask().Result; break;
                case "shuffle": // on ↔ off
                    {
                        GlobalSystemMediaTransportControlsSessionPlaybackInfo p = s.GetPlaybackInfo();
                        bool on = p != null && p.IsShuffleActive.HasValue && p.IsShuffleActive.Value;
                        ok = s.TryChangeShuffleActiveAsync(!on).AsTask().Result;
                        break;
                    }
                case "repeat": // off → the list → off (as Spotify's own button goes, but one song stays its own)
                    {
                        GlobalSystemMediaTransportControlsSessionPlaybackInfo p = s.GetPlaybackInfo();
                        bool on = p != null && p.AutoRepeatMode.HasValue && p.AutoRepeatMode.Value != Windows.Media.MediaPlaybackAutoRepeatMode.None;
                        ok = s.TryChangeAutoRepeatModeAsync(on ? Windows.Media.MediaPlaybackAutoRepeatMode.None : Windows.Media.MediaPlaybackAutoRepeatMode.List).AsTask().Result;
                        break;
                    }
                default: ok = s.TryTogglePlayPauseAsync().AsTask().Result; break;
            }
            if (!ok) throw new Exception("The app didn’t take it");
        }

        public static bool Dispatch(string cmd, Dictionary<string, object> c, Dictionary<string, object> r)
        {
            switch (cmd)
            {
                case "deckMix": Mix(r); return true;
                case "deckMixSet": MixSet(c); return true;
                case "deckMedia": Media(r); return true;
                case "deckMediaCtl": MediaCtl(c); return true;
                default: return false;
            }
        }
    }
}

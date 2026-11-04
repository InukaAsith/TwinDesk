// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume (windows/activity.js): what is in use in the window in front. Its app (the .exe), its
// title, and what it shows: a browser's address (its address bar, read with UI Automation, never the
// page itself), else the document whose name the title shows, found among the files Windows lists
// as recently opened (Recent's shortcuts). Asked only while ReZume is on; the address is read again
// only when the window or its title changed. A browser showing a local file (a PDF) gives that file.
// Store apps (Photos, Media Player) sit inside ApplicationFrameHost's frame: their own process is the
// child window's. Besides Recent, a file is looked for in the app's command line (a player opened by
// a double-click), PotPlayer's own memory (its registry key, .ini and playlists), and next to Recent's
// newest files (Photos' next picture, a player's next file): the folders go back as "dirs" for
// windows/activity.js, which also has VLC's own list (shared/docfind.js).
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Automation;
using Microsoft.Win32;

namespace MacShare
{
    static class Activity
    {
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
        [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int ret);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string cmd, out int n);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
        delegate bool EnumProc(IntPtr hwnd, IntPtr lp);
        [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc fn, IntPtr lp);

        static readonly Regex Browsers = new Regex(@"^(chrome|msedge|firefox|brave|vivaldi|opera|chromium|librewolf|waterfox|zen|arc)$", RegexOptions.IgnoreCase);
        static readonly Regex Hostish = new Regex(@"^([\w-]+\.)+[a-z]{2,}(:\d+)?([/?#]|$)|^localhost(:\d+)?([/?#]|$)", RegexOptions.IgnoreCase);
        static long lastHwnd;
        static string lastTitle = "";
        static string lastUrl = "";
        static readonly Dictionary<string, string> links = new Dictionary<string, string>(); // a Recent shortcut (path|time) → its target
        static readonly Regex Marks = new Regex("[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]");
        static readonly Regex PotPlayer = new Regex(@"^potplayer(mini)?(64)?$", RegexOptions.IgnoreCase);
        static readonly Regex WinPath = new Regex(@"[A-Za-z]:\\[^\r\n\0*""|<>?]{1,240}?\.[A-Za-z0-9]{2,5}(?=[\r\n\0*""|<>?]|$)");
        static long docHwnd;
        static string docTitle = "";
        static string docFile;
        static List<string> docDirs = new List<string>();

        public static void Front(Dictionary<string, object> r)
        {
            IntPtr root = GetAncestor(GetForegroundWindow(), 2); // GA_ROOT
            if (root == IntPtr.Zero || !IsWindowVisible(root)) return;
            StringBuilder cls = new StringBuilder(64);
            GetClassName(root, cls, cls.Capacity);
            string c = cls.ToString();
            if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd" || c == "CabinetWClass" || c == "ExploreWClass") return;
            uint pid;
            GetWindowThreadProcessId(root, out pid);
            StringBuilder t = new StringBuilder(512);
            GetWindowText(root, t, t.Capacity);
            string title = Marks.Replace(t.ToString(), "").Trim();
            string exe = ExeOf(pid);
            if (c == "ApplicationFrameWindow" || Path.GetFileName(exe).Equals("ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase))
            {
                uint app = HostedApp(root, pid);
                if (app == 0) return; // a frame still starting, or Settings and the like
                pid = app;
                exe = ExeOf(pid);
            }
            r["hwnd"] = (double)root.ToInt64();
            r["pid"] = (double)pid;
            r["exe"] = exe;
            r["title"] = title;
            string name = Path.GetFileNameWithoutExtension(exe);
            if (Browsers.IsMatch(name))
            {
                if (root.ToInt64() != lastHwnd || title != lastTitle)
                {
                    lastHwnd = root.ToInt64();
                    lastTitle = title;
                    lastUrl = "";
                    try { lastUrl = AddressOf(root); } catch (Exception) { lastUrl = ""; }
                }
                r["browser"] = true;
                if (lastUrl.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
                {
                    string local = LocalPath(lastUrl);
                    if (local != null) r["file"] = local; // a PDF (or a picture, a text file) the browser shows
                }
                else if (lastUrl != "") r["url"] = lastUrl;
                else
                {
                    // Address bar not readable: a tab named as a file ("report.pdf") Windows opened lately.
                    string f = null;
                    try { f = RecentFile(title, true); } catch (Exception) { f = null; }
                    if (f != null) r["file"] = f;
                }
                return;
            }
            if (root.ToInt64() != docHwnd || title != docTitle || (docFile != null && !File.Exists(docFile)))
            {
                docHwnd = root.ToInt64();
                docTitle = title;
                docDirs = new List<string>();
                docFile = null;
                try { docFile = RecentFile(title, false); } catch (Exception) { docFile = null; }
                if (docFile == null) try { docFile = Pick(title, ArgFiles(pid)); } catch (Exception) { docFile = null; }
                if (docFile == null && PotPlayer.IsMatch(name)) try { docFile = Pick(title, PotFiles(name, exe)); } catch (Exception) { docFile = null; }
                if (docFile == null) try { docDirs = RecentDirs(); } catch (Exception) { docDirs = new List<string>(); }
            }
            if (docFile != null) r["file"] = docFile;
            else if (docDirs.Count > 0) r["dirs"] = docDirs.ToArray();
        }

        // The Store app inside a frame: the child window whose process isn't the frame's.
        static uint HostedApp(IntPtr frame, uint framePid)
        {
            uint found = 0;
            EnumChildWindows(frame, delegate (IntPtr h, IntPtr lp)
            {
                uint p;
                GetWindowThreadProcessId(h, out p);
                if (p != 0 && p != framePid) { found = p; return false; }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        static string LocalPath(string u)
        {
            Uri x;
            if (!Uri.TryCreate(u, UriKind.Absolute, out x) || !x.IsFile) return null;
            string p = x.LocalPath;
            return File.Exists(p) ? p : null;
        }

        // The first file the title names (with its extension, or without it).
        static string Pick(string title, IEnumerable<string> files)
        {
            foreach (string f in files)
            {
                string name = Path.GetFileName(f);
                string stem = Path.GetFileNameWithoutExtension(f);
                if (stem == name || stem.Length < 2) continue;
                if ((Shows(title, name) || (stem.Length >= 3 && Shows(title, stem))) && File.Exists(f)) return f;
            }
            return null;
        }

        // The files the app was started with ("PotPlayerMini64.exe" "D:\Films\a.mkv").
        static List<string> ArgFiles(uint pid)
        {
            List<string> o = new List<string>();
            string cmd = CommandLine(pid);
            if (string.IsNullOrEmpty(cmd)) return o;
            int n;
            IntPtr argv = CommandLineToArgvW(cmd, out n);
            if (argv == IntPtr.Zero) return o;
            try
            {
                for (int i = 1; i < n && i < 64; i++)
                {
                    string a = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size));
                    if (!string.IsNullOrEmpty(a) && a.Length > 3 && Path.IsPathRooted(a) && a.IndexOfAny(Path.GetInvalidPathChars()) < 0) o.Add(a);
                }
            }
            finally { LocalFree(argv); }
            return o;
        }

        // ProcessCommandLineInformation (Windows 8.1 and later), with only PROCESS_QUERY_LIMITED_INFORMATION.
        static string CommandLine(uint pid)
        {
            IntPtr h = OpenProcess(0x1000, false, pid);
            if (h == IntPtr.Zero) return null;
            int size = 4096;
            try
            {
                for (int tries = 0; tries < 2; tries++)
                {
                    IntPtr buf = Marshal.AllocHGlobal(size);
                    try
                    {
                        int ret;
                        int st = NtQueryInformationProcess(h, 60, buf, size, out ret);
                        if (st == 0)
                        {
                            int len = (ushort)Marshal.ReadInt16(buf);
                            IntPtr s = Marshal.ReadIntPtr(buf, IntPtr.Size); // UNICODE_STRING: Length, MaximumLength, (padding), Buffer
                            return s == IntPtr.Zero ? null : Marshal.PtrToStringUni(s, len / 2);
                        }
                        if (ret <= size || ret > 1 << 20) return null;
                        size = ret;
                    }
                    finally { Marshal.FreeHGlobal(buf); }
                }
            }
            finally { CloseHandle(h); }
            return null;
        }

        // PotPlayer's own memory of what it played: its registry key (where it keeps settings by
        // default), else its .ini, and its playlists (.dpl). Any full path in them, newest place first.
        static List<string> PotFiles(string name, string exe)
        {
            List<string> o = new List<string>();
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\DAUM\" + name))
                    if (k != null) { int budget = 4000; RegPaths(k, 0, o, ref budget); }
            }
            catch (Exception) { }
            List<string> files = new List<string>();
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string dir = Path.GetDirectoryName(exe) ?? "";
            files.Add(Path.Combine(dir, name + ".ini"));
            files.Add(Path.Combine(Path.Combine(appData, name), name + ".ini"));
            foreach (string d in new string[] { Path.Combine(dir, "Playlist"), Path.Combine(Path.Combine(appData, name), "Playlist") })
                try { if (Directory.Exists(d)) files.AddRange(Directory.GetFiles(d, "*.dpl")); } catch (Exception) { }
            foreach (string f in files)
            {
                try
                {
                    FileInfo fi = new FileInfo(f);
                    if (!fi.Exists || fi.Length > 4 << 20) continue;
                    foreach (Match m in WinPath.Matches(File.ReadAllText(f))) o.Add(m.Value);
                }
                catch (Exception) { }
            }
            return o;
        }

        static void RegPaths(RegistryKey k, int depth, List<string> o, ref int budget)
        {
            foreach (string v in k.GetValueNames())
            {
                if (--budget < 0) return;
                string s = k.GetValue(v) as string;
                if (s == null || s.Length < 6) continue;
                foreach (Match m in WinPath.Matches(s)) o.Add(m.Value);
            }
            if (depth >= 2) return;
            foreach (string sub in k.GetSubKeyNames())
            {
                if (budget < 0) return;
                try { using (RegistryKey c = k.OpenSubKey(sub)) if (c != null) RegPaths(c, depth + 1, o, ref budget); } catch (Exception) { }
            }
        }

        // The folders of Recent's newest files, where the next picture or video of one would be.
        static List<string> RecentDirs()
        {
            List<string> o = new List<string>();
            string dir = Environment.GetFolderPath(Environment.SpecialFolder.Recent);
            if (!Directory.Exists(dir)) return o;
            FileInfo[] lnks = new DirectoryInfo(dir).GetFiles("*.lnk");
            Array.Sort(lnks, delegate (FileInfo a, FileInfo b) { return b.LastWriteTimeUtc.CompareTo(a.LastWriteTimeUtc); });
            int n = 0;
            foreach (FileInfo l in lnks)
            {
                if (n++ >= 16 || o.Count >= 8) break;
                string name = Path.GetFileNameWithoutExtension(l.Name);
                if (Path.GetFileNameWithoutExtension(name) == name) continue; // a folder's shortcut
                string target = Target(l);
                if (string.IsNullOrEmpty(target)) continue;
                string d = Path.GetDirectoryName(target);
                if (!string.IsNullOrEmpty(d) && !o.Contains(d) && Directory.Exists(d)) o.Add(d);
            }
            return o;
        }

        static string ExeOf(uint pid)
        {
            IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
            if (h == IntPtr.Zero) return "";
            try
            {
                StringBuilder sb = new StringBuilder(1024);
                int size = sb.Capacity;
                return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : "";
            }
            finally { CloseHandle(h); }
        }

        // The address bar: the first edit box in the window's own controls (pages are documents,
        // never gone into), Firefox's by its id. Not while it's being typed in.
        static string AddressOf(IntPtr hwnd)
        {
            AutomationElement root = AutomationElement.FromHandle(hwnd);
            TreeWalker w = TreeWalker.ControlViewWalker;
            Queue<KeyValuePair<AutomationElement, int>> q = new Queue<KeyValuePair<AutomationElement, int>>();
            q.Enqueue(new KeyValuePair<AutomationElement, int>(root, 0));
            int seen = 0;
            string first = "";
            while (q.Count > 0 && seen++ < 600)
            {
                KeyValuePair<AutomationElement, int> e = q.Dequeue();
                AutomationElement el = e.Key;
                ControlType ct;
                string id;
                try { ct = el.Current.ControlType; id = el.Current.AutomationId ?? ""; } catch (Exception) { continue; }
                if (ct == ControlType.Document) continue;
                if (ct == ControlType.Edit || id == "urlbar-input")
                {
                    bool typing = false;
                    try { typing = el.Current.HasKeyboardFocus; } catch (Exception) { }
                    string v = typing ? "" : ValueOf(el);
                    string u = Normalize(v);
                    if (u != "")
                    {
                        if (id == "urlbar-input") return u;
                        if (first == "") first = u;
                        return first;
                    }
                    continue;
                }
                if (e.Value >= 14) continue;
                AutomationElement child = null;
                try { child = w.GetFirstChild(el); } catch (Exception) { }
                while (child != null)
                {
                    q.Enqueue(new KeyValuePair<AutomationElement, int>(child, e.Value + 1));
                    try { child = w.GetNextSibling(child); } catch (Exception) { child = null; }
                }
            }
            return first;
        }

        static string ValueOf(AutomationElement el)
        {
            object p;
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p)) return ((ValuePattern)p).Current.Value ?? "";
            return "";
        }

        // Chromium shows "example.com/page" while not edited: that's https://example.com/page.
        static string Normalize(string v)
        {
            v = (v ?? "").Trim();
            // A local file: Chrome shows file:///C:/…, Edge (unedited) the path itself, "C:/Users/…/a.pdf".
            if (v.StartsWith("file:", StringComparison.OrdinalIgnoreCase)) return v;
            if (Regex.IsMatch(v, @"^[A-Za-z]:[\\/]")) { try { return new Uri(v.Replace('/', '\\')).AbsoluteUri; } catch (Exception) { return ""; } }
            if (v == "" || v.IndexOf(' ') >= 0) return "";
            if (v.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || v.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return v;
            return Hostish.IsMatch(v) ? "https://" + v : "";
        }

        // The file of Recent's newest shortcuts whose name the window's title shows ("report.docx -
        // Word", "report - Word", "notes.txt - Notepad").
        // strict (a browser's tab): only by the full name, extension and all ("report.pdf").
        static string RecentFile(string title, bool strict)
        {
            if (title.Length < 3) return null;
            string dir = Environment.GetFolderPath(Environment.SpecialFolder.Recent);
            if (!Directory.Exists(dir)) return null;
            FileInfo[] lnks = new DirectoryInfo(dir).GetFiles("*.lnk");
            Array.Sort(lnks, delegate (FileInfo a, FileInfo b) { return b.LastWriteTimeUtc.CompareTo(a.LastWriteTimeUtc); });
            int n = 0;
            foreach (FileInfo l in lnks)
            {
                if (n++ >= 80) break;
                string name = Path.GetFileNameWithoutExtension(l.Name); // "report.docx"
                string stem = Path.GetFileNameWithoutExtension(name);
                if (stem == name || stem.Length < 2) continue; // a folder's shortcut
                if (!Shows(title, name) && (strict || !Shows(title, stem))) continue;
                string target = Target(l);
                if (!string.IsNullOrEmpty(target) && File.Exists(target)) return target;
            }
            return null;
        }

        static bool Shows(string title, string name)
        {
            int i = title.IndexOf(name, StringComparison.OrdinalIgnoreCase);
            if (i < 0) return false;
            bool start = i == 0 || " *[(-—–•|".IndexOf(title[i - 1]) >= 0;
            int end = i + name.Length;
            bool stop = end == title.Length || " *])-—–•|:".IndexOf(title[end]) >= 0;
            return start && stop;
        }

        static string Target(FileInfo lnk)
        {
            string key = lnk.FullName + "|" + lnk.LastWriteTimeUtc.Ticks;
            string t;
            if (links.TryGetValue(key, out t)) return t;
            Type type = Type.GetTypeFromProgID("WScript.Shell");
            object sh = Activator.CreateInstance(type);
            try
            {
                object sc = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, sh, new object[] { lnk.FullName });
                t = Convert.ToString(sc.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, sc, null));
                Marshal.ReleaseComObject(sc);
            }
            finally { Marshal.ReleaseComObject(sh); }
            if (links.Count > 500) links.Clear();
            links[key] = t;
            return t;
        }
    }
}

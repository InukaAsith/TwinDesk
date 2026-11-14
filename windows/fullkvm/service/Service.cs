// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Full KVM on Windows (docs/full-kvm.md), the Full KVM build only: twindesk-fullkvm.exe.
//
//   (no arguments)   the TwinDeskFullKvm service, LocalSystem: the kvm pipe and the agent
//   --node           the TwinDeskFullKvmNode service, LOCAL SERVICE: the machine node (System-wide)
//   --setup <off|simple|system> <client exe> <settings dir> [<runtime>]
//                    from the app: asks for an administrator (UAC) and runs --apply as one
//   --apply …        as an administrator: installs, changes or removes the services
//   --state          one line of JSON: { mode, active, node }
//   --stop, --start  as an administrator: the installer around an update (our files are in use)
//
// The service hands the mesh's mouse and keyboard to one client over \\.\pipe\TwinDesk.kvm: the
// console session's signed-in person (their TwinDesk), or, System-wide with nobody signed in, the
// machine node. The pipe's ACL names that one account, and the client must be the TwinDesk the
// administrator installed this for (its image path, in the config only administrators may write).
// For each client it starts the agent (macshare-winhelper-agent.exe --agent, Agent.cs) as SYSTEM in
// the console session, on the input desktop, and passes the helper's own JSON lines both ways, for
// the mouse-and-keyboard commands only. When the input desktop changes (a UAC prompt, the lock
// screen, the login screen) the agent exits; another starts there and gets the last settings again.
// Ctrl+Alt+Del, which Windows never takes from SendInput, becomes SendSAS here.
// C# 5 (the .NET Framework compiler, build.cmd).
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("TwinDesk Full KVM")]
[assembly: System.Reflection.AssemblyProduct("TwinDesk")]

namespace TwinDesk.FullKvm
{
    static class Paths
    {
        public const string Service = "TwinDeskFullKvm";
        public const string NodeService = "TwinDeskFullKvmNode";
        public const string Pipe = "TwinDesk.kvm";
        public static string Data { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "TwinDesk"); } }
        public static string Config { get { return Path.Combine(Data, "fullkvm.json"); } }
        public static string Machine { get { return Path.Combine(Data, "machine"); } }
        public static string Exe { get { return Process.GetCurrentProcess().MainModule.FileName; } }
        // <app>\windows\fullkvm\bin\twindesk-fullkvm.exe -> <app>
        public static string AppRoot { get { return Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Exe), "..", "..", "..")); } }
        public static string Agent { get { return Path.Combine(AppRoot, "windows-helper", "bin", "macshare-winhelper-agent.exe"); } }
        public static string Headless { get { return Path.Combine(AppRoot, "shared", "fullkvm", "headless.js"); } }
    }

    class Config
    {
        public string mode = "off";   // simple | system
        public string client = "";    // the TwinDesk exe that may connect (TwinDesk.exe, or electron.exe in a checkout)
        public string runtime = "";   // what runs headless.js (the same exe, as Node)
        public object sasBefore = null; // SoftwareSASGeneration before we set it (restored on removal)

        static readonly JavaScriptSerializer json = new JavaScriptSerializer();

        public static Config Read()
        {
            try { return json.Deserialize<Config>(File.ReadAllText(Paths.Config)) ?? new Config(); }
            catch (Exception) { return new Config(); }
        }

        public void Write()
        {
            Directory.CreateDirectory(Paths.Data);
            File.WriteAllText(Paths.Config, json.Serialize(this));
        }
    }

    static class Log
    {
        // The node service (LOCAL SERVICE) may write only in the machine folder.
        public static string To = null;

        public static void Line(string s)
        {
            try
            {
                string f = To ?? Path.Combine(Paths.Data, "fullkvm.log");
                if (File.Exists(f) && new FileInfo(f).Length > 1 << 20) File.Delete(f);
                File.AppendAllText(f, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + s + "\r\n");
            }
            catch (Exception) { }
        }
    }

    static class Program
    {
        static int Main(string[] args)
        {
            if (args.Length == 0) { ServiceBase.Run(new KvmService()); return 0; }
            switch (args[0])
            {
                case "--node": ServiceBase.Run(new NodeService(args.Length > 1 ? args[1] : "")); return 0;
                case "--state": Console.Out.Write(Setup.State()); return 0;
                case "--setup": return Setup.Elevate(args);
                case "--apply": return Setup.Apply(args);
                case "--stop": return Setup.Control(false);  // the installer, before it replaces our files
                case "--start": return Setup.Control(true);  // and after
                default: Console.Error.WriteLine("twindesk-fullkvm: --setup | --apply | --state | --node"); return 2;
            }
        }
    }

    // ---- the kvm pipe and the agent ----

    class KvmService : ServiceBase
    {
        static readonly HashSet<string> Allowed = new HashSet<string>(new string[] {
            "ping", "keepalive", "kvmConfig", "screens", "capture", "place", "armReturn", "inject", "pen", "touch", "releaseAll", "watchRelease", "moveTo", "info" });
        // Kept and given again to an agent started on another desktop, in this order.
        static readonly string[] Replayed = new string[] { "kvmConfig", "armReturn", "capture" };

        readonly object gate = new object();
        Config cfg;
        Thread loop;
        volatile bool stopping;
        string ownerSid = null; // who the pipe is for now
        NamedPipeServerStream pipe;
        Client client;

        public KvmService()
        {
            ServiceName = Paths.Service;
            CanStop = true;
        }

        protected override void OnStart(string[] args)
        {
            cfg = Config.Read();
            Log.Line("started (" + cfg.mode + ")");
            loop = new Thread(Loop);
            loop.IsBackground = true;
            loop.Start();
        }

        protected override void OnStop()
        {
            stopping = true;
            lock (gate) { DropClient(); ClosePipe(); }
            Node(false);
            Log.Line("stopped");
        }

        protected override void OnCustomCommand(int command)
        {
            if (command == 128) { cfg = Config.Read(); Log.Line("mode " + cfg.mode); lock (gate) { ownerSid = null; } } // --apply changed the mode
        }

        void Loop()
        {
            while (!stopping)
            {
                try { Tick(); } catch (Exception e) { Log.Line("tick: " + e.Message); }
                Thread.Sleep(1000);
            }
        }

        // Who the console belongs to: the signed-in person (also while locked: it is their session),
        // or, System-wide with nobody signed in, the machine node (LOCAL SERVICE).
        void Tick()
        {
            uint session = Win.WTSGetActiveConsoleSessionId();
            string user = Win.ConsoleUserSid(session);
            bool system = cfg.mode == "system";
            string want = user ?? (system ? Win.LocalServiceSid : null);
            Node(system && user == null && session != 0xFFFFFFFF);
            lock (gate)
            {
                if (want == ownerSid && (pipe != null || client != null)) return; // waiting, or in use
                Log.Line("console " + session + ": " + (user != null ? "signed in" : system ? "login screen (machine node)" : "nobody"));
                DropClient();
                ClosePipe();
                ownerSid = want;
                if (want != null) OpenPipe(want);
            }
        }

        void OpenPipe(string sid)
        {
            PipeSecurity ps = new PipeSecurity();
            ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid), PipeAccessRights.ReadWrite, AccessControlType.Allow));
            ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
            ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny)); // never from another computer
            NamedPipeServerStream p = new NamedPipeServerStream(Paths.Pipe, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, ps);
            pipe = p;
            p.BeginWaitForConnection(delegate (IAsyncResult ar) { OnConnect(p, ar); }, null);
        }

        void ClosePipe()
        {
            if (pipe == null) return;
            try { pipe.Dispose(); } catch (Exception) { }
            pipe = null;
        }

        void OnConnect(NamedPipeServerStream p, IAsyncResult ar)
        {
            try { p.EndWaitForConnection(ar); } catch (Exception) { return; }
            lock (gate)
            {
                if (p != pipe) { try { p.Dispose(); } catch (Exception) { } return; }
                string image = Win.ClientImage(p);
                if (cfg.client.Length == 0 || !string.Equals(image, cfg.client, StringComparison.OrdinalIgnoreCase))
                {
                    Log.Line("refused a client: " + image);
                    pipe = null;
                    try { p.Dispose(); } catch (Exception) { }
                    OpenPipe(ownerSid);
                    return;
                }
                pipe = null; // this instance is the client's now; the next comes when it goes
                client = new Client(this, p);
                client.Start();
            }
        }

        void DropClient()
        {
            if (client == null) return;
            client.Stop();
            client = null;
        }

        // The client went (or its agent couldn't run): a new pipe instance for the next one.
        internal void ClientGone(Client c)
        {
            lock (gate)
            {
                if (client != c) return;
                client = null;
                Log.Line("client gone");
                if (ownerSid != null && pipe == null && !stopping) OpenPipe(ownerSid);
            }
        }

        void Node(bool on)
        {
            try
            {
                using (ServiceController sc = new ServiceController(Paths.NodeService))
                {
                    ServiceControllerStatus st = sc.Status;
                    if (on && st == ServiceControllerStatus.Stopped) { sc.Start(); Log.Line("machine node started"); }
                    else if (!on && st == ServiceControllerStatus.Running) { sc.Stop(); Log.Line("machine node stopped"); }
                }
            }
            catch (InvalidOperationException) { /* not installed (Signed in) */ }
            catch (Exception e) { Log.Line("node: " + e.Message); }
        }

        // ---- one client and its agent ----

        internal class Client
        {
            readonly KvmService svc;
            readonly NamedPipeServerStream pipe;
            readonly Dictionary<string, string> kept = new Dictionary<string, string>();
            readonly object agentGate = new object();
            Win.Agent agent;
            volatile bool done;
            bool readySent; // the client has had an agent's "ready": a later one's is ours (Replay)
            string desktop = "Default"; // where the next agent starts (the last one said where to)
            bool ctrl, alt;

            public Client(KvmService svc, NamedPipeServerStream pipe) { this.svc = svc; this.pipe = pipe; }

            public void Start()
            {
                if (!StartAgent()) { Stop(); svc.ClientGone(this); return; }
                Thread t = new Thread(FromClient);
                t.IsBackground = true;
                t.Start();
            }

            bool StartAgent()
            {
                Win.Agent a = Win.StartAgent(Paths.Agent, desktop);
                if (a == null) { Log.Line("the agent didn't start: " + Win.LastError); return false; }
                lock (agentGate) agent = a;
                Log.Line("agent " + a.Pid);
                Thread t = new Thread(delegate () { FromAgent(a); });
                t.IsBackground = true;
                t.Start();
                return true;
            }

            public void Stop()
            {
                done = true;
                Win.Agent a;
                lock (agentGate) { a = agent; agent = null; }
                if (a != null) a.Close(); // EOF: it lets go of every key and button and exits
                try { pipe.Dispose(); } catch (Exception) { }
            }

            void FromClient()
            {
                StreamReader r = new StreamReader(pipe, new UTF8Encoding(false));
                try
                {
                    string line;
                    while (!done && (line = r.ReadLine()) != null)
                    {
                        if (line.Length > 262144) break;
                        Dictionary<string, object> c;
                        try { c = Win.Json.DeserializeObject(line) as Dictionary<string, object>; }
                        catch (Exception) { continue; }
                        if (c == null) continue;
                        object cmdObj;
                        string cmd = c.TryGetValue("cmd", out cmdObj) ? cmdObj as string : null;
                        if (cmd == null || !Allowed.Contains(cmd))
                        {
                            object id;
                            if (c.TryGetValue("id", out id)) ToClient("{\"id\":" + Win.Json.Serialize(id) + ",\"ok\":false,\"error\":\"not allowed through Full KVM\"}");
                            continue;
                        }
                        if (cmd == "inject" && Sas(c)) continue;
                        string clean = Win.Json.Serialize(c);
                        if (Array.IndexOf(Replayed, cmd) >= 0) kept[cmd] = clean;
                        lock (agentGate) { if (agent != null) agent.Write(clean); }
                    }
                }
                catch (Exception) { }
                Stop();
                svc.ClientGone(this);
            }

            // Ctrl+Alt+Del: Windows never takes it from SendInput; SendSAS from a service it does.
            bool Sas(Dictionary<string, object> c)
            {
                object evObj;
                Dictionary<string, object> ev = c.TryGetValue("ev", out evObj) ? evObj as Dictionary<string, object> : null;
                if (ev == null) return false;
                object t, code;
                string type = ev.TryGetValue("t", out t) ? t as string : "";
                string k = ev.TryGetValue("code", out code) ? code as string : "";
                bool down = type == "k.kd";
                if (type != "k.kd" && type != "k.ku") return false;
                if (k == "ControlLeft" || k == "ControlRight") ctrl = down;
                else if (k == "AltLeft" || k == "AltRight") alt = down;
                else if ((k == "Delete" || k == "NumpadDecimal") && ctrl && alt)
                {
                    if (down) { Log.Line("Ctrl+Alt+Del"); try { Win.SendSAS(false); } catch (Exception e) { Log.Line("SendSAS: " + e.Message); } }
                    return true;
                }
                return false;
            }

            void ToClient(string line)
            {
                try
                {
                    byte[] b = Encoding.UTF8.GetBytes(line + "\n");
                    lock (pipe) pipe.Write(b, 0, b.Length);
                }
                catch (Exception) { }
            }

            void FromAgent(Win.Agent a)
            {
                string line;
                while ((line = a.ReadLine()) != null)
                {
                    if (done) break;
                    if (line.IndexOf("\"event\":\"agentDesktop\"", StringComparison.Ordinal) >= 0) { Want(line); continue; } // ours, not the app's
                    if (line.IndexOf("\"event\":\"ready\"", StringComparison.Ordinal) >= 0)
                    {
                        // The client's first "ready" goes through, whichever agent says it: at the login
                        // screen the first agent (on Default) leaves for Winlogon before it is ready, and
                        // without one the client sends nothing. A later agent's is ours: the last settings again.
                        if (readySent) { Replay(a); continue; }
                        readySent = true;
                    }
                    ToClient(line);
                }
                int code = a.Wait();
                lock (agentGate) { if (agent != a) return; agent = null; }
                if (done) return;
                if (code == 3) // Agent.DESKTOP_CHANGED: the same client, on the new input desktop
                {
                    Thread.Sleep(100);
                    if (StartAgent()) return;
                }
                Log.Line("agent exited " + code);
                Stop();
                svc.ClientGone(this);
            }

            // {"event":"agentDesktop","from":…,"want":"Winlogon"}: the next agent's desktop.
            void Want(string line)
            {
                try
                {
                    Dictionary<string, object> m = Win.Json.DeserializeObject(line) as Dictionary<string, object>;
                    object w;
                    if (m != null && m.TryGetValue("want", out w) && w is string && ((string)w).Length > 0)
                    {
                        desktop = (string)w;
                        Log.Line("input desktop: " + desktop);
                    }
                }
                catch (Exception) { }
            }

            void Replay(Win.Agent a)
            {
                foreach (string cmd in Replayed)
                {
                    string l;
                    if (kept.TryGetValue(cmd, out l)) a.Write(l);
                }
            }
        }
    }

    // ---- the machine node (System-wide), as LOCAL SERVICE ----

    class NodeService : ServiceBase
    {
        Process child;
        readonly string runtime; // on its command line: LOCAL SERVICE can't read fullkvm.json

        public NodeService(string runtime) { this.runtime = runtime; ServiceName = Paths.NodeService; CanStop = true; }

        protected override void OnStart(string[] args)
        {
            Log.To = Path.Combine(Paths.Machine, "node.log");
            ProcessStartInfo si = new ProcessStartInfo(runtime, "\"" + Paths.Headless + "\"");
            si.UseShellExecute = false;
            si.CreateNoWindow = true;
            si.WorkingDirectory = Paths.Machine;
            si.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            si.EnvironmentVariables["TWINDESK_MACHINE_DIR"] = Paths.Machine;
            si.EnvironmentVariables["TWINDESK_KVM_SOCK"] = @"\\.\pipe\" + Paths.Pipe;
            si.RedirectStandardOutput = true;
            si.RedirectStandardError = true;
            child = Process.Start(si);
            child.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) Log.Line("[node] " + e.Data); };
            child.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) Log.Line("[node] " + e.Data); };
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            child.EnableRaisingEvents = true;
            child.Exited += delegate { if (child != null) Stop(); }; // it ended by itself: the service too (KvmService starts it again)
        }

        protected override void OnStop()
        {
            Process c = child;
            child = null;
            if (c == null || c.HasExited) return;
            try { c.Kill(); } catch (Exception) { }
        }
    }

    // ---- setup: --setup (from the app) and --apply (as an administrator) ----

    static class Setup
    {
        public static string State()
        {
            // From the app, as the user: fullkvm.json is the administrators' only; the services say it.
            string mode = !Installed(Paths.Service) ? "off" : Installed(Paths.NodeService) ? "system" : "simple";
            return "{\"mode\":\"" + mode + "\",\"active\":" + (Running(Paths.Service) ? "true" : "false") + ",\"node\":" + (Running(Paths.NodeService) ? "true" : "false") + "}";
        }

        public static int Control(bool start)
        {
            foreach (string name in start ? new string[] { Paths.Service } : new string[] { Paths.NodeService, Paths.Service })
            {
                try
                {
                    using (ServiceController sc = new ServiceController(name))
                    {
                        if (start && sc.Status == ServiceControllerStatus.Stopped) sc.Start();
                        else if (!start && sc.Status != ServiceControllerStatus.Stopped) { sc.Stop(); sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(10)); }
                    }
                }
                catch (Exception) { /* not installed, or already so */ }
            }
            return 0;
        }

        static bool Installed(string name)
        {
            try { using (ServiceController sc = new ServiceController(name)) { ServiceControllerStatus s = sc.Status; return true; } }
            catch (InvalidOperationException) { return false; }
        }

        static bool Running(string name)
        {
            try { using (ServiceController sc = new ServiceController(name)) return sc.Status == ServiceControllerStatus.Running; }
            catch (InvalidOperationException) { return false; }
        }

        // From the app (not elevated): the same exe with --apply, as an administrator (one UAC prompt).
        public static int Elevate(string[] args)
        {
            if (args.Length < 4) return 2;
            StringBuilder sb = new StringBuilder("--apply");
            for (int i = 1; i < args.Length; i++) sb.Append(" \"").Append(args[i].Replace("\"", "")).Append('"');
            ProcessStartInfo si = new ProcessStartInfo(Paths.Exe, sb.ToString());
            si.UseShellExecute = true;
            si.Verb = "runas";
            si.WindowStyle = ProcessWindowStyle.Hidden;
            try
            {
                using (Process p = Process.Start(si)) { p.WaitForExit(); return p.ExitCode; }
            }
            catch (Win32Exception e) { Console.Error.WriteLine(e.NativeErrorCode == 1223 ? "The administrator’s approval was not given" : e.Message); return 5; }
        }

        // --apply <off|simple|system> <client exe> <settings dir> [<runtime>]
        public static int Apply(string[] args)
        {
            try
            {
                string mode = args.Length > 1 ? args[1] : "";
                if (mode != "off" && mode != "simple" && mode != "system") return 2;
                Config cfg = Config.Read();
                if (mode == "off") { Remove(cfg); return 0; }
                string client = args.Length > 2 ? Path.GetFullPath(args[2]) : "";
                string settings = args.Length > 3 ? args[3] : "";
                string runtime = args.Length > 4 ? Path.GetFullPath(args[4]) : client;
                if (!File.Exists(client) || !File.Exists(Paths.Agent)) { Console.Error.WriteLine("TwinDesk's files aren't all there"); return 3; }
                LockDown();
                cfg.mode = mode;
                cfg.client = client;
                cfg.runtime = runtime;
                if (cfg.sasBefore == null) cfg.sasBefore = Registry.GetValue(SasKey, "SoftwareSASGeneration", "none") ?? "none";
                Registry.SetValue(SasKey, "SoftwareSASGeneration", 1, RegistryValueKind.DWord); // services may raise Ctrl+Alt+Del
                cfg.Write();
                if (mode == "system") CopyState(settings); else WipeState();
                Win.InstallService(Paths.Service, "TwinDesk Full KVM", "\"" + Paths.Exe + "\"", null);
                if (mode == "system") Win.InstallService(Paths.NodeService, "TwinDesk Full KVM (login screen)", "\"" + Paths.Exe + "\" --node \"" + runtime + "\"", @"NT AUTHORITY\LocalService");
                else Win.DeleteService(Paths.NodeService);
                using (ServiceController sc = new ServiceController(Paths.Service))
                {
                    if (sc.Status == ServiceControllerStatus.Running) sc.ExecuteCommand(128);
                    else sc.Start();
                }
                return 0;
            }
            catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
        }

        const string SasKey = @"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";

        static void Remove(Config cfg)
        {
            Win.DeleteService(Paths.NodeService);
            Win.DeleteService(Paths.Service);
            if (cfg.sasBefore != null)
            {
                if ("none".Equals(cfg.sasBefore)) { using (RegistryKey k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", true)) { if (k != null) k.DeleteValue("SoftwareSASGeneration", false); } }
                else Registry.SetValue(SasKey, "SoftwareSASGeneration", Convert.ToInt32(cfg.sasBefore), RegistryValueKind.DWord);
            }
            WipeState();
            try { File.Delete(Paths.Config); } catch (Exception) { }
        }

        // %ProgramData%\TwinDesk: administrators and SYSTEM only (a folder a user made before us is
        // taken back), LOCAL SERVICE may read and write the machine node's folder.
        static void LockDown()
        {
            Directory.CreateDirectory(Paths.Data);
            DirectorySecurity ds = new DirectorySecurity();
            ds.SetAccessRuleProtection(true, false);
            SecurityIdentifier admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            ds.SetOwner(admins);
            ds.AddAccessRule(new FileSystemAccessRule(admins, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            ds.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(Paths.Data, ds);
        }

        static void CopyState(string from)
        {
            if (string.IsNullOrEmpty(from) || !Directory.Exists(from)) throw new Exception("System-wide needs TwinDesk's settings folder");
            WipeState();
            Directory.CreateDirectory(Paths.Machine);
            foreach (string f in new string[] { "device.json", "paired.json", "paired-mesh.json", "pairing.json", "pairings.json", "multi.json", "settings.json", "fullkvm-displays.json" })
            {
                string src = Path.Combine(from, f);
                if (File.Exists(src)) File.Copy(src, Path.Combine(Paths.Machine, f), true);
            }
            string id = Path.Combine(from, "identity");
            if (Directory.Exists(id))
            {
                Directory.CreateDirectory(Path.Combine(Paths.Machine, "identity"));
                foreach (string f in Directory.GetFiles(id)) File.Copy(f, Path.Combine(Paths.Machine, "identity", Path.GetFileName(f)), true);
            }
            DirectorySecurity ds = Directory.GetAccessControl(Paths.Machine);
            ds.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalServiceSid, null), FileSystemRights.Modify, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(Paths.Machine, ds);
        }

        static void WipeState()
        {
            try { if (Directory.Exists(Paths.Machine)) Directory.Delete(Paths.Machine, true); } catch (Exception) { }
        }
    }

    // ---- Windows ----

    static class Win
    {
        public static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        public static readonly string LocalServiceSid = new SecurityIdentifier(WellKnownSidType.LocalServiceSid, null).Value;
        public static string LastError = "";

        [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSQueryUserToken(uint session, out IntPtr token);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, int len, out int needed);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attrs, int level, int type, out IntPtr dup);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int cls, ref uint info, int len);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr p, uint flags, StringBuilder name, ref uint size);
        [DllImport("sas.dll")] public static extern void SendSAS(bool asUser);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenSCManager(string machine, string db, uint access);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern IntPtr CreateService(IntPtr scm, string name, string display, uint access, uint type, uint start, uint error, string path, string group, IntPtr tag, string deps, string user, string password);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenService(IntPtr scm, string name, uint access);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool DeleteService(IntPtr svc);
        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool ChangeServiceConfig(IntPtr svc, uint type, uint start, uint error, string path, string group, IntPtr tag, string deps, string user, string password, string display);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool CloseServiceHandle(IntPtr h);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool ControlService(IntPtr svc, uint control, byte[] status);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFO
        {
            public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
            public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }
        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

        // The SID of the person signed in on that session, or null (nobody: the login screen).
        public static string ConsoleUserSid(uint session)
        {
            if (session == 0xFFFFFFFF) return null;
            IntPtr token;
            if (!WTSQueryUserToken(session, out token)) return null;
            try
            {
                int needed;
                GetTokenInformation(token, 1 /* TokenUser */, IntPtr.Zero, 0, out needed);
                IntPtr buf = Marshal.AllocHGlobal(needed);
                try
                {
                    if (!GetTokenInformation(token, 1, buf, needed, out needed)) return null;
                    return new SecurityIdentifier(Marshal.ReadIntPtr(buf)).Value;
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
            finally { CloseHandle(token); }
        }

        // The image path of the process at the pipe's other end.
        public static string ClientImage(NamedPipeServerStream p)
        {
            uint pid;
            if (!GetNamedPipeClientProcessId(p.SafePipeHandle.DangerousGetHandle(), out pid)) return "";
            IntPtr h = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
            if (h == IntPtr.Zero) return "";
            try
            {
                StringBuilder sb = new StringBuilder(1024);
                uint size = (uint)sb.Capacity;
                return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : "";
            }
            finally { CloseHandle(h); }
        }

        // The agent as SYSTEM in the console session (our own token, moved there), on that desktop of
        // winsta0, its stdin and stdout ours.
        public static Agent StartAgent(string exe, string desktop)
        {
            uint session = WTSGetActiveConsoleSessionId();
            IntPtr self, tok;
            if (!OpenProcessToken(GetCurrentProcess(), 0x0002 | 0x0001 | 0x0008 | 0x0100 | 0x0080 /* DUPLICATE, ASSIGN_PRIMARY, QUERY, ADJUST_SESSIONID, ADJUST_DEFAULT */, out self)) { LastError = "OpenProcessToken " + Marshal.GetLastWin32Error(); return null; }
            try
            {
                if (!DuplicateTokenEx(self, 0x02000000 /* MAXIMUM_ALLOWED */, IntPtr.Zero, 2 /* SecurityImpersonation */, 1 /* TokenPrimary */, out tok)) { LastError = "DuplicateTokenEx " + Marshal.GetLastWin32Error(); return null; }
            }
            finally { CloseHandle(self); }
            AnonymousPipeServerStream toAgent = null, fromAgent = null;
            try
            {
                if (!SetTokenInformation(tok, 12 /* TokenSessionId */, ref session, 4)) { LastError = "SetTokenInformation " + Marshal.GetLastWin32Error(); return null; }
                toAgent = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
                fromAgent = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
                STARTUPINFO si = new STARTUPINFO();
                si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                si.lpDesktop = @"winsta0\" + desktop; // every thread of the agent's is there (Agent.cs)
                si.dwFlags = 0x00000100; // STARTF_USESTDHANDLES
                si.hStdInput = toAgent.ClientSafePipeHandle.DangerousGetHandle();
                si.hStdOutput = fromAgent.ClientSafePipeHandle.DangerousGetHandle();
                si.hStdError = fromAgent.ClientSafePipeHandle.DangerousGetHandle();
                PROCESS_INFORMATION pi;
                StringBuilder cmd = new StringBuilder("\"" + exe + "\" --agent");
                if (!CreateProcessAsUser(tok, exe, cmd, IntPtr.Zero, IntPtr.Zero, true, 0x08000000 /* CREATE_NO_WINDOW */, IntPtr.Zero, Path.GetDirectoryName(exe), ref si, out pi))
                {
                    LastError = "CreateProcessAsUser " + Marshal.GetLastWin32Error();
                    toAgent.Dispose(); fromAgent.Dispose();
                    return null;
                }
                toAgent.DisposeLocalCopyOfClientHandle();
                fromAgent.DisposeLocalCopyOfClientHandle();
                CloseHandle(pi.hThread);
                return new Agent(pi.hProcess, pi.dwProcessId, toAgent, fromAgent);
            }
            finally { CloseHandle(tok); }
        }

        public class Agent
        {
            readonly IntPtr process;
            public readonly int Pid;
            readonly AnonymousPipeServerStream input, output;
            readonly StreamWriter w;
            readonly StreamReader r;
            bool closed;

            public Agent(IntPtr process, int pid, AnonymousPipeServerStream input, AnonymousPipeServerStream output)
            {
                this.process = process;
                Pid = pid;
                this.input = input;
                this.output = output;
                w = new StreamWriter(input, new UTF8Encoding(false));
                w.AutoFlush = true;
                w.NewLine = "\n";
                r = new StreamReader(output, new UTF8Encoding(false));
            }

            public void Write(string line)
            {
                lock (w) { if (!closed) { try { w.WriteLine(line); } catch (Exception) { } } }
            }

            public string ReadLine()
            {
                try { return r.ReadLine(); } catch (Exception) { return null; }
            }

            public void Close()
            {
                lock (w) { if (closed) return; closed = true; try { input.Dispose(); } catch (Exception) { } }
            }

            public int Wait()
            {
                WaitForSingleObject(process, 5000);
                uint code;
                int c = GetExitCodeProcess(process, out code) ? (int)code : -1;
                CloseHandle(process);
                try { output.Dispose(); } catch (Exception) { }
                Close();
                return c;
            }
        }

        public static void InstallService(string name, string display, string path, string user)
        {
            IntPtr scm = OpenSCManager(null, null, 0xF003F);
            if (scm == IntPtr.Zero) throw new Win32Exception();
            try
            {
                IntPtr s = OpenService(scm, name, 0xF01FF);
                if (s != IntPtr.Zero) // there: its command line again (another TwinDesk.exe, a new runtime)
                {
                    bool ok = ChangeServiceConfig(s, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, path, null, IntPtr.Zero, null, null, null, null);
                    CloseServiceHandle(s);
                    if (!ok) throw new Win32Exception();
                    return;
                }
                // Own process; the main one starts with Windows, the node one only on demand.
                s = CreateService(scm, name, display, 0xF01FF, 0x10, user == null ? 2u : 3u, 1, path, null, IntPtr.Zero, null, user, null);
                if (s == IntPtr.Zero) throw new Win32Exception();
                CloseServiceHandle(s);
            }
            finally { CloseServiceHandle(scm); }
        }

        public static void DeleteService(string name)
        {
            IntPtr scm = OpenSCManager(null, null, 0xF003F);
            if (scm == IntPtr.Zero) return;
            try
            {
                IntPtr s = OpenService(scm, name, 0xF01FF);
                if (s == IntPtr.Zero) return;
                ControlService(s, 1 /* SERVICE_CONTROL_STOP */, new byte[36]);
                DeleteService(s);
                CloseServiceHandle(s);
            }
            finally { CloseServiceHandle(scm); }
        }
    }
}

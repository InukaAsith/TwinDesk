// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This PC's sound without TwinDesk's own: Windows' process loopback (Windows 10 build 20348+, so
// Windows 11 in practice) set to leave out one process tree, TwinDesk's (every Electron process is a
// child of its main process). The sound another computer plays here through TwinDesk is then never
// captured and sent back, which looped when two computers shared sound both ways.
//
// soundCapture {on: true, pid} → {pipe}: a named pipe main reads (net.connect), 48 kHz stereo float32
// frames, as the Mac's helper writes on fd 3 (Audio.swift). {on: false} stops it. Older Windows: an
// error, and main keeps Chromium's capture (which still has the loop).
//
// The endpoint's volume and mute don't reach this capture: it taps the apps' streams before them,
// so "Mute this PC while sending" can mute the speakers and the sound still goes out.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;

namespace MacShare
{
    static class SoundCapture
    {
        const string LOOPBACK_PATH = "VAD\\Process_Loopback"; // VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
        const int RATE = 48000, CH = 2;

        static readonly object gate = new object();
        static Runner cur;

        public static void Dispatch(Dictionary<string, object> c, Dictionary<string, object> r)
        {
            lock (gate)
            {
                if (cur != null) { cur.Stop(); cur = null; }
                if (!Json.Bool(c, "on", false)) return;
                uint pid = (uint)Json.Num(c, "pid", 0);
                if (pid == 0) throw new Exception("no process id");
                Version v = Environment.OSVersion.Version;
                if (v.Major < 10 || (v.Major == 10 && v.Build < 20348)) throw new Exception("process loopback needs Windows 10 build 20348 or later");
                Runner run = new Runner(pid);
                run.Start(); // throws when Windows refuses the capture
                cur = run;
                r["pipe"] = run.PipePath;
            }
        }

        public static void Shutdown()
        {
            lock (gate) { if (cur != null) cur.Stop(); cur = null; }
        }

        sealed class Runner
        {
            readonly uint pid;
            readonly string name = "twindesk-sound-" + Guid.NewGuid().ToString("N");
            NamedPipeServerStream pipe;
            IAudioClient client;
            IAudioCaptureClient cap;
            readonly AutoResetEvent ready = new AutoResetEvent(false);
            volatile bool stop;
            Thread thread;

            public Runner(uint pid) { this.pid = pid; }
            public string PipePath { get { return "\\\\.\\pipe\\" + name; } }

            public void Start()
            {
                client = Activate(pid);
                IntPtr fmt = Marshal.AllocHGlobal(18);
                try
                {
                    // WAVEFORMATEX: 16-bit PCM (what the process loopback takes), converted to float below.
                    Marshal.WriteInt16(fmt, 0, 1);              // wFormatTag WAVE_FORMAT_PCM
                    Marshal.WriteInt16(fmt, 2, CH);             // nChannels
                    Marshal.WriteInt32(fmt, 4, RATE);           // nSamplesPerSec
                    Marshal.WriteInt32(fmt, 8, RATE * CH * 2);  // nAvgBytesPerSec
                    Marshal.WriteInt16(fmt, 12, CH * 2);        // nBlockAlign
                    Marshal.WriteInt16(fmt, 14, 16);            // wBitsPerSample
                    Marshal.WriteInt16(fmt, 16, 0);             // cbSize
                    const uint LOOPBACK = 0x00020000, EVENTCALLBACK = 0x00040000, AUTOCONVERTPCM = 0x80000000;
                    Check(client.Initialize(0, LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM, 200000, 0, fmt, IntPtr.Zero), "Initialize");
                }
                finally { Marshal.FreeHGlobal(fmt); }
                Check(client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle()), "SetEventHandle");
                Guid iid = typeof(IAudioCaptureClient).GUID;
                object svc;
                Check(client.GetService(ref iid, out svc), "GetService");
                cap = (IAudioCaptureClient)svc;
                pipe = new NamedPipeServerStream(name, PipeDirection.Out, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 1 << 16);
                thread = new Thread(Loop) { IsBackground = true, Name = "soundCapture" };
                thread.Start();
            }

            void Loop()
            {
                try
                {
                    IAsyncResult w = pipe.BeginWaitForConnection(null, null);
                    if (!w.AsyncWaitHandle.WaitOne(10000) || stop) return; // main never came: give up
                    pipe.EndWaitForConnection(w);
                    Check(client.Start(), "Start");
                    byte[] outBuf = new byte[0];
                    short[] tmp = new short[0];
                    float[] fl = new float[0];
                    while (!stop)
                    {
                        ready.WaitOne(200);
                        uint packet;
                        while (!stop && cap.GetNextPacketSize(out packet) == 0 && packet > 0)
                        {
                            IntPtr data; uint frames, flags; ulong dev, qpc;
                            if (cap.GetBuffer(out data, out frames, out flags, out dev, out qpc) != 0) break;
                            int n = (int)frames * CH;
                            if (outBuf.Length < n * 4) outBuf = new byte[n * 4];
                            if ((flags & 2) != 0) Array.Clear(outBuf, 0, n * 4); // AUDCLNT_BUFFERFLAGS_SILENT
                            else
                            {
                                if (tmp.Length < n) { tmp = new short[n]; fl = new float[n]; }
                                Marshal.Copy(data, tmp, 0, n);
                                for (int i = 0; i < n; i++) fl[i] = tmp[i] / 32768f;
                                Buffer.BlockCopy(fl, 0, outBuf, 0, n * 4); // little-endian float32, as the Mac's
                            }
                            cap.ReleaseBuffer(frames);
                            if (n > 0) pipe.Write(outBuf, 0, n * 4); // main stopped reading: IOException ends the loop
                        }
                    }
                }
                catch (Exception e) { try { Console.Error.WriteLine("[sound] capture: " + e.Message); } catch (Exception) { }; }
                finally
                {
                    try { client.Stop(); } catch (Exception) { }
                    try { pipe.Dispose(); } catch (Exception) { }
                    Release();
                }
            }

            public void Stop()
            {
                stop = true;
                ready.Set();
                if (thread == null) { try { if (pipe != null) pipe.Dispose(); } catch (Exception) { } Release(); }
            }

            void Release()
            {
                if (cap != null) { try { Marshal.ReleaseComObject(cap); } catch (Exception) { } cap = null; }
                if (client != null) { try { Marshal.ReleaseComObject(client); } catch (Exception) { } client = null; }
            }
        }

        static void Check(int hr, string what)
        {
            if (hr != 0) throw new Exception(what + " failed (0x" + hr.ToString("X8") + ")");
        }

        // ActivateAudioInterfaceAsync on the process loopback device, leaving out pid's process tree.
        static IAudioClient Activate(uint pid)
        {
            // AUDIOCLIENT_ACTIVATION_PARAMS {ActivationType = PROCESS_LOOPBACK (1), TargetProcessId,
            // ProcessLoopbackMode = EXCLUDE_TARGET_PROCESS_TREE (1)}, in a PROPVARIANT of type VT_BLOB.
            IntPtr parms = Marshal.AllocHGlobal(12);
            IntPtr pv = Marshal.AllocHGlobal(8 + 2 * IntPtr.Size);
            try
            {
                Marshal.WriteInt32(parms, 0, 1);
                Marshal.WriteInt32(parms, 4, (int)pid);
                Marshal.WriteInt32(parms, 8, 1);
                for (int i = 0; i < 8 + 2 * IntPtr.Size; i++) Marshal.WriteByte(pv, i, 0);
                Marshal.WriteInt16(pv, 0, 65);                // vt = VT_BLOB
                Marshal.WriteInt32(pv, 8, 12);                // blob.cbSize
                Marshal.WriteIntPtr(pv, 8 + IntPtr.Size, parms); // blob.pBlobData (pointer-aligned)
                Handler h = new Handler();
                IActivateAudioInterfaceAsyncOperation op;
                Guid iid = typeof(IAudioClient).GUID;
                int hr = ActivateAudioInterfaceAsync(LOOPBACK_PATH, ref iid, pv, h, out op);
                if (hr != 0) throw new Exception("ActivateAudioInterfaceAsync failed (0x" + hr.ToString("X8") + ")");
                if (!h.Done.WaitOne(5000)) throw new Exception("Windows didn't open the sound capture");
                int res; object iface;
                op.GetActivateResult(out res, out iface);
                Check(res, "Activate");
                return (IAudioClient)iface;
            }
            finally { Marshal.FreeHGlobal(pv); Marshal.FreeHGlobal(parms); }
        }

        [DllImport("Mmdevapi.dll", ExactSpelling = true)]
        static extern int ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid riid, IntPtr activationParams,
            IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation op);

        // The completion handler must be agile: a .NET object's COM wrapper is (free-threaded), and it
        // says so with IAgileObject.
        [ClassInterface(ClassInterfaceType.None)]
        sealed class Handler : IActivateAudioInterfaceCompletionHandler, IAgileObject
        {
            public readonly ManualResetEvent Done = new ManualResetEvent(false);
            public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation op) { Done.Set(); return 0; }
        }

        [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAgileObject { }

        [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IActivateAudioInterfaceCompletionHandler
        {
            [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation op);
        }

        [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IActivateAudioInterfaceAsyncOperation
        {
            [PreserveSig] int GetActivateResult(out int hr, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        }

        [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioClient
        {
            [PreserveSig] int Initialize(int shareMode, uint flags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
            [PreserveSig] int GetBufferSize(out uint frames);
            [PreserveSig] int GetStreamLatency(out long latency);
            [PreserveSig] int GetCurrentPadding(out uint frames);
            [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
            [PreserveSig] int GetMixFormat(out IntPtr format);
            [PreserveSig] int GetDevicePeriod(out long def, out long min);
            [PreserveSig] int Start();
            [PreserveSig] int Stop();
            [PreserveSig] int Reset();
            [PreserveSig] int SetEventHandle(IntPtr handle);
            [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
        }

        [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioCaptureClient
        {
            [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
            [PreserveSig] int ReleaseBuffer(uint frames);
            [PreserveSig] int GetNextPacketSize(out uint frames);
        }
    }
}

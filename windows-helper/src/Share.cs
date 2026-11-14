// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Windows' Share for files here (Photos › Share, shared/phonehub.js shareImage): DataTransferManager
// through its interop, which wants a window of this process. So: a tiny, see-through tool window at
// the pointer (where Share was just clicked), on its own STA thread with a message loop, kept until
// something is shared or a few minutes pass. One at a time: a new Share closes the last one.
//   share {paths: [file, …], title}
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading;
using System.Windows.Forms;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Windows.Storage.Streams;

namespace MacShare
{
    static class Share
    {
        [ComImport, Guid("3A3DCD6C-3EAB-43DC-BCDE-45671CE800C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IDataTransferManagerInterop
        {
            IntPtr GetForWindow([In] IntPtr appWindow, [In] ref Guid riid);
            void ShowShareUIForWindow(IntPtr appWindow);
        }
        static Guid DtmIid = new Guid(0xa5caee9b, 0x8708, 0x49d1, 0x8d, 0x36, 0x67, 0xd2, 0x5a, 0x8d, 0xa0, 0x0c);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);

        static readonly object gate = new object();
        static Form current;

        public static void Files(List<string> paths, string title)
        {
            List<string> files = new List<string>();
            foreach (string p in paths) if (!string.IsNullOrEmpty(p) && File.Exists(p)) files.Add(p);
            if (files.Count == 0) return;
            Point at = Cursor.Position;
            Thread t = new Thread(delegate () { Run(files, title, at); });
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
        }

        static void Run(List<string> files, string title, Point at)
        {
            Form f = new Form();
            f.FormBorderStyle = FormBorderStyle.None;
            f.ShowInTaskbar = false;
            f.StartPosition = FormStartPosition.Manual;
            f.Bounds = new Rectangle(at.X, at.Y, 1, 1);
            f.Opacity = 0.01;
            f.TopMost = true;
            lock (gate)
            {
                Form last = current;
                current = f;
                if (last != null) try { last.BeginInvoke((MethodInvoker)delegate { last.Close(); }); } catch (Exception) { }
            }
            System.Windows.Forms.Timer quit = new System.Windows.Forms.Timer();
            quit.Interval = 5 * 60 * 1000;
            quit.Tick += delegate { f.Close(); };
            f.Shown += delegate
            {
                try
                {
                    List<IStorageItem> items = new List<IStorageItem>();
                    foreach (string p in files) items.Add(StorageFile.GetFileFromPathAsync(p).AsTask().Result);
                    IDataTransferManagerInterop interop = (IDataTransferManagerInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(DataTransferManager));
                    IntPtr ptr = interop.GetForWindow(f.Handle, ref DtmIid);
                    DataTransferManager dtm = (DataTransferManager)Marshal.GetObjectForIUnknown(ptr);
                    Marshal.Release(ptr);
                    dtm.DataRequested += delegate (DataTransferManager s, DataRequestedEventArgs e)
                    {
                        DataPackage d = e.Request.Data;
                        d.Properties.Title = string.IsNullOrEmpty(title) ? Path.GetFileName(files[0]) : title;
                        d.SetStorageItems(items);
                        if (items.Count == 1) d.SetBitmap(RandomAccessStreamReference.CreateFromFile((StorageFile)items[0]));
                    };
                    // Shared: a moment for the app it went to, then the window goes.
                    dtm.TargetApplicationChosen += delegate { quit.Interval = 30000; quit.Stop(); quit.Start(); };
                    SetForegroundWindow(f.Handle);
                    interop.ShowShareUIForWindow(f.Handle);
                    quit.Start();
                }
                catch (Exception e)
                {
                    Console.Error.WriteLine("share: " + e.Message);
                    f.Close();
                }
            };
            f.FormClosed += delegate
            {
                quit.Stop();
                lock (gate) { if (current == f) current = null; }
                Application.ExitThread();
            };
            Application.Run(f);
        }
    }
}

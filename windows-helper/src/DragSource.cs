// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Drag across the edge: files and folders dragged from the Mac become
// a real Windows drag at the pointer — OLE DoDragDrop with *virtual files* (FileGroupDescriptorW +
// FileContents streams), so any drop target works (Explorer, Desktop, mail, browsers) and Explorer
// copies in the background (IDataObjectAsyncCapability). The bytes are still arriving while the
// person drags: a stream read waits for them (the files land in a temp folder, written by main).
// Runs on its own STA thread so a waiting read never blocks the input hooks on the main thread.
// The paste shortcut uses the same data object, dropped straight onto the folder's
// drop target (no mouse): Windows copies it with its own progress dialog and replace/skip prompts.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using FORMATETC = System.Runtime.InteropServices.ComTypes.FORMATETC;
using STGMEDIUM = System.Runtime.InteropServices.ComTypes.STGMEDIUM;
using STATSTG = System.Runtime.InteropServices.ComTypes.STATSTG;
using ComIDataObject = System.Runtime.InteropServices.ComTypes.IDataObject;

namespace MacShare
{
    // One entry of the drag: a folder, or a file with its temp path and final size.
    class DragEntry
    {
        public string Rel;   // relative path with '\'
        public bool Dir;
        public long Size;
        public string Temp;  // where main writes the bytes
        public volatile int State; // 0 arriving, 1 complete and verified, -1 failed
    }

    class DragSession
    {
        public string Id;
        public List<DragEntry> Entries;
        public string DropDir; // set: drop onto this folder at once instead of dragging (paste)
        public volatile bool DropRequested, CancelRequested;
        public Action<Dictionary<string, object>> Emit;
        volatile bool finished;
        DateTime started;
        // A drag of ours is starting or on (DropEdge.cs: no strip meanwhile. It came in with the driver's pointer,
        // at the edge where the way-back strip goes: on top, the strip took the press that starts the drag here,
        // and after 1.5 s it 'failed'. Its way back is kvm.js's drag.back, not the strip).
        static int running;
        public static bool Running { get { return System.Threading.Thread.VolatileRead(ref running) > 0; } }
        // Where the press that starts a drag here can land: the pointer, moved into the screen's work area when
        // it came in over the taskbar or at the very edge (it does, from the device below or beside): there the
        // taskbar, top-most too, took the press and the drag 'failed' (AMXLPDL, its taskbar at the bottom).
        public static Point Clear()
        {
            Point cur = Cursor.Position;
            Rectangle wa = Screen.FromPoint(cur).WorkingArea;
            wa.Inflate(-24, -24);
            Point inside = new Point(Math.Max(wa.Left, Math.Min(wa.Right - 1, cur.X)), Math.Max(wa.Top, Math.Min(wa.Bottom - 1, cur.Y)));
            if (inside == cur) return cur;
            Cursor.Position = inside;
            Console.Error.WriteLine("[drag] the pointer came in at " + cur.X + "," + cur.Y + ", over the taskbar or the edge: the drag starts at " + inside.X + "," + inside.Y);
            return inside;
        }

        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Native.POINT p);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);

        // The window the press that starts a drag goes to covers the whole work area of the pointer's screen,
        // nearly invisible, for that instant (it goes out of the way at its mouse-down): a 32 px one under the
        // pointer missed it, the pointer moving on with the driver's hand, or another top-most window there.
        public static void Cover(Form f)
        {
            Point cur = Clear();
            f.Bounds = Screen.FromPoint(cur).WorkingArea;
        }

        // On top again (a popup shown since is top-most too), then the press.
        public static void Press(Form f)
        {
            SetWindowPos(f.Handle, new IntPtr(-1) /* HWND_TOPMOST */, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 /* NOSIZE, NOMOVE, NOACTIVATE */);
            Native2.Button(true);
        }

        // What Windows has under the pointer (the log, when the press didn't arrive).
        public static string Under()
        {
            Point p = Cursor.Position;
            IntPtr w = GetAncestor(WindowFromPoint(new Native.POINT(p.X, p.Y)), 2); // GA_ROOT
            StringBuilder cls = new StringBuilder(128);
            GetClassName(w, cls, cls.Capacity);
            uint pid;
            GetWindowThreadProcessId(w, out pid);
            string proc = "?";
            try { proc = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { /* gone, or not ours to open */ }
            return cls + " of " + proc + " (" + pid + ") at " + p.X + "," + p.Y;
        }

        public static void Begin() { System.Threading.Interlocked.Increment(ref running); }
        public static void End() { System.Threading.Interlocked.Decrement(ref running); } // LocalDrag's too

        // ---- running the drag (own STA thread) ----

        public void Start(List<string> names)
        {
            Thread t = new Thread(delegate () { Run(names); });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Start();
        }

        // Windows only lets the foreground window capture the mouse, so the drag starts like a real
        // one: a tiny, almost invisible window under the pointer gets an (injected, marked) left-button
        // press, and DoDragDrop runs from its mouse-down.
        void Run(List<string> names)
        {
            Begin();
            try { RunDrag(names); }
            finally { End(); }
        }

        void RunDrag(List<string> names)
        {
            Native2.OleInitialize(IntPtr.Zero);
            if (DropDir != null) { DropInto(); return; }
            Form f = new Form();
            f.FormBorderStyle = FormBorderStyle.None;
            f.ShowInTaskbar = false;
            f.TopMost = true;
            f.StartPosition = FormStartPosition.Manual;
            f.Opacity = 0.02; // layered with alpha > 0: still gets the click
            DragSession.Cover(f);
            bool began = false;
            f.MouseDown += delegate (object o, MouseEventArgs e)
            {
                if (began || e.Button != MouseButtons.Left) return;
                began = true;
                f.Bounds = new Rectangle(-32000, -32000, 1, 1); // out of the way of the drop targets
                Drag(names);
                f.Close();
            };
            f.Shown += delegate
            {
                DragSession.Press(f);
                System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
                t.Interval = 1500;
                t.Tick += delegate { t.Stop(); if (!began) { began = true; Native2.Button(false); Console.Error.WriteLine("[drag] the press that starts the drag here didn't reach it in 1.5 s: under the pointer is " + DragSession.Under()); Event("dragState", "result", "failed", 0); finished = true; f.Close(); } };
                t.Start();
            };
            Application.Run(f);
        }

        void Drag(List<string> names)
        {
            VirtualFiles data = new VirtualFiles(this);
            DropSource source = new DropSource(this);
            DragImage.Attach(data, Entries, names);
            started = DateTime.UtcNow;
            int effect;
            int hr = Native2.DoDragDrop(data, source, 1 /* DROPEFFECT_COPY */, out effect);
            bool dropped = hr == 0x00040100 /* DRAGDROP_S_DROP */;
            Event("dragState", "result", dropped ? "dropped" : "cancelled", effect);
            if (!dropped) { finished = true; Event("dragDone", "ok", false, 0); return; }
            if (!data.AsyncStarted) { finished = true; Event("dragDone", "ok", effect != 0, effect); }
            // Async (Explorer): keep pumping COM calls until the target ends the operation.
            DateTime until = DateTime.UtcNow.AddHours(2);
            while (!finished && DateTime.UtcNow < until && !CancelRequested)
            {
                Application.DoEvents();
                Thread.Sleep(5);
            }
            if (!finished) { finished = true; Event("dragDone", "ok", false, 0); }
        }

        // Paste: the folder's drop target (its parent's GetUIObjectOf, owned by the window in front,
        // so Windows shows its copy dialog over it) → DragEnter + Drop with copy, as a drop there.
        void DropInto()
        {
            VirtualFiles data = new VirtualFiles(this);
            int effect = 1; // DROPEFFECT_COPY
            IntPtr pidl = IntPtr.Zero;
            try
            {
                uint attrs;
                int hr = Native2.SHParseDisplayName(DropDir, IntPtr.Zero, out pidl, 0, out attrs);
                if (hr != 0) throw new COMException("folder", hr);
                Guid sfIid = new Guid("000214E6-0000-0000-C000-000000000046"); // IShellFolder
                IShellFolderDrop parent;
                IntPtr child;
                hr = Native2.SHBindToParent(pidl, ref sfIid, out parent, out child);
                if (hr != 0 || parent == null) throw new COMException("parent", hr);
                Guid dtIid = new Guid("00000122-0000-0000-C000-000000000046"); // IDropTarget
                IntPtr unk;
                hr = parent.GetUIObjectOf(Native2.GetForegroundWindow(), 1, new IntPtr[] { child }, ref dtIid, IntPtr.Zero, out unk);
                if (hr != 0 || unk == IntPtr.Zero) throw new COMException("drop target", hr);
                IDropTarget target = (IDropTarget)Marshal.GetObjectForIUnknown(unk);
                Marshal.Release(unk);
                Point cur = Cursor.Position;
                long pt = ((long)cur.Y << 32) | (uint)cur.X;
                target.DragEnter(data, 0, pt, ref effect);
                if (effect == 0) { target.DragLeave(); throw new COMException("refused", -1); }
                effect = 1;
                target.Drop(data, 0, pt, ref effect);
            }
            catch (Exception ex)
            {
                if (pidl != IntPtr.Zero) { Native2.CoTaskMemFree(pidl); pidl = IntPtr.Zero; }
                Console.Error.WriteLine("pasteDrop: " + ex.Message);
                Event("dragState", "result", "failed", 0);
                finished = true;
                Event("dragDone", "ok", false, 0);
                return;
            }
            if (pidl != IntPtr.Zero) Native2.CoTaskMemFree(pidl);
            Event("dragState", "result", "dropped", effect);
            if (!data.AsyncStarted) { finished = true; Event("dragDone", "ok", effect != 0, effect); return; }
            DateTime until = DateTime.UtcNow.AddHours(2);
            while (!finished && DateTime.UtcNow < until && !CancelRequested)
            {
                Application.DoEvents();
                Thread.Sleep(5);
            }
            if (!finished) { finished = true; Event("dragDone", "ok", false, 0); }
        }

        public void Ended(bool ok, int effect)
        {
            if (finished) return;
            finished = true;
            Event("dragDone", "ok", ok, effect);
        }

        void Event(string name, string key, object value, int effect)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["event"] = name;
            d["drag"] = Id;
            d[key] = value;
            d["effect"] = effect;
            Emit(d);
        }

        // IDropSource.QueryContinueDrag: our own rules, since the button is the Mac's.
        public int Continue(bool escape, int keys)
        {
            const int S_OK = 0, DROP = 0x00040100, CANCEL = 0x00040101, MK_LBUTTON = 1;
            if (escape || CancelRequested) { if ((keys & MK_LBUTTON) != 0) Native2.Button(false); return CANCEL; }
            // Drop when the Mac's button comes up here (injected k.mu) or main says so (dragDrop).
            if ((keys & MK_LBUTTON) == 0) return DROP;
            if (DropRequested) { Native2.Button(false); return DROP; }
            return S_OK;
        }
    }

    // A drag of this PC's own files (dragLocal): one of ours that went to the Mac came back home with
    // the button still held. Started like DragSession's (a click into a tiny window under the
    // pointer), with the paths as Explorer's own drag has them; our real button-up drops it.
    static class LocalDrag
    {
        public static void Start(List<string> paths, string id, Action<Dictionary<string, object>> emit)
        {
            List<string> have = paths.FindAll(delegate (string p) { return File.Exists(p) || Directory.Exists(p); });
            if (have.Count == 0) { Done(emit, id, "failed"); return; }
            Thread t = new Thread(delegate () { DragSession.Begin(); try { Run(have, id, emit); } finally { DragSession.End(); } });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Start();
        }

        static void Done(Action<Dictionary<string, object>> emit, string id, string result)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["event"] = "dragState";
            d["drag"] = id;
            d["result"] = result;
            emit(d);
        }

        static void Run(List<string> paths, string id, Action<Dictionary<string, object>> emit)
        {
            Native2.OleInitialize(IntPtr.Zero);
            Form f = new Form();
            f.FormBorderStyle = FormBorderStyle.None;
            f.ShowInTaskbar = false;
            f.TopMost = true;
            f.StartPosition = FormStartPosition.Manual;
            f.Opacity = 0.02; // layered with alpha > 0: still gets the click
            DragSession.Cover(f);
            bool began = false;
            f.MouseDown += delegate (object o, MouseEventArgs e)
            {
                if (began || e.Button != MouseButtons.Left) return;
                began = true;
                f.Bounds = new Rectangle(-32000, -32000, 1, 1); // out of the way of the drop targets
                DataObject data = new DataObject(DataFormats.FileDrop, paths.ToArray());
                DragDropEffects eff = f.DoDragDrop(data, DragDropEffects.Copy | DragDropEffects.Move | DragDropEffects.Link);
                Done(emit, id, eff == DragDropEffects.None ? "cancelled" : "dropped");
                f.Close();
            };
            f.Shown += delegate
            {
                DragSession.Press(f);
                System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
                t.Interval = 1500;
                t.Tick += delegate { t.Stop(); if (!began) { began = true; Native2.Button(false); Console.Error.WriteLine("[drag] the press that starts our drag here didn't reach it in 1.5 s: under the pointer is " + DragSession.Under()); Done(emit, id, "failed"); f.Close(); } };
                t.Start();
            };
            Application.Run(f);
        }
    }

    [ComImport, Guid("00000121-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDropSource
    {
        [PreserveSig] int QueryContinueDrag([MarshalAs(UnmanagedType.Bool)] bool escape, int keys);
        [PreserveSig] int GiveFeedback(int effect);
    }

    class DropSource : IDropSource
    {
        readonly DragSession s;
        public DropSource(DragSession s) { this.s = s; }
        public int QueryContinueDrag(bool escape, int keys) { return s.Continue(escape, keys); }
        public int GiveFeedback(int effect) { return 0x00040102; /* DRAGDROP_S_USEDEFAULTCURSORS */ }
    }

    [ComImport, Guid("00000122-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDropTarget
    {
        // POINTL by value: 8 bytes, passed as one 64-bit value (x low, y high).
        void DragEnter([MarshalAs(UnmanagedType.Interface)] ComIDataObject data, int keys, long pt, ref int effect);
        void DragOver(int keys, long pt, ref int effect);
        void DragLeave();
        void Drop([MarshalAs(UnmanagedType.Interface)] ComIDataObject data, int keys, long pt, ref int effect);
    }

    // IShellFolder, only as far as GetUIObjectOf (the earlier slots keep the vtable order).
    [ComImport, Guid("000214E6-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellFolderDrop
    {
        [PreserveSig] int ParseDisplayName(IntPtr hwnd, IntPtr bc, IntPtr name, IntPtr eaten, IntPtr pidl, IntPtr attrs);
        [PreserveSig] int EnumObjects(IntPtr hwnd, int flags, IntPtr list);
        [PreserveSig] int BindToObject(IntPtr pidl, IntPtr bc, ref Guid riid, IntPtr ppv);
        [PreserveSig] int BindToStorage(IntPtr pidl, IntPtr bc, ref Guid riid, IntPtr ppv);
        [PreserveSig] int CompareIDs(IntPtr lParam, IntPtr pidl1, IntPtr pidl2);
        [PreserveSig] int CreateViewObject(IntPtr hwnd, ref Guid riid, IntPtr ppv);
        [PreserveSig] int GetAttributesOf(uint cidl, IntPtr apidl, IntPtr attrs);
        [PreserveSig] int GetUIObjectOf(IntPtr hwnd, uint cidl, [MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl, ref Guid riid, IntPtr reserved, out IntPtr ppv);
    }

    [ComImport, Guid("3D8B0590-F691-11d2-8EA9-006097DF5BD4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDataObjectAsyncCapability
    {
        [PreserveSig] int SetAsyncMode([MarshalAs(UnmanagedType.Bool)] bool doOpAsync);
        [PreserveSig] int GetAsyncMode([MarshalAs(UnmanagedType.Bool)] out bool isOpAsync);
        [PreserveSig] int StartOperation(IntPtr bindCtx);
        [PreserveSig] int InOperation([MarshalAs(UnmanagedType.Bool)] out bool inAsyncOp);
        [PreserveSig] int EndOperation(int hResult, IntPtr bindCtx, int effects);
    }

    // The data object: virtual files + whatever the shell stores on it (drag image, drop description).
    class VirtualFiles : ComIDataObject, IDataObjectAsyncCapability
    {
        static readonly short CF_DESCRIPTOR = (short)Native2.RegisterClipboardFormat("FileGroupDescriptorW");
        static readonly short CF_CONTENTS = (short)Native2.RegisterClipboardFormat("FileContents");
        static readonly short CF_EFFECT = (short)Native2.RegisterClipboardFormat("Preferred DropEffect");
        const int DV_E_FORMATETC = unchecked((int)0x80040064), E_NOTIMPL = unchecked((int)0x80004001), OLE_E_ADVISENOTSUPPORTED = unchecked((int)0x80040003);

        readonly DragSession s;
        readonly Dictionary<short, IntPtr> stored = new Dictionary<short, IntPtr>(); // HGLOBALs the shell set
        bool asyncMode = true, inOp;
        public bool AsyncStarted;

        public VirtualFiles(DragSession s) { this.s = s; }

        public void GetData(ref FORMATETC f, out STGMEDIUM m)
        {
            m = new STGMEDIUM();
            if (f.cfFormat == CF_DESCRIPTOR && (f.tymed & TYMED.TYMED_HGLOBAL) != 0)
            {
                m.tymed = TYMED.TYMED_HGLOBAL;
                m.unionmember = Descriptor();
            }
            else if (f.cfFormat == CF_CONTENTS && (f.tymed & TYMED.TYMED_ISTREAM) != 0 && f.lindex >= 0 && f.lindex < s.Entries.Count && !s.Entries[f.lindex].Dir)
            {
                m.tymed = TYMED.TYMED_ISTREAM;
                m.unionmember = Marshal.GetComInterfaceForObject(new WaitingStream(s.Entries[f.lindex], s), typeof(IStream));
            }
            else if (f.cfFormat == CF_EFFECT && (f.tymed & TYMED.TYMED_HGLOBAL) != 0)
            {
                m.tymed = TYMED.TYMED_HGLOBAL;
                m.unionmember = Native2.Global(BitConverter.GetBytes(1)); // copy
            }
            else if (stored.ContainsKey(f.cfFormat) && (f.tymed & TYMED.TYMED_HGLOBAL) != 0)
            {
                m.tymed = TYMED.TYMED_HGLOBAL;
                m.unionmember = Native2.CopyGlobal(stored[f.cfFormat]);
            }
            else throw new COMException("format", DV_E_FORMATETC);
        }

        public void GetDataHere(ref FORMATETC f, ref STGMEDIUM m) { throw new COMException("here", E_NOTIMPL); }

        public int QueryGetData(ref FORMATETC f)
        {
            if (f.cfFormat == CF_DESCRIPTOR || f.cfFormat == CF_EFFECT || stored.ContainsKey(f.cfFormat)) return (f.tymed & TYMED.TYMED_HGLOBAL) != 0 ? 0 : DV_E_FORMATETC;
            if (f.cfFormat == CF_CONTENTS) return (f.tymed & TYMED.TYMED_ISTREAM) != 0 ? 0 : DV_E_FORMATETC;
            return DV_E_FORMATETC;
        }

        public int GetCanonicalFormatEtc(ref FORMATETC i, out FORMATETC o) { o = i; o.ptd = IntPtr.Zero; return 0x00040130; /* DATA_S_SAMEFORMATETC */ }

        public void SetData(ref FORMATETC f, ref STGMEDIUM m, bool release)
        {
            if (m.tymed != TYMED.TYMED_HGLOBAL) throw new COMException("tymed", E_NOTIMPL);
            IntPtr copy = release ? m.unionmember : Native2.CopyGlobal(m.unionmember);
            IntPtr old;
            if (stored.TryGetValue(f.cfFormat, out old)) Native2.GlobalFree(old);
            stored[f.cfFormat] = copy;
        }

        public IEnumFORMATETC EnumFormatEtc(DATADIR dir)
        {
            if (dir != DATADIR.DATADIR_GET) throw new COMException("dir", E_NOTIMPL);
            List<FORMATETC> list = new List<FORMATETC>();
            list.Add(Fmt(CF_DESCRIPTOR, TYMED.TYMED_HGLOBAL, -1));
            list.Add(Fmt(CF_CONTENTS, TYMED.TYMED_ISTREAM, -1));
            list.Add(Fmt(CF_EFFECT, TYMED.TYMED_HGLOBAL, -1));
            foreach (short k in stored.Keys) list.Add(Fmt(k, TYMED.TYMED_HGLOBAL, -1));
            return new FormatEnum(list.ToArray(), 0);
        }

        static FORMATETC Fmt(short cf, TYMED t, int lindex)
        {
            FORMATETC f = new FORMATETC();
            f.cfFormat = cf; f.dwAspect = DVASPECT.DVASPECT_CONTENT; f.lindex = lindex; f.tymed = t;
            return f;
        }

        public int DAdvise(ref FORMATETC f, ADVF a, IAdviseSink sink, out int c) { c = 0; return OLE_E_ADVISENOTSUPPORTED; }
        public void DUnadvise(int c) { throw new COMException("advise", OLE_E_ADVISENOTSUPPORTED); }
        public int EnumDAdvise(out IEnumSTATDATA e) { e = null; return OLE_E_ADVISENOTSUPPORTED; }

        // FILEGROUPDESCRIPTORW: count + one 592-byte FILEDESCRIPTORW per entry (folders first).
        IntPtr Descriptor()
        {
            MemoryStream ms = new MemoryStream();
            BinaryWriter w = new BinaryWriter(ms);
            w.Write(s.Entries.Count);
            long now = DateTime.Now.ToFileTime();
            foreach (DragEntry e in s.Entries)
            {
                // FD_ATTRIBUTES | FD_FILESIZE | FD_WRITESTIME | FD_PROGRESSUI | FD_UNICODE
                w.Write(unchecked((int)(0x04 | 0x40 | 0x20 | 0x4000 | 0x80000000)));
                w.Write(new byte[16 + 8 + 8]); // clsid, sizel, pointl
                w.Write(e.Dir ? 0x10 : 0x80); // FILE_ATTRIBUTE_DIRECTORY / NORMAL
                w.Write(now); w.Write(now); w.Write(now); // creation, access, write
                w.Write((int)(e.Size >> 32)); w.Write((int)(e.Size & 0xFFFFFFFF));
                byte[] name = new byte[520];
                byte[] b = Encoding.Unicode.GetBytes(e.Rel);
                Array.Copy(b, name, Math.Min(b.Length, 518));
                w.Write(name);
            }
            w.Flush();
            return Native2.Global(ms.ToArray());
        }

        // ---- async capability (Explorer copies on its own thread, with its progress dialog) ----
        public int SetAsyncMode(bool a) { asyncMode = a; return 0; }
        public int GetAsyncMode(out bool a) { a = asyncMode; return 0; }
        public int StartOperation(IntPtr bc) { inOp = true; AsyncStarted = true; return 0; }
        public int InOperation(out bool a) { a = inOp; return 0; }
        public int EndOperation(int hr, IntPtr bc, int effects) { inOp = false; s.Ended(hr >= 0 && effects != 0, effects); return 0; }
    }

    class FormatEnum : IEnumFORMATETC
    {
        readonly FORMATETC[] items;
        int pos;
        public FormatEnum(FORMATETC[] items, int pos) { this.items = items; this.pos = pos; }
        public int Next(int celt, FORMATETC[] rgelt, int[] fetched)
        {
            int n = 0;
            while (n < celt && pos < items.Length) rgelt[n++] = items[pos++];
            if (fetched != null && fetched.Length > 0) fetched[0] = n;
            return n == celt ? 0 : 1;
        }
        public int Skip(int celt) { pos += celt; return pos <= items.Length ? 0 : 1; }
        public int Reset() { pos = 0; return 0; }
        public void Clone(out IEnumFORMATETC e) { e = new FormatEnum(items, pos); }
    }

    // A read-only stream over a temp file that is still being written: waits for missing bytes;
    // the last byte only after main verified the file (sha256); fails if the transfer failed.
    class WaitingStream : IStream
    {
        readonly DragEntry e;
        readonly DragSession s;
        long pos;
        FileStream fs;
        const int E_FAIL = unchecked((int)0x80004005), E_NOTIMPL = unchecked((int)0x80004001);

        public WaitingStream(DragEntry e, DragSession s) { this.e = e; this.s = s; }

        public void Read(byte[] pv, int cb, IntPtr pcbRead)
        {
            int n = 0;
            DateTime idle = DateTime.UtcNow;
            while (cb > 0 && pos < e.Size)
            {
                if (e.State < 0 || s.CancelRequested) throw new COMException("transfer failed", E_FAIL);
                long have = 0;
                try { have = new FileInfo(e.Temp).Length; } catch (Exception) { }
                if (e.State == 0) have = Math.Min(have, e.Size - 1); // the end waits for the check
                if (have > pos)
                {
                    if (fs == null) fs = new FileStream(e.Temp, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    fs.Position = pos;
                    int r = fs.Read(pv, 0, (int)Math.Min(cb, have - pos));
                    pos += r; n = r;
                    break;
                }
                if ((DateTime.UtcNow - idle).TotalSeconds > 120) throw new COMException("no data", E_FAIL);
                Thread.Sleep(15);
            }
            if (pos >= e.Size && fs != null) { fs.Dispose(); fs = null; }
            if (pcbRead != IntPtr.Zero) Marshal.WriteInt32(pcbRead, n);
        }

        public void Write(byte[] pv, int cb, IntPtr pcbWritten) { throw new COMException("ro", E_NOTIMPL); }

        public void Seek(long move, int origin, IntPtr newPos)
        {
            long p = origin == 0 ? move : origin == 1 ? pos + move : e.Size + move;
            pos = Math.Max(0, Math.Min(p, e.Size));
            if (newPos != IntPtr.Zero) Marshal.WriteInt64(newPos, pos);
        }

        public void Stat(out STATSTG st, int flag)
        {
            st = new STATSTG();
            st.type = 2; // STGTY_STREAM
            st.cbSize = e.Size;
            if ((flag & 1) == 0) st.pwcsName = Path.GetFileName(e.Rel); // STATFLAG_NONAME not set
        }

        public void SetSize(long size) { throw new COMException("ro", E_NOTIMPL); }
        public void CopyTo(IStream to, long cb, IntPtr read, IntPtr written) { throw new COMException("copy", E_NOTIMPL); }
        public void Commit(int flags) { }
        public void Revert() { }
        public void LockRegion(long o, long cb, int t) { throw new COMException("lock", E_NOTIMPL); }
        public void UnlockRegion(long o, long cb, int t) { throw new COMException("lock", E_NOTIMPL); }
        public void Clone(out IStream ppstm) { throw new COMException("clone", E_NOTIMPL); }
    }

    static class Native2
    {
        [DllImport("ole32.dll")] public static extern int OleInitialize(IntPtr reserved);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern int SHParseDisplayName(string name, IntPtr bc, out IntPtr pidl, uint sfgaoIn, out uint sfgaoOut);
        [DllImport("shell32.dll")] public static extern int SHBindToParent(IntPtr pidl, ref Guid riid, out IShellFolderDrop folder, out IntPtr last);
        [DllImport("ole32.dll")] public static extern void CoTaskMemFree(IntPtr p);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("ole32.dll")] public static extern int DoDragDrop(ComIDataObject data, IDropSource source, int okEffects, out int effect);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern uint RegisterClipboardFormat(string name);
        [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
        [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
        [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
        [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr h);
        [DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr h);
        [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);

        public static IntPtr Global(byte[] data)
        {
            IntPtr h = GlobalAlloc(0x0042 /* GHND */, new UIntPtr((uint)Math.Max(1, data.Length)));
            IntPtr p = GlobalLock(h);
            Marshal.Copy(data, 0, p, data.Length);
            GlobalUnlock(h);
            return h;
        }

        public static IntPtr CopyGlobal(IntPtr src)
        {
            int n = (int)GlobalSize(src).ToUInt32();
            byte[] b = new byte[n];
            IntPtr p = GlobalLock(src);
            Marshal.Copy(p, b, 0, n);
            GlobalUnlock(src);
            return Global(b);
        }

        public static void Nudge()
        {
            mouse_event(0x0001 /* MOVE */, 0, 0, 0, Native.MARK);
        }

        // Left button, marked as ours (the capture hooks skip it).
        public static void Button(bool down)
        {
            mouse_event(down ? 0x0002u : 0x0004u, 0, 0, 0, Native.MARK);
        }
    }
}

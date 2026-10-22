// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Drag files across the edge, PC → Mac: while the left button is
// held at home, an invisible top-most strip covers the outer edge facing the Mac. A file drag that
// enters it is accepted as a copy and ended right there (a marked left-up on the strip; dropping
// does nothing), so Explorer's drag simply ends at the edge: no slide-back, no Esc to whatever app
// is in front. Capture starts first, so the real button-up later goes to the Mac, and main gets
// `edge {offset, drag:{paths}}` while the Mac's own drag carries on.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace MacShare
{
    class DropEdge : Form
    {
        readonly Capture capture;
        readonly Action<Dictionary<string, object>> emit;
        readonly Timer timer = new Timer();
        const int STRIP = 3; // px
        bool taken; // a drag entered and is being handed to the Mac
        string[] pending; // its paths, until Explorer's drop on the strip
        Point pendingAt;

        // Never Move: the source would delete the files after a "move" drop.
        static DragDropEffects Copy(DragEventArgs e)
        {
            return (e.AllowedEffect & DragDropEffects.Copy) != 0 ? DragDropEffects.Copy
                : (e.AllowedEffect & DragDropEffects.Link) != 0 ? DragDropEffects.Link : DragDropEffects.None;
        }

        public DropEdge(Capture capture, Action<Dictionary<string, object>> emit)
        {
            this.capture = capture;
            this.emit = emit;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.Black;
            Opacity = 0.01; // layered and practically invisible, but still a drop target
            AllowDrop = true;
            Size = new Size(1, 1);
            DragEnter += OnDragEnter;
            DragOver += delegate (object o, DragEventArgs e) { e.Effect = taken ? Copy(e) : DragDropEffects.None; };
            DragDrop += delegate { OnDrop(); }; // the files go to the Mac; nothing is copied here
            timer.Interval = 50;
            timer.Tick += delegate { Follow(); };
            timer.Start();
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x80 | 0x08000000 | 0x8; // TOOLWINDOW | NOACTIVATE | TOPMOST
                return cp;
            }
        }

        string activeDropSide;

        // Shown only while the left button is held at home with edge crossing on, along the outer
        // edge of the monitor under the pointer.
        void Follow()
        {
            string side = capture.Side;
            bool held = (Native.GetAsyncKeyState(0x01) & 0x8000) != 0;
            if (taken) return; // stays while Explorer's drag ends on it
            if (!held || side == null || !capture.DriveOther || !capture.DragFiles || capture.Capturing) { if (Visible) Hide(); return; }
            Native.POINT p;
            Native.GetCursorPos(out p);
            Rectangle m = Screen.FromPoint(new Point(p.x, p.y)).Bounds;
            string matchSide = null;
            string[] sides = side.Split(new char[] { ',', ';', ' ', '|' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string s in sides)
            {
                Point probe = s == "left" ? new Point(m.Left, p.y) : s == "right" ? new Point(m.Right - 1, p.y)
                    : s == "top" ? new Point(p.x, m.Top) : new Point(p.x, m.Bottom - 1);
                if (Screens.OnOuterEdge(probe.X, probe.Y, s)) { matchSide = s; break; }
            }
            if (matchSide == null) { if (Visible) Hide(); return; }
            activeDropSide = matchSide;
            Rectangle r = matchSide == "left" ? new Rectangle(m.Left, m.Top, STRIP, m.Height)
                : matchSide == "right" ? new Rectangle(m.Right - STRIP, m.Top, STRIP, m.Height)
                : matchSide == "top" ? new Rectangle(m.Left, m.Top, m.Width, STRIP)
                : new Rectangle(m.Left, m.Bottom - STRIP, m.Width, STRIP);
            if (Bounds != r) Bounds = r;
            if (!Visible) Show();
        }

        void OnDragEnter(object sender, DragEventArgs e)
        {
            e.Effect = DragDropEffects.None;
            if (!e.Data.GetDataPresent(DataFormats.FileDrop) || capture.Capturing) return;
            string[] paths = e.Data.GetData(DataFormats.FileDrop) as string[];
            if (paths == null || paths.Length == 0) return;
            e.Effect = Copy(e);
            if (e.Effect == DragDropEffects.None) return;
            taken = true;
            pending = paths;
            Native.POINT p;
            Native.GetCursorPos(out p);
            pendingAt = new Point(p.x, p.y);
            // Leave the drag loop's callback, then a marked left-up while the pointer is still on
            // the strip: Explorer's drag ends with a (copy) drop here, which does nothing.
            BeginInvoke((MethodInvoker)delegate { Native2.Button(false); });
            System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
            t.Interval = 600;
            t.Tick += delegate { t.Stop(); t.Dispose(); if (taken) { taken = false; pending = null; Hide(); } }; // no drop came
            t.Start();
        }

        // Explorer's drag ended on the strip: now cross. Capture starts (the user's real button-up
        // is swallowed from here and goes to the Mac) and main gets the paths.
        void OnDrop()
        {
            string[] paths = pending;
            pending = null;
            taken = false;
            Hide();
            if (paths == null || capture.Capturing) return;
            BeginInvoke((MethodInvoker)delegate
            {
                string s = activeDropSide ?? capture.Side;
                if (s != null && s.Contains(",")) s = s.Split(',')[0].Trim();
                double offset = Screens.Offset(pendingAt.X, pendingAt.Y, s);
                capture.Begin(true, capture.EdgeKeyboard);
                Dictionary<string, object> d = new Dictionary<string, object>();
                d["event"] = "edge";
                d["side"] = s;
                d["offset"] = Math.Round(offset, 4);
                Dictionary<string, object> drag = new Dictionary<string, object>();
                drag["paths"] = paths;
                d["drag"] = drag;
                emit(d);
            });
        }
    }
}

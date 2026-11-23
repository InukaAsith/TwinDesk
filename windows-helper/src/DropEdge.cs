// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Drag files across the edge, PC → Mac: while the left button is
// held at home, an invisible top-most strip covers the outer edge facing the Mac. A file drag that
// enters it is accepted as a copy and ended right there (a marked left-up on the strip; dropping
// does nothing), so Explorer's drag simply ends at the edge: no slide-back, no Esc to whatever app
// is in front. Capture starts first, so the real button-up later goes to the Mac, and main gets
// `edge {offset, drag:{paths}}` while the Mac's own drag carries on.
// While the Mac drives this PC the strip covers the way back instead, for the Mac's button held in
// an Explorer drag here: caught the same way, the input goes home with it (`return {offset,
// drag:{paths}}`, Capture.ReturnWithDrag) and the Mac carries the drag on.
// What it knows of the capture comes through IDragEdge: this helper's own (LocalEdge), or with Full
// KVM the service's, which can't have the strip (DragRelay.cs).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace MacShare
{
    // What the strip needs of a capture.
    interface IDragEdge
    {
        bool Capturing { get; }
        bool DragFiles { get; }
        List<string> HomeSides(); // the sides a drag crosses at home (none: edge crossing off)
        List<string> ReturnStops(); // the way back while driven (none: not driven)
        DateTime LastCross { get; }
        void Hold(bool on); // a drag caught on the way back: the return waits for its drop
        void Cross(Point at, string side, bool back, string[] paths); // Explorer's drag ended on the strip
    }

    // This helper's own capture: the drag crosses here.
    class LocalEdge : IDragEdge
    {
        readonly Capture capture;
        readonly Action<Dictionary<string, object>> emit;

        public LocalEdge(Capture capture, Action<Dictionary<string, object>> emit)
        {
            this.capture = capture;
            this.emit = emit;
        }

        public bool Capturing { get { return capture.Capturing; } }
        public bool DragFiles { get { return capture.DragFiles; } }
        public DateTime LastCross { get { return capture.LastCross; } }
        public List<string> ReturnStops() { return capture.ReturnStops(); }
        public void Hold(bool on) { capture.HoldReturn = on; }

        public List<string> HomeSides()
        {
            List<string> l = new List<string>();
            if (!capture.DriveOther) return l;
#if MULTI
            l.AddRange(capture.Sides); // every watched side, each to its device
#else
            if (capture.Side != null) l.Add(capture.Side);
#endif
            return l;
        }

        // Capture starts (the user's real button-up is swallowed from here and goes to the Mac) and
        // main gets the paths with the crossing; on the way back the input goes home with them.
        public void Cross(Point at, string side, bool back, string[] paths)
        {
            if (back) { capture.ReturnWithDrag(at, side, paths); return; }
            capture.HoldReturn = false;
            if (capture.Capturing) return;
            capture.Begin(true, capture.EdgeKeyboard);
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["event"] = "edge";
            d["offset"] = Math.Round(Screens.Offset(at.X, at.Y, side), 4);
            d["side"] = side;
            Dictionary<string, object> drag = new Dictionary<string, object>();
            drag["paths"] = paths;
            d["drag"] = drag;
            emit(d);
        }
    }

    class DropEdge : Form
    {
        readonly IDragEdge edge;
        readonly Timer timer = new Timer();
        const int STRIP = 3; // px
        bool taken; // a drag entered and is being handed to the Mac
        string[] pending; // its paths, until Explorer's drop on the strip
        Point pendingAt;
        string stripSide; // the side the strip covers now
        bool stripBack;   // …as the way back, while driven
        bool pendingBack; // the drag was caught on the way back
        DateTime seenCross; // the last crossing seen; after one the pointer is at the edge…
        bool away = true;   // …and the strip waits until it has moved off it (a drag that came home starts there)

        // Never Move: the source would delete the files after a "move" drop.
        static DragDropEffects Copy(DragEventArgs e)
        {
            return (e.AllowedEffect & DragDropEffects.Copy) != 0 ? DragDropEffects.Copy
                : (e.AllowedEffect & DragDropEffects.Link) != 0 ? DragDropEffects.Link : DragDropEffects.None;
        }

        public DropEdge(IDragEdge edge)
        {
            this.edge = edge;
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

        // Shown only while the left button is held with file drags across the edge on, along the
        // outer edge of the monitor under the pointer: at home the crossing edge (edge crossing on),
        // while driven the way back (the button is the Mac's then).
        void Follow()
        {
            List<string> back = edge.Capturing ? new List<string>() : edge.ReturnStops();
            bool held = (Native.GetAsyncKeyState(0x01) & 0x8000) != 0;
            if (taken) return; // stays while Explorer's drag ends on it
            List<string> sides = back.Count > 0 ? back : edge.HomeSides();
            if (!held || !edge.DragFiles || edge.Capturing || sides.Count == 0) { if (Visible) Hide(); return; }
            Native.POINT p;
            Native.GetCursorPos(out p);
            Rectangle m = Screen.FromPoint(new Point(p.x, p.y)).Bounds;
            string side = null;
            foreach (string s in sides)
            {
                Point probe = s == "left" ? new Point(m.Left, p.y) : s == "right" ? new Point(m.Right - 1, p.y)
                    : s == "top" ? new Point(p.x, m.Top) : new Point(p.x, m.Bottom - 1);
                if (Screens.OnOuterEdge(probe.X, probe.Y, s)) { side = s; break; }
            }
            if (side == null) { if (Visible) Hide(); return; }
            if (edge.LastCross != seenCross) { seenCross = edge.LastCross; away = false; }
            int dist = side == "left" ? p.x - m.Left : side == "right" ? m.Right - 1 - p.x : side == "top" ? p.y - m.Top : m.Bottom - 1 - p.y;
            if (dist > 16) away = true;
            if (!away) { if (Visible) Hide(); return; }
            stripSide = side;
            stripBack = back.Count > 0;
            Rectangle r = side == "left" ? new Rectangle(m.Left, m.Top, STRIP, m.Height)
                : side == "right" ? new Rectangle(m.Right - STRIP, m.Top, STRIP, m.Height)
                : side == "top" ? new Rectangle(m.Left, m.Top, m.Width, STRIP)
                : new Rectangle(m.Left, m.Bottom - STRIP, m.Width, STRIP);
            if (Bounds != r) Bounds = r;
            if (!Visible) Show();
        }

        void OnDragEnter(object sender, DragEventArgs e)
        {
            e.Effect = DragDropEffects.None;
            if (!e.Data.GetDataPresent(DataFormats.FileDrop) || edge.Capturing) return;
            string[] paths = e.Data.GetData(DataFormats.FileDrop) as string[];
            if (paths == null || paths.Length == 0) return;
            e.Effect = Copy(e);
            if (e.Effect == DragDropEffects.None) return;
            taken = true;
            pending = paths;
            pendingBack = stripBack;
            if (pendingBack) edge.Hold(true); // the input goes home with the drag, at the drop
            Native.POINT p;
            Native.GetCursorPos(out p);
            pendingAt = new Point(p.x, p.y);
            // Leave the drag loop's callback, then a marked left-up while the pointer is still on
            // the strip: Explorer's drag ends with a (copy) drop here, which does nothing.
            BeginInvoke((MethodInvoker)delegate { Native2.Button(false); });
            System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
            t.Interval = 600;
            t.Tick += delegate { t.Stop(); t.Dispose(); if (taken) { taken = false; pending = null; edge.Hold(false); Hide(); } }; // no drop came
            t.Start();
        }

        // Explorer's drag ended on the strip: now cross, through the side the strip covers.
        void OnDrop()
        {
            string[] paths = pending;
            pending = null;
            taken = false;
            Hide();
            if (paths == null || edge.Capturing) { edge.Hold(false); return; }
            Point at = pendingAt;
            string side = stripSide;
            bool back = pendingBack;
            BeginInvoke((MethodInvoker)delegate { edge.Cross(at, side, back, paths); });
        }
    }
}

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Monitors (physical pixels; the process is per-monitor DPI aware), outer edges, offsets along a
// side, landing points, clamping and the DPI scale under a point.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace MacShare
{
    static class Screens
    {
        public static Rectangle[] All()
        {
            Screen[] s = Screen.AllScreens;
            Rectangle[] r = new Rectangle[s.Length];
            for (int i = 0; i < s.Length; i++) r[i] = s[i].Bounds;
            return r;
        }

        public static Rectangle Box()
        {
            Rectangle b = Rectangle.Empty;
            foreach (Rectangle r in All()) b = b.IsEmpty ? r : Rectangle.Union(b, r);
            return b;
        }

        public static bool Contains(int x, int y)
        {
            foreach (Rectangle r in All()) if (r.Contains(x, y)) return true;
            return false;
        }

        static bool MonitorAt(int x, int y, out Rectangle mon)
        {
            foreach (Rectangle r in All()) if (r.Contains(x, y)) { mon = r; return true; }
            mon = Rectangle.Empty;
            return false;
        }

        // On the outer edge of `side` (within 1 px) with no other monitor continuing beyond it.
        public static bool OnOuterEdge(int x, int y, string side)
        {
            Rectangle m;
            if (!MonitorAt(x, y, out m)) return false;
            switch (side)
            {
                case "left": return x <= m.Left + 1 && !Contains(m.Left - 1, y);
                case "right": return x >= m.Right - 2 && !Contains(m.Right, y);
                case "top": return y <= m.Top + 1 && !Contains(x, m.Top - 1);
                case "bottom": return y >= m.Bottom - 2 && !Contains(x, m.Bottom);
            }
            return false;
        }

        // Within `px` of the edge of the monitor the point is on (whether or not another monitor continues beyond it).
        public static bool NearEdge(int x, int y, string side, int px)
        {
            Rectangle m;
            if (!MonitorAt(x, y, out m)) return false;
            switch (side)
            {
                case "left": return x <= m.Left + px;
                case "right": return x >= m.Right - 1 - px;
                case "top": return y <= m.Top + px;
                case "bottom": return y >= m.Bottom - 1 - px;
            }
            return false;
        }

        // "left,top,right,bottom;..." of every monitor, for the logs.
        public static string Describe()
        {
            List<string> l = new List<string>();
            foreach (Rectangle r in All()) l.Add(r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom);
            return string.Join(";", l.ToArray());
        }

        // Outward component of a motion for `side` (positive = pushing through it).
        public static double Outward(string side, double dx, double dy)
        {
            switch (side)
            {
                case "left": return -dx;
                case "right": return dx;
                case "top": return -dy;
                case "bottom": return dy;
            }
            return 0;
        }

        // 0–1 along the side, on the bounding box of all monitors.
        public static double Offset(int x, int y, string side)
        {
            Rectangle b = Box();
            double v = side == "left" || side == "right"
                ? (y - b.Top) / (double)Math.Max(1, b.Height - 1)
                : (x - b.Left) / (double)Math.Max(1, b.Width - 1);
            return Math.Min(1, Math.Max(0, v));
        }

        // A point 2 px inside the outer edge of `side` at `offset`.
        public static Point EdgePoint(string side, double offset)
        {
            Rectangle b = Box();
            bool vertical = side == "left" || side == "right";
            int along = vertical ? b.Top + (int)Math.Round(offset * (b.Height - 1)) : b.Left + (int)Math.Round(offset * (b.Width - 1));
            Rectangle best = Rectangle.Empty;
            int bestDist = int.MaxValue;
            foreach (Rectangle r in All())
            {
                int lo = vertical ? r.Top : r.Left, hi = (vertical ? r.Bottom : r.Right) - 1;
                int dist = along < lo ? lo - along : along > hi ? along - hi : 0;
                // Prefer the monitor whose span contains the point, then the outermost one.
                bool better = dist < bestDist || (dist == bestDist && !best.IsEmpty && Outer(r, side) > Outer(best, side));
                if (better) { best = r; bestDist = dist; }
            }
            if (best.IsEmpty) return new Point(0, 0);
            int a = Math.Min(Math.Max(along, vertical ? best.Top : best.Left), (vertical ? best.Bottom : best.Right) - 1);
            switch (side)
            {
                case "left": return new Point(best.Left + 2, a);
                case "right": return new Point(best.Right - 3, a);
                case "top": return new Point(a, best.Top + 2);
                default: return new Point(a, best.Bottom - 3);
            }
        }

        static int Outer(Rectangle r, string side)
        {
            switch (side)
            {
                case "left": return -r.Left;
                case "right": return r.Right;
                case "top": return -r.Top;
                default: return r.Bottom;
            }
        }

        public static Point Center()
        {
            Rectangle p = Screen.PrimaryScreen.Bounds;
            return new Point(p.Left + p.Width / 2, p.Top + p.Height / 2);
        }

        // Keep a target on the desktop: if it falls outside every monitor, clamp it to the monitor
        // the pointer is on now (avoids the dead zones between monitors of different sizes).
        public static Point Clamp(int x, int y, int fromX, int fromY)
        {
            if (Contains(x, y)) return new Point(x, y);
            Rectangle m;
            if (!MonitorAt(fromX, fromY, out m)) m = Screen.PrimaryScreen.Bounds;
            return new Point(Math.Min(Math.Max(x, m.Left), m.Right - 1), Math.Min(Math.Max(y, m.Top), m.Bottom - 1));
        }

        // Monitor DPI / 96 under a point.
        public static double Scale(int x, int y)
        {
            try
            {
                IntPtr mon = Native.MonitorFromPoint(new Native.POINT(x, y), Native.MONITOR_DEFAULTTONEAREST);
                uint dx, dy;
                if (Native.GetDpiForMonitor(mon, 0, out dx, out dy) == 0 && dx > 0) return dx / 96.0;
            }
            catch (Exception) { }
            return 1.0;
        }
    }
}

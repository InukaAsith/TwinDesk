// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Full KVM (docs/full-kvm.md): the mouse and keyboard are the service's helper's (the agent, as SYSTEM),
// and Windows doesn't let Explorer, which runs as the user, drop onto a window of SYSTEM's: its file-drag
// strip (DropEdge.cs) never saw a drag, and with a button held its capture doesn't cross (Rule 6), so a
// file couldn't be dragged past the edge. The strip is this helper's then (the user's own, which main
// keeps running beside the service): main tells it what the service's capture does (`dragStrip {on,
// sides, driveOther, dragFiles, back, capturing, cross}`, shared/fullkvm/route.js), and a drag caught on
// it goes to the service (`dragCross`, `dragHold` events, which main sends on as commands), whose capture
// crosses with it (LocalEdge there). With `on` false (no service) it is this helper's own capture again.
using System;
using System.Collections.Generic;
using System.Drawing;

namespace MacShare
{
    class DragRelay : IDragEdge
    {
        readonly IDragEdge local;
        readonly Action<Dictionary<string, object>> emit;
        bool on; // the service has the mouse and keyboard
        bool capturing, dragFiles = true;
        List<string> home = new List<string>(), back = new List<string>();
        double cross = -1; // main's count of the service's crossings: a new one is LastCross
        DateTime lastCross;

        public DragRelay(IDragEdge local, Action<Dictionary<string, object>> emit)
        {
            this.local = local;
            this.emit = emit;
        }

        // dragStrip: the service's capture, as main last told it.
        public void Update(Dictionary<string, object> c)
        {
            on = Json.Bool(c, "on", false);
            capturing = Json.Bool(c, "capturing", false);
            dragFiles = Json.Bool(c, "dragFiles", true);
            home = Json.Bool(c, "driveOther", false) ? (Json.Strs(c, "sides") ?? new List<string>()) : new List<string>();
            back = Json.Strs(c, "back") ?? new List<string>();
            double n = Json.Num(c, "cross", 0);
            if (n != cross) { cross = n; lastCross = DateTime.UtcNow; }
        }

        public bool Capturing { get { return on ? capturing : local.Capturing; } }
        public bool DragFiles { get { return on ? dragFiles : local.DragFiles; } }
        public DateTime LastCross { get { return on ? lastCross : local.LastCross; } }
        public List<string> HomeSides() { return on ? home : local.HomeSides(); }
        public List<string> ReturnStops() { return on ? back : local.ReturnStops(); }

        public void Hold(bool hold)
        {
            if (!on) { local.Hold(hold); return; }
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["event"] = "dragHold";
            d["on"] = hold;
            emit(d);
        }

        public void Cross(Point at, string side, bool toHome, string[] paths)
        {
            if (!on) { local.Cross(at, side, toHome, paths); return; }
            Console.Error.WriteLine("[drag] handed to the Full KVM service: its capture crosses with it");
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["event"] = "dragCross";
            d["x"] = at.X;
            d["y"] = at.Y;
            d["side"] = side;
            d["back"] = toHome;
            d["paths"] = paths;
            emit(d);
        }
    }
}

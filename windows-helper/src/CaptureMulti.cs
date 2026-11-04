// TwinDesk — Copyright (C) 2026 inukaasith, Erdoğan Yeşil. GPL-3.0, see LICENSE.
// Capture with several watched sides, for Multi-device (docs/multi-device.md, docs/mesh.md "Shared
// layout"): built into macshare-winhelper-multi.exe only (build.cmd, /define:MULTI), which the mesh app
// starts (windows/mesh/helper.js). Each side of this PC can lead to another device: the edge push is
// summed per side, and the edge and return events say which side. In macshare-winhelper.exe (no MULTI)
// this file is empty and Capture.cs keeps its one-side versions of these members.
#if MULTI
using System;
using System.Collections.Generic;
using System.Drawing;

namespace MacShare
{
    partial class Capture
    {
        // Sides of this PC whose outer edge is watched for a crossing (kvmConfig sides; each one leads
        // to another device). The first one is also Side: the file-drag strip (DropEdge) uses it.
        public readonly List<string> Sides = new List<string>();
        public string Side { get { return Sides.Count > 0 ? Sides[0] : null; } }

        // edge push (home) per watched side, and the return edge (driven)
        class EdgePush { public double Amount; public DateTime Last, Since; }
        readonly Dictionary<string, EdgePush> pushes = new Dictionary<string, EdgePush>();
        // The return watch (this PC is driven): every side that has a device behind it, the push per side.
        readonly List<string> retSides = new List<string>();
        readonly Dictionary<string, EdgePush> retPushes = new Dictionary<string, EdgePush>();
        bool retArmed; double retResistance;

        // Watches these sides (valid names only, no repeats). Empty: no edge crossing.
        public void SetSides(IEnumerable<string> list)
        {
            Sides.Clear();
            foreach (string s in list)
                if ((s == "left" || s == "right" || s == "top" || s == "bottom") && !Sides.Contains(s)) Sides.Add(s);
        }

        // The watched side whose outer edge the point is on (null: none).
        string EdgeAt(int x, int y)
        {
            foreach (string s in Sides) if (Screens.OnOuterEdge(x, y, s)) return s;
            return null;
        }

        public void Begin(bool mouse, bool keys)
        {
            Begin(mouse, keys, null);
        }

        // edge: the side that was crossed (null: the pointer's own edge, or none), for the animation.
        public void Begin(bool mouse, bool keys, string edge)
        {
            if (capturing) { capMouse = mouse; capKeys = keys; return; }
            capturing = true; capMouse = mouse; capKeys = keys;
            heldVks.Clear(); heldButtons.Clear();
            hkPending = 0; hkRemote.Clear();
            Touch();
            if (mouse)
            {
                Native.POINT p;
                Native.GetCursorPos(out p);
                saved = new Point(p.x, p.y);
                // Leaving: the animation where it goes, then the pointer hides and stays put for
                // the eye (it is parked in the middle only to measure motion).
                if (Flash != null) Flash.Play(saved, edge ?? EdgeAt(p.x, p.y), true);
                HideCursor.Hide();
                // Park in the middle so outward motion isn't clamped by the screen edge.
                parked = Screens.Center();
                parkedAt = DateTime.UtcNow;
                parkPad.Cover(parked);
                Native.SetCursorPos(parked.X, parked.Y);
            }
            pushes.Clear();
            lastCross = DateTime.UtcNow; arrivalSide = null;
        }

        // side == null: put the pointer back where capture began.
        public void Stop(string side, double offset)
        {
            if (!capturing) return;
            capturing = false;
            // Rule 5: whatever is still held was pressed remotely; its release stays swallowed here.
            foreach (uint vk in heldVks) swallowVks.Add(vk);
            foreach (int b in heldButtons) swallowButtons.Add(b);
            heldVks.Clear(); heldButtons.Clear();
            hkPending = 0; hkRemote.Clear(); // a sent hotkey's release is in swallowVks (heldVks) now
            if (capMouse)
            {
                Point p = side != null ? Screens.EdgePoint(side, offset) : saved;
                parkPad.Uncover();
                Native.SetCursorPos(p.X, p.Y);
                HideCursor.Show();
                if (Flash != null) Flash.Play(p, side ?? EdgeAt(p.X, p.Y), false); // arriving
            }
            Arrived(side);
        }

        // Watches these sides for the pointer leaving this PC (valid names only, no repeats). Off, or none
        // given: nothing is watched.
        public void ArmReturn(bool on, IEnumerable<string> sides, double resistance)
        {
            WatchLocal(on);
            retSides.Clear();
            retPushes.Clear();
            if (on && sides != null)
            {
                foreach (string s in sides)
                    if ((s == "left" || s == "right" || s == "top" || s == "bottom") && !retSides.Contains(s)) retSides.Add(s);
            }
            retArmed = retSides.Count > 0;
            retResistance = resistance;
        }

        void OnRawMove(int dx, int dy)
        {
            Watchdog();
            if (capturing) return;
            if (NoteLocal(dx, dy, false)) return;
            Native.POINT p;
            Native.GetCursorPos(out p);
            if (retArmed) { FeedReturn(p.x, p.y, dx, dy); return; }
            if (!DriveOther || Sides.Count == 0 || (AnyButtonDown() && !AppWindows.Grabbing)) { pushes.Clear(); return; } // Rule 6: no crossing mid-drag
            foreach (string side in Sides)
            {
                double outward = Screens.Outward(side, dx, dy);
                if (!MayCross(side, outward)) { pushes.Remove(side); continue; }
                if (outward <= 0 || !Screens.OnOuterEdge(p.x, p.y, side) || !InZone(EdgeZones, p.x, p.y, side)) { pushes.Remove(side); continue; }
                DateTime now = DateTime.UtcNow;
                EdgePush e;
                if (!pushes.TryGetValue(side, out e)) { e = new EdgePush(); pushes[side] = e; }
                if ((now - e.Last).TotalMilliseconds > 300) e.Amount = 0;
                e.Last = now;
                if (e.Amount == 0) e.Since = now;
                e.Amount += outward;
                if (e.Amount < ResistancePx || !Dwelt(ResistancePx, e.Since, now)) continue;
                double offset = Screens.Offset(p.x, p.y, side);
                Begin(true, EdgeKeyboard, side); // start capturing at once so no motion leaks, then tell main
                saved = new Point(p.x, p.y);
                Dictionary<string, object> d = Ev("edge");
                AppWindows.AddMoving(d, true); // a window grabbed with the move key goes over with the pointer (pcapps.js)
                d["offset"] = Math.Round(offset, 4);
                d["side"] = side;
                emit(d);
                return;
            }
        }

        // Injected moves report here too (Injector.Moved): the owner's hand reaches the edge.
        // The return event names the side it left by. Pushes are summed per side; the first side to reach
        // the resistance wins and the watch is off until main arms it again.
        public void FeedReturn(int x, int y, double dx, double dy)
        {
            if (!retArmed || HoldReturn) return;
            DateTime now = DateTime.UtcNow;
            foreach (string side in retSides)
            {
                double outward = Screens.Outward(side, dx, dy);
                if (!MayCross(side, outward)) { retPushes.Remove(side); continue; }
                if (outward <= 0 || !Screens.OnOuterEdge(x, y, side) || !InZone(ReturnZones, x, y, side)) { retPushes.Remove(side); continue; }
                EdgePush e;
                if (!retPushes.TryGetValue(side, out e)) { e = new EdgePush(); retPushes[side] = e; }
                if ((now - e.Last).TotalMilliseconds > 300) e.Amount = 0;
                e.Last = now;
                if (e.Amount == 0) e.Since = now;
                e.Amount += outward;
                if (e.Amount < retResistance || !Dwelt(retResistance, e.Since, now)) continue;
                retArmed = false;
                retPushes.Clear();
                lastCross = now;
                if (Flash != null) Flash.Play(new Point(x, y), side, true); // leaving this PC for another device
                Dictionary<string, object> d = Ev("return");
                AppWindows.AddMoving(d, false); // a window grabbed with the move key goes over with the pointer (pcapps.js)
                d["offset"] = Math.Round(Screens.Offset(x, y, side), 4);
                d["side"] = side;
                emit(d);
                return;
            }
        }
    }
}
#endif

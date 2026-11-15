// TwinDesk — Copyright (C) 2026 inukaasith, pengusto. GPL-3.0, see LICENSE.
// Hold a key to cross (kvmConfig crossingModifier, #230) and the emergency return shortcut
// (kvmConfig emergencyKeys, #178), as the Mac helper has them (CrossingModifier.swift,
// EmergencyShortcut.swift, EmergencyInputGate.swift).
//
// Crossing bits travel between peers in k.mod and kvm.take crossingFlags: 1 Command (the Windows key
// here), 2 Control, 4 Alt (Option), 8 Shift. Only these bits go over; no key is injected for them.
using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace MacShare
{
    partial class Capture
    {
        // "" (cross as before), "Command" (the Windows key), "Control", "Alt" or "Shift".
        public string CrossingModifier = "";
        // Driven by a peer that reports its modifiers (kvm.take crossingModifierV1): the way back needs
        // the key too. An older driver can't say, and the way back stays open.
        public bool ReturnRequiresModifier;
        public volatile int RemoteCrossingBits;
        bool crossingWatch;
        int crossingSent = -1;
        // The modifiers physically down here, from the keyboard hook (a key the hook swallows while
        // capturing never reaches GetAsyncKeyState).
        readonly HashSet<uint> modDown = new HashSet<uint>();

        static int BitOf(uint vk)
        {
            switch (vk)
            {
                case 0x5B: case 0x5C: return 1;                // Windows keys
                case 0x11: case 0xA2: case 0xA3: return 2;     // Ctrl
                case 0x12: case 0xA4: case 0xA5: return 4;     // Alt
                case 0x10: case 0xA0: case 0xA1: return 8;     // Shift
            }
            return 0;
        }

        public int LocalCrossingBits()
        {
            int bits = 0;
            foreach (uint vk in modDown) bits |= BitOf(vk);
            return bits;
        }

        public static bool AllowsCrossing(string required, int bits)
        {
            switch (required ?? "")
            {
                case "": return true;
                case "Command": return (bits & 1) != 0;
                case "Control": return (bits & 2) != 0;
                case "Alt": return (bits & 4) != 0;
                case "Shift": return (bits & 8) != 0;
            }
            return false;
        }

        // Leaving this PC at its edge: the held key, when one is set.
        bool EdgeAllowed() { return AllowsCrossing(CrossingModifier, LocalCrossingBits()); }

        // The way back (driven): the driver's keys, or this PC's own (its own mouse at the edge).
        bool ReturnAllowed()
        {
            return !ReturnRequiresModifier || AllowsCrossing(CrossingModifier, RemoteCrossingBits | LocalCrossingBits());
        }

        // A compatible peer accepted: from now on it hears this PC's modifiers while we drive it.
        public void WatchCrossingFlags()
        {
            if (!capturing || !capMouse) return;
            crossingWatch = true;
            crossingSent = -1;
            SendCrossingBits();
        }

        void SendCrossingBits()
        {
            int bits = LocalCrossingBits();
            if (bits == crossingSent) return;
            crossingSent = bits;
            Dictionary<string, object> e = K("k.mod");
            e["flags"] = bits;
            Forward(e);
        }

        // Every key the hook sees, first: the modifiers' state, sent on while watched.
        void NoteModifier(uint vk, bool down)
        {
            if (BitOf(vk) == 0) return;
            if (down) modDown.Add(vk); else modDown.Remove(vk);
            if (capturing && capMouse && crossingWatch) SendCrossingBits();
        }

        void CrossingReset() { crossingWatch = false; crossingSent = -1; }

        // ---- emergency return ----

        public bool EmergencyActive; // a session is on (main: mode isn't home)
        public EmergencyShortcut Emergency = new EmergencyShortcut(EmergencyShortcut.Fallback);
        readonly EmergencyGate emergencyGate = new EmergencyGate();

        public void SetEmergencyActive(bool on)
        {
            EmergencyActive = on;
            emergencyGate.Session(on);
            // Held only until main has ended the session: after that main injects nothing of it, and a
            // phone's remote (injected the same way) works again.
            Injector.Blocked = emergencyGate.Stopping;
        }

        // The shortcut pressed while a session is on: capture stops here first, injected keys and
        // buttons are let go, and main is told (it goes home and turns sharing off).
        bool CheckEmergency(uint vk, string code, bool down)
        {
            if (!(EmergencyActive || capturing) || !down || code == null) return false;
            if (!Emergency.Matches(code, LocalCrossingBits())) return false;
            emergencyGate.Stop();
            Injector.Blocked = true;
            if (capturing) Stop(null, 0);
            else if (ReleaseInjected != null) ReleaseInjected();
            DisarmForEmergency();
            EmergencyActive = false;
            DriveOther = false;
            emergencyVks.Add(vk); // its repeats and release stay here
            emit(Ev("emergency"));
            return true;
        }

        public Action ReleaseInjected; // Program: the injector's keys and buttons, let go
        readonly HashSet<uint> emergencyVks = new HashSet<uint>();
    }

    // After an emergency, input from the old session stays blocked until main ends it and starts another.
    class EmergencyGate
    {
        enum State { Open, WaitingForEnd, WaitingForNewSession }
        State state = State.Open;
        public bool AllowsInput { get { return state == State.Open; } }
        public bool Stopping { get { return state == State.WaitingForEnd; } }
        public void Stop() { state = State.WaitingForEnd; }
        public void Session(bool active)
        {
            if (!active && state == State.WaitingForEnd) state = State.WaitingForNewSession;
            else if (active && state == State.WaitingForNewSession) state = State.Open;
        }
    }

    // "Control+Alt+Command+Escape" and the like (mac/emergency-shortcut.js); anything invalid is the fallback.
    class EmergencyShortcut
    {
        public const string Fallback = "Control+Alt+Command+Escape";
        static readonly Regex KeyRx = new Regex(@"^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|20)|Escape|Space|Tab|Backspace|Delete|Enter|Up|Down|Left|Right)$");
        static readonly Regex BareRx = new Regex(@"^F(?:1[3-9]|20)$");
        public readonly string Code;
        public readonly int Bits;

        public EmergencyShortcut(string value)
        {
            string code; int bits;
            if (!Parse(value ?? "", out code, out bits)) Parse(Fallback, out code, out bits);
            Code = code; Bits = bits;
        }

        static bool Parse(string value, out string code, out int bits)
        {
            code = null; bits = 0;
            string[] parts = value.Split('+');
            string key = parts[parts.Length - 1];
            if (!KeyRx.IsMatch(key)) return false;
            HashSet<string> seen = new HashSet<string>();
            bool nonShift = false;
            for (int i = 0; i < parts.Length - 1; i++)
            {
                string m = parts[i];
                int b = m == "Command" ? 1 : m == "Control" ? 2 : m == "Alt" ? 4 : m == "Shift" ? 8 : 0;
                if (b == 0 || !seen.Add(m)) return false;
                if (m != "Shift") nonShift = true;
                bits |= b;
            }
            if (!nonShift && !(parts.Length == 1 && BareRx.IsMatch(key))) return false;
            if (key.Length == 1 && key[0] >= 'A' && key[0] <= 'Z') code = "Key" + key;
            else if (key.Length == 1) code = "Digit" + key;
            else if (key == "Up" || key == "Down" || key == "Left" || key == "Right") code = "Arrow" + key;
            else code = key;
            return true;
        }

        public bool Matches(string code, int bits) { return code == Code && bits == Bits; }
    }
}

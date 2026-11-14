// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
import CoreGraphics

// Only these four bits travel between compatible peers; no keystrokes are injected.
func crossingBits(_ flags: CGEventFlags) -> Int {
  (flags.contains(.maskCommand) ? 1 : 0) | (flags.contains(.maskControl) ? 2 : 0) |
  (flags.contains(.maskAlternate) ? 4 : 0) | (flags.contains(.maskShift) ? 8 : 0)
}

func crossingFlags(_ bits: Int) -> CGEventFlags {
  var flags: CGEventFlags = []
  if bits & 1 != 0 { flags.insert(.maskCommand) }
  if bits & 2 != 0 { flags.insert(.maskControl) }
  if bits & 4 != 0 { flags.insert(.maskAlternate) }
  if bits & 8 != 0 { flags.insert(.maskShift) }
  return flags
}

// The empty setting preserves the existing automatic edge crossing.
func allowsCrossing(required: String, flags: CGEventFlags) -> Bool {
  switch required {
  case "": return true
  case "Command": return flags.contains(.maskCommand)
  case "Control": return flags.contains(.maskControl)
  case "Alt": return flags.contains(.maskAlternate)
  case "Shift": return flags.contains(.maskShift)
  default: return false
  }
}

// An interrupted push must start over even if the key is pressed again quickly.
func crossingModifierGate(required: String, flags: CGEventFlags, reset: () -> Void) -> Bool {
  guard allowsCrossing(required: required, flags: flags) else { reset(); return false }
  return true
}

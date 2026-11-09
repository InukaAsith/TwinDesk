// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
import CoreGraphics

// A distinct emergency chord, only acted on while a one-to-one session is using input.
func emergencyShortcutPressed(keyCode: UInt16, flags: CGEventFlags, down: Bool) -> Bool {
  down && keyCode == 0x35 && flags.contains([.maskControl, .maskAlternate, .maskCommand])
}

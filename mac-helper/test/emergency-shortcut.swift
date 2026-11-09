// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
import CoreGraphics

@main
struct EmergencyShortcutTest {
  static func main() {
    let chord: CGEventFlags = [.maskControl, .maskAlternate, .maskCommand]
    precondition(emergencyShortcutPressed(keyCode: 0x35, flags: chord, down: true))
    precondition(!emergencyShortcutPressed(keyCode: 0x35, flags: [.maskAlternate, .maskCommand], down: true))
    precondition(!emergencyShortcutPressed(keyCode: 0x35, flags: chord, down: false))
    precondition(!emergencyShortcutPressed(keyCode: 0x24, flags: chord, down: true))
    print("emergency shortcut matcher: ok")
  }
}

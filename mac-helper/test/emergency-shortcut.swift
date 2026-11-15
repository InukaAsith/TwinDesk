// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
import CoreGraphics

@main
struct EmergencyShortcutTest {
  static func main() {
    let chord: CGEventFlags = [.maskControl, .maskAlternate, .maskCommand]
    let fallback = EmergencyShortcut(EmergencyShortcut.fallback)
    precondition(fallback.matches(keyCode: 0x35, flags: chord, down: true))
    precondition(!fallback.matches(keyCode: 0x35, flags: [.maskAlternate, .maskCommand], down: true))
    precondition(!fallback.matches(keyCode: 0x35, flags: chord, down: false))
    precondition(!fallback.matches(keyCode: 0x35, flags: chord.union(.maskShift), down: true))
    let custom = EmergencyShortcut("Control+Alt+R")
    precondition(custom.matches(keyCode: 0x0F, flags: [.maskControl, .maskAlternate], down: true))
    precondition(!custom.matches(keyCode: 0x35, flags: chord, down: true))
    precondition(EmergencyShortcut("F14").matches(keyCode: 0x6B, flags: [], down: true))
    for invalid in ["", "R", "Shift+R", "Control+Control+R", "Control++R", "Control+F24", "Foo+R"] {
      precondition(EmergencyShortcut(invalid).matches(keyCode: 0x35, flags: chord, down: true))
    }
    print("emergency shortcut matcher: ok")
  }
}

// TwinDesk — Copyright (C) 2026 pengusto. GPL-3.0, see LICENSE.
import CoreGraphics

struct EmergencyShortcut {
  static let fallback = "Control+Alt+Command+Escape"
  let code: String
  let modifiers: CGEventFlags

  init(_ value: String) {
    let parts = value.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    let names: [String: CGEventFlags] = ["Control": .maskControl, "Alt": .maskAlternate,
                                          "Shift": .maskShift, "Command": .maskCommand]
    let key = parts.last ?? ""
    let mods = Array(parts.dropLast())
    let special = ["Up": "ArrowUp", "Down": "ArrowDown", "Left": "ArrowLeft", "Right": "ArrowRight"]
    let physical: String
    if key.count == 1, let c = key.first, c.isASCII, c.isUppercase { physical = "Key" + key }
    else if key.count == 1, let c = key.first, c.isASCII, c.isNumber { physical = "Digit" + key }
    else { physical = special[key] ?? key }
    let allowed = key.range(of: #"^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|20)|Escape|Space|Tab|Backspace|Delete|Enter|Up|Down|Left|Right)$"#, options: .regularExpression) != nil
    let bare = mods.isEmpty && key.range(of: #"^F(?:1[3-9]|20)$"#, options: .regularExpression) != nil
    if !allowed || KeyCodes.toMac[physical] == nil || Set(mods).count != mods.count ||
        mods.contains(where: { names[$0] == nil }) || (!bare && !mods.contains(where: { $0 != "Shift" })) {
      self.code = "Escape"
      self.modifiers = [.maskControl, .maskAlternate, .maskCommand]
      return
    }
    self.code = physical
    self.modifiers = mods.reduce(CGEventFlags()) { $0.union(names[$1]!) }
  }

  func matches(keyCode: UInt16, flags: CGEventFlags, down: Bool, kbType: Int64 = 0) -> Bool {
    let mask: CGEventFlags = [.maskControl, .maskAlternate, .maskShift, .maskCommand]
    return down && KeyCodes.code(keyCode, kbType: kbType) == code && flags.intersection(mask) == modifiers
  }
}

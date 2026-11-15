// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
import CoreFoundation
import Foundation

/// Whether Ctrl+Space / Ctrl+Option+Space from remote input should switch the layout here
/// (macOS ignores those as synthetic keys) or be passed through to apps using the same combo.
enum InputSourceShortcut {
  static let previousInputSourceID = 60
  static let nextInputSourceID = 61
  private static let spaceKeyCode = 49
  // com.apple.symbolichotkeys default masks: Control=262144, Control+Option=786432 (ids 60/61).
  private static let controlMask: UInt32 = 262144
  private static let controlOptionMask: UInt32 = 786432

  struct Binding: Equatable {
    var enabled: Bool
    var keyCode: Int
    var modifiers: UInt32
  }

  static func hotkeyID(for heldKinds: Set<String>) -> Int? {
    switch heldKinds {
    case ["Control"]: return previousInputSourceID
    case ["Control", "Alt"]: return nextInputSourceID
    default: return nil
    }
  }

  static func defaultBinding(for id: Int) -> Binding? {
    switch id {
    case previousInputSourceID:
      return Binding(enabled: true, keyCode: spaceKeyCode, modifiers: controlMask)
    case nextInputSourceID:
      return Binding(enabled: true, keyCode: spaceKeyCode, modifiers: controlOptionMask)
    default: return nil
    }
  }

  /// Pure decision: match macOS's input-source symbolic hotkey and require 2+ layouts.
  static func shouldSwitch(heldKinds: Set<String>, bindings: [Int: Binding], selectableSourceCount: Int) -> Bool {
    guard selectableSourceCount > 1, let id = hotkeyID(for: heldKinds), let expected = defaultBinding(for: id) else { return false }
    let binding = bindings[id] ?? expected
    guard binding.enabled else { return false }
    return binding.keyCode == expected.keyCode && binding.modifiers == expected.modifiers
  }

  static func shouldSwitch(heldKinds: Set<String>) -> Bool {
    shouldSwitch(heldKinds: heldKinds, bindings: symbolicHotkeyBindings(), selectableSourceCount: InputSources.selectableCount())
  }

  static func symbolicHotkeyBindings() -> [Int: Binding] {
    guard let root = CFPreferencesCopyAppValue("AppleSymbolicHotKeys" as CFString, "com.apple.symbolichotkeys" as CFString) as? [String: Any] else { return [:] }
    var out: [Int: Binding] = [:]
    for (key, value) in root {
      guard let id = Int(key), let entry = value as? [String: Any] else { continue }
      let enabled: Bool = {
        if let b = entry["enabled"] as? Bool { return b }
        if let n = entry["enabled"] as? NSNumber { return n.boolValue }
        return true
      }()
      guard let valueDict = entry["value"] as? [String: Any],
            let raw = valueDict["parameters"] as? [Any], raw.count >= 3,
            let keyCode = (raw[1] as? NSNumber)?.intValue,
            let mods = (raw[2] as? NSNumber)?.uint32Value else { continue }
      out[id] = Binding(enabled: enabled, keyCode: keyCode, modifiers: mods)
    }
    return out
  }
}

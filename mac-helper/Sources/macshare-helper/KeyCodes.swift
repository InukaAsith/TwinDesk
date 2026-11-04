// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// DOM KeyboardEvent.code <-> macOS virtual key codes (kVK_* from Carbon's Events.h, ANSI layout).
import Carbon.HIToolbox
import CoreGraphics

enum KeyCodes {
  static let toMac: [String: UInt16] = [
    "KeyA": 0x00, "KeyS": 0x01, "KeyD": 0x02, "KeyF": 0x03, "KeyH": 0x04, "KeyG": 0x05, "KeyZ": 0x06,
    "KeyX": 0x07, "KeyC": 0x08, "KeyV": 0x09, "IntlBackslash": 0x0A, "KeyB": 0x0B, "KeyQ": 0x0C,
    "KeyW": 0x0D, "KeyE": 0x0E, "KeyR": 0x0F, "KeyY": 0x10, "KeyT": 0x11,
    "Digit1": 0x12, "Digit2": 0x13, "Digit3": 0x14, "Digit4": 0x15, "Digit6": 0x16, "Digit5": 0x17,
    "Equal": 0x18, "Digit9": 0x19, "Digit7": 0x1A, "Minus": 0x1B, "Digit8": 0x1C, "Digit0": 0x1D,
    "BracketRight": 0x1E, "KeyO": 0x1F, "KeyU": 0x20, "BracketLeft": 0x21, "KeyI": 0x22, "KeyP": 0x23,
    "Enter": 0x24, "KeyL": 0x25, "KeyJ": 0x26, "Quote": 0x27, "KeyK": 0x28, "Semicolon": 0x29,
    "Backslash": 0x2A, "Comma": 0x2B, "Slash": 0x2C, "KeyN": 0x2D, "KeyM": 0x2E, "Period": 0x2F,
    "Tab": 0x30, "Space": 0x31, "Backquote": 0x32, "Backspace": 0x33, "Escape": 0x35,
    "MetaRight": 0x36, "MetaLeft": 0x37, "ShiftLeft": 0x38, "CapsLock": 0x39, "AltLeft": 0x3A,
    "ControlLeft": 0x3B, "ShiftRight": 0x3C, "AltRight": 0x3D, "ControlRight": 0x3E, "Fn": 0x3F,
    "F17": 0x40, "NumpadDecimal": 0x41, "NumpadMultiply": 0x43, "NumpadAdd": 0x45, "NumLock": 0x47,
    "AudioVolumeUp": 0x48, "AudioVolumeDown": 0x49, "AudioVolumeMute": 0x4A, "NumpadDivide": 0x4B,
    "NumpadEnter": 0x4C, "NumpadSubtract": 0x4E, "F18": 0x4F, "F19": 0x50, "NumpadEqual": 0x51,
    "Numpad0": 0x52, "Numpad1": 0x53, "Numpad2": 0x54, "Numpad3": 0x55, "Numpad4": 0x56,
    "Numpad5": 0x57, "Numpad6": 0x58, "Numpad7": 0x59, "F20": 0x5A, "Numpad8": 0x5B, "Numpad9": 0x5C,
    "IntlYen": 0x5D, "IntlRo": 0x5E, "NumpadComma": 0x5F,
    "F5": 0x60, "F6": 0x61, "F7": 0x62, "F3": 0x63, "F8": 0x64, "F9": 0x65, "F11": 0x67, "F13": 0x69,
    "F16": 0x6A, "F14": 0x6B, "F10": 0x6D, "ContextMenu": 0x6E, "F12": 0x6F, "F15": 0x71,
    "Insert": 0x72, "Help": 0x72, "Home": 0x73, "PageUp": 0x74, "Delete": 0x75, "F4": 0x76, "End": 0x77,
    "F2": 0x78, "PageDown": 0x79, "F1": 0x7A, "ArrowLeft": 0x7B, "ArrowRight": 0x7C,
    "ArrowDown": 0x7D, "ArrowUp": 0x7E,
    // PC keys without a Mac key: map onto the spare F keys (as macOS does for PC keyboards).
    "PrintScreen": 0x69, "ScrollLock": 0x6B, "Pause": 0x71,
    // Brightness as some Mac keyboards send it (a key, not a system key); injected as system keys.
    "BrightnessUp": 0x90, "BrightnessDown": 0x91,
  ]

  /// The system keys (volume, brightness, media, keyboard light): NX_SYSDEFINED events of subtype 8
  /// (aux control buttons), their NX_KEYTYPE_* from ev_keymap.h. macOS acts on these, not on a key
  /// event with the volume's virtual key, so they're read and posted that way (#115).
  static let system: [String: Int] = [
    "AudioVolumeUp": 0, "AudioVolumeDown": 1, "BrightnessUp": 2, "BrightnessDown": 3, "AudioVolumeMute": 7,
    "MediaPlayPause": 16, "MediaTrackNext": 17, "MediaTrackPrevious": 18, "MediaFastForward": 19, "MediaRewind": 20,
    "KbdIllumUp": 21, "KbdIllumDown": 22, "KbdIllumToggle": 23,
  ]
  static let fromSystem: [Int: String] = Dictionary(uniqueKeysWithValues: system.map { ($1, $0) })

  static let fromMac: [UInt16: String] = {
    var m: [UInt16: String] = [:]
    for (code, vk) in toMac where m[vk] == nil || code.count < m[vk]!.count { m[vk] = code }
    // Prefer the real names where two codes share a key.
    m[0x72] = "Insert"; m[0x69] = "F13"; m[0x6B] = "F14"; m[0x71] = "F15"
    return m
  }()

  /// Apple ISO keyboards (German, French, British…) give the key left of 1 (^ on a German Mac, @ on a
  /// French one) 0x0A and the key left of Z (<) 0x32: the other way round from the ANSI names above,
  /// so there the two swap (as Chromium does). kbType: the keyboard an event came from; without one,
  /// the one last used on this Mac.
  static func isISO(_ kbType: Int64 = 0) -> Bool {
    let t = kbType > 0 && kbType < 256 ? Int16(kbType) : Int16(LMGetKbdType())
    return KBGetLayoutType(t) == UInt32(kKeyboardISO)
  }

  private static func isoSwap(_ vk: UInt16, _ iso: Bool) -> UInt16 {
    guard iso else { return vk }
    return vk == 0x0A ? 0x32 : vk == 0x32 ? 0x0A : vk
  }

  /// The code for a key this Mac's keyboard sent.
  static func code(_ vk: UInt16, kbType: Int64 = 0) -> String? { fromMac[isoSwap(vk, isISO(kbType))] }

  /// This Mac's key for a code.
  static func vk(_ code: String) -> UInt16? { toMac[code].map { isoSwap($0, isISO()) } }

  /// Modifier key -> (generic flag, device-dependent flag bit from IOLLEvent.h).
  static let modifiers: [String: (flag: CGEventFlags, device: UInt64)] = [
    "ShiftLeft": (.maskShift, 0x02), "ShiftRight": (.maskShift, 0x04),
    "ControlLeft": (.maskControl, 0x01), "ControlRight": (.maskControl, 0x2000),
    "AltLeft": (.maskAlternate, 0x20), "AltRight": (.maskAlternate, 0x40),
    "MetaLeft": (.maskCommand, 0x08), "MetaRight": (.maskCommand, 0x10),
  ]
}

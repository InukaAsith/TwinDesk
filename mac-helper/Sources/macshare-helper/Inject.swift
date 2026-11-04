// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Input injection with CGEvent: absolute stream input (`input`, a phone's stylus in Pen.swift) and releaseAll.
// Relative KVM input (`inject`) is in InjectRelative.swift.
// Every injected event is marked with eventSourceUserData = 0x4D53 so our own tap can skip it.
import Carbon.HIToolbox
import Cocoa
import IOKit.pwr_mgt
import IOKit.hidsystem

let injectedMark: Int64 = 0x4D53

final class Injector {
  let source: CGEventSource?
  private var heldKeys = Set<UInt16>()         // non-modifier keys we pressed
  private var heldMods = Set<String>()         // modifier DOM codes we pressed
  private var capsLock = false
  var heldButtons = Set<Int>()                 // P.BUTTON values
  private var lastDown: (at: TimeInterval, point: CGPoint, button: Int, count: Int64)?
  var clickCount: [Int: Int64] = [:]           // button -> click state of its current press
  // Input source shortcuts from the other computer are done here (InputSources.next): macOS's
  // input menu ignores a synthetic Ctrl+Space or 🌐. Ctrl(+Option)+Space (Win+Space on a PC, with
  // the Ctrl/Cmd swap), a tap of 🌐/Fn, a tap of Option+Shift or Cmd+Shift (Alt+Shift, Ctrl+Shift on a PC).
  private var swallowSpace = false
  private var tapMods = Set<String>()          // modifiers (and Fn) pressed since none were held
  private var tapDown = Set<String>()          // those held now
  private var modsOnly = false                 // ...and no other key between
  // Injected events don't count as user activity, so a sleeping display stays dark. Declare it,
  // at most once a second, reusing one assertion.
  private var activityID = IOPMAssertionID(0)
  private var lastActivity: TimeInterval = 0
  // A phone's stylus (Pen.swift): its pointer events go as a tablet pen's.
  lazy var pen = PenInput(source: source, post: { [unowned self] e in self.post(e) })

  init() {
    source = CGEventSource(stateID: .hidSystemState)
    // Don't suppress the local mouse/keyboard for 0.25 s after each injected event.
    source?.localEventsSuppressionInterval = 0
  }

  var flags: CGEventFlags {
    var f = CGEventFlags(rawValue: 0)
    for code in heldMods {
      if let m = KeyCodes.modifiers[code] { f.insert(m.flag); f.insert(CGEventFlags(rawValue: m.device)) }
    }
    if capsLock { f.insert(.maskAlphaShift) }
    return f
  }

  /// Caps Lock (#131): set != nil turns it that way, the real one (its light too) and the one our
  /// keys carry. Returns whether it is on.
  func caps(set: Bool?) -> Bool {
    guard let on = set else { return CGEventSource.flagsState(.combinedSessionState).contains(.maskAlphaShift) }
    capsLock = on
    let svc = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching(kIOHIDSystemClass))
    if svc != 0 {
      var conn: io_connect_t = 0
      if IOServiceOpen(svc, mach_task_self_, UInt32(kIOHIDParamConnectType), &conn) == KERN_SUCCESS {
        IOHIDSetModifierLockState(conn, Int32(kIOHIDCapsLockState), on)
        IOServiceClose(conn)
      }
      IOObjectRelease(svc)
    }
    return on
  }

  // A volume, brightness or media key as macOS's own keys send it (NX_SYSDEFINED, aux control
  // button): a key event with the volume's virtual key does nothing (#115).
  func systemKey(_ kt: Int, down: Bool) {
    let state = down ? 0x0A : 0x0B
    guard let e = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(state << 8)),
                                     timestamp: 0, windowNumber: 0, context: nil, subtype: 8,
                                     data1: (kt << 16) | (state << 8), data2: -1) else { return }
    post(e.cgEvent)
  }

  func post(_ e: CGEvent?) {
    guard let e = e else { return }
    e.setIntegerValueField(.eventSourceUserData, value: injectedMark)
    e.post(tap: .cghidEventTap)
    declareActivity()
  }

  func declareActivity() {
    let now = ProcessInfo.processInfo.systemUptime
    if now - lastActivity < 1 { return }
    lastActivity = now
    IOPMAssertionDeclareUserActivity("TwinDesk remote input" as CFString, kIOPMUserActiveLocal, &activityID)
  }

  private func cgButton(_ b: Int) -> CGMouseButton {
    switch b { case 0: return .left; case 1: return .right; default: return .center }
  }

  func mouseType(_ b: Int, down: Bool) -> CGEventType {
    switch b {
    case 0: return down ? .leftMouseDown : .leftMouseUp
    case 1: return down ? .rightMouseDown : .rightMouseUp
    default: return down ? .otherMouseDown : .otherMouseUp
    }
  }

  func mouse(_ type: CGEventType, at p: CGPoint, button b: Int, clickState: Int64? = nil) {
    let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: cgButton(b))
    // P.BUTTON: 0 left, 1 right, 2 middle, 3 back, 4 forward -> CG button numbers 0, 1, 2, 3, 4.
    e?.setIntegerValueField(.mouseEventButtonNumber, value: Int64(b))
    if let c = clickState { e?.setIntegerValueField(.mouseEventClickState, value: c) }
    e?.flags = flags
    if let e = e { pen.decorate(e, at: p) }
    post(e)
  }

  private func point(_ ev: [String: Any], _ bounds: CGRect) -> CGPoint {
    let x = min(max((ev["x"] as? NSNumber)?.doubleValue ?? 0, 0), 1)
    let y = min(max((ev["y"] as? NSNumber)?.doubleValue ?? 0, 0), 1)
    return CGPoint(x: bounds.minX + min(x * bounds.width, bounds.width - 1),
                   y: bounds.minY + min(y * bounds.height, bounds.height - 1))
  }

  /// One `in.*` message (key codes already swapped by main) onto the display at `bounds`.
  func input(_ ev: [String: Any], bounds: CGRect) {
    guard let t = ev["t"] as? String else { return }
    // At a window's copy over there: the hidden pointer stays where we put it (Capture.injectedPointer).
    if t == "in.mm" || t == "in.md" || t == "in.mu" { Capture.shared.injectedPointer(at: point(ev, bounds)) }
    if let p = ev["pen"] as? [String: Any] {
      guard pen.arrive(p) else { return } // out of range: its proximity ended
      pen.current = p
    }
    defer { pen.current = nil }
    switch t {
    case "in.mm":
      let p = point(ev, bounds)
      if let b = heldButtons.min() {
        let type: CGEventType = b == 0 ? .leftMouseDragged : b == 1 ? .rightMouseDragged : .otherMouseDragged
        mouse(type, at: p, button: b, clickState: clickCount[b])
      } else {
        mouse(.mouseMoved, at: p, button: 0)
      }
    case "in.md", "in.mu":
      button((ev["b"] as? NSNumber)?.intValue ?? 0, down: t == "in.md", at: point(ev, bounds))
    case "in.wh":
      scroll(dx: (ev["dx"] as? NSNumber)?.doubleValue ?? 0, dy: (ev["dy"] as? NSNumber)?.doubleValue ?? 0, lines: false)
    case "in.kd", "in.ku":
      guard let code = ev["code"] as? String else { return }
      key(code, down: t == "in.kd")
    default:
      log("input: unknown \(t)")
    }
  }

  /// Button down/up at `p`, with the click count macOS expects for double/triple clicks.
  func button(_ b: Int, down: Bool, at p: CGPoint) {
    // Move windows (Grab.swift): the move key and an injected click grab a window, the same as here.
    if b == 0 && down && WindowGrab.shared.tryGrab(at: p, flags: flags.rawValue) { return }
    if b == 0 && !down && WindowGrab.shared.upPending { _ = WindowGrab.shared.up(); return }
    if down {
      let now = ProcessInfo.processInfo.systemUptime
      var count: Int64 = 1
      if let l = lastDown, l.button == b, now - l.at < NSEvent.doubleClickInterval,
         abs(l.point.x - p.x) <= 4, abs(l.point.y - p.y) <= 4 {
        count = l.count + 1
      }
      lastDown = (now, p, b, count)
      clickCount[b] = count
      heldButtons.insert(b)
      mouse(mouseType(b, down: true), at: p, button: b, clickState: count)
    } else {
      guard heldButtons.remove(b) != nil else { return }
      mouse(mouseType(b, down: false), at: p, button: b, clickState: clickCount[b] ?? 1)
    }
  }

  /// Scroll in DOM sign (positive dy = see content further down); pixels, or lines (wheel notches).
  func scroll(dx: Double, dy: Double, lines: Bool) {
    let clamp = { (v: Double) in Int32(max(-10000, min(10000, -v.rounded()))) }
    let e = CGEvent(scrollWheelEvent2Source: source, units: lines ? .line : .pixel, wheelCount: 2,
                    wheel1: clamp(dy), wheel2: clamp(dx), wheel3: 0)
    e?.flags = flags
    post(e)
  }

  func key(_ code: String, down: Bool) {
    if let kt = KeyCodes.system[code] { return systemKey(kt, down: down) }
    if code == "Space" {
      let held = Set(heldMods.map(Injector.kind))
      if down && (held == ["Control"] || held == ["Control", "Alt"]) {
        swallowSpace = true
        modsOnly = false
        InputSources.next()
        return
      }
      if !down && swallowSpace { swallowSpace = false; return }
    }
    if KeyCodes.modifiers[code] != nil || code == "Fn" {
      if down {
        if tapDown.isEmpty { tapMods = []; modsOnly = true }
        tapDown.insert(code)
        tapMods.insert(code)
      } else if tapDown.remove(code) != nil && tapDown.isEmpty {
        let kinds = Set(tapMods.map(Injector.kind))
        if modsOnly && (kinds == ["Fn"] || kinds == ["Alt", "Shift"] || kinds == ["Meta", "Shift"]) { InputSources.next() }
        modsOnly = false
      }
      if code == "Fn" { return } // only its tap means something (above)
    } else if down { modsOnly = false }
    guard let vk = KeyCodes.vk(code) else {
      log("no Mac key for \(code)")
      return
    }
    if KeyCodes.modifiers[code] != nil {
      if down { heldMods.insert(code) } else { guard heldMods.remove(code) != nil else { return } }
      let e = CGEvent(keyboardEventSource: source, virtualKey: vk, keyDown: down)
      e?.type = .flagsChanged
      e?.flags = flags
      post(e)
      return
    }
    if code == "CapsLock" {
      if down {
        capsLock.toggle()
        let e = CGEvent(keyboardEventSource: source, virtualKey: vk, keyDown: true)
        e?.type = .flagsChanged
        e?.flags = flags
        post(e)
      }
      return
    }
    let repeating = down && heldKeys.contains(vk)
    if down { heldKeys.insert(vk) } else { guard heldKeys.remove(vk) != nil else { return } }
    let e = CGEvent(keyboardEventSource: source, virtualKey: vk, keyDown: down)
    e?.flags = flags
    if repeating { e?.setIntegerValueField(.keyboardEventAutorepeat, value: 1) }
    post(e)
  }

  static func kind(_ code: String) -> String {
    for k in ["Shift", "Control", "Alt", "Meta"] where code.hasPrefix(k) { return k }
    return code
  }

  /// Text typed as it is, whatever this Mac's layout: a letter of another alphabet from the other
  /// computer's layout (shared/keylayout.js) or the phone Remote's keyboard. Without modifiers.
  func type(_ text: String) {
    for ch in text.prefix(64) {
      let u = Array(String(ch).utf16)
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        e?.flags = []
        e?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
        post(e)
      }
    }
  }

  /// Key-up every key and button we hold, clear modifiers.
  func releaseAll() {
    for vk in heldKeys {
      let e = CGEvent(keyboardEventSource: source, virtualKey: vk, keyDown: false)
      e?.flags = flags
      post(e)
    }
    heldKeys.removeAll()
    tapDown.removeAll()
    modsOnly = false
    swallowSpace = false
    for code in heldMods { key(code, down: false) }
    let p = CGEvent(source: nil)?.location ?? .zero
    for b in heldButtons { mouse(mouseType(b, down: false), at: p, button: b, clickState: clickCount[b] ?? 1) }
    heldButtons.removeAll()
    pen.leave()
  }
}

// The keyboard layouts and input methods the person enabled, as the input menu lists them.
enum InputSources {
  /// The next one after the current (Ctrl+Space's "previous input source" with two of them).
  static func next() {
    let props = [
      kTISPropertyInputSourceCategory as String: kTISCategoryKeyboardInputSource as String,
      kTISPropertyInputSourceIsSelectCapable as String: true,
    ] as CFDictionary
    guard let list = TISCreateInputSourceList(props, false)?.takeRetainedValue() as? [TISInputSource], list.count > 1 else { return }
    let id = { (s: TISInputSource) -> String in
      guard let p = TISGetInputSourceProperty(s, kTISPropertyInputSourceID) else { return "" }
      return Unmanaged<CFString>.fromOpaque(p).takeUnretainedValue() as String
    }
    let cur = id(TISCopyCurrentKeyboardInputSource().takeRetainedValue())
    let i = list.firstIndex { id($0) == cur } ?? -1
    let to = list[(i + 1) % list.count]
    TISSelectInputSource(to)
    log("input source: \(id(to))")
  }

  private static func id(_ s: TISInputSource) -> String {
    guard let p = TISGetInputSourceProperty(s, kTISPropertyInputSourceID) else { return "" }
    return Unmanaged<CFString>.fromOpaque(p).takeUnretainedValue() as String
  }

  /// An input method's mode (not a layout): its first language, "ja", "zh-Hans", "ko"…
  private static func imLanguage(_ s: TISInputSource) -> String? {
    guard let t = TISGetInputSourceProperty(s, kTISPropertyInputSourceType),
          Unmanaged<CFString>.fromOpaque(t).takeUnretainedValue() as String == kTISTypeKeyboardInputMode as String,
          let l = TISGetInputSourceProperty(s, kTISPropertyInputSourceLanguages),
          let lang = (Unmanaged<CFArray>.fromOpaque(l).takeUnretainedValue() as? [String])?.first else { return nil }
    return lang
  }

  /// keyLayout's im: the language of the input method typed with (Japanese, Pinyin, Korean…), whose
  /// keys type a–z that it composes; nil on a layout or a mode typing as English (Kotoeri's Roman).
  static func currentIM() -> String? {
    guard let lang = imLanguage(TISCopyCurrentKeyboardInputSource().takeRetainedValue()), lang != "en" else { return nil }
    return lang
  }

  private static var before: String? // what was in use before select(), for restore()

  /// An enabled input method of that language, for keys from a computer typing with one
  /// (shared/keylayout.js); false when none is enabled here.
  static func select(language: String) -> Bool {
    let props = [
      kTISPropertyInputSourceCategory as String: kTISCategoryKeyboardInputSource as String,
      kTISPropertyInputSourceIsSelectCapable as String: true,
    ] as CFDictionary
    let cur = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
    if imLanguage(cur) == language { return true }
    guard let list = TISCreateInputSourceList(props, false)?.takeRetainedValue() as? [TISInputSource],
          // the plainest mode of it (Hiragana, not Katakana or half-width)
          let to = list.filter({ imLanguage($0) == language }).min(by: { id($0).count < id($1).count }) else { return false }
    if before == nil { before = id(cur) }
    TISSelectInputSource(to)
    log("input source: \(id(to)) for \(language)")
    return true
  }

  /// Back to what was in use before select().
  static func restore() {
    guard let was = before else { return }
    before = nil
    let props = [kTISPropertyInputSourceID as String: was] as CFDictionary
    if let s = (TISCreateInputSourceList(props, false)?.takeRetainedValue() as? [TISInputSource])?.first {
      TISSelectInputSource(s)
      log("input source: \(was) again")
    }
  }
}

enum KeyLayout {
  /// Keys that type a character: letters, digits, punctuation.
  static let typing: Set<String> = Set(KeyCodes.toMac.keys.filter {
    $0.hasPrefix("Key") || $0.hasPrefix("Digit") || ["Minus", "Equal", "BracketLeft", "BracketRight", "Backslash",
      "Semicolon", "Quote", "Backquote", "Comma", "Period", "Slash", "IntlBackslash"].contains($0)
  })

  /// What each of those keys types alone in the current keyboard layout, lower case: ["KeyY": "z", …]
  /// on a German Mac. Main uses it to send shortcuts by letter (shared/keylayout.js). With an input
  /// method (Japanese, Chinese…) its ASCII layout; dead keys give their character. shift: what each
  /// types with Shift instead, as it is (Sinhala's ඛ on the ක key: no case to guess it from). A key
  /// may type several characters (a ligature).
  /// sourceID: another installed layout instead (com.apple.keylayout.German), for tests.
  static func current(sourceID: String? = nil, shift: Bool = false) -> [String: String] {
    var picked: TISInputSource?
    if let sourceID {
      let props = [kTISPropertyInputSourceID as String: sourceID] as CFDictionary
      picked = (TISCreateInputSourceList(props, true)?.takeRetainedValue() as? [TISInputSource])?.first
    } else {
      picked = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue()
    }
    guard let src = picked,
          let ptr = TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData) else { return [:] }
    let data = Unmanaged<CFData>.fromOpaque(ptr).takeUnretainedValue() as Data
    var out: [String: String] = [:]
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      guard let layout = raw.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return }
      for code in typing {
        guard let vk = KeyCodes.vk(code) else { continue }
        var dead: UInt32 = 0
        var len = 0
        var chars = [UniChar](repeating: 0, count: 16)
        let mods = shift ? UInt32(shiftKey >> 8) & 0xFF : 0
        let st = UCKeyTranslate(layout, vk, UInt16(kUCKeyActionDisplay), mods, UInt32(LMGetKbdType()),
                                OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, chars.count, &len, &chars)
        guard st == noErr && len > 0 else { continue }
        let s = String(utf16CodeUnits: chars, count: len)
        out[code] = shift ? s : s.lowercased()
      }
    }
    return out
  }
}

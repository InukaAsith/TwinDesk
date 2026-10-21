// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Input injection with CGEvent: absolute stream input (`input`) and releaseAll.
// Relative KVM input (`inject`) is in InjectRelative.swift.
// Every injected event is marked with eventSourceUserData = 0x4D53 so our own tap can skip it.
import Carbon.HIToolbox
import Cocoa

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

  func post(_ e: CGEvent?) {
    guard let e = e else { return }
    e.setIntegerValueField(.eventSourceUserData, value: injectedMark)
    e.post(tap: .cghidEventTap)
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
    guard let vk = KeyCodes.toMac[code] else {
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
}

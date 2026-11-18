// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Trackpad gestures from the other computer as real macOS gesture events, so macOS
// itself does them (smooth pinch zoom in any app; Mission Control, App Exposé and Spaces following
// the fingers with the system's own animation). macOS has no public API for this: the events carry
// the private gesture fields WindowServer uses (55 event type, 110 HID event type, 113
// magnification, 123/165 dock-swipe motion, 124/135 progress, 129/130 exit speed, 132/134 phase).
// If a macOS version ignores them, main falls back to keyboard shortcuts (kvm.js).
import Cocoa

enum GesturePost {
  private static func set(_ e: CGEvent, _ f: UInt32, _ v: Int64) {
    if let field = CGEventField(rawValue: f) { e.setIntegerValueField(field, value: v) }
  }
  private static func setD(_ e: CGEvent, _ f: UInt32, _ v: Double) {
    if let field = CGEventField(rawValue: f) { e.setDoubleValueField(field, value: v) }
  }
  /// IOHIDEventPhaseBits: began 1, changed 2, ended 4, cancelled 8.
  private static func phaseBits(_ p: String?) -> Int64 {
    switch p { case "begin": return 1; case "end": return 4; case "cancel": return 8; default: return 2 }
  }
  private static func mark(_ e: CGEvent) { e.setIntegerValueField(.eventSourceUserData, value: injectedMark) }

  /// Pinch: magnification step (+ = in).
  static func magnify(_ m: Double, phase: String?) {
    guard let e = CGEvent(source: nil) else { return }
    set(e, 55, 29)  // NSEventTypeGesture
    set(e, 110, 8)  // kIOHIDEventTypeZoom
    set(e, 132, phaseBits(phase))
    setD(e, 113, m)
    mark(e)
    e.post(tap: .cgSessionEventTap)
  }

  /// A system swipe (Mission Control / App Exposé / Spaces / Launchpad pinch): motion 1 horizontal,
  /// 2 vertical, 3 pinch; offset = progress so far; exit = speed on end.
  static func dock(motion: Int64, offset: Double, phase: String?, exit: Double) {
    guard let e30 = CGEvent(source: nil), let e29 = CGEvent(source: nil) else { return }
    let ph = phaseBits(phase)
    set(e30, 55, 30)  // dock control
    set(e30, 110, 23) // kIOHIDEventTypeDockSwipe
    set(e30, 132, ph)
    set(e30, 134, ph)
    setD(e30, 124, offset)
    var f = Float32(offset)
    var bits: UInt32 = 0
    memcpy(&bits, &f, 4)
    set(e30, 135, Int64(bits))
    set(e30, 41, 33231)
    setD(e30, 123, Double(motion))
    setD(e30, 165, Double(motion))
    if ph == 4 || ph == 8 {
      setD(e30, 129, exit)
      setD(e30, 130, exit)
    }
    set(e29, 55, 29)
    set(e29, 41, 33231)
    mark(e30)
    mark(e29)
    e30.post(tap: .cgSessionEventTap)
    e29.post(tap: .cgSessionEventTap)
  }

  static func handle(_ msg: [String: Any]) {
    if injector.remoteOverview { return }
    let num = { (k: String) -> Double in (msg[k] as? NSNumber)?.doubleValue ?? 0 }
    switch msg["kind"] as? String {
    case "zoom": magnify(num("v"), phase: msg["phase"] as? String)
    case "dock": dock(motion: Int64(num("motion")), offset: num("v"), phase: msg["phase"] as? String, exit: num("exit"))
    default: break
    }
  }
}

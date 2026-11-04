// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Apps and Windows › Move windows (mac/appsend.js, shared/movewin.js): the move key held (Right Ctrl
// unless another is chosen), a click on a window grabs it. The click never reaches the app (the tap
// swallows it, or the injector doesn't post it), and the window follows the pointer through
// Accessibility until the button comes up. If the pointer crosses to another computer meanwhile, the
// edge / return event carries `moving` (its CGWindowID) and the window goes along.
import ApplicationServices
import Cocoa

final class WindowGrab {
  static let shared = WindowGrab()

  static let codes: [String: CGKeyCode] = [
    "ControlRight": 0x3E, "ControlLeft": 0x3B, "ShiftRight": 0x3C, "ShiftLeft": 0x38,
    "AltRight": 0x3D, "AltLeft": 0x3A, "MetaRight": 0x36, "MetaLeft": 0x37,
  ]

  private var key: CGKeyCode? // nil: moving is off
  private var win: AXUIElement?
  private var wid = 0
  private(set) var pid = 0 // the grabbed window's process (kept after take: the event names it)
  private var off = CGPoint.zero // the pointer's place in the window
  private(set) var upPending = false // the left button's release is swallowed (its press was)
  private let queue = DispatchQueue(label: "twindesk.grab")
  private let lock = NSLock()
  private var pending: (AXUIElement, CGPoint)?

  var grabbing: Bool { win != nil }

  /// `moveWin {key}`: "ControlRight" … "MetaLeft", "" = off.
  func setKey(_ name: String) {
    key = WindowGrab.codes[name]
    if key == nil { win = nil; upPending = false }
  }

  private func held() -> Bool {
    guard let k = key else { return false }
    return CGEventSource.keyState(.combinedSessionState, key: k)
  }

  /// The left button went down at p (global points, top-left origin). True: a window was grabbed
  /// and the click must not go on.
  func tryGrab(at p: CGPoint) -> Bool {
    guard key != nil, win == nil, held() else { return false }
    let me = Int(getpid())
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    for w in list { // front to back: the first app window under the pointer
      guard (w[kCGWindowLayer as String] as? Int) == 0, let pid = w[kCGWindowOwnerPID as String] as? Int,
            let b = w[kCGWindowBounds as String] as? [String: Double] else { continue }
      let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
      guard r.contains(p) else { continue }
      let owner = w[kCGWindowOwnerName as String] as? String ?? ""
      if pid == me || owner == "Dock" || owner == "Window Server" { return false }
      guard let ax = Apps.axWindow(pid: pid, frame: r) else { return false }
      win = ax
      wid = w[kCGWindowNumber as String] as? Int ?? 0
      self.pid = pid
      off = CGPoint(x: p.x - r.minX, y: p.y - r.minY)
      upPending = true
      AXUIElementPerformAction(ax, kAXRaiseAction as CFString)
      NSRunningApplication(processIdentifier: pid_t(pid))?.activate()
      return true
    }
    return false
  }

  /// The pointer moved to p: the window follows, off the tap's thread (AX calls wait on the app);
  /// only the newest place is set.
  func move(to p: CGPoint) {
    guard let w = win else { return }
    lock.lock()
    let start = pending == nil
    pending = (w, CGPoint(x: p.x - off.x, y: p.y - off.y))
    lock.unlock()
    if start { queue.async { self.drain() } }
  }

  private func drain() {
    while true {
      lock.lock()
      guard let (w, at) = pending else { lock.unlock(); return }
      pending = nil
      lock.unlock()
      var pt = at
      if let v = AXValueCreate(.cgPoint, &pt) { AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, v) }
    }
  }

  /// The left button came up: the grab ends. True: the release is swallowed, as its press was.
  func up() -> Bool {
    let was = upPending
    upPending = false
    win = nil
    return was
  }

  /// Crossing with a grabbed window: its CGWindowID for the event (0: none), and the grab ends.
  /// keepUp: the button is still down here (the home side), its release comes later and is swallowed.
  func take(keepUp: Bool) -> Int {
    guard win != nil else { return 0 }
    win = nil
    if !keepUp { upPending = false }
    return wid
  }
}

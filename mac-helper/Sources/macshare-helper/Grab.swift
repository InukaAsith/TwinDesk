// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Apps › Move windows (mac/appsend.js, shared/movewin.js): the move key held (Right Command
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

  private var keys: [(code: CGKeyCode, device: UInt64)] = [] // the move key and its Ctrl/Cmd partner; empty: moving is off
  private var win: AXUIElement?
  private var wid = 0
  private(set) var pid = 0 // the grabbed window's process (kept after take: the event names it)
  private var off = CGPoint.zero // the pointer's place in the window
  private(set) var upPending = false // the left button's release is swallowed (its press was)
  private let queue = DispatchQueue(label: "twindesk.grab")
  private let lock = NSLock()
  private var pending: (AXUIElement, CGPoint)?
  private var lastWhy = ""
  private var keyName: String?

  var grabbing: Bool { win != nil }

  // The key's partner under Ctrl/Cmd swapping: the other computer's Right Ctrl arrives here as Right
  // Command (or not), and a Mac's Right Command arrives on a PC as Right Ctrl (or the Windows key).
  static let partner = ["ControlRight": "MetaRight", "MetaRight": "ControlRight", "ControlLeft": "MetaLeft", "MetaLeft": "ControlLeft"]

  /// `moveWin {key}`: "ControlRight" … "MetaLeft", "" = off.
  func setKey(_ name: String) {
    if name == keyName { return }
    keyName = name
    keys = [name, WindowGrab.partner[name] ?? ""].compactMap { n in
      guard let c = WindowGrab.codes[n], let m = KeyCodes.modifiers[n] else { return nil }
      return (c, m.device)
    }
    if keys.isEmpty { win = nil; upPending = false }
    log("move windows: \(keys.isEmpty ? "off" : "hold \(name)")")
  }

  // Held, by the click's own flags (they carry each side's bit; a key TwinDesk injected is only
  // there: macOS's key state never sees it), else by the keyboard's state.
  private func held(_ flags: UInt64) -> Bool {
    for k in keys where flags & k.device != 0 || CGEventSource.keyState(.combinedSessionState, key: k.code) { return true }
    return false
  }

  private func why(_ text: String) -> Bool {
    if text != lastWhy { lastWhy = text; log("move windows: \(text)") }
    return false
  }

  /// The left button went down at p (global points, top-left origin) with these flags. True: a
  /// window was grabbed and the click must not go on.
  func tryGrab(at p: CGPoint, flags: UInt64) -> Bool {
    guard !keys.isEmpty, win == nil, held(flags) else { return false }
    let me = Int(getpid())
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    for w in list { // front to back: the first app window under the pointer
      guard (w[kCGWindowLayer as String] as? Int) == 0, let pid = w[kCGWindowOwnerPID as String] as? Int,
            let b = w[kCGWindowBounds as String] as? [String: Double] else { continue }
      let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
      guard r.contains(p) else { continue }
      let owner = w[kCGWindowOwnerName as String] as? String ?? ""
      if pid == me || owner == "Dock" || owner == "Window Server" { return why("not a window to move (\(owner))") }
      guard let ax = Apps.axWindow(pid: pid, frame: r) else { return why("no Accessibility window for \(owner) (is Accessibility on?)") }
      win = ax
      wid = w[kCGWindowNumber as String] as? Int ?? 0
      self.pid = pid
      off = CGPoint(x: p.x - r.minX, y: p.y - r.minY)
      upPending = true
      lastWhy = ""
      AXUIElementPerformAction(ax, kAXRaiseAction as CFString)
      NSRunningApplication(processIdentifier: pid_t(pid))?.activate()
      log("move windows: grabbed \(owner)'s window \(wid)")
      return true
    }
    return why("no window under the pointer")
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

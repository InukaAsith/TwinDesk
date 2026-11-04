// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Mac apps on the PC: list apps with icons, launch, watch the windows
// of launched apps, move them onto the shared display, raise / close one (Accessibility API).
import Cocoa

enum Apps {
  private static var iconCache: [String: String] = [:]
  /// Never offered: assistants and system agents that aren't normal windowed apps.
  private static let hidden: Set<String> = ["com.apple.Siri", "com.apple.siri.launcher", "com.apple.SiriNCService"]

  private static func offerable(_ b: Bundle, id: String) -> Bool {
    if hidden.contains(id) { return false }
    let info = b.infoDictionary ?? [:]
    func flag(_ k: String) -> Bool { (info[k] as? Bool) ?? ((info[k] as? String) == "1") || ((info[k] as? NSNumber)?.boolValue ?? false) }
    return !flag("LSUIElement") && !flag("LSBackgroundOnly") // menu-bar extras and background agents
  }

  static func list() -> [[String: Any]] {
    var byId: [String: (name: String, url: URL)] = [:]
    let fm = FileManager.default
    let roots = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
                 NSHomeDirectory() + "/Applications"]
    for root in roots {
      for name in (try? fm.contentsOfDirectory(atPath: root)) ?? [] where name.hasSuffix(".app") {
        let url = URL(fileURLWithPath: root).appendingPathComponent(name)
        guard let b = Bundle(url: url), let id = b.bundleIdentifier, byId[id] == nil, offerable(b, id: id) else { continue }
        let display = (b.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
          ?? (b.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? String(name.dropLast(4))
        byId[id] = (display, url)
      }
    }
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
      if let id = app.bundleIdentifier, let url = app.bundleURL, byId[id] == nil, !hidden.contains(id) {
        byId[id] = (app.localizedName ?? id, url)
      }
    }
    return byId.map { id, v in ["id": id, "name": v.name, "icon": icon(v.url)] }
      .sorted { ($0["name"] as! String).localizedCaseInsensitiveCompare($1["name"] as! String) == .orderedAscending }
  }

  /// 64 px PNG as a data: URL.
  static func icon(_ url: URL) -> String {
    if let c = iconCache[url.path] { return c }
    let img = NSWorkspace.shared.icon(forFile: url.path)
    let size = NSSize(width: 64, height: 64)
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64, bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0) else { return "" }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    img.draw(in: NSRect(origin: .zero, size: size))
    NSGraphicsContext.restoreGraphicsState()
    let s = rep.representation(using: .png, properties: [:]).map { "data:image/png;base64," + $0.base64EncodedString() } ?? ""
    iconCache[url.path] = s
    return s
  }

  static func launch(id: String, done: @escaping (Result<Int, HelperError>) -> Void) {
    if let running = NSRunningApplication.runningApplications(withBundleIdentifier: id).first {
      running.activate()
      return done(.success(Int(running.processIdentifier)))
    }
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else {
      return done(.failure(HelperError(message: "not installed")))
    }
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = true
    NSWorkspace.shared.openApplication(at: url, configuration: cfg) { app, err in
      DispatchQueue.main.async {
        if let app = app { done(.success(Int(app.processIdentifier))) }
        else { done(.failure(HelperError(message: err?.localizedDescription ?? "launch failed"))) }
      }
    }
  }

  /// Normal on-screen windows of these processes, front to back, global CG coordinates.
  /// popups: also the app's menus and pop-ups (layers above normal windows), marked
  /// `popup`, front to back as the window server lists them.
  static func windows(pids: Set<Int>, popups: Bool = false) -> [[String: Any]] {
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    return list.compactMap { w in
      let layer = w[kCGWindowLayer as String] as? Int ?? -1
      guard let pid = w[kCGWindowOwnerPID as String] as? Int, pids.contains(pid),
            layer == 0 || (popups && layer > 0 && layer <= 101),
            let b = w[kCGWindowBounds as String] as? [String: Double],
            (b["Width"] ?? 0) > (layer == 0 ? 40 : 8), (b["Height"] ?? 0) > (layer == 0 ? 40 : 8) else { return nil }
      var out: [String: Any] = ["wid": w[kCGWindowNumber as String] as? Int ?? 0, "pid": pid, "title": w[kCGWindowName as String] as? String ?? "",
                                "x": b["X"] ?? 0, "y": b["Y"] ?? 0, "w": b["Width"] ?? 0, "h": b["Height"] ?? 0]
      if layer > 0 { out["popup"] = true }
      return out
    }
  }

  /// Resize a window (points), keeping its top-left.
  static func resize(wid: Int, w: Double, h: Double) -> Bool {
    guard let (win, _) = ax(for: wid) else { return false }
    var s = CGSize(width: w, height: h)
    guard let v = AXValueCreate(.cgSize, &s) else { return false }
    return AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, v) == .success
  }

  private static func axWindows(_ pid: Int) -> [AXUIElement] {
    let app = AXUIElementCreateApplication(pid_t(pid))
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &v) == .success, let ws = v as? [AXUIElement] else { return [] }
    return ws
  }

  private static func frame(_ w: AXUIElement) -> CGRect? {
    var pv: CFTypeRef?, sv: CFTypeRef?
    guard AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &pv) == .success,
          AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &sv) == .success else { return nil }
    var p = CGPoint.zero, s = CGSize.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &p)
    AXValueGetValue(sv as! AXValue, .cgSize, &s)
    return CGRect(origin: p, size: s)
  }

  /// The AX window matching a CG window (by pid + frame).
  private static func ax(for wid: Int) -> (AXUIElement, Int)? {
    guard let cg = windows(pids: Set(NSWorkspace.shared.runningApplications.map { Int($0.processIdentifier) }))
      .first(where: { ($0["wid"] as? Int) == wid }), let pid = cg["pid"] as? Int else { return nil }
    let r = CGRect(x: cg["x"] as! Double, y: cg["y"] as! Double, width: cg["w"] as! Double, height: cg["h"] as! Double)
    for w in axWindows(pid) {
      if let f = frame(w), abs(f.minX - r.minX) < 2, abs(f.minY - r.minY) < 2, abs(f.width - r.width) < 2 { return (w, pid) }
    }
    return nil
  }

  /// The AX window of `pid` with this frame (a CG window's bounds), for WindowGrab.
  static func axWindow(pid: Int, frame r: CGRect) -> AXUIElement? {
    for w in axWindows(pid) {
      if let f = frame(w), abs(f.minX - r.minX) < 2, abs(f.minY - r.minY) < 2, abs(f.width - r.width) < 2 { return w }
    }
    return nil
  }

  /// One window's top-left to x, y (points), raised: a moved window back (shared/movewin.js).
  static func place(wid: Int, x: Double, y: Double) -> Bool {
    guard let (w, pid) = ax(for: wid) else { return false }
    var p = CGPoint(x: x, y: y)
    guard let v = AXValueCreate(.cgPoint, &p) else { return false }
    let ok = AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, v) == .success
    AXUIElementPerformAction(w, kAXRaiseAction as CFString)
    NSRunningApplication(processIdentifier: pid_t(pid))?.activate()
    return ok
  }

  /// Move every window of `pid` that isn't on `bounds` onto it (cascaded from its top-left).
  static func moveOnto(pid: Int, bounds: CGRect) {
    var i = 0
    for w in axWindows(pid) {
      guard let f = frame(w), !bounds.intersects(f) else { continue }
      var p = CGPoint(x: bounds.minX + 40 + CGFloat(i * 30), y: bounds.minY + 60 + CGFloat(i * 30))
      if let v = AXValueCreate(.cgPoint, &p) { AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, v) }
      if f.width > bounds.width - 80 || f.height > bounds.height - 100 {
        var s = CGSize(width: min(f.width, bounds.width - 80), height: min(f.height, bounds.height - 100))
        if let v = AXValueCreate(.cgSize, &s) { AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, v) }
      }
      i += 1
    }
  }

  static func focus(wid: Int) -> Bool {
    guard let (w, pid) = ax(for: wid) else { return false }
    AXUIElementPerformAction(w, kAXRaiseAction as CFString)
    NSRunningApplication(processIdentifier: pid_t(pid))?.activate()
    return true
  }

  static func close(wid: Int) -> Bool {
    guard let (w, _) = ax(for: wid) else { return false }
    var b: CFTypeRef?
    guard AXUIElementCopyAttributeValue(w, kAXCloseButtonAttribute as CFString, &b) == .success, let btn = b else { return false }
    return AXUIElementPerformAction(btn as! AXUIElement, kAXPressAction as CFString) == .success
  }
}

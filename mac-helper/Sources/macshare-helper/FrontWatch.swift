// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// ReZume's look at the app in front (mac/activity.js, an osascript a look) only when something there
// changed: another app in front (NSWorkspace), another window in front, or the front window's title
// (a browser's tab, a document) (Accessibility). shared/rezume.js looks on each, at most every 1.5 s,
// and every 15 s anyway.
//
// Command: frontWatch {on} -> {ax} (ax false: no Accessibility, only app switches are told: main
// keeps polling then). Events: {"event":"front"}, at most one every 300 ms.
import AppKit
import ApplicationServices

final class FrontWatch {
  static let shared = FrontWatch()

  private var on = false
  private var appObserver: NSObjectProtocol?
  private var ax: AXObserver?
  private var axPid: pid_t = 0
  private var app: AXUIElement?
  private var window: AXUIElement?
  private var pending = false

  // Main thread.
  func set(on: Bool) -> Bool {
    if on == self.on { return AXIsProcessTrusted() }
    self.on = on
    if !on {
      if let o = appObserver { NSWorkspace.shared.notificationCenter.removeObserver(o) }
      appObserver = nil
      detach()
      return AXIsProcessTrusted()
    }
    appObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.attach()
      self?.changed()
    }
    attach()
    return AXIsProcessTrusted()
  }

  private func changed() {
    if pending { return }
    pending = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
      guard let self = self else { return }
      self.pending = false
      if self.on { emit(["event": "front"]) }
    }
  }

  private func detach() {
    if let o = ax {
      CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode)
    }
    ax = nil
    axPid = 0
    app = nil
    window = nil
  }

  // Accessibility notifications from the app in front: its focused window changing, and that
  // window's title.
  private func attach() {
    guard AXIsProcessTrusted(), let front = NSWorkspace.shared.frontmostApplication else { return detach() }
    let pid = front.processIdentifier
    if pid == axPid, ax != nil { return watchWindow() }
    detach()
    var obs: AXObserver?
    let cb: AXObserverCallback = { _, _, note, refcon in
      guard let refcon = refcon else { return }
      let me = Unmanaged<FrontWatch>.fromOpaque(refcon).takeUnretainedValue()
      if (note as String) == kAXFocusedWindowChangedNotification || (note as String) == kAXMainWindowChangedNotification {
        me.watchWindow()
      }
      me.changed()
    }
    guard AXObserverCreate(pid, cb, &obs) == .success, let o = obs else { return }
    let el = AXUIElementCreateApplication(pid)
    let me = Unmanaged.passUnretained(self).toOpaque()
    AXObserverAddNotification(o, el, kAXFocusedWindowChangedNotification as CFString, me)
    AXObserverAddNotification(o, el, kAXMainWindowChangedNotification as CFString, me)
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode)
    ax = o
    axPid = pid
    app = el
    watchWindow()
  }

  private func watchWindow() {
    guard let o = ax, let el = app else { return }
    if let w = window { AXObserverRemoveNotification(o, w, kAXTitleChangedNotification as CFString) }
    window = nil
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXFocusedWindowAttribute as CFString, &v) == .success, let w = v else { return }
    let win = w as! AXUIElement
    if AXObserverAddNotification(o, win, kAXTitleChangedNotification as CFString, Unmanaged.passUnretained(self).toOpaque()) == .success {
      window = win
    }
  }
}

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Is a phone with USB debugging on the cable? IOKit says when one is plugged in or out, so main
// (shared/usbadb.js) needn't ask ioreg every couple of seconds: an adb USB interface is class 0xff,
// subclass 0x42, protocol 1, the same three numbers usbadb.js looks for.
//
// Command: usbWatch -> {present}; then events {"event":"usbAdb","present":Bool} when that changes.
import Foundation
import IOKit
import IOKit.usb

final class UsbWatch {
  static let shared = UsbWatch()

  private var port: IONotificationPortRef?
  private var added: io_iterator_t = 0
  private var removed: io_iterator_t = 0
  private var count = 0
  private(set) var present = false

  private func matching() -> CFDictionary {
    let d = IOServiceMatching("IOUSBHostInterface") as NSMutableDictionary
    d["bInterfaceClass"] = 255
    d["bInterfaceSubClass"] = 66
    d["bInterfaceProtocol"] = 1
    return d
  }

  // Main thread (the notifications come on its run loop). Returns whether one is plugged in now.
  func start() -> Bool {
    if port != nil { return present }
    guard let p = IONotificationPortCreate(kIOMainPortDefault) else { return false }
    port = p
    CFRunLoopAddSource(CFRunLoopGetMain(), IONotificationPortGetRunLoopSource(p).takeUnretainedValue(), .defaultMode)
    let me = Unmanaged.passUnretained(self).toOpaque()
    let onAdd: IOServiceMatchingCallback = { ctx, it in
      guard let ctx = ctx else { return }
      Unmanaged<UsbWatch>.fromOpaque(ctx).takeUnretainedValue().drain(it, by: 1)
    }
    let onRemove: IOServiceMatchingCallback = { ctx, it in
      guard let ctx = ctx else { return }
      Unmanaged<UsbWatch>.fromOpaque(ctx).takeUnretainedValue().drain(it, by: -1)
    }
    IOServiceAddMatchingNotification(p, kIOFirstMatchNotification, matching(), onAdd, me, &added)
    IOServiceAddMatchingNotification(p, kIOTerminatedNotification, matching(), onRemove, me, &removed)
    // Draining arms them, and counts what is plugged in already.
    drain(added, by: 1, quiet: true)
    drain(removed, by: -1, quiet: true)
    return present
  }

  private func drain(_ it: io_iterator_t, by delta: Int, quiet: Bool = false) {
    var obj = IOIteratorNext(it)
    while obj != 0 {
      count = max(0, count + delta)
      IOObjectRelease(obj)
      obj = IOIteratorNext(it)
    }
    let now = count > 0
    if now == present { return }
    present = now
    if !quiet { emit(["event": "usbAdb", "present": now]) }
  }
}

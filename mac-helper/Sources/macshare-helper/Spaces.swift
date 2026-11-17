// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Read which macOS desktop (Space) each display is on. SkyLight here is read-only:
// CGSMainConnectionID and CGSCopyManagedDisplaySpaces. Do not dlsym
// CGSManagedDisplaySetCurrentSpace or any other SkyLight write. On macOS 27 that setter
// changes the current-space id without replacing the visible desktop, and the destination's
// windows stay onscreen after the id is put back. This file never posts a key or a swipe.
//
// A switch, when the snapshot allows one, is Mission Control AXPress (SpacesOverview.swift),
// not this file. After the press, currents() is the postcheck: the destination desktop
// is current, and every other display is still on the desktop this snapshot named.
// look() also reports composed. That is a read of which spaces the on-screen windows
// belong to. It is false while a window from another desktop is still visible, and a
// switch is refused before Mission Control opens. This file does not move one.
//
// When "Displays have separate Spaces" is off, or a desktop id appears on more than one
// display, or a display cannot be tied to a CGDirectDisplayID, destination refuses. Nothing
// here falls back to Control-arrow, which would follow keyboard focus.
import Cocoa
import Darwin

enum MacSpaces {
  private typealias Connect = @convention(c) () -> Int32
  private typealias CopySpaces = @convention(c) (Int32) -> Unmanaged<CFArray>?
  private typealias CopyWindowSpaces = @convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?

  private struct Desk {
    var uuid: String
    var cgId: UInt32?
    var current: String
    var spaces: [String]
  }

  private static let api: (Connect, CopySpaces)? = {
    let path = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
    guard let handle = dlopen(path, RTLD_LAZY) else { return nil }
    func sym<T>(_ name: String) -> T? {
      guard let p = dlsym(handle, name) else { return nil }
      return unsafeBitCast(p, to: T.self)
    }
    guard let connect: Connect = sym("CGSMainConnectionID"),
          let copy: CopySpaces = sym("CGSCopyManagedDisplaySpaces") else { return nil }
    return (connect, copy)
  }()

  /// Read of the spaces an on-screen window belongs to. Nil when the symbol is missing.
  /// Not a space setter, and not called with any other selector.
  private static let windowSpaces: CopyWindowSpaces? = {
    let path = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
    guard let handle = dlopen(path, RTLD_LAZY),
          let pointer = dlsym(handle, "SLSCopySpacesForWindows") else { return nil }
    return unsafeBitCast(pointer, to: CopyWindowSpaces.self)
  }()

  /// Read-only. `error` is set when the symbols are missing; otherwise `spans`, `separate`,
  /// `composed`, `displays`. `composed` is false when an on-screen window belongs to none
  /// of the desktops that are current, or when that read itself fails.
  static func look() -> [String: Any] {
    guard let desks = snapshot() else { return ["error": "unavailable"] }
    let spans = spansDisplays()
    var owner: [String: String] = [:]
    var shared = false
    for desk in desks {
      for id in desk.spaces {
        if let prev = owner[id], prev != desk.uuid { shared = true }
        else { owner[id] = desk.uuid }
      }
    }
    let separate = !spans && !shared && !desks.isEmpty && desks.allSatisfy { $0.cgId != nil }
    return [
      "spans": spans,
      "separate": separate,
      "composed": composed(desks),
      "displays": desks.map { desk -> [String: Any] in
        var row: [String: Any] = ["uuid": desk.uuid, "current": desk.current, "spaces": desk.spaces]
        if let cgId = desk.cgId { row["cgId"] = cgId }
        return row
      },
    ]
  }

  /// nil when `spaces[index]` on that display is `spaceId` and a press of that index cannot
  /// take another display with it. `composed` means an on-screen window still belongs to
  /// another desktop. Any other answer is a why, and the caller must not open Mission Control.
  /// This does not change the desktop.
  static func destination(displayId: UInt32, spaceId: UInt64, index: Int, count: Int) -> String? {
    guard displayId != 0, spaceId != 0, index >= 0, count > index, api != nil else { return "unavailable" }
    guard let desks = snapshot() else { return "unavailable" }
    let space = String(spaceId)
    guard let mine = desks.first(where: { $0.cgId == displayId }) else { return "display" }
    guard mine.spaces.count == count, index < mine.spaces.count, mine.spaces[index] == space else { return "unavailable" }
    let others = desks.contains { $0.uuid != mine.uuid }
    var owner: [String: String] = [:]
    var shared = false
    for desk in desks {
      for id in desk.spaces {
        if let prev = owner[id], prev != desk.uuid { shared = true }
        else { owner[id] = desk.uuid }
      }
    }
    if !composed(desks) { return "composed" }
    if others && (spansDisplays() || shared || owner[space] != mine.uuid) { return "spans" }
    if others && desks.contains(where: { $0.cgId == nil }) { return "unavailable" }
    return nil
  }

  /// False when any on-screen window is assigned only to a desktop that is not current,
  /// or when the window-space read fails. Does not move a window or a desktop.
  private static func composed(_ desks: [Desk]) -> Bool {
    var current: [UInt64] = []
    for desk in desks {
      guard desk.cgId != nil, let id = UInt64(desk.current), id != 0 else { return false }
      current.append(id)
    }
    return SpaceComposition.clean(current: current, windows: onScreenWindowSpaces())
  }

  /// One space list per on-screen normal window. Nil when any window cannot be read.
  private static func onScreenWindowSpaces() -> [[UInt64]]? {
    guard let copy = windowSpaces, let api else { return nil }
    let cid = api.0()
    guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    var out: [[UInt64]] = []
    for row in info {
      let layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
      guard layer == 0 else { continue }
      guard let wid = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value, wid != 0 else { continue }
      let list = [NSNumber(value: wid)] as CFArray
      guard let raw = copy(cid, 0x7, list)?.takeRetainedValue() as? [AnyObject] else { return nil }
      var ids: [UInt64] = []
      for value in raw {
        guard let number = value as? NSNumber else { return nil }
        let id = number.uint64Value
        if id == 0 { return nil }
        if !ids.contains(id) { ids.append(id) }
      }
      out.append(ids)
    }
    return out
  }

  /// One row per display that has a CGDirectDisplayID. Nil when the managed-space
  /// read itself fails. A row whose current desktop cannot be read has current nil.
  static func currents() -> [DisplayCurrent]? {
    guard let desks = snapshot() else { return nil }
    var rows: [DisplayCurrent] = []
    for desk in desks {
      guard let cgId = desk.cgId, cgId != 0 else { continue }
      let current = UInt64(desk.current)
      rows.append(DisplayCurrent(displayId: cgId, current: current == 0 ? nil : current))
    }
    return rows
  }

  private static func spansDisplays() -> Bool {
    let value = CFPreferencesCopyAppValue("spans-displays" as CFString, "com.apple.spaces" as CFString)
    if let n = value as? NSNumber { return n.boolValue }
    return false
  }

  private static func snapshot() -> [Desk]? {
    guard let api = api else { return nil }
    guard let unmanaged = api.1(api.0()) else { return nil }
    let raw = unmanaged.takeRetainedValue() as [AnyObject]
    let byUUID = displayUUIDs()
    var desks: [Desk] = []
    for item in raw {
      guard let row = item as? [String: Any],
            let uuid = row["Display Identifier"] as? String, !uuid.isEmpty,
            let spaces = row["Spaces"] as? [Any] else { continue }
      var ids: [String] = []
      for entry in spaces {
        guard let space = entry as? [String: Any], let id = spaceId(space["id64"]), !ids.contains(id) else { continue }
        ids.append(id)
      }
      guard !ids.isEmpty else { continue }
      let current = spaceId((row["Current Space"] as? [String: Any])?["id64"]) ?? ""
      desks.append(Desk(uuid: uuid, cgId: byUUID[uuid.uppercased()], current: ids.contains(current) ? current : "", spaces: ids))
    }
    return desks
  }

  private static func spaceId(_ value: Any?) -> String? {
    guard let n = value as? NSNumber else { return nil }
    let id = n.uint64Value
    if id == 0 { return nil }
    return String(id)
  }

  private static func displayUUIDs() -> [String: UInt32] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [:] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [:] }
    var out: [String: UInt32] = [:]
    for id in ids.prefix(Int(count)) where id != 0 {
      guard let unmanaged = CGDisplayCreateUUIDFromDisplayID(id) else { continue }
      let text = CFUUIDCreateString(kCFAllocatorDefault, unmanaged.takeRetainedValue()) as String
      out[text.uppercased()] = id
    }
    return out
  }
}

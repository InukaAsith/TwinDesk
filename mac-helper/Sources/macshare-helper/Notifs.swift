// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Other apps' notifications. macOS has no API for them, so we read the Notification
// Center database (SQLite, read-only) once a second for records newer than the last one seen.
// Needs Full Disk Access for the responsible app (TwinDesk). Emits `notif` and `notifState`.
import Cocoa
import SQLite3

final class NotifWatch {
  static let shared = NotifWatch()
  private var db: OpaquePointer?
  private var timer: Timer?
  private var last: Int64 = -1
  private var names: [String: String] = [:]
  private let own: Set<String> = ["org.macshare.mac", "org.macshare.mesh", "com.github.Electron"]

  private var dbPath: String {
    NSHomeDirectory() + "/Library/Group Containers/group.com.apple.usernoted/db2/db"
  }

  func set(on: Bool) {
    timer?.invalidate()
    timer = nil
    if db != nil { sqlite3_close(db); db = nil }
    last = -1
    guard on else { return }
    tick()
    timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in self?.tick() }
  }

  /// Can we read the database (Full Disk Access)?
  func readable() -> Bool {
    var probe: OpaquePointer?
    defer { if probe != nil { sqlite3_close(probe) } }
    guard sqlite3_open_v2(dbPath, &probe, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { return false }
    return sqlite3_exec(probe, "SELECT 1 FROM record LIMIT 1", nil, nil, nil) == SQLITE_OK
  }

  private func open() -> Bool {
    if db != nil { return true }
    guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
      if db != nil { sqlite3_close(db); db = nil }
      return false
    }
    sqlite3_busy_timeout(db, 200)
    return true
  }

  private var lastState = ""
  private func state(_ s: String) {
    if s == lastState { return }
    lastState = s
    emit(["event": "notifState", "state": s]) // "ok" | "noAccess"
  }

  private func tick() {
    guard open() else { return state("noAccess") }
    if last < 0 { // start after what is already there
      var st: OpaquePointer?
      guard sqlite3_prepare_v2(db, "SELECT IFNULL(MAX(rec_id), 0) FROM record", -1, &st, nil) == SQLITE_OK else {
        sqlite3_close(db); db = nil
        return state("noAccess")
      }
      if sqlite3_step(st) == SQLITE_ROW { last = sqlite3_column_int64(st, 0) }
      sqlite3_finalize(st)
      return state("ok")
    }
    var st: OpaquePointer?
    let q = "SELECT r.rec_id, a.identifier, r.data FROM record r JOIN app a ON a.app_id = r.app_id WHERE r.rec_id > ? ORDER BY r.rec_id LIMIT 50"
    guard sqlite3_prepare_v2(db, q, -1, &st, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(st) }
    sqlite3_bind_int64(st, 1, last)
    while sqlite3_step(st) == SQLITE_ROW {
      last = sqlite3_column_int64(st, 0)
      let app = sqlite3_column_text(st, 1).map { String(cString: $0) } ?? ""
      guard !own.contains(app), let blob = sqlite3_column_blob(st, 2) else { continue }
      let data = Data(bytes: blob, count: Int(sqlite3_column_bytes(st, 2)))
      guard let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
            let req = plist["req"] as? [String: Any] else { continue }
      let title = (req["titl"] as? String) ?? ""
      let subtitle = (req["subt"] as? String) ?? ""
      let body = (req["body"] as? String) ?? ""
      if title.isEmpty && body.isEmpty { continue }
      let date = (plist["date"] as? Double).map { ($0 + 978307200) * 1000 } ?? Date().timeIntervalSince1970 * 1000
      emit(["event": "notif", "id": String(last), "app": app, "appName": name(of: app),
            "title": cut(title), "subtitle": cut(subtitle), "body": cut(body), "at": date, "icon": icon(of: app)])
    }
    state("ok")
  }

  private func cut(_ s: String) -> String { s.count > 500 ? String(s.prefix(500)) : s }

  /// The app's icon (64 px PNG data: URL, cached by Apps.icon), or "".
  private func icon(of bundle: String) -> String {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { return "" }
    return Apps.icon(url)
  }

  private func name(of bundle: String) -> String {
    if let n = names[bundle] { return n }
    var n = bundle
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) {
      n = FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
    }
    names[bundle] = n
    return n
  }
}

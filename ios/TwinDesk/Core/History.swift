// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// History: what was copied (both ways) and the computer's notifications shown here, for this
// session — and, with Keep history on (off at first), kept across restarts for a day, a week, 30
// days or a year, encrypted (AES-GCM) with a key in this device's Keychain, made when it's turned
// on (iOS never asks about an app's own Keychain items). Read only when a history is first looked
// at. Each has its own view (HistoryView.swift), from its page or an Overview shortcut; the pages
// keep their Recent lists. As the computers' History (shared/histkeeper.js) and Android's.
import CryptoKit
import Foundation
import Security

final class History {
    struct Entry: Codable, Identifiable {
        var at: Double; var text: String; var dir = ""; var app = ""; var title = ""; var nid = ""
        var id: String { "\(at):\(nid):\(text.prefix(40))" }
    }
    static let days = [1, 7, 30, 365]
    private static let max = 1000
    private static let account = "twindesk.history"
    private unowned let core: Core
    private var clipList: [Entry] = []
    private var notifList: [Entry] = []
    private var loaded = false
    private(set) var error = ""

    init(_ core: Core) { self.core = core }

    var save: Bool { core.store.flag("history.save", false) }
    var keepDays: Int { Int(core.store.string("history.days", "7")).flatMap { History.days.contains($0) ? $0 : nil } ?? 7 }

    private func file(_ what: String) -> URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("history-\(what).enc")
    }

    func setSave(_ on: Bool) {
        core.store.setFlag("history.save", on)
        if on {
            if key() == nil { error = tr("History can’t be kept: the Keychain didn’t answer"); core.store.setFlag("history.save", false) }
            loaded = true // what's here now is kept from now on
            write()
        } else { forget() }
        core.changed()
    }

    func setDays(_ d: Int) {
        guard History.days.contains(d) else { return }
        core.store.setString("history.days", String(d))
        prune(); write(); core.changed()
    }

    func clip() -> [Entry] { load(); return clipList }
    func notifs() -> [Entry] { load(); return notifList }

    func addClip(_ dir: String, _ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if save { load() }
        clipList.removeAll { $0.text == text && $0.dir == dir }
        clipList.insert(Entry(at: Date().timeIntervalSince1970, text: String(text.prefix(20000)), dir: dir), at: 0)
        if clipList.count > History.max { clipList.removeLast(clipList.count - History.max) }
        write()
    }

    func addNotif(id: String, app: String, title: String, body: String) {
        if save { load() }
        if !id.isEmpty { notifList.removeAll { $0.nid == id } }
        notifList.insert(Entry(at: Date().timeIntervalSince1970, text: String(body.prefix(2000)), app: app, title: title, nid: id), at: 0)
        if notifList.count > History.max { notifList.removeLast(notifList.count - History.max) }
        write()
    }

    func clear(_ what: String) {
        if what == "clip" { clipList = []; core.clip.clearHistory() } else { notifList = [] }
        try? FileManager.default.removeItem(at: file(what))
        core.changed()
    }

    // The kept ones back, once a session.
    private func load() {
        if loaded { return }
        loaded = true
        guard save, let k = key() else { return }
        for what in ["clip", "notifs"] {
            guard let data = try? Data(contentsOf: file(what)) else { continue }
            do {
                let plain = try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: k)
                let kept = try JSONDecoder().decode([Entry].self, from: plain)
                var list = what == "clip" ? clipList : notifList
                var seen = Set(list.map(\.id))
                list += kept.filter { seen.insert($0.id).inserted }
                list.sort { $0.at > $1.at }
                if what == "clip" { clipList = list } else { notifList = list }
            } catch { self.error = tr("The saved history couldn’t be opened") }
        }
        prune()
    }

    private func prune() {
        let since = Date().timeIntervalSince1970 - Double(keepDays) * 86400
        clipList.removeAll { $0.at < since }
        notifList.removeAll { $0.at < since }
    }

    private func write() {
        guard save, let k = key() else { return }
        prune()
        for (what, list) in [("clip", clipList), ("notifs", notifList)] {
            guard let plain = try? JSONEncoder().encode(list), let box = try? AES.GCM.seal(plain, using: k), let data = box.combined else { continue }
            try? data.write(to: file(what), options: [.atomic, .completeFileProtection])
        }
    }

    // Off: the saved history and its key go (this session's lists stay until TwinDesk quits).
    private func forget() {
        for what in ["clip", "notifs"] { try? FileManager.default.removeItem(at: file(what)) }
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: History.account] as CFDictionary)
    }

    // The key: 256 bits in the Keychain, this device only.
    private var cached: SymmetricKey?
    private func key() -> SymmetricKey? {
        if let c = cached { return c }
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: History.account, kSecReturnData as String: true]
        var out: CFTypeRef?
        if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data {
            cached = SymmetricKey(data: d)
            return cached
        }
        let k = SymmetricKey(size: .bits256)
        let raw = k.withUnsafeBytes { Data($0) }
        let add: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: History.account, kSecValueData as String: raw,
                                  kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { return nil }
        cached = k
        return k
    }
}

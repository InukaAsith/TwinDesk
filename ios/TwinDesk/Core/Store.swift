// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What the iPhone remembers: its identity, the computers it paired with (hosts) and its settings.
// Hosts (with their tokens) live in the Keychain; switches in UserDefaults.
import Foundation
import Security
#if canImport(UIKit)
import UIKit
#endif

// A paired computer this phone connects to (it hosts the session).
struct Computer: Codable, Identifiable, Equatable {
    let id: String
    var name: String
    let os: String
    var address: String
    var port: UInt16
    let fp: String
    let token: String
    var lastSeen: Double
}

final class Store {
    static let shared = Store()
    private let d = UserDefaults.standard
    private let lock = NSLock()

    let deviceId: String

    private init() {
        if let id = d.string(forKey: "deviceId"), Proto.isHex(id, min: 32, max: 32) {
            deviceId = id
        } else {
            deviceId = Proto.randomHex(16)
            d.set(deviceId, forKey: "deviceId")
        }
    }

    // iOS 16 and later tell apps only "iPhone" without a special entitlement, so the person names it
    // once (Settings › Name). Until then: "iPhone" or "iPad".
    var deviceName: String {
        get {
            if let n = d.string(forKey: "deviceName"), !n.trimmingCharacters(in: .whitespaces).isEmpty { return n }
            #if canImport(UIKit)
            return UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
            #else
            return "iPhone"
            #endif
        }
        set { d.set(String(newValue.trimmingCharacters(in: .whitespaces).prefix(64)), forKey: "deviceName") }
    }

    var model: String {
        var u = utsname()
        uname(&u)
        return withUnsafeBytes(of: &u.machine) { p in String(cString: p.bindMemory(to: CChar.self).baseAddress!) }
    }

    // ---- hosts (Keychain) ----

    private let service = "com.twindesk.ios.hosts"

    // list: "hosts" (computers), or "peerHosts" (phones, Peer.swift), kept apart.
    func hosts(_ list: String = "hosts") -> [Computer] {
        lock.lock(); defer { lock.unlock() }
        return readHosts(list)
    }

    private func readHosts(_ list: String = "hosts") -> [Computer] {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: list, kSecReturnData as String: true]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return [] }
        return (try? JSONDecoder().decode([Computer].self, from: data)) ?? []
    }

    private func writeHosts(_ list: [Computer], _ account: String = "hosts") {
        guard let data = try? JSONEncoder().encode(list) else { return }
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account]
        // After first unlock: the app reconnects in the background while the phone is locked.
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        if SecItemUpdate(q as CFDictionary, attrs as CFDictionary) == errSecItemNotFound {
            var add = q
            for (k, v) in attrs { add[k] = v }
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    func host(_ id: String, _ list: String = "hosts") -> Computer? { hosts(list).first { $0.id == id } }

    func putHost(_ h: Computer, _ list: String = "hosts") {
        lock.lock(); defer { lock.unlock() }
        writeHosts([h] + readHosts(list).filter { $0.id != h.id }, list)
    }

    func forgetHost(_ id: String, _ list: String = "hosts") {
        lock.lock(); defer { lock.unlock() }
        writeHosts(readHosts(list).filter { $0.id != id }, list)
        d.removeObject(forKey: "sync.\(id)")
    }

    // ---- settings ----

    func flag(_ key: String, _ def: Bool) -> Bool { d.object(forKey: key) == nil ? def : d.bool(forKey: key) }
    func setFlag(_ key: String, _ on: Bool) { d.set(on, forKey: key) }
    func string(_ key: String, _ def: String) -> String { d.string(forKey: key) ?? def }
    func setString(_ key: String, _ v: String) { d.set(v, forKey: key) }

    // Two-way switches remembered per pair (pair.sync), as JSON by host id.
    func pairSync(_ hostId: String) -> JSON? { d.dictionary(forKey: "sync.\(hostId)") }
    func setPairSync(_ hostId: String, _ v: JSON) { d.set(v, forKey: "sync.\(hostId)") }

    // The last computer used: reconnected to in the background.
    var lastHostId: String? {
        get { d.string(forKey: "lastHost") }
        set { d.set(newValue, forKey: "lastHost") }
    }
}

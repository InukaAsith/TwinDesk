// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Signing TwinDesk with your own Apple ID, done by a computer (ios-signer/ there). Opt in.
//
// The computer keeps nothing (unless Keep a copy is switched on there). What has to last from one
// refresh to the next is here, in this app's Keychain: the signing state the computer's helper
// hands back (Apple's developer session, good for about a year and for certificates and app IDs
// only; the development certificate's private key; the anisette identity Apple knows this
// "machine" by). The password is typed once to sign in and kept nowhere. Readable only while the
// iPhone is unlocked, never in a backup, never synced to iCloud Keychain or another device
// (WhenUnlockedThisDeviceOnly). Signing out removes it. SignerFeature.swift is the feature on it.
//
// And none of it crosses the computer's app in the clear: for each refresh the computer's signing
// helper makes a key (X25519), this makes one too, and what goes to the helper is sealed for it
// (ChaCha20-Poly1305, the keys from HKDF-SHA256 over the shared secret; salt: the helper's public
// key then this one; one key each way; the nonce counts messages). The session it travels on is
// already TLS, pinned to the paired computer: this is so the app in between, whose console goes
// to a log file, is only a pipe. The helper's main.rs has the other end, word for word.
import CryptoKit
import Foundation
import Security

enum SignerVault {
    private static let service = "com.twindesk.ios.signing"
    private static let stateAccount = "state"

    private static func item(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false]
    }

    private static func read(_ account: String) -> Data? {
        var q = item(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    @discardableResult
    private static func write(_ account: String, _ data: Data) -> Bool {
        let attrs: [String: Any] = [kSecValueData as String: data,
                                    kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(item(account) as CFDictionary, attrs as CFDictionary)
        guard status == errSecItemNotFound else { return status == errSecSuccess }
        var add = item(account)
        for (k, v) in attrs { add[k] = v }
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    private static func remove(_ account: String) { SecItemDelete(item(account) as CFDictionary) }

    // The signing state the computers' helper hands back: Apple's developer session (in place of
    // the password, which is never kept), the certificate's key, the anisette identity.
    static var state: [String: String] {
        guard let data = read(stateAccount) else { return [:] }
        return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }

    static func save(state: [String: String]) {
        guard !state.isEmpty, let data = try? JSONEncoder().encode(state) else { return }
        write(stateAccount, data)
    }

    // Whose it is and until when Apple takes its session (nothing while the iPhone is locked).
    static var facts: (email: String, until: Double, signedIn: Bool) {
        let s = state
        let until = Double(s["xcode_token_expiry"] ?? "") ?? 0
        let ok = !(s["xcode_token"] ?? "").isEmpty && until > Date().timeIntervalSince1970 * 1000
        return (s["email"] ?? "", until, ok)
    }

    // Sign out: the session goes. everything: the certificate's key and the identity too (the next
    // sign-in then asks Apple for a new certificate and for a code again).
    static func signOut(everything: Bool) {
        if everything { remove(stateAccount); return }
        var s = state
        for k in ["xcode_token", "xcode_token_expiry", "xcode_token_duration", "adsid"] { s[k] = nil }
        if s.isEmpty { remove(stateAccount) } else { save(state: s) }
    }

    // What one run needs, for a seal made for that run: the state, and when signing in, the
    // Apple ID and its password as just typed (used once, kept nowhere).
    static func request(for seal: SignerSeal, email: String? = nil, password: String? = nil) -> [String: Any]? {
        var r: [String: Any] = ["state": state]
        if let e = email, let p = password { r["email"] = e; r["password"] = p }
        return seal.first(r)
    }
}

// One refresh's sealed conversation with the computer's signing helper.
final class SignerSeal {
    private let outKey: SymmetricKey // this to the helper
    private let inKey: SymmetricKey // the helper to this
    private var sent: UInt64 = 0
    private var received: UInt64 = 0
    private let publicKey: String

    // helperKey: the "pub" of the helper's {"ev":"key"}.
    init?(helperKey: String) {
        guard let theirs = Data(base64Encoded: helperKey), theirs.count == 32,
              let their = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: theirs) else { return nil }
        let mine = Curve25519.KeyAgreement.PrivateKey()
        guard let shared = try? mine.sharedSecretFromKeyAgreement(with: their) else { return nil }
        let ours = mine.publicKey.rawRepresentation
        let salt = theirs + ours
        func key(_ info: String) -> SymmetricKey {
            shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt, sharedInfo: Data(info.utf8), outputByteCount: 32)
        }
        outKey = key("TwinDesk iOS signing 1: phone to helper")
        inKey = key("TwinDesk iOS signing 1: helper to phone")
        publicKey = ours.base64EncodedString()
    }

    private static func nonce(_ n: UInt64) -> ChaChaPoly.Nonce? {
        var bytes = Data(count: 4)
        withUnsafeBytes(of: n.bigEndian) { bytes.append(contentsOf: $0) }
        return try? ChaChaPoly.Nonce(data: bytes)
    }

    // A message for the helper: the ciphertext and its tag, base64.
    func seal(_ message: [String: Any]) -> String? {
        guard let plain = try? JSONSerialization.data(withJSONObject: message), let n = Self.nonce(sent),
              let box = try? ChaChaPoly.seal(plain, using: outKey, nonce: n) else { return nil }
        sent += 1
        return (box.ciphertext + box.tag).base64EncodedString()
    }

    // The first line for the helper: this run's public key and the sealed request.
    func first(_ request: [String: Any]) -> [String: Any]? {
        guard let box = seal(request) else { return nil }
        return ["pub": publicKey, "box": box]
    }

    // An answer to one of the helper's questions (a code, the certificates to revoke, "abort").
    func answer(_ message: [String: Any]) -> [String: Any]? {
        seal(message).map { ["box": $0] }
    }

    // The "box" of the helper's {"ev":"state"}: the state to keep.
    func open(state box: String) -> [String: String]? {
        guard let data = Data(base64Encoded: box), data.count >= 16, let n = Self.nonce(received) else { return nil }
        received += 1
        guard let sealed = try? ChaChaPoly.SealedBox(nonce: n, ciphertext: data.dropLast(16), tag: data.suffix(16)),
              let plain = try? ChaChaPoly.open(sealed, using: inKey) else { return nil }
        return try? JSONDecoder().decode([String: String].self, from: plain)
    }
}

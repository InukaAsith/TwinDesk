// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This iPhone's own identity for hosting another phone (PeerServer.swift): a P-256 key made once in
// the Keychain and a self-signed certificate for it, which the other phone pins after pairing,
// exactly as it pins a computer's (its fingerprint: SHA-256 of the certificate). iOS has no API that
// makes a certificate, so it's written here (DER, X.509 v3, ecdsa-with-SHA256), signed by the key.
import Foundation
import Security

enum PeerKey {
    private static let tag = Data("com.twindesk.ios.peer.key".utf8)
    private static let certKey = "peer.cert"
    private static var cached: (SecIdentity, Data)?
    private static let lock = NSLock()

    // The identity and its certificate (DER), made the first time.
    static func identity() -> (SecIdentity, Data)? {
        lock.lock(); defer { lock.unlock() }
        if let c = cached { return c }
        if let der = UserDefaults.standard.data(forKey: certKey), let id = find(der) { cached = (id, der); return cached }
        guard let made = make() else { return nil }
        cached = made
        return made
    }

    static var fingerprint: String { identity().map { Proto.sha256($0.1).hex } ?? "" }

    private static func find(_ der: Data) -> SecIdentity? {
        let q: [String: Any] = [kSecClass as String: kSecClassIdentity, kSecReturnRef as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let list = out as? [SecIdentity] else { return nil }
        for id in list {
            var cert: SecCertificate?
            if SecIdentityCopyCertificate(id, &cert) == errSecSuccess, let c = cert, SecCertificateCopyData(c) as Data == der { return id }
        }
        return nil
    }

    private static func make() -> (SecIdentity, Data)? {
        // Whatever was there before (a certificate without its key, a key without one): gone.
        SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag] as CFDictionary)
        if let old = UserDefaults.standard.data(forKey: certKey), let c = SecCertificateCreateWithData(nil, old as CFData) {
            SecItemDelete([kSecClass as String: kSecClassCertificate, kSecValueRef as String: c] as CFDictionary)
        }
        let attrs: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: tag,
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            ],
        ]
        var err: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &err), let pub = SecKeyCopyPublicKey(key),
              let point = SecKeyCopyExternalRepresentation(pub, &err) as Data? else {
            NSLog("TwinDesk: peer key: %@", err?.takeRetainedValue().localizedDescription ?? "failed")
            return nil
        }
        let tbs = tbsCertificate(point)
        guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, tbs as CFData, &err) as Data? else { return nil }
        let der = seq(tbs, algorithm, bits(sig))
        guard let cert = SecCertificateCreateWithData(nil, der as CFData) else { return nil }
        let add: [String: Any] = [kSecClass as String: kSecClassCertificate, kSecValueRef as String: cert,
                                  kSecAttrLabel as String: "TwinDesk peer",
                                  kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let st = SecItemAdd(add as CFDictionary, nil)
        guard st == errSecSuccess || st == errSecDuplicateItem, let id = find(der) else {
            NSLog("TwinDesk: peer certificate: %d", st)
            return nil
        }
        UserDefaults.standard.set(der, forKey: certKey)
        return (id, der)
    }

    // ---- DER ----

    private static func tlv(_ tag: UInt8, _ body: Data) -> Data {
        var d = Data([tag])
        let n = body.count
        if n < 128 { d.append(UInt8(n)) }
        else if n < 256 { d.append(contentsOf: [0x81, UInt8(n)]) }
        else { d.append(contentsOf: [0x82, UInt8(n >> 8), UInt8(n & 255)]) }
        d.append(body)
        return d
    }
    private static func seq(_ parts: Data...) -> Data { tlv(0x30, parts.reduce(Data(), +)) }
    private static func set(_ parts: Data...) -> Data { tlv(0x31, parts.reduce(Data(), +)) }
    private static func oid(_ b: [UInt8]) -> Data { tlv(0x06, Data(b)) }
    private static func bits(_ d: Data) -> Data { tlv(0x03, Data([0]) + d) }
    private static func time(_ d: Date) -> Data {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyMMddHHmmss'Z'"
        return tlv(0x17, Data(f.string(from: d).utf8))
    }

    private static let ecdsaSha256: [UInt8] = [0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02]
    private static var algorithm: Data { seq(oid(ecdsaSha256)) }

    private static func tbsCertificate(_ point: Data) -> Data {
        var serial = [UInt8](repeating: 0, count: 8)
        _ = SecRandomCopyBytes(kSecRandomDefault, 8, &serial)
        serial[0] = (serial[0] & 0x7f) | 0x01 // positive, not zero
        let name = seq(set(seq(oid([0x55, 0x04, 0x03]), tlv(0x0c, Data("TwinDesk".utf8)))))
        let spki = seq(seq(oid([0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01]), oid([0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07])), bits(point))
        let validity = seq(time(Date().addingTimeInterval(-86400)), time(Date(timeIntervalSince1970: 2_524_607_999))) // to 2049-12-31
        return seq(
            tlv(0xa0, tlv(0x02, Data([2]))), // v3
            tlv(0x02, Data(serial)),
            algorithm,
            name,
            validity,
            name,
            spki
        )
    }
}

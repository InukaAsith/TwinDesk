// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The wire protocol from the iPhone's side: the same constants and pairing math as
// shared/protocol.js and android/…/Proto.kt (keep the three in step).
import Foundation
import CryptoKit
#if canImport(UIKit)
import UIKit
#endif

enum Proto {
    static let version = 1
    static let port: UInt16 = 47800
    static let discoveryPort: UInt16 = 47801
    static let beaconInterval: TimeInterval = 2
    static let deviceStale: TimeInterval = 10
    static let pingInterval: TimeInterval = 1
    static let timeout: TimeInterval = 8
    static let phoneGrace: TimeInterval = 30
    static let clipMaxBytes = 256 * 1024
    static let clipImageMaxBytes = 10 * 1024 * 1024
    static let clipImagePartBytes = 256 * 1024
    static let fileChunkBytes = 64 * 1024
    static let fileMaxBytes: Int64 = 16 * 1024 * 1024 * 1024 * 1024
    static let fxPath = "/twindesk/fx/"
    static let fxHeader = "x-twindesk-fx"
    static let maxPayload = 16 * 1024 * 1024
    static let os = "ios"
    private static let sasLabel = "macshare-sas-v1"

    enum T {
        static let beacon = "beacon"
        static let probe = "probe"
        static let invite = "invite"
        static let pairStart = "pair.start"
        static let pairNonce = "pair.nonce"
        static let pairReveal = "pair.reveal"
        static let pairConfirm = "pair.confirm"
        static let pairOk = "pair.ok"
        static let pairCancel = "pair.cancel"
        static let hello = "hello"
        static let welcome = "welcome"
        static let error = "error"
        static let ping = "ping"
        static let pong = "pong"
        static let bye = "bye"
        static let clip = "clip"
        static let clipPolicy = "clip.policy"
        static let clipImage = "clip.image"
        static let clipImagePart = "clip.image.part"
        static let notif = "notif"
        static let notifPolicy = "notif.policy"
        static let fileOffer = "file.offer"
        static let fileAccept = "file.accept"
        static let fileRefuse = "file.refuse"
        static let fileChunk = "file.chunk"
        static let fileEnd = "file.end"
        static let fileDone = "file.done"
        static let fileCancel = "file.cancel"
        static let filePull = "file.pull"
        static let filesDone = "files.done"
        static let fclipOffer = "fclip.offer"
        static let fclipPaste = "fclip.paste"
        static let fclipGone = "fclip.gone"
        static let pairSync = "pair.sync"
        static let phoneInfo = "phone.info"
        static let phoneMicWant = "phone.mic.want"
        static let phoneMic = "phone.mic"
        static let phoneMicState = "phone.mic.state"
        static let pcMedia = "pc.media"
        static let pcMediaWant = "pc.media.want"
        static let pcMediaCtl = "pc.media.ctl"
    }

    enum E {
        static let versionMismatch = "version_mismatch"
        static let badToken = "bad_token"
        static let pairRefused = "pair_refused"
        static let pairTimeout = "pair_timeout"
        static let busy = "busy"
        static let replaced = "replaced"
        static let released = "released"
        static let asleep = "asleep"
    }

    static func randomHex(_ bytes: Int) -> String {
        var b = [UInt8](repeating: 0, count: bytes)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &b)
        return Data(b).hex
    }

    static func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

    // Pairing commit for our nonce: sha256(nonce bytes), hex.
    static func commitOf(_ nonceHex: String) -> String { sha256(Data(hex: nonceHex)).hex }

    // The 6-digit code both sides show:
    // sha256(SAS_LABEL || fp bytes || nw bytes || nm bytes), first 4 bytes as uint32 BE, mod 1e6.
    static func sasCode(fp: String, nw: String, nm: String) -> String {
        var h = SHA256()
        h.update(data: Data(sasLabel.utf8))
        h.update(data: Data(hex: normFingerprint(fp)))
        h.update(data: Data(hex: nw))
        h.update(data: Data(hex: nm))
        let d = Array(h.finalize())
        let n = (UInt32(d[0]) << 24) | (UInt32(d[1]) << 16) | (UInt32(d[2]) << 8) | UInt32(d[3])
        let s = String(n % 1_000_000)
        return String(repeating: "0", count: max(0, 6 - s.count)) + s
    }

    static func normFingerprint(_ fp: String?) -> String { (fp ?? "").replacingOccurrences(of: ":", with: "").lowercased() }

    static func isHex(_ s: String, min: Int, max: Int) -> Bool {
        s.count >= min && s.count <= max && s.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }
}

typealias JSON = [String: Any]

func msg(_ t: String, _ fields: JSON = [:]) -> JSON {
    var o = fields
    o["t"] = t
    return o
}

func encodeJSON(_ o: JSON) -> String? {
    guard let d = try? JSONSerialization.data(withJSONObject: o) else { return nil }
    return String(data: d, encoding: .utf8)
}

func decodeJSON(_ s: String) -> JSON? {
    guard let d = s.data(using: .utf8) else { return nil }
    return (try? JSONSerialization.jsonObject(with: d)) as? JSON
}

extension Dictionary where Key == String, Value == Any {
    func str(_ k: String, max: Int = 500) -> String { String(((self[k] as? String) ?? "").prefix(max)) }
    func int(_ k: String, _ def: Int = 0) -> Int { (self[k] as? NSNumber)?.intValue ?? def }
    func int64(_ k: String, _ def: Int64 = 0) -> Int64 { (self[k] as? NSNumber)?.int64Value ?? def }
    func bool(_ k: String) -> Bool { (self[k] as? NSNumber)?.boolValue ?? false }
    func obj(_ k: String) -> JSON? { self[k] as? JSON }
    func has(_ k: String) -> Bool { self[k] != nil && !(self[k] is NSNull) }
}

extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }

    init(hex: String) {
        let s = hex.count % 2 == 0 ? hex : "0" + hex
        var out = Data(capacity: s.count / 2)
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            out.append(UInt8(s[i..<j], radix: 16) ?? 0)
            i = j
        }
        self = out
    }
}

// "iPhone" or "iPad", for what the app says about this device.
enum Device {
    static let isPad: Bool = {
        #if canImport(UIKit)
        return UIDevice.current.userInterfaceIdiom == .pad
        #else
        return false
        #endif
    }()
    static var word: String { isPad ? "iPad" : "iPhone" }
}

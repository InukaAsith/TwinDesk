// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The sealed conversation, end to end, with the iPhone's own code (ios/TwinDesk/Core/Signer.swift)
// against the helper: test/seal.sh builds and runs this. No Apple ID and no network: the device
// asked for doesn't exist, so the helper opens the request, hands the state back sealed and stops.
import Foundation

let helper = CommandLine.arguments[1]
var failures = 0
func check(_ ok: Bool, _ what: String) {
    print(ok ? "  ok    \(what)" : "  FAIL  \(what)")
    if !ok { failures += 1 }
}

// One run of the helper: `prepare` turns its key into the line to answer with; all it printed after.
func run(_ prepare: (SignerSeal) -> [String: Any]?) -> (seal: SignerSeal?, events: [[String: Any]]) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: helper)
    let stdin = Pipe(), stdout = Pipe()
    p.standardInput = stdin
    p.standardOutput = stdout
    try! p.run()
    var pending = Data()
    func line() -> [String: Any]? {
        while true {
            if let nl = pending.firstIndex(of: 10) {
                let one = pending.subdata(in: pending.startIndex..<nl)
                pending = pending.subdata(in: pending.index(after: nl)..<pending.endIndex)
                return (try? JSONSerialization.jsonObject(with: one)) as? [String: Any]
            }
            let more = stdout.fileHandleForReading.availableData
            if more.isEmpty { return nil }
            pending.append(more)
        }
    }
    func send(_ obj: [String: Any]) {
        stdin.fileHandleForWriting.write(try! JSONSerialization.data(withJSONObject: obj) + Data([10]))
    }
    send(["op": "install", "sealed": true, "udid": "NOT-A-DEVICE"])
    guard let key = line(), key["ev"] as? String == "key", let pub = key["pub"] as? String,
          let seal = SignerSeal(helperKey: pub), let first = prepare(seal) else {
        p.terminate()
        return (nil, [])
    }
    send(first)
    var events: [[String: Any]] = []
    while let e = line() { events.append(e) }
    p.waitUntilExit()
    return (seal, events)
}

let state = ["anisette_url": "https://anisette.example", "0f/key": "a2V5IGJ5dGVz", "anisette_state": "c3RhdGU="]
let secret: [String: Any] = ["email": "tést@example.com", "password": "p\"a\\ss wörd ✓", "state": state]

print("A sealed request")
var r = run { $0.first(secret) }
let boxed = r.events.first { $0["ev"] as? String == "state" }
check(boxed?["state"] == nil, "the state doesn't come back in the clear")
check((boxed?["box"] as? String).flatMap { r.seal?.open(state: $0) } == state, "the state comes back sealed, as it went")
let err = r.events.last
check(err?["ev"] as? String == "error" && (err?["message"] as? String ?? "").contains("isn't connected"),
      "the helper opened the request and got as far as the device")
check(!String(describing: r.events).contains("wörd"), "the password is in nothing the helper printed")

print("A request changed on the way")
r = run {
    guard var first = $0.first(secret), let box = first["box"] as? String, var raw = Data(base64Encoded: box) else { return nil }
    raw[raw.count / 2] ^= 1
    first["box"] = raw.base64EncodedString()
    return first
}
check(r.events.count == 1 && (r.events[0]["message"] as? String ?? "").contains("didn't open"), "is refused, and nothing else is said")

print("A request sealed for another key than this run's")
r = run { _ in SignerSeal(helperKey: Data(repeating: 9, count: 32).base64EncodedString())?.first(secret) }
check(r.events.count == 1 && (r.events[0]["message"] as? String ?? "").contains("didn't open"), "is refused")

print("A malformed key from the helper")
check(SignerSeal(helperKey: "short") == nil, "makes no seal")

print(failures == 0 ? "\nAll passed." : "\n\(failures) failed.")
exit(failures == 0 ? 0 : 1)

// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Fast files v2 (docs/protocol.md "fx2", the computers' shared/fx2-engine.js, Android's Fx2.kt): the
// computer's files engine has a server of its own (welcome {fx2: {port}}). A file up to 8 MB goes as
// one range, a bigger one as 4 ranges at once, each its own TLS connection (pinned like the session):
//   PUT|GET /twindesk/fx2/<id>?i=&off=&len=&total=, the fx token in x-twindesk-fx.
// Straight HTTP/1.1 on Network.framework sockets: each range is read (or written) at its offset and
// hashed (SHA-256) as it streams, with no temporary copy and nothing read twice. file.end carries
// the sender's hashes ({fx2: [hex]}, sha256 = SHA-256 of the hashes joined by ','). Anything wrong
// before a byte went (early): that file and the rest of the session's go the fx way.
import Foundation
import Network
import CryptoKit

enum Fx2 {
    static let path = "/twindesk/fx2/"
    static let oneRangeMax: Int64 = 8 << 20
    static let ranges: Int64 = 4
    static let align: Int64 = 1 << 20
    static let ioBytes = 1 << 20
    static let inFlight = 4 // sends handed to the socket at once, per range

    struct Range { let i: Int; let off: Int64; let len: Int64 }
    struct To { let host: String; let port: UInt16; let fp: String; let token: String }
    struct Failure: Error { let early: Bool; let why: String }
    typealias Done = (Result<[String], Failure>) -> Void

    // The same plan as the engine's: the computer refuses a range that isn't one of it.
    static func plan(_ size: Int64) -> [Range] {
        if size <= oneRangeMax { return [Range(i: 0, off: 0, len: size)] }
        let step = ((size + ranges * align - 1) / (ranges * align)) * align
        var out: [Range] = []
        var off: Int64 = 0
        while off < size {
            out.append(Range(i: out.count, off: off, len: min(step, size - off)))
            off += step
        }
        return out
    }

    static func joined(_ hashes: [String]) -> String { Proto.sha256(Data(hashes.joined(separator: ",").utf8)).hex }

    static func same(_ theirs: Any?, _ ours: [String]) -> Bool {
        guard let a = theirs as? [Any], a.count == ours.count else { return false }
        for (i, h) in ours.enumerated() where ((a[i] as? String) ?? "").lowercased() != h { return false }
        return true
    }

    // Our file, PUT in its ranges at once. progress and done come on the main queue.
    // Returns its stop (Cancel on the Files page): done then fails with "cancelled".
    @discardableResult
    static func put(_ to: To, id: String, url: URL, size: Int64, progress: @escaping (Int64) -> Void, done: @escaping Done) -> () -> Void {
        let j = Job(to, id: id, url: url, size: size, put: true, progress: progress, done: done)
        j.start()
        return { j.cancel() }
    }

    // The computer's file, its ranges fetched at once into `url` (truncated to `size` first).
    // Returns its stop (the computer went another way): done then fails with "cancelled".
    @discardableResult
    static func get(_ to: To, id: String, url: URL, size: Int64, progress: @escaping (Int64) -> Void, done: @escaping Done) -> () -> Void {
        let j = Job(to, id: id, url: url, size: size, put: false, progress: progress, done: done)
        j.start()
        return { j.cancel() }
    }

    // Nothing through by then (a connection or TLS handshake that hangs: NWConnection has no timeout
    // of its own): an early failure, so the file goes the fx way at once. Under the computer's own
    // 10 s (fastfile.js PULL_MS), which otherwise gives up first while this one still waits.
    static let firstByteSeconds: Double = 7

    private final class Job {
        let to: To, id: String, url: URL, size: Int64, put: Bool
        let progress: (Int64) -> Void
        let done: Done
        private let q = DispatchQueue(label: "td.fx2.job")
        private var hashes: [String?] = []
        private var left = 0
        private var moved: Int64 = 0 // bytes through, all ranges (0 at a failure: early)
        private var unreported: Int64 = 0
        private var reportAt = Date.distantPast
        private var ended = false
        private var conns: [NWConnection] = []

        init(_ to: To, id: String, url: URL, size: Int64, put: Bool, progress: @escaping (Int64) -> Void, done: @escaping Done) {
            self.to = to; self.id = id; self.url = url; self.size = size; self.put = put; self.progress = progress; self.done = done
        }

        func start() {
            let plan = Fx2.plan(size)
            hashes = Array(repeating: nil, count: plan.count)
            left = plan.count
            if !put {
                guard let fh = try? FileHandle(forWritingTo: url), (try? fh.truncate(atOffset: UInt64(size))) != nil else {
                    return fail("can't write the file")
                }
                try? fh.close()
            }
            for r in plan { open(r) }
            q.asyncAfter(deadline: .now() + Fx2.firstByteSeconds) { [weak self] in
                guard let self = self, !self.ended, self.moved == 0 else { return }
                self.fail("no answer in \(Int(Fx2.firstByteSeconds)) s")
            }
        }

        func cancel() { fail("cancelled") }

        private func fail(_ why: String) {
            q.async {
                guard !self.ended else { return }
                self.ended = true
                self.conns.forEach { $0.cancel() }
                let f = Failure(early: self.moved == 0, why: why)
                DispatchQueue.main.async { self.done(.failure(f)) }
            }
        }

        private func rangeDone(_ i: Int, _ h: String) {
            q.async {
                guard !self.ended else { return }
                self.hashes[i] = h
                self.left -= 1
                guard self.left == 0 else { return }
                self.ended = true
                self.conns.forEach { $0.cancel() }
                let n = self.unreported
                self.unreported = 0
                let all = self.hashes.map { $0 ?? "" }
                DispatchQueue.main.async {
                    if n > 0 { self.progress(n) }
                    self.done(.success(all))
                }
            }
        }

        private func count(_ n: Int) {
            q.async {
                self.moved += Int64(n)
                self.unreported += Int64(n)
                let now = Date()
                guard now.timeIntervalSince(self.reportAt) > 0.1 else { return }
                self.reportAt = now
                let k = self.unreported
                self.unreported = 0
                DispatchQueue.main.async { self.progress(k) }
            }
        }

        private func open(_ r: Range) {
            let rq = DispatchQueue(label: "td.fx2.range")
            let tls = NWProtocolTLS.Options()
            let pin = to.fp
            sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
                complete(Link.leafFingerprint(sec_trust_copy_ref(trust).takeRetainedValue()) == pin)
            }, rq)
            let tcp = NWProtocolTCP.Options()
            tcp.noDelay = true
            let c = NWConnection(host: NWEndpoint.Host(to.host), port: NWEndpoint.Port(rawValue: to.port)!, using: NWParameters(tls: tls, tcp: tcp))
            q.sync { conns.append(c) }
            var began = false
            c.stateUpdateHandler = { [weak self] st in
                guard let self = self else { return }
                switch st {
                case .ready:
                    if began { return }
                    began = true
                    if self.put { self.send(c, r) } else { self.fetch(c, r) }
                case .failed(let e): self.fail("\(e)")
                case .waiting(let e): self.fail("\(e)") // unreachable: not worth waiting for
                default: break
                }
            }
            c.start(queue: rq)
        }

        private func head(_ method: String, _ r: Range) -> Data {
            let enc = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id
            let host = to.host.contains(":") ? "[\(to.host)]" : to.host
            var s = "\(method) \(Fx2.path)\(enc)?i=\(r.i)&off=\(r.off)&len=\(r.len)&total=\(size) HTTP/1.1\r\n"
            s += "Host: \(host):\(to.port)\r\n\(Proto.fxHeader): \(to.token)\r\nConnection: close\r\n"
            if method == "PUT" { s += "Content-Type: application/octet-stream\r\nContent-Length: \(r.len)\r\n" }
            return Data((s + "\r\n").utf8)
        }

        // PUT: the range read at its offset, hashed, a few sends handed to the socket at once.
        private func send(_ c: NWConnection, _ r: Range) {
            guard let fh = try? FileHandle(forReadingFrom: url), (try? fh.seek(toOffset: UInt64(r.off))) != nil else {
                return fail("can't read the file")
            }
            c.send(content: head("PUT", r), completion: .contentProcessed { _ in })
            var h = SHA256()
            var left = r.len
            var flying = 0
            var finished = false
            func finish() {
                if finished { return }
                finished = true
                try? fh.close()
                let hex = Data(h.finalize()).hex
                self.status(c) { code, _ in
                    if (200..<300).contains(code) { self.rangeDone(r.i, hex) } else { self.fail("HTTP \(code)") }
                }
            }
            func pump() {
                while flying < Fx2.inFlight && left > 0 {
                    let n = Int(min(left, Int64(Fx2.ioBytes)))
                    let d: Data
                    do { d = try fh.read(upToCount: n) ?? Data() } catch { return fail("read: \(error.localizedDescription)") }
                    if d.count != n { return fail("the file changed") }
                    h.update(data: d)
                    left -= Int64(n)
                    flying += 1
                    c.send(content: d, completion: .contentProcessed { e in
                        flying -= 1
                        if let e = e { return self.fail("\(e)") }
                        self.count(n)
                        pump()
                    })
                }
                if left == 0 && flying == 0 { finish() }
            }
            pump()
        }

        // GET: the body written at the range's offset, hashed as it comes.
        private func fetch(_ c: NWConnection, _ r: Range) {
            c.send(content: head("GET", r), completion: .contentProcessed { _ in })
            status(c) { code, first in
                guard code == 200 else { return self.fail("HTTP \(code)") }
                guard let fh = try? FileHandle(forWritingTo: self.url), (try? fh.seek(toOffset: UInt64(r.off))) != nil else {
                    return self.fail("can't write the file")
                }
                var h = SHA256()
                var got: Int64 = 0
                var pending = Data()
                func take(_ d: Data) -> Bool {
                    if got + Int64(d.count) > r.len { return false }
                    h.update(data: d)
                    pending.append(d)
                    got += Int64(d.count)
                    if pending.count >= Fx2.ioBytes || got == r.len {
                        do { try fh.write(contentsOf: pending) } catch { return false }
                        self.count(pending.count)
                        pending.removeAll(keepingCapacity: true)
                    }
                    return true
                }
                func finish() {
                    try? fh.close()
                    self.rangeDone(r.i, Data(h.finalize()).hex)
                }
                if !first.isEmpty, !take(first) { try? fh.close(); return self.fail("too long") }
                func more() {
                    if got == r.len { return finish() }
                    c.receive(minimumIncompleteLength: 1, maximumLength: Fx2.ioBytes) { d, _, end, err in
                        if let d = d, !d.isEmpty, !take(d) { try? fh.close(); return self.fail("too long, or no room") }
                        if got == r.len { return finish() }
                        if end || err != nil { try? fh.close(); return self.fail(err.map { "\($0)" } ?? "closed early") }
                        more()
                    }
                }
                more()
            }
        }

        // The response's status code, and whatever of the body came with the head.
        private func status(_ c: NWConnection, _ buf: Data = Data(), _ done: @escaping (Int, Data) -> Void) {
            c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { d, _, end, err in
                var b = buf
                if let d = d { b.append(d) }
                if let k = b.range(of: Data("\r\n\r\n".utf8)) {
                    let line = String(decoding: b[b.startIndex..<k.lowerBound], as: UTF8.self).split(separator: "\r\n").first ?? ""
                    let parts = line.split(separator: " ")
                    return done(parts.count > 1 ? Int(parts[1]) ?? 0 : 0, Data(b[k.upperBound...]))
                }
                if end || err != nil || b.count > 16384 { return done(0, Data()) }
                self.status(c, b, done)
            }
        }
    }
}

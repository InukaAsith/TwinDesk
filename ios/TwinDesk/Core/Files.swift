// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Files both ways (Files.kt, docs/protocol.md "Files"): file.offer / accept / chunk / end / done,
// and fast files (fx) where the computer offers them: we PUT what we send and GET what it sends
// (after file.pull), over HTTPS pinned like the session. What arrives lands in
// Files › On My \(Device.word) › TwinDesk › Received (UIFileSharingEnabled).
import Foundation
import CryptoKit
import UIKit

final class Files: Feature {
    struct Batch: Identifiable {
        let id: String
        let dir: String // in | out
        var name: String
        var count: Int
        var bytes: Int64
        var got: Int64 = 0
        var done = 0
        var ok = true
        var finished = false
        var cancelled = false
        var at = Date()
        var progress: Double { bytes > 0 ? min(1, Double(got) / Double(bytes)) : (finished ? 1 : 0) }
    }

    private final class Incoming {
        let id: String, batch: String, name: String, rel: String, size: Int64
        let url: URL
        let handle: FileHandle
        var hash = SHA256()
        var got: Int64 = 0
        var seq = 0
        var pulling = false
        var heldEnd: JSON?
        var fx2Hashes: [String]? // fx2: the ranges' hashes, once every one is in (file.end {fx2} must match)
        var stop2: (() -> Void)? // the fx2 fetch under way
        var tries = 0 // which fetch is the live one (an older one's end is ignored)
        init(id: String, batch: String, name: String, rel: String, size: Int64, url: URL, handle: FileHandle) {
            self.id = id; self.batch = batch; self.name = name; self.rel = rel; self.size = size; self.url = url; self.handle = handle
        }
    }

    private final class Outgoing {
        let id: String, url: URL, name: String, size: Int64, batch: String
        var state = "offered" // offered, accepted, sending, cancelled
        var stop: (() -> Void)? // the transfer under way (fx2's ranges, fx's upload)
        init(id: String, url: URL, name: String, size: Int64, batch: String) {
            self.id = id; self.url = url; self.name = name; self.size = size; self.batch = batch
        }
    }

    private(set) var batches: [Batch] = [] // newest first, for the Files page
    private var incoming: [String: Incoming] = [:] { didSet { keepRunning() } }
    private var outgoing: [Outgoing] = [] { didSet { keepRunning() } }
    // While a file goes either way, iOS is asked to keep the app running (a background task, about
    // 30 s once off screen): a file sent from the computer's Share menu or Send files while this
    // screen is off was never pulled (the app suspended: the computer's 10 s wait for file.pull ran
    // out) and its file.chunk stopped when the session dropped.
    private var task: UIBackgroundTaskIdentifier = .invalid
    var busy: Bool { !incoming.isEmpty || !outgoing.isEmpty }
    private func keepRunning() {
        let busy = self.busy
        if busy, task == .invalid {
            task = UIApplication.shared.beginBackgroundTask(withName: "TwinDesk files") { [weak self] in self?.letGo() }
        } else if !busy {
            // Done off screen: onto Bluetooth now (Core.backgrounded waited for the files).
            if task != .invalid { DispatchQueue.main.async { if !Core.shared.inFront { Core.shared.backgrounded() } } }
            letGo()
        }
    }
    private func letGo() {
        guard task != .invalid else { return }
        UIApplication.shared.endBackgroundTask(task)
        task = .invalid
    }
    private var expected: Set<String> = [] // batches asked for (fclip.paste)
    private var fxBroken = false
    private var fx2Broken = false // fx2 failed before a byte went: the fx way for the rest of the session
    private let io = DispatchQueue(label: "td.files")
    private var pumping = false

    static var receivedDir: URL {
        let d = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Received", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    func expect(_ batch: String) { expected.insert(batch) }

    // The computer's next batch goes into this folder (its Upload into a folder here: fs.expect),
    // done told how it went.
    private var targets: [String: (dir: URL, done: (Bool) -> Void)] = [:]
    func expect(_ batch: String, into dir: URL, done: @escaping (Bool) -> Void) {
        targets[batch] = (dir, done)
        expected.insert(batch)
    }

    override func onWelcome(_ host: Computer, _ m: JSON) {
        fxBroken = false
        fx2Broken = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.flushShares() }
    }

    override func onClosed() {
        for f in incoming.values { try? f.handle.close(); try? FileManager.default.removeItem(at: f.url) }
        incoming.removeAll()
        outgoing.removeAll()
        for i in batches.indices where !batches[i].finished { batches[i].finished = true; batches[i].ok = false }
        core.changed()
    }

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        switch t {
        case Proto.T.fileOffer: offer(m)
        case Proto.T.fileChunk: chunk(m)
        case Proto.T.fileEnd: end(m)
        case Proto.T.filePull: pull(m)
        case Proto.T.fileCancel:
            abort(m.str("id"), "cancelled", tell: false)
            outgoing.removeAll { $0.id == m.str("id") }
        case Proto.T.fileAccept:
            outgoing.first { $0.id == m.str("id") && $0.state == "offered" }?.state = "accepted"
            pump()
        case Proto.T.fileRefuse: outgoing.removeAll { $0.id == m.str("id") }
        case Proto.T.fileDone: break
        case Proto.T.filesDone: outDone(m)
        case "drag.policy": break
        case "drag.start":
            // The computer's pointer crossed over dragging files: they land in Received.
            let id = m.str("drag", max: 128)
            if !id.isEmpty {
                if m.int("files") == 0 { core.send(msg("drag.end", ["drag": id, "result": "dropped", "where": "TwinDesk/Received"])) }
                else { expect(id) }
            }
        default: return false
        }
        return true
    }

    // ---- in ----

    private func refuse(_ id: String, _ why: String) { core.send(msg(Proto.T.fileRefuse, ["id": id, "why": why])) }

    private func clean(_ s: String) -> String {
        var n = s.replacingOccurrences(of: "[\\u0000-\\u001f/:\\\\]", with: "_", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        if n.isEmpty || n == "." || n == ".." { n = "file" }
        return String(n.prefix(200))
    }

    private func offer(_ m: JSON) {
        let id = m.str("id", max: 128)
        guard !id.isEmpty, incoming[id] == nil else { return }
        let drop = m.str("drop")
        guard ["send", "paste", "drag", "rezume"].contains(drop) else { return refuse(id, "not_allowed") }
        let size = m.int64("size", -1)
        guard size >= 0, size <= Proto.fileMaxBytes else { return refuse(id, "too_big") }
        let batchId = (drop == "drag" ? m.str("drag", max: 128) : m.str("batch", max: 128)).isEmpty ? id : (drop == "drag" ? m.str("drag", max: 128) : m.str("batch", max: 128))
        let relRaw = m.str("rel", max: 4096).isEmpty ? m.str("name", max: 4096) : m.str("rel", max: 4096)
        let rel = relRaw.split(separator: "/").map { clean(String($0)) }
        guard let name = rel.last else { return refuse(id, "bad_name") }
        if !batches.contains(where: { $0.id == batchId }) {
            if drop == "paste" && !expected.contains(batchId) { return refuse(id, "not_expected") }
            expected.remove(batchId)
            let count = max(1, m.int("count", 1))
            batches.insert(Batch(id: batchId, dir: "in", name: count == 1 ? name : trCount(count, "item"), count: count, bytes: m.int64("bytes", size)), at: 0)
        }
        // Keep both: "name 2.ext" when one is already there.
        let target0 = targets[batchId]
        var url = target0?.dir ?? Self.receivedDir
        for seg in rel.dropLast() { url.appendPathComponent(seg, isDirectory: true) }
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var target = url.appendingPathComponent(name)
        if rel.count == 1 || target0 != nil {
            let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
            var i = 2
            while FileManager.default.fileExists(atPath: target.path) {
                target = url.appendingPathComponent(ext.isEmpty ? "\(base) \(i)" : "\(base) \(i).\(ext)")
                i += 1
            }
        }
        guard FileManager.default.createFile(atPath: target.path, contents: nil), let h = try? FileHandle(forWritingTo: target) else {
            refuse(id, "not_allowed")
            return finished(batchId, false)
        }
        incoming[id] = Incoming(id: id, batch: batchId, name: name, rel: rel.joined(separator: "/"), size: size, url: target, handle: h)
        core.send(msg(Proto.T.fileAccept, ["id": id]))
        core.changed()
    }

    private func chunk(_ m: JSON) {
        guard let f = incoming[m.str("id", max: 128)] else { return }
        if f.pulling && f.stop2 != nil && f.got == 0 { drop2(f) } // the computer gave up on fx2 (no bytes in time): its chunks instead
        if f.pulling { return abort(f.id, "out of order", tell: true) }
        guard let d = Data(base64Encoded: m.str("data", max: Proto.fileChunkBytes * 2)), m.int("seq") == f.seq,
              f.got + Int64(d.count) <= f.size else { return abort(f.id, "out of order", tell: true) }
        f.seq += 1
        f.handle.write(d)
        f.hash.update(data: d)
        f.got += Int64(d.count)
        addGot(f.batch, Int64(d.count))
    }

    private func end(_ m: JSON) {
        guard let f = incoming[m.str("id", max: 128)] else { return }
        if f.pulling { f.heldEnd = m; return }
        incoming.removeValue(forKey: f.id)
        try? f.handle.close()
        let ok = f.got == f.size && (f.fx2Hashes.map { Fx2.same(m["fx2"], $0) } ?? (Data(f.hash.finalize()).hex == m.str("sha256", max: 64)))
        if !ok {
            try? FileManager.default.removeItem(at: f.url)
            core.send(msg(Proto.T.fileDone, ["id": f.id, "ok": false, "error": "checksum"]))
            return finished(f.batch, false)
        }
        core.send(msg(Proto.T.fileDone, ["id": f.id, "ok": true, "path": "TwinDesk/Received/\(f.rel)"]))
        finished(f.batch, true)
    }

    private func abort(_ id: String, _ why: String, tell: Bool) {
        guard let f = incoming.removeValue(forKey: id) else { return }
        try? f.handle.close()
        try? FileManager.default.removeItem(at: f.url)
        if tell { core.send(msg(Proto.T.fileCancel, ["id": id])) }
        NSLog("TwinDesk: file %@: %@", f.name, why)
        finished(f.batch, false)
    }

    // file.pull (fast files): GET the bytes of a file we accepted; {failed} when we can't, and the
    // computer sends it as file.chunk.
    private func pull(_ m: JSON) {
        let id = m.str("id", max: 128)
        if m.has("fx2") { return pull2(id, m.int64("size", -1)) }
        if let f = incoming[id], f.pulling, f.stop2 != nil, f.got == 0 { drop2(f) } // fx2 given up on by the computer: fx now
        guard let f = incoming[id], !fxBroken, !f.pulling, f.got == 0, f.seq == 0,
              let req = core.link.fxRequest(id, method: "GET") else {
            core.send(msg(Proto.T.filePull, ["id": id, "failed": true]))
            return
        }
        f.pulling = true
        let task = core.link.urlSession.downloadTask(with: req) { [weak self] tmp, res, err in
            guard let self = self else { return }
            var error = err?.localizedDescription
            if error == nil, (res as? HTTPURLResponse)?.statusCode != 200 { error = "HTTP \((res as? HTTPURLResponse)?.statusCode ?? 0)" }
            // The download's file goes away when this returns: moved aside at once (a rename), then
            // copied into ours and hashed off the session's queue.
            var kept: URL?
            if error == nil, let tmp = tmp {
                let k = FileManager.default.temporaryDirectory.appendingPathComponent("fx-" + UUID().uuidString)
                if (try? FileManager.default.moveItem(at: tmp, to: k)) != nil { kept = k } else { error = "move failed" }
            }
            self.io.async {
            var hashed: (SHA256, Int64)?
            if let k = kept { hashed = Self.copy(k, into: f.handle); try? FileManager.default.removeItem(at: k) }
            DispatchQueue.main.async {
                f.pulling = false
                guard self.incoming[f.id] === f else { return }
                guard let (h, n) = hashed, error == nil else {
                    NSLog("TwinDesk: fast file %@: %@", f.name, error ?? "failed")
                    self.fxBroken = true
                    self.core.send(msg(Proto.T.filePull, ["id": f.id, "failed": true]))
                    return
                }
                f.hash = h
                f.got = n
                self.addGot(f.batch, n)
                if let e = f.heldEnd { f.heldEnd = nil; self.end(e) }
            }
            }
        }
        task.resume()
    }

    // The computer gave up on the fx2 fetch before a byte came (fastfile.js PULL_MS) and went the fx or
    // the chunk way: that fetch is stopped and forgotten, the file afresh for the new way. Before,
    // a still-waiting fetch made the fallback fail too ("out of order"): the first send failed.
    private func drop2(_ f: Incoming) {
        NSLog("TwinDesk: fast file (fx2) %@: the computer went another way", f.name)
        f.tries += 1
        let stop = f.stop2
        f.stop2 = nil
        f.pulling = false
        fx2Broken = true // as the computer: the fx way for the rest of the session
        stop?()
        try? f.handle.truncate(atOffset: 0)
        try? f.handle.seek(toOffset: 0)
    }

    // file.pull {fx2, size}: its ranges fetched at once, each written at its offset. {failed, fx2}
    // when we can't (before a byte): the computer sends it the fx way.
    private func pull2(_ id: String, _ size: Int64) {
        guard let f = incoming[id], !fxBroken, !fx2Broken, !f.pulling, f.got == 0, f.seq == 0, size == f.size,
              let to = core.link.fx2Target() else {
            core.send(msg(Proto.T.filePull, ["id": id, "failed": true, "fx2": 1]))
            return
        }
        f.pulling = true
        f.tries += 1
        let attempt = f.tries
        f.stop2 = Fx2.get(to, id: id, url: f.url, size: f.size, progress: { [weak self] n in
            guard let self = self, self.incoming[f.id] === f, f.tries == attempt else { return }
            self.addGot(f.batch, n)
        }) { [weak self] r in
            guard let self = self, f.tries == attempt else { return } // dropped: the computer went another way
            f.pulling = false
            f.stop2 = nil
            guard self.incoming[f.id] === f else { return }
            switch r {
            case .success(let hs):
                f.fx2Hashes = hs
                f.got = f.size
                if let e = f.heldEnd { f.heldEnd = nil; self.end(e) }
            case .failure(let e) where e.early:
                NSLog("TwinDesk: fast file (fx2) %@: %@: the fx way for this session", f.name, e.why)
                self.fx2Broken = true
                try? f.handle.truncate(atOffset: 0)
                try? f.handle.seek(toOffset: 0)
                self.core.send(msg(Proto.T.filePull, ["id": f.id, "failed": true, "fx2": 1]))
            case .failure(let e):
                self.abort(f.id, "fast file (fx2): \(e.why)", tell: true)
            }
        }
    }

    // The downloaded file's bytes into ours, hashed as they go.
    private static func copy(_ from: URL, into: FileHandle) -> (SHA256, Int64)? {
        guard let r = try? FileHandle(forReadingFrom: from) else { return nil }
        defer { try? r.close() }
        var h = SHA256()
        var n: Int64 = 0
        while true {
            let d = r.readData(ofLength: 1 << 20)
            if d.isEmpty { break }
            into.write(d)
            h.update(data: d)
            n += Int64(d.count)
        }
        return (h, n)
    }

    private func addGot(_ batch: String, _ n: Int64) {
        if let i = batches.firstIndex(where: { $0.id == batch }) { batches[i].got += n }
        core.changed()
    }

    private func finished(_ batch: String, _ ok: Bool) {
        guard let i = batches.firstIndex(where: { $0.id == batch }) else { return }
        batches[i].done += 1
        if !ok { batches[i].ok = false }
        if batches[i].done >= batches[i].count {
            batches[i].finished = true
            let b = batches[i]
            if b.dir == "in", let t = targets.removeValue(forKey: b.id) {
                core.send(msg(Proto.T.filesDone, ["batch": b.id, "ok": b.ok, "where": "TwinDesk", "files": b.done]))
                t.done(b.ok)
            } else if b.dir == "in" {
                core.send(msg(Proto.T.filesDone, ["batch": b.id, "ok": b.ok, "where": "TwinDesk/Received", "files": b.done]))
                Notifier.shared.filesIn(b.name, ok: b.ok, from: core.link.host?.name ?? tr("the computer"))
            }
        }
        core.changed()
    }

    // ---- out ----

    // Files shared to TwinDesk from another app ("Open in TwinDesk", "Copy to TwinDesk") land in
    // Documents/Inbox: they go to the computer, from a folder of ours (Inbox is read-only for us).
    private var pendingShares: [URL] = []

    func importInbox() {
        let fm = FileManager.default
        let inbox = fm.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Inbox", isDirectory: true)
        guard let items = try? fm.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil), !items.isEmpty else { return flushShares() }
        for u in items { adopt(u) }
        flushShares()
    }

    // A file handed to us (onOpenURL with a file, the Inbox): kept in Caches/Outbox until sent.
    func adopt(_ url: URL) {
        let fm = FileManager.default
        let out = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Outbox", isDirectory: true)
        try? fm.createDirectory(at: out, withIntermediateDirectories: true)
        let dest = out.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? fm.createDirectory(at: dest, withIntermediateDirectories: true)
        let target = dest.appendingPathComponent(url.lastPathComponent)
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        // Ours (Inbox, a temporary copy): moved. Anyone else's (opened in place from the Files app,
        // LSSupportsOpeningDocumentsInPlace): copied, the original stays where it is.
        let home = URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path
        let mine = url.resolvingSymlinksInPath().path.hasPrefix(home + "/") || url.path.hasPrefix(FileManager.default.temporaryDirectory.path)
        if !mine || (try? fm.moveItem(at: url, to: target)) == nil { try? fm.copyItem(at: url, to: target) }
        if fm.fileExists(atPath: target.path) { pendingShares.append(target) }
    }

    // Files already in Outbox (ShareIn): sent now, or once connected.
    func queue(_ urls: [URL]) {
        pendingShares.append(contentsOf: urls)
        flushShares()
    }

    func flushShares() {
        guard core.connected, !pendingShares.isEmpty else { return }
        let list = pendingShares
        pendingShares = []
        send(list)
    }

    var waitingShares: Int { pendingShares.count }

    // Files picked here (document picker, photos, the share sheet's inbox): offered to the computer.
    @discardableResult
    func send(_ urls: [URL], kind: String = "send", rels: [String]? = nil) -> Bool {
        guard core.connected, !urls.isEmpty else { return false }
        let batch = UUID().uuidString
        var items: [(URL, String, Int64)] = []
        var seen = Set<String>()
        for (ui, u) in urls.enumerated() {
            let size = (try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize).flatMap { $0 }.map(Int64.init) ?? 0
            if let r = rels, ui < r.count { items.append((u, r[ui], size)); continue } // a folder's files, their paths kept
            var name = u.lastPathComponent
            var i = 2
            while !seen.insert(name).inserted {
                let base = (u.lastPathComponent as NSString).deletingPathExtension, ext = (u.lastPathComponent as NSString).pathExtension
                name = ext.isEmpty ? "\(base) \(i)" : "\(base) \(i).\(ext)"
                i += 1
            }
            items.append((u, name, size))
        }
        let bytes = items.reduce(Int64(0)) { $0 + $1.2 }
        batches.insert(Batch(id: batch, dir: "out", name: items.count == 1 ? items[0].1 : trCount(items.count, "item"), count: items.count, bytes: bytes), at: 0)
        for (index, it) in items.enumerated() {
            let id = UUID().uuidString
            let leaf = (it.1 as NSString).lastPathComponent
            outgoing.append(Outgoing(id: id, url: it.0, name: leaf, size: it.2, batch: batch))
            core.send(msg(Proto.T.fileOffer, ["id": id, "name": leaf, "size": it.2, "drop": kind, "batch": batch, "rel": it.1,
                                              "index": index, "count": items.count, "bytes": bytes]))
        }
        core.changed()
        return true
    }

    private func pump() {
        if pumping { return }
        guard let f = outgoing.first(where: { $0.state == "accepted" }) else { return }
        pumping = true
        f.state = "sending"
        let done = { [weak self] in
            guard let self = self else { return }
            self.outgoing.removeAll { $0 === f }
            self.pumping = false
            self.pump()
        }
        if !fxBroken, !fx2Broken, let to = core.link.fx2Target() {
            f.stop = Fx2.put(to, id: f.id, url: f.url, size: f.size, progress: { [weak self] n in self?.addGot(f.batch, n) }) { [weak self] r in
                guard let self = self else { return }
                if f.state == "cancelled" { return done() }
                switch r {
                case .success(let hs):
                    self.core.send(msg(Proto.T.fileEnd, ["id": f.id, "sha256": Fx2.joined(hs), "fx2": hs]))
                    done()
                case .failure(let e) where e.early:
                    NSLog("TwinDesk: fast file (fx2) %@: %@: the fx way for this session", f.name, e.why)
                    self.fx2Broken = true
                    f.state = "accepted"
                    self.pumping = false
                    self.pump()
                case .failure(let e):
                    NSLog("TwinDesk: send %@: %@", f.name, e.why)
                    self.core.send(msg(Proto.T.fileCancel, ["id": f.id]))
                    done()
                }
            }
            return
        }
        if !fxBroken, let req = core.link.fxRequest(f.id, method: "PUT") {
            io.async {
                let sha = Self.hashFile(f.url)
                DispatchQueue.main.async {
                    guard let sha = sha else {
                        self.core.send(msg(Proto.T.fileCancel, ["id": f.id]))
                        return done()
                    }
                    var r = req
                    r.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
                    r.setValue(String(f.size), forHTTPHeaderField: "Content-Length")
                    if f.state == "cancelled" { return done() }
                    let task = self.core.link.urlSession.uploadTask(with: r, fromFile: f.url) { _, res, err in
                        DispatchQueue.main.async {
                            if f.state == "cancelled" { return done() }
                            let code = (res as? HTTPURLResponse)?.statusCode ?? 0
                            if err == nil && (200..<300).contains(code) {
                                self.addGot(f.batch, f.size)
                                self.core.send(msg(Proto.T.fileEnd, ["id": f.id, "sha256": sha]))
                                done()
                            } else {
                                NSLog("TwinDesk: fast file %@: %@ (HTTP %d): file.chunk for this session", f.name, err?.localizedDescription ?? "", code)
                                self.fxBroken = true
                                self.chunks(f, done)
                            }
                        }
                    }
                    f.stop = { task.cancel() }
                    task.resume()
                }
            }
            return
        }
        chunks(f, done)
    }

    // The bytes as base64 file.chunk on the session, while it drains.
    private func chunks(_ f: Outgoing, _ done: @escaping () -> Void) {
        io.async {
            var h = SHA256()
            var seq = 0
            guard let r = try? FileHandle(forReadingFrom: f.url) else {
                DispatchQueue.main.async { self.core.send(msg(Proto.T.fileCancel, ["id": f.id])); done() }
                return
            }
            defer { try? r.close() }
            while true {
                if !self.core.link.connected || f.state == "cancelled" { DispatchQueue.main.async(execute: done); return }
                while self.core.link.queued() > 1 << 20 { usleep(5000) }
                let d = r.readData(ofLength: Proto.fileChunkBytes)
                if d.isEmpty { break }
                h.update(data: d)
                self.core.send(msg(Proto.T.fileChunk, ["id": f.id, "seq": seq, "data": d.base64EncodedString()]))
                seq += 1
                let n = Int64(d.count)
                DispatchQueue.main.async { self.addGot(f.batch, n) }
            }
            let sha = Data(h.finalize()).hex
            DispatchQueue.main.async {
                self.core.send(msg(Proto.T.fileEnd, ["id": f.id, "sha256": sha]))
                done()
            }
        }
    }

    // Files › Cancel on a batch on its way: each of its files stopped and the computer told
    // (file.cancel); the batch ends as cancelled.
    func cancel(_ batch: String) {
        guard let i = batches.firstIndex(where: { $0.id == batch && $0.dir == "out" && !$0.finished }) else { return }
        for f in outgoing where f.batch == batch {
            let was = f.state
            f.state = "cancelled"
            f.stop?()
            core.send(msg(Proto.T.fileCancel, ["id": f.id]))
            if was != "sending" { outgoing.removeAll { $0 === f } } // a sending one leaves when its transfer stops
        }
        batches[i].finished = true
        batches[i].ok = false
        batches[i].cancelled = true
        core.changed()
    }

    private static func hashFile(_ url: URL) -> String? {
        guard let r = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? r.close() }
        var h = SHA256()
        while true {
            let d = r.readData(ofLength: 1 << 20)
            if d.isEmpty { break }
            h.update(data: d)
        }
        return Data(h.finalize()).hex
    }

    private func outDone(_ m: JSON) {
        let id = m.str("batch", max: 128)
        guard let i = batches.firstIndex(where: { $0.id == id }), !batches[i].cancelled else { return }
        batches[i].finished = true
        batches[i].ok = m.bool("ok")
        batches[i].done = batches[i].count
        Notifier.shared.filesOut(batches[i].name, ok: batches[i].ok, to: core.link.host?.name ?? tr("the computer"))
        core.changed()
    }
}

// Files copied on the computer with its shortcut (⌃⌥C): a notification here, Save brings them over
// (fclip.offer, fclip.paste; FileClip.kt).
final class FileClip: Feature {
    private(set) var offer: (id: String, files: Int, bytes: Int64, names: [String])?

    override func onClosed() { offer = nil }

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        switch t {
        case Proto.T.fclipOffer:
            let items = (m["items"] as? [JSON]) ?? []
            let names = items.prefix(3).map { $0.str("name", max: 100) }
            offer = (m.str("id", max: 128), m.int("files", items.count), m.int64("bytes"), names)
            Notifier.shared.fclip(id: offer!.id, names: names, files: offer!.files, from: core.link.host?.name ?? tr("the computer"))
            core.changed()
        case Proto.T.fclipGone:
            if offer?.id == m.str("id", max: 128) { offer = nil; Notifier.shared.cancelFclip(); core.changed() }
        case Proto.T.fclipPaste, "fclip.key": break
        default: return false
        }
        return true
    }

    func save(_ id: String? = nil) {
        guard let id = id ?? offer?.id else { return }
        core.files.expect(id)
        core.send(msg(Proto.T.fclipPaste, ["id": id]))
        offer = nil
        core.changed()
    }
}

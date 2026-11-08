// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Connect with Android (Android's Peer.kt): this iPhone and an Android phone with TwinDesk, side by
// side with the computer's session and never in its way: a second Link, with its own paired list
// ("peerHosts"). The Android phone hosts (its own TLS server, pinned once paired, exactly as a
// computer is); this iPhone is always the guest. Not hosting itself, it gives no token back (peer.rev):
// the Android phone sees it while it's connected, and it connects again from here.
//
// On the session: clip, notif, files (f.*), requests (q → r: the Android phone's Photos and Messages
// here, this iPhone's Photos there) and its screen (screen.*). The bytes of files and the screen go in
// HTTPS requests to the Android phone with the session's key (peer.key), never through the session.
import Foundation
import UIKit
import Photos

final class Peer: NSObject, LinkEvents {
    static let hostsList = "peerHosts"
    static let header = "x-twindesk-peer"

    unowned let core: Core
    let link = Link(list: Peer.hostsList)
    private let work = DispatchQueue(label: "td.peer.work")

    // main
    private(set) var role = "" // "" | guest
    private(set) var peerId = ""
    private(set) var peerName = ""
    private(set) var peerModel = ""
    private(set) var message = ""
    private(set) var waitingFor = ""
    private var waitUntil = Date.distantPast
    private var key = ""
    private var resumeUntil = Date.distantPast
    var connected: Bool { role == "guest" }

    var on: Bool { core.store.flag("peer.on", true) }
    var clipOn: Bool { core.store.flag("peer.clip", true) }
    var notifsOn: Bool { core.store.flag("peer.notifs", true) }
    var photosOn: Bool { core.store.flag("peer.photos", true) }
    func set(_ k: String, _ v: Bool) {
        core.store.setFlag(k, v)
        if k == "peer.on" && !v { disconnect() }
        changed()
    }

    init(_ core: Core) {
        self.core = core
        super.init()
        link.events = self
        core.discovery.peerOn = { [weak self] in self?.on ?? false }
        core.discovery.onPeer = { [weak self] f, m in self?.onPeer(f, m) }
        NotificationCenter.default.addObserver(forName: UIPasteboard.changedNotification, object: nil, queue: .main) { [weak self] _ in self?.clipNow() }
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.clipNow() }
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
    }

    private func changed() { core.changed() }

    func paired() -> [Computer] { core.store.hosts(Self.hostsList) }
    func nearby() -> [Found] { core.discovery.phoneList() }
    var pair: PairState? { link.pair }
    var linkState: String { link.state }

    // ---- connecting (as the guest) ----

    // Connect on a phone near: straight to it while it hosts; else ask it to (peer.ask).
    func connect(_ f: Found) {
        message = ""
        if connected && peerId == f.id { return }
        if connected { disconnect() }
        if f.port == 0 {
            waitingFor = f.id
            waitUntil = Date().addingTimeInterval(30)
            core.discovery.sendTo(msg("peer.ask", ["v": Proto.version, "id": core.store.deviceId, "name": core.store.deviceName]), f.address)
            return changed()
        }
        if var h = paired().first(where: { $0.id == f.id }) {
            h.address = f.address
            h.port = f.port
            core.store.putHost(h, Self.hostsList)
            link.connect(h)
        } else {
            link.startPairing(address: f.address, port: f.port, name: f.name)
        }
        changed()
    }

    func cancelWait() { waitingFor = ""; changed() }

    func disconnect() {
        resumeUntil = .distantPast
        link.disconnect()
        if link.pair != nil { link.cancelPairing() }
    }

    func forget(_ id: String) {
        if peerId == id && connected { send(msg("peer.forget")); disconnect() }
        core.store.forgetHost(id, Self.hostsList)
        changed()
    }

    private func onPeer(_ f: Found, _ m: JSON) {
        switch m.str("t", max: 30) {
        case "peer.hosting":
            let p = m.int("port")
            guard waitingFor == f.id, (1...65535).contains(p) else { return }
            core.discovery.setPhonePort(f.id, f.address, UInt16(p))
            waitingFor = ""
            var g = f
            g.port = UInt16(p)
            connect(g)
        case "peer.no":
            if waitingFor == f.id { waitingFor = ""; message = "\(f.name) said not now."; changed() }
        default: break
        }
    }

    private func tick() {
        if !waitingFor.isEmpty {
            if let f = core.discovery.phone(waitingFor), f.port > 0 { waitingFor = ""; connect(f) }
            else if Date() > waitUntil {
                let name = core.discovery.phone(waitingFor)?.name ?? "That phone"
                waitingFor = ""
                message = "\(name) didn’t answer. Open TwinDesk on it, or turn on Host for other phones there."
                changed()
            }
        }
    }

    // ---- LinkEvents (the link's queue) ----

    func linkChanged() { DispatchQueue.main.async { self.changed() } }

    func linkWelcome(_ host: Computer, _ m: JSON) {
        DispatchQueue.main.async {
            self.resumeUntil = .distantPast
            self.role = "guest"
            self.peerId = host.id
            self.peerName = host.name
            self.key = ""
            NSLog("TwinDesk: peer: session with %@", host.name)
            self.send(msg("peer.info", ["model": self.core.store.model]))
            self.message = ""
            self.changed()
        }
    }

    func linkMessage(_ t: String, _ m: JSON) { DispatchQueue.main.async { self.dispatch(t, m) } }

    func linkClosed(_ host: Computer, _ code: String?) {
        DispatchQueue.main.async {
            if self.role == "guest" { self.ended() }
            let deliberate = ["local", Proto.E.released, Proto.E.replaced, Proto.E.badToken, Proto.E.busy]
            if let c = code, deliberate.contains(c) { return }
            if self.link.state == "failed" { return }
            if self.resumeUntil == .distantPast { self.resumeUntil = Date().addingTimeInterval(Proto.phoneGrace) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                guard Date() < self.resumeUntil, !self.connected, self.link.state != "connecting", self.link.pair == nil,
                      var h = self.paired().first(where: { $0.id == host.id }) else { return }
                if let f = self.core.discovery.phone(h.id), f.port > 0 { h.address = f.address; h.port = f.port }
                self.link.connect(h)
            }
        }
    }

    private func ended() {
        NSLog("TwinDesk: peer: session with %@ ended", peerName)
        role = ""
        key = ""
        let waiting = calls
        calls.removeAll()
        for (_, cb) in waiting { cb(["error": "Disconnected"]) }
        for id in Array(inFiles.keys) { inFailed(id) }
        outFiles.removeAll()
        screenEnded()
        changed()
    }

    @discardableResult
    func send(_ m: JSON) -> Bool { link.send(m) }

    private func dispatch(_ t: String, _ m: JSON) {
        switch t {
        case "peer.key": key = m.str("key", max: 64)
        case "peer.info": peerModel = m.str("model", max: 80); changed()
        case "peer.forget": forget(peerId)
        case "clip": clipIn(m)
        case "notif": notifIn(m)
        case "f.offer": inOffer(m)
        case "f.accept": outAccepted(m.str("id", max: 128))
        case "f.done": outDone(m.str("id", max: 128), m.bool("ok"))
        case "f.cancel": let id = m.str("id", max: 128); inFailed(id); outFiles.removeValue(forKey: id)
        case "q": answer(m)
        case "r": if let cb = calls.removeValue(forKey: m.str("qid", max: 40)) { cb(m) }
        case "screen.ready": screenReady()
        case "screen.stop": screenEnded()
        case "screen.state":
            screenError = m.str("error", max: 300)
            if !m.bool("on") { if screenError.isEmpty { screenEnded() } }
            changed()
        default: break
        }
    }

    // ---- clipboard (read while TwinDesk is in front, as iOS allows) ----

    private var clipLastIn = ""
    private var clipLastOut = ""
    private var clipCount = UIPasteboard.general.changeCount

    func clipNow() {
        guard connected, clipOn, UIApplication.shared.applicationState == .active else { return }
        let pb = UIPasteboard.general
        guard pb.changeCount != clipCount else { return }
        clipCount = pb.changeCount
        guard pb.hasStrings, let text = pb.string else { return }
        clipOut(text)
    }

    func clipOut(_ text: String) {
        guard connected, clipOn, !text.isEmpty, text != clipLastIn, text != clipLastOut, text.utf8.count <= Proto.clipMaxBytes else { return }
        clipLastOut = text
        send(msg("clip", ["text": text]))
    }

    private func clipIn(_ m: JSON) {
        let text = m.str("text", max: Proto.clipMaxBytes)
        guard clipOn, !text.isEmpty else { return }
        clipLastIn = text
        UIPasteboard.general.string = text
        clipCount = UIPasteboard.general.changeCount
    }

    // ---- notifications ----

    private func notifIn(_ m: JSON) {
        guard notifsOn else { return }
        let app = m.str("appName", max: 80).isEmpty ? m.str("app", max: 80) : m.str("appName", max: 80)
        let title = m.str("title", max: 300)
        Notifier.shared.note("peer:" + m.str("id", max: 200), title.isEmpty ? app : "\(app): \(title)", m.str("body", max: 1000))
    }

    // ---- files ----
    // f.offer {id, name, size, batch, count, rel} → f.accept. We PUT what we send (/peer/f/<id>) and
    // GET what it sends; f.done from the one receiving. Into TwinDesk/Received.

    struct Batch: Identifiable {
        let id: String
        let up: Bool
        let name: String
        let count: Int
        let bytes: Int64
        var moved: Int64 = 0
        var done = 0
        var ok = true
        var progress: Double { bytes > 0 ? min(1, Double(moved) / Double(bytes)) : 0 }
    }
    private final class OutFile { let id: String, url: URL, name: String, size: Int64, batch: String
        init(_ id: String, _ url: URL, _ name: String, _ size: Int64, _ batch: String) { self.id = id; self.url = url; self.name = name; self.size = size; self.batch = batch } }
    private final class InFile { let id: String, name: String, size: Int64, batch: String, url: URL
        var task: URLSessionTask?
        init(_ id: String, _ name: String, _ size: Int64, _ batch: String, _ url: URL) { self.id = id; self.name = name; self.size = size; self.batch = batch; self.url = url } }
    private var outFiles: [String: OutFile] = [:]
    private var inFiles: [String: InFile] = [:]
    private(set) var batches: [String: Batch] = [:]

    @discardableResult
    func sendFiles(_ urls: [URL]) -> Bool {
        guard connected, !urls.isEmpty else { return false }
        let batch = UUID().uuidString
        let items = urls.map { u -> (URL, Int64) in (u, Int64((try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)) }
        let bytes = items.reduce(0) { $0 + $1.1 }
        batches[batch] = Batch(id: batch, up: true, name: items.count == 1 ? items[0].0.lastPathComponent : "\(items.count) items", count: items.count, bytes: bytes)
        for (i, it) in items.enumerated() {
            let id = UUID().uuidString
            let name = it.0.lastPathComponent
            outFiles[id] = OutFile(id, it.0, name, it.1, batch)
            send(msg("f.offer", ["id": id, "name": name, "size": it.1, "batch": batch, "count": items.count, "index": i, "bytes": bytes, "rel": name]))
        }
        changed()
        return true
    }

    private func request(_ path: String, _ method: String) -> URLRequest? {
        guard connected, !key.isEmpty, let h = link.host else { return nil }
        let a = link.address.contains(":") ? "[\(link.address)]" : link.address
        guard let u = URL(string: "https://\(a):\(h.port)\(path)") else { return nil }
        var r = URLRequest(url: u)
        r.httpMethod = method
        r.setValue(key, forHTTPHeaderField: Self.header)
        r.timeoutInterval = 60
        return r
    }

    private func enc(_ id: String) -> String { id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id }

    private func outAccepted(_ id: String) {
        guard let f = outFiles[id] else { return }
        guard var r = request("/peer/f/\(enc(id))", "PUT") else { return outDone(id, false) }
        r.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        r.setValue(String(f.size), forHTTPHeaderField: "Content-Length")
        let t = link.urlSession.uploadTask(with: r, fromFile: f.url) { [weak self] _, res, err in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if err != nil || (res as? HTTPURLResponse)?.statusCode != 200 {
                    NSLog("TwinDesk: peer: send %@: %@", f.name, err?.localizedDescription ?? "HTTP \((res as? HTTPURLResponse)?.statusCode ?? 0)")
                    self.send(msg("f.cancel", ["id": id]))
                    self.outDone(id, false)
                } else { self.moved(f.batch, f.size) }
            }
        }
        t.resume()
    }

    private func outDone(_ id: String, _ ok: Bool) {
        guard let f = outFiles.removeValue(forKey: id) else { return }
        finished(f.batch, ok)
    }

    private func clean(_ s: String) -> String {
        var n = s.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_").replacingOccurrences(of: "\\", with: "_")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if n.isEmpty || n == "." || n == ".." { n = "file" }
        return String(n.prefix(200))
    }

    private func inOffer(_ m: JSON) {
        let id = m.str("id", max: 128)
        let size = m.int64("size", -1)
        guard !id.isEmpty, inFiles[id] == nil else { return }
        guard size >= 0, size <= Proto.fileMaxBytes else { send(msg("f.cancel", ["id": id])); return }
        let rel = (m.str("rel", max: 1000).isEmpty ? m.str("name", max: 255) : m.str("rel", max: 1000)).split(separator: "/").map { clean(String($0)) }
        guard !rel.isEmpty else { send(msg("f.cancel", ["id": id])); return }
        let bid = m.str("batch", max: 128).isEmpty ? id : m.str("batch", max: 128)
        let count = max(1, m.int("count", 1))
        if batches[bid] == nil {
            batches[bid] = Batch(id: bid, up: false, name: count == 1 ? rel.last! : "\(count) items", count: count, bytes: m.int64("bytes", size))
        }
        var dir = Files.receivedDir
        for p in rel.dropLast() { dir.appendPathComponent(p, isDirectory: true) }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var url = dir.appendingPathComponent(rel.last!)
        var k = 2
        while FileManager.default.fileExists(atPath: url.path) {
            let base = (rel.last! as NSString).deletingPathExtension, ext = (rel.last! as NSString).pathExtension
            url = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(k)" : "\(base) \(k).\(ext)")
            k += 1
        }
        let f = InFile(id, rel.last!, size, bid, url)
        inFiles[id] = f
        send(msg("f.accept", ["id": id]))
        guard let r = request("/peer/f/\(enc(id))", "GET") else { return inFailed(id) }
        let t = link.urlSession.downloadTask(with: r) { [weak self] tmp, res, err in
            var ok = err == nil && (res as? HTTPURLResponse)?.statusCode == 200 && tmp != nil
            if ok, let tmp = tmp {
                let n = (try? FileManager.default.attributesOfItem(atPath: tmp.path)[.size] as? NSNumber)?.int64Value ?? -1
                ok = n == size && (try? FileManager.default.moveItem(at: tmp, to: url)) != nil
            }
            DispatchQueue.main.async {
                guard let self = self, self.inFiles[id] === f else { return }
                if ok {
                    self.inFiles.removeValue(forKey: id)
                    self.moved(bid, size)
                    self.send(msg("f.done", ["id": id, "ok": true]))
                    self.finished(bid, true)
                } else {
                    self.send(msg("f.cancel", ["id": id]))
                    self.inFailed(id)
                }
            }
        }
        f.task = t
        t.resume()
    }

    private func inFailed(_ id: String) {
        guard let f = inFiles.removeValue(forKey: id) else { return }
        f.task?.cancel()
        try? FileManager.default.removeItem(at: f.url)
        finished(f.batch, false)
    }

    private func moved(_ batch: String, _ n: Int64) {
        batches[batch]?.moved += n
        changed()
    }

    private func finished(_ batch: String, _ ok: Bool) {
        guard var b = batches[batch] else { return }
        b.done += 1
        if !ok { b.ok = false }
        batches[batch] = b
        guard b.done >= b.count else { return changed() }
        batches.removeValue(forKey: batch)
        if b.up { Notifier.shared.filesOut(b.name, ok: b.ok, to: peerName) }
        else { Notifier.shared.filesIn(b.name, ok: b.ok, from: peerName) }
        changed()
    }

    // ---- requests both ways ----

    private var calls: [String: (JSON) -> Void] = [:]

    // Ask the Android phone; the answer comes on main ({error} when it can't).
    func ask(_ op: String, _ args: JSON = [:], timeout: TimeInterval = 20, _ cb: @escaping (JSON) -> Void) {
        guard connected else { return cb(["error": "Not connected"]) }
        let id = Proto.randomHex(8)
        calls[id] = cb
        var m = args
        m["t"] = "q"; m["qid"] = id; m["op"] = op
        send(m)
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            if let cb = self?.calls.removeValue(forKey: id) { cb(["error": "No answer"]) }
        }
    }

    // Its requests to us: this iPhone's Photos (when allowed here and in iOS).
    private func answer(_ m: JSON) {
        let qid = m.str("qid", max: 40)
        let reply = { (r: JSON) in var r = r; r["t"] = "r"; r["qid"] = qid; self.send(r) }
        let perm: String = photosOn ? PhotoAccess.now.wire : "none"
        let photos = perm == "ok" || perm == "partial"
        switch m.str("op", max: 30) {
        case "perms": reply(["messages": "none", "media": perm, "files": "none"])
        case "ask":
            if m.str("what", max: 20) == "media" && photosOn { core.hub.askPhotos() }
            reply(["ok": true])
        case "media.list":
            guard photos else { return reply(["error": "perm", "perm": perm]) }
            work.async { let p = self.core.hub.page(m); DispatchQueue.main.async { reply(["items": p["items"] ?? [], "more": p["more"] ?? false, "next": p["next"] ?? ""]) } }
        case "media.thumb":
            guard photos else { return reply(["error": "perm", "perm": perm]) }
            core.hub.image(m.str("id", max: 40), 256, quality: 0.72, fast: true) { d in DispatchQueue.main.async { reply(["data": d ?? NSNull()]) } }
        case "media.view":
            guard photos else { return reply(["error": "perm", "perm": perm]) }
            core.hub.image(m.str("id", max: 40), 1600, quality: 0.85, fast: false) { d in DispatchQueue.main.async { reply(["data": d ?? NSNull()]) } }
        case "media.save":
            guard photos else { return reply(["error": "perm", "perm": perm]) }
            let ids = Array(((m["ids"] as? [String]) ?? []).prefix(500))
            core.hub.originals(ids) { urls in self.sendFiles(urls) }
            reply(["ok": true, "n": ids.count])
        case "screen.start": reply(["error": "The iPhone’s screen goes to computers only (Share Screen)"])
        default: reply(["error": "unknown"])
        }
    }

    // ---- its screen, here ----

    private(set) var screenOn = false
    private(set) var screenError = ""
    let screen = PeerScreenFeed()

    func startScreen() {
        screenError = ""
        screenOn = true
        changed()
        let side = Int(max(UIScreen.main.nativeBounds.width, UIScreen.main.nativeBounds.height))
        ask("screen.start", ["maxSize": min(1920, side)]) { [weak self] r in
            guard let self = self else { return }
            if let e = r["error"] as? String { self.screenError = e; self.changed() }
        }
    }

    private func screenReady() {
        guard screenOn, var r = request("/peer/screen", "GET"), let fp = link.host?.fp else { return }
        r.timeoutInterval = 3600
        screen.fetch(r, pin: fp) { [weak self] in self?.screenEnded(tell: false) }
    }

    func stopScreen() { screenEnded(tell: true) }

    private func screenEnded(tell: Bool = false) {
        if tell && screenOn && connected { send(msg("screen.stop")) }
        screen.stop()
        if screenOn { screenOn = false; changed() }
    }
}

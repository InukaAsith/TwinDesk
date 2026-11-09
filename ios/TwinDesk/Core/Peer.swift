// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Phones (Android's Peer.kt, the same protocol): this iPhone and another phone with TwinDesk, an
// Android phone or an iPhone. One session at a time, as on the computers: a phone's ends the
// computer's and a computer's ends the phone's (Core.linkWelcome), and while a phone holds it the
// app's pages are that phone's, only what both can do (peer.info's caps; RootView's pages).
// Roles: the phone that taps Connect is the guest, the other the host. The guest's side is a second
// Link (pairing by code, hello, pings) with its own paired list ("peerHosts"); the host runs
// PeerServer (with Host for other phones on, or for a while when asked: peer.ask over discovery,
// which a paired phone gets at once and a new one after Allow). After the first pairing each phone
// gives the other a token for itself (peer.rev), so either can connect to the other later.
//
// On the session, the same messages both ways: clip, notif, files (f.*), requests (q → r: the other
// phone's Photos and Messages, its screen) and screen.*. The bytes of files and the screen go in HTTPS
// requests to the host (the guest's PUT/POST or GET) with the session's key (peer.key).
import Foundation
import UIKit
import Photos
import Network

final class Peer: NSObject, LinkEvents, PeerServerHandler {
    static let hostsList = "peerHosts"
    static let header = "x-twindesk-peer"

    unowned let core: Core
    let link = Link(list: Peer.hostsList)
    private let work = DispatchQueue(label: "td.peer.work")

    // main
    private(set) var role = "" // "" | host | guest
    private(set) var peerId = ""
    private(set) var peerName = ""
    private(set) var peerModel = ""
    private(set) var message = ""
    private(set) var waitingFor = ""
    private var waitUntil = Date.distantPast
    private var key = ""
    private var resumeUntil = Date.distantPast
    var connected: Bool { !role.isEmpty }
    // The other phone: its os (pairing, its hello) and what it can do (peer.info's caps).
    private(set) var peerOs = ""
    private var peerCaps: Set<String>?
    func can(_ c: String) -> Bool { (peerCaps ?? Peer.defaultCaps(peerOs)).contains(c) }
    // What this iPhone offers (the same names in our peer.info): no messages or storage to browse.
    var myCaps: Set<String> { photosOn ? ["clip", "notifs", "files", "screen", "photos"] : ["clip", "notifs", "files", "screen"] }
    // A phone older than caps: an iPhone has no messages or storage to browse; an Android phone has all.
    static func defaultCaps(_ os: String) -> Set<String> {
        os == "ios" ? ["clip", "notifs", "files", "screen", "photos"] : ["clip", "notifs", "files", "screen", "photos", "messages", "fs"]
    }
    private func info() -> JSON { ["model": core.store.model, "os": Proto.os, "caps": Array(myCaps).sorted()] }
    // One session: the computer's ends as a phone's starts.
    private func takeOver() {
        if core.connected || core.state == "connecting" { NSLog("TwinDesk: peer: ending the computer's session for %@", peerName); core.disconnect() }
    }

    // ---- hosting ----
    let server = PeerServer()
    private var hostWs: PeerServer.Ws?
    private(set) var hostPort: UInt16 = 0
    private var starting = false
    private var tempUntil = Date.distantPast // hosting because we were asked, until then
    var hostOn: Bool { core.store.flag("peer.host", false) }
    struct PairReq {
        let ws: PeerServer.Ws
        let id: String, name: String, commit: String, nm: String
        var nw = "", code = ""
        var confirmed = false, allowed = false
        let at = Date()
    }
    private(set) var pairing: PairReq? // a phone pairing with us: the code, Allow / Deny
    fileprivate var pairFails: [String: [Date]] = [:] // failed pairings per address (pairFailed)
    private(set) var asked: Found? // a phone asked us to host, not paired yet
    private var guests: [String: JSON] {
        get { (UserDefaults.standard.dictionary(forKey: "peer.guests") as? [String: JSON]) ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: "peer.guests") }
    }
    private var myFp: String { PeerKey.fingerprint }

    var on: Bool { core.store.flag("peer.on", false) }
    var clipOn: Bool { core.store.flag("peer.clip", true) }
    var notifsOn: Bool { core.store.flag("peer.notifs", true) }
    var photosOn: Bool { core.store.flag("peer.photos", true) }
    func set(_ k: String, _ v: Bool) {
        core.store.setFlag(k, v)
        if k == "peer.on" && !v { disconnect(); asked = nil }
        if k == "peer.photos" && connected { send(msg("peer.info", info())) } // what it can do here changed
        hosting()
        changed()
    }

    init(_ core: Core) {
        self.core = core
        super.init()
        link.events = self
        core.discovery.peerOn = { [weak self] in self?.on ?? false }
        core.discovery.onPeer = { [weak self] f, m in self?.onPeer(f, m) }
        core.discovery.peerPort = { [weak self] in self?.hostPort ?? 0 }
        server.handler = self
        core.mirror.peerTap = { [weak self] p in self?.screenOut.packet(p) }
        NotificationCenter.default.addObserver(forName: UIPasteboard.changedNotification, object: nil, queue: .main) { [weak self] _ in self?.clipNow() }
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.clipNow() }
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
    }

    private func changed() { core.changed() }

    func paired() -> [Computer] { core.store.hosts(Self.hostsList) }
    func nearby() -> [Found] { core.discovery.phoneList() }
    func isPaired(_ id: String) -> Bool { guests[id] != nil || paired().contains { $0.id == id } }
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
        if role == "host", let w = hostWs { w.send(text(msg(Proto.T.bye))); w.close() }
        else { link.disconnect() }
        if link.pair != nil { link.cancelPairing() }
    }

    private func text(_ m: JSON) -> String { encodeJSON(m) ?? "{}" }

    func forget(_ id: String) {
        if peerId == id && connected { send(msg("peer.forget")); disconnect() }
        core.store.forgetHost(id, Self.hostsList)
        var g = guests; g.removeValue(forKey: id); guests = g
        changed()
    }

    private func onPeer(_ f: Found, _ m: JSON) {
        switch m.str("t", max: 30) {
        case "peer.ask":
            if connected || !on { return }
            if hostOn || guests[f.id] != nil || paired().contains(where: { $0.id == f.id }) { return allowHost(f) }
            if asked?.id == f.id { return }
            asked = f
            Notifier.shared.note("peer.ask", tr("{name} requests a connection", ["name": f.name]), tr("Open TwinDesk to allow the connection."))
            changed()
        case "peer.hosting":
            let p = m.int("port")
            guard waitingFor == f.id, (1...65535).contains(p) else { return }
            core.discovery.setPhonePort(f.id, f.address, UInt16(p))
            waitingFor = ""
            var g = f
            g.port = UInt16(p)
            connect(g)
        case "peer.no":
            if waitingFor == f.id { waitingFor = ""; message = tr("{name} said not now.", ["name": f.name]); changed() }
        default: break
        }
    }

    private var ticks = 0
    private func tick() {
        ticks += 1
        // The host's side of liveness: the guest pings every second.
        if let w = hostWs {
            if Date().timeIntervalSince(w.lastRx) > Proto.timeout { NSLog("TwinDesk: peer: %@ stopped answering", peerName); w.close(); wsClose(w) }
            else { w.send(text(msg(Proto.T.ping, ["ts": Int(Date().timeIntervalSince1970 * 1000)]))) }
        }
        if let p = pairing, Date().timeIntervalSince(p.at) > 60 { pairing = nil; pairFailed(p.ws); fail(p.ws, Proto.E.pairTimeout, "Pairing timed out"); changed() }
        if ticks % 5 == 0 { hosting() }
        if !waitingFor.isEmpty {
            if let f = core.discovery.phone(waitingFor), f.port > 0 { waitingFor = ""; connect(f) }
            else if Date() > waitUntil {
                let name = core.discovery.phone(waitingFor)?.name ?? tr("That phone")
                waitingFor = ""
                message = tr("{name} didn’t answer. Open TwinDesk on it, or turn on Host for other phones there.", ["name": name])
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
            self.peerOs = host.os
            self.peerCaps = nil
            self.key = ""
            NSLog("TwinDesk: peer: session with %@", host.name)
            // A token for the other way (it can connect to us later), and our certificate.
            if !self.myFp.isEmpty {
                let token = Proto.randomHex(32)
                var g = self.guests
                g[host.id] = ["name": host.name, "tokenHash": Proto.sha256(Data(token.utf8)).hex, "at": Date().timeIntervalSince1970]
                self.guests = g
                self.send(msg("peer.rev", ["token": token, "fp": self.myFp, "port": Int(PeerServer.port)]))
            }
            self.send(msg("peer.info", self.info()))
            self.takeOver()
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
        peerCaps = nil
        screenAsked = nil
        let waiting = calls
        calls.removeAll()
        for (_, cb) in waiting { cb(["error": tr("Disconnected")]) }
        for id in Array(inFiles.keys) { inFailed(id) }
        outFiles.removeAll()
        screenEnded()
        screenOut.stop()
        hosting()
        changed()
    }

    @discardableResult
    func send(_ m: JSON) -> Bool {
        if role == "host" { guard let w = hostWs else { return false }; w.send(text(m)); return true }
        return link.send(m)
    }

    private func dispatch(_ t: String, _ m: JSON) {
        switch t {
        case "peer.key": key = m.str("key", max: 64)
        case "peer.info":
            peerModel = m.str("model", max: 80)
            let os = m.str("os", max: 20)
            if !os.isEmpty { peerOs = os }
            if let a = m["caps"] as? [Any] { peerCaps = Set(a.compactMap { ($0 as? String).map { String($0.prefix(20)) } }) }
            changed()
        case "peer.forget": forget(peerId)
        case "peer.rev":
            guard role == "host" else { return }
            let token = m.str("token", max: 64), fp = Proto.normFingerprint(m["fp"] as? String)
            let p = m.int("port", Int(PeerServer.port))
            guard Proto.isHex(token, min: 64, max: 64), Proto.isHex(fp, min: 64, max: 64) else { return }
            let near = core.discovery.phone(peerId)
            core.store.putHost(Computer(id: peerId, name: peerName, os: near?.os ?? "android", address: near?.address ?? hostWs?.address ?? "",
                                        port: (1...65535).contains(p) ? UInt16(p) : PeerServer.port, fp: fp, token: token,
                                        lastSeen: Date().timeIntervalSince1970), Self.hostsList)
        case "clip": clipIn(m)
        case "notif": notifIn(m)
        case "f.offer": inOffer(m)
        case "f.accept": outAccepted(m.str("id", max: 128))
        case "f.done": outDone(m.str("id", max: 128), m.bool("ok"))
        case "f.cancel": let id = m.str("id", max: 128); inFailed(id); outFiles.removeValue(forKey: id)
        case "q": answer(m)
        case "r": if let cb = calls.removeValue(forKey: m.str("qid", max: 40)) { cb(m) }
        case "screen.ready": screenReady()
        case "screen.stop": screenEnded(); screenOut.stop()
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
        guard !core.clip.ownOnBoard, pb.hasStrings, let text = pb.string else { return } // TwinDesk's own copy: never read
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
        core.clip.write(text) // marked as TwinDesk's, kept on this device (Clip.put)
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
        batches[batch] = Batch(id: batch, up: true, name: items.count == 1 ? items[0].0.lastPathComponent : trCount(items.count, "item"), count: items.count, bytes: bytes)
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
        if role == "host" { return } // the guest GETs it
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
            batches[bid] = Batch(id: bid, up: false, name: count == 1 ? rel.last! : trCount(count, "item"), count: count, bytes: m.int64("bytes", size))
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
        if role == "host" { // the guest PUTs it
            if size == 0 { FileManager.default.createFile(atPath: url.path, contents: nil); inDone(f) }
            return
        }
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

    private func inDone(_ f: InFile) {
        guard inFiles[f.id] === f else { return }
        inFiles.removeValue(forKey: f.id)
        send(msg("f.done", ["id": f.id, "ok": true]))
        finished(f.batch, true)
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
        guard connected else { return cb(["error": tr("Not connected")]) }
        let id = Proto.randomHex(8)
        calls[id] = cb
        var m = args
        m["t"] = "q"; m["qid"] = id; m["op"] = op
        send(m)
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            if let cb = self?.calls.removeValue(forKey: id) { cb(["error": tr("No answer")]) }
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
        case "screen.start":
            let size = min(1920, max(480, m.int("maxSize", 1600)))
            guard core.mirror.sharing else {
                // Remembered: starting Share Screen here sends it straight away (shareStarted).
                screenAsked = size
                Notifier.shared.note("peer.screen", tr("{name} wants to see this screen", ["name": peerName]), tr("Start Share Screen in TwinDesk to show it."))
                return reply(["error": "Start Share Screen on \(core.store.deviceName) (TwinDesk › Share screen). It appears here once started."])
            }
            reply(["ok": true])
            sendScreen(size)
        default: reply(["error": "unknown"])
        }
    }

    // ---- our screen, there ----

    private var screenAsked: Int? // it asked before Share Screen was started here (its maxSize)

    private func sendScreen(_ size: Int) {
        screenAsked = nil
        core.mirror.peerWant(size)
        if role == "host" { send(msg("screen.ready")) } // it GETs our screen
        else if let r = request("/peer/screen", "POST"), let fp = link.host?.fp { screenOut.post(r, pin: fp) } // we POST it
    }

    // Share Screen started here while a phone holds the session: to it, if it asked already.
    func shareStarted() {
        guard connected else { return }
        if let size = screenAsked { sendScreen(size) }
    }

    // ---- its screen, here ----

    let screenOut = PeerScreenOut()
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

    // As the host: the guest's screen comes in its POST.
    private func screenIn(_ r: PeerServer.Request) {
        guard screenOn else { return r.respond(409) }
        screen.begin { [weak self] in self?.screenEnded(tell: false) }
        func more() {
            r.read { [weak self] d, err in
                guard let self = self else { return }
                if let d = d { self.screen.push(d); return more() }
                r.respond(err ? 500 : 200)
                DispatchQueue.main.async { self.screen.finished() }
            }
        }
        more()
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

// ---- PeerServerHandler: the host's side (main) ----

extension Peer {
    func wsOpen(_ ws: PeerServer.Ws) {}

    func wsText(_ ws: PeerServer.Ws, _ t: String) {
        guard let m = decodeJSON(t) else { return ws.close() }
        let type = m.str("t", max: 40)
        if ws === hostWs {
            switch type {
            case Proto.T.ping: ws.send(text(msg(Proto.T.pong, ["ts": m["ts"] ?? 0])))
            case Proto.T.pong: break
            case Proto.T.bye: ws.close(); wsClose(ws)
            default: dispatch(type, m)
            }
            return
        }
        switch type {
        case Proto.T.pairStart: pairStart(ws, m)
        case Proto.T.pairReveal:
            guard var p = pairing, p.ws === ws else { return }
            let nonce = m.str("nonce", max: 64)
            guard p.nw.isEmpty, Proto.isHex(nonce, min: 32, max: 32), Proto.commitOf(nonce) == p.commit else {
                pairing = nil; pairFailed(ws); changed()
                return fail(ws, Proto.E.pairRefused, "Nonce does not match")
            }
            p.nw = nonce
            p.code = Proto.sasCode(fp: myFp, nw: nonce, nm: p.nm)
            pairing = p
            Notifier.shared.note("peer.pair", tr("Pair with {name}?", ["name": p.name]), tr("Check that both phones show the same code in TwinDesk."))
            changed()
        case Proto.T.pairConfirm:
            guard var p = pairing, p.ws === ws, !p.code.isEmpty else { return }
            p.confirmed = true
            pairing = p
            finishPair()
        case Proto.T.pairCancel:
            if pairing?.ws === ws { pairing = nil; pairFailed(ws); changed() }
            ws.close()
        case Proto.T.hello: hello(ws, m)
        default: fail(ws, "bad_message", "\"\(type)\" before welcome")
        }
    }

    func wsClose(_ ws: PeerServer.Ws) {
        if pairing?.ws === ws { pairing = nil; pairFailed(ws); changed() }
        if ws === hostWs { hostWs = nil; ended() }
    }

    private func fail(_ ws: PeerServer.Ws, _ code: String, _ why: String) {
        ws.send(text(msg(Proto.T.error, ["code": code, "message": why])))
        ws.close()
    }

    // Failed pairings per address, as shared/pairfail.js: after 5 in 10 minutes that address can't
    // start another for a while, so a phone on the network can't keep popping the dialog.
    private func pairFailed(_ ws: PeerServer.Ws) {
        let a = ws.address
        guard !a.isEmpty, a != "127.0.0.1" else { return }
        pairFails[a] = (pairFails[a] ?? []).filter { Date().timeIntervalSince($0) < 600 } + [Date()]
    }
    private func pairLocked(_ ws: PeerServer.Ws) -> Bool {
        let live = (pairFails[ws.address] ?? []).filter { Date().timeIntervalSince($0) < 600 }
        pairFails[ws.address] = live.isEmpty ? nil : live
        return live.count >= 5
    }

    private func pairStart(_ ws: PeerServer.Ws, _ m: JSON) {
        if pairLocked(ws) { return fail(ws, Proto.E.pairRefused, "Too many failed pairing attempts; wait a few minutes and try again") }
        if let p = pairing, p.ws !== ws { return fail(ws, Proto.E.busy, "Another pairing is in progress") }
        if m.int("v") != Proto.version { return fail(ws, Proto.E.versionMismatch, "Different TwinDesk version") }
        let id = m.str("id", max: 64), commit = m.str("commit", max: 64)
        guard !id.isEmpty, Proto.isHex(commit, min: 64, max: 64) else { pairFailed(ws); return fail(ws, "bad_message", "pair.start needs id and commit") }
        guard !myFp.isEmpty else { return fail(ws, Proto.E.busy, "This iPhone can’t host") }
        let nm = Proto.randomHex(16)
        let name = m.str("name", max: 64)
        pairing = PairReq(ws: ws, id: id, name: name.isEmpty ? "Phone" : name, commit: commit, nm: nm)
        ws.send(text(msg(Proto.T.pairNonce, ["nonce": nm, "os": Proto.os])))
        hosting()
        changed()
    }

    // Allow / Deny here.
    func respondPair(_ allow: Bool) {
        guard var p = pairing else { return }
        if !allow { pairing = nil; pairFailed(p.ws); fail(p.ws, Proto.E.pairRefused, "Refused"); return changed() }
        guard !p.code.isEmpty else { return }
        p.allowed = true
        pairing = p
        finishPair()
    }

    private func finishPair() {
        guard let p = pairing else { return }
        changed()
        guard p.confirmed, p.allowed else { return }
        let token = Proto.randomHex(32)
        var g = guests
        g[p.id] = ["name": p.name, "tokenHash": Proto.sha256(Data(token.utf8)).hex, "at": Date().timeIntervalSince1970]
        guests = g
        p.ws.send(text(msg(Proto.T.pairOk, ["token": token, "macId": core.store.deviceId, "macName": core.store.deviceName, "os": Proto.os])))
        pairing = nil
        pairFails[p.ws.address] = nil
        NSLog("TwinDesk: peer: paired with %@", p.name)
        changed()
    }

    private func hello(_ ws: PeerServer.Ws, _ m: JSON) {
        if m.int("v") != Proto.version { return fail(ws, Proto.E.versionMismatch, "Different TwinDesk version") }
        let id = m.str("id", max: 64), token = m.str("token", max: 128)
        guard let e = guests[id], !token.isEmpty, (e["tokenHash"] as? String) == Proto.sha256(Data(token.utf8)).hex else {
            return fail(ws, Proto.E.badToken, "Not paired with this phone")
        }
        if role == "guest" { return fail(ws, Proto.E.busy, "Connected to another phone") }
        if let old = hostWs, old !== ws { old.send(text(msg(Proto.T.error, ["code": Proto.E.replaced, "message": "Connected again"]))); old.close() }
        if role == "host" { ended() }
        hostWs = ws
        role = "host"
        peerId = id
        let n = m.str("name", max: 64)
        peerName = n.isEmpty ? ((e["name"] as? String) ?? "Phone") : n
        peerOs = m.str("os", max: 20)
        peerCaps = nil
        var g = guests; var en = e; en["name"] = peerName; g[id] = en; guests = g
        key = Proto.randomHex(16)
        ws.send(text(msg(Proto.T.welcome, ["v": Proto.version, "macId": core.store.deviceId, "macName": core.store.deviceName, "os": Proto.os])))
        ws.send(text(msg("peer.key", ["key": key])))
        tempUntil = .distantPast
        message = ""
        asked = nil
        NSLog("TwinDesk: peer: session with %@ as host", peerName)
        send(msg("peer.info", info()))
        takeOver()
        hosting()
        changed()
    }

    // The server runs while it's wanted: the setting, an ask, a session, a pairing.
    func hosting() {
        let want = on && (hostOn || Date() < tempUntil || role == "host" || pairing != nil)
        if want && hostPort == 0 && !starting {
            starting = true
            server.start { [weak self] port in
                guard let self = self else { return }
                self.starting = false
                self.hostPort = port
                self.changed()
            }
        } else if !want && hostPort > 0 {
            server.stop()
            hostPort = 0
            changed()
        }
    }

    func setHostOn(_ v: Bool) { core.store.setFlag("peer.host", v); hosting(); changed() }

    // Hosting for a phone that asked: it hears where (peer.hosting).
    private func allowHost(_ f: Found) {
        tempUntil = Date().addingTimeInterval(120)
        let tell = { [weak self] in
            guard let self = self, self.hostPort > 0 else { return }
            self.core.discovery.sendTo(msg("peer.hosting", ["v": Proto.version, "id": self.core.store.deviceId, "name": self.core.store.deviceName, "port": Int(self.hostPort)]), f.address)
        }
        if hostPort > 0 { return tell() }
        starting = true
        server.start { [weak self] port in
            self?.starting = false
            self?.hostPort = port
            tell()
            self?.changed()
        }
    }

    func answerAsk(_ allow: Bool) {
        guard let f = asked else { return }
        asked = nil
        if allow { allowHost(f) }
        else { core.discovery.sendTo(msg("peer.no", ["v": Proto.version, "id": core.store.deviceId, "name": core.store.deviceName]), f.address) }
        changed()
    }

    var hostPairing: PairReq? { pairing }

    // HTTPS on our server: the files' bytes and the screen, with the session's key, from its address.
    func request(_ r: PeerServer.Request) {
        guard role == "host", let ws = hostWs, !key.isEmpty, r.headers[Self.header] == key, r.address == ws.address else { return r.respond(403) }
        let path = r.path.components(separatedBy: "?")[0]
        if path.hasPrefix("/peer/f/") {
            let id = String(path.dropFirst("/peer/f/".count)).removingPercentEncoding ?? ""
            if r.method == "PUT" { return putIn(id, r) }
            if r.method == "GET" { return getOut(id, r) }
            return r.respond(400)
        }
        if path == "/peer/screen" {
            if r.method == "GET" { return screenOut.serve(r) }
            if r.method == "POST" { return screenIn(r) }
        }
        r.respond(404)
    }

    private func putIn(_ id: String, _ r: PeerServer.Request) {
        guard let f = inFiles[id] else { return r.respond(404) }
        FileManager.default.createFile(atPath: f.url.path, contents: nil)
        guard let h = try? FileHandle(forWritingTo: f.url) else { return r.respond(500) }
        var got: Int64 = 0
        var last = Date()
        var pending: Int64 = 0
        func more() {
            r.read { [weak self] d, err in
                guard let self = self else { return }
                if let d = d {
                    if got + Int64(d.count) > f.size { try? h.close(); r.respond(400); return DispatchQueue.main.async { self.inFailed(id) } }
                    do { try h.write(contentsOf: d) } catch { try? h.close(); r.respond(500); return DispatchQueue.main.async { self.inFailed(id) } }
                    got += Int64(d.count)
                    pending += Int64(d.count)
                    if Date().timeIntervalSince(last) > 0.2 { let n = pending; pending = 0; last = Date(); DispatchQueue.main.async { self.moved(f.batch, n) } }
                    return more()
                }
                try? h.close()
                let ok = !err && got == f.size
                r.respond(ok ? 200 : 500)
                let n = pending
                DispatchQueue.main.async {
                    if n > 0 { self.moved(f.batch, n) }
                    if ok { self.inDone(f) } else { self.inFailed(id) }
                }
            }
        }
        more()
    }

    private func getOut(_ id: String, _ r: PeerServer.Request) {
        guard let f = outFiles[id], let h = try? FileHandle(forReadingFrom: f.url) else { return r.respond(404) }
        r.streamHead(f.size)
        let batch = f.batch
        work.async {
            var left = f.size
            func next() {
                if left <= 0 { try? h.close(); return }
                let n = Int(min(left, 1 << 20))
                guard let d = try? h.read(upToCount: n), d.count == n else { try? h.close(); r.close(); return }
                left -= Int64(n)
                r.write(d) { ok in
                    if !ok { try? h.close(); return }
                    DispatchQueue.main.async { self.moved(batch, Int64(n)) }
                    self.work.async { next() }
                }
            }
            next()
        }
    }
}

// Our screen to the other phone (the broadcast's packets, Mirror.peerTap): as the host, the body of
// its GET; as the guest, the body of our POST to it (chunked).
final class PeerScreenOut {
    private let q = DispatchQueue(label: "td.peer.screenout")
    private var get: PeerServer.Request?
    private var post: NWConnection?
    private var inflight = 0
    private var head: [Data] = [] // the size and SPS/PPS packets: first in every new stream

    func packet(_ p: Data) {
        q.async {
            guard p.count >= 12 else { return }
            if p[p.startIndex] & 0x80 != 0 { self.head = [p] }
            else if p[p.startIndex] & 0x40 != 0 { self.head = Array(self.head.prefix(1)) + [p] }
            self.send(p)
        }
    }

    private func send(_ p: Data) {
        if inflight > 4 << 20 { return } // behind: dropped (the decoder waits for the next keyframe)
        if let r = get {
            inflight += p.count
            r.write(p) { ok in self.q.async { self.inflight -= p.count; if !ok { self.get = nil } } }
        } else if let c = post {
            var d = Data(String(p.count, radix: 16).utf8) + Data("\r\n".utf8)
            d.append(p)
            d.append(Data("\r\n".utf8))
            inflight += d.count
            let n = d.count
            c.send(content: d, completion: .contentProcessed { e in self.q.async { self.inflight -= n; if e != nil { self.post = nil } } })
        }
    }

    func serve(_ r: PeerServer.Request) {
        q.async {
            self.get?.close()
            self.get = r
            self.inflight = 0
            r.streamHead()
            for p in self.head { self.send(p) }
        }
    }

    func post(_ r: URLRequest, pin: String) {
        q.async {
            self.post?.cancel()
            guard let u = r.url, let host = u.host, let port = u.port else { return }
            let tls = NWProtocolTLS.Options()
            sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, done in
                done(Link.leafFingerprint(sec_trust_copy_ref(trust).takeRetainedValue()) == pin)
            }, self.q)
            let c = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: UInt16(port))!, using: NWParameters(tls: tls))
            self.post = c
            self.inflight = 0
            var h = "POST \(u.path) HTTP/1.1\r\nHost: \(host):\(port)\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n"
            for (k, v) in r.allHTTPHeaderFields ?? [:] where k.lowercased().hasPrefix("x-") { h += "\(k): \(v)\r\n" }
            c.stateUpdateHandler = { st in
                switch st {
                case .ready:
                    c.send(content: Data((h + "\r\n").utf8), completion: .contentProcessed { _ in })
                    self.q.async { for p in self.head { self.send(p) } }
                case .failed, .cancelled: self.q.async { if self.post === c { self.post = nil } }
                default: break
                }
            }
            c.start(queue: self.q)
        }
    }

    func stop() {
        q.async {
            self.get?.close(); self.get = nil
            if let c = self.post { c.send(content: Data("0\r\n\r\n".utf8), completion: .contentProcessed { _ in c.cancel() }) }
            self.post = nil
        }
    }
}

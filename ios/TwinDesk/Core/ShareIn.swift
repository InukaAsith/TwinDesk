// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The share sheet's Send to Computer (ios/Share/ShareViewController.swift) hands what was shared to
// us on 127.0.0.1:47831: files land in Caches/Outbox and go to the computer as File Sharing's (now,
// or once connected); text and links go to its clipboard. Loopback only.
//   in:  {"t":"hello"}  {"t":"file","name","size"} <size bytes>  {"t":"text","text"}  {"t":"end"}
//   out: {"ok":true,"to","connected"} after hello, {"done":true,"sent"} after end
import Foundation
import Network
import UIKit

final class ShareIn: Feature {
    static let port: UInt16 = 47831
    private let q = DispatchQueue(label: "td.sharein")
    private var listener: NWListener?
    private var pendingText: [String] = [] // main: for when the session is back

    override init(_ core: Core) {
        super.init(core)
        q.async { self.listen() }
    }

    private func listen() {
        let p = NWParameters.tcp
        p.allowLocalEndpointReuse = true
        p.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Self.port)!)
        guard let l = try? NWListener(using: p) else { return }
        l.newConnectionHandler = { [weak self] c in self?.serve(c) }
        l.stateUpdateHandler = { [weak self] st in
            if case .failed = st { l.cancel(); self?.q.asyncAfter(deadline: .now() + 3) { self?.listen() } }
        }
        l.start(queue: q)
        listener = l
    }

    override func onWelcome(_ host: Computer, _ m: JSON) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            let t = self.pendingText
            self.pendingText = []
            for s in t { self.core.clip.sendText(s) }
        }
    }

    private final class Session {
        var buf = Data()
        var file: (handle: FileHandle, url: URL, left: Int64)?
        var files: [URL] = []
        var texts: [String] = []
    }

    private func serve(_ c: NWConnection) {
        let s = Session()
        // Shared from another app (Photos in front, TwinDesk behind it): iOS would suspend us part
        // way through the bytes and the share sheet waited forever. Kept running while it lasts.
        var task = UIBackgroundTaskIdentifier.invalid
        DispatchQueue.main.async {
            task = UIApplication.shared.beginBackgroundTask(withName: "TwinDesk share") { c.cancel() }
        }
        c.stateUpdateHandler = { st in
            switch st {
            case .cancelled, .failed:
                DispatchQueue.main.async {
                    if task != .invalid { UIApplication.shared.endBackgroundTask(task); task = .invalid }
                }
            default: break
            }
        }
        c.start(queue: q)
        func reply(_ o: JSON) {
            guard var d = try? JSONSerialization.data(withJSONObject: o) else { return }
            d.append(10)
            c.send(content: d, completion: .contentProcessed { _ in })
        }
        func fail() {
            if let f = s.file { try? f.handle.close(); try? FileManager.default.removeItem(at: f.url) }
            c.cancel()
        }
        // What's in buf: a file's bytes, or lines.
        func take() -> Bool {
            while true {
                if let f = s.file {
                    if s.buf.isEmpty { return true }
                    let n = Int(min(Int64(s.buf.count), f.left))
                    do { try f.handle.write(contentsOf: s.buf.prefix(n)) } catch { return false }
                    s.buf = Data(s.buf.dropFirst(n))
                    let left = f.left - Int64(n)
                    if left == 0 {
                        try? f.handle.close()
                        s.files.append(f.url)
                        s.file = nil
                    } else { s.file = (f.handle, f.url, left); return true }
                    continue
                }
                guard let i = s.buf.firstIndex(of: 10) else { return s.buf.count < 1 << 20 }
                let line = s.buf[s.buf.startIndex..<i]
                s.buf = Data(s.buf[(i + 1)...])
                guard let o = (try? JSONSerialization.jsonObject(with: line)) as? JSON else { return false }
                switch o.str("t", max: 16) {
                case "hello":
                    let st = DispatchQueue.main.sync { (self.core.connected, self.core.link.host?.name ?? Store.shared.hosts().first?.name ?? "") }
                    reply(["ok": true, "connected": st.0, "to": st.1])
                case "text":
                    let t = o.str("text", max: Proto.clipMaxBytes)
                    if !t.isEmpty { s.texts.append(t) }
                case "file":
                    let size = o.int64("size", -1)
                    var name = (o.str("name", max: 200) as NSString).lastPathComponent
                    if name.isEmpty || name == "." || name == ".." { name = "Shared" }
                    guard size >= 0 else { return false }
                    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                        .appendingPathComponent("Outbox", isDirectory: true).appendingPathComponent(UUID().uuidString, isDirectory: true)
                    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                    let url = dir.appendingPathComponent(name)
                    guard FileManager.default.createFile(atPath: url.path, contents: nil), let h = try? FileHandle(forWritingTo: url) else { return false }
                    if size == 0 { try? h.close(); s.files.append(url) } else { s.file = (h, url, size) }
                case "end":
                    let files = s.files, texts = s.texts
                    s.files = []
                    s.texts = []
                    let sent = DispatchQueue.main.sync { () -> Bool in
                        let on = self.core.connected
                        if !files.isEmpty { self.core.files.queue(files) }
                        for t in texts { if on { self.core.clip.sendText(t) } else { self.pendingText.append(t) } }
                        if !files.isEmpty || !texts.isEmpty { self.core.changed() }
                        return on
                    }
                    reply(["done": true, "sent": sent])
                default: return false
                }
            }
        }
        func more() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { d, _, end, err in
                if let d = d { s.buf.append(d) }
                if !take() { return fail() }
                if end || err != nil {
                    if s.file != nil { fail() } else { c.cancel() }
                    return
                }
                more()
            }
        }
        more()
    }
}

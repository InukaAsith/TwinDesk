// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Send to Computer, in the share sheet: what's shared (files, photos, videos, a link, text) goes to
// TwinDesk (the app, on 127.0.0.1:47831, ShareIn.swift there), which sends it over its session:
// files as File Sharing's, text and links to the computer's clipboard. Through the app, as Share
// Screen does: no pairing, App Group or certificate of the extension's own. When the app isn't
// running (iOS ended it) there's nothing to hand them to: it says to open TwinDesk.
//
// To the app: a JSON line, then for a file its bytes:
//   {"t":"hello"}  {"t":"file","name","size"} <size bytes>  {"t":"text","text"}  {"t":"end"}
// From the app: {"ok":true,"to":"<computer>","connected":bool} after hello; {"done":true,"sent":bool} after end.
import UIKit
import Network
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private enum Item { case file(URL, String), text(String) }

    private let q = DispatchQueue(label: "td.share")
    private var conn: NWConnection?
    private var rx = Data()
    private let card = UIView()
    private let title_ = UILabel()
    private let detail = UILabel()
    private let bar = UIProgressView(progressViewStyle: .default)
    private let button = UIButton(type: .system)
    private var total: Int64 = 0
    private var sent: Int64 = 0
    private var finished = false
    private var lastProgress = Date() // q: when bytes last went (a stall ends it with a message)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.35)
        card.backgroundColor = UIColor(red: 0.12, green: 0.12, blue: 0.125, alpha: 1)
        card.layer.cornerRadius = 22
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(card)
        let icon = UIImageView(image: UIImage(systemName: "laptopcomputer.and.arrow.down"))
        icon.tintColor = UIColor(red: 0.04, green: 0.52, blue: 1, alpha: 1)
        icon.contentMode = .scaleAspectFit
        title_.font = .preferredFont(forTextStyle: .headline)
        title_.textColor = .white
        title_.text = tr("Send to Computer")
        detail.font = .preferredFont(forTextStyle: .subheadline)
        detail.textColor = UIColor(white: 1, alpha: 0.6)
        detail.numberOfLines = 0
        detail.text = tr("Getting the items ready…")
        bar.progressTintColor = icon.tintColor
        button.setTitle(tr("Cancel"), for: .normal)
        button.titleLabel?.font = .preferredFont(forTextStyle: .body)
        button.addTarget(self, action: #selector(close), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [icon, title_, detail, bar, button])
        stack.axis = .vertical
        stack.spacing = 12
        stack.alignment = .fill
        stack.setCustomSpacing(4, after: title_)
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)
        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(equalTo: view.widthAnchor, multiplier: 0.86),
            card.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
            icon.heightAnchor.constraint(equalToConstant: 34),
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 22),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -14),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -20),
        ])
        collect { items in self.q.async { self.deliver(items) } }
    }

    @objc private func close() {
        conn?.cancel()
        if finished { extensionContext?.completeRequest(returningItems: nil) }
        else { extensionContext?.cancelRequest(withError: NSError(domain: "TwinDesk", code: 1)) }
    }

    private func show(_ title: String, _ text: String, done: Bool = false) {
        DispatchQueue.main.async {
            self.title_.text = title
            self.detail.text = text
            if done {
                self.finished = true
                self.bar.isHidden = true
                self.button.setTitle(tr("Done"), for: .normal)
            }
        }
    }

    // ---- the items, as files in our temporary folder (theirs go away when the callback returns) ----

    private func collect(_ done: @escaping ([Item]) -> Void) {
        let providers = ((extensionContext?.inputItems as? [NSExtensionItem]) ?? []).flatMap { $0.attachments ?? [] }
        var out = [Item?](repeating: nil, count: providers.count)
        let g = DispatchGroup()
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        for (i, p) in providers.enumerated() {
            g.enter()
            // A photo or video is always the file (Photos' items can say URL too).
            let media = p.hasItemConformingToTypeIdentifier(UTType.image.identifier) || p.hasItemConformingToTypeIdentifier(UTType.audiovisualContent.identifier)
            let isFile = media || p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
            if !isFile, p.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                p.loadItem(forTypeIdentifier: UTType.url.identifier) { v, _ in
                    if let u = v as? URL { out[i] = .text(u.absoluteString) }
                    g.leave()
                }
                continue
            }
            if !isFile, p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), !p.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                p.loadItem(forTypeIdentifier: UTType.plainText.identifier) { v, _ in
                    if let s = v as? String { out[i] = .text(s) } else if let d = v as? Data, let s = String(data: d, encoding: .utf8) { out[i] = .text(s) }
                    g.leave()
                }
                continue
            }
            // A file: its own type first (a photo as the photo, not a converted copy). Photos lists
            // private types too (a Live Photo's bundle, thumbnails): those give a folder or nothing,
            // so a public image or video type comes first, then any other file type.
            let ids = p.registeredTypeIdentifiers
            let usable = ids.filter { !$0.hasPrefix("com.apple.private") && $0 != "com.apple.live-photo-bundle" }
            func pick(_ ok: (UTType) -> Bool) -> String? { usable.first { UTType($0).map(ok) ?? false } }
            let type = pick { $0.conforms(to: .image) || $0.conforms(to: .movie) || $0.conforms(to: .audiovisualContent) }
                ?? pick { $0.conforms(to: .data) && !$0.conforms(to: .directory) }
                ?? (p.hasItemConformingToTypeIdentifier(UTType.image.identifier) ? UTType.image.identifier : UTType.data.identifier)
            let dir = tmp.appendingPathComponent(String(i), isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let suggested = p.suggestedName ?? ""
            func named(_ ext: String, _ fallback: String) -> URL {
                var name = suggested.isEmpty ? fallback : suggested
                if !ext.isEmpty, !name.lowercased().hasSuffix("." + ext.lowercased()) { name = "\(name).\(ext)" }
                return dir.appendingPathComponent(name.replacingOccurrences(of: "/", with: "_"))
            }
            let ext = UTType(type)?.preferredFilenameExtension ?? ""
            p.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                if let url = url, !((try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false) {
                    let dest = suggested.isEmpty ? dir.appendingPathComponent(url.lastPathComponent) : named(url.pathExtension, url.lastPathComponent)
                    if (try? FileManager.default.copyItem(at: url, to: dest)) != nil { out[i] = .file(dest, dest.lastPathComponent); g.leave(); return }
                }
                // No file for it: what the item gives as such (a URL, its bytes or a picture).
                p.loadItem(forTypeIdentifier: type) { v, _ in
                    defer { g.leave() }
                    let dest = named(ext, "Shared item")
                    if let u = v as? URL, u.isFileURL, case let d = named(u.pathExtension, u.lastPathComponent), (try? FileManager.default.copyItem(at: u, to: d)) != nil {
                        out[i] = .file(d, d.lastPathComponent)
                    } else if let d = v as? Data, (try? d.write(to: dest)) != nil {
                        out[i] = .file(dest, dest.lastPathComponent)
                    } else if let img = v as? UIImage, let d = img.jpegData(compressionQuality: 0.92) {
                        let j = named("jpg", "Photo")
                        if (try? d.write(to: j)) != nil { out[i] = .file(j, j.lastPathComponent) }
                    }
                }
            }
        }
        g.notify(queue: .main) { done(out.compactMap { $0 }) }
    }

    // ---- to the app ----

    private func deliver(_ items: [Item]) {
        if items.isEmpty { return show(tr("Nothing to send"), tr("TwinDesk couldn’t read what was shared."), done: true) }
        for it in items { if case .file(let u, _) = it { total += Int64((try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) } }
        let c = NWConnection(host: "127.0.0.1", port: 47831, using: .tcp)
        conn = c
        var started = false
        c.stateUpdateHandler = { [weak self] st in
            guard let self = self else { return }
            switch st {
            case .ready:
                if started { return }
                started = true
                self.line(["t": "hello"])
                self.readLine(timeout: 4) { o in
                    guard let o = o, o["ok"] as? Bool == true else { return self.notRunning() }
                    let to = (o["to"] as? String) ?? ""
                    let on = o["connected"] as? Bool == true
                    self.show(on ? tr("Sending to {name}", ["name": to.isEmpty ? tr("the computer") : to]) : tr("Send to Computer"),
                              on ? self.summary(items) : tr("TwinDesk isn’t connected: they go when it is."))
                    self.send(items, 0)
                }
            case .failed, .waiting: if !started { started = true; self.notRunning() }
            default: break
            }
        }
        c.start(queue: q)
    }

    private func summary(_ items: [Item]) -> String {
        let files = items.filter { if case .file = $0 { return true }; return false }.count
        let texts = items.count - files
        var parts: [String] = []
        if files > 0 { parts.append(files == 1 ? tr("1 file") : tr("{files} files", ["files": files])) }
        if texts > 0 { parts.append(tr("text to its clipboard")) }
        return parts.joined(separator: " and ")
    }

    private func notRunning() {
        conn?.cancel()
        show(tr("TwinDesk isn’t running"), tr("Open TwinDesk, then share again. With Stay connected on (General) it keeps running in the background and this works from anywhere."), done: true)
    }

    private func line(_ o: [String: Any]) {
        guard var d = try? JSONSerialization.data(withJSONObject: o) else { return }
        d.append(10)
        conn?.send(content: d, completion: .contentProcessed { _ in })
    }

    private func send(_ items: [Item], _ i: Int) {
        guard i < items.count else {
            line(["t": "end"])
            return readLine(timeout: 30) { o in
                let on = o?["sent"] as? Bool == true
                self.show(o == nil ? tr("Something went wrong") : on ? tr("Sent") : tr("Waiting to send"),
                          o == nil ? tr("TwinDesk stopped answering.") : on ? tr("It’s on its way to the computer.") : tr("TwinDesk sends them once it’s connected."), done: true)
                if o != nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { self.close() } }
            }
        }
        switch items[i] {
        case .text(let s):
            line(["t": "text", "text": s])
            send(items, i + 1)
        case .file(let u, let name):
            let size = Int64((try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            guard let fh = try? FileHandle(forReadingFrom: u) else { return send(items, i + 1) }
            line(["t": "file", "name": name, "size": size])
            lastProgress = Date()
            watchStall()
            var left = size
            func pump() {
                if left <= 0 { try? fh.close(); try? FileManager.default.removeItem(at: u); return send(items, i + 1) }
                let n = Int(min(left, 1 << 20))
                var d = (try? fh.read(upToCount: n)) ?? Data()
                if d.count < n { d.append(Data(count: n - d.count)) } // the file shrank: its size was promised
                left -= Int64(n)
                conn?.send(content: d, completion: .contentProcessed { [weak self] e in
                    guard let self = self else { return }
                    if e != nil { return self.show(tr("Something went wrong"), tr("TwinDesk stopped answering."), done: true) }
                    self.sent += Int64(n)
                    self.lastProgress = Date()
                    let p = self.total > 0 ? Float(Double(self.sent) / Double(self.total)) : 0
                    DispatchQueue.main.async { self.bar.setProgress(p, animated: true) }
                    pump()
                })
            }
            pump()
        }
    }

    // TwinDesk stopped taking the bytes (iOS suspended it behind this app): said, not waited on forever.
    private var watching = false
    private func watchStall() {
        if watching { return }
        watching = true
        func check() {
            q.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self = self, !self.finished else { return }
                if Date().timeIntervalSince(self.lastProgress) > 20 {
                    self.conn?.cancel()
                    return self.show(tr("TwinDesk stopped answering"), tr("iOS paused it in the background. Open TwinDesk, then share again."), done: true)
                }
                check()
            }
        }
        check()
    }

    private func readLine(timeout: TimeInterval, _ done: @escaping ([String: Any]?) -> Void) {
        var answered = false
        let answer = { (o: [String: Any]?) in
            if answered { return }
            answered = true
            done(o)
        }
        q.asyncAfter(deadline: .now() + timeout) { answer(nil) }
        func more() {
            if let i = rx.firstIndex(of: 10) {
                let l = rx[rx.startIndex..<i]
                rx = Data(rx[(i + 1)...])
                return answer((try? JSONSerialization.jsonObject(with: l)) as? [String: Any])
            }
            conn?.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] d, _, end, err in
                guard let self = self else { return }
                if let d = d { self.rx.append(d) }
                if self.rx.contains(10) { return more() }
                if end || err != nil { return answer(nil) }
                more()
            }
        }
        more()
    }
}

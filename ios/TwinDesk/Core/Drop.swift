// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Drop (shared/drop.js, android/…/Drop.kt): one conversation with every TwinDesk device. This iPhone keeps
// what it may see (to everyone, to it, from it) in its own folder, and the computer it's connected to
// passes the rest on to the mesh. Written while away, a message waits here and goes when a computer
// connects: each side says which ids it has (drop.hi) and the other sends what's missing (drop.msgs).
//   drop.hi {ids, gone, since?} ↔ ; drop.msgs {items} ↔ ; drop.msg {item} ↔ ; drop.del {id, from, at, to} ↔
//   drop.who {} → ; drop.who {members} ← : who the To picker offers (the computer first)
// item: {id, from, name, os, at, to: "*" | id, text?, file?: {name, size, mime, data (base64)}}
import Foundation
import UIKit
import ImageIO
import UniformTypeIdentifiers

final class Drop: Feature {
    static let HI = "drop.hi", MSGS = "drop.msgs", MSG = "drop.msg", DEL = "drop.del", WHO = "drop.who"
    static let maxFile = 5 * 1024 * 1024
    static let maxText = 8000
    private static let keep = 300
    private static let keepBytes: Int64 = 100 * 1024 * 1024
    private static let hiIds = 300
    private static let batch = 6 * 1024 * 1024

    struct FileInfo { let name: String; let size: Int64; let mime: String
        var image: Bool { mime.range(of: "^image/(png|jpe?g|gif|webp|bmp|heic)$", options: .regularExpression) != nil }
    }
    final class Item: Identifiable {
        let id: String, from: String, name: String, os: String, at: Int64, to: String, k: Int64
        var text: String, file: FileInfo?, gone: Bool, hid: Bool
        init(id: String, from: String, name: String, os: String, at: Int64, to: String, text: String, file: FileInfo?, gone: Bool, hid: Bool, k: Int64) {
            self.id = id; self.from = from; self.name = name; self.os = os; self.at = at; self.to = to
            self.text = text; self.file = file; self.gone = gone; self.hid = hid; self.k = k
        }
    }
    struct Member: Identifiable { let id: String, name: String, os: String, online: Bool }

    private let q = DispatchQueue(label: "td.drop")
    private let root: URL = {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("drop", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()
    private var roomFile: URL { root.appendingPathComponent("room.json") }
    private var items: [Item] = []
    private var byId: [String: Item] = [:]
    private var k: Int64 = 0
    private var readK: Int64 = 0
    private var loaded = false
    private var onFlag = false // off on a new install
    private var blocked: [String: String] = [:]
    private(set) var members: [Member] = [] // main
    private(set) var note = "" // main
    private var thumbs = NSCache<NSString, UIImage>()
    private var me: String { core.store.deviceId }
    private var saving = false

    private func isId(_ s: String) -> Bool { s.range(of: "^[A-Za-z0-9_.:-]{1,64}$", options: .regularExpression) != nil }
    private func isItemId(_ s: String) -> Bool { s.range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression) != nil }

    // ---- the room on disk (on q) ----

    private func load() {
        if loaded { return }
        loaded = true
        guard let data = try? Data(contentsOf: roomFile), let j = (try? JSONSerialization.jsonObject(with: data)) as? JSON else { return }
        k = j.int64("k"); readK = j.int64("read"); onFlag = (j["on"] as? NSNumber)?.boolValue ?? false
        for (id, n) in (j.obj("blocked") ?? [:]) { blocked[id] = n as? String ?? "" }
        for x in (j["items"] as? [JSON]) ?? [] {
            let f = x.obj("file")
            let it = Item(id: x.str("id", max: 64), from: x.str("from", max: 64), name: x.str("name", max: 64), os: x.str("os", max: 10), at: x.int64("at"),
                          to: x.str("to", max: 64).isEmpty ? "*" : x.str("to", max: 64), text: x.str("text", max: Self.maxText),
                          file: f.map { FileInfo(name: $0.str("name", max: 200), size: $0.int64("size"), mime: $0.str("mime", max: 100)) },
                          gone: x.bool("gone"), hid: x.bool("hid"), k: x.int64("k"))
            if isItemId(it.id), byId[it.id] == nil { items.append(it); byId[it.id] = it }
        }
        items.sort { $0.at != $1.at ? $0.at < $1.at : $0.id < $1.id }
    }

    private func save() {
        if saving { return }
        saving = true
        q.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.flush() }
    }

    private func flush() {
        saving = false
        let a: [JSON] = items.map { x in
            var o: JSON = ["id": x.id, "from": x.from, "name": x.name, "os": x.os, "at": x.at, "to": x.to, "k": x.k]
            if !x.text.isEmpty { o["text"] = x.text }
            if let f = x.file { o["file"] = ["name": f.name, "size": f.size, "mime": f.mime] }
            if x.gone { o["gone"] = true }
            if x.hid { o["hid"] = true }
            return o
        }
        let o: JSON = ["v": 1, "k": k, "read": readK, "on": onFlag, "blocked": blocked, "items": a]
        if let d = try? JSONSerialization.data(withJSONObject: o) { try? d.write(to: roomFile, options: .atomic) }
    }

    func fileURL(_ x: Item) -> URL? { x.file.map { root.appendingPathComponent("files", isDirectory: true).appendingPathComponent(x.id, isDirectory: true).appendingPathComponent($0.name) } }
    private func dropFile(_ x: Item) {
        try? FileManager.default.removeItem(at: root.appendingPathComponent("files", isDirectory: true).appendingPathComponent(x.id, isDirectory: true))
        thumbs.removeObject(forKey: x.id as NSString)
    }

    private func insert(_ it: Item) {
        var i = items.count
        while i > 0 && (items[i - 1].at > it.at || (items[i - 1].at == it.at && items[i - 1].id > it.id)) { i -= 1 }
        items.insert(it, at: i); byId[it.id] = it
        var bytes = items.reduce(Int64(0)) { $0 + ($1.file?.size ?? 0) }
        while items.count > Self.keep || (bytes > Self.keepBytes && !items.isEmpty) {
            let x = items.removeFirst(); byId[x.id] = nil; bytes -= x.file?.size ?? 0; dropFile(x)
        }
    }

    // ---- who sees what ----

    private func mine(_ to: String, _ from: String) -> Bool { to == "*" || to == me || from == me }
    private func shown(_ x: Item) -> Bool { !x.hid && !x.gone && mine(x.to, x.from) && !(x.from != me && blocked[x.from] != nil) }

    var on: Bool { q.sync { load(); return onFlag } }

    func setOn(_ v: Bool) {
        q.sync { load(); onFlag = v; save() }
        if v && core.connected { hello() }
        core.changed()
    }

    func block(_ id: String, _ v: Bool, name: String) {
        q.sync { load(); if v { blocked[id] = String(name.prefix(64)) } else { blocked[id] = nil }; save() }
        core.changed()
    }

    func blockedList() -> [(id: String, name: String)] { q.sync { load(); return blocked.map { ($0.key, $0.value) }.sorted { $0.name < $1.name } } }

    func view() -> [Item] { q.sync { load(); return Array(items.filter { shown($0) }.suffix(300)) } }

    func unread() -> Int { q.sync { load(); return onFlag ? items.filter { $0.k > readK && $0.from != me && shown($0) }.count : 0 } }

    func read() {
        let changed = q.sync { () -> Bool in load(); if readK != k { readK = k; save(); return true }; return false }
        if changed { Notifier.shared.cancel("drop"); core.changed() }
    }

    // ---- the link ----

    override func onWelcome(_ host: Computer, _ m: JSON) { DispatchQueue.main.async { self.members = [] }; hello() }
    override func onClosed() { DispatchQueue.main.async { self.members = []; self.core.changed() } }

    private func hello() {
        guard on else { return }
        let (ids, gone, since) = q.sync { () -> ([String], [String], Int64) in
            load()
            let list = Array(items.suffix(Self.hiIds))
            return (list.map(\.id), list.filter(\.gone).map(\.id), list.count == Self.hiIds ? list[0].at : 0)
        }
        var m: JSON = ["ids": ids, "gone": gone]
        if since > 0 { m["since"] = since }
        _ = core.send(msg(Self.HI, m))
        ask()
    }

    // The To picker's devices (the page asks when it opens).
    func ask() { if on && core.connected { _ = core.send(msg(Self.WHO)) } }

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        guard [Self.HI, Self.MSGS, Self.MSG, Self.DEL, Self.WHO].contains(t) else { return false }
        guard on else { return true }
        switch t {
        case Self.HI: q.async { self.answer(m) }
        case Self.WHO:
            let list = ((m["members"] as? [JSON]) ?? []).filter { isId($0.str("id", max: 64)) && $0.str("id", max: 64) != me }
                .map { Member(id: $0.str("id", max: 64), name: $0.str("name", max: 64), os: $0.str("os", max: 10), online: $0.bool("online")) }
            DispatchQueue.main.async { self.members = list; self.core.changed() }
        case Self.MSGS:
            q.async {
                var any = false
                for x in ((m["items"] as? [JSON]) ?? []).prefix(150) { any = self.take(x) || any }
                if any { self.core.changed() }
            }
        case Self.MSG: q.async { if let x = m.obj("item"), self.take(x) { self.core.changed() } }
        default: q.async { var x = m; x["gone"] = true; if self.take(x) { self.core.changed() } }
        }
        return true
    }

    // On q.
    private func answer(_ m: JSON) {
        load()
        let have = Set(((m["ids"] as? [String]) ?? []).prefix(Self.hiIds * 2))
        let buried = Set(((m["gone"] as? [String]) ?? []).prefix(Self.hiIds))
        let since = m.int64("since")
        let lack = items.filter { !$0.hid && (!have.contains($0.id) || ($0.gone && !buried.contains($0.id))) && $0.at >= since }.suffix(150)
        var batch: [JSON] = [], size = 0
        for x in lack {
            guard let w = wire(x) else { continue }
            let n = ((w["file"] as? JSON)?["data"] as? String)?.count ?? (200 + x.text.count)
            if !batch.isEmpty && size + n > Self.batch { _ = core.send(msg(Self.MSGS, ["items": batch])); batch = []; size = 0 }
            batch.append(w); size += n
        }
        if !batch.isEmpty { _ = core.send(msg(Self.MSGS, ["items": batch])) }
    }

    private func wire(_ x: Item, data: Data? = nil) -> JSON? {
        var w: JSON = ["id": x.id, "from": x.from, "name": x.name, "os": x.os, "at": x.at, "to": x.to]
        if x.gone { w["gone"] = true; return w }
        if !x.text.isEmpty { w["text"] = x.text }
        if let f = x.file {
            guard let bytes = data ?? fileURL(x).flatMap({ try? Data(contentsOf: $0) }) else { return nil }
            w["file"] = ["name": f.name, "size": f.size, "mime": f.mime, "data": bytes.base64EncodedString()]
        }
        return w
    }

    private func safeName(_ n: String) -> String {
        var s = String(n.prefix(200)).replacingOccurrences(of: "[\\\\/:*?\"<>|\\u0000-\\u001f]", with: "_", options: .regularExpression)
        s = s.replacingOccurrences(of: "^\\.+", with: "_", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return s.isEmpty ? "file" : s
    }

    // An item from the computer (on q): kept the first time, when this iPhone may see it. True when the room changed.
    private func take(_ j: JSON) -> Bool {
        let id = j.str("id", max: 64), from = j.str("from", max: 64), at = j.int64("at")
        let to = j.str("to", max: 64).isEmpty ? "*" : j.str("to", max: 64)
        guard isItemId(id), isId(from), at > 0, to == "*" || isId(to), mine(to, from) else { return false }
        let gone = j.bool("gone")
        load()
        if let old = byId[id] {
            if !gone || old.gone || old.from != from { return false }
            dropFile(old); old.text = ""; old.file = nil; old.gone = true
            save()
            return true
        }
        if from == me && !gone { return false } // ours, gone from here: not back
        var info: FileInfo?
        var data: Data?
        if let f = j.obj("file"), !gone {
            let size = (f["size"] as? NSNumber)?.int64Value ?? -1
            guard size >= 0, size <= Int64(Self.maxFile), let d = Data(base64Encoded: f.str("data", max: Self.maxFile * 2)), Int64(d.count) == size else { return false }
            data = d
            info = FileInfo(name: safeName(f.str("name", max: 200)), size: size, mime: f.str("mime", max: 100))
        }
        let text = j.str("text", max: Self.maxText)
        if !gone && text.isEmpty && info == nil { return false }
        k += 1
        let fresh = Item(id: id, from: from, name: j.str("name", max: 64), os: j.str("os", max: 10), at: at, to: to,
                         text: gone ? "" : text, file: gone ? nil : info, gone: gone, hid: false, k: k)
        if let d = data, let u = fileURL(fresh) {
            do { try FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true); try d.write(to: u) }
            catch { return false }
        }
        insert(fresh)
        save()
        if shown(fresh) && fresh.from != me {
            let n = items.filter { $0.k > readK && $0.from != me && shown($0) }.count
            DispatchQueue.main.async { if !self.core.inFront { Notifier.shared.drop(fresh.name, fresh.text.isEmpty ? (fresh.file?.name ?? "") : fresh.text, count: n) } }
        }
        return true
    }

    // ---- this iPhone ----

    private func newItem(_ to: String, _ text: String, _ file: FileInfo?) -> Item {
        k += 1
        return Item(id: UUID().uuidString, from: me, name: String(core.store.deviceName.prefix(64)), os: Proto.os, at: Int64(Date().timeIntervalSince1970 * 1000),
                    to: to == "*" || !isId(to) ? "*" : to, text: text, file: file, gone: false, hid: false, k: k)
    }

    private func send(_ it: Item, _ data: Data?) {
        guard core.connected, let w = wire(it, data: data) else { return } // it goes with the next drop.hi
        _ = core.send(msg(Self.MSG, ["item": w]))
    }

    func post(to: String, text: String) {
        let t = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maxText))
        guard !t.isEmpty, on else { return }
        q.async {
            self.load()
            let it = self.newItem(to, t, nil)
            self.insert(it); self.readK = self.k; self.save()
            self.core.changed()
            self.send(it, nil)
        }
    }

    // Files picked here (security-scoped URLs from the file picker).
    func postFiles(to: String, urls: [URL]) {
        guard on else { return }
        var picked: [(String, Data?, Bool)] = [] // name, bytes, too big
        for u in urls.prefix(20) {
            let scoped = u.startAccessingSecurityScopedResource()
            let size = (try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? -1
            if size > Self.maxFile { picked.append((u.lastPathComponent, nil, true)) }
            else { let d = try? Data(contentsOf: u); picked.append((u.lastPathComponent, d, (d?.count ?? 0) > Self.maxFile)) }
            if scoped { u.stopAccessingSecurityScopedResource() }
        }
        post(to: to, files: picked)
    }

    // A picture or file already in hand (the photo picker).
    func post(to: String, files: [(String, Data?, Bool)]) {
        q.async {
            var big: [String] = []
            for (name, data, tooBig) in files {
                guard !tooBig, let bytes = data else { if tooBig { big.append(name) }; continue }
                self.load()
                let mime = UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                let it = self.newItem(to, "", FileInfo(name: self.safeName(name), size: Int64(bytes.count), mime: mime))
                guard let u = self.fileURL(it), (try? FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)) != nil,
                      (try? bytes.write(to: u)) != nil else { continue }
                self.insert(it); self.readK = self.k; self.save()
                self.send(it, bytes)
            }
            let n = big.isEmpty ? "" : tr("Too large for Drop (5 MB at most): {names}. Send it from Files instead.", ["names": big.joined(separator: ", ")])
            DispatchQueue.main.async { self.note = n; self.core.changed() }
        }
    }

    func del(_ id: String, everyone: Bool) {
        let tomb = q.sync { () -> JSON? in
            load()
            guard let x = byId[id], !x.gone, !everyone || x.from == me else { return nil }
            dropFile(x); x.text = ""; x.file = nil
            if everyone { x.gone = true } else { x.hid = true }
            save()
            return everyone ? msg(Self.DEL, ["id": x.id, "from": x.from, "at": x.at, "to": x.to]) : [:]
        }
        if let t = tomb, !t.isEmpty, core.connected { _ = core.send(t) }
        core.changed()
    }

    func clear() {
        q.sync { load(); for x in items where shown(x) { dropFile(x); x.text = ""; x.file = nil; x.hid = true }; save() }
        core.changed()
    }

    func setNote(_ text: String) { note = text; core.changed() }

    // A picture, made small for the page (decoded once).
    func thumb(_ x: Item) -> UIImage? {
        if let t = thumbs.object(forKey: x.id as NSString) { return t }
        guard let u = fileURL(x), let src = CGImageSourceCreateWithURL(u as CFURL, nil),
              let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 900,
                                                                     kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { return nil }
        let img = UIImage(cgImage: cg)
        thumbs.setObject(img, forKey: x.id as NSString)
        return img
    }
}

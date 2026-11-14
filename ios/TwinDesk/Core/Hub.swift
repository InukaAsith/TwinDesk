// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Photos and Files on the computer (shared/phonehub.js there, android/…/Hub.kt): each is off until
// switched on (its page on the computer, or here), and while it's off nothing of it runs.
//   Photos: this iPhone's library a page at a time (media.list), small pictures for the grid
//     (media.thumb, the ones on screen first), a big one (media.view), the files themselves to the
//     computer (media.save, as Send), and removing them (media.delete: iOS asks here first).
//   Files: TwinDesk's own folder (Files › On My iPhone › TwinDesk), folder by folder (fs.list),
//     New Folder / Rename / Delete (fs.do), to the computer (fs.save), from it into a folder (fs.expect).
// Calls and Messages: iOS gives no app either, so they say so (perm "none").
import Foundation
import Photos
import ImageIO
import UIKit

final class Hub: Feature {
    private(set) var peer = false // the computer knows the hub (it sent hub.policy)
    private(set) var mediaOn = false
    private(set) var filesOn = false
    private var lastState = ""
    private let work = DispatchQueue(label: "td.hub", qos: .userInitiated)

    // Photos' ids on the wire are short numbers (the computer takes [a-z]?digits): ours, per session.
    private var ids: [String: String] = [:] // wire id -> PHAsset.localIdentifier
    private var nextId = 1
    private var want: [String] = [] // thumbnails still to send, the computer's order
    private var pumping = false

    var photos: PhotoAccess { PhotoAccess.now }

    override func onWelcome(_ host: Computer, _ m: JSON) { reset() }
    override func onClosed() { reset() }

    private func reset() {
        peer = false
        mediaOn = false
        filesOn = false
        lastState = ""
        ids.removeAll()
        want.removeAll()
    }

    // Switched here: the computer keeps the setting.
    func set(_ what: String, _ on: Bool) {
        switch what {
        case "media": mediaOn = on; if on { askPhotos() }
        case "files": filesOn = on
        default: return
        }
        core.send(msg("hub.set", ["what": what, "on": on]))
        sendState()
        core.changed()
    }

    func askPhotos() {
        guard PhotoAccess.now == .ask else { return }
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in
            DispatchQueue.main.async { self.sendState(); self.core.changed() }
        }
    }

    func sendState() {
        guard peer, core.connected else { return }
        let st = msg("hub.state", [
            "calls": ["perm": "none", "missing": ["iOS keeps calls to itself"]],
            "messages": ["perm": "none", "missing": ["iOS keeps messages to itself"]],
            "media": ["perm": PhotoAccess.now.wire, "remove": true],
            "files": ["perm": "ok"],
            "bt": [String: Any](),
            "opens": false,
        ])
        guard let key = encodeJSON(st), key != lastState else { return }
        lastState = key
        core.send(st)
    }

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        switch t {
        case "hub.policy":
            peer = true
            mediaOn = m.bool("media")
            filesOn = m.bool("files")
            lastState = ""
            sendState()
            core.changed()
        case "hub.ask":
            if m.str("what") == "media" {
                if PhotoAccess.now == .ask && UIApplication.shared.applicationState == .active { askPhotos() }
                else { Notifier.shared.note("hub.ask", tr("Allow Photos for TwinDesk"), tr("Open TwinDesk › Photos to allow {name} to view your photos.", ["name": core.host?.name ?? tr("the computer")]), sound: true) }
            }
        case "call.do": core.send(msg("call.done", ["a": m.str("a", max: 20), "ok": false, "error": "off"]))
        case "sms.send": core.send(msg("sms.sent", ["ref": m.str("ref", max: 60), "ok": false, "error": "off"]))
        case "call.log", "contacts", "sms.threads": core.send(msg(t, ["items": [Any]()]))
        case "media.list": if mediaOn { work.async { self.list(m) } }
        case "media.thumb": if mediaOn { thumbs((m["ids"] as? [String]) ?? []) }
        case "media.view": if mediaOn { let id = m.str("id", max: 40); work.async { self.view(id) } }
        case "media.save": if mediaOn { save((m["ids"] as? [String]) ?? []) }
        case "media.delete": if mediaOn { delete((m["ids"] as? [String]) ?? []) }
        case "fs.list": if filesOn { work.async { self.core.send(self.fsList(m)) } }
        case "fs.do": if filesOn { work.async { self.core.send(self.fsDo(m)) } }
        case "fs.save": if filesOn { fsSave((m["paths"] as? [String]) ?? []) }
        case "fs.expect": if filesOn { fsExpect(m.str("batch", max: 64), m.str("path", max: 1000)) }
        default: return false
        }
        return true
    }

    // ---- Photos ----

    private func asset(_ id: String) -> PHAsset? {
        guard let local = ids[id] else { return nil }
        return PHAsset.fetchAssets(withLocalIdentifiers: [local], options: nil).firstObject
    }

    private func wireId(_ a: PHAsset) -> String {
        let pre = a.mediaType == .video ? "v" : "i"
        if let hit = ids.first(where: { $0.value == a.localIdentifier }) { return hit.key }
        let id = pre + String(nextId)
        nextId += 1
        ids[id] = a.localIdentifier
        return id
    }

    // One page, newest first. `before` is where the last page ended (a creation time in ms).
    private func list(_ m: JSON) { core.send(msg("media.list", page(m))) }

    // One page (also for a phone, Peer.swift): {kind, before, items, more, next}.
    func page(_ m: JSON) -> JSON {
        let kind = m.str("kind", max: 20)
        let n = max(1, min(500, m.int("n", 120)))
        let before = Double(m.str("before", max: 40)) ?? 0
        var preds: [NSPredicate] = []
        switch kind {
        case "photos": preds.append(NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue))
        case "videos": preds.append(NSPredicate(format: "mediaType == %d", PHAssetMediaType.video.rawValue))
        case "screenshots": preds.append(NSPredicate(format: "(mediaSubtypes & %d) != 0", PHAssetMediaSubtype.photoScreenshot.rawValue))
        default: preds.append(NSPredicate(format: "mediaType == %d OR mediaType == %d", PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue))
        }
        if before > 0 { preds.append(NSPredicate(format: "creationDate < %@", Date(timeIntervalSince1970: before / 1000) as NSDate)) }
        let o = PHFetchOptions()
        o.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: preds)
        o.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        o.fetchLimit = n + 1
        let r = PHAsset.fetchAssets(with: o)
        var items: [JSON] = []
        var last = ""
        var more = false
        DispatchQueue.main.sync {
            r.enumerateObjects { a, i, stop in
                if i >= n { more = true; stop.pointee = true; return }
                let at = (a.creationDate ?? a.modificationDate ?? Date()).timeIntervalSince1970 * 1000
                let name = PHAssetResource.assetResources(for: a).first?.originalFilename ?? ""
                items.append(["id": self.wireId(a), "video": a.mediaType == .video, "at": Int64(at), "w": a.pixelWidth, "h": a.pixelHeight,
                              "size": 0, "name": name, "dur": Int64(a.duration * 1000), "album": ""])
                last = String(Int64(at))
            }
        }
        return ["kind": kind, "before": m.str("before", max: 40), "items": items, "more": more, "next": last]
    }

    // These next: the ones still waiting from before are dropped (scrolled past).
    private func thumbs(_ list: [String]) {
        want = Array(list.prefix(300))
        guard !pumping, !want.isEmpty else { return }
        pumping = true
        pump()
    }

    // One at a time, while the link has little queued: input and the rest never wait behind them.
    private func pump() {
        guard core.connected, mediaOn, !want.isEmpty else { pumping = false; return }
        if core.link.queued() > 256 * 1024 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { self.pump() }
            return
        }
        let id = want.removeFirst()
        image(id, 256, quality: 0.72, fast: true) { data in
            self.core.send(msg("media.thumb", ["id": id, "data": data ?? NSNull()]))
            DispatchQueue.main.async { self.pump() }
        }
    }

    private func view(_ id: String) {
        DispatchQueue.main.async {
            let done = self.keepUp("TwinDesk photo")
            self.image(id, 1600, quality: 0.85, fast: false) { data in
                self.core.send(msg("media.view", ["id": id, "data": data ?? NSNull()]))
                done()
            }
        }
    }

    func image(_ id: String, _ side: CGFloat, quality: CGFloat, fast: Bool, _ done: @escaping (String?) -> Void) {
        guard let a = asset(id) else { return done(nil) }
        let o = PHImageRequestOptions()
        o.isNetworkAccessAllowed = true // in iCloud: downloaded
        o.deliveryMode = fast ? .fastFormat : .highQualityFormat
        o.resizeMode = fast ? .fast : .exact
        o.isSynchronous = false
        var answered = false
        PHImageManager.default().requestImage(for: a, targetSize: CGSize(width: side, height: side), contentMode: fast ? .aspectFill : .aspectFit, options: o) { img, info in
            if answered { return }
            if (info?[PHImageResultIsDegradedKey] as? Bool) == true && !fast { return }
            answered = true
            if let img = img, let jpg = img.jpegData(compressionQuality: quality) { return done("data:image/jpeg;base64," + jpg.base64EncodedString()) }
            if fast { return done(nil) }
            // No picture at that size (an iCloud download that failed, an odd format): the photo's own
            // data, scaled here.
            NSLog("TwinDesk: photo %@: no image (%@), trying its data", id, String(describing: info?[PHImageErrorKey] ?? "none"))
            self.fromData(a, side, quality, done)
        }
    }

    // The photo's full data (downloaded from iCloud if need be), scaled to `side` and made a JPEG.
    private func fromData(_ a: PHAsset, _ side: CGFloat, _ quality: CGFloat, _ done: @escaping (String?) -> Void) {
        guard a.mediaType == .image else { return done(nil) }
        let o = PHImageRequestOptions()
        o.isNetworkAccessAllowed = true
        o.deliveryMode = .highQualityFormat
        o.version = .current
        PHImageManager.default().requestImageDataAndOrientation(for: a, options: o) { data, _, _, info in
            guard let data = data, let src = CGImageSourceCreateWithData(data as CFData, nil) else {
                NSLog("TwinDesk: photo data: none (%@)", String(describing: info?[PHImageErrorKey] ?? "none"))
                return done(nil)
            }
            let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                         kCGImageSourceThumbnailMaxPixelSize: Int(side)]
            guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary),
                  let jpg = UIImage(cgImage: cg).jpegData(compressionQuality: quality) else { return done(nil) }
            done("data:image/jpeg;base64," + jpg.base64EncodedString())
        }
    }

    // A minute to finish (an iCloud download, the files' handover) when TwinDesk leaves the screen
    // meanwhile: the computer is often what's in front then.
    private func keepUp(_ name: String) -> () -> Void {
        var t = UIBackgroundTaskIdentifier.invalid
        let end = { if t != .invalid { UIApplication.shared.endBackgroundTask(t); t = .invalid } }
        t = UIApplication.shared.beginBackgroundTask(withName: name) { end() }
        return { DispatchQueue.main.async { end() } }
    }

    // The files themselves (the originals, with their names), to the computer.
    private func save(_ list: [String]) {
        let done = keepUp("TwinDesk photos")
        originals(list) { urls in
            if urls.isEmpty { NSLog("TwinDesk: photos: none of %d could be read", list.count) }
            else { self.core.files.send(urls) }
            done()
        }
    }

    // The originals of these, as files in a temporary folder (main). Each: its original resource
    // (downloaded from iCloud if need be), else, for a photo, its image data as Photos hands it out.
    // Always calls back (an empty list when none could be read).
    func originals(_ list: [String], _ done: @escaping ([URL]) -> Void) {
        let assets = list.prefix(500).compactMap { asset($0) }
        guard !assets.isEmpty else { return done([]) }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("photos-" + UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var urls: [URL] = []
        var names = Set<String>()
        let group = DispatchGroup()
        let lock = NSLock()
        for (n, a) in assets.enumerated() {
            let res = PHAssetResource.assetResources(for: a)
            let r = res.first(where: { $0.type == .fullSizePhoto || $0.type == .fullSizeVideo })
                ?? res.first(where: { $0.type == .photo || $0.type == .video }) ?? res.first
            var name = r?.originalFilename ?? ""
            if name.isEmpty { name = "IMG_\(n + 1)" + (a.mediaType == .video ? ".mov" : ".jpg") }
            if !names.insert(name).inserted { name = "\(n + 1)-" + name; names.insert(name) }
            let to = dir.appendingPathComponent(name)
            let got = { (ok: Bool) in if ok { lock.lock(); urls.append(to); lock.unlock() }; group.leave() }
            group.enter()
            let viaData = {
                guard a.mediaType == .image else { return got(false) }
                let o = PHImageRequestOptions()
                o.isNetworkAccessAllowed = true
                o.deliveryMode = .highQualityFormat
                o.version = .current
                PHImageManager.default().requestImageDataAndOrientation(for: a, options: o) { data, _, _, _ in
                    got(data.map { (try? $0.write(to: to)) != nil } ?? false)
                }
            }
            guard let res1 = r else { viaData(); continue }
            let o = PHAssetResourceRequestOptions()
            o.isNetworkAccessAllowed = true
            PHAssetResourceManager.default().writeData(for: res1, toFile: to, options: o) { err in
                if err == nil { return got(true) }
                NSLog("TwinDesk: photo original %@: %@", name, err!.localizedDescription)
                try? FileManager.default.removeItem(at: to)
                viaData()
            }
        }
        group.notify(queue: .main) { done(urls.sorted { $0.path < $1.path }) }
    }

    // Removed from the library: iOS asks here first (Delete), so it waits for this app to be in front.
    private var deleting: [String] = []
    private func delete(_ list: [String]) {
        deleting = Array(list.prefix(300))
        if UIApplication.shared.applicationState == .active { runDelete() }
        else {
            Notifier.shared.note("media.delete", tr("Remove {count} from Photos?", ["count": deleting.count]), tr("Open TwinDesk to confirm."), sound: true)
            core.send(msg("media.delete", ["ids": [String](), "failed": 0, "confirm": deleting.count]))
        }
    }

    func appBecameActive() { if !deleting.isEmpty { runDelete() } }

    private func runDelete() {
        let list = deleting
        deleting = []
        let assets = list.compactMap { asset($0) }
        guard !assets.isEmpty else { core.send(msg("media.delete", ["ids": [String](), "failed": list.count, "confirm": 0])); return }
        PHPhotoLibrary.shared().performChanges({ PHAssetChangeRequest.deleteAssets(assets as NSArray) }) { ok, _ in
            DispatchQueue.main.async {
                self.core.send(msg("media.delete", ["ids": ok ? list : [String](), "failed": ok ? 0 : list.count, "confirm": 0]))
            }
        }
    }

    // ---- Files: TwinDesk's folder ----

    private var root: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }

    private func at(_ path: String) -> URL? {
        let parts = path.split(separator: "/").map(String.init).filter { !$0.isEmpty && $0 != "." }
        if parts.contains(where: { $0 == ".." || $0.unicodeScalars.contains { $0.value < 32 } }) { return nil }
        var u = root
        for p in parts { u.appendPathComponent(p) }
        let top = root.standardizedFileURL.resolvingSymlinksInPath().path
        let real = u.standardizedFileURL.resolvingSymlinksInPath().path
        return real == top || real.hasPrefix(top + "/") ? u : nil
    }

    private func cleanName(_ n: String) -> String? {
        let t = n.trimmingCharacters(in: .whitespaces)
        return t.isEmpty || t == "." || t == ".." || t.count > 255 || t.contains("/") || t.unicodeScalars.contains { $0.value < 32 } ? nil : t
    }

    private func fsList(_ m: JSON) -> JSON {
        let path = m.str("path", max: 1000)
        var out = msg("fs.list", ["path": path])
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard let dir = at(path), fm.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else {
            out["error"] = "That folder isn’t there any more"
            out["items"] = [Any]()
            return out
        }
        let hidden = m.bool("hidden")
        let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
        let list = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys, options: hidden ? [] : [.skipsHiddenFiles])) ?? []
        var items: [JSON] = []
        for u in list.prefix(5000) {
            let v = try? u.resourceValues(forKeys: Set(keys))
            let d = v?.isDirectory == true
            var o: JSON = ["name": u.lastPathComponent, "dir": d, "at": Int64((v?.contentModificationDate ?? Date()).timeIntervalSince1970 * 1000)]
            if d { o["n"] = ((try? fm.contentsOfDirectory(atPath: u.path)) ?? []).filter { hidden || !$0.hasPrefix(".") }.count }
            else { o["size"] = Int64(v?.fileSize ?? 0) }
            items.append(o)
        }
        if let a = try? fm.attributesOfFileSystem(forPath: root.path) {
            out["free"] = (a[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
            out["total"] = (a[.systemSize] as? NSNumber)?.int64Value ?? 0
        }
        out["items"] = items
        return out
    }

    // mkdir {path (the folder), name} | rename {path (the item), name} | delete {path (the folder), paths}.
    private func fsDo(_ m: JSON) -> JSON {
        let a = m.str("a", max: 20), path = m.str("path", max: 1000)
        let done = { (ok: Bool, error: String, folder: String) -> JSON in
            var o = msg("fs.done", ["ref": m.str("ref", max: 60), "ok": ok, "path": folder])
            if !error.isEmpty { o["error"] = error }
            return o
        }
        let fm = FileManager.default
        guard let f = at(path) else { return done(false, "Not in TwinDesk’s folder", path) }
        let name = cleanName(m.str("name", max: 300))
        switch a {
        case "mkdir":
            guard let n = name else { return done(false, "That name won’t do", path) }
            let d = f.appendingPathComponent(n, isDirectory: true)
            if fm.fileExists(atPath: d.path) { return done(false, "\(n) is already there", path) }
            return done((try? fm.createDirectory(at: d, withIntermediateDirectories: true)) != nil, "", path)
        case "rename":
            let parent = (path as NSString).deletingLastPathComponent
            guard let n = name, f.standardizedFileURL != root.standardizedFileURL else { return done(false, "That name won’t do", parent) }
            let to = f.deletingLastPathComponent().appendingPathComponent(n)
            if fm.fileExists(atPath: to.path) { return done(false, "\(n) is already there", parent) }
            return done((try? fm.moveItem(at: f, to: to)) != nil, "", parent)
        case "delete":
            let gone = ((m["paths"] as? [String]) ?? []).compactMap { at($0) }.filter { $0.standardizedFileURL != root.standardizedFileURL }
            let failed = gone.filter { (try? fm.removeItem(at: $0)) == nil }.count
            return done(failed == 0, failed == 0 ? "" : "Couldn’t delete \(failed) item\(failed == 1 ? "" : "s")", path)
        default: return done(false, "", path)
        }
    }

    // To the computer, folders with what's in them (their paths kept).
    private func fsSave(_ paths: [String]) {
        let fm = FileManager.default
        var urls: [URL] = [], rels: [String] = []
        for p in paths.prefix(500) {
            guard let f = at(p), f.standardizedFileURL != root.standardizedFileURL else { continue }
            let base = f.deletingLastPathComponent().standardizedFileURL.path
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: f.path, isDirectory: &isDir) else { continue }
            if !isDir.boolValue { urls.append(f); rels.append(f.lastPathComponent); continue }
            let e = fm.enumerator(at: f, includingPropertiesForKeys: [.isRegularFileKey])
            while let u = e?.nextObject() as? URL, urls.count < 10000 {
                guard (try? u.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { continue }
                urls.append(u)
                rels.append(String(u.standardizedFileURL.path.dropFirst(base.count + 1)))
            }
        }
        if !urls.isEmpty { core.files.send(urls, rels: rels) }
    }

    private func fsExpect(_ batch: String, _ path: String) {
        guard !batch.isEmpty, let dir = at(path) else { return }
        core.files.expect(batch, into: dir) { ok in
            var o = msg("fs.done", ["ok": ok, "path": path])
            if !ok { o["error"] = "Not everything arrived" }
            self.core.send(o)
        }
    }
}

// What iOS lets us do with the photo library.
enum PhotoAccess {
    case ok, partial, ask, denied
    static var now: PhotoAccess {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized: return .ok
        case .limited: return .partial
        case .notDetermined: return .ask
        default: return .denied
        }
    }
    var wire: String { switch self { case .ok: return "ok"; case .partial: return "partial"; case .ask: return "ask"; case .denied: return "none" } }
}

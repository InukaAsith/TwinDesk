// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Clipboard text and pictures both ways (Clip.kt, shared/clipimage.js).
//
// The computer's copies: put on this clipboard at once (Clipboard › Copy at once) and/or shown as a
// notification with Copy (Clipboard › Notify). iOS lets an app write the clipboard in the
// background; reading it is another matter:
//
// The iPhone's copies: iOS lets only the app in front read the clipboard (and asks "Allow Paste"
// unless Settings › TwinDesk › Paste from Other Apps is Allow). So while TwinDesk is kept alive in
// the background we watch only the clipboard's change count, which needs no permission, and post
// "You copied something — Send to <computer>". Its button opens TwinDesk for a moment and sends
// it. With TwinDesk in front, a copy goes at once. The Send Clipboard shortcut (Back Tap, the
// Action button) does the same from anywhere.
//
// No loops: what TwinDesk writes carries its own type (Clip.mark) and stays on this device
// (localOnly: Universal Clipboard doesn't carry it back to a Mac on the same Apple Account), and a
// clipboard holding TwinDesk's own copy is never read or sent. Universal Clipboard still echoes
// what goes between this device and a Mac (the Mac's copy reaching here on its own too; ours,
// written there, coming back): with a Mac only, after each copy either way, the one change that echo makes isn't read (no "Allow
// Paste" for something already on both). Seen once, it's expected for 15 s after each copy; never
// seen (Universal Clipboard off, another Apple Account), nothing is skipped past the first 5 s.
import Foundation
import UIKit
import UniformTypeIdentifiers

final class Clip: Feature {
    struct Item: Identifiable { let id = UUID(); let dir: String; let text: String; var pic = false; let at = Date() }

    private(set) var peerAccepts = false
    private(set) var peerImages = false
    private(set) var history: [Item] = [] // newest first
    private var lastIn: String?
    private var lastOut: String?
    private var ownCount = -1 // the change count right after we wrote the clipboard ourselves
    private var seenCount = UIPasteboard.general.changeCount
    private var echoUntil = Date.distantPast // one Universal Clipboard echo expected until then
    private var ucEchoes: Bool { core.store.flag("clip.ucEcho", false) }

    // A copy went between the two: its echo (one change) is expected.
    // Only with a Mac: Universal Clipboard is Apple's, a Windows or Linux computer never echoes, so
    // with those nothing is ever skipped.
    private func expectEcho() {
        guard (core.link.host?.os ?? "") == "mac" else { echoUntil = .distantPast; return }
        echoUntil = Date().addingTimeInterval(ucEchoes ? 15 : 5)
    }
    static let mark = "com.twindesk.clip" // on everything TwinDesk writes to the clipboard
    private var watch: Timer?
    private var pic: (id: String, w: Int, h: Int, bytes: Int, parts: Int, got: Int, data: Data, at: Date)?

    var autoCopy: Bool { core.store.flag("clip.auto", true) }
    var notify: Bool { core.store.flag("clip.notify", true) }
    var notifyOwn: Bool { core.store.flag("clip.notifyOwn", true) }
    var pictures: Bool { core.store.flag("clip.images", false) }

    func setOption(_ key: String, _ on: Bool) {
        core.store.setFlag(key, on)
        if key == "clip.images" { sendPolicy() }
        core.changed()
    }

    func sendPolicy() {
        let accept = core.sync.get("clipboard", "in")
        core.send(msg(Proto.T.clipPolicy, ["accept": accept, "images": accept && pictures]))
    }

    override func onWelcome(_ host: Computer, _ m: JSON) {
        peerAccepts = false
        peerImages = false
        sendPolicy()
        startWatching()
    }

    override func onClosed() {
        peerAccepts = false
        peerImages = false
        pic = nil
    }

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        switch t {
        case Proto.T.clipPolicy:
            peerAccepts = m.bool("accept")
            peerImages = m.bool("images")
            core.changed()
        case Proto.T.clip:
            let text = m.str("text", max: Proto.clipMaxBytes)
            if !text.isEmpty && core.sync.get("clipboard", "in") { receiveText(text) }
        case Proto.T.clipImage: header(m)
        case Proto.T.clipImagePart: part(m)
        default: return false
        }
        return true
    }

    // ---- the computer's copies ----

    func receiveText(_ text: String) {
        lastIn = text
        expectEcho()
        remember(Item(dir: "in", text: text))
        if autoCopy || UIApplication.shared.applicationState == .active { write(text) }
        if notify && UIApplication.shared.applicationState != .active {
            Notifier.shared.clipIn(text, from: core.link.host?.name ?? "Computer", copied: autoCopy)
        }
    }

    // From the notification's Copy button, or a Recent item.
    func write(_ text: String) {
        put([UTType.utf8PlainText.identifier: text])
    }

    private func writeImage(_ img: UIImage) {
        guard let png = img.pngData() else { return }
        put([UTType.png.identifier: png])
    }

    // Ours: marked, and only on this device (no Universal Clipboard round trip back to the computer).
    private func put(_ item: [String: Any]) {
        var item = item
        item[Self.mark] = Data("1".utf8)
        UIPasteboard.general.setItems([item], options: [.localOnly: true])
        ownCount = UIPasteboard.general.changeCount
        seenCount = ownCount
    }

    // TwinDesk's own copy is on the clipboard (checking types needs no permission, no prompt).
    var ownOnBoard: Bool { UIPasteboard.general.contains(pasteboardTypes: [Self.mark]) }

    private func header(_ m: JSON) {
        pic = nil
        let id = m.str("id", max: 128)
        guard !id.isEmpty, core.sync.get("clipboard", "in"), pictures else { return }
        let w = m.int("w"), h = m.int("h")
        if let inline = m["png"] as? String, !inline.isEmpty { // whole, in the message (Multi-device's form)
            if let d = Data(base64Encoded: inline), d.count <= Proto.clipImageMaxBytes { receivePicture(d, w, h) }
            return
        }
        let bytes = m.int("bytes"), parts = m.int("parts")
        let per = Proto.clipImagePartBytes
        guard bytes >= 9, bytes <= Proto.clipImageMaxBytes, parts == (bytes + per - 1) / per else { return }
        pic = (id, w, h, bytes, parts, 0, Data(capacity: bytes), Date())
    }

    private func part(_ m: JSON) {
        guard var c = pic, m.str("id", max: 128) == c.id else { return }
        guard m.int("i", -1) == c.got, Date().timeIntervalSince(c.at) < 60,
              let d = Data(base64Encoded: m.str("data", max: Proto.clipImagePartBytes * 2)) else { pic = nil; return }
        c.data.append(d)
        c.got += 1
        if c.data.count > c.bytes { pic = nil; return }
        if c.got < c.parts { pic = c; return }
        pic = nil
        if c.data.count == c.bytes { receivePicture(c.data, c.w, c.h) }
    }

    private func receivePicture(_ png: Data, _ w: Int, _ h: Int) {
        guard let img = UIImage(data: png) else { return }
        expectEcho()
        remember(Item(dir: "in", text: tr("Picture · {w} × {h}", ["w": w, "h": h]), pic: true))
        writeImage(img)
        if notify && UIApplication.shared.applicationState != .active {
            Notifier.shared.clipIn(tr("Picture · {w} × {h}", ["w": w, "h": h]), from: core.link.host?.name ?? "Computer", copied: true)
        }
    }

    // ---- the iPhone's copies ----

    // The clipboard's change count, once a second while we run (it's free: no paste prompt).
    private func startWatching() {
        if watch != nil { return }
        watch = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.check() }
        watch?.tolerance = 0.5 // iOS may fold it into other wakeups (battery)
    }

    func appBecameActive() { check() }

    private func check() {
        let n = UIPasteboard.general.changeCount
        guard n != seenCount else { return }
        seenCount = n
        guard n != ownCount, !ownOnBoard, core.connected, core.sync.get("clipboard", "out") else { return }
        // The copy that just went between the two, through Universal Clipboard: not read (it would ask to paste).
        if Date() < echoUntil {
            echoUntil = .distantPast
            if !ucEchoes { core.store.setFlag("clip.ucEcho", true) }
            return
        }
        if UIApplication.shared.applicationState == .active {
            sendCurrent(force: false)
        } else if notifyOwn {
            let hasImage = UIPasteboard.general.hasImages
            Notifier.shared.clipOut(to: core.link.host?.name ?? tr("the computer"), picture: hasImage)
        }
    }

    // What's on the clipboard now goes to the computer (in front, or from the notification / shortcut).
    @discardableResult
    func sendCurrent(force: Bool = true) -> Bool {
        let pb = UIPasteboard.general
        if !force && ownOnBoard { return false } // TwinDesk's own copy: nothing new
        if pb.hasStrings, let text = pb.string { return sendText(text, force: force) }
        if pb.hasImages, let img = pb.image { return sendPicture(img) }
        return false
    }

    @discardableResult
    func sendText(_ text: String, force: Bool = true) -> Bool {
        guard core.connected, !text.isEmpty, text.utf8.count <= Proto.clipMaxBytes else { return false }
        if !force && (text == lastOut || text == lastIn) { return false }
        lastOut = text
        expectEcho()
        remember(Item(dir: "out", text: text))
        return core.send(msg(Proto.T.clip, ["text": text]))
    }

    // A PNG in pieces (clip.image + clip.image.part), only while both sides take pictures.
    @discardableResult
    func sendPicture(_ img: UIImage) -> Bool {
        guard core.connected, peerImages, pictures, let png = img.pngData(), png.count <= Proto.clipImageMaxBytes else { return false }
        let id = Proto.randomHex(8)
        let per = Proto.clipImagePartBytes
        let parts = (png.count + per - 1) / per
        let w = Int(img.size.width * img.scale), h = Int(img.size.height * img.scale)
        core.send(msg(Proto.T.clipImage, ["id": id, "w": w, "h": h, "bytes": png.count, "parts": parts]))
        DispatchQueue.global(qos: .userInitiated).async {
            for i in 0..<parts {
                while self.core.link.queued() > 512 * 1024 { usleep(10_000) }
                let from = i * per
                let chunk = png.subdata(in: from..<min(png.count, from + per))
                self.core.send(msg(Proto.T.clipImagePart, ["id": id, "i": i, "data": chunk.base64EncodedString()]))
            }
        }
        expectEcho()
        remember(Item(dir: "out", text: tr("Picture · {w} × {h}", ["w": w, "h": h]), pic: true))
        return true
    }

    private func remember(_ item: Item) {
        history.removeAll { $0.text == item.text }
        history.insert(item, at: 0)
        if history.count > 20 { history.removeLast(history.count - 20) }
        core.changed()
    }
}

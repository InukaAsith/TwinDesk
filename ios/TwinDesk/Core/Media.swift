// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// What plays on the computer (shared/pcnow.js there, android/…/PcMedia.kt): on the Media page, and
// on this iPhone's Lock Screen and Control Center (its Now Playing, with Play/Pause, Next and
// Previous). Asked for (pc.media.want) only while one of them wants it.
//
// The computer's controls (shared/devctl.js there: dev.state / dev.do): its volume, Lock, Sleep, Do
// Not Disturb and Bluetooth; and ours for it: Ring (find this iPhone).
//
// The computer's shared folder over SMB (mac/smb.js: smb.offer {share, user, password, port}): the
// Files app connects to it (Connect to Server), so it shows there as a server, like a PC's drive.
import Foundation
import MediaPlayer
import AVFoundation
import UIKit
import AudioToolbox

final class PcMedia: Feature {
    struct Now: Equatable { var title = "", artist = "", album = "", app = "", playing = false }
    private(set) var now: Now?
    private(set) var art: UIImage? // the computer's artwork for what plays (pc.media's art; left out there: unchanged)
    private var pageOpen = false

    var lockScreen: Bool { core.store.flag("media.lockScreen", true) }
    func setLockScreen(_ on: Bool) {
        core.store.setFlag("media.lockScreen", on)
        want()
        show()
        core.changed()
    }

    func page(_ open: Bool) { pageOpen = open; want() }

    private var wanted = false
    private func want() {
        let w = core.connected && (pageOpen || lockScreen)
        if w == wanted { return }
        wanted = w
        core.send(msg(Proto.T.pcMediaWant, ["on": w]))
        if !w && !pageOpen { now = nil; art = nil; show() }
    }

    func ctl(_ a: String) { core.send(msg(Proto.T.pcMediaCtl, ["a": a])) }

    override func onWelcome(_ host: Computer, _ m: JSON) {
        wanted = false
        want()
        commands()
    }

    override func onClosed() {
        wanted = false
        now = nil
        art = nil
        show()
    }

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        guard t == Proto.T.pcMedia else { return false }
        if let a = m["art"] as? String {
            art = nil
            if a.hasPrefix("data:image/"), let comma = a.firstIndex(of: ","), let d = Data(base64Encoded: String(a[a.index(after: comma)...])) { art = UIImage(data: d) }
        }
        if m.bool("none") || m.str("title").isEmpty { now = nil; art = nil }
        else { now = Now(title: m.str("title", max: 300), artist: m.str("artist", max: 300), album: m.str("album", max: 300), app: m.str("app", max: 60), playing: m.bool("playing")) }
        show()
        core.changed()
        return true
    }

    // ---- Now Playing ----

    private var commandsSet = false
    private func commands() {
        guard !commandsSet else { return }
        commandsSet = true
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in self?.ctl("play"); return .success }
        c.pauseCommand.addTarget { [weak self] _ in self?.ctl("pause"); return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in self?.ctl("toggle"); return .success }
        c.nextTrackCommand.addTarget { [weak self] _ in self?.ctl("next"); return .success }
        c.previousTrackCommand.addTarget { [weak self] _ in self?.ctl("prev"); return .success }
    }

    private func show() {
        let center = MPNowPlayingInfoCenter.default()
        guard lockScreen, let n = now, core.connected else {
            center.nowPlayingInfo = nil
            Background.shared.setNowPlaying(false)
            return
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: n.title,
            MPMediaItemPropertyArtist: n.artist.isEmpty ? (core.host?.name ?? "Computer") : n.artist,
            MPMediaItemPropertyAlbumTitle: n.album.isEmpty ? tr("{app} on {name}", ["app": n.app, "name": core.host?.name ?? tr("the computer")]) : n.album,
            MPNowPlayingInfoPropertyPlaybackRate: n.playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyIsLiveStream: true,
        ]
        if let img = art { info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: img.size) { _ in img } }
        center.nowPlayingInfo = info
        // iOS shows Now Playing for the app whose sound doesn't mix with others: ours, while the
        // computer plays (the silent sound, not mixed then).
        if n.playing { Background.shared.setNowPlaying(true) }
    }
}

final class DevCtl: Feature {
    struct Can: OptionSet { let rawValue: Int
        static let lock = Can(rawValue: 1), sleep = Can(rawValue: 2), volume = Can(rawValue: 4), dnd = Can(rawValue: 8), bluetooth = Can(rawValue: 16), ring = Can(rawValue: 32)
    }
    private(set) var can: Can = []
    private(set) var volume: Double?
    private(set) var dnd: Bool?
    private(set) var bluetooth: Bool?
    private(set) var ringing = false
    private var ringTimer: Timer?

    func act(_ what: String, _ extra: JSON = [:]) {
        var m = msg("dev.do", extra)
        m["do"] = what
        core.send(m)
    }

    func setVolume(_ v: Double) {
        volume = v
        act("volume", ["level": max(0, min(1, v))])
    }

    override func onWelcome(_ host: Computer, _ m: JSON) {
        can = []
        volume = nil
        sendState()
    }

    override func onClosed() {
        can = []
        stopRing()
    }

    private func sendState() {
        core.send(msg("dev.state", ["can": ["ring": true, "ringStop": true], "ringing": ringing,
                                     // which TwinDesk (shared/appinfo.js): the computer warns when it's older
                                     "app": ["v": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""]]))
    }

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        switch t {
        case "dev.state":
            var c: Can = []
            let cm = m.obj("can") ?? [:]
            if cm.bool("lock") { c.insert(.lock) }
            if cm.bool("sleep") { c.insert(.sleep) }
            if cm.bool("volume") { c.insert(.volume) }
            if cm.bool("dnd") { c.insert(.dnd) }
            if cm.bool("bluetooth") { c.insert(.bluetooth) }
            if cm.bool("ring") { c.insert(.ring) }
            can = c
            volume = (m["volume"] as? NSNumber)?.doubleValue
            dnd = m["dnd"] as? Bool
            bluetooth = m["bluetooth"] as? Bool
            core.changed()
        case "dev.do":
            switch m.str("do") {
            case "ring": ring()
            case "ringStop": stopRing()
            default: break
            }
        default: return false
        }
        return true
    }

    // Find this iPhone: a loud sound and vibration every second for half a minute, or until stopped
    // (here, or from the computer).
    private func ring() {
        stopRing()
        ringing = true
        sendState()
        try? AVAudioSession.sharedInstance().setCategory(.playback, options: [])
        try? AVAudioSession.sharedInstance().setActive(true)
        var n = 0
        ringTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] t in
            n += 1
            AudioServicesPlayAlertSound(SystemSoundID(1005))
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
            if n >= 30 { t.invalidate(); self?.stopRing() }
        }
        Notifier.shared.note("ring", tr("{name} is ringing this {device}", ["name": core.host?.name ?? tr("Your computer"), "device": Device.word]), tr("Open TwinDesk to stop the sound."), sound: true)
        core.changed()
    }

    func stopRing() {
        ringTimer?.invalidate()
        ringTimer = nil
        guard ringing else { return }
        ringing = false
        Notifier.shared.cancel("ring")
        Background.shared.apply()
        if core.connected { sendState() }
        core.changed()
    }
}

final class Smb: Feature {
    struct Offer { var share: String, user: String, password: String, port: Int, address: String }
    private(set) var offer: Offer?

    override func onClosed() { offer = nil; core.changed() }

    override func onMessage(_ t: String, _ m: JSON) -> Bool {
        guard t == "smb.offer" else { return false }
        let share = m.str("share", max: 80)
        guard !share.isEmpty, let h = core.host else { return true }
        // The address the session reaches it on (not the cable's 127.0.0.1: the Files app needs the network).
        let addr = core.store.host(h.id)?.address ?? h.address
        offer = Offer(share: share, user: m.str("user", max: 80), password: m.str("password", max: 200), port: m.int("port", 445), address: addr)
        core.changed()
        return true
    }

    var url: URL? {
        guard let o = offer else { return nil }
        let a = o.address.contains(":") ? "[\(o.address)]" : o.address
        let user = o.user.addingPercentEncoding(withAllowedCharacters: .urlUserAllowed) ?? o.user
        return URL(string: "smb://\(user)@\(a)\(o.port == 445 ? "" : ":\(o.port)")/\(o.share)")
    }

    // The Files app's Connect to Server with the address filled in (smb:// opens it), the password
    // on the clipboard to paste.
    func connectInFiles() {
        guard let o = offer, let u = url else { return }
        core.clip.write(o.password)
        UIApplication.shared.open(u)
    }
}
